import type { CatalogEntry } from "../../config/documentCatalog";
import { getDb } from "../../data/store";
import { canWrite, getRecord } from "../../services/access";
import { nameOf } from "../../services/wrapped/people";
import { sessionsOf, type Project } from "../../services/wrapped/workflow";
import { fmtDate } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty } from "../../ui/parts";
import { OpenLinkButton } from "../../ui/workflow/shared";
import { RunSheetPanel, WrapPanel } from "../workflow/SessionPage";
import type { FixedCard } from "./PageList";

// The documents of the later stages that belong to a session or an episode. A Recording Day Sheet (a documentary's
// Shoot Day Sheet) is one per recording session: its run sheet and wrap checklist are the session's own forms, as
// before (the run sheet sets the call sheet's call time), shown as fixed cards beside the pages of notes. A Review
// Thread has a page for each episode, with where that episode's review stands shown above the page.

const SESSION_STATUS: Record<string, string> = { Planned: "planned", Open: "recording now", Closed: "closed" };

/** The project's sessions a day sheet can be for: every one still on the schedule. */
export const daySheetSessions = (projectId: string) => sessionsOf(projectId).filter((s) => !s.archivedAt);

/** The session a day sheet opens on: the one recording now, else the next one planned, else the last one. */
export function defaultSession(projectId: string): string | null {
  const all = daySheetSessions(projectId);
  return (all.find((s) => s.status === "Open") ?? all.find((s) => s.status === "Planned") ?? all[all.length - 1])?.id ?? null;
}

/** The form pages of a day sheet's catalogue entry, as fixed cards: before the notes or after them, as listed. */
export function formCards(entry: CatalogEntry): FixedCard[] {
  const out: FixedCard[] = [];
  let written = 0;
  for (const p of entry.pages ?? []) {
    if (!p.form) {
      written++;
      continue;
    }
    out.push({
      id: `form:${p.form}`,
      title: p.title,
      note: p.form === "runSheet" ? "The day's schedule; it sets the call sheet's call time" : "Ticked off at the end of the day",
      at: written === 0 ? "start" : "end",
    });
  }
  return out;
}

export function SessionPicker({
  project,
  value,
  onChange,
}: {
  project: Project;
  value: string | null;
  onChange: (sessionId: string) => void;
}) {
  const { go } = useApp();
  const all = daySheetSessions(project.contentId);
  return (
    <div className="pd-session-pick">
      <label>
        <span>Recording session</span>
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {all.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id.slice(project.contentId.length + 1)} · {s.scheduledDate ? fmtDate(s.scheduledDate) : "No date yet"} ·{" "}
              {SESSION_STATUS[s.status] ?? s.status}
            </option>
          ))}
        </select>
      </label>
      {value && (
        <button className="btn small" onClick={() => go({ n: "session", id: value })}>
          Open the session
        </button>
      )}
    </div>
  );
}

/** A day sheet's run sheet or wrap checklist: the session's own form, with its rules as on the session's screen. */
export function DaySheetForm({ project, sessionId, form }: { project: Project; sessionId: string; form: string }) {
  const { actor } = useApp();
  const session = getDb().recordingSessions.find((s) => s.id === sessionId);
  if (!session) return <Empty>That recording session no longer exists.</Empty>;
  const editable = canWrite(actor, project) && !project.archived && !session.archivedAt && session.status !== "Closed";
  if (form === "runSheet") return <RunSheetPanel sessionId={sessionId} editable={editable} />;
  if (session.status === "Planned") return <Empty>The wrap checklist opens once recording starts.</Empty>;
  return <WrapPanel sessionId={sessionId} editable={editable} />;
}

const CHECKPOINT_LABEL = { rough_cut: "Rough cut review", final: "Final review" } as const;

/** Where one episode's review stands, above its page of the Review Thread. Read only; it is changed on the episode. */
export function EpisodeStrip({ episodeId }: { episodeId: string }) {
  const { go } = useApp();
  const ep = getRecord(episodeId);
  const info = ep?.episode;
  if (!ep || !info) return null;
  const checkpoint = (key: keyof typeof CHECKPOINT_LABEL) => getDb().reviewCheckpoints.find((c) => c.id === `${episodeId}|${key}`);
  return (
    <section className="pd-episode" aria-label={`Where ${episodeId} stands`}>
      <div className="wf-chips">
        <span className="cid">{episodeId}</span>
        <span className="badge">{info.stage === "Post production" ? info.postStage : `${info.stage}: ${info.mdStage}`}</span>
        {ep.archived && <span className="badge bad">Archived</span>}
        <span className="muted">Editor: {info.editorId ? nameOf(info.editorId) : "not chosen yet"}</span>
        <span className="grow" />
        {info.reviewLink && <OpenLinkButton url={info.reviewLink}>Open the review link</OpenLinkButton>}
        <button className="btn small" onClick={() => go({ n: "record", id: episodeId })}>
          Open the episode
        </button>
      </div>
      <ul className="pd-checkpoints">
        {(Object.keys(CHECKPOINT_LABEL) as (keyof typeof CHECKPOINT_LABEL)[]).map((key) => {
          const c = checkpoint(key);
          return (
            <li key={key}>
              {CHECKPOINT_LABEL[key]}: <b>{c ? c.status : "No reviewers yet"}</b>
              {c?.note ? <span className="muted"> · {c.note}</span> : null}
            </li>
          );
        })}
      </ul>
      {info.sendBackReason && info.postStage === "Editing" && <p className="banner warn">Sent back from review: {info.sendBackReason}</p>}
    </section>
  );
}
