import type {
  Actor,
  ChecklistOwner,
  ContentRecord,
  DevelopmentForm,
  Person,
  RecordingSession,
  ReviewCheckpoint,
  SessionLogEntry,
  WorkflowChecklistItem,
} from "../../types";
import { RuleError } from "../../types";
import { getDb } from "../../data/store";
import { CHECKLISTS, type ChecklistKey } from "../../config/workflow";
import { canView, canWrite, getRecord, isHop, rootOf } from "../access";
import { can } from "../permissions";
import { getPerson } from "../people";
import { logAudit } from "../audit";

// Shared by the workflow's services: finding a project, session or episode and checking who may change it.

export const nowStamp = (): string => new Date().toISOString();

/** The project a record is, if it runs the five-stage workflow. */
export const isWorkflowProject = (
  r: ContentRecord | undefined,
): r is ContentRecord & { workflow: NonNullable<ContentRecord["workflow"]> } => !!r?.workflow;
export const isWorkflowEpisode = (r: ContentRecord | undefined): r is ContentRecord & { episode: NonNullable<ContentRecord["episode"]> } =>
  !!r?.episode;

export type Project = ContentRecord & { workflow: NonNullable<ContentRecord["workflow"]> };
export type Episode = ContentRecord & { episode: NonNullable<ContentRecord["episode"]> };

export function requireProject(id: string): Project {
  const r = getRecord(id);
  if (!isWorkflowProject(r)) throw new RuleError("Project not found.");
  return r;
}

/** A project this person may change. Closed projects are kept as they were and cannot be changed. */
export function projectForWrite(actor: Actor, id: string): Project {
  const p = requireProject(id);
  if (!canWrite(actor, p)) throw new RuleError("You have view-only access to this project.");
  if (p.archived) throw new RuleError("This project is closed. It is kept as it was and cannot be changed.");
  return p;
}

export function projectForView(actor: Actor, id: string): Project {
  const p = requireProject(id);
  if (!canView(actor, p)) throw new RuleError("Project not found.");
  return p;
}

export function requireEpisode(id: string): Episode {
  const r = getRecord(id);
  if (!isWorkflowEpisode(r)) throw new RuleError("Episode not found.");
  return r;
}

export function projectOfEpisode(ep: ContentRecord): Project {
  return requireProject(ep.parentId ?? "");
}

export function episodeForWrite(actor: Actor, id: string): { ep: Episode; project: Project } {
  const ep = requireEpisode(id);
  const project = projectForWrite(actor, ep.parentId ?? "");
  if (ep.archived) throw new RuleError("This episode is archived and cannot be changed.");
  return { ep, project };
}

export const getSession = (id: string): RecordingSession | undefined => getDb().recordingSessions.find((s) => s.id === id);

export function requireSession(id: string): RecordingSession {
  const s = getSession(id);
  if (!s) throw new RuleError("Recording session not found.");
  return s;
}

export function sessionForWrite(actor: Actor, id: string): { session: RecordingSession; project: Project } {
  const session = requireSession(id);
  const project = projectForWrite(actor, session.contentId);
  if (session.archivedAt) throw new RuleError("This session is archived and cannot be changed.");
  return { session, project };
}

export function formOf(projectId: string): DevelopmentForm {
  const f = getDb().developmentForms.find((x) => x.contentId === projectId);
  if (!f) throw new RuleError("This project has no development form.");
  return f;
}

export const rowsOf = (sessionId: string): SessionLogEntry[] => getDb().sessionLogEntries.filter((e) => e.sessionId === sessionId);
export const sessionsOf = (projectId: string): RecordingSession[] =>
  getDb()
    .recordingSessions.filter((s) => s.contentId === projectId)
    .sort((a, b) => a.sessionNumber - b.sessionNumber);
export const episodesOf = (projectId: string, includeArchived = false): Episode[] =>
  getDb()
    .records.filter((r): r is Episode => !!r.episode && r.parentId === projectId && (includeArchived || !r.archived))
    .sort((a, b) => a.episode.episodeNumber - b.episode.episodeNumber);
export const isDocumentary = (p: Project): boolean =>
  p.workflow.formType === "documentary_dof" || p.workflow.formType === "documentary_pitched";

/** Planned episodes not made yet and not on the log of a session still to come: another session is needed for them. */
export function unscheduledPlanned(projectId: string): number {
  const db = getDb();
  const upcoming = new Set(
    db.recordingSessions.filter((s) => s.contentId === projectId && !s.archivedAt && s.status !== "Closed").map((s) => s.id),
  );
  const onLog = new Set(db.sessionLogEntries.filter((e) => upcoming.has(e.sessionId)).map((e) => e.plannedEpisodeId));
  const made = new Set(episodesOf(projectId).map((e) => e.episode.plannedEpisodeId));
  return db.plannedEpisodes.filter((x) => x.contentId === projectId && !x.archivedAt && !made.has(x.id) && !onLog.has(x.id)).length;
}

export const checkpointsOf = (contentId: string, episodeId: string | null): ReviewCheckpoint[] =>
  getDb().reviewCheckpoints.filter((c) => c.contentId === contentId && c.episodeId === episodeId);
export const checkpoint = (owner: string, key: ReviewCheckpoint["checkpoint"]): ReviewCheckpoint | undefined =>
  getDb().reviewCheckpoints.find((c) => c.id === `${owner}|${key}`);

// ── People ───────────────────────────────────────────────────

/** Someone on the crew list: active Crew or the Head of Production. Every assignee is chosen from these. */
export function requireCrew(personId: string, what: string): Person {
  const p = getPerson(personId);
  if (!p || p.status !== "active" || (p.category !== "CRW" && p.category !== "HOP"))
    throw new RuleError(`${what} must be someone on the crew list.`);
  return p;
}

export const isProducer = (actor: Actor, p: Project): boolean => p.workflow.showProducerId === actor.personId;
/** Greenlight decisions, and closing a project. */
export const canDecide = (actor: Actor): boolean => isHop(actor) || can(actor, "pipeline.manage");
/** Naming the show producer. Operations does this; here it is whoever may assign other people's work. */
export const canNameProducer = (actor: Actor): boolean => isHop(actor) || can(actor, "pipeline.assign");
/** Assigning the other project roles: the producer, or whoever may assign other people's work. */
export const canManageTeam = (actor: Actor, p: Project): boolean => canNameProducer(actor) || isProducer(actor, p);

/** Someone given work on a project becomes part of it, so they can see and change it. */
export function joinProject(actor: Actor, personId: string, p: ContentRecord): void {
  const person = getPerson(personId);
  if (!person || person.category === "HOP") return;
  const rootId = rootOf(p).contentId;
  if (getDb().members.some((m) => m.personId === personId && m.projectContentId === rootId)) return;
  getDb().members.push({ personId, projectContentId: rootId, roleOnProject: "Assigned", canComment: person.category !== "VOL" });
  logAudit(actor, "assign", "person", personId, `${rootId} (via the workflow)`);
}

// ── Checklists ───────────────────────────────────────────────

/** Adds a checklist's items to its owner, once. Items worked out from the data are never stored. */
export function ensureChecklist(key: ChecklistKey, ownerType: ChecklistOwner, ownerId: string): void {
  const def = CHECKLISTS[key];
  const db = getDb();
  const at = nowStamp();
  for (const item of def.items) {
    if (item.auto) continue;
    const id = `${ownerId}|${def.stage}|${item.key}`;
    if (db.workflowChecklistItems.some((c) => c.id === id)) continue;
    const row: WorkflowChecklistItem = {
      id,
      ownerType,
      ownerId,
      stage: def.stage,
      itemKey: item.key,
      label: item.label,
      required: item.required,
      done: false,
      note: "",
      doneAt: null,
      doneById: null,
      createdAt: at,
      updatedAt: at,
    };
    db.workflowChecklistItems.push(row);
  }
}

/** The stored items of one checklist for one owner, in the order the checklist lists them. */
export function checklistItems(key: ChecklistKey, ownerId: string): WorkflowChecklistItem[] {
  const def = CHECKLISTS[key];
  const order = def.items.map((i) => i.key);
  return getDb()
    .workflowChecklistItems.filter((c) => c.ownerId === ownerId && c.stage === def.stage && order.includes(c.itemKey))
    .sort((a, b) => order.indexOf(a.itemKey) - order.indexOf(b.itemKey));
}

/** The labels of a checklist's required items not yet ticked, counting an item never added as not ticked. */
export function openRequired(key: ChecklistKey, ownerId: string): string[] {
  const def = CHECKLISTS[key];
  const stored = checklistItems(key, ownerId);
  return def.items.filter((i) => i.required && !i.auto && !stored.some((c) => c.itemKey === i.key && c.done)).map((i) => i.label);
}

export { isHop };
