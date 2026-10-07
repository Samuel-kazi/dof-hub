import type { Actor, FormType, SeriesType } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { localId } from "../../data/ids";
import { canWrite, getRecord } from "../access";
import { logAudit } from "../audit";
import { getDrive, recordSnapshot } from "../driveUsage";
import { hasStorageAccess } from "../storage";
import { daysOfEvent } from "../production";
import { isIsoDate, todayIso } from "../utils";
import { ensureChecklist, nowStamp, projectForWrite, type Project } from "./common";
import { makeEpisode } from "./episodes";
import { addPlannedEpisode, plannedOf } from "./planned";
import { createWorkflowProject } from "./projects";
import { createSession } from "./sessions";
import { driveFolders, type DriveFolder } from "./recordingLog";

// Importing a project recorded before the system (build prompt v4, section 7A). Its footage is already on a drive, as
// an entry on the Storage & Media screen with no project yet (a folder). The project is made with a Content ID and
// that entry is linked to it; it starts in Production (a session open, its Recording Log blank) or in Post production
// (one episode per item recorded). Its earlier stages show "Recorded before the system" and are never errors, and its
// dates before the import are history: no reminders, overdue, urgency or Google sync for them (./history.ts).

export type ImportCategory = "series" | "devotional" | "documentary" | "music" | "live";

export interface ImportInput {
  allocationId: string; // the folder on a drive
  category: ImportCategory;
  title: string; // the project's title; the folder's name if left empty
  seriesType?: SeriesType | null; // a series: podcast, testimonial or sermon
  formType?: FormType | null; // a documentary's or a music release's kind
  start: "Production" | "Post production";
  recordedOn?: string | null; // when it was recorded (the session's or the episodes' date); today if not known
  items?: string[]; // what was recorded: needed to start in Post production, optional in Production
  reviewedBeforeSystem?: boolean; // its theological review was done before the system
}

export interface ImportResult {
  project: Project;
  sessionId: string | null; // starting in Production: the session whose Recording Log opens
  episodes: string[]; // starting in Post production: the episodes made
}

/** The folders on a drive that may be imported: the entries no project is linked to (and, if asked, the linked ones). */
export function importableFolders(actor: Actor, driveId: string, includeLinked = false): DriveFolder[] {
  if (!hasStorageAccess(actor)) return [];
  return driveFolders(driveId).filter((f) => includeLinked || f.contentId === null);
}

export function importProject(actor: Actor, input: ImportInput): ImportResult {
  if (!hasStorageAccess(actor)) throw new RuleError("Importing works from a drive: it needs someone who may use storage.");
  const db = getDb();
  const entry = db.allocations.find((a) => a.id === input.allocationId);
  if (!entry) throw new RuleError("Choose one of the folders on a drive.");
  if (entry.contentId) throw new RuleError(`That folder already belongs to ${getRecord(entry.contentId)?.title ?? entry.contentId}.`);
  if (entry.sessionId) throw new RuleError("Choose one of the folders on a drive.");
  const drive = getDrive(entry.driveId);
  if (!drive) throw new RuleError("That folder's drive no longer exists.");
  if (input.start !== "Production" && input.start !== "Post production")
    throw new RuleError("Start it in Production or in Post production.");
  const recordedOn = input.recordedOn || todayIso();
  if (!isIsoDate(recordedOn)) throw new RuleError("Pick the date it was recorded.");
  const items = (input.items ?? []).map((t) => t.trim()).filter(Boolean);
  if (items.length > 200) throw new RuleError("Import up to 200 items at once.");
  if (items.some((t) => t.length > 200)) throw new RuleError("Keep each item's title under 200 characters.");
  const title = input.title.trim() || entry.label.trim();
  if (!title) throw new RuleError("Give the project a title.");
  const isSingle = input.category === "music" && input.formType === "music_single";
  if (input.start === "Post production" && !items.length && !isSingle)
    throw new RuleError("List what was recorded, one item a line: each becomes an episode in Post production.");

  // The project, as any new one is made (its Content ID, its documents to come), then moved past the stages it skipped.
  const project = createWorkflowProject(actor, {
    category: input.category,
    title,
    seriesType: input.seriesType ?? null,
    formType: input.formType ?? null,
    ...(input.category === "live" ? { event: { mode: "one_time" as const, date: recordedOn } } : {}),
  });
  const at = nowStamp();
  Object.assign(project.workflow, {
    stage: "Pre-production",
    status: "Active",
    imported: true,
    importedAt: at,
    reviewedBeforeSystem: !!input.reviewedBeforeSystem,
  });
  project.version += 1;
  ensureChecklist("preProject", "project", project.contentId);

  // The folder becomes the project's place on the drive.
  entry.contentId = project.contentId;
  entry.folderPath ||= entry.label;
  entry.updatedAt = todayIso();

  let sessionId: string | null = null;
  const episodes: string[] = [];
  const singleSong = () => plannedOf(project.contentId)[0];
  if (input.start === "Production") {
    // One session, open, its Recording Log blank (or listing what was named), its footage in the folder imported.
    const session =
      input.category === "live"
        ? daysOfEvent(project.contentId)[0]
        : createSession(actor, project.contentId, { scheduledDate: recordedOn, name: "Imported recording" });
    session.status = "Open";
    session.updatedAt = at;
    ensureChecklist("wrap", "session", session.id);
    sessionId = session.id;
    entry.sessionId = session.id;
    entry.role = "primary";
    session.storageDriveId = entry.driveId;
    if (items.length && input.category !== "live" && input.category !== "documentary") {
      for (const [i, t] of items.entries()) {
        const planned =
          isSingle && i === 0 ? singleSong() : isSingle ? null : addPlannedEpisode(actor, project.contentId, { workingTitle: t });
        if (!planned) break;
        if (isSingle) planned.workingTitle = t;
        db.sessionLogEntries.push({
          id: `${session.id}|${planned.id}`,
          sessionId: session.id,
          plannedEpisodeId: planned.id,
          itemLabel: "",
          logDate: recordedOn,
          guest: "",
          status: null,
          notesForPost: "",
          createdAt: at,
          updatedAt: at,
        });
      }
    } else if (items.length) {
      for (const t of items)
        db.sessionLogEntries.push({
          id: `${session.id}|${localId("I", (x) => db.sessionLogEntries.some((e) => e.id === `${session.id}|${x}`))}`,
          sessionId: session.id,
          plannedEpisodeId: null,
          itemLabel: t,
          logDate: recordedOn,
          guest: "",
          status: null,
          notesForPost: "",
          createdAt: at,
          updatedAt: at,
        });
    }
  } else {
    // Straight to Post production: one episode for each item recorded (a devotion's stay flat, under the devotion).
    if (input.category === "live") {
      // The event's one day is history: closed, its recordings made below.
      const day = daysOfEvent(project.contentId)[0];
      if (day) Object.assign(day, { status: "Closed", closedAt: at, updatedAt: at });
    }
    const names = isSingle ? [items[0] || singleSong()?.workingTitle || title] : items;
    for (const [i, t] of names.entries()) {
      const planned =
        input.category === "live"
          ? null
          : isSingle && i === 0
            ? singleSong()
            : addPlannedEpisode(actor, project.contentId, { workingTitle: t });
      if (planned && isSingle) planned.workingTitle = t;
      const ep = makeEpisode(actor, project, {
        title: t,
        plannedEpisodeId: planned?.id ?? null,
        sourceSessionId: null,
        productionNotes: `Imported from ${drive.name}, ${entry.folderPath || entry.label}.`,
        scheduledDate: recordedOn,
      });
      episodes.push(ep.contentId);
    }
  }
  logAudit(
    actor,
    "import",
    "record",
    project.contentId,
    `Imported from ${drive.name} (${entry.folderPath || entry.label}), starting in ${input.start}${episodes.length ? `: ${episodes.join(", ")}` : ""}`,
  );
  recordSnapshot();
  commit();
  return { project, sessionId, episodes };
}

/** "Reviewed before the system": an imported project's theological review was done before; the banner is cleared. */
export function setReviewedBeforeSystem(actor: Actor, projectId: string, on: boolean): Project {
  const p = projectForWrite(actor, projectId);
  if (!p.workflow.imported) throw new RuleError("Only a project imported from before the system is marked this way.");
  if (!canWrite(actor, p)) throw new RuleError("You are not attached to this project.");
  p.workflow.reviewedBeforeSystem = on;
  p.version += 1;
  logAudit(actor, "review-before-system", "record", projectId, on ? "Reviewed before the system" : "Not marked reviewed before the system");
  commit();
  return p;
}
