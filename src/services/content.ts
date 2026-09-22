import type { Actor, CategoryKey, Comment, ContentRecord, Featured, ProductionLevel, StageLink, StageOwner, StageTask } from "../types";
import { cleanRoles } from "../config/projectRoles";
import { can, requireCan } from "./permissions";
import { ConflictError, RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { categoryOf, finalStageOf } from "../config/categories";
import { archiveDocsFor, attachStageDocs, docSubject } from "./docs";
import { checkedOutFor, releaseReservedFor, reservedFor } from "./equipment";
import { recordSnapshot } from "./driveUsage";
import { fmtSize } from "./utils";
import { canComment, canJoin, canView, canWrite, getRecord, isHop, selfAndAncestors, visibleRecords } from "./access";
import { getPerson } from "./people";
import { logAudit } from "./audit";
import { daysUntil, hoursUntilEndOfDay, pad, todayIso } from "./utils";

// ── Hierarchy helpers ────────────────────────────────────────

export function getChildren(parentId: string, includeArchived = false): ContentRecord[] {
  return getDb()
    .records.filter((r) => r.parentId === parentId && (includeArchived || !r.archived))
    .sort((a, b) => a.contentId.localeCompare(b.contentId, undefined, { numeric: true }));
}

/** Only the level that does production work moves through a pipeline. */
export function usesPipeline(r: ContentRecord): boolean {
  const cfg = categoryOf(r.category);
  return r.hierarchyLevel === cfg.leafLevel;
}

/** All pipeline-carrying descendants of a record (or the record itself if it is one). */
export function leavesUnder(r: ContentRecord): ContentRecord[] {
  if (usesPipeline(r)) return r.archived ? [] : [r];
  return getChildren(r.contentId).flatMap(leavesUnder);
}

export interface ProductionUnit { id: string; title: string; leaves: ContentRecord[] }

/**
 * One row per production for dashboard counts. A live show with several days is many leaves
 * (one per day) but one production, so its days collapse into the show they belong to.
 * Every other category counts one leaf as one production, same as before.
 */
export function productionUnits(leaves: ContentRecord[]): ProductionUnit[] {
  const map = new Map<string, ProductionUnit>();
  for (const leaf of leaves) {
    const show = leaf.category === "live" && leaf.hierarchyLevel > 0 ? getRecord(leaf.parentId!) : null;
    const owner = show ?? leaf;
    if (!map.has(owner.contentId)) map.set(owner.contentId, { id: owner.contentId, title: owner.title, leaves: [] });
    map.get(owner.contentId)!.leaves.push(leaf);
  }
  return [...map.values()];
}

export function levelLabel(r: ContentRecord): string {
  const cfg = categoryOf(r.category);
  if (r.hierarchyLevel === 0) return cfg.singular;
  if (r.hierarchyLevel === 1) return cfg.childLevelLabel ?? "Level 1";
  return cfg.grandchildLevelLabel ?? "Level 2";
}

/** What can be created underneath this record, per category config. */
export function childKindFor(r: ContentRecord): string | null {
  const cfg = categoryOf(r.category);
  if (!cfg.supportsChildren) return null;
  if (r.hierarchyLevel === 0) return cfg.childLevelLabel;
  if (r.hierarchyLevel === 1) return cfg.grandchildLevelLabel;
  return null;
}

// ── Stage state ──────────────────────────────────────────────

export const currentStageDeadline = (r: ContentRecord): string | null =>
  r.pipelineStage ? r.stageDeadlines[r.pipelineStage] ?? null : null;

export function isComplete(r: ContentRecord): boolean {
  if (!usesPipeline(r) || !r.pipelineStage) return false;
  const stages = categoryOf(r.category).stages;
  const last = stages[stages.length - 1].name;
  return r.pipelineStage === last && !!r.stageOutputs[last];
}

export type Risk = "done" | "overdue" | "at-risk" | "ok";

export function riskOf(r: ContentRecord): Risk {
  if (isComplete(r)) return "done";
  const stageDue = currentStageDeadline(r);
  if (stageDue && daysUntil(stageDue) < 0 && !r.stageOutputs[r.pipelineStage!]) return "overdue";
  if (r.deadline && daysUntil(r.deadline) < 0) return "overdue";
  if (r.deadline && r.pipelineStage) {
    const stages = categoryOf(r.category).stages;
    const progress = stages.findIndex((s) => s.name === r.pipelineStage) / (stages.length - 1);
    if (daysUntil(r.deadline) <= 5 && progress < 0.6) return "at-risk";
  }
  return "ok";
}

/** What to call a record in a list. A day of a live show carries the show's name, so five Day 1s stay apart. */
export const displayTitle = (r: ContentRecord): string => docSubject(r);

/** The pseudo-stage that holds the people who work on a whole project rather than one stage. */
export const PROJECT_STAGE = "Project";

export const ownersOf = (r: ContentRecord, stage: string): StageOwner[] => r.stageAssignees[stage] ?? [];

/** Owner of the stage an item is in now. Carried-over responsibility counts until the stage has owners of its own. */
export const isOwnerNow = (r: ContentRecord, personId: string): boolean =>
  !!r.pipelineStage && (ownersOf(r, r.pipelineStage).some((o) => o.personId === personId) || (ownersOf(r, r.pipelineStage).length === 0 && r.assigneePersonId === personId));

/** The person responsible right now is the first owner of the current stage. */
function syncResponsible(r: ContentRecord): void {
  if (!r.pipelineStage) return;
  const first = ownersOf(r, r.pipelineStage)[0];
  if (first) r.assigneePersonId = first.personId;
  else if (Object.keys(r.stageAssignees).includes(r.pipelineStage)) r.assigneePersonId = null;
}

export const tasksOf = (r: ContentRecord, stage: string | null = r.pipelineStage): StageTask[] => r.tasks.filter((t) => t.stage === stage);
export const openTasks = (r: ContentRecord): StageTask[] => tasksOf(r).filter((t) => !t.done);

export function canAdvance(r: ContentRecord): { ok: boolean; reason: string } {
  if (!usesPipeline(r) || !r.pipelineStage) return { ok: false, reason: "This record is a container. Its episodes or tracks carry the pipeline." };
  const stages = categoryOf(r.category).stages;
  const idx = stages.findIndex((s) => s.name === r.pipelineStage);
  if (idx === stages.length - 1) return { ok: false, reason: "Already at the final stage." };
  const open = openTasks(r);
  if (open.length) return { ok: false, reason: `Finish ${open.map((t) => t.label).join(", ")} before leaving ${r.pipelineStage}.` };
  if (!r.stageOutputs[r.pipelineStage]) {
    return { ok: false, reason: `Confirm "${stages[idx].requiredOutput}" before leaving ${r.pipelineStage}.` };
  }
  return { ok: true, reason: "" };
}

// ── Content ID generation ────────────────────────────────────

function nextTopLevelId(category: CategoryKey): string {
  const code = categoryOf(category).code;
  const nums = getDb()
    .records.filter((r) => r.category === category && r.hierarchyLevel === 0)
    .map((r) => parseInt(r.contentId.split("-")[2], 10))
    .filter((n) => !Number.isNaN(n));
  return `DOF-${code}-${pad((nums.length ? Math.max(...nums) : 0) + 1)}`;
}

function nextChildId(parent: ContentRecord): string {
  const cfg = categoryOf(parent.category);
  const token = parent.hierarchyLevel === 0 ? cfg.childToken! : cfg.grandchildToken!;
  const width = parent.hierarchyLevel === 0 ? 1 : 2;
  const nums = getChildren(parent.contentId, true).map((c) => parseInt(c.contentId.slice(parent.contentId.length + 1 + token.length), 10));
  const n = (nums.length ? Math.max(...nums.filter((x) => !Number.isNaN(x))) : 0) + 1;
  return `${parent.contentId}-${token}${pad(n, width)}`;
}

// ── Create / update / delete ─────────────────────────────────

/** Being assigned to a record means being attached to its project, otherwise the assignee could not work on it. */
function ensureMember(actor: Actor, personId: string | null | undefined, r: ContentRecord): void {
  if (!personId) return;
  const person = getDb().people.find((p) => p.personId === personId);
  if (!person || person.category === "HOP") return;
  const rootId = selfAndAncestors(r).slice(-1)[0].contentId;
  const already = getDb().members.some((m) => m.personId === personId && m.projectContentId === rootId);
  if (already) return;
  getDb().members.push({ personId, projectContentId: rootId, roleOnProject: "Assigned", canComment: person.category !== "VOL" });
  logAudit(actor, "assign", "person", personId, `${rootId} (via assignment)`);
}

export interface NewRecordInput {
  category: CategoryKey;
  title: string;
  scheduledDate?: string | null;
  deadline?: string | null;
  assigneePersonId?: string | null;
  productionLevel?: ProductionLevel | null; // live: applied to each day created
  showStart?: string | null; // series and live shows
  showEnd?: string | null;
  notes?: string;
}

function blankRecord(id: string, category: CategoryKey, title: string, parentId: string | null, level: number): ContentRecord {
  return {
    contentId: id,
    title,
    category,
    parentId,
    hierarchyLevel: level,
    pipelineStage: null,
    stageOutputs: {},
    stageDeadlines: {},
    scheduledDate: null,
    startDate: todayIso(),
    deadline: null,
    assigneePersonId: null,
    stageAssignees: {},
    tasks: [],
    links: [],
    productionLevel: null,
    featured: [],
    showStart: null,
    showEnd: null,
    spunOffFrom: null,
    postProductionNeeded: null,
    strikePattern: null,
    strikeChecklist: null,
    archived: false,
    version: 1,
    createdAt: new Date().toISOString(),
    notes: "",
  };
}

function initPipeline(actor: Actor, r: ContentRecord, stepDays = 4, startStage?: string): void {
  const stages = categoryOf(r.category).stages;
  r.pipelineStage = startStage ?? stages[0].name;
  r.stageOutputs = Object.fromEntries(stages.map((s) => [s.name, false]));
  const base = new Date();
  r.stageDeadlines = Object.fromEntries(
    stages.map((s, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + (i + 1) * stepDays);
      return [s.name, d.toISOString().slice(0, 10)];
    }),
  );
  ensureStageTasks(r, r.pipelineStage);
  attachStageDocs(actor, r, r.pipelineStage);
}

/** What a live day's Wrap checklist should contain: what comes down every night, plus, on the show's last day, what stays rigged until then. */
function wrapTasksFor(r: ContentRecord): string[] {
  if (r.category !== "live") return [];
  const show = r.parentId ? getRecord(r.parentId) : null;
  if (!show?.strikeChecklist) return [];
  const isLastDay = !show.showEnd || r.scheduledDate === show.showEnd;
  return isLastDay ? [...show.strikeChecklist.daily, ...show.strikeChecklist.final] : show.strikeChecklist.daily;
}

/** Creates the default checklist for a stage the first time an item enters it. */
export function ensureStageTasks(r: ContentRecord, stage: string): void {
  if (r.tasks.some((t) => t.stage === stage)) return;
  const def = categoryOf(r.category).stages.find((x) => x.name === stage);
  const labels = stage === "Wrap" ? wrapTasksFor(r) : (def?.tasks ?? []);
  for (const label of labels) {
    r.tasks.push({ id: `T-${pad(nextCounter("task"), 4)}`, stage, label, done: false, dueDate: r.stageDeadlines[stage] ?? null, assigneePersonId: null, doneAt: null, doneBy: null });
  }
}

/** The show runs from a first day to a last day. */
function checkShowDates(category: CategoryKey, start: string | null | undefined, end: string | null | undefined): void {
  if (!start && !end) return;
  if (category !== "series" && category !== "live") throw new RuleError("Show dates apply to series and live shows.");
  if (end && !start) throw new RuleError("Set the day the show starts as well as the day it ends.");
  if (start && end && end < start) throw new RuleError("The show cannot end before it starts.");
}

const MAX_SHOW_DAYS = 31;

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const [y, m, d] = start.split("-").map(Number);
  for (let i = 0; i <= MAX_SHOW_DAYS; i++) {
    const dt = new Date(y, m - 1, d + i);
    const p = (x: number) => String(x).padStart(2, "0");
    const iso = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
    if (iso > end) break;
    out.push(iso);
  }
  return out;
}

/** A live show is made of days. Each is its own item, with its own pipeline, call sheet and run of show. */
function createDays(actor: Actor, show: ContentRecord, input: NewRecordInput): void {
  const dates = input.showStart ? datesBetween(input.showStart, input.showEnd || input.showStart) : [null];
  if (dates.length > MAX_SHOW_DAYS) throw new RuleError(`A live show can run for up to ${MAX_SHOW_DAYS} days. Add a longer one in parts.`);
  dates.forEach((date, i) => {
    const day = blankRecord(nextChildId(show), "live", `Day ${i + 1}`, show.contentId, 1);
    day.scheduledDate = date;
    day.deadline = date ?? input.deadline ?? null; // a live day is published on the day it is streamed
    day.assigneePersonId = input.assigneePersonId || null;
    day.productionLevel = input.productionLevel ?? null;
    initPipeline(actor, day);
    if (day.assigneePersonId && day.pipelineStage) day.stageAssignees[day.pipelineStage] = [{ personId: day.assigneePersonId, roles: [] }];
    getDb().records.push(day);
    ensureMember(actor, day.assigneePersonId, day);
  });
}

/** Creates a top-level project (Head of Production only). */
export function createRecord(actor: Actor, input: NewRecordInput): ContentRecord {
  requireCan(actor, "pipeline.manage", "create a new project");
  if (!input.title.trim()) throw new RuleError("Give the project a title.");
  checkShowDates(input.category, input.showStart, input.showEnd);
  if (input.category === "live" && input.showStart && datesBetween(input.showStart, input.showEnd || input.showStart).length > MAX_SHOW_DAYS) throw new RuleError(`A live show can run for up to ${MAX_SHOW_DAYS} days. Add a longer one in parts.`);
  const r = blankRecord(nextTopLevelId(input.category), input.category, input.title.trim(), null, 0);
  r.showStart = input.showStart || null;
  r.showEnd = input.showEnd || null;
  r.deadline = input.deadline || null;
  r.scheduledDate = input.scheduledDate || null;
  r.assigneePersonId = input.assigneePersonId || null;
  r.notes = input.notes ?? "";
  if (usesPipeline(r)) {
    if (input.productionLevel) r.productionLevel = validLevel(r, input.productionLevel);
    initPipeline(actor, r);
  }
  if (r.assigneePersonId && r.pipelineStage) r.stageAssignees[r.pipelineStage] = [{ personId: r.assigneePersonId, roles: [] }];
  getDb().records.push(r);
  ensureMember(actor, r.assigneePersonId, r);
  if (r.category === "live") createDays(actor, r, input);
  logAudit(actor, "create", "record", r.contentId, r.title);
  commit();
  return r;
}

export function createChildRecord(actor: Actor, parentId: string, input: Omit<NewRecordInput, "category">): ContentRecord {
  const parent = getRecord(parentId);
  if (!parent) throw new RuleError("Parent record not found.");
  if (!canWrite(actor, parent)) throw new RuleError("You are not assigned to this project.");
  const kind = childKindFor(parent);
  if (!kind) throw new RuleError(`${categoryOf(parent.category).label} records cannot have children.`);
  if (!input.title.trim()) throw new RuleError(`Give the ${kind.toLowerCase()} a title.`);
  const r = blankRecord(nextChildId(parent), parent.category, input.title.trim(), parent.contentId, parent.hierarchyLevel + 1);
  r.deadline = input.deadline || null;
  r.scheduledDate = input.scheduledDate || null;
  r.assigneePersonId = input.assigneePersonId || null;
  r.notes = input.notes ?? "";
  if (usesPipeline(r)) {
    if (input.productionLevel) r.productionLevel = validLevel(r, input.productionLevel);
    initPipeline(actor, r);
  }
  if (r.assigneePersonId && r.pipelineStage) r.stageAssignees[r.pipelineStage] = [{ personId: r.assigneePersonId, roles: [] }];
  getDb().records.push(r);
  ensureMember(actor, r.assigneePersonId, r);
  logAudit(actor, "create", "record", r.contentId, `${kind}: ${r.title}`);
  commit();
  return r;
}

// A recording made on a live day, spun off into its own item. It starts past the stages that assume
// there is no footage yet, since the footage already exists — it lands where editing begins.
const SPIN_OFF_START_STAGE: Record<"music" | "series", string> = { music: "Audio post-production", series: "Editorial" };
export const spinOffCategories: ("music" | "series")[] = ["music", "series"];

export interface SplitInput { destCategory: "music" | "series"; parentId: string; title: string }

/** Splits a recording made on a live day into its own Music track or Series episode, already past Recording. */
export function splitRecording(actor: Actor, dayId: string, input: SplitInput): ContentRecord {
  const day = getRecord(dayId);
  if (!day) throw new RuleError("Live day not found.");
  if (day.category !== "live" || !usesPipeline(day)) throw new RuleError("Only a live day's recording can be split off like this.");
  if (!canWrite(actor, day)) throw new RuleError("You are not assigned to this project.");
  if (!spinOffCategories.includes(input.destCategory)) throw new RuleError("Choose Music or Series.");
  const parent = getRecord(input.parentId);
  if (!parent || parent.category !== input.destCategory) throw new RuleError(`Choose an ${categoryOf(input.destCategory).childLevelLabel?.toLowerCase()} to put it in.`);
  if (!canWrite(actor, parent)) throw new RuleError("You are not assigned to that project.");
  if (!input.title.trim()) throw new RuleError(`Give the ${categoryOf(input.destCategory).grandchildLevelLabel?.toLowerCase()} a title.`);
  const r = blankRecord(nextChildId(parent), input.destCategory, input.title.trim(), parent.contentId, parent.hierarchyLevel + 1);
  r.scheduledDate = day.scheduledDate;
  r.spunOffFrom = day.contentId;
  r.notes = `Recorded live on ${day.title} (${day.contentId}).`;
  initPipeline(actor, r, 4, SPIN_OFF_START_STAGE[input.destCategory]);
  getDb().records.push(r);
  logAudit(actor, "create", "record", r.contentId, `${categoryOf(input.destCategory).grandchildLevelLabel}: ${r.title}, split from ${day.contentId}`);
  commit();
  return r;
}

/** Every Music track or Series episode that was split off from this live day. */
export function spinOffsOf(dayId: string): ContentRecord[] {
  return getDb().records.filter((r) => r.spunOffFrom === dayId);
}

/** The show's strike plan: what comes down every night, and what stays rigged until the last day. Live shows only. */
export function setStrikePlan(actor: Actor, id: string, pattern: "daily" | "continuous", daily: string[], final: string[], expectedVersion?: number): ContentRecord {
  const r = loadForWrite(actor, id, expectedVersion);
  if (r.category !== "live" || r.hierarchyLevel !== 0) throw new RuleError("Only a live show itself has a strike plan.");
  const clean = (list: string[]) => list.map((s) => s.trim()).filter(Boolean);
  r.strikePattern = pattern;
  r.strikeChecklist = { daily: clean(daily), final: clean(final) };
  // Any day already at or past Wrap keeps its checklist as it was when it entered; only days that have not reached Wrap yet pick up the change.
  for (const day of getChildren(id)) {
    if (day.pipelineStage === "Wrap" && !day.tasks.some((t) => t.stage === "Wrap")) ensureStageTasks(day, "Wrap");
  }
  r.version += 1;
  logAudit(actor, "update", "record", id, "Strike plan");
  commit();
  return r;
}

function loadForWrite(actor: Actor, id: string, expectedVersion?: number): ContentRecord {
  const r = getRecord(id);
  if (!r) throw new RuleError("Record not found.");
  if (!canWrite(actor, r)) throw new RuleError("You have view-only access to this project.");
  if (expectedVersion !== undefined && r.version !== expectedVersion) throw new ConflictError();
  return r;
}

export function updateRecord(
  actor: Actor,
  id: string,
  patch: Partial<Pick<ContentRecord, "title" | "scheduledDate" | "deadline" | "assigneePersonId" | "notes" | "productionLevel" | "showStart" | "showEnd">>,
  expectedVersion?: number,
): ContentRecord {
  const r = loadForWrite(actor, id, expectedVersion);
  if (patch.title !== undefined && !patch.title.trim()) throw new RuleError("Title cannot be empty.");
  if (patch.productionLevel !== undefined && patch.productionLevel !== null) patch.productionLevel = validLevel(r, patch.productionLevel);
  if (patch.showStart !== undefined || patch.showEnd !== undefined) checkShowDates(r.category, patch.showStart !== undefined ? patch.showStart : r.showStart, patch.showEnd !== undefined ? patch.showEnd : r.showEnd);
  Object.assign(r, patch);
  if (patch.assigneePersonId !== undefined && r.pipelineStage) {
    // The responsible person is the first owner of the current stage, so the two stay in step.
    const rest = ownersOf(r, r.pipelineStage);
    const kept = rest.find((o) => o.personId === patch.assigneePersonId);
    if (patch.assigneePersonId) r.stageAssignees[r.pipelineStage] = [kept ?? { personId: patch.assigneePersonId, roles: [] }, ...rest.filter((o) => o.personId !== patch.assigneePersonId)];
    else r.stageAssignees[r.pipelineStage] = rest.slice(1);
  }
  if (patch.assigneePersonId) ensureMember(actor, patch.assigneePersonId, r);
  r.version += 1;
  logAudit(actor, "update", "record", id, Object.keys(patch).join(", "));
  commit();
  return r;
}

function validLevel(r: ContentRecord, level: ProductionLevel): ProductionLevel {
  if (r.category !== "live" || !usesPipeline(r)) throw new RuleError("Level of production is set on each day of a live show.");
  if (!["small", "medium", "large"].includes(level)) throw new RuleError("Choose small, medium or large.");
  return level;
}

export function setStageDeadline(actor: Actor, id: string, stage: string, date: string, expectedVersion?: number): void {
  const r = loadForWrite(actor, id, expectedVersion);
  r.stageDeadlines[stage] = date;
  r.version += 1;
  logAudit(actor, "stage-deadline", "record", id, `${stage} → ${date}`);
  commit();
}

/** Mark the current stage's required output as present (or not). */
/** Live days only: was anything recorded on this day that needs post-production? Must be answered before Post Production can be confirmed done. */
export function setPostProductionNeeded(actor: Actor, id: string, needed: boolean, expectedVersion?: number): ContentRecord {
  const r = loadForWrite(actor, id, expectedVersion);
  if (r.category !== "live") throw new RuleError("Only live days ask this.");
  r.postProductionNeeded = needed;
  r.stageOutputs["Post Production"] = false; // re-confirm after answering (or changing the answer)
  r.version += 1;
  logAudit(actor, "output-cleared", "record", id, `Post-production needed: ${needed ? "yes" : "no"}`);
  commit();
  return r;
}

export function setStageOutput(actor: Actor, id: string, present: boolean, expectedVersion?: number): void {
  const r = loadForWrite(actor, id, expectedVersion);
  if (!r.pipelineStage) throw new RuleError("This record has no pipeline.");
  if (present && r.category === "live" && r.pipelineStage === "Post Production") {
    if (r.postProductionNeeded === null) throw new RuleError("First say whether anything recorded on this day needs post-production.");
    if (r.postProductionNeeded && !getDb().records.some((x) => x.spunOffFrom === r.contentId)) {
      throw new RuleError("Attach the recording that needs post-production first (split it into a Music track or Series episode), or say that nothing was recorded.");
    }
  }
  r.stageOutputs[r.pipelineStage] = present;
  r.version += 1;
  logAudit(actor, present ? "output-confirmed" : "output-cleared", "record", id, `${r.pipelineStage}: ${categoryOf(r.category).stages.find((s) => s.name === r.pipelineStage)?.requiredOutput}`);
  commit();
}

/** All-or-nothing: checks the gate first, then changes the stage in a single step. */
export function advanceStage(actor: Actor, id: string, expectedVersion?: number): ContentRecord {
  const r = loadForWrite(actor, id, expectedVersion);
  const gate = canAdvance(r);
  if (!gate.ok) throw new RuleError(gate.reason);
  const stages = categoryOf(r.category).stages;
  const idx = stages.findIndex((s) => s.name === r.pipelineStage);
  const from = r.pipelineStage!;
  r.pipelineStage = stages[idx + 1].name;
  ensureStageTasks(r, r.pipelineStage);
  attachStageDocs(actor, r, r.pipelineStage);
  // The next stage's owner takes over. With no owner set yet, responsibility stays where it was.
  const nextOwner = ownersOf(r, r.pipelineStage)[0];
  if (nextOwner) r.assigneePersonId = nextOwner.personId;
  r.version += 1;
  logAudit(actor, "stage-advance", "record", id, `${from} → ${r.pipelineStage}`);
  commit();
  return r;
}

export function sendBackStage(actor: Actor, id: string, expectedVersion?: number): ContentRecord {
  const r = loadForWrite(actor, id, expectedVersion);
  const stages = categoryOf(r.category).stages;
  const idx = stages.findIndex((s) => s.name === r.pipelineStage);
  if (idx <= 0) throw new RuleError("Already at the first stage.");
  const from = r.pipelineStage!;
  r.pipelineStage = stages[idx - 1].name;
  r.stageOutputs[r.pipelineStage] = false; // must be re-verified
  const owner = ownersOf(r, r.pipelineStage)[0];
  if (owner) r.assigneePersonId = owner.personId;
  r.version += 1;
  logAudit(actor, "stage-back", "record", id, `${from} → ${r.pipelineStage}`);
  commit();
  return r;
}

// ── Stage owners ─────────────────────────────────────────────

/**
 * Who does what. A stage can have several owners, each with the roles they do. The Head of Production
 * puts anyone on any stage. Crew on the project can add themselves, change their own roles, or step off.
 */
function ownerTarget(actor: Actor, id: string, stage: string, personId: string, expectedVersion?: number): ContentRecord {
  const mine = personId === actor.personId;
  const existing = getRecord(id);
  // Anyone who may jump in can add themselves to a project they are not attached to yet.
  const r = existing && mine && !canWrite(actor, existing) && canJoin(actor, existing) ? existing : loadForWrite(actor, id, expectedVersion);
  if (stage !== PROJECT_STAGE) {
    if (!usesPipeline(r)) throw new RuleError("Stages belong to episodes, tracks, days and single projects. Use the project team row for the whole project.");
    if (!categoryOf(r.category).stages.some((s) => s.name === stage)) throw new RuleError("That stage does not exist for this category.");
  }
  if (!mine && !can(actor, "pipeline.assign")) throw new RuleError("Only the Head of Production, or someone given \"Assign other people's work\", can change other people's work. You can change your own.");
  return r;
}

export function addStageOwner(actor: Actor, id: string, stage: string, personId: string, roles: string[], expectedVersion?: number): ContentRecord {
  const r = ownerTarget(actor, id, stage, personId, expectedVersion);
  const p = getPerson(personId);
  if (!p || p.status !== "active" || (p.category !== "CRW" && p.category !== "HOP")) throw new RuleError("Only active crew can own a stage.");
  const list = ownersOf(r, stage);
  if (list.some((o) => o.personId === personId)) throw new RuleError(`${p.name} is already on ${stage}. Change their roles instead.`);
  r.stageAssignees[stage] = [...list, { personId, roles: cleanRoles(roles) }];
  syncResponsible(r);
  ensureMember(actor, personId, r);
  r.version += 1;
  logAudit(actor, "owner-add", "record", id, `${stage}: ${p.name}`);
  commit();
  return r;
}

export function setOwnerRoles(actor: Actor, id: string, stage: string, personId: string, roles: string[]): ContentRecord {
  const r = ownerTarget(actor, id, stage, personId);
  const o = ownersOf(r, stage).find((x) => x.personId === personId);
  if (!o) throw new RuleError("That person is not on this stage.");
  o.roles = cleanRoles(roles);
  r.version += 1;
  logAudit(actor, "owner-roles", "record", id, `${stage}: ${personId}`);
  commit();
  return r;
}

export function removeStageOwner(actor: Actor, id: string, stage: string, personId: string): ContentRecord {
  const r = ownerTarget(actor, id, stage, personId);
  if (!ownersOf(r, stage).some((x) => x.personId === personId)) throw new RuleError("That person is not on this stage.");
  r.stageAssignees[stage] = ownersOf(r, stage).filter((x) => x.personId !== personId);
  syncResponsible(r);
  r.version += 1;
  logAudit(actor, "owner-remove", "record", id, `${stage}: ${personId}`);
  commit();
  return r;
}

// ── Stage checklists ─────────────────────────────────────────

export interface TaskInput { stage?: string; label: string; dueDate?: string | null; assigneePersonId?: string | null }

function checkAssignee(personId: string | null | undefined): void {
  if (!personId) return;
  const p = getPerson(personId);
  if (!p || p.status !== "active" || (p.category !== "CRW" && p.category !== "HOP")) throw new RuleError("Only active crew can be given a task.");
}

export function addTask(actor: Actor, id: string, input: TaskInput): StageTask {
  const r = loadForWrite(actor, id);
  if (!usesPipeline(r)) throw new RuleError("Checklists belong to episodes, tracks and single projects.");
  const stage = input.stage ?? r.pipelineStage!;
  if (!categoryOf(r.category).stages.some((s) => s.name === stage)) throw new RuleError("That stage does not exist for this category.");
  if (!input.label.trim()) throw new RuleError("Give the task a name.");
  if (r.tasks.some((t) => t.stage === stage && t.label.toLowerCase() === input.label.trim().toLowerCase())) throw new RuleError(`${stage} already has a task called ${input.label.trim()}.`);
  checkAssignee(input.assigneePersonId);
  const t: StageTask = { id: `T-${pad(nextCounter("task"), 4)}`, stage, label: input.label.trim(), done: false, dueDate: input.dueDate || r.stageDeadlines[stage] || null, assigneePersonId: input.assigneePersonId || null, doneAt: null, doneBy: null };
  r.tasks.push(t);
  if (t.assigneePersonId) ensureMember(actor, t.assigneePersonId, r);
  r.version += 1;
  logAudit(actor, "task-add", "record", id, `${stage}: ${t.label}`);
  commit();
  return t;
}

export function updateTask(actor: Actor, id: string, taskId: string, patch: { label?: string; dueDate?: string | null; assigneePersonId?: string | null; done?: boolean }): StageTask {
  const r = loadForWrite(actor, id);
  const t = r.tasks.find((x) => x.id === taskId);
  if (!t) throw new RuleError("Task not found.");
  if (patch.label !== undefined) {
    if (!patch.label.trim()) throw new RuleError("Give the task a name.");
    t.label = patch.label.trim();
  }
  if (patch.dueDate !== undefined) t.dueDate = patch.dueDate || null;
  if (patch.assigneePersonId !== undefined) {
    checkAssignee(patch.assigneePersonId);
    t.assigneePersonId = patch.assigneePersonId || null;
    if (t.assigneePersonId) ensureMember(actor, t.assigneePersonId, r);
  }
  if (patch.done !== undefined && patch.done !== t.done) {
    t.done = patch.done;
    t.doneAt = patch.done ? new Date().toISOString() : null;
    t.doneBy = patch.done ? actor.personId : null;
  }
  r.version += 1;
  logAudit(actor, "task-update", "record", id, `${t.stage}: ${t.label}${patch.done !== undefined ? (t.done ? " done" : " reopened") : ""}`);
  commit();
  return t;
}

export function removeTask(actor: Actor, id: string, taskId: string): void {
  const r = loadForWrite(actor, id);
  const t = r.tasks.find((x) => x.id === taskId);
  if (!t) throw new RuleError("Task not found.");
  r.tasks = r.tasks.filter((x) => x.id !== taskId);
  r.version += 1;
  logAudit(actor, "task-remove", "record", id, `${t.stage}: ${t.label}`);
  commit();
}

// ── Hosts and guests ─────────────────────────────────────────

export interface FeaturedInput { kind: Featured["kind"]; name: string; note?: string }

export function addFeatured(actor: Actor, id: string, input: FeaturedInput): Featured {
  const r = loadForWrite(actor, id);
  const name = input.name.trim();
  if (!name) throw new RuleError(input.kind === "host" ? "Enter the host's name." : "Enter the guest's name.");
  if (r.featured.some((f) => f.kind === input.kind && f.name.toLowerCase() === name.toLowerCase())) throw new RuleError(`${name} is already listed as a ${input.kind}.`);
  const f: Featured = { id: `F-${pad(nextCounter("featured"), 4)}`, kind: input.kind, name, note: (input.note ?? "").trim() };
  r.featured.push(f);
  r.version += 1;
  logAudit(actor, "featured-add", "record", id, `${input.kind}: ${name}`);
  commit();
  return f;
}

export function updateFeatured(actor: Actor, id: string, featuredId: string, patch: Partial<FeaturedInput>): Featured {
  const r = loadForWrite(actor, id);
  const f = r.featured.find((x) => x.id === featuredId);
  if (!f) throw new RuleError("That person is no longer listed.");
  if (patch.name !== undefined && !patch.name.trim()) throw new RuleError("Enter a name.");
  Object.assign(f, { ...(patch.kind ? { kind: patch.kind } : {}), ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.note !== undefined ? { note: patch.note.trim() } : {}) });
  r.version += 1;
  logAudit(actor, "featured-update", "record", id, f.name);
  commit();
  return f;
}

export function removeFeatured(actor: Actor, id: string, featuredId: string): void {
  const r = loadForWrite(actor, id);
  const f = r.featured.find((x) => x.id === featuredId);
  if (!f) throw new RuleError("That person is no longer listed.");
  r.featured = r.featured.filter((x) => x.id !== featuredId);
  r.version += 1;
  logAudit(actor, "featured-remove", "record", id, f.name);
  commit();
}

/** Hosts and guests on this record, plus the hosts of the show it belongs to. */
export function featuredFor(r: ContentRecord): { own: Featured[]; inherited: { person: Featured; from: ContentRecord }[] } {
  const inherited = selfAndAncestors(r).slice(1).flatMap((a) => a.featured.filter((f) => f.kind === "host").map((person) => ({ person, from: a })));
  return { own: r.featured, inherited };
}

// ── Links: review cuts, the final published link, analysis ───

export interface LinkInput { stage?: string; kind: StageLink["kind"]; url?: string; note?: string }
export interface LinkBatchInput { stage?: string; kind: StageLink["kind"]; links: { url?: string; note?: string }[] }

/** Posts several links at once, for example a review cut in two places. All are checked before any is saved. */
export function addLinks(actor: Actor, id: string, input: LinkBatchInput): StageLink[] {
  const r = loadForWrite(actor, id);
  if (!usesPipeline(r)) throw new RuleError("Links belong to episodes, tracks, days and single projects.");
  const stages = categoryOf(r.category).stages;
  const stage = input.stage ?? r.pipelineStage!;
  if (!stages.some((s) => s.name === stage)) throw new RuleError("That stage does not exist for this category.");
  if (input.kind === "final" && r.pipelineStage !== finalStageOf(r.category).name) throw new RuleError(`The final link is posted once this reaches ${finalStageOf(r.category).name}.`);
  const rows = input.links.map((x) => ({ url: (x.url ?? "").trim(), note: (x.note ?? "").trim() })).filter((x) => x.url || x.note);
  if (!rows.length) throw new RuleError(input.kind === "analysis" ? "Add a link or write the analysis." : "Paste at least one link.");
  for (const row of rows) {
    if (input.kind !== "analysis" && !row.url) throw new RuleError("Every row needs a link. Remove the empty ones.");
    if (row.url && !/^https?:\/\//i.test(row.url)) throw new RuleError(`"${row.url}" is not a link. Links must start with http:// or https://.`);
  }
  const made = rows.map((row): StageLink => ({ id: `L-${pad(nextCounter("link"), 4)}`, stage, kind: input.kind, url: row.url, note: row.note, byPersonId: actor.personId, at: new Date().toISOString() }));
  r.links.push(...made);
  r.version += 1;
  logAudit(actor, "link-add", "record", id, `${stage}: ${input.kind} x ${made.length}`);
  commit();
  return made;
}

export function addLink(actor: Actor, id: string, input: LinkInput): StageLink {
  return addLinks(actor, id, { stage: input.stage, kind: input.kind, links: [{ url: input.url, note: input.note }] })[0];
}

export function removeLink(actor: Actor, id: string, linkId: string): void {
  const r = loadForWrite(actor, id);
  const l = r.links.find((x) => x.id === linkId);
  if (!l) throw new RuleError("Link not found.");
  if (!isHop(actor) && l.byPersonId !== actor.personId) throw new RuleError("Only the person who posted a link, or the Head of Production, can remove it.");
  r.links = r.links.filter((x) => x.id !== linkId);
  r.version += 1;
  logAudit(actor, "link-remove", "record", id, `${l.stage}: ${l.kind}`);
  commit();
}

export function canDelete(id: string): { ok: boolean; reason: string } {
  const active = getChildren(id);
  if (active.length) {
    const kind = childKindFor(getRecord(id)!) ?? "item";
    return { ok: false, reason: `This still has ${active.length} active ${kind.toLowerCase()}${active.length > 1 ? "s" : ""}. Remove those first.` };
  }
  return { ok: true, reason: "" };
}

export interface DeletionImpact {
  blockers: string[]; // why it cannot be deleted right now
  drives: { driveName: string; sizeGB: number }[]; // space that will be released
  totalGB: number;
  docs: number;
  sheets: number;
  gearLists: number;
}

/** Everything attached to this Content ID that goes with it, and anything that stops the deletion. */
export function deletionImpact(actor: Actor, id: string): DeletionImpact {
  const r = getRecord(id);
  if (!r) throw new RuleError("Record not found.");
  const db = getDb();
  const blockers: string[] = [];
  const gate = canDelete(id);
  if (!gate.ok) blockers.push(gate.reason);
  const allocs = db.allocations.filter((a) => a.contentId === id);
  if (allocs.some((a) => a.kind === "raw") && !isHop(actor) && leavesUnder(r).some((l) => !isComplete(l))) {
    blockers.push(`Raw footage for ${r.title} is still on a drive and it is not Delivered. Deliver it first, or ask the Head of Production to delete it.`);
  }
  const out = checkedOutFor(id);
  if (out.length) blockers.push(`Gear is checked out for ${r.title} (${out.map((m) => m.id).join(", ")}). Check it back in first.`);
  const byDrive = new Map<string, number>();
  for (const a of allocs) {
    const name = db.drives.find((d) => d.id === a.driveId)?.name ?? a.driveId;
    byDrive.set(name, (byDrive.get(name) ?? 0) + a.sizeGB);
  }
  return {
    blockers,
    drives: [...byDrive].map(([driveName, sizeGB]) => ({ driveName, sizeGB })),
    totalGB: allocs.reduce((n, a) => n + a.sizeGB, 0),
    docs: db.docs.filter((d) => d.contentId === id && !d.archived).length,
    sheets: db.callSheets.filter((c) => c.contentId === id).length,
    gearLists: reservedFor(id).length,
  };
}

/** What the confirmation dialog tells the person before a project is deleted. */
export function deletionSummary(impact: DeletionImpact): string {
  const parts: string[] = [];
  if (impact.drives.length) parts.push(`release ${fmtSize(impact.totalGB)} on ${impact.drives.length === 1 ? impact.drives[0].driveName : impact.drives.map((d) => `${d.driveName} (${fmtSize(d.sizeGB)})`).join(", ")}`);
  if (impact.docs) parts.push(`archive ${impact.docs} document${impact.docs > 1 ? "s" : ""}, keeping their history`);
  if (impact.gearLists) parts.push(`release ${impact.gearLists} reserved gear list${impact.gearLists > 1 ? "s" : ""}`);
  if (impact.sheets) parts.push(`delete ${impact.sheets} call sheet${impact.sheets > 1 ? "s" : ""}`);
  const also = parts.length ? ` It will also ${parts.join("; ")}.` : "";
  const files = impact.drives.length ? " This updates the records here. The files on the drives are not touched, so remove them from the disk yourself." : "";
  return `It moves to the archive. Its Content ID is kept and never reused.${also}${files}`;
}

/**
 * Removal archives the record so history and IDs are never lost. Everything attached to its Content ID
 * goes with it, so a deleted project no longer takes up space on a drive or holds gear.
 */
export function deleteRecord(actor: Actor, id: string): void {
  const r = loadForWrite(actor, id);
  const impact = deletionImpact(actor, id);
  if (impact.blockers.length) throw new RuleError(impact.blockers[0]);
  const db = getDb();
  for (const a of db.allocations.filter((x) => x.contentId === id)) logAudit(actor, "deallocate", "drive", a.driveId, `${id} ${fmtSize(a.sizeGB)} (project deleted)`);
  db.allocations = db.allocations.filter((a) => a.contentId !== id);
  archiveDocsFor(actor, id);
  releaseReservedFor(actor, id);
  for (const cs of db.callSheets.filter((c) => c.contentId === id)) logAudit(actor, "delete", "callsheet", cs.id, "project deleted");
  db.callSheets = db.callSheets.filter((c) => c.contentId !== id);
  r.archived = true;
  r.version += 1;
  recordSnapshot();
  logAudit(actor, "archive", "record", id, r.title);
  commit();
}

// ── Rollups (computed on demand, never stored) ───────────────

export interface Rollup {
  total: number;
  complete: number;
  overdue: number;
  atRisk: number;
  byStage: Record<string, number>;
}

export function getRollupStatus(parentId: string): Rollup {
  const root = getRecord(parentId);
  const out: Rollup = { total: 0, complete: 0, overdue: 0, atRisk: 0, byStage: {} };
  if (!root) return out;
  for (const leaf of leavesUnder(root)) {
    out.total++;
    if (isComplete(leaf)) out.complete++;
    const risk = riskOf(leaf);
    if (risk === "overdue") out.overdue++;
    if (risk === "at-risk") out.atRisk++;
    const st = leaf.pipelineStage ?? "None";
    out.byStage[st] = (out.byStage[st] ?? 0) + 1;
  }
  return out;
}

export const getBreadcrumb = (id: string): ContentRecord[] => {
  const r = getRecord(id);
  return r ? selfAndAncestors(r).reverse() : [];
};

// ── Reminders, blocked-on-you ────────────────────────────────

export interface Reminder {
  record: ContentRecord;
  stage: string;
  dueDate: string;
  hoursLeft: number;
}

/** The logged-in person's own unfinished stages with a deadline inside the reminder window (or already past). */
export function getReminders(actor: Actor): Reminder[] {
  const windowHours = getDb().settings.stageReminderHours;
  return visibleRecords(actor)
    .filter((r) => usesPipeline(r) && isOwnerNow(r, actor.personId) && !isComplete(r))
    .map((r) => ({ record: r, stage: r.pipelineStage!, dueDate: currentStageDeadline(r), outputDone: r.stageOutputs[r.pipelineStage!] }))
    .filter((x): x is { record: ContentRecord; stage: string; dueDate: string; outputDone: boolean } => !!x.dueDate && !x.outputDone)
    .map((x) => ({ record: x.record, stage: x.stage, dueDate: x.dueDate, hoursLeft: hoursUntilEndOfDay(x.dueDate) }))
    .filter((x) => x.hoursLeft <= windowHours)
    .sort((a, b) => a.hoursLeft - b.hoursLeft);
}

/** Everything currently waiting on this specific person. */
export function getBlockedOnUser(actor: Actor): ContentRecord[] {
  return visibleRecords(actor)
    .filter((r) => usesPipeline(r) && isOwnerNow(r, actor.personId) && !isComplete(r))
    .sort((a, b) => (currentStageDeadline(a) ?? "9999").localeCompare(currentStageDeadline(b) ?? "9999"));
}

// ── Comments (additive only) ─────────────────────────────────

export function getComments(contentId: string, callSheetId: string | null = null): Comment[] {
  return getDb()
    .comments.filter((c) => c.contentId === contentId && c.callSheetId === callSheetId)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function addComment(actor: Actor, contentId: string, text: string, callSheetId: string | null = null): Comment {
  const r = getRecord(contentId);
  if (!r || !canView(actor, r)) throw new RuleError("Record not found.");
  if (!canComment(actor, r)) throw new RuleError("You can view this project but not comment on it.");
  if (!text.trim()) throw new RuleError("Write a comment first.");
  const c: Comment = {
    id: `C-${pad(nextCounter("comment"))}`,
    contentId,
    callSheetId,
    byPersonId: actor.personId,
    text: text.trim(),
    at: new Date().toISOString(),
  };
  getDb().comments.push(c);
  logAudit(actor, "comment", "record", contentId, text.slice(0, 60));
  commit();
  return c;
}
