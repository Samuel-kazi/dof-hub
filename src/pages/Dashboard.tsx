import { useMemo, useRef, useState } from "react";
import { can } from "../services/wrapped/permissions";
import { useApp } from "../ui/AppContext";
import { useDb } from "../data/store";

import { categoryOf } from "../config/categories";
import { visibleCallSheets, visibleRecords } from "../services/access";
import {
  currentStageDeadline,
  displayTitle,
  getBlockedOnUser,
  isComplete,
  leavesUnder,
  productionUnits,
  riskOf,
  usesPipeline,
} from "../services/wrapped/content";
import { nameOf } from "../services/wrapped/people";
import { daysUntil, fmtShort, fmtSize, relativeDays, todayIso } from "../services/utils";
import { RiskBadge } from "../ui/parts";
import { NewRecordModal } from "./RecordForms";
import { IconCalendar, IconCam, IconDrive, IconFilm, IconPlus, IconPulse, IconSheet, IconUsers } from "../ui/Icons";
import { Empty } from "../ui/parts";
import { StorageBar } from "../ui/StorageViz";
import { WorkloadGrid } from "./Workload";
import { hasGearAccess, isOverdue, listManifests, manifestSummary, projectLabel } from "../services/wrapped/equipment";
import { allDriveUsage, fleetTotals, forecast, hasStorageAccess, isNearlyFull } from "../services/wrapped/storage";
import { crewWorkload } from "../services/workload";
import { modulesFor } from "../services/wrapped/permissions";
import { searchAll, type Hit } from "../services/search";
import { onBoard, waitingOnPerson, workItems, type WorkItem } from "../services/workItems";
import type { Route } from "../ui/AppContext";

interface HorizonRow {
  key: string;
  title: string;
  cid: string;
  start: string;
  due: string;
  late: boolean;
  lateDays: number;
  open: Route;
}

/** A session or an episode is named with its project, so "Session 1" or "Day 3" of two projects stay apart. */
const itemTitle = (i: WorkItem): string => (i.level === "project" ? i.title : `${i.context}, ${i.title}`);

const greeting = (): string => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

/** Search across everything this person may see. Arrow keys and Enter work. */
function HeroSearch() {
  const { actor, go } = useApp();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const hits = useMemo(() => searchAll(actor, q), [actor, q]);
  const box = useRef<HTMLDivElement>(null);
  const open = (h: Hit) => {
    setQ("");
    go(
      h.kind === "project"
        ? { n: "record", id: h.id }
        : h.kind === "session"
          ? { n: "session", id: h.id }
          : h.kind === "doc"
            ? { n: "doc", id: h.id }
            : h.kind === "callsheet"
              ? { n: "callsheet", id: h.id }
              : h.kind === "gear"
                ? { n: "item", id: h.id }
                : { n: "drive", id: h.id },
    );
  };
  const KIND: Record<Hit["kind"], string> = {
    project: "Project",
    session: "Session",
    doc: "Document",
    callsheet: "Call sheet",
    gear: "Gear",
    drive: "Drive",
  };
  return (
    <div className="hero-search" ref={box} role="search">
      <input
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((i) => Math.min(hits.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && hits[sel]) open(hits[sel]);
          else if (e.key === "Escape") setQ("");
        }}
        placeholder="Search projects, sessions, documents, gear"
        aria-label="Search everything"
        autoComplete="off"
      />
      <div className="underline" />
      {q.trim().length >= 2 && (
        <div className="results" role="listbox">
          {hits.length === 0 ? (
            <div className="empty">Nothing matches "{q.trim()}".</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.kind}-${h.id}`}
                className={`result ${i === sel ? "sel" : ""}`}
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => open(h)}
              >
                <span className="kind">{KIND[h.kind]}</span>
                <span className="grow" style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block" }}>{h.title}</span>
                  <span className="cid">{h.sub}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** One number, one line about it, and where to go for more. */
function StatCard({
  icon,
  title,
  range,
  big,
  unit,
  foot,
  bad,
  share,
  onClick,
}: {
  icon: JSX.Element;
  title: string;
  range?: string;
  big: string | number;
  unit?: string;
  foot: string;
  bad?: boolean;
  share?: number;
  onClick: () => void;
}) {
  return (
    <section className="glass gcard" aria-label={title} onClick={onClick} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onClick()}>
      <div className="gcard-head">
        <span className="tile">{icon}</span>
        <h3>{title}</h3>
        {range && <span className="range">{range}</span>}
      </div>
      <div>
        <span className="big">
          {big}
          {unit && <small>{unit}</small>}
        </span>
      </div>
      {share !== undefined && (
        <div className="meter" role="img" aria-label={`${Math.round(share)} percent`}>
          <i style={{ width: `${Math.max(2, Math.min(100, share))}%` }} />
        </div>
      )}
      <div className={`gcard-foot ${bad ? "bad" : ""}`}>{foot}</div>
    </section>
  );
}

export function Dashboard() {
  const { actor, me, go } = useApp();
  useDb(); // shows changes as they happen
  const [creating, setCreating] = useState(false);

  const records = visibleRecords(actor);
  const leaves = records.filter(usesPipeline);
  const inProgress = leaves.filter((r) => !isComplete(r));
  const projects = records.filter((r) => r.hierarchyLevel === 0);
  const activeProjects = projects.filter((p) => leavesUnder(p).some((l) => !isComplete(l)));
  const overdue = leaves.filter((r) => riskOf(r) === "overdue");
  const atRisk = leaves.filter((r) => riskOf(r) === "at-risk");
  const blocked = getBlockedOnUser(actor);
  const soon = visibleCallSheets(actor)
    .filter((cs) => daysUntil(cs.date) >= 0 && daysUntil(cs.date) <= 7)
    .sort((a, b) => a.date.localeCompare(b.date));
  // The Production card counts productions, not pipeline stages: a live show with several days is one production, not one per day.
  const units = productionUnits(leaves);
  const unitsInProgress = units.filter((u) => u.leaves.some((l) => !isComplete(l)));
  const unitsOverdue = units.filter((u) => u.leaves.some((l) => riskOf(l) === "overdue"));
  const unitsAtRisk = units.filter((u) => !unitsOverdue.includes(u) && u.leaves.some((l) => riskOf(l) === "at-risk"));
  // The five-stage workflow counts a project as one production, and its sessions and episodes as the work that can
  // run late (assumption A5: a project itself is never overdue).
  const wfItems = workItems(actor, false);
  const wfActive = records.filter((r) => r.workflow && r.workflow.status !== "Completed");
  const wfTracked = wfItems.filter((i) => !i.done && (onBoard(i) || i.overdue));
  const wfLate = wfTracked.filter((i) => i.overdue);
  const wfWaiting = waitingOnPerson(wfItems, actor.personId);
  const tracked = unitsInProgress.length + wfTracked.length;
  const lateCount = unitsOverdue.length + wfLate.length;
  const onTrack = tracked ? Math.round((100 * (tracked - lateCount - unitsAtRisk.length)) / tracked) : 100;
  const inProduction = unitsInProgress.length + wfActive.length;
  const activeCount = activeProjects.length + wfActive.length;
  const waitingCount = blocked.length + wfWaiting.length;
  // A session in the next week with no call sheet yet is a shoot nobody has been called to.
  const sessionsSoon = wfItems.filter(
    (i) => i.level === "session" && !i.done && !i.callSheetId && !!i.due && daysUntil(i.due) >= 0 && daysUntil(i.due) <= 7,
  );

  const gearAccess = hasGearAccess(actor);
  const storageAccess = hasStorageAccess(actor);
  const gearOut = gearAccess
    ? listManifests(actor)
        .filter((m) => m.status === "checked-out")
        .sort((a, b) => (a.expectedReturn ?? "").localeCompare(b.expectedReturn ?? ""))
    : [];
  const gearLate = gearOut.filter(isOverdue);
  const gearUnitsOut = gearOut.reduce((n, m) => n + m.lines.reduce((a, l) => a + l.quantity, 0), 0);
  const fleet = storageAccess ? fleetTotals() : { used: 0, capacity: 0 };
  const nearlyFull = storageAccess ? allDriveUsage().filter(isNearlyFull) : [];
  const fc = storageAccess ? forecast() : null;

  // Capacity for the coming week. The Head of Production sees the whole crew, crew see themselves.
  const crewAccess = modulesFor(actor).includes("crew");
  const week = crewAccess ? crewWorkload(actor, todayIso(), 7) : [];
  const stretched = week.filter((r) => r.workload.overDays.length > 0);

  // Horizon: at most five, overdue first, then nearest deadline. An earlier-pipeline item runs to its publish date;
  // a session to its date and an episode to the deadline of the stage it is in.
  const horizon: HorizonRow[] = [
    ...inProgress
      .filter((r) => r.deadline)
      .map((r): HorizonRow => {
        const late = riskOf(r) === "overdue";
        const stageDue = currentStageDeadline(r);
        return {
          key: r.contentId,
          title: displayTitle(r),
          cid: r.contentId,
          start: r.startDate,
          due: r.deadline!,
          late,
          lateDays: late
            ? Math.max(
                daysUntil(r.deadline!) < 0 ? -daysUntil(r.deadline!) : 0,
                stageDue && daysUntil(stageDue) < 0 ? -daysUntil(stageDue) : 0,
              )
            : 0,
          open: { n: "record", id: r.contentId },
        };
      }),
    ...wfItems
      // A session's day that has passed is not a deadline: sessions are never overdue.
      .filter((i) => !i.done && i.level !== "project" && !!i.due && (onBoard(i) || (i.level === "session" && i.due >= todayIso())))
      .map((i): HorizonRow => ({
        key: i.key,
        title: itemTitle(i),
        cid: i.id,
        start: i.start,
        due: i.due!,
        late: i.overdue,
        lateDays: i.overdue ? -daysUntil(i.due!) : 0,
        open: i.open,
      })),
  ]
    .sort((a, b) => Number(b.late) - Number(a.late) || a.due.localeCompare(b.due))
    .slice(0, 5);
  const elapsed = (start: string, end: string) => {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return Math.max(0.03, Math.min(1, (Date.now() - s) / Math.max(1, e - s)));
  };

  return (
    <div className="page">
      <div className="hero">
        <h1>
          {greeting()}, {me.name.split(" ")[0]}
        </h1>
        <HeroSearch />
        <div className="dash-actions">
          <span className="chip" style={{ cursor: "default" }}>
            <IconCalendar /> {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
          </span>
          {can(actor, "pipeline.manage") && (
            <button className="chip" onClick={() => setCreating(true)}>
              <IconPlus /> New project
            </button>
          )}
        </div>
      </div>

      <div className="stat-row">
        <StatCard
          icon={<IconFilm />}
          title="Production"
          big={inProduction}
          unit=" in production"
          share={onTrack}
          foot={
            lateCount || unitsAtRisk.length
              ? `${lateCount} overdue, ${unitsAtRisk.length} at risk, ${activeCount} active project${activeCount === 1 ? "" : "s"}`
              : `${onTrack}% on track, ${activeCount} active project${activeCount === 1 ? "" : "s"}`
          }
          bad={lateCount > 0}
          onClick={() => go({ n: "pipeline" })}
        />
        {gearAccess && (
          <StatCard
            icon={<IconCam />}
            title="Gear"
            big={gearUnitsOut}
            unit={gearUnitsOut === 1 ? " unit out" : " units out"}
            foot={
              gearLate.length
                ? `${gearLate.length} checkout list${gearLate.length === 1 ? "" : "s"} overdue`
                : gearOut.length
                  ? "All on time"
                  : "Everything is in the studio"
            }
            bad={gearLate.length > 0}
            onClick={() => go({ n: "equipment", tab: "checkouts" })}
          />
        )}
        {storageAccess && (
          <StatCard
            icon={<IconDrive />}
            title="Storage"
            big={(fleet.used / 1000).toFixed(1)}
            unit=" TB used"
            share={fleet.capacity ? (100 * fleet.used) / fleet.capacity : 0}
            foot={
              nearlyFull.length
                ? `${nearlyFull.length} drive${nearlyFull.length === 1 ? "" : "s"} nearly full`
                : fc && fc.slopeGBPerDay > 0
                  ? `${fmtSize(fc.slopeGBPerDay * 7)} added per week`
                  : `${fmtSize(fleet.capacity - fleet.used)} free`
            }
            bad={nearlyFull.length > 0}
            onClick={() => go({ n: "storage" })}
          />
        )}
        {crewAccess &&
          (can(actor, "workload.viewAll") ? (
            <StatCard
              icon={<IconUsers />}
              title="Crew capacity"
              big={stretched.length}
              unit={stretched.length === 1 ? " person over capacity" : " people over capacity"}
              foot={
                stretched.length
                  ? `${stretched
                      .slice(0, 3)
                      .map((r) => r.person.name.split(" ")[0])
                      .join(", ")}${stretched.length > 3 ? " and more" : ""}, in the next 7 days`
                  : "Everyone has room this week"
              }
              bad={stretched.length > 0}
              onClick={() => go({ n: "crew", tab: "workload" })}
            />
          ) : (
            <StatCard
              icon={<IconUsers />}
              title="Your week"
              big={week[0]?.workload.overDays.length ?? 0}
              unit=" days over capacity"
              foot={
                week[0] && week[0].workload.overDays.length
                  ? `Over capacity on ${week[0].workload.overDays.slice(0, 3).map(fmtShort).join(", ")}`
                  : "You have room this week"
              }
              bad={!!week[0]?.workload.overDays.length}
              onClick={() => go({ n: "crew", tab: "workload" })}
            />
          ))}
        {!gearAccess && (
          <StatCard
            icon={<IconPulse />}
            title="Waiting on you"
            big={waitingCount}
            unit={waitingCount === 1 ? " item" : " items"}
            foot={
              blocked[0] ? `Next: ${displayTitle(blocked[0])}` : wfWaiting[0] ? `Next: ${itemTitle(wfWaiting[0])}` : "Nothing needs you"
            }
            onClick={() => go({ n: "pipeline" })}
          />
        )}
        {!gearAccess && (
          <StatCard
            icon={<IconSheet />}
            title="Shoots"
            big={soon.length + sessionsSoon.length}
            unit=" this week"
            foot={soon[0] ? `Next: ${soon[0].title}` : sessionsSoon[0] ? `Next: ${itemTitle(sessionsSoon[0])}` : "None scheduled"}
            onClick={() => go({ n: "callsheets" })}
          />
        )}
      </div>

      <section className="glass panel" aria-label="Nearest deadlines">
        <h2>Nearest deadlines</h2>
        {horizon.length === 0 ? (
          <Empty>Nothing with a deadline is in production right now.</Empty>
        ) : (
          <div className="horizon">
            {horizon.map((r) => (
              <div
                key={r.key}
                className="hz-row"
                onClick={() => go(r.open)}
                role="link"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && go(r.open)}
              >
                <div>
                  <div className="hz-title">{r.title}</div>
                  <div className="cid">{r.cid}</div>
                </div>
                <div className="hz-track" title={r.late ? "Overdue" : `Due ${fmtShort(r.due)}`}>
                  <div
                    className={`hz-fill ${r.late ? "late" : ""}`}
                    style={{ width: `${r.late ? 100 : elapsed(r.start, r.due) * 100}%` }}
                  />
                </div>
                <div className="hz-when">
                  {r.late ? (
                    <span className="badge bad">{r.lateDays > 0 ? `${r.lateDays} days late` : "Overdue"}</span>
                  ) : (
                    <span>
                      {fmtShort(r.due)}
                      <span className="muted"> ({relativeDays(r.due)})</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid-2">
        <section className="glass panel" aria-label="Blocked on you">
          <h2>Waiting on you</h2>
          {waitingCount === 0 ? (
            <Empty>Nothing is waiting on you.</Empty>
          ) : (
            <div className="list">
              {wfWaiting.map((i) => (
                <div key={i.key} className="list-item" onClick={() => go(i.open)}>
                  <div className="grow">
                    <div className="title">{itemTitle(i)}</div>
                    <div className="muted" style={{ fontSize: ".84rem" }}>
                      {i.stage}:{" "}
                      {i.reviews
                        .filter((r) => r.reviewerIds.includes(actor.personId))
                        .map((r) => r.label)
                        .join(", ") || i.step}
                    </div>
                  </div>
                  {i.due && (
                    <span className={`badge ${i.overdue ? "bad" : i.level !== "project" && daysUntil(i.due) <= 1 ? "warn" : ""}`}>
                      {relativeDays(i.due)}
                    </span>
                  )}
                </div>
              ))}
              {blocked.map((r) => {
                const due = currentStageDeadline(r);
                const out = categoryOf(r.category).stages.find((s) => s.name === r.pipelineStage)?.requiredOutput;
                return (
                  <div key={r.contentId} className="list-item" onClick={() => go({ n: "record", id: r.contentId })}>
                    <div className="grow">
                      <div className="title">{displayTitle(r)}</div>
                      <div className="muted" style={{ fontSize: ".84rem" }}>
                        {r.pipelineStage}: {out}
                      </div>
                    </div>
                    {due && (
                      <span className={`badge ${daysUntil(due) < 0 ? "bad" : daysUntil(due) <= 1 ? "warn" : ""}`}>{relativeDays(due)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="glass panel" aria-label="At risk">
          <h2>At risk</h2>
          {overdue.length + atRisk.length + wfLate.length === 0 ? (
            <Empty>Everything is on track.</Empty>
          ) : (
            <div className="list">
              {wfLate.map((i) => (
                <div key={i.key} className="list-item" onClick={() => go(i.open)}>
                  <div className="grow">
                    <div className="title">{itemTitle(i)}</div>
                    <div className="muted" style={{ fontSize: ".84rem" }}>
                      {i.stage}: {i.step}, {nameOf(i.ownerId)}
                    </div>
                  </div>
                  <span className="badge bad">Overdue</span>
                </div>
              ))}
              {[...overdue, ...atRisk].map((r) => (
                <div key={r.contentId} className="list-item" onClick={() => go({ n: "record", id: r.contentId })}>
                  <div className="grow">
                    <div className="title">{displayTitle(r)}</div>
                    <div className="muted" style={{ fontSize: ".84rem" }}>
                      {r.pipelineStage}, {nameOf(r.assigneePersonId)}
                    </div>
                  </div>
                  <RiskBadge record={r} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {(gearAccess || crewAccess) && (
        <div className="grid-2">
          {crewAccess && (
            <section className="glass panel" aria-label="Crew load">
              <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                <h2 style={{ flex: 1 }}>{can(actor, "workload.viewAll") ? "Crew load this week" : "Your week"}</h2>
                <button className="btn small" onClick={() => go({ n: "crew", tab: "workload" })}>
                  Full workload
                </button>
              </div>
              <WorkloadGrid rows={week} compact />
            </section>
          )}
          {gearAccess && (
            <section className="glass panel" aria-label="Gear out">
              <h2>Gear out</h2>
              {gearOut.length === 0 ? (
                <Empty>All gear is in the studio.</Empty>
              ) : (
                <div className="list">
                  {gearOut.map((m) => (
                    <div key={m.id} className="list-item" onClick={() => go({ n: "manifest", id: m.id })}>
                      <div className="grow">
                        <div className="title">{projectLabel(actor, m.contentId)}</div>
                        <div className="muted" style={{ fontSize: ".84rem" }}>
                          {nameOf(m.responsiblePersonId)}, {manifestSummary(m)}
                        </div>
                      </div>
                      {isOverdue(m) ? (
                        <span className="badge bad">Due {relativeDays(m.expectedReturn!)}</span>
                      ) : (
                        <span className="badge">Back {relativeDays(m.expectedReturn ?? m.date)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {nearlyFull.length > 0 && (
        <section className="glass panel" aria-label="Drives nearly full">
          <h2 style={{ marginBottom: 12 }}>Drives nearly full</h2>
          <div className="stack">
            {nearlyFull.map((u) => (
              <div key={u.drive.id} style={{ cursor: "pointer" }} onClick={() => go({ n: "drive", id: u.drive.id })}>
                <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <span style={{ flex: 1 }}>{u.drive.name}</span>
                  <span className="muted">
                    {u.pct.toFixed(0)}%, {fmtSize(u.freeGB)} free
                  </span>
                </div>
                <StorageBar usage={u} legend={false} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="glass panel" aria-label="Upcoming call sheets">
        <h2>Shoots in the next 7 days</h2>
        {soon.length + sessionsSoon.length === 0 ? (
          <Empty>No call sheets are scheduled this week.</Empty>
        ) : (
          <div className="list">
            {sessionsSoon.map((i) => (
              <div key={i.key} className="list-item" onClick={() => go(i.open)}>
                <div className="grow">
                  <div className="title">{itemTitle(i)}</div>
                  <div className="muted" style={{ fontSize: ".84rem" }}>
                    Recording session {i.id}. It has no call sheet yet.
                  </div>
                </div>
                <span className="badge accent">{relativeDays(i.due!)}</span>
                <span className="badge warn">No call sheet</span>
              </div>
            ))}
            {soon.map((cs) => (
              <div key={cs.id} className="list-item" onClick={() => go({ n: "callsheet", id: cs.id })}>
                <div className="grow">
                  <div className="title">{cs.title}</div>
                  <div className="muted" style={{ fontSize: ".84rem" }}>
                    {cs.location || "Location not set"}, call time {cs.callTime}
                  </div>
                </div>
                <span className="badge accent">{relativeDays(cs.date)}</span>
                <span className={`badge ${cs.status === "final" ? "ok" : ""}`}>{cs.status === "final" ? "Final" : "Draft"}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      {creating && (
        <NewRecordModal
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            go({ n: "record", id: r.contentId });
          }}
        />
      )}
    </div>
  );
}
