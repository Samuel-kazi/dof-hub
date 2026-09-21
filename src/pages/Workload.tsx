import { useState } from "react";
import { ReportButton } from "../ui/ReportDialog";
import { can } from "../services/wrapped/permissions";
import type { Person } from "../types";
import { useApp } from "../ui/AppContext";
import { Empty } from "../ui/parts";
import { DEFAULT_STAGE_EFFORT, HORIZON_DAYS } from "../config/capacity";
import { categoryOf } from "../config/categories";
import { isHop } from "../services/access";
import { assignmentRisks, canSeeWorkload, crewWorkload, fmtDays, workloadFor, type DayLoad, type LoadStatus, type Risk, type Workload } from "../services/workload";
import { fmtShort, todayIso } from "../services/utils";

const LABEL: Record<LoadStatus, string> = { off: "Day off", free: "Room to spare", ok: "Comfortable", busy: "Full", over: "Over capacity" };
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const dow = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

function tip(d: DayLoad): string {
  const head = `${fmtShort(d.date)}: ${LABEL[d.status]}${d.load ? `, ${Math.round(d.load * 100)}% of a day` : ""}${!d.workDay && d.load ? " (day off)" : ""}`;
  return d.parts.length ? `${head}\n${d.parts.map((p) => `${p.item.label}${p.item.kind === "stage" || p.item.kind === "task" ? ` (${fmtDays(p.amount)})` : ""}${p.item.late ? ", already late" : ""}`).join("\n")}` : head;
}

/** One coloured square for one person on one day. Hover for what is in it. */
function Cell({ d }: { d: DayLoad }) {
  return <td className={`load load-${d.status}`} title={tip(d)} aria-label={tip(d).replace(/\n/g, ". ")}>{d.load > 0 ? Math.round(d.load * 100) : ""}</td>;
}

/** Everyone's load, day by day. */
export function WorkloadGrid({ rows, compact = false }: { rows: { person: Person; workload: Workload }[]; compact?: boolean }) {
  const { go } = useApp();
  if (!rows.length) return <Empty>No one to show.</Empty>;
  const days = rows[0].workload.days;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className={`load-grid ${compact ? "compact" : ""}`}>
        <thead>
          <tr>
            <th />
            {days.map((d) => <th key={d.date} className={d.workDay ? "" : "off"} title={fmtShort(d.date)}><span>{DOW[dow(d.date)]}</span><b>{Number(d.date.slice(8))}</b></th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ person, workload }) => (
            <tr key={person.personId}>
              <th className="who"><div style={{ display: "flex", alignItems: "center", gap: 8 }}><button className="linkish" onClick={() => go({ n: "person", id: person.personId })}>{person.name}</button>{workload.overDays.length > 0 && <span className="badge bad">{workload.overDays.length} over</span>}</div></th>
              {workload.days.map((d) => <Cell key={d.date} d={d} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Legend() {
  return (
    <div className="legend" style={{ marginTop: 8 }}>
      {(["free", "ok", "busy", "over", "off"] as LoadStatus[]).map((s) => <span key={s}><i className={`load-${s}`} style={{ border: "1px solid var(--glass-line)" }} />{LABEL[s]}</span>)}
    </div>
  );
}

function RiskList({ risks }: { risks: Risk[] }) {
  const { go } = useApp();
  return (
    <div className="list">
      {risks.map((r) => (
        <div key={r.item.id} className="list-item" onClick={() => go({ n: "record", id: r.item.contentId })}>
          <span className="badge bad">{r.item.late ? "Late" : "Not enough time"}</span>
          <div className="grow">{r.reason}</div>
        </div>
      ))}
    </div>
  );
}

/** The Workload tab on the People page. */
export function WorkloadTab() {
  const { actor, go } = useApp();
  const [weeks, setWeeks] = useState<2 | 4>(2);
  const rows = crewWorkload(actor, todayIso(), weeks * 7);
  const hop = can(actor, "backend.settings");
  const trouble = rows.map((r) => ({ ...r, risks: assignmentRisks(r.person.personId) })).filter((r) => r.workload.overDays.length > 0 || r.risks.length > 0);

  return (
    <>
      <section className="glass panel">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <h2 style={{ flex: 1 }}>{hop ? "Who has what on" : "What you have on"}</h2>
          <div className="seg" role="group" aria-label="Range"><button className={weeks === 2 ? "on" : ""} onClick={() => setWeeks(2)}>Two weeks</button><button className={weeks === 4 ? "on" : ""} onClick={() => setWeeks(4)}>Four weeks</button></div>
          <ReportButton scope="workload" />
        </div>
        <WorkloadGrid rows={rows} />
        <Legend />
        <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Each square is a share of one person's working day. Hover a square to see what is in it. Over 100% is more than one person can do in a day.</p>
      </section>

      <section className="glass panel" aria-label="Needs attention">
        <h2 style={{ marginBottom: 12 }}>Needs attention</h2>
        {trouble.length === 0 ? <Empty>Nobody is over capacity, and everything assigned has the time it needs.</Empty> : (
          <div className="stack" style={{ gap: 18 }}>
            {trouble.map(({ person, workload, risks }) => (
              <div key={person.personId}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6 }}>
                  <button className="linkish" style={{ fontWeight: 600 }} onClick={() => go({ n: "person", id: person.personId })}>{person.name}</button>
                  {workload.overDays.length > 0 && <span className="badge bad">Over capacity on {workload.overDays.slice(0, 4).map(fmtShort).join(", ")}{workload.overDays.length > 4 ? ` and ${workload.overDays.length - 4} more` : ""}</span>}
                </div>
                {risks.length > 0 && <RiskList risks={risks} />}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="glass panel">
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 500 }}>How this is worked out</summary>
          <div className="stack" style={{ marginTop: 12, fontSize: ".92rem" }}>
            <p>Work is measured in person-days: how long a stage takes one person when they have nothing else on. That time is spread evenly over the working days between when the stage can start and when it is due. A shoot day on a call sheet, or being away with gear, takes the whole day.</p>
            <p>For a series, finishing a cut takes at least <b>2 days</b> for someone with nothing else on. It covers adding B-roll and working through the review notes from picture lock. Give it one day and that person is shown at 200%.</p>
            <p>More people on a stage share its time. A checklist item goes to the person it is given to. Filming, recording and streaming stages are counted as shoot days, not desk time. Work already past its date is shown as catch-up starting today.</p>
            <table className="table" style={{ marginTop: 6 }}>
              <thead><tr><th>Category</th><th>Stage</th><th>Person-days</th></tr></thead>
              <tbody>
                {Object.entries(DEFAULT_STAGE_EFFORT).flatMap(([cat, stages]) => Object.entries(stages).map(([stage, days], i) => (
                  <tr key={`${cat}-${stage}`}><td>{i === 0 ? categoryOf(cat as never).label : ""}</td><td>{stage}</td><td>{days}</td></tr>
                )))}
              </tbody>
            </table>
            <p className="muted">Only the series editing figure comes from the team. The rest are starting estimates.{hop ? " Change any of them, and the working days, in Settings." : ""}</p>
          </div>
        </details>
      </section>
    </>
  );
}

/** One person's load and anything that will not fit, for their profile. */
export function PersonWorkload({ personId }: { personId: string }) {
  const { actor } = useApp();
  if (!canSeeWorkload(actor, personId)) return null;
  const w = workloadFor(personId, todayIso(), HORIZON_DAYS);
  const risks = assignmentRisks(personId);
  return (
    <section className="glass panel" aria-label="Workload">
      <h2 style={{ marginBottom: 12 }}>Workload, next four weeks</h2>
      <WorkloadGrid rows={[{ person: { personId, name: "Load" } as Person, workload: w }]} />
      <Legend />
      <div style={{ marginTop: 14 }}>{risks.length === 0 ? <p className="muted">Everything assigned has the time it needs.</p> : <RiskList risks={risks} />}</div>
      {w.undated.length > 0 && <p className="muted" style={{ marginTop: 10 }}>No date is set for: {w.undated.join("; ")}. Work without a date cannot be scheduled.</p>}
    </section>
  );
}
