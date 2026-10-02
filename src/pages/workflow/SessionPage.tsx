import { useState } from "react";
import type { LogStatus, RunItem, SessionLogEntry } from "../../types";
import { categoryOf } from "../../config/categories";
import { PROJECT_ROLE_DEFS } from "../../config/workflow";
import { getDb, useDb } from "../../data/store";
import { canView, canWrite, getRecord } from "../../services/access";
import { getBreadcrumb } from "../../services/wrapped/content";
import { gearIssues, manifestForSheet } from "../../services/wrapped/equipment";
import { getPerson, nameOf } from "../../services/wrapped/people";
import {
  addLogRow,
  addRunSheetItem,
  archiveSession,
  availableForLog,
  closeSession,
  createSessionCallSheet,
  evaluateGate,
  getSession,
  openSession,
  removeLogRow,
  removeRunSheetItem,
  reopenSession,
  resetRunSheet,
  rowsOf,
  RUN_SHEET_NOTE,
  updateLogRow,
  updateRunSheetItem,
  updateSession,
  type Project,
} from "../../services/wrapped/workflow";
import { fmtDate, fmtDateTime } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { GatePanel } from "../../ui/workflow/shared";
import { ConfigChecklist, useDraft, useReason } from "./common";

// One recording session: Pre-production while Planned (call sheet, gear, rehearsal), Production while Open (the
// run sheet and the log, then wrap), and the close that makes the episodes.

const STATUSES: LogStatus[] = ["Recorded", "Pickup needed", "Not recorded"];
const stageOf = (status: string) => (status === "Planned" ? "Pre-production" : status === "Open" ? "Production" : "Closed");

function RunSheetRow({ sessionId, item, editable }: { sessionId: string; item: RunItem; editable: boolean }) {
  const { actor, attempt } = useApp();
  const [draft, setDraft, dirty, saved] = useDraft({
    time: item.time,
    title: item.title,
    durationMin: item.durationMin,
    notes: item.notes,
  });
  const save = () => dirty && attempt(() => updateRunSheetItem(actor, sessionId, item.id, draft)) && saved();
  const end = (() => {
    const [h, m] = draft.time.split(":").map(Number);
    const t = h * 60 + m + Number(draft.durationMin || 0);
    return Number.isFinite(t) && draft.durationMin
      ? `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
      : "";
  })();
  return (
    <tr>
      <td>
        <input
          type="time"
          aria-label="Start"
          value={draft.time}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, time: e.target.value })}
          onBlur={save}
        />
      </td>
      <td className="muted">{end && `to ${end}`}</td>
      <td>
        <input
          type="text"
          aria-label="Activity"
          value={draft.title}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          onBlur={save}
        />
      </td>
      <td>
        <input
          type="number"
          min={0}
          aria-label="Minutes"
          style={{ width: 80 }}
          value={draft.durationMin}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, durationMin: Number(e.target.value) })}
          onBlur={save}
        />
      </td>
      <td>
        <input
          type="text"
          aria-label="Notes"
          value={draft.notes}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          onBlur={save}
        />
      </td>
      <td>
        {editable && (
          <button
            className="btn small ghost"
            aria-label={`Remove ${item.title}`}
            onClick={() => attempt(() => removeRunSheetItem(actor, sessionId, item.id))}
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function LogRow({ row, editable, statusEditable }: { row: SessionLogEntry; editable: boolean; statusEditable: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const planned = row.plannedEpisodeId ? getDb().plannedEpisodes.find((p) => p.id === row.plannedEpisodeId) : undefined;
  const [draft, setDraft, dirty, saved] = useDraft({
    logDate: row.logDate,
    guest: row.guest,
    notesForPost: row.notesForPost,
    itemLabel: row.itemLabel,
  });
  const save = () => dirty && attempt(() => updateLogRow(actor, row.id, draft)) && saved();
  return (
    <tr>
      <td className="cid">{row.sessionId.slice(row.sessionId.lastIndexOf("-") + 1)}</td>
      <td>
        <input
          type="date"
          aria-label="Date"
          value={draft.logDate}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, logDate: e.target.value })}
          onBlur={save}
        />
      </td>
      <td>
        {planned ? (
          <>
            <span className="cid">{planned.id.slice(planned.contentId.length + 1)}</span> {planned.workingTitle}
          </>
        ) : (
          <input
            type="text"
            aria-label="What was recorded"
            value={draft.itemLabel}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, itemLabel: e.target.value })}
            onBlur={save}
          />
        )}
      </td>
      <td>
        <input
          type="text"
          aria-label="Guest"
          value={draft.guest}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, guest: e.target.value })}
          onBlur={save}
        />
      </td>
      <td>
        <select
          aria-label="Status"
          value={row.status ?? ""}
          disabled={!statusEditable}
          title={statusEditable ? "" : "Set during the session, once it is in Production"}
          onChange={(e) => attempt(() => updateLogRow(actor, row.id, { status: (e.target.value || null) as LogStatus | null }))}
        >
          <option value="">No status yet</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </td>
      <td>
        <textarea
          aria-label="Notes for post production"
          placeholder="Pickups, retakes, timestamps, audio or focus problems, dates"
          value={draft.notesForPost}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, notesForPost: e.target.value })}
          onBlur={save}
        />
      </td>
      <td>
        {editable && (
          <button
            className="btn small ghost"
            onClick={async () => {
              if (
                await confirm({
                  title: "Remove this row from the log?",
                  body: `${planned ? planned.workingTitle : row.itemLabel} comes off this session's log.`,
                  confirmLabel: "Remove",
                  danger: true,
                })
              )
                attempt(() => removeLogRow(actor, row.id), "Removed");
            }}
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function RecordingDay({ project, sessionId, editable }: { project: Project; sessionId: string; editable: boolean }) {
  const { actor, attempt } = useApp();
  const s = getSession(sessionId)!;
  const [venue, setVenue] = useState(s.venue);
  const rows = rowsOf(sessionId);
  const roles = getDb().projectRoles.filter((r) => r.contentId === project.contentId);
  const crew = [
    ...(project.workflow.showProducerId ? [{ role: "Show producer (runs the clock)", id: project.workflow.showProducerId, name: "" }] : []),
    ...roles.map((r) => ({
      role: PROJECT_ROLE_DEFS.find((d) => d.key === r.roleKey)?.label ?? r.roleKey,
      id: r.crewId,
      name: r.guestName,
    })),
  ];
  return (
    <section className="glass panel" aria-label="Recording day">
      <h2>Recording day</h2>
      <div className="row" style={{ alignItems: "end" }}>
        <Field label="Date">
          <input
            type="date"
            value={s.scheduledDate ?? ""}
            disabled={!editable}
            onChange={(e) => attempt(() => updateSession(actor, sessionId, { scheduledDate: e.target.value || null }))}
          />
        </Field>
        <Field label="Venue">
          <input
            type="text"
            value={venue}
            disabled={!editable}
            onChange={(e) => setVenue(e.target.value)}
            onBlur={() => venue !== s.venue && attempt(() => updateSession(actor, sessionId, { venue }), "Venue saved")}
          />
        </Field>
      </div>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div>
          <h3>Episodes and guests</h3>
          {rows.length === 0 ? (
            <p className="muted">None planned yet. Add them to the log below.</p>
          ) : (
            <ul>
              {rows.map((r) => {
                const p = getDb().plannedEpisodes.find((x) => x.id === r.plannedEpisodeId);
                return (
                  <li key={r.id}>
                    <span className="cid">{p?.id ?? "Item"}</span> {p?.workingTitle ?? r.itemLabel}
                    {r.guest ? `, with ${r.guest}` : ""}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <h3>Crew and contacts</h3>
          {crew.length === 0 ? (
            <p className="muted">No roles assigned yet.</p>
          ) : (
            <ul>
              {crew.map((c, i) => {
                const person = c.id ? getPerson(c.id) : undefined;
                return (
                  <li key={`${c.role}-${i}`}>
                    {c.role}: <b>{c.id ? nameOf(c.id) : c.name}</b>
                    {person?.phone ? `, ${person.phone}` : ""}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

export function SessionPage({ id }: { id: string }) {
  const { actor, go, attempt, confirm, toast } = useApp();
  useDb();
  const [ask, reasonModal] = useReason();
  const [pick, setPick] = useState("");
  const [label, setLabel] = useState("");
  const [dailyLog, setDailyLog] = useState<string | null>(null);
  const session = getSession(id);
  const project = session ? getRecord(session.contentId) : undefined;
  if (!session || !project?.workflow || !canView(actor, project))
    return (
      <div className="page">
        <Empty>This recording session does not exist, or is not part of a project you are attached to.</Empty>
      </div>
    );
  const p = project as Project;
  const write = canWrite(actor, p) && !p.archived && !session.archivedAt;
  const editable = write && session.status !== "Closed";
  const isDoc = p.workflow.formType.startsWith("documentary");
  const rows = rowsOf(id);
  const sheet = session.callSheetId ? getDb().callSheets.find((c) => c.id === session.callSheetId) : undefined;
  const gear = sheet ? manifestForSheet(sheet.id) : undefined;
  const issues = sheet ? gearIssues(sheet.id) : [];
  const available = availableForLog(id);
  const crumbs = getBreadcrumb(p.contentId);

  const addRow = () => {
    const input = isDoc ? { itemLabel: label } : { plannedEpisodeId: pick };
    if (attempt(() => addLogRow(actor, id, input), "Added to the log")) {
      setPick("");
      setLabel("");
    }
  };
  const close = async () => {
    const make = rows.filter((r) => r.status === "Recorded" || r.status === "Pickup needed");
    const skip = rows.filter((r) => r.status === "Not recorded");
    const body = isDoc
      ? "The session closes. A documentary's film is made when it is sent to post production."
      : `${make.length} episode${make.length === 1 ? "" : "s"} will be made${skip.length ? `; ${skip.length} not recorded will stay planned for a later session` : ""}. This cannot be undone once editing starts on them.`;
    if (!(await confirm({ title: "Close session and send to post production?", body, confirmLabel: "Close session" }))) return;
    const res = attempt(() => closeSession(actor, id));
    if (res) toast(res.made.length ? `Session closed. Made ${res.made.join(", ")}.` : "Session closed.", "success");
  };

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => go({ n: "pipeline", category: p.category })}>{categoryOf(p.category).label}</button>
        {crumbs.map((c) => (
          <span key={c.contentId}>
            <span aria-hidden> / </span>
            <button onClick={() => go({ n: "record", id: c.contentId })}>{c.title}</button>
          </span>
        ))}
        <span aria-hidden> / </span>
        <span>{session.id}</span>
      </nav>
      <div className="page-head">
        <div className="grow">
          <h1>Recording session {session.sessionNumber}</h1>
          <div className="wf-chips" style={{ marginTop: 4 }}>
            <span className="cid">{session.id}</span>
            <span className={`badge ${session.status === "Closed" ? "ok" : "accent"}`}>{stageOf(session.status)}</span>
            {session.scheduledDate && <span className="muted">{fmtDate(session.scheduledDate)}</span>}
          </div>
        </div>
        {write && session.status === "Planned" && (
          <button
            className="btn danger"
            onClick={async () => {
              const reason = await ask(
                `Take ${session.id} off the schedule`,
                "Why? The session is archived with this reason, and kept.",
                "Archive session",
              );
              if (reason) attempt(() => archiveSession(actor, id, reason), "Session taken off the schedule");
            }}
          >
            Take off the schedule
          </button>
        )}
      </div>
      {session.archivedAt && <div className="banner bad">Taken off the schedule: {session.archivedReason}</div>}
      {session.status === "Closed" && (
        <div className="banner">
          <span className="grow">
            Closed {session.closedAt ? fmtDateTime(session.closedAt) : ""}. Its episodes are in the project's episode tracker.
          </span>
          {write && (
            <button
              className="btn small"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Reopen ${session.id}?`,
                    body: "Only possible while no work has started on its episodes. Closing again will not make them twice.",
                    confirmLabel: "Reopen",
                  })
                )
                  attempt(() => reopenSession(actor, id), "Session reopened");
              }}
            >
              Reopen session
            </button>
          )}
        </div>
      )}

      <RecordingDay project={p} sessionId={id} editable={editable} />

      {session.status === "Planned" && (
        <>
          <section className="glass panel" aria-label="Call sheet and gear">
            <h2>Call sheet and gear</h2>
            {sheet ? (
              <div className="stack">
                <div className="wf-chips">
                  <button className="btn" onClick={() => go({ n: "callsheet", id: sheet.id })}>
                    Open call sheet {sheet.id}
                  </button>
                  <span className={`badge ${sheet.status === "final" ? "ok" : ""}`}>{sheet.status === "final" ? "Issued" : "Draft"}</span>
                  <span className="muted">
                    {gear ? `${gear.lines.length} item${gear.lines.length === 1 ? "" : "s"} of gear` : "No gear chosen yet"}
                    {issues.length ? `, ${issues.length} conflict${issues.length === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
                <p className="muted">
                  Choose gear on the call sheet with the Equipment picker. Clashes and availability show as you pick. Issue the sheet there
                  when it is ready.
                </p>
              </div>
            ) : (
              <div className="stack">
                <p className="muted">
                  The call sheet is made in the Call Sheet module, filled in from this session: date, venue, crew, episodes and guests.
                  Every field can be changed there.
                </p>
                {write && (
                  <div>
                    <button
                      className="btn primary"
                      disabled={!session.scheduledDate}
                      onClick={() => attempt(() => createSessionCallSheet(actor, id), "Call sheet made")}
                    >
                      Make the call sheet
                    </button>
                    {!session.scheduledDate && <span className="muted"> Set the date first.</span>}
                  </div>
                )}
              </div>
            )}
          </section>
          <ConfigChecklist
            title="Camera tests and rehearsal"
            listKey="preSession"
            ownerId={id}
            disabled={!editable}
            auto={{
              gear_selected: [
                !!gear && gear.lines.length > 0 && issues.length === 0,
                issues[0] ?? (gear?.lines.length ? "Chosen, no conflicts" : "Choose it on the call sheet"),
              ],
              call_sheet_issued: [
                sheet?.status === "final" && sheet.date === session.scheduledDate,
                sheet ? (sheet.status === "final" ? `Issued: ${sheet.id}` : "Issue it on the call sheet") : "No call sheet yet",
              ],
            }}
          />
          <GatePanel
            title="Ready to record"
            gate={evaluateGate("Pre-production", "session", id)}
            action="Start recording: move to Production"
            disabled={!write}
            onDone={async () => {
              if (
                await confirm({
                  title: "Start recording?",
                  body: "The session moves into Production. It cannot move back to Pre-production.",
                  confirmLabel: "Start recording",
                })
              )
                attempt(() => openSession(actor, id), "Session in Production");
            }}
          />
        </>
      )}

      <section className="glass panel" aria-label="Run sheet">
        <div className="wf-head">
          <h2>Run sheet</h2>
          {editable && (
            <button
              className="btn small"
              onClick={async () => {
                if (
                  await confirm({
                    title: "Rebuild the run sheet?",
                    body: `It is made again from the template for ${rows.filter((r) => r.plannedEpisodeId).length || 5} episodes. Changes made to it are replaced.`,
                    confirmLabel: "Rebuild",
                  })
                )
                  attempt(() => resetRunSheet(actor, id), "Run sheet rebuilt");
              }}
            >
              Rebuild from the template
            </button>
          )}
        </div>
        <p className="muted">{RUN_SHEET_NOTE}</p>
        {session.runSheet.length === 0 ? (
          <Empty>The run sheet is empty.</Empty>
        ) : (
          <div className="wf-scroll">
            <table className="table wf-table">
              <thead>
                <tr>
                  <th>Start</th>
                  <th>End</th>
                  <th>Activity</th>
                  <th>Minutes</th>
                  <th>Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {session.runSheet.map((item) => (
                  <RunSheetRow key={item.id} sessionId={id} item={item} editable={editable} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && (
          <button
            className="btn small"
            style={{ marginTop: 8 }}
            onClick={() => attempt(() => addRunSheetItem(actor, id, { time: "17:00", title: "New item", durationMin: 15, notes: "" }))}
          >
            Add a line
          </button>
        )}
      </section>

      <section className="glass panel" aria-label="Recording session log">
        <h2>Recording session log</h2>
        <p className="muted">
          Pickups, retakes, timestamps, audio or focus problems and any dates go in each row's notes for post production.
        </p>
        {rows.length === 0 ? (
          <Empty>{isDoc ? "No items logged yet: interview sets, scenes, locations." : "No episodes on this session's log yet."}</Empty>
        ) : (
          <div className="wf-scroll">
            <table className="table wf-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Date</th>
                  <th>{isDoc ? "Item" : "Episode"}</th>
                  <th>Guest</th>
                  <th>Status</th>
                  <th>Notes for post production</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <LogRow key={r.id} row={r} editable={editable} statusEditable={editable && session.status === "Open"} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && (
          <div className="row" style={{ alignItems: "end", marginTop: 10 }}>
            {isDoc ? (
              <Field label="Add an item: an interview set, a scene, a location">
                <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
              </Field>
            ) : (
              <Field label="Add an episode (planned, and not recorded in another session)">
                <select value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">{available.length ? "Choose…" : "No planned episodes left to add"}</option>
                  {available.map((pid) => {
                    const pe = getDb().plannedEpisodes.find((x) => x.id === pid)!;
                    return (
                      <option key={pid} value={pid}>
                        {pid.slice(pe.contentId.length + 1)}: {pe.workingTitle}
                      </option>
                    );
                  })}
                </select>
              </Field>
            )}
            <div style={{ flex: "none" }}>
              <button className="btn primary" disabled={isDoc ? !label.trim() : !pick} onClick={addRow}>
                Add to the log
              </button>
            </div>
          </div>
        )}
      </section>

      {session.status !== "Planned" && (
        <>
          <ConfigChecklist
            title="Wrap"
            listKey="wrap"
            ownerId={id}
            disabled={!editable}
            auto={{
              episode_status: [
                session.status === "Closed",
                session.status === "Closed" ? "Done when the session closed" : "Done by the app when you close the session",
              ],
            }}
          />
          <section className="glass panel" aria-label="Daily log">
            <h2>Daily log</h2>
            <textarea
              aria-label="Daily log"
              placeholder="What was recorded, timestamps of pickups, technical problems, who attended"
              value={dailyLog ?? session.dailyLog}
              disabled={!editable}
              onChange={(e) => setDailyLog(e.target.value)}
              onBlur={() => {
                if (
                  dailyLog !== null &&
                  dailyLog !== session.dailyLog &&
                  attempt(() => updateSession(actor, id, { dailyLog }), "Daily log saved")
                )
                  setDailyLog(null);
              }}
            />
          </section>
        </>
      )}
      {session.status === "Open" && (
        <GatePanel
          title="Close the session"
          gate={evaluateGate("Production", "session", id)}
          action="Close session and send to post production"
          disabled={!write}
          onDone={() => void close()}
        />
      )}
      {reasonModal}
    </div>
  );
}
