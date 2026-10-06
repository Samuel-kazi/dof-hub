import type {
  Actor,
  CallSheet,
  ContentRecord,
  EventPlan,
  ProductionInfo,
  ProductionLevel,
  ProductionMode,
  RecurrenceRule,
  SheetContent,
  ShowTemplate,
} from "../types";
import { RuleError } from "../types";
import { categoryOf } from "../config/categories";
import { DEFAULT_TECH_CHECK, EVENT_PLAN_FIELDS, MODE_LABEL, blankEventPlan, blankSheetContent } from "../config/callSheet";
import { commit, getDb, nextCounter } from "../data/store";
import { claimId, localId } from "../data/ids";
import { canWrite, getRecord, isHop } from "./access";
import { logAudit } from "./audit";
import { createCallSheet } from "./callsheets";
import { MAX_DAYS_OF_SHOW, createRecord, isComplete, makeDay, showDates } from "./content";
import { bookWhatIsFree, hasGearAccess, manifestForSheet, releaseManifest, removeLine } from "./equipment";
import { anchorDeadlines, attachCrew } from "./instances";
import { can } from "./permissions";
import { checkRule, occurrencesBetween, weekdayOf } from "./recurrence";
import { applyContent, checkContent, cloneContent, tidyContent } from "./sheetContent";
import { noteChanges, trackedOf } from "./sheetTracking";
import { addDaysIso, fmtDate, isIsoDate, pad, todayIso } from "./utils";

// One production system for live shows, with three ways of making its days. Every day (an instance) is a record of
// its own, with its own pipeline and exactly one call sheet:
// - a recurring show makes a day for each date of its schedule, from its Show Template, up to some weeks ahead, and
//   tops up once a day. A day follows later template changes until someone changes its call sheet by hand.
// - a one-time event has exactly one day.
// - a multi-day event has an Event Plan, and a day for each date, each with its own call sheet.
// The same call sheet, the same copying (src/services/sheetContent.ts) and the same day records serve all three.

/** How far ahead a recurring show's days are made, unless its template says otherwise. */
export const DEFAULT_HORIZON_WEEKS = 12;
export const MAX_HORIZON_WEEKS = 26;
/** A day's gear is booked automatically once the day is this close; before that it waits on the sheet as a list. */
export const GEAR_WINDOW_DAYS = 14;
/** The pipeline board shows a recurring show's days from a week ago to two weeks ahead (and older ones not finished). */
export const BOARD_PAST_DAYS = 7;
export const BOARD_AHEAD_DAYS = 14;
const MAX_NEW_PER_RUN = 60;
const OFF_SCHEDULE = "No longer on the show's schedule";
const SYSTEM: Actor = { personId: "system", role: "HOP" };
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Reading ──────────────────────────────────────────────────

export const isShow = (r: ContentRecord | undefined): r is ContentRecord => !!r && r.category === "live" && r.hierarchyLevel === 0;

/** A show's days, in date order (days with no date last). */
export const daysOfShow = (showId: string, withArchived = false): ContentRecord[] =>
  getDb()
    .records.filter((r) => r.parentId === showId && r.hierarchyLevel === 1 && (withArchived || !r.archived))
    .sort((a, b) => (a.scheduledDate ?? "9999").localeCompare(b.scheduledDate ?? "9999") || a.contentId.localeCompare(b.contentId));

/** How a show makes its days. A show from before data version 19 is read from its days: one is a one-time event. */
export function productionOf(show: ContentRecord): ProductionInfo | null {
  if (!isShow(show)) return null;
  if (show.production) return show.production;
  return { mode: daysOfShow(show.contentId).length === 1 ? "one_time" : "multi_day", templateId: null, eventPlan: null };
}

export const modeLabel = (mode: ProductionMode): string => MODE_LABEL[mode];
export const getTemplate = (id: string): ShowTemplate | undefined => (getDb().showTemplates ?? []).find((t) => t.id === id);
export const templateOfShow = (showId: string): ShowTemplate | undefined =>
  (getDb().showTemplates ?? []).find((t) => t.contentId === showId);

/** A day's call sheet: the one made for it, or for a day from before data version 19, the show's sheet on its date. */
export function sheetOfDay(day: ContentRecord): CallSheet | undefined {
  const sheets = getDb().callSheets;
  return (
    sheets.find((c) => c.instanceId === day.contentId) ??
    (day.scheduledDate
      ? sheets.find((c) => c.contentId === day.parentId && c.instanceId === null && c.date === day.scheduledDate)
      : undefined)
  );
}

/** Whether a day still follows its show's template (made from it, and not changed by hand since). */
export const followsTemplate = (day: ContentRecord): boolean => !!day.instance && !day.instance.locked;

/** Whether a day was made from the schedule but the schedule no longer gives its date. */
export function offSchedule(day: ContentRecord, today = todayIso()): boolean {
  if (!day.instance || !day.scheduledDate || day.scheduledDate < today) return false;
  const t = getTemplate(day.instance.templateId);
  if (!t) return false;
  const to = addDaysIso(today, t.horizonWeeks * 7);
  return (
    day.instance.occurrence >= today &&
    day.instance.occurrence <= to &&
    !occurrencesBetween(t.rule, today, to).includes(day.instance.occurrence)
  );
}

/**
 * Whether a day of a show shows on the pipeline board. A recurring show would fill it with months of days, so its
 * days show from a week ago to two weeks ahead, and any older one not finished yet. Other days always show.
 */
export function onBoard(r: ContentRecord, today = todayIso()): boolean {
  if (!r.instance || !r.scheduledDate) return true;
  if (r.scheduledDate > addDaysIso(today, BOARD_AHEAD_DAYS)) return false;
  if (r.scheduledDate < addDaysIso(today, -BOARD_PAST_DAYS)) return !isComplete(r);
  return true;
}

/** What a day of a recurring show is called: its date, "Fri Oct 9, 2026". */
export const instanceTitle = (date: string): string => `${WEEKDAY_SHORT[weekdayOf(date)]} ${fmtDate(date)}`;

// ── Who may change how a show's days are made ────────────────

/** The Head of Production, someone who manages the pipeline, or the show's responsible person. */
export const canPlanShow = (actor: Actor, show: ContentRecord): boolean =>
  canWrite(actor, show) && (isHop(actor) || can(actor, "pipeline.manage") || show.assigneePersonId === actor.personId);

function showForPlan(actor: Actor, showId: string): ContentRecord {
  const show = getRecord(showId);
  if (!isShow(show)) throw new RuleError("That show no longer exists.");
  if (show.archived) throw new RuleError("This show is closed.");
  if (!canPlanShow(actor, show))
    throw new RuleError(
      "Only the Head of Production, someone who manages the pipeline, or the show's responsible person can change how its days are made.",
    );
  return show;
}

// ── Making days and their call sheets ────────────────────────

/** A day's call sheet, made from the given content (a template's, the day before's, or a new one). */
function makeSheet(actor: Actor, show: ContentRecord, day: ContentRecord, content: SheetContent): CallSheet {
  const cs = createCallSheet(actor, { contentId: show.contentId, date: day.scheduledDate!, title: `${show.title}: ${day.title}` });
  applyContent(cs, content);
  cs.instanceId = day.contentId;
  return cs;
}

/**
 * Books a day's gear still to book, if the day is within two weeks and the person (or the daily check) may book gear:
 * whatever is free that day. Anything already booked or lent out stays on the sheet's list, to be booked by hand.
 */
function bookIfDue(actor: Actor, cs: CallSheet, today: string): number {
  if (!cs.plannedGear.length || cs.status === "final" || !hasGearAccess(actor)) return 0;
  if (cs.date < today || cs.date > addDaysIso(today, GEAR_WINDOW_DAYS)) return 0;
  const r = bookWhatIsFree(actor, { id: cs.id, contentId: cs.contentId, date: cs.date }, cs.plannedGear);
  cs.plannedGear = r.skipped.map((x) => x.line);
  if (r.booked.length) cs.version += 1;
  return r.booked.length;
}

/** What a new show's call sheets start with: its call time and place, and the usual technical check. */
function startingContent(callTime: string, location: string): SheetContent {
  const c = blankSheetContent();
  c.callTime = callTime || "08:00";
  c.location = location.trim();
  c.technicalCheck = DEFAULT_TECH_CHECK.map((label) => ({ id: localId("TC"), label, done: false, note: "" }));
  return c;
}

/** One day of a recurring show, from its template. */
function makeInstance(actor: Actor, show: ContentRecord, t: ShowTemplate, date: string, today: string): ContentRecord {
  const day = makeDay(actor, show, date, instanceTitle(date), { productionLevel: t.productionLevel, assigneePersonId: t.ownerPersonId });
  day.instance = { templateId: t.id, occurrence: date, templateVersion: t.version, locked: false, lockedAt: null, lockedBy: null };
  anchorDeadlines(day, date);
  const cs = makeSheet(actor, show, day, cloneContent(t.sheet));
  bookIfDue(actor, cs, today);
  return day;
}

/** A day nothing has been done on yet: still at its first stage, nothing ticked or linked, its sheet a draft with no gear out. */
function untouched(day: ContentRecord): boolean {
  if (day.tasks.some((t) => t.done) || day.links.length) return false;
  if (day.pipelineStage !== categoryOf(day.category).stages[0].name || Object.values(day.stageOutputs).some(Boolean)) return false;
  const cs = sheetOfDay(day);
  if (!cs) return true;
  if (cs.status === "final" || getDb().comments.some((c) => c.callSheetId === cs.id)) return false;
  const m = manifestForSheet(cs.id);
  return !m || m.status === "assigned";
}

export interface ScheduleResult {
  made: string[];
  restored: string[];
  removed: string[]; // archived: off the schedule, unchanged, nothing done on them
  kept: string[]; // off the schedule but changed by hand or worked on: left for a person to decide
  booked: number;
}

/**
 * Brings a recurring show's days in line with its schedule, up to its horizon: makes the days missing, brings back a
 * day taken off the schedule if its date is back, and archives (never deletes) a coming day the schedule no longer
 * gives, if nothing was done on it and it was not changed by hand. Books the gear of days within two weeks. Safe to
 * run any number of times.
 */
function syncSchedule(actor: Actor, show: ContentRecord, t: ShowTemplate, today: string): ScheduleResult {
  const out: ScheduleResult = { made: [], restored: [], removed: [], kept: [], booked: 0 };
  const to = addDaysIso(today, t.horizonWeeks * 7);
  const wanted = occurrencesBetween(t.rule, today, to);
  const wantedSet = new Set(wanted);
  const mine = daysOfShow(show.contentId, true).filter((d) => d.instance?.templateId === t.id);
  const byDate = new Map<string, ContentRecord>();
  for (const d of mine) if (!byDate.has(d.instance!.occurrence) || !d.archived) byDate.set(d.instance!.occurrence, d);
  for (const date of wanted) {
    if (out.made.length >= MAX_NEW_PER_RUN) break;
    const d = byDate.get(date);
    if (!d) out.made.push(makeInstance(actor, show, t, date, today).contentId);
    else if (d.archived && d.closedReason === OFF_SCHEDULE) {
      d.archived = false;
      d.closedReason = null;
      d.version += 1;
      out.restored.push(d.contentId);
    }
  }
  for (const d of mine) {
    if (d.archived || !d.scheduledDate || d.scheduledDate < today || wantedSet.has(d.instance!.occurrence)) continue;
    if (d.instance!.occurrence > to && d.scheduledDate > to) continue; // beyond the horizon: left until it comes near
    if (d.instance!.locked || !untouched(d)) {
      out.kept.push(d.contentId);
      continue;
    }
    const cs = sheetOfDay(d);
    const m = cs ? manifestForSheet(cs.id) : undefined;
    if (m?.status === "assigned") releaseManifest(actor, m.id);
    d.archived = true;
    d.closedReason = OFF_SCHEDULE;
    d.version += 1;
    out.removed.push(d.contentId);
  }
  for (const d of daysOfShow(show.contentId).filter((x) => x.instance?.templateId === t.id)) {
    const cs = sheetOfDay(d);
    if (cs) out.booked += bookIfDue(actor, cs, today);
  }
  if (out.made.length || out.restored.length || out.removed.length)
    logAudit(
      actor,
      "schedule-sync",
      "record",
      show.contentId,
      [
        out.made.length && `${out.made.length} days made`,
        out.restored.length && `${out.restored.length} brought back`,
        out.removed.length && `${out.removed.length} taken off`,
      ]
        .filter(Boolean)
        .join(", "),
    );
  return out;
}

// ── Creating a production ────────────────────────────────────

export interface ProductionInput {
  title: string;
  mode: ProductionMode;
  date?: string | null; // a one-time event
  startDate?: string | null; // a multi-day event
  endDate?: string | null;
  rule?: RecurrenceRule | null; // a recurring show
  productionLevel?: ProductionLevel | null;
  assigneePersonId?: string | null;
  callTime?: string;
  location?: string;
  notes?: string;
}

/**
 * Makes a live show as a production, in one of three ways. Everything is checked before anything is made. A one-time
 * event gets exactly one day and call sheet; a multi-day event a day and call sheet for each date, and an empty Event
 * Plan; a recurring show its Show Template and a day and call sheet for each date of its schedule, up to 12 weeks
 * ahead.
 */
export function createProduction(actor: Actor, input: ProductionInput): ContentRecord {
  if (!input.title.trim()) throw new RuleError("Give the show a title.");
  checkContent({ callTime: input.callTime ?? "", location: input.location ?? "" });
  let dates: string[] = [];
  if (input.mode === "one_time") {
    if (!input.date || !isIsoDate(input.date)) throw new RuleError("Pick the date of the event.");
    dates = [input.date];
  } else if (input.mode === "multi_day") {
    if (!input.startDate || !input.endDate || !isIsoDate(input.startDate) || !isIsoDate(input.endDate))
      throw new RuleError("Pick the first and last day of the event.");
    if (input.endDate <= input.startDate)
      throw new RuleError("A multi-day event runs for at least two days. For one day, make it a one-time event.");
    dates = showDates(input.startDate, input.endDate);
    if (dates.length > MAX_DAYS_OF_SHOW || dates[dates.length - 1] !== input.endDate)
      throw new RuleError(`An event can run for up to ${MAX_DAYS_OF_SHOW} days. Add a longer one in parts.`);
  } else if (input.mode === "recurring") {
    if (!input.rule) throw new RuleError("Set when the show happens.");
    checkRule(input.rule);
  } else throw new RuleError("Choose a recurring show, a one-time event or a multi-day event.");
  const recurring = input.mode === "recurring";
  const show = createRecord(actor, {
    category: "live",
    title: input.title,
    showStart: recurring ? null : dates[0],
    showEnd: recurring ? null : dates[dates.length - 1],
    productionLevel: input.productionLevel ?? null,
    assigneePersonId: input.assigneePersonId ?? null,
    notes: input.notes ?? "",
    noDays: recurring,
  });
  show.production = { mode: input.mode, templateId: null, eventPlan: input.mode === "multi_day" ? blankEventPlan() : null };
  const content = startingContent(input.callTime ?? "", input.location ?? "");
  const today = todayIso();
  if (recurring) {
    const at = new Date().toISOString();
    const t: ShowTemplate = {
      id: claimId(`DOF-TPL-${pad(nextCounter("showTemplate"))}`),
      contentId: show.contentId,
      rule: structuredClone(input.rule!),
      sheet: content,
      productionLevel: input.productionLevel ?? null,
      ownerPersonId: input.assigneePersonId || null,
      horizonWeeks: DEFAULT_HORIZON_WEEKS,
      version: 1,
      createdAt: at,
      updatedAt: at,
      updatedBy: actor.personId,
    };
    getDb().showTemplates.push(t);
    show.production.templateId = t.id;
    show.showStart = t.rule.startDate;
    show.showEnd = t.rule.until;
    syncSchedule(actor, show, t, today);
  } else
    for (const day of daysOfShow(show.contentId)) {
      anchorDeadlines(day, day.scheduledDate!);
      makeSheet(actor, show, day, cloneContent(content));
    }
  logAudit(actor, "create-production", "record", show.contentId, modeLabel(input.mode));
  commit();
  return show;
}

// ── A recurring show: its schedule and template ──────────────

const requireTemplate = (id: string): ShowTemplate => {
  const t = getTemplate(id);
  if (!t) throw new RuleError("That show's template no longer exists.");
  return t;
};

/** Changes when a recurring show happens. Days the schedule now gives are made; coming days it no longer gives are taken off (see syncSchedule). */
export function setShowSchedule(actor: Actor, templateId: string, rule: RecurrenceRule): ScheduleResult {
  const t = requireTemplate(templateId);
  const show = showForPlan(actor, t.contentId);
  checkRule(rule);
  t.rule = structuredClone(rule);
  t.updatedAt = new Date().toISOString();
  t.updatedBy = actor.personId;
  show.showStart = rule.startDate;
  show.showEnd = rule.until;
  show.version += 1;
  const r = syncSchedule(actor, show, t, todayIso());
  logAudit(actor, "schedule", "record", show.contentId, "schedule changed");
  commit();
  return r;
}

export interface TemplatePatch {
  sheet?: Partial<SheetContent>;
  productionLevel?: ProductionLevel | null;
  ownerPersonId?: string | null;
  horizonWeeks?: number;
}

export interface TemplateResult {
  updated: string[]; // days that took the change
  kept: string[]; // coming days left as they are: changed by hand, or their call sheet is final
}

/**
 * Applies a template to one day still following it: its call sheet takes the template's content (keeping what was
 * ticked on the day), and gear the template no longer has is released. The day's level of production follows too.
 */
function applyTemplateTo(actor: Actor, t: ShowTemplate, day: ContentRecord, cs: CallSheet, today: string): void {
  const was = trackedOf(cs);
  const before = new Map(cs.technicalCheck.map((x) => [x.label, x]));
  const next = cloneContent(t.sheet);
  next.technicalCheck = next.technicalCheck.map((x) => {
    const old = before.get(x.label);
    return old ? { ...x, done: old.done, note: old.note } : x;
  });
  next.rehearsal.done = cs.rehearsal.done;
  const m = manifestForSheet(cs.id);
  if (m && m.status === "assigned" && hasGearAccess(actor)) {
    for (const l of [...m.lines])
      if (!t.sheet.plannedGear.some((g) => g.equipmentId === l.equipmentId)) removeLine(actor, m.id, l.equipmentId);
    const still = manifestForSheet(cs.id);
    next.plannedGear = next.plannedGear.filter((g) => !still?.lines.some((l) => l.equipmentId === g.equipmentId));
  } else if (m) next.plannedGear = next.plannedGear.filter((g) => !m.lines.some((l) => l.equipmentId === g.equipmentId));
  applyContent(cs, next);
  cs.version += 1;
  noteChanges(actor, cs, was);
  day.productionLevel = t.productionLevel;
  day.instance!.templateVersion = t.version;
  day.version += 1;
  bookIfDue(actor, cs, today);
}

/**
 * Changes a recurring show's template: its standard call sheet (crew, talent, location, gear, run of show, checks and
 * the rest), the level of production and responsible person of its days, or how far ahead days are made. Every
 * coming day still following the template takes the change; a day changed by hand, or whose sheet is final, keeps
 * its own.
 */
export function updateShowTemplate(actor: Actor, templateId: string, patch: TemplatePatch): TemplateResult {
  const t = requireTemplate(templateId);
  const show = showForPlan(actor, t.contentId);
  if (patch.sheet) {
    const c = tidyContent(patch.sheet, t.sheet);
    checkContent(c, c.crewPersonIds ?? t.sheet.crewPersonIds);
    if (c.crewPersonIds) attachCrew(actor, show.contentId, c.crewPersonIds);
    Object.assign(t.sheet, c);
  }
  if (patch.productionLevel !== undefined) {
    if (patch.productionLevel !== null && !["small", "medium", "large"].includes(patch.productionLevel))
      throw new RuleError("Choose small, medium or large.");
    t.productionLevel = patch.productionLevel;
  }
  if (patch.ownerPersonId !== undefined) {
    const p = patch.ownerPersonId ? getDb().people.find((x) => x.personId === patch.ownerPersonId) : null;
    if (patch.ownerPersonId && (!p || p.status !== "active" || (p.category !== "CRW" && p.category !== "HOP")))
      throw new RuleError("Choose someone from the crew to be responsible for each day.");
    t.ownerPersonId = patch.ownerPersonId || null;
  }
  if (patch.horizonWeeks !== undefined) {
    if (!Number.isInteger(patch.horizonWeeks) || patch.horizonWeeks < 1 || patch.horizonWeeks > MAX_HORIZON_WEEKS)
      throw new RuleError(`Make days from 1 to ${MAX_HORIZON_WEEKS} weeks ahead.`);
    t.horizonWeeks = patch.horizonWeeks;
  }
  t.version += 1;
  t.updatedAt = new Date().toISOString();
  t.updatedBy = actor.personId;
  const today = todayIso();
  const out: TemplateResult = { updated: [], kept: [] };
  for (const day of daysOfShow(show.contentId).filter((d) => d.instance?.templateId === t.id && (d.scheduledDate ?? "") >= today)) {
    const cs = sheetOfDay(day);
    if (!cs || day.instance!.locked || cs.status === "final") {
      out.kept.push(day.contentId);
      continue;
    }
    applyTemplateTo(actor, t, day, cs, today);
    out.updated.push(day.contentId);
  }
  if (patch.horizonWeeks !== undefined) syncSchedule(actor, show, t, today);
  logAudit(
    actor,
    "template",
    "record",
    show.contentId,
    `${Object.keys(patch).join(", ")}: ${out.updated.length} days follow, ${out.kept.length} kept`,
  );
  commit();
  return out;
}

/**
 * Puts a day changed by hand back on its show's template: its call sheet takes the template's content again (its
 * date stays), gear the template does not have is released, and later template changes reach it again.
 */
export function resetToTemplate(actor: Actor, dayId: string): ContentRecord {
  const day = getRecord(dayId);
  if (!day?.instance) throw new RuleError("This day was not made from a show's template.");
  const show = getRecord(day.parentId ?? "");
  if (!show || !canWrite(actor, show) || day.archived) throw new RuleError("You have view-only access to this show.");
  const t = requireTemplate(day.instance.templateId);
  const cs = sheetOfDay(day);
  if (!cs) throw new RuleError("This day has no call sheet.");
  if (cs.status === "final") throw new RuleError("This call sheet is final. Reopen it to put it back on the template.");
  const today = todayIso();
  if ((day.scheduledDate ?? "") < today) throw new RuleError("A day that has passed is kept as it was.");
  day.instance.locked = false;
  day.instance.lockedAt = null;
  day.instance.lockedBy = null;
  applyTemplateTo(actor, t, day, cs, today);
  logAudit(actor, "reset-to-template", "record", day.contentId, `from ${t.id}`);
  commit();
  return day;
}

/** Makes the days a recurring show is missing now, and books gear that has come within two weeks. */
export function topUpShow(actor: Actor, showId: string): ScheduleResult {
  const show = getRecord(showId);
  if (!isShow(show) || show.archived) throw new RuleError("That show no longer exists.");
  if (!canWrite(actor, show)) throw new RuleError("You have view-only access to this show.");
  const t = show.production?.templateId ? getTemplate(show.production.templateId) : undefined;
  if (!t) throw new RuleError("This show does not repeat.");
  const r = syncSchedule(actor, show, t, todayIso());
  commit();
  return r;
}

/** Whether any recurring show is missing days, or has gear to book that has come within two weeks. */
export function recurringDue(today = todayIso()): boolean {
  for (const t of getDb().showTemplates ?? []) {
    const show = getRecord(t.contentId);
    if (!isShow(show) || show.archived) continue;
    const have = new Set(
      daysOfShow(show.contentId, true)
        .filter((d) => d.instance?.templateId === t.id)
        .map((d) => d.instance!.occurrence),
    );
    if (occurrencesBetween(t.rule, today, addDaysIso(today, t.horizonWeeks * 7)).some((d) => !have.has(d))) return true;
    for (const d of daysOfShow(show.contentId)) {
      const cs = d.instance ? sheetOfDay(d) : undefined;
      if (cs?.plannedGear.length && cs.status === "draft" && cs.date >= today && cs.date <= addDaysIso(today, GEAR_WINDOW_DAYS))
        return true;
    }
  }
  return false;
}

/**
 * The daily check for recurring shows: makes each show's coming days up to its horizon, and books the gear of days
 * that have come within two weeks. Run by the server's daily check and by the desktop app and local demo. The
 * caller saves.
 */
export function topUpRecurring(today = todayIso()): { made: number; booked: number } {
  const out = { made: 0, booked: 0 };
  for (const t of [...(getDb().showTemplates ?? [])]) {
    const show = getRecord(t.contentId);
    if (!isShow(show) || show.archived) continue;
    const r = syncSchedule(SYSTEM, show, t, today);
    out.made += r.made.length + r.restored.length;
    out.booked += r.booked;
  }
  return out;
}

// ── A multi-day event: its plan and days ─────────────────────

function eventForPlan(actor: Actor, showId: string): ContentRecord {
  const show = showForPlan(actor, showId);
  if (productionOf(show)?.mode !== "multi_day") throw new RuleError("Only a multi-day event has an Event Plan and days to add.");
  return show;
}

/** Changes the Event Plan of a multi-day event: what it is, who for, where, travel, accommodation, budget and notes. */
export function updateEventPlan(actor: Actor, showId: string, patch: Partial<EventPlan>): EventPlan {
  const show = eventForPlan(actor, showId);
  const plan = { ...blankEventPlan(), ...(show.production?.eventPlan ?? {}) };
  for (const f of EVENT_PLAN_FIELDS) {
    const v = patch[f.key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > 4000) throw new RuleError(`Keep the ${f.label.toLowerCase()} under 4,000 characters.`);
    plan[f.key] = v;
  }
  show.production = { ...(show.production ?? productionOf(show)!), eventPlan: plan };
  show.version += 1;
  logAudit(actor, "event-plan", "record", showId, Object.keys(patch).join(", "));
  commit();
  return plan;
}

/**
 * Adds a day to a multi-day event. Its call sheet starts as a copy of the nearest day before it (or the first day),
 * with that day's gear where it is free; the days are numbered again in date order.
 */
export function addEventDay(actor: Actor, showId: string, date: string): ContentRecord {
  const show = eventForPlan(actor, showId);
  if (!isIsoDate(date)) throw new RuleError("Pick the day's date.");
  const days = daysOfShow(showId);
  if (days.some((d) => d.scheduledDate === date)) throw new RuleError("The event already has a day on that date.");
  if (days.length >= MAX_DAYS_OF_SHOW)
    throw new RuleError(`An event can run for up to ${MAX_DAYS_OF_SHOW} days. Add a longer one in parts.`);
  const dated = days.filter((d) => d.scheduledDate);
  const from = [...dated].reverse().find((d) => d.scheduledDate! < date) ?? dated[0];
  const day = makeDay(actor, show, date, `Day ${days.length + 1}`, {
    productionLevel: from?.productionLevel ?? show.productionLevel,
    assigneePersonId: from?.assigneePersonId ?? show.assigneePersonId,
  });
  anchorDeadlines(day, date);
  const fromSheet = from ? sheetOfDay(from) : undefined;
  const cs = makeSheet(
    actor,
    show,
    day,
    fromSheet ? cloneContent(fromSheet) : startingContent("", show.production?.eventPlan?.venue ?? ""),
  );
  const gear = fromSheet ? manifestForSheet(fromSheet.id) : undefined;
  if (gear && hasGearAccess(actor)) {
    const r = bookWhatIsFree(
      actor,
      { id: cs.id, contentId: cs.contentId, date },
      gear.lines.map((l) => ({ equipmentId: l.equipmentId, quantity: l.quantity })),
    );
    cs.plannedGear = [...cs.plannedGear, ...r.skipped.map((x) => x.line)];
  }
  // Days named "Day N" are numbered again in date order; a day someone renamed keeps its name.
  daysOfShow(showId).forEach((d, i) => {
    if (/^Day \d+$/.test(d.title) && d.title !== `Day ${i + 1}`) {
      d.title = `Day ${i + 1}`;
      d.version += 1;
    }
  });
  const all = daysOfShow(showId)
    .map((d) => d.scheduledDate)
    .filter((x): x is string => !!x);
  show.showStart = all[0] ?? null;
  show.showEnd = all[all.length - 1] ?? null;
  show.version += 1;
  logAudit(actor, "event-day", "record", showId, `${day.contentId} on ${date}`);
  commit();
  return day;
}
