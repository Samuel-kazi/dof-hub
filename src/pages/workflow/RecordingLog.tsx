import { useState } from "react";
import type { LogStatus, RecordingSession, SessionLogEntry } from "../../types";
import { categoryOf } from "../../config/categories";
import { TAKE_MARKS } from "../../config/workflow";
import { getDb } from "../../data/store";
import { driveUsage } from "../../services/driveUsage";
import { hasStorageAccess } from "../../services/storage";
import {
  addLogRow,
  assignSessionStorage,
  attendeesOf,
  availableForLog,
  bestFolder,
  clearSessionStorage,
  driveFolders,
  folderFor,
  folderOf,
  footageOf,
  footageWhere,
  getSession,
  markStorage,
  pickupsOf,
  removeLogRow,
  rowsOf,
  sessionName,
  sessionStorage,
  setSessionFootage,
  storageWarnings,
  suggestedStorage,
  updateLogRow,
  updateSession,
  type Project,
} from "../../services/wrapped/workflow";
import { fmtDate, fmtDateTime, fmtSize } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { PersonName } from "../../ui/PersonName";
import { CrewSelect } from "../../ui/workflow/shared";
import { SavedInput } from "../documents/toolkit";
import { useDraft } from "./common";

// The Recording Log (build prompt v4, section 7A): one per session, in Production. It records what actually happened:
// (1) the session's details and who attended, (2) what was recorded, each with its take mark, length and notes, (3)
// the issues and pickups, and (4) where the footage is kept, with its backup. It works with no Recording Plan and no
// call sheet (an imported project's), and replaces the Session Log and Storage tiles.

const driveName = (id: string | null | undefined): string => getDb().drives.find((d) => d.id === id)?.name ?? "";

/** One row of the log: what was recorded, its date, guest, take mark, length and notes for post production. */
export function LogRow({ row, editable, markable }: { row: SessionLogEntry; editable: boolean; markable: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const planned = row.plannedEpisodeId ? getDb().plannedEpisodes.find((p) => p.id === row.plannedEpisodeId) : undefined;
  const [draft, setDraft, dirty, saved] = useDraft({
    logDate: row.logDate,
    guest: row.guest,
    notesForPost: row.notesForPost,
    itemLabel: row.itemLabel,
    duration: row.duration ?? "",
  });
  const save = () => dirty && attempt(() => updateLogRow(actor, row.id, draft)) && saved();
  const what = planned ? planned.workingTitle : row.itemLabel;
  return (
    <tr>
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
          type="date"
          aria-label="Date"
          value={draft.logDate}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, logDate: e.target.value })}
          onBlur={save}
        />
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
          aria-label="Take mark"
          value={row.status ?? ""}
          disabled={!markable}
          title={markable ? "" : "Marked during the session, once it is in Production"}
          onChange={(e) => attempt(() => updateLogRow(actor, row.id, { status: (e.target.value || null) as LogStatus | null }))}
        >
          <option value="">No take mark yet</option>
          {TAKE_MARKS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="text"
          aria-label="Length"
          placeholder="12:30"
          style={{ width: 80 }}
          value={draft.duration}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, duration: e.target.value })}
          onBlur={save}
        />
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
            aria-label={`Remove ${what || "this row"}`}
            onClick={async () => {
              if (
                await confirm({
                  title: "Remove this row from the log?",
                  body: `${what || "This row"} comes off this session's log.`,
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

/** (1) The session's details: its date, place and label, and who attended (the call sheet's crew until changed). */
function SessionDetails({ session, editable }: { session: RecordingSession; editable: boolean }) {
  const { actor, attempt } = useApp();
  const [others, setOthers] = useState<string | null>(null);
  const sheet = session.callSheetId ? getDb().callSheets.find((c) => c.id === session.callSheetId) : undefined;
  const people = attendeesOf(session);
  const set = (next: string[]) => attempt(() => updateSession(actor, session.id, { attendees: next }), "Attendees saved");
  return (
    <div className="stack">
      <h3>Session details</h3>
      <div className="rp-readonly">
        <span>
          <b>Date:</b> {session.scheduledDate ? fmtDate(session.scheduledDate) : "No date"}
        </span>
        <span>
          <b>Place:</b> {session.venue || sheet?.location || "Not set"}
        </span>
        <span>
          <b>Label:</b> {session.label || sessionName(session)}
        </span>
      </div>
      <div>
        <b>Who attended</b>
        {session.attendees == null && people.length > 0 && <span className="muted"> (from the call sheet)</span>}
        <ul className="wf-chips" aria-label="Who attended" style={{ marginTop: 6 }}>
          {people.length === 0 && <li className="muted">No one listed yet.</li>}
          {people.map((pid) => (
            <li key={pid} className="badge">
              <PersonName id={pid} />
              {editable && (
                <button className="link" aria-label="Remove from who attended" onClick={() => set(people.filter((x) => x !== pid))}>
                  {" "}
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {editable && (
          <div className="row" style={{ alignItems: "end", marginTop: 6 }}>
            <Field label="Add someone from Crew">
              <CrewSelect
                label="Add someone who attended"
                value={null}
                none="Choose…"
                onChange={(pid) => pid && !people.includes(pid) && set([...people, pid])}
              />
            </Field>
            <Field label="Others who attended">
              <input
                type="text"
                value={others ?? session.attendeesNote ?? ""}
                disabled={!editable}
                placeholder="Guests, volunteers, the church team"
                onChange={(e) => setOthers(e.target.value)}
                onBlur={() => {
                  if (others !== null && others !== (session.attendeesNote ?? "")) {
                    if (attempt(() => updateSession(actor, session.id, { attendeesNote: others }), "Saved")) setOthers(null);
                  }
                }}
              />
            </Field>
          </div>
        )}
        {!editable && session.attendeesNote && <p className="muted">Also: {session.attendeesNote}</p>}
      </div>
    </div>
  );
}

/** (3) The issues and pickups: the rows marked Pickup needed, and the session's own notes, both carried to Edit Notes. */
function IssuesAndPickups({ session, editable }: { session: RecordingSession; editable: boolean }) {
  const { actor, attempt } = useApp();
  const [issues, setIssues] = useState<string | null>(null);
  const pickups = pickupsOf(session.id);
  const planned = new Map(getDb().plannedEpisodes.map((p) => [p.id, p.workingTitle]));
  return (
    <div className="stack">
      <h3>Issues and pickups</h3>
      {pickups.length > 0 && (
        <ul aria-label="Pickups needed">
          {pickups.map((r) => (
            <li key={r.id}>
              <b>{(r.plannedEpisodeId && planned.get(r.plannedEpisodeId)) || r.itemLabel}</b>
              {r.notesForPost ? `: ${r.notesForPost}` : ""}
            </li>
          ))}
        </ul>
      )}
      <textarea
        aria-label="Issues"
        placeholder="Technical problems, what went wrong, what to fix next time"
        value={issues ?? session.issues ?? ""}
        disabled={!editable}
        onChange={(e) => setIssues(e.target.value)}
        onBlur={() => {
          if (issues !== null && issues !== (session.issues ?? "")) {
            if (attempt(() => updateSession(actor, session.id, { issues }), "Issues saved")) setIssues(null);
          }
        }}
      />
      <p className="muted">Pickups and issues go to the editor in the project&apos;s Edit Notes when the session closes.</p>
    </div>
  );
}

/** One drive slot of a session's footage: its main drive (Offloaded) or the backup (Backed up), chosen in a few clicks. */
function StorageSlot({
  project,
  session,
  role,
  write,
}: {
  project: Project;
  session: RecordingSession;
  role: "primary" | "backup";
  write: boolean;
}) {
  const { actor, attempt, confirm } = useApp();
  const current = sessionStorage(session.id)[role];
  const [changing, setChanging] = useState(false);
  const suggested = role === "primary" ? suggestedStorage(session.id) : { link: null, choices: [] };
  const firstDrive =
    current?.driveId ??
    suggested.link?.driveId ??
    (role === "primary" ? session.storageDriveId || project.workflow.storageDriveId || "" : "");
  const [driveId, setDriveId] = useState<string>(firstDrive);
  const folders = driveId ? driveFolders(driveId) : [];
  const best = driveId ? bestFolder(driveId, project) : undefined;
  const [folderChoice, setFolderChoice] = useState<string | null>(null);
  const folder = folderChoice ?? best?.allocationId ?? "__add";
  const access = hasStorageAccess(actor);
  const label = role === "primary" ? "Footage" : "Backup";
  const other = sessionStorage(session.id)[role === "primary" ? "backup" : "primary"];
  if (current && !changing) {
    const done = role === "primary" ? current.offloadedAt : current.backedUpAt;
    const by = role === "primary" ? current.offloadedBy : current.backedUpBy;
    return (
      <div className="pd-episode" aria-label={label}>
        <div className="row" style={{ alignItems: "center" }}>
          <span className="grow">
            <b>{label}:</b> {driveName(current.driveId)} · <code>{folderOf(current)}</code>
          </span>
          {write && access && session.status !== "Closed" && (
            <button className="btn small" onClick={() => setChanging(true)}>
              Change
            </button>
          )}
          {write && access && session.status !== "Closed" && !done && !(role === "primary" && current.sizeGB > 0) && (
            <button
              className="btn small ghost"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Take the ${label.toLowerCase()} drive off?`,
                    body: "The entry on the drive is removed.",
                    confirmLabel: "Take off",
                  })
                )
                  attempt(() => clearSessionStorage(actor, session.id, role), "Taken off");
              }}
            >
              Take off
            </button>
          )}
        </div>
        <div className="row" style={{ alignItems: "center", marginTop: 6 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={!!done}
              disabled={!write || !access || session.status === "Planned"}
              onChange={(e) => attempt(() => markStorage(actor, session.id, role, e.target.checked))}
            />{" "}
            {role === "primary" ? "Offloaded" : "Backed up"}
          </label>
          {done && (
            <span className="muted">
              {" "}
              {by ? <PersonName id={by} /> : null}, {fmtDateTime(done)}
            </span>
          )}
          {role === "primary" && session.status !== "Planned" && (
            <Field label="Size (GB)">
              <SavedInput
                type="number"
                min={0}
                step="any"
                aria-label={`Footage size for ${sessionName(session)}, in GB`}
                value={footageOf(session.id)?.sizeGB ? String(footageOf(session.id)!.sizeGB) : ""}
                disabled={!write || !access}
                placeholder="GB"
                onSave={(v) => {
                  const n = v.trim() ? Number(v) : null;
                  if (n !== null) attempt(() => setSessionFootage(actor, session.id, n), "Footage size saved");
                }}
              />
            </Field>
          )}
        </div>
      </div>
    );
  }
  if (!access)
    return (
      <p className="muted">
        <b>{label}:</b> not chosen yet. It is chosen by someone who may use storage.
      </p>
    );
  if (!write)
    return (
      <p className="muted">
        <b>{label}:</b> not chosen.
      </p>
    );
  const drives = getDb().drives.filter((d) => d.id !== other?.driveId);
  const project_ = project;
  const preview = folderFor(session, project_, folder !== "__add" ? folders.find((f) => f.allocationId === folder)?.folderPath : undefined);
  return (
    <div className="pd-episode" aria-label={`Choose the ${label.toLowerCase()} drive`}>
      <b>{label}</b>
      {role === "primary" && !current && suggested.choices.length > 1 && (
        <p className="muted">This project is on {suggested.choices.length} drives already: choose the one for this session.</p>
      )}
      {role === "primary" && !current && suggested.choices.length === 0 && (
        <p className="muted">This project is not on a drive yet: choose one and add it.</p>
      )}
      <div className="row" style={{ alignItems: "end" }}>
        <Field label={`${label} drive`}>
          <select
            value={driveId}
            onChange={(e) => {
              setDriveId(e.target.value);
              setFolderChoice(null);
            }}
          >
            <option value="">Choose a drive…</option>
            {drives.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {fmtSize(driveUsage(d).freeGB)} free{d.offline ? " · offline" : ""}
              </option>
            ))}
          </select>
        </Field>
        {driveId && (
          <Field label="The project's folder on it">
            <select value={folder} onChange={(e) => setFolderChoice(e.target.value)}>
              {folders.map((f) => (
                <option key={f.allocationId} value={f.allocationId}>
                  {f.folderPath}
                  {f.contentId ? ` (${f.title})` : " (no project yet)"}
                  {best?.allocationId === f.allocationId ? " · best match" : ""}
                </option>
              ))}
              <option value="__add">+ Add {project.title} to this drive</option>
            </select>
          </Field>
        )}
      </div>
      {driveId && (
        <p className="muted">
          This session&apos;s footage goes in <code>{preview}</code>. The app records where it is; the crew copy the files there.
        </p>
      )}
      <div className="row">
        <button
          className="btn primary small"
          disabled={!driveId}
          onClick={() =>
            attempt(
              () =>
                assignSessionStorage(actor, session.id, {
                  driveId,
                  role,
                  ...(folder === "__add" ? { addToDrive: true } : { linkId: folder }),
                }),
              `${label} drive saved`,
            ) && setChanging(false)
          }
        >
          Confirm
        </button>
        {changing && (
          <button className="btn small ghost" onClick={() => setChanging(false)}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** (4) Storage and backup, with soft warnings only. */
function StorageAndBackup({ project, session, write }: { project: Project; session: RecordingSession; write: boolean }) {
  const warnings = storageWarnings(session.id);
  return (
    <div className="stack" aria-label="Storage and backup">
      <h3>Storage and backup</h3>
      <StorageSlot project={project} session={session} role="primary" write={write} />
      <StorageSlot project={project} session={session} role="backup" write={write} />
      {warnings.length > 0 && (
        <ul className="cs-warn" aria-label="Storage: needs attention">
          {warnings.map((w) => (
            <li key={w}>{w}.</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A session's Recording Log, on its own page and as the Production stage's tile. */
export function RecordingLog({ project, sessionId, write }: { project: Project; sessionId: string; write: boolean }) {
  const { actor, attempt } = useApp();
  const [pick, setPick] = useState("");
  const [label, setLabel] = useState("");
  const session = getSession(sessionId);
  if (!session) return <Empty>That session no longer exists.</Empty>;
  const editable = write && session.status !== "Closed" && !session.archivedAt;
  const markable = editable && session.status === "Open";
  const live = project.category === "live";
  const isDoc = project.workflow.formType.startsWith("documentary");
  const imported = !!project.workflow.imported;
  // Free-form rows: a documentary's interview sets and scenes, a live day's recordings, and anything an imported
  // project names (it has no plan to choose from).
  const freeForm = isDoc || live;
  const nameIt = freeForm || imported;
  const episodeWord = (categoryOf(project.category).workflow?.episodeLabel ?? "Episode").toLowerCase();
  const rows = rowsOf(sessionId);
  const available = availableForLog(sessionId);
  const title = live ? "Show log" : "Recording Log";
  const addRow = () => {
    const input = nameIt && (!pick || freeForm) ? { itemLabel: label } : { plannedEpisodeId: pick };
    if (attempt(() => addLogRow(actor, sessionId, input), "Added to the log")) {
      setPick("");
      setLabel("");
    }
  };
  return (
    <section className="glass panel" aria-label={title}>
      <h2>{title}</h2>
      <p className="muted">
        What actually happened at {sessionName(session)}, not the plan.{" "}
        {live
          ? "Name each part recorded for post production (the full service, a worship set, the message), with its take mark and notes. Leave it empty if nothing needs post production."
          : "Each item recorded gets a take mark: Good and Pickup needed go on to Post production; Re-record leaves it for another session."}
      </p>
      <SessionDetails session={session} editable={editable} />
      <h3 style={{ marginTop: 14 }}>What was recorded</h3>
      {rows.length === 0 ? (
        <Empty>
          {live
            ? "Nothing logged for post production yet."
            : isDoc
              ? "No items logged yet: interview sets, scenes, locations."
              : `No ${episodeWord}s on this session's log yet.`}
        </Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table wf-table">
            <thead>
              <tr>
                <th>{live ? "Recorded" : isDoc ? "Item" : episodeWord.charAt(0).toUpperCase() + episodeWord.slice(1)}</th>
                <th>Date</th>
                <th>Guest</th>
                <th>Take</th>
                <th>Length</th>
                <th>Notes for post production</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <LogRow key={r.id} row={r} editable={editable} markable={markable} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <div className="row" style={{ alignItems: "end", marginTop: 10 }}>
          {!freeForm && available.length > 0 && (
            <Field
              label={
                project.category === "music"
                  ? "Add a song (it can be on more than one session: its audio, then its video)"
                  : `Add ${episodeWord === "episode" ? "an episode" : `a ${episodeWord}`} (planned, and not recorded in another session)`
              }
            >
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose…</option>
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
          {!freeForm && !imported && available.length === 0 && <p className="muted">No planned {episodeWord}s left to add.</p>}
          {nameIt && (
            <Field
              label={
                live
                  ? "Add what was recorded: the full service, a worship set, the message"
                  : isDoc
                    ? "Add an item: an interview set, a scene, a location"
                    : `Name what was recorded (it becomes a planned ${episodeWord})`
              }
            >
              <input
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (e.target.value) setPick("");
                }}
              />
            </Field>
          )}
          <div style={{ flex: "none" }}>
            <button className="btn primary" disabled={!label.trim() && !pick} onClick={addRow}>
              Add to the log
            </button>
          </div>
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <IssuesAndPickups session={session} editable={editable} />
      </div>
      <div style={{ marginTop: 14 }}>
        <StorageAndBackup project={project} session={session} write={write && !session.archivedAt} />
      </div>
    </section>
  );
}

/** Where a project's footage is, session by session: for the project, and for the editor in Post production. */
export function FootageWhere({ projectId, sessionId }: { projectId: string; sessionId?: string | null }) {
  const all = footageWhere(projectId).filter((f) => !sessionId || f.sessionId === sessionId);
  if (!all.length)
    return <p className="muted">No drive is recorded for the footage yet. It is chosen in each session&apos;s Recording Log.</p>;
  return (
    <ul className="rp-readonly" aria-label="Where the footage is">
      {all.map((f) => (
        <li key={`${f.sessionId}-${f.role}`}>
          <span>
            {sessionName(getSession(f.sessionId))} <span className="cid">{f.sessionId}</span>
            {f.role === "backup" ? " (backup)" : ""}
          </span>
          <b>
            {f.drive} · <code>{f.folder}</code>
          </b>
        </li>
      ))}
    </ul>
  );
}
