import type { CatalogEntry } from "../../config/documentCatalog";
import { plannedSectionOf, sectionOf } from "../../config/devForms";
import { getDb } from "../../data/store";
import { pagesOf } from "../../services/wrapped/documents";
import { sessionsOf, type Project } from "../../services/wrapped/workflow";
import { fmtDate } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty } from "../../ui/parts";
import { DecisionHistory, PlannedEditor, SectionEditor } from "../workflow/Development";
import { PreProductionTab, RolesPanel } from "../workflow/PreProduction";
import { EpisodeTracker } from "../workflow/EpisodeTracker";
import { SessionStorage } from "../workflow/StorageFields";
import { DevelopmentGate } from "./DevelopmentGate";
import { ShotListTool } from "./ShotLists";
import { StoryboardTool } from "./Storyboards";

// The forms among a project's tiles. Each keeps its screen and its behaviour as before (the calendar, reminders, call
// sheets, gear conflicts, storage and overdue all read them); only the way to them is new.

type Shortcut = "callSheet" | "recordingDay" | "gear" | "sessionLog";
const SHORTCUT: Record<Shortcut, { title: string; text: string; open: string }> = {
  callSheet: {
    title: "Call sheets",
    text: "A call sheet is made from its recording session, filled in from the session's date. It works as before.",
    open: "Open session",
  },
  recordingDay: {
    title: "Recording day",
    text: "Each session's recording day: the run sheet, the log and the wrap, as before.",
    open: "Open recording day",
  },
  gear: {
    title: "Gear",
    text: "Gear is chosen on each session from the equipment inventory, with its conflicts and availability, as before.",
    open: "Choose gear on the session",
  },
  sessionLog: { title: "Session log", text: "Each session's log of what was recorded, as before.", open: "Open the log" },
};

/** The project's sessions, each opening its own screen: run sheet, call sheet, gear, log and recording day. */
function SessionShortcuts({ project, what }: { project: Project; what: Shortcut }) {
  const { go } = useApp();
  const sessions = sessionsOf(project.contentId).filter((s) => !s.archivedAt);
  const s0 = SHORTCUT[what];
  return (
    <section className="glass panel" aria-label={s0.title}>
      <h2>{s0.title}</h2>
      <p className="muted">{s0.text}</p>
      {sessions.length === 0 ? (
        <Empty>No recording sessions yet. They are scheduled in Pre-production.</Empty>
      ) : (
        <ul className="pd-session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="cid">{s.id}</span>
              <span className="grow">{s.scheduledDate ? fmtDate(s.scheduledDate) : "No date yet"}</span>
              {what === "callSheet" && s.callSheetId && (
                <button className="btn small" onClick={() => go({ n: "callsheet", id: s.callSheetId! })}>
                  Open call sheet
                </button>
              )}
              <button className="btn small" onClick={() => go({ n: "session", id: s.id })}>
                {what === "callSheet" && !s.callSheetId ? "Make it from the session" : s0.open}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A devotion's Accept or Decline: its header strip, then the gate and the decision. */
function DevotionAcceptance({ project, write }: { project: Project; write: boolean }) {
  const sections = ["guest", "entry"].map((k) => sectionOf(project.workflow.formType, k)).filter((s) => !!s);
  const script = getDb().projectDocuments.find((d) => d.contentId === project.contentId && d.docKey === "devotional_script");
  return (
    <div className="stack">
      <DevelopmentGate project={project} write={write} />
      {project.workflow.stage !== "Development" && (
        <section className="glass panel">
          <h2>Accepted</h2>
          <p>
            The devotion is in {project.workflow.stage}. {script ? `Its script has ${pagesOf(script.id).length} pages.` : ""} The devotions
            are listed in the Recording Plan, in Pre-production.
          </p>
          <DecisionHistory projectId={project.contentId} />
        </section>
      )}
      {sections.map((s) => (
        <SectionEditor key={s.key} project={project} section={s} write={write && project.workflow.stage === "Development"} open />
      ))}
    </div>
  );
}

function Note({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <section className="glass panel" aria-label={title}>
      <h2>{title}</h2>
      <p className="muted">{text}</p>
      {children}
    </section>
  );
}

export function FormPane({ project, entry, write }: { project: Project; entry: CatalogEntry; write: boolean }) {
  if (entry.kind === "tool")
    return entry.tool === "storyboard" ? (
      <StoryboardTool project={project} write={write} />
    ) : (
      <ShotListTool project={project} write={write} />
    );
  switch (entry.form) {
    case "acceptDecline":
      return <DevotionAcceptance project={project} write={write} />;
    case "plannedEpisodes": {
      const section = plannedSectionOf(project.workflow.formType);
      return section ? (
        <section className="glass panel" aria-label={entry.title}>
          <h2>{entry.title}</h2>
          <PlannedEditor project={project} section={section} write={write && !project.archived} />
        </section>
      ) : (
        <Empty>This kind of project plans no episodes here.</Empty>
      );
    }
    case "consent": {
      const section = sectionOf(project.workflow.formType, "consent");
      return section ? <SectionEditor project={project} section={section} write={write && !project.archived} open /> : null;
    }
    case "roles":
      return <RolesPanel project={project} write={write} />;
    case "sessions":
      return <PreProductionTab project={project} write={write} />;
    case "callSheet":
      return <SessionShortcuts project={project} what="callSheet" />;
    case "gear":
      return <SessionShortcuts project={project} what="gear" />;
    case "sessionLog":
      return <SessionShortcuts project={project} what="sessionLog" />;
    case "recordingDayView":
      return <SessionShortcuts project={project} what="recordingDay" />;
    case "review":
    case "episodeTracker":
      return <EpisodeTracker project={project} />;
    case "platformStatus":
      return (
        <Note title="Platform status" text="Where each episode is published, set on the episode in Marketing and distribution, as before.">
          <EpisodeTracker project={project} />
        </Note>
      );
    case "archive":
      return (
        <Note title="Archive" text="Each episode's archive step, on the episode in Marketing and distribution, as before.">
          <EpisodeTracker project={project} />
        </Note>
      );
    case "storage":
      return <SessionStorage project={project} write={write} />;
    default:
      return <Empty>{entry.title} has no screen here.</Empty>;
  }
}
