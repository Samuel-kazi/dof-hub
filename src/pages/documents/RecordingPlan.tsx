import { useState } from "react";
import type { RecordingSession, SessionLabel } from "../../types";
import { roleName, SESSION_LABELS } from "../../config/workflow";
import { planLabels } from "../../config/documentCatalog";
import { getDb } from "../../data/store";
import { driveUsage } from "../../services/driveUsage";
import { hasStorageAccess } from "../../services/storage";
import { canManageTeam } from "../../services/workflow/common";
import { fmtDate, fmtSize } from "../../services/utils";
import { framesOf, makeDevotionEpisodes, rowsOfShotList, shotListsOf, shotNumbers, storyboardsOf } from "../../services/wrapped/documents";
import { nameOf } from "../../services/wrapped/people";
import {
  addPlanRole,
  archiveSession,
  assignDevotion,
  createSession,
  createSessionCallSheet,
  devotionPlacements,
  planRolesOf,
  removeRole,
  renamePlanRole,
  roleHolder,
  sessionName,
  sessionsOf,
  setProjectDrive,
  setRolePerson,
  setSessionBoards,
  sheetTimes,
  startPlanRoles,
  updateSession,
  type Placement,
  type Project,
} from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { askIfScheduling, useReviewCheck } from "../../ui/ReviewCheck";
import { Empty, Field } from "../../ui/parts";
import { CrewSelect } from "../../ui/workflow/shared";
import { CallSheetBody } from "../CallSheets";
import { useReason } from "../workflow/common";
import { DuplicateSessionModal, RunSheetPanel } from "../workflow/SessionPage";
import { imageSrc } from "./images";
import type { FixedCard } from "./PageList";
import { sheetContacts, usePrintCallSheet } from "./printCallSheet";
import { SavedInput } from "./toolkit";

// A devotion's Recording Plan (section 7A of the documents brief): four section cards before its pages. The project's
// roles, each held by someone from the crew; the devotions, read from the script, each on one recording session; the
// sessions themselves, with the devotions ticked on each; and one call sheet per session, with its run sheet and the
// storyboard and shot list it uses. Built on the project's own roles, sessions and call sheets, so the same plan can
// serve a series or documentary later.

export type PlanSection = "roles" | "devotions" | "sessions" | "callSheets";

const liveSessions = (projectId: string): RecordingSession[] =>
  sessionsOf(projectId)
    .filter((s) => !s.archivedAt)
    .sort((a, b) => a.sessionNumber - b.sessionNumber);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the plan's items are called for this project: devotions, episodes or parts. */
const labelsOf = (projectId: string) => planLabels((getDb().records.find((r) => r.contentId === projectId) as Project).workflow.formType);

/** The plan's section cards, with where each stands. */
export function planCards(projectId: string): FixedCard[] {
  const L = labelsOf(projectId);
  const roles = planRolesOf(projectId);
  const placed = devotionPlacements(projectId);
  const waiting = placed.filter((x) => !x.sessionId && !x.locked).length;
  const sessions = liveSessions(projectId);
  const sheets = sessions.filter((s) => s.callSheetId).length;
  const card = (id: PlanSection, title: string, note: string): FixedCard => ({ id: `plan:${id}`, title, note, at: "start", tag: "plan" });
  return [
    card("roles", "Project roles", roles.length ? `${roles.filter(roleHolder).length} of ${roles.length} have a person` : "No roles yet"),
    card(
      "devotions",
      L.title,
      placed.length
        ? `${placed.length - waiting} of ${placed.length} assigned${waiting ? ` · ${waiting} ${waiting === 1 ? "needs" : "need"} a session` : ""}`
        : "Not listed yet",
    ),
    card("sessions", "Recording sessions", sessions.length ? plural(sessions.length, "session") : "None yet"),
    card("callSheets", "Call sheets", sessions.length ? `${sheets} of ${sessions.length} made` : "One per session"),
  ];
}

/** What a session is, in a line: its name, label, date and time range. */
export function sessionLine(s: RecordingSession): string {
  const when = [
    s.label,
    s.scheduledDate ? fmtDate(s.scheduledDate) : "No date yet",
    s.startTime && `${s.startTime}${s.endTime ? `–${s.endTime}` : ""}`,
  ];
  return [sessionName(s), ...when].filter(Boolean).join(" · ");
}

export function PlanSectionView({
  project,
  section,
  write,
  onOpenTool,
}: {
  project: Project;
  section: PlanSection;
  write: boolean;
  onOpenTool: (key: "storyboard" | "shot_list") => void;
}) {
  switch (section) {
    case "roles":
      return <RolesSection project={project} write={write} />;
    case "devotions":
      return <DevotionsSection project={project} write={write} />;
    case "sessions":
      return <SessionsSection project={project} write={write} />;
    case "callSheets":
      return <CallSheetsSection project={project} write={write} onOpenTool={onOpenTool} />;
  }
}

// ── 1. Project roles ─────────────────────────────────────────

function RolesSection({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const [adding, setAdding] = useState("");
  const roles = planRolesOf(project.contentId);
  const manage = write && !project.archived && canManageTeam(actor, project) && project.workflow.stage === "Pre-production";
  const guest = String(getDb().developmentForms.find((f) => f.contentId === project.contentId)?.sections.guest?.name ?? "").trim();
  const add = () => {
    if (attempt(() => addPlanRole(actor, project.contentId, adding), `${adding.trim()} added`)) setAdding("");
  };
  return (
    <section className="glass panel rp-section" aria-label="Project roles">
      <h2>Project roles</h2>
      <p className="muted">
        Each role needs someone from the crew before recording.{" "}
        {guest && project.workflow.formType === "devotion" ? `The devotion's guest, ${guest}, is its host.` : ""}{" "}
        {manage
          ? "Rename a role by typing over its name."
          : "The show producer, or someone who may assign other people's work, changes these."}
      </p>
      {roles.length === 0 ? (
        <Empty>No roles yet.</Empty>
      ) : (
        <ul className="rp-roles">
          {roles.map((r) => (
            <li key={r.id}>
              {manage ? (
                <SavedInput
                  aria-label={`Name of the role ${roleName(r)}`}
                  value={roleName(r)}
                  onSave={(next) => attempt(() => renamePlanRole(actor, r.id, next), "Role renamed")}
                />
              ) : (
                <b>{roleName(r)}</b>
              )}
              {r.guestName && !r.crewId ? (
                <span>{r.guestName} (outside the crew)</span>
              ) : (
                <CrewSelect
                  label={`Who is ${roleName(r)}`}
                  value={r.crewId}
                  none="No one yet"
                  disabled={!manage}
                  onChange={(p) => attempt(() => setRolePerson(actor, r.id, p), `${roleName(r)}: ${p ? nameOf(p) : "no one yet"}`)}
                />
              )}
              <span>{!roleHolder(r) && <span className="badge warn">Needs a person</span>}</span>
              {manage && (
                <button
                  className="btn small ghost"
                  aria-label={`Remove the role ${roleName(r)}`}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Remove ${roleName(r)}?`,
                        body: "The role is taken off this project's plan. It can be added again.",
                        confirmLabel: "Remove role",
                        danger: true,
                      })
                    )
                      attempt(() => removeRole(actor, r.id), "Role removed");
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <div className="row rp-add">
          <Field label="A role to add">
            <input
              type="text"
              value={adding}
              maxLength={60}
              placeholder="Makeup"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && adding.trim() && add()}
            />
          </Field>
          <div style={{ flex: "none" }}>
            <button className="btn" disabled={!adding.trim()} onClick={add}>
              + Add role
            </button>
          </div>
          {roles.length === 0 && (
            <div style={{ flex: "none" }}>
              <button className="btn primary" onClick={() => attempt(() => startPlanRoles(actor, project.contentId), "Roles listed")}>
                List the usual roles
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── 2. Devotions ─────────────────────────────────────────────

const contentIdOf = (x: Placement): string =>
  getDb().records.find((r) => r.episode?.plannedEpisodeId === x.planned.id && !r.archived)?.contentId ??
  x.planned.reservedId ??
  x.planned.id;

function DevotionsSection({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt, toast } = useApp();
  const placed = devotionPlacements(project.contentId);
  const sessions = new Map(liveSessions(project.contentId).map((s) => [s.id, s]));
  const waiting = placed.filter((x) => !x.sessionId && !x.locked).length;
  const pre = project.workflow.stage === "Pre-production";
  const L = planLabels(project.workflow.formType);
  const devotion = project.workflow.formType === "devotion";
  return (
    <section className="glass panel rp-section" aria-label={L.title}>
      <div className="wf-head">
        <h2>{L.title}</h2>
        {placed.length > 0 && (
          <span className={`badge ${waiting ? "warn" : "ok"}`}>
            {placed.length - waiting} of {placed.length} assigned
          </span>
        )}
      </div>
      <p className="muted">
        {devotion
          ? "Read from the Devotional Script as it stands: each page is one devotion, with its topic and scripture."
          : `Read from ${L.source} as it stands.`}{" "}
        Each is recorded in one session, ticked under Recording sessions.
      </p>
      {devotion && placed[0]?.planned.question && (
        <p className="pd-theme">
          Theme, shared by every devotion: <b>{placed[0].planned.question}</b>
        </p>
      )}
      {placed.length === 0 ? (
        <Empty>
          {!devotion
            ? `No ${L.many} are planned yet. Add them in ${L.source}.`
            : pre
              ? "The devotions are not listed from the script yet."
              : "The devotions are listed once the devotion is accepted."}
        </Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Content ID</th>
                <th>{devotion ? "Topic" : "Title"}</th>
                <th>{L.detail}</th>
                <th>Session</th>
              </tr>
            </thead>
            <tbody>
              {placed.map((x) => (
                <tr key={x.planned.id}>
                  <td className="cid">{contentIdOf(x)}</td>
                  <td>{x.title}</td>
                  <td>{(devotion ? x.scripture : x.planned.question) || <span className="muted">None given</span>}</td>
                  <td>
                    {x.sessionId ? (
                      sessionName(sessions.get(x.sessionId))
                    ) : x.locked ? (
                      <span className="muted">Recorded</span>
                    ) : (
                      <span className="badge warn">Needs a session</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {write && pre && devotion && (
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn"
            disabled={project.archived}
            onClick={() => {
              const r = attempt(() => makeDevotionEpisodes(actor, project.contentId));
              if (r)
                toast(
                  r.made.length || r.updated.length
                    ? `${r.made.length} listed, ${r.updated.length} brought up to date from the script`
                    : "The list already matches the script",
                  "success",
                );
            }}
          >
            {placed.length ? "Bring the list up to date from the script" : "List the devotions from the script"}
          </button>
        </div>
      )}
    </section>
  );
}

// ── 3. Recording sessions ────────────────────────────────────

interface NewSession {
  name: string;
  label: SessionLabel | "";
  date: string;
  start: string;
  end: string;
  venue: string;
}
const NO_SESSION: NewSession = { name: "", label: "", date: "", start: "", end: "", venue: "" };

function SessionsSection({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt } = useApp();
  const [draft, setDraft] = useState<NewSession>(NO_SESSION);
  const [ask, reasonModal] = useReason();
  const sessions = liveSessions(project.contentId);
  const removed = sessionsOf(project.contentId).filter((s) => s.archivedAt);
  const placed = devotionPlacements(project.contentId);
  const L = planLabels(project.workflow.formType);
  const canAdd = write && !project.archived && project.workflow.stage === "Pre-production";
  const [reviewCheck, reviewModal] = useReviewCheck();
  const add = async () => {
    const ok = await askIfScheduling(reviewCheck, project.contentId, "new session", null, draft.date || null);
    if (!ok) return;
    const made = attempt(
      () =>
        createSession(actor, project.contentId, {
          name: draft.name,
          label: draft.label || null,
          scheduledDate: draft.date || null,
          startTime: draft.start || null,
          endTime: draft.end || null,
          venue: draft.venue,
        }),
      "Session added",
    );
    if (made) {
      ok.done(made.id);
      setDraft(NO_SESSION);
    }
  };
  return (
    <section className="glass panel rp-section" aria-label="Recording sessions">
      <h2>Recording sessions</h2>
      <p className="muted">
        Tick the {L.many} each session records. Each {L.one} is on one session: ticking it on another moves it there. A session's call sheet
        is made as soon as it has a date.
      </p>
      {sessions.length === 0 && <Empty>No sessions yet.</Empty>}
      {sessions.map((s) => (
        <SessionCard
          key={s.id}
          project={project}
          session={s}
          placed={placed}
          write={write}
          onRemove={async () => {
            const reason = await ask(
              `Remove ${sessionName(s)}`,
              `Why? The session is kept, archived with this reason, and its ${L.many} need a session again.`,
              "Remove session",
            );
            if (reason) attempt(() => archiveSession(actor, s.id, reason), `Session removed. Its ${L.many} need a session again.`);
          }}
        />
      ))}
      {removed.length > 0 && <p className="muted">Removed: {removed.map((s) => `${sessionName(s)} (${s.archivedReason})`).join(", ")}</p>}
      {canAdd && (
        <div className="rp-new" aria-label="Add a session">
          <h3>Add a session</h3>
          <div className="row">
            <Field label="Name">
              <input
                type="text"
                value={draft.name}
                maxLength={120}
                placeholder="Day 1"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="Label">
              <select value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value as SessionLabel | "" })}>
                <option value="">None</option>
                {SESSION_LABELS.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </Field>
            <Field label="Date">
              <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
            </Field>
          </div>
          <div className="row">
            <Field label="From">
              <input type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
            </Field>
            <Field label="To">
              <input type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
            </Field>
            <Field label="Venue">
              <input
                type="text"
                value={draft.venue}
                placeholder="DOF Studio A"
                onChange={(e) => setDraft({ ...draft, venue: e.target.value })}
              />
            </Field>
          </div>
          <button className="btn primary" onClick={() => void add()}>
            + Add session
          </button>
        </div>
      )}
      {reasonModal}
      {reviewModal}
    </section>
  );
}

const STATUS_TEXT: Record<RecordingSession["status"], string> = { Planned: "Planned", Open: "Recording", Closed: "Closed" };

function SessionCard({
  project,
  session: s,
  placed,
  write,
  onRemove,
}: {
  project: Project;
  session: RecordingSession;
  placed: Placement[];
  write: boolean;
  onRemove: () => void;
}) {
  const { actor, attempt, go } = useApp();
  const [duplicating, setDuplicating] = useState(false);
  const [reviewCheck, reviewModal] = useReviewCheck();
  const L = planLabels(project.workflow.formType);
  const edit = write && !project.archived && s.status !== "Closed";
  const save = (patch: Parameters<typeof updateSession>[2]) => attempt(() => updateSession(actor, s.id, patch));
  const here = placed.filter((x) => x.sessionId === s.id).length;
  return (
    <article className="rp-session" aria-label={sessionName(s)}>
      <div className="wf-head">
        <h3>
          {sessionName(s)} <span className="cid">{s.id}</span>
        </h3>
        <span className={`badge ${s.status === "Closed" ? "ok" : s.status === "Open" ? "accent" : ""}`}>{STATUS_TEXT[s.status]}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => go({ n: "session", id: s.id })}>
          Open the session
        </button>
        {write && !project.archived && project.workflow.stage === "Pre-production" && (
          <button className="btn small" onClick={() => setDuplicating(true)}>
            Duplicate…
          </button>
        )}
        {write && s.status === "Planned" && !project.archived && (
          <button className="btn small ghost" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {duplicating && <DuplicateSessionModal session={s} onClose={() => setDuplicating(false)} />}
      {reviewModal}
      <div className="row">
        <Field label="Name">
          <SavedInput
            value={s.name ?? ""}
            maxLength={120}
            disabled={!edit}
            placeholder={`Session ${s.sessionNumber}`}
            onSave={(name) => save({ name })}
          />
        </Field>
        <Field label="Label">
          <select value={s.label ?? ""} disabled={!edit} onChange={(e) => save({ label: (e.target.value || null) as SessionLabel | null })}>
            <option value="">None</option>
            {SESSION_LABELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={s.scheduledDate ?? ""}
            disabled={!edit}
            onChange={async (e) => {
              const date = e.target.value || null;
              const ok = await askIfScheduling(reviewCheck, project.contentId, s.id, s.scheduledDate, date);
              if (ok && save({ scheduledDate: date })) ok.done();
            }}
          />
        </Field>
      </div>
      <div className="row">
        <Field label="From">
          <input type="time" value={s.startTime ?? ""} disabled={!edit} onChange={(e) => save({ startTime: e.target.value || null })} />
        </Field>
        <Field label="To">
          <input type="time" value={s.endTime ?? ""} disabled={!edit} onChange={(e) => save({ endTime: e.target.value || null })} />
        </Field>
        <Field label="Venue">
          <SavedInput value={s.venue} disabled={!edit} onSave={(venue) => save({ venue })} />
        </Field>
      </div>
      <fieldset className="rp-ticks">
        <legend>
          {L.title} on this session ({here} of {placed.length})
        </legend>
        {placed.length === 0 ? (
          <p className="muted">
            The {L.many} are listed from {L.source}, under {L.title}.
          </p>
        ) : (
          placed.map((x) => {
            const on = x.sessionId === s.id;
            const elsewhere = x.sessionId && !on ? getDb().recordingSessions.find((o) => o.id === x.sessionId) : undefined;
            return (
              <label key={x.planned.id} className="check">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!edit || s.status !== "Planned" || x.locked}
                  onChange={(e) =>
                    attempt(
                      () => assignDevotion(actor, x.planned.id, e.target.checked ? s.id : null),
                      e.target.checked ? `${x.title} is on ${sessionName(s)}` : `${x.title} needs a session`,
                    )
                  }
                />
                <span>
                  {x.title}
                  {elsewhere && <span className="muted"> · on {sessionName(elsewhere)}</span>}
                  {x.locked && !on && !elsewhere && <span className="muted"> · recorded</span>}
                </span>
              </label>
            );
          })
        )}
      </fieldset>
    </article>
  );
}

// ── 4. Call sheets ───────────────────────────────────────────

function CallSheetsSection({
  project,
  write,
  onOpenTool,
}: {
  project: Project;
  write: boolean;
  onOpenTool: (key: "storyboard" | "shot_list") => void;
}) {
  const { actor, attempt, go } = useApp();
  const sessions = liveSessions(project.contentId);
  const [tab, setTab] = useState<string | null>(() => (sessions.find((s) => s.status !== "Closed") ?? sessions[0])?.id ?? null);
  const [print, printNode] = usePrintCallSheet();
  const s = sessions.find((x) => x.id === tab) ?? sessions[0];
  if (!s)
    return (
      <section className="glass panel rp-section" aria-label="Call sheets">
        <h2>Call sheets</h2>
        <Empty>No sessions yet. Each session added under Recording sessions gets its call sheet here.</Empty>
      </section>
    );
  const cs = s.callSheetId ? getDb().callSheets.find((c) => c.id === s.callSheetId) : undefined;
  const edit = write && !project.archived && s.status !== "Closed";
  // The call sheet itself shows the schedule (its times read from the run sheet when not typed), the crew's contacts
  // and the run sheet. The plan adds its roles, the session's devotions and its storyboard and shot list, and, as
  // contacts, the guest and any role holder not on the sheet's crew.
  const planParts = (
    <>
      <RolesOnSheet project={project} />
      <DevotionsOnSheet project={project} session={s} />
      <BoardsOnSheet project={project} session={s} edit={edit} onOpenTool={onOpenTool} />
    </>
  );
  const onCrew = new Set(cs?.crewPersonIds ?? []);
  const moreContacts = sheetContacts(project, actor).filter(
    (c) =>
      c.role === "Guest (host)" || !planRolesOf(project.contentId).some((r) => r.crewId && onCrew.has(r.crewId) && roleName(r) === c.role),
  );
  return (
    <section className="rp-section rp-sheets" aria-label="Call sheets">
      <div className="glass panel">
        <h2>Call sheets</h2>
        <div className="rp-tabs" role="tablist" aria-label="Sessions">
          {sessions.map((x) => (
            <button key={x.id} role="tab" aria-selected={x.id === s.id} className={x.id === s.id ? "on" : ""} onClick={() => setTab(x.id)}>
              {sessionName(x)}
              {x.label ? <span className="muted"> · {x.label}</span> : null}
            </button>
          ))}
        </div>
        <div className="rp-sheet-bar">
          <span className="grow">
            <b>{sessionLine(s)}</b>
            {cs && <span className={`badge ${cs.status === "final" ? "ok" : ""}`}>{cs.status === "final" ? "Final" : "Draft"}</span>}
          </span>
          <button className="btn small" onClick={() => print({ sessionId: s.id, only: "all" })}>
            Print call sheet
          </button>
          <button className="btn small" onClick={() => print({ sessionId: s.id, only: "run" })}>
            Print run sheet only
          </button>
          {cs && (
            <button className="btn small" onClick={() => go({ n: "callsheet", id: cs.id })}>
              Open in Call sheets
            </button>
          )}
        </div>
      </div>
      {cs ? (
        <CallSheetBody key={cs.id} cs={cs} root={project} embedded moreContacts={moreContacts}>
          {planParts}
        </CallSheetBody>
      ) : (
        <>
          <section className="glass panel">
            {s.scheduledDate && edit ? (
              <div className="row">
                <span className="grow">This session has a date but no call sheet yet.</span>
                <button className="btn primary" onClick={() => attempt(() => createSessionCallSheet(actor, s.id), "Call sheet made")}>
                  Make the call sheet
                </button>
              </div>
            ) : (
              <Empty>
                {s.scheduledDate
                  ? "This session has no call sheet."
                  : "Set this session's date under Recording sessions: its call sheet is made then."}
              </Empty>
            )}
          </section>
          <TimesAndContacts project={project} session={s} />
          <RolesOnSheet project={project} />
          <DevotionsOnSheet project={project} session={s} />
          <RunSheetPanel sessionId={s.id} editable={edit} />
          <BoardsOnSheet project={project} session={s} edit={edit} onOpenTool={onOpenTool} />
        </>
      )}
      {printNode}
    </section>
  );
}

function TimesAndContacts({ project, session }: { project: Project; session: RecordingSession }) {
  const { actor } = useApp();
  const t = sheetTimes(session.runSheet);
  const contacts = sheetContacts(project, actor);
  const time = (v: string | null) => v ?? <span className="muted">Not on the run sheet</span>;
  return (
    <section className="glass panel" aria-label="Times and contacts">
      <h2>Times and contacts</h2>
      <p className="muted">The times are read from the run sheet below; change them there.</p>
      <dl className="rp-times">
        <div>
          <dt>Crew call</dt>
          <dd>{time(t.crewCall)}</dd>
        </div>
        <div>
          <dt>Talent arrival</dt>
          <dd>{time(t.talentArrival)}</dd>
        </div>
        <div>
          <dt>Start recording</dt>
          <dd>{time(t.startRecording)}</dd>
        </div>
        <div>
          <dt>Wrap</dt>
          <dd>{time(t.wrap)}</dd>
        </div>
      </dl>
      {contacts.length === 0 ? (
        <Empty>No one holds a role yet.</Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Name</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={`${c.role}|${c.name}`}>
                  <td>{c.role}</td>
                  <td>{c.name}</td>
                  <td>{c.phone || <span className="muted">None on file</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RolesOnSheet({ project }: { project: Project }) {
  const roles = planRolesOf(project.contentId);
  return (
    <section className="glass panel" aria-label="Roles on this call sheet">
      <h2>Roles</h2>
      <p className="muted">From Project roles; changed there.</p>
      {roles.length === 0 ? (
        <Empty>No roles yet.</Empty>
      ) : (
        <ul className="rp-readonly">
          {roles.map((r) => (
            <li key={r.id}>
              <span>{roleName(r)}</span>
              <b>{r.crewId ? nameOf(r.crewId) : r.guestName || <span className="muted">No one yet</span>}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DevotionsOnSheet({ project, session }: { project: Project; session: RecordingSession }) {
  const L = planLabels(project.workflow.formType);
  const here = devotionPlacements(project.contentId).filter((x) => x.sessionId === session.id);
  return (
    <section className="glass panel" aria-label={`${L.title} on this session`}>
      <h2>{L.title}, in order</h2>
      {here.length === 0 ? (
        <Empty>No {L.many} are ticked on this session yet.</Empty>
      ) : (
        <ol className="rp-order">
          {here.map((x) => (
            <li key={x.planned.id}>
              <b>{x.title}</b>
              {x.scripture && <span className="muted"> · {x.scripture}</span>} <span className="cid">{contentIdOf(x)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function BoardsOnSheet({
  project,
  session,
  edit,
  onOpenTool,
}: {
  project: Project;
  session: RecordingSession;
  edit: boolean;
  onOpenTool: (key: "storyboard" | "shot_list") => void;
}) {
  const { actor, attempt } = useApp();
  const boards = storyboardsOf(project.contentId);
  const lists = shotListsOf(project.contentId);
  const board = boards.find((b) => b.id === session.storyboardId);
  const list = lists.find((l) => l.id === session.shotListId);
  const frames = board ? framesOf(board.id) : [];
  const rows = list ? rowsOfShotList(list.id).filter((r) => r.rowType !== "setup") : [];
  const numbers = list ? shotNumbers(list.id) : new Map<string, number>();
  return (
    <section className="glass panel" aria-label="Storyboard and shot list">
      <h2>Storyboard and shot list</h2>
      <p className="muted">Chosen from the project's own; they are edited in the Storyboard and Shot List.</p>
      <div className="row">
        <Field label="Storyboard">
          <select
            value={session.storyboardId ?? ""}
            disabled={!edit}
            onChange={(e) => attempt(() => setSessionBoards(actor, session.id, { storyboardId: e.target.value || null }))}
          >
            <option value="">None</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Shot list">
          <select
            value={session.shotListId ?? ""}
            disabled={!edit}
            onChange={(e) => attempt(() => setSessionBoards(actor, session.id, { shotListId: e.target.value || null }))}
          >
            <option value="">None</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {board && (
        <>
          <div className="wf-head">
            <h3>{board.name}</h3>
            <button className="btn small" onClick={() => onOpenTool("storyboard")}>
              Open the Storyboard
            </button>
          </div>
          {frames.length === 0 ? (
            <Empty>No frames yet.</Empty>
          ) : (
            <ol className="rp-frames">
              {frames.map((f, i) => {
                const src = imageSrc(f.imagePath);
                return (
                  <li key={f.id}>
                    {src ? <img src={src} alt={`Frame ${i + 1}`} /> : <span className="rp-frame-blank">{i + 1}</span>}
                    <span className="rp-frame-text">
                      {f.scene && <b>{f.scene} </b>}
                      {f.description}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
      {list && (
        <>
          <div className="wf-head">
            <h3>{list.name}</h3>
            <button className="btn small" onClick={() => onOpenTool("shot_list")}>
              Open the Shot List
            </button>
          </div>
          {rows.length === 0 ? (
            <Empty>No shots yet.</Empty>
          ) : (
            <div className="wf-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Shot</th>
                    <th>Description</th>
                    <th>Size</th>
                    <th>Movement</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) =>
                    r.rowType === "banner" ? (
                      <tr key={r.id} className="rp-banner">
                        <td colSpan={4}>{r.description}</td>
                      </tr>
                    ) : (
                      <tr key={r.id}>
                        <td>{numbers.get(r.id)}</td>
                        <td>{r.description}</td>
                        <td>{r.shotSize}</td>
                        <td>{r.movement}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Cards and storage: the drive the footage is planned to go on ──

export function PlannedDrive({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt } = useApp();
  const chosen = project.workflow.storageDriveId ?? null;
  if (!hasStorageAccess(actor))
    return (
      <section className="pd-episode rp-drive" aria-label="Footage drive">
        <b>Footage drive:</b> {chosen ? "chosen" : "not chosen yet"}. It is chosen by someone who may use storage.
      </section>
    );
  const drives = getDb().drives;
  return (
    <section className="pd-episode rp-drive" aria-label="Footage drive">
      <Field label="Drive the footage goes on">
        <select
          value={chosen ?? ""}
          disabled={!write || project.archived}
          onChange={(e) => attempt(() => setProjectDrive(actor, project.contentId, e.target.value || null), "Footage drive saved")}
        >
          <option value="">Not chosen yet</option>
          {drives.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {fmtSize(driveUsage(d).freeGB)} free
            </option>
          ))}
        </select>
      </Field>
      <p className="muted">
        Each session's footage goes on this drive unless the session chooses another, in Production under Storage, where the size of the
        recorded footage is entered once recording starts.
      </p>
    </section>
  );
}
