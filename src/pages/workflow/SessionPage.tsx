import { useState } from "react";
import type { RunItem } from "../../types";
import { categoryOf } from "../../config/categories";
import { PROJECT_ROLE_DEFS } from "../../config/workflow";
import { getDb, useDb } from "../../data/store";
import { canView, canWrite, getRecord } from "../../services/access";
import { getBreadcrumb } from "../../services/wrapped/content";
import { gearIssues, manifestForSheet } from "../../services/wrapped/equipment";
import { getPerson } from "../../services/wrapped/people";
import {
  addRunSheetItem,
  archiveSession,
  closeSession,
  createSessionCallSheet,
  duplicateSession,
  evaluateGate,
  getSession,
  openSession,
  removeRunSheetItem,
  reopenSession,
  resetRunSheet,
  rowsOf,
  RUN_SHEET_NOTE,
  updateRunSheetItem,
  updateSession,
  type Project,
} from "../../services/wrapped/workflow";
import { addDaysIso, fmtDate, fmtDateTime } from "../../services/utils";
import { cleanHtml } from "../../services/html";
import { pagesOf } from "../../services/wrapped/documents";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { Modal } from "../../ui/Modal";
import { DateShift } from "../../ui/DateShift";
import { CrewSelect, GatePanel } from "../../ui/workflow/shared";
import { ConfigChecklist, useDraft, useReason } from "./common";
import { focusNext, useFocusRow } from "../../ui/keys";
import { askIfScheduling, useReviewCheck } from "../../ui/ReviewCheck";
import { PersonName } from "../../ui/PersonName";
import { updateCallSheet } from "../../services/wrapped/callsheets";
import { dayTitle } from "../../services/wrapped/production";
import { RunOfShowSection } from "../production/SheetSections";
import { InstanceStrip } from "../production/InstanceStrip";
import { RecordingLog } from "./RecordingLog";
import type { CallSheet } from "../../types";

/** A live day's running order: its call sheet's run of show, with the live columns (status, actual times, cues). */
export function LiveRunOfShow({ sheet, editable }: { sheet: CallSheet; editable: boolean }) {
  const { actor, attempt } = useApp();
  return (
    <RunOfShowSection
      value={sheet}
      editable={editable}
      onChange={(patch) => attempt(() => updateCallSheet(actor, sheet.id, patch, sheet.version))}
      live
    />
  );
}

// One recording session: Pre-production while Planned (call sheet, gear, rehearsal), Production while Open (the
// run sheet and the log, then wrap), and the close that makes the episodes.

const stageOf = (status: string) => (status === "Planned" ? "Pre-production" : status === "Open" ? "Production" : "Closed");

function RunSheetRow({
  sessionId,
  item,
  editable,
  onEnterAdd,
}: {
  sessionId: string;
  item: RunItem;
  editable: boolean;
  onEnterAdd: (end: string) => void;
}) {
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
  // Enter moves to the next field (leaving one saves it); in the notes, it saves the row and adds one below.
  const next = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    focusNext(e.currentTarget);
  };
  return (
    <tr data-row={item.id}>
      <td>
        <input
          type="time"
          aria-label="Start"
          onKeyDown={next}
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
          onKeyDown={next}
          value={draft.title}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          onBlur={save}
        />
      </td>
      <td className="wf-who">
        <CrewSelect
          label={`Who: ${item.title}`}
          value={item.ownerPersonId}
          disabled={!editable}
          onChange={(p) => attempt(() => updateRunSheetItem(actor, sessionId, item.id, { ownerPersonId: p }))}
        />
      </td>
      <td>
        <input
          type="number"
          min={0}
          aria-label="Minutes"
          onKeyDown={next}
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
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (dirty) {
              if (!attempt(() => updateRunSheetItem(actor, sessionId, item.id, draft))) return;
              saved();
            }
            onEnterAdd(end || draft.time);
          }}
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

function RecordingDay({ project, sessionId, editable }: { project: Project; sessionId: string; editable: boolean }) {
  const { actor, attempt } = useApp();
  const [reviewCheck, reviewModal] = useReviewCheck();
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
    <section className="glass panel" aria-label={project.category === "live" ? "Show day" : "Recording day"}>
      <h2>{project.category === "live" ? "Show day" : "Recording day"}</h2>
      {reviewModal}
      <div className="row" style={{ alignItems: "end" }}>
        <Field label="Date">
          <input
            type="date"
            value={s.scheduledDate ?? ""}
            disabled={!editable}
            onChange={async (e) => {
              const date = e.target.value || null;
              const ok = await askIfScheduling(reviewCheck, s.contentId, sessionId, s.scheduledDate, date);
              if (ok && attempt(() => updateSession(actor, sessionId, { scheduledDate: date }))) ok.done();
            }}
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
          <h3>
            {project.category === "live"
              ? "Logged for post production"
              : `${categoryOf(project.category).workflow?.episodeLabel ?? "Episode"}s and guests`}
          </h3>
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
                    {c.role}: <b>{c.id ? <PersonName id={c.id} role={c.role} /> : c.name}</b>
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

/** A session's run sheet: the schedule of the day, which also sets the call sheet's call time. */
export function RunSheetPanel({ sessionId, editable }: { sessionId: string; editable: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const focusRow = useFocusRow('input[aria-label="Activity"]');
  const session = getSession(sessionId);
  if (!session) return null;
  const id = sessionId;
  const rows = rowsOf(id);
  // A devotion's run sheet has a "Record: <title>" row for each devotion on the session.
  const devotion = getRecord(session.contentId)?.workflow?.formType === "devotion";
  const planned = rows.filter((r) => r.plannedEpisodeId).length;
  const addAt = (time: string) => {
    const item = attempt(() => addRunSheetItem(actor, id, { time, title: "New item", durationMin: 15, notes: "" }));
    if (item) focusRow(item.id);
  };
  return (
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
                  body: devotion
                    ? `It is made again from the template, with a recording row for each of the ${planned} devotion${planned === 1 ? "" : "s"} on this session. Changes made to it are replaced.`
                    : `It is made again from the template for ${planned || 5} episodes. Changes made to it are replaced.`,
                  confirmLabel: "Rebuild",
                })
              )
                attempt(() => resetRunSheet(actor, id), "Run sheet rebuilt");
            }}
          >
            {devotion ? "Rebuild from episodes" : "Rebuild from the template"}
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
                <th>Who</th>
                <th>Minutes</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {session.runSheet.map((item) => (
                <RunSheetRow key={item.id} sessionId={id} item={item} editable={editable} onEnterAdd={addAt} />
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
          {devotion ? "+ Row" : "Add a line"}
        </button>
      )}
    </section>
  );
}

/** A session's wrap checklist, once recording has started. */
export function WrapPanel({ sessionId, editable }: { sessionId: string; editable: boolean }) {
  const session = getSession(sessionId);
  if (!session) return null;
  return (
    <ConfigChecklist
      title="Wrap"
      listKey="wrap"
      ownerId={sessionId}
      disabled={!editable}
      auto={{
        episode_status: [
          session.status === "Closed",
          session.status === "Closed" ? "Done when the session closed" : "Done by the app when you close the session",
        ],
      }}
    />
  );
}

/**
 * Copies a session to another date: its plan, run sheet and call sheet (every section), with gear where it is free
 * that day. The devotions or episodes on it are not copied.
 */
export function DuplicateSessionModal({
  session,
  onClose,
  onMade,
}: {
  session: { id: string; scheduledDate: string | null; name?: string };
  onClose: () => void;
  onMade?: (id: string) => void;
}) {
  const { actor, attempt, toast } = useApp();
  const [reviewCheck, reviewModal] = useReviewCheck();
  const [date, setDate] = useState(() => (session.scheduledDate ? addDaysIso(session.scheduledDate, 7) : ""));
  const save = async () => {
    // The copy is a new session on a date: scheduling it.
    const ok = await reviewCheck({ contentId: getSession(session.id)?.contentId, action: "schedule", targetId: session.id });
    if (!ok) return;
    const r = attempt(() => duplicateSession(actor, session.id, date));
    if (!r) return;
    ok.done(r.session.id);
    const skipped = r.gear.skipped.length ? ` Gear not free that day: ${r.gear.skipped.join(" ")}` : "";
    toast(
      `${r.session.id} made for ${fmtDate(date)}${r.sheet ? `, with call sheet ${r.sheet.id}` : ""}.${skipped}`,
      skipped ? "info" : "success",
    );
    onClose();
    onMade?.(r.session.id);
  };
  return (
    <Modal
      title={`Duplicate ${session.name?.trim() || session.id}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!date} onClick={() => void save()}>
            Duplicate
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Date of the new session">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus />
        </Field>
        <DateShift from={session.scheduledDate} value={date} onChange={setDate} />
        <p className="muted">
          The new session gets this one's name, hours, venue, storyboard, shot list and run sheet, and a copy of its call sheet with every
          section (ticks and confirmations cleared). Gear is booked where it is free that day. The episodes or devotions on this session
          stay on it.
        </p>
      </div>
      {reviewModal}
    </Modal>
  );
}

export function SessionPage({ id }: { id: string }) {
  const { actor, go, attempt, confirm, toast } = useApp();
  useDb();
  const [ask, reasonModal] = useReason();
  const [duplicating, setDuplicating] = useState(false);
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
  // A live event's day: its running order is its call sheet's run of show, and its show log names what was recorded.
  const live = p.category === "live";
  const episodeWord = (categoryOf(p.category).workflow?.episodeLabel ?? "Episode").toLowerCase();
  const rows = rowsOf(id);
  const sheet = session.callSheetId ? getDb().callSheets.find((c) => c.id === session.callSheetId) : undefined;
  const gear = sheet ? manifestForSheet(sheet.id) : undefined;
  const issues = sheet ? gearIssues(sheet.id) : [];
  const crumbs = getBreadcrumb(p.contentId);
  // The day's notes are written in the session's day sheet once it is started.
  const daySheet = getDb().projectDocuments.find((d) => d.ownerId === id && d.stage === "Production");

  const close = async () => {
    const make = rows.filter((r) => r.status === "Recorded" || r.status === "Pickup needed");
    const skip = rows.filter((r) => r.status === "Not recorded");
    const body = isDoc
      ? "The session closes. A documentary's film is made when it is sent to post production."
      : live
        ? make.length
          ? `${make.length} recording${make.length === 1 ? "" : "s"} will go to post production. This cannot be undone once editing starts on them.`
          : "Nothing was logged for post production: the day closes, and nothing goes to post production."
        : `${make.length} ${episodeWord}${make.length === 1 ? "" : "s"} will be made${skip.length ? `; ${skip.length} not recorded will stay planned for a later session` : ""}. This cannot be undone once editing starts on them.`;
    const title = live ? "Close the day?" : "Close session and send to post production?";
    if (!(await confirm({ title, body, confirmLabel: live ? "Close the day" : "Close session" }))) return;
    const res = attempt(() => closeSession(actor, id));
    if (res)
      toast(
        res.made.length ? `${live ? "Day" : "Session"} closed. Made ${res.made.join(", ")}.` : `${live ? "Day" : "Session"} closed.`,
        "success",
      );
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
          <h1>{live ? `${dayTitle(session)}: ${p.title}` : `Recording session ${session.sessionNumber}`}</h1>
          <div className="wf-chips" style={{ marginTop: 4 }}>
            <span className="cid">{session.id}</span>
            <span className={`badge ${session.status === "Closed" ? "ok" : "accent"}`}>{stageOf(session.status)}</span>
            {session.scheduledDate && <span className="muted">{fmtDate(session.scheduledDate)}</span>}
          </div>
        </div>
        {canWrite(actor, p) && !p.archived && p.workflow.stage === "Pre-production" && !live && (
          <button className="btn" onClick={() => setDuplicating(true)}>
            Duplicate…
          </button>
        )}
        {write && session.status === "Planned" && !session.instance && (
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
            Closed {session.closedAt ? fmtDateTime(session.closedAt) : ""}.{" "}
            {live ? "What it recorded is in the event's recording tracker." : "Its episodes are in the project's episode tracker."}
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

      {session.instance && <InstanceStrip day={session} write={write} />}
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
            title={live ? "Ready for the show" : "Ready to record"}
            gate={evaluateGate("Pre-production", "session", id)}
            action={live ? "Start the show: move to Production" : "Start recording: move to Production"}
            disabled={!write}
            onDone={async () => {
              if (
                await confirm({
                  title: live ? "Start the show?" : "Start recording?",
                  body: `The ${live ? "day" : "session"} moves into Production. It cannot move back to Pre-production.`,
                  confirmLabel: live ? "Start the show" : "Start recording",
                })
              )
                attempt(() => openSession(actor, id), live ? "Day in Production" : "Session in Production");
            }}
          />
        </>
      )}

      {live ? (
        sheet ? (
          <LiveRunOfShow sheet={sheet} editable={editable} />
        ) : (
          <Empty>This day has no call sheet, so no run of show yet.</Empty>
        )
      ) : (
        <RunSheetPanel sessionId={id} editable={editable} />
      )}

      <RecordingLog project={p} sessionId={id} write={write} />

      {session.status !== "Planned" && (
        <>
          <WrapPanel sessionId={id} editable={editable} />
          <section className="glass panel" aria-label="Daily log">
            <h2>Daily log</h2>
            {daySheet ? (
              <>
                <p className="muted">
                  Written in the session&apos;s {daySheet.title}, with the project&apos;s documents (Production). It began with this log.
                </p>
                <div className="pd-paper">
                  {/* Cleaned to the editor's allow-list, as on every load. */}
                  <div
                    className="pd-prose"
                    dangerouslySetInnerHTML={{
                      __html: cleanHtml(pagesOf(daySheet.id)[0]?.bodyHtml ?? "") || "<p><em>Nothing written yet.</em></p>",
                    }}
                  />
                </div>
              </>
            ) : (
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
            )}
          </section>
        </>
      )}
      {session.status === "Open" && (
        <GatePanel
          title={live ? "Close the day" : "Close the session"}
          gate={evaluateGate("Production", "session", id)}
          action={live ? "Close the day and send recordings to post production" : "Close session and send to post production"}
          disabled={!write}
          onDone={() => void close()}
        />
      )}
      {reasonModal}
      {duplicating && (
        <DuplicateSessionModal session={session} onClose={() => setDuplicating(false)} onMade={(sid) => go({ n: "session", id: sid })} />
      )}
    </div>
  );
}
