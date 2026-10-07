import type { Actor, DriveAllocation, PlannedEpisode, ProjectRole, RecordingSession, RunItem } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { localId } from "../../data/ids";
import { PLAN_ROLE_SEEDS, PROJECT_ROLE_DEFS, isMusicForm, roleName } from "../../config/workflow";
import { getRecord } from "../access";
import { logAudit } from "../audit";
import { addAllocation, getDrive, hasStorageAccess, updateAllocation } from "../storage";
import { fmtSize } from "../utils";
import {
  canManageTeam,
  episodeForWrite,
  joinProject,
  nowStamp,
  plannedScripture,
  plannedTitle,
  projectForWrite,
  requireCrew,
  rowsOf,
  sessionForWrite,
  type Project,
} from "./common";
import { addLogRow, followRunSheet, recordTitles } from "./sessions";

// A devotion's Recording Plan (and, built the same way, any project's): the project's roles, the devotions brought up
// from the script and the session each is recorded in, the sessions themselves, and what is needed to plan where the
// footage is kept. A devotion is on a session by a row of that session's recording log, as every project's episodes
// are; here it is on exactly one, and ticking it on another moves it there.

// ── Roles ────────────────────────────────────────────────────

const defOrder = (r: ProjectRole): number => {
  const i = PROJECT_ROLE_DEFS.findIndex((d) => d.key === r.roleKey);
  return i < 0 ? PROJECT_ROLE_DEFS.length : i;
};

/** The project's roles, in their order: as set in the plan, or the usual order of roles for older ones. */
export const planRolesOf = (projectId: string): ProjectRole[] =>
  getDb()
    .projectRoles.filter((r) => r.contentId === projectId)
    .sort((a, b) => (a.position ?? defOrder(a)) - (b.position ?? defOrder(b)) || a.createdAt.localeCompare(b.createdAt));

function forRoles(actor: Actor, projectId: string): Project {
  const p = projectForWrite(actor, projectId);
  if (!canManageTeam(actor, p))
    throw new RuleError(
      'Only the show producer, the Head of Production, or someone given "Assign other people\'s work", can change roles.',
    );
  if (p.workflow.stage !== "Pre-production")
    throw new RuleError("Roles are set at Pre-production, once the project is greenlit and handed off.");
  return p;
}

const MAX_ROLE_NAME = 60;
function roleNameOf(label: string, projectId: string, selfId?: string): string {
  const name = label.trim();
  if (!name) throw new RuleError("Give the role a name.");
  if (name.length > MAX_ROLE_NAME) throw new RuleError(`Keep the role's name under ${MAX_ROLE_NAME} characters.`);
  const clash = planRolesOf(projectId).find((r) => r.id !== selfId && roleName(r).toLowerCase() === name.toLowerCase());
  if (clash) throw new RuleError(`There is already a role called ${roleName(clash)}.`);
  return name;
}

function blankRole(projectId: string, key: ProjectRole["roleKey"], label: string, position: number, by: string): ProjectRole {
  const db = getDb();
  const at = nowStamp();
  const known = key !== "custom" && !db.projectRoles.some((r) => r.id === `${projectId}|${key}`);
  return {
    id: known ? `${projectId}|${key}` : `${projectId}|custom-${localId("RL").slice(3)}`,
    contentId: projectId,
    roleKey: known ? key : "custom",
    exclusive: known, // a role of the usual kind is held once per project; roles added by hand can be several
    crewId: null,
    guestName: "",
    assignedById: by,
    assignedAt: at,
    createdAt: at,
    updatedAt: at,
    label,
    position,
  };
}

/** The usual roles, no one chosen yet, for a project that has none. Used when a devotion is accepted. */
export function seedPlanRoles(projectId: string, by: string): ProjectRole[] {
  const db = getDb();
  if (db.projectRoles.some((r) => r.contentId === projectId)) return [];
  const made = PLAN_ROLE_SEEDS.map((s, i) => blankRole(projectId, s.key, s.label, i, by));
  db.projectRoles.push(...made);
  return made;
}

/** Starts the plan's roles with the usual ones, if the project has none yet. */
export function startPlanRoles(actor: Actor, projectId: string): ProjectRole[] {
  forRoles(actor, projectId);
  const made = seedPlanRoles(projectId, actor.personId);
  if (made.length) {
    logAudit(actor, "role", "record", projectId, `Roles listed: ${made.map(roleName).join(", ")}`);
    commit();
  }
  return planRolesOf(projectId);
}

export function addPlanRole(actor: Actor, projectId: string, label: string): ProjectRole {
  forRoles(actor, projectId);
  const name = roleNameOf(label, projectId);
  const roles = planRolesOf(projectId);
  const role = blankRole(projectId, "custom", name, Math.max(-1, ...roles.map((r) => r.position ?? defOrder(r))) + 1, actor.personId);
  getDb().projectRoles.push(role);
  logAudit(actor, "role", "record", projectId, `Role added: ${name}`);
  commit();
  return role;
}

const requireRole = (roleId: string): ProjectRole => {
  const role = getDb().projectRoles.find((r) => r.id === roleId);
  if (!role) throw new RuleError("That role is no longer on the project.");
  return role;
};

export function renamePlanRole(actor: Actor, roleId: string, label: string): ProjectRole {
  const role = requireRole(roleId);
  forRoles(actor, role.contentId);
  const before = roleName(role);
  role.label = roleNameOf(label, role.contentId, role.id);
  role.updatedAt = nowStamp();
  logAudit(actor, "role", "record", role.contentId, `Role renamed: ${before} → ${role.label}`);
  commit();
  return role;
}

/** Chooses who holds a role, from the crew list, or no one yet. */
export function setRolePerson(actor: Actor, roleId: string, crewId: string | null): ProjectRole {
  const role = requireRole(roleId);
  const p = forRoles(actor, role.contentId);
  if (crewId) {
    requireCrew(crewId, roleName(role));
    joinProject(actor, crewId, p);
  }
  role.crewId = crewId || null;
  if (crewId) role.guestName = "";
  role.assignedById = actor.personId;
  role.assignedAt = role.updatedAt = nowStamp();
  logAudit(
    actor,
    "role",
    "record",
    role.contentId,
    `${roleName(role)}: ${crewId ? (getDb().people.find((x) => x.personId === crewId)?.name ?? crewId) : "no one yet"}`,
  );
  commit();
  return role;
}

/** Someone on a role: chosen from the crew, or a host or guest from outside it. */
export const roleHolder = (r: ProjectRole): boolean => !!r.crewId || !!r.guestName.trim();

// ── Devotions on sessions ────────────────────────────────────

export interface Placement {
  planned: PlannedEpisode;
  title: string; // from its script page, as it stands
  scripture: string;
  sessionId: string | null;
  sessionIds: string[]; // every session it is on: a song can be on several (its audio, then its video)
  locked: boolean; // on a session that has started recording, or recorded: it stays where it is
}

const liveSessions = (projectId: string): RecordingSession[] =>
  getDb().recordingSessions.filter((s) => s.contentId === projectId && !s.archivedAt);

/** Each devotion (or planned episode) of the project, with the session it is on, if any. A session taken off the schedule holds none. */
export function devotionPlacements(projectId: string): Placement[] {
  const db = getDb();
  const sessions = new Map(liveSessions(projectId).map((s) => [s.id, s]));
  return db.plannedEpisodes
    .filter((p) => p.contentId === projectId && !p.archivedAt)
    .sort((a, b) => a.episodeNumber - b.episodeNumber)
    .map((p) => {
      const rows = db.sessionLogEntries.filter((e) => e.plannedEpisodeId === p.id && sessions.has(e.sessionId));
      const row = rows.find((e) => e.status === "Recorded" || e.status === "Pickup needed") ?? rows[0];
      const session = row ? sessions.get(row.sessionId)! : undefined;
      const made = db.records.some((r) => r.episode?.plannedEpisodeId === p.id && !r.archived);
      return {
        planned: p,
        title: plannedTitle(p),
        scripture: plannedScripture(p),
        sessionId: session?.id ?? null,
        sessionIds: [...new Set(rows.map((e) => e.sessionId))],
        locked: made || (!!session && (session.status !== "Planned" || !!row!.status)),
      };
    });
}

/**
 * Puts a devotion on a session, taking it off any other: a devotion is recorded in exactly one. With no session, it is
 * taken off the one it is on. Only between sessions that have not started recording; once recorded, it stays.
 */
export function assignDevotion(actor: Actor, plannedId: string, sessionId: string | null): Placement {
  const db = getDb();
  const planned = db.plannedEpisodes.find((p) => p.id === plannedId);
  if (!planned || planned.archivedAt) throw new RuleError("That devotion is no longer on the list.");
  projectForWrite(actor, planned.contentId);
  const now = devotionPlacements(planned.contentId).find((x) => x.planned.id === plannedId)!;
  if (now.sessionId === sessionId) return now;
  if (now.locked)
    throw new RuleError(
      `${now.title} is on ${sessionName(db.recordingSessions.find((s) => s.id === now.sessionId))}, which has started recording, so it stays there.`,
    );
  if (sessionId) {
    const { session } = sessionForWrite(actor, sessionId);
    if (session.contentId !== planned.contentId) throw new RuleError("That session belongs to another project.");
    if (session.status !== "Planned")
      throw new RuleError(`${sessionName(session)} has started recording. Choose a session still being planned.`);
  }
  const live = new Set(liveSessions(planned.contentId).map((s) => s.id));
  // The run sheets of the session it leaves and the one it joins, as they were, so an untouched one follows.
  const touched = [now.sessionId, sessionId].filter((x): x is string => !!x).map((id) => [id, recordTitles(id)] as const);
  db.sessionLogEntries = db.sessionLogEntries.filter((e) => !(e.plannedEpisodeId === plannedId && live.has(e.sessionId)));
  if (sessionId) addLogRow(actor, sessionId, { plannedEpisodeId: plannedId });
  for (const [id, before] of touched) followRunSheet(id, before);
  logAudit(
    actor,
    "devotion-session",
    "record",
    planned.contentId,
    `${now.title}: ${sessionId ? `on ${sessionId}` : "taken off its session"}`,
  );
  commit();
  return devotionPlacements(planned.contentId).find((x) => x.planned.id === plannedId)!;
}

/**
 * Puts a song on a session, or takes it off, leaving it on any others: a song is recorded in more than one session
 * (its audio, then its video), each with its own storyboard and shot list or the release's. Only while the session is
 * being planned.
 */
export function setSongOnSession(actor: Actor, plannedId: string, sessionId: string, on: boolean): Placement {
  const db = getDb();
  const planned = db.plannedEpisodes.find((p) => p.id === plannedId);
  if (!planned || planned.archivedAt) throw new RuleError("That song is no longer on the list.");
  const project = projectForWrite(actor, planned.contentId);
  if (!isMusicForm(project.workflow.formType)) throw new RuleError("Only a music release puts a song on several sessions.");
  const { session } = sessionForWrite(actor, sessionId);
  if (session.contentId !== planned.contentId) throw new RuleError("That session belongs to another release.");
  if (session.status !== "Planned")
    throw new RuleError(`${sessionName(session)} has started recording. Choose a session still being planned.`);
  const has = db.sessionLogEntries.some((e) => e.sessionId === sessionId && e.plannedEpisodeId === plannedId);
  if (on !== has) {
    const before = recordTitles(sessionId);
    if (on) addLogRow(actor, sessionId, { plannedEpisodeId: plannedId });
    else db.sessionLogEntries = db.sessionLogEntries.filter((e) => !(e.sessionId === sessionId && e.plannedEpisodeId === plannedId));
    followRunSheet(sessionId, before);
    logAudit(actor, "devotion-session", "record", planned.contentId, `${plannedTitle(planned)}: ${on ? "on" : "off"} ${sessionId}`);
  }
  commit();
  return devotionPlacements(planned.contentId).find((x) => x.planned.id === plannedId)!;
}

/** What a session is called: its name, or its code. */
export const sessionName = (s: RecordingSession | undefined): string => (s ? s.name?.trim() || `Session ${s.sessionNumber}` : "a session");

/** The times a call sheet shows, read from its session's run sheet: never typed twice. */
export interface SheetTimes {
  crewCall: string | null;
  talentArrival: string | null;
  startRecording: string | null;
  wrap: string | null;
}

export function sheetTimes(runSheet: RunItem[]): SheetTimes {
  const rows = [...runSheet].sort((a, b) => a.time.localeCompare(b.time));
  const at = (re: RegExp) => rows.find((i) => re.test(i.title))?.time ?? null;
  return {
    crewCall: at(/crew call/i) ?? rows[0]?.time ?? null,
    talentArrival: at(/talent|guest arriv|host arriv/i),
    startRecording: at(/^(record\b|episode \d)/i),
    wrap: at(/^wrap/i),
  };
}

// ── A session's storyboard and shot list ─────────────────────

export interface BoardChoice {
  storyboardId?: string | null;
  shotListId?: string | null;
}

/** Chooses the storyboard and shot list a session's call sheet shows. They stay where they are, to be edited there. */
export function setSessionBoards(actor: Actor, sessionId: string, choice: BoardChoice): RecordingSession {
  const { session } = sessionForWrite(actor, sessionId);
  if (session.status === "Closed") throw new RuleError("This session is closed.");
  const db = getDb();
  if (choice.storyboardId !== undefined) {
    if (choice.storyboardId && !db.storyboards.some((b) => b.id === choice.storyboardId && b.contentId === session.contentId))
      throw new RuleError("Choose one of this project's storyboards.");
    session.storyboardId = choice.storyboardId || null;
  }
  if (choice.shotListId !== undefined) {
    if (choice.shotListId && !db.shotLists.some((l) => l.id === choice.shotListId && l.contentId === session.contentId))
      throw new RuleError("Choose one of this project's shot lists.");
    session.shotListId = choice.shotListId || null;
  }
  session.updatedAt = nowStamp();
  logAudit(
    actor,
    "session-boards",
    "session",
    sessionId,
    `storyboard ${session.storyboardId ?? "none"}, shot list ${session.shotListId ?? "none"}`,
  );
  commit();
  return session;
}

// ── Where the footage is kept ────────────────────────────────

/** Drives are seen by those who may use storage (Crew and the Head of Production unless changed), so they choose them. */
const requireStorage = (actor: Actor): void => {
  if (!hasStorageAccess(actor)) throw new RuleError("Only someone who may use storage can choose the drive.");
};

const requireDrive = (driveId: string) => {
  const d = getDrive(driveId);
  if (!d) throw new RuleError("Choose one of the drives on the Storage screen.");
  return d;
};

/** The drive a project's footage is planned to go on (the Recording Plan's Cards and storage). */
export function setProjectDrive(actor: Actor, projectId: string, driveId: string | null): Project {
  const p = projectForWrite(actor, projectId);
  requireStorage(actor);
  if (driveId) requireDrive(driveId);
  p.workflow.storageDriveId = driveId || null;
  p.version += 1;
  logAudit(actor, "storage-plan", "record", projectId, driveId ? `footage to go on ${getDrive(driveId)!.name}` : "no drive chosen");
  commit();
  return p;
}

/** The drive a session's footage goes on: its own, or the project's. */
export function sessionDriveId(session: RecordingSession): string | null {
  const p = getRecord(session.contentId) as Project | undefined;
  return session.storageDriveId ?? p?.workflow?.storageDriveId ?? null;
}

/** The storage entry for a session's recorded footage, once its size is entered. */
export const footageOf = (sessionId: string): DriveAllocation | undefined =>
  getDb().allocations.find((a) => a.sessionId === sessionId && a.role !== "backup");

/** The storage entry for the assets post production makes for an episode. */
export const assetsOf = (episodeId: string): DriveAllocation | undefined =>
  getDb().allocations.find((a) => a.contentId === episodeId && a.kind === "project" && !a.sessionId);

/** Changes the drive a session's footage goes on. Footage already entered moves with it, if the drive has room. */
export function setSessionDrive(actor: Actor, sessionId: string, driveId: string | null): RecordingSession {
  const { session } = sessionForWrite(actor, sessionId);
  requireStorage(actor);
  if (driveId) requireDrive(driveId);
  session.storageDriveId = driveId || null;
  session.updatedAt = nowStamp();
  const footage = footageOf(sessionId);
  const target = sessionDriveId(session);
  if (footage && target && footage.driveId !== target) updateAllocation(actor, footage.id, { driveId: target });
  logAudit(actor, "storage-plan", "session", sessionId, target ? `footage on ${getDrive(target)?.name ?? target}` : "no drive chosen");
  commit();
  return session;
}

const checkSize = (sizeGB: number): void => {
  if (!Number.isFinite(sizeGB) || sizeGB <= 0 || sizeGB > 1_000_000) throw new RuleError("Enter the size in GB, more than zero.");
};

/**
 * The space a session's recorded footage takes, entered once recording has started: kept as raw footage on the
 * session's drive (the Storage screen's own entry, so the drive's free space and warnings include it).
 */
export function setSessionFootage(actor: Actor, sessionId: string, sizeGB: number): DriveAllocation {
  const { session } = sessionForWrite(actor, sessionId);
  if (session.status === "Planned") throw new RuleError("The footage's size is entered once recording has started.");
  checkSize(sizeGB);
  const existing = footageOf(sessionId);
  if (existing) {
    const a = updateAllocation(actor, existing.id, { sizeGB });
    commit();
    return a;
  }
  const driveId = sessionDriveId(session);
  if (!driveId) throw new RuleError("Choose the drive the footage is on first.");
  const a = addAllocation(actor, {
    driveId,
    contentId: session.contentId,
    sizeGB,
    kind: "raw",
    label: `${sessionName(session)} footage`,
    note: `Recording session ${session.id}`,
  });
  a.sessionId = sessionId;
  a.role = "primary";
  logAudit(actor, "storage-footage", "session", sessionId, fmtSize(sizeGB));
  commit();
  return a;
}

export interface AssetsInput {
  driveId?: string | null;
  sizeGB?: number;
}

/**
 * The space the assets post production makes for an episode take (project files, renders, graphics), and the drive
 * they are on: the project's drive unless another is chosen. Changed as the edit grows.
 */
export function setEpisodeAssets(actor: Actor, episodeId: string, input: AssetsInput): DriveAllocation {
  const { project } = episodeForWrite(actor, episodeId);
  const existing = assetsOf(episodeId);
  if (input.sizeGB !== undefined) checkSize(input.sizeGB);
  if (input.driveId) requireDrive(input.driveId);
  if (existing) {
    const a = updateAllocation(actor, existing.id, {
      ...(input.sizeGB !== undefined ? { sizeGB: input.sizeGB } : {}),
      ...(input.driveId ? { driveId: input.driveId } : {}),
    });
    commit();
    return a;
  }
  const driveId = input.driveId || project.workflow.storageDriveId || null;
  if (!driveId) throw new RuleError("Choose the drive the assets are on first.");
  if (input.sizeGB === undefined) throw new RuleError("Enter the size in GB, more than zero.");
  const a = addAllocation(actor, { driveId, contentId: episodeId, sizeGB: input.sizeGB, kind: "project", label: "Edit assets" });
  logAudit(actor, "storage-assets", "record", episodeId, fmtSize(input.sizeGB));
  commit();
  return a;
}

/** Devotions with no session yet: a note in the plan and on the gate, never a block. */
export const unassignedDevotions = (projectId: string): Placement[] =>
  devotionPlacements(projectId).filter((x) => !x.sessionId && !x.locked);

/** Whether a session has a devotion on it (for the plan's tick boxes). */
export const onSession = (sessionId: string, plannedId: string): boolean => rowsOf(sessionId).some((r) => r.plannedEpisodeId === plannedId);
