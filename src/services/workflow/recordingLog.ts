import type { Actor, DriveAllocation, RecordingSession, SessionLogEntry } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb, nextCounter } from "../../data/store";
import { claimId } from "../../data/ids";
import { getRecord, rootOf } from "../access";
import { logAudit } from "../audit";
import { driveUsage, getDrive, isNearlyFull, recordSnapshot } from "../driveUsage";
import { hasStorageAccess } from "../storage";
import { DEFAULT_FOLDER_PATTERN } from "../settings";
import { fmtSize, pad, todayIso } from "../utils";
import { nowStamp, rowsOf, sessionForWrite, type Project } from "./common";
import { sessionName } from "./plan";

// The Recording Log (build prompt v4, section 7A): one per session, in Production. It records what actually happened,
// not the plan: who attended, what was recorded with its take mark and length (the session's log rows), the issues
// and pickups, and where the footage is kept. Storage is assigned here, in Production, never in Pre-production.
//
// Storage reads the Storage & Media screen's own records (drives and their entries) and adds to them; it never keeps a
// list of its own. A session's footage is an entry on a drive with the session's id and a role, primary or backup. The
// app cannot reach the drives themselves (the hosted site has no access to them, and the desktop app writes only to
// its own picture folder), so the folder is recorded and the crew copy the files there.

/** Who attended: as entered, or the call sheet's crew until someone changes it. */
export function attendeesOf(session: RecordingSession): string[] {
  if (session.attendees) return session.attendees;
  const sheet = session.callSheetId ? getDb().callSheets.find((c) => c.id === session.callSheetId) : undefined;
  return sheet ? [...sheet.crewPersonIds] : [];
}

/** The rows marked Pickup needed: listed under the log's issues and carried into Edit Notes. */
export const pickupsOf = (sessionId: string): SessionLogEntry[] => rowsOf(sessionId).filter((r) => r.status === "Pickup needed");

// ── Where the footage is ─────────────────────────────────────

/** An entry's folder, as recorded; an entry from before folders were recorded shows its label. */
export const folderOf = (a: DriveAllocation): string => a.folderPath?.trim() || a.label.trim() || a.contentId || a.id;

/** A project's place on a drive: an entry for the project (or the season, series or show it sits in) with no session. */
const isProjectLink = (a: DriveAllocation): boolean => !a.sessionId;

/** The ids a project's footage may be filed under on a drive: the project, the record it sits in, and its root. */
function lineage(project: Project): string[] {
  const out = [project.contentId];
  if (project.parentId) out.push(project.parentId);
  const root = rootOf(project).contentId;
  if (!out.includes(root)) out.push(root);
  return out;
}

export interface DriveFolder {
  allocationId: string;
  driveId: string;
  contentId: string | null; // null: a folder no project is linked to yet
  title: string; // the project's title, or the entry's label
  folderPath: string;
}

/** The folders on a drive: each project's place on it, and the entries not linked to a project yet. */
export function driveFolders(driveId: string): DriveFolder[] {
  return getDb()
    .allocations.filter((a) => a.driveId === driveId && isProjectLink(a))
    .map((a) => ({
      allocationId: a.id,
      driveId,
      contentId: a.contentId,
      title: a.contentId ? (getRecord(a.contentId)?.title ?? a.contentId) : a.label,
      folderPath: folderOf(a),
    }))
    .sort((a, b) => a.folderPath.localeCompare(b.folderPath));
}

/** A project's places on drives (step 3 of section 7A: one is chosen for it, several are asked about, none is prompted). */
export function projectLinks(project: Project): DriveAllocation[] {
  const ids = lineage(project);
  return getDb().allocations.filter((a) => isProjectLink(a) && a.contentId !== null && ids.includes(a.contentId));
}

/** The folder on a drive that best matches a project: its own Content ID, then the record it sits in, then its name. */
export function bestFolder(driveId: string, project: Project): DriveFolder | undefined {
  const folders = driveFolders(driveId);
  for (const id of lineage(project)) {
    const hit = folders.find((f) => f.contentId === id);
    if (hit) return hit;
  }
  const name = project.title.trim().toLowerCase();
  const parent = project.parentId ? getRecord(project.parentId)?.title.trim().toLowerCase() : undefined;
  return folders.find((f) => {
    const t = `${f.title} ${f.folderPath}`.toLowerCase();
    return (!!name && t.includes(name)) || (!!parent && t.includes(parent));
  });
}

/** A session's footage on its drives: the main one, and the backup. */
export function sessionStorage(sessionId: string): { primary?: DriveAllocation; backup?: DriveAllocation } {
  const mine = getDb().allocations.filter((a) => a.sessionId === sessionId);
  return { primary: mine.find((a) => a.role !== "backup"), backup: mine.find((a) => a.role === "backup") };
}

/** The folder a session's footage goes in: the pattern in Settings, inside the project's own folder if it has one. */
export function folderFor(session: RecordingSession, project: Project, inside?: string): string {
  const pattern = getDb().settings.storageFolderPattern?.trim() || DEFAULT_FOLDER_PATTERN;
  const clean = (v: string) => v.replace(/[\\/:*?"<>|]+/g, "-").trim();
  const label = clean(session.label || sessionName(session)).replace(/\s+/g, "-");
  const path = pattern
    .split("{contentId}")
    .join(project.contentId)
    .split("{date}")
    .join(session.scheduledDate ?? todayIso())
    .split("{label}")
    .join(label)
    .split("{session}")
    .join(session.id);
  if (!inside) return path;
  // Inside the project's own folder: the pattern's last part (the session's) goes under it.
  const last = path.split("/").filter(Boolean).pop() ?? path;
  return `${inside.replace(/\/+$/, "")}/${last}`;
}

/** What the picker suggests for a session's main drive: the project's one place, or nothing (none, or several to ask). */
export function suggestedStorage(sessionId: string): { link: DriveAllocation | null; choices: DriveAllocation[] } {
  const session = getDb().recordingSessions.find((s) => s.id === sessionId);
  const project = session ? (getRecord(session.contentId) as Project | undefined) : undefined;
  if (!session || !project?.workflow) return { link: null, choices: [] };
  const choices = projectLinks(project);
  return { link: choices.length === 1 ? choices[0] : null, choices };
}

const requireStorage = (actor: Actor): void => {
  if (!hasStorageAccess(actor)) throw new RuleError("Only someone who may use storage can choose where the footage goes.");
};

/** A new entry on a drive. The Storage screen lists it like any other; a size of 0 is "not entered yet". */
function newEntry(fields: Omit<DriveAllocation, "id" | "updatedAt">): DriveAllocation {
  const a: DriveAllocation = { id: claimId(`ALC-${pad(nextCounter("allocation"), 4)}`), updatedAt: todayIso(), ...fields };
  getDb().allocations.push(a);
  return a;
}

export interface StorageAssignInput {
  driveId: string;
  role: "primary" | "backup";
  linkId?: string | null; // the project's place on that drive, chosen from its folders (the best match is suggested)
  addToDrive?: boolean; // "+ Add to this drive": the project has no place on it yet
  folderPath?: string; // the session's folder, if not the one the pattern gives
}

/**
 * Says where a session's footage is: its main drive or its backup (step 1 to 5 of section 7A). Chosen from the drives
 * and the project's place on the chosen one, or added to it; the session's folder follows the pattern in Settings.
 * Choosing again moves it. The backup is on another drive.
 */
export function assignSessionStorage(actor: Actor, sessionId: string, input: StorageAssignInput): DriveAllocation {
  const { session, project } = sessionForWrite(actor, sessionId);
  requireStorage(actor);
  const drive = getDrive(input.driveId);
  if (!drive) throw new RuleError("Choose one of the drives on the Storage & Media screen.");
  if (input.role !== "primary" && input.role !== "backup") throw new RuleError("Choose the main drive or the backup.");
  const current = sessionStorage(sessionId);
  const other = input.role === "primary" ? current.backup : current.primary;
  if (other && other.driveId === drive.id)
    throw new RuleError(
      `The backup must be on another drive than the footage itself: ${drive.name} is already the ${input.role === "primary" ? "backup" : "main drive"}.`,
    );
  let link: DriveAllocation | undefined;
  if (input.linkId) {
    link = getDb().allocations.find((a) => a.id === input.linkId);
    if (!link || link.driveId !== drive.id || !isProjectLink(link)) throw new RuleError("Choose one of the folders on that drive.");
    if (link.contentId === null) {
      // A folder no project was linked to: it becomes this project's place on the drive.
      link.contentId = project.contentId;
      link.folderPath ||= link.label;
      link.updatedAt = todayIso();
    }
  } else if (input.addToDrive) {
    link = newEntry({
      driveId: drive.id,
      contentId: project.contentId,
      label: project.title,
      sizeGB: 0,
      kind: "raw",
      note: `Added from the Recording Log of ${session.id}`,
      folderPath: project.contentId,
    });
  }
  const folder = (input.folderPath ?? "").trim() || folderFor(session, project, link ? folderOf(link) : undefined);
  if (folder.length > 240) throw new RuleError("Keep the folder path under 240 characters.");
  const mine = input.role === "primary" ? current.primary : current.backup;
  let a: DriveAllocation;
  if (mine) {
    if (mine.driveId !== drive.id && mine.sizeGB > driveUsage(drive).freeGB + 1e-6)
      throw new RuleError(`${drive.name} has only ${fmtSize(driveUsage(drive).freeGB)} free.`);
    Object.assign(mine, { driveId: drive.id, folderPath: folder, updatedAt: todayIso() });
    a = mine;
  } else {
    a = newEntry({
      driveId: drive.id,
      contentId: project.contentId,
      label: `${sessionName(session)} ${input.role === "backup" ? "backup" : "footage"}`,
      sizeGB: input.role === "backup" ? (current.primary?.sizeGB ?? 0) : 0,
      kind: "raw",
      note: `Recording session ${session.id}`,
      sessionId,
      role: input.role,
      folderPath: folder,
      offloadedAt: null,
      offloadedBy: null,
      backedUpAt: null,
      backedUpBy: null,
    });
  }
  if (input.role === "primary") session.storageDriveId = drive.id;
  session.updatedAt = nowStamp();
  logAudit(actor, "storage-assign", "session", sessionId, `${input.role === "backup" ? "backup" : "footage"} on ${drive.name}: ${folder}`);
  recordSnapshot();
  commit();
  return a;
}

/** Takes a session's main drive or backup off: the entry is removed while nothing was marked copied to it. */
export function clearSessionStorage(actor: Actor, sessionId: string, role: "primary" | "backup"): void {
  const { session } = sessionForWrite(actor, sessionId);
  requireStorage(actor);
  const a = sessionStorage(sessionId)[role];
  if (!a) throw new RuleError("Nothing is assigned there.");
  if (a.offloadedAt || a.backedUpAt) throw new RuleError("The footage is marked copied there. Untick it first.");
  if (a.sizeGB > 0 && role === "primary")
    throw new RuleError("The footage's size is entered on this drive. Move it to another drive instead.");
  getDb().allocations = getDb().allocations.filter((x) => x.id !== a.id);
  if (role === "primary") session.storageDriveId = null;
  session.updatedAt = nowStamp();
  logAudit(actor, "storage-clear", "session", sessionId, role);
  recordSnapshot();
  commit();
}

/** Ticks Offloaded (the main drive) or Backed up (the backup), with who and when; unticking clears them. */
export function markStorage(actor: Actor, sessionId: string, role: "primary" | "backup", done: boolean): DriveAllocation {
  const { session } = sessionForWrite(actor, sessionId);
  requireStorage(actor);
  if (session.status === "Planned") throw new RuleError("The footage is offloaded once recording has started.");
  const a = sessionStorage(sessionId)[role];
  if (!a) throw new RuleError(role === "primary" ? "Choose the drive the footage goes on first." : "Choose the backup drive first.");
  const at = done ? nowStamp() : null;
  const by = done ? actor.personId : null;
  if (role === "primary") Object.assign(a, { offloadedAt: at, offloadedBy: by });
  else Object.assign(a, { backedUpAt: at, backedUpBy: by });
  a.updatedAt = todayIso();
  logAudit(actor, "storage-mark", "session", sessionId, `${role === "primary" ? "offloaded" : "backed up"}: ${done ? "yes" : "no"}`);
  commit();
  return a;
}

/** Soft warnings only (section 7A): no drive, no backup, a drive nearly full or marked offline, not copied yet. */
export function storageWarnings(sessionId: string): string[] {
  const session = getDb().recordingSessions.find((s) => s.id === sessionId);
  if (!session) return [];
  const { primary, backup } = sessionStorage(sessionId);
  const out: string[] = [];
  if (!primary) out.push("No drive chosen for the footage");
  if (!backup) out.push("No backup drive");
  for (const a of [primary, backup]) {
    const d = a ? getDrive(a.driveId) : undefined;
    if (!d) continue;
    if (d.offline) out.push(`${d.name} is marked offline`);
    const u = driveUsage(d);
    if (isNearlyFull(u)) out.push(`${d.name} is ${Math.round(u.pct)}% full`);
  }
  if (session.status !== "Planned") {
    if (primary && !primary.offloadedAt) out.push("The footage is not marked offloaded yet");
    if (backup && !backup.backedUpAt) out.push("The backup is not marked made yet");
  }
  return out;
}

/** Where a project's footage is, session by session, for the project page and the editor. */
export function footageWhere(projectId: string): { sessionId: string; role: "primary" | "backup"; drive: string; folder: string }[] {
  const ids = new Set(
    getDb()
      .recordingSessions.filter((s) => s.contentId === projectId)
      .map((s) => s.id),
  );
  return getDb()
    .allocations.filter((a) => a.sessionId && ids.has(a.sessionId))
    .map((a) => ({
      sessionId: a.sessionId!,
      role: a.role === "backup" ? ("backup" as const) : ("primary" as const),
      drive: getDrive(a.driveId)?.name ?? a.driveId,
      folder: folderOf(a),
    }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.role.localeCompare(b.role));
}
