import type {
  Actor,
  CallSheet,
  ContentRecord,
  EventPlan,
  ProductionInfo,
  ProductionLevel,
  ProductionMode,
  RecordingSession,
  RecurrenceRule,
  SheetContent,
  ShowTemplate,
} from "../types";
import { RuleError } from "../types";
import {
  LIVE_TECH_CHECK,
  REHEARSAL_STEPS,
  blankStep,
  EVENT_PLAN_FIELDS,
  MODE_LABEL,
  SHEET_CONTENT_KEYS,
  blankEventPlan,
  blankSheetContent,
} from "../config/callSheet";
import { commit, getDb, nextCounter } from "../data/store";
import { claimId, localId } from "../data/ids";
import { canWrite, getRecord, isHop, rootOf } from "./access";
import { logAudit } from "./audit";
import { createCallSheet } from "./callsheets";
import { MAX_DAYS_OF_SHOW, showDates } from "./content";
import { bookWhatIsFree, hasGearAccess, manifestForSheet, releaseManifest, removeLine } from "./equipment";
import { attachCrew } from "./instances";
import { can } from "./permissions";
import { checkRule, occurrencesBetween, weekdayOf } from "./recurrence";
import { applyContent, checkContent, cloneContent, tidyContent } from "./sheetContent";
import { noteChanges, trackedOf } from "./sheetTracking";
import { assertSheetOpen } from "./sheetLock";
import { addDaysIso, fmtDate, isIsoDate, pad, todayIso } from "./utils";
import { ensureChecklist, nowStamp, rowsOf } from "./workflow/common";
import { nextSession } from "./workflow/ids";
import { createWorkflowProject } from "./workflow/projects";

// How a live event makes its days (data version 23). A live show holds its events, as a series holds its seasons; an
// event is a project of the five-stage workflow, and each of its days is one of its recording sessions, with exactly
// one call sheet and its own run of show:
// - a recurring show makes a day for each date of its schedule, from its Show Template, up to its next 8 dates, and
//   tops up once a day. A day follows later template changes until someone changes its call sheet by hand.
// - a one-time event has exactly one day.
// - a multi-day event has an Event Plan, and a day for each date, each with its own call sheet.
// The same call sheet, the same copying (src/services/sheetContent.ts) and the same sessions serve all three. From
// there an event goes on as any project does: a day is opened for the show and closed with its show log, and what was
// recorded goes on as recordings, through post production and release.

/** How far ahead a recurring show's days are made, unless its template says otherwise. */
export const DEFAULT_HORIZON_WEEKS = 12;
export const MAX_HORIZON_WEEKS = 26;
/** A day's gear is booked automatically once the day is this close; before that it waits on the sheet as a list. */
export const GEAR_WINDOW_DAYS = 14;
/** A recurring show's days show on their own from a week ago to two weeks ahead (and older ones not finished). */
export const BOARD_PAST_DAYS = 7;
export const BOARD_AHEAD_DAYS = 14;
const MAX_NEW_PER_RUN = 60;
const OFF_SCHEDULE = "No longer on the show's schedule";
const SYSTEM: Actor = { personId: "system", role: "HOP" };
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Reading ──────────────────────────────────────────────────

/** A live event: the project of the five-stage workflow under a live show. */
export const isLiveEvent = (r: ContentRecord | undefined): r is ContentRecord => !!r && r.category === "live" && !!r.workflow;

/** An event's days, in date order (days with no date last). */
export const daysOfEvent = (eventId: string, withArchived = false): RecordingSession[] =>
  getDb()
    .recordingSessions.filter((s) => s.contentId === eventId && (withArchived || !s.archivedAt))
    .sort((a, b) => (a.scheduledDate ?? "9999").localeCompare(b.scheduledDate ?? "9999") || a.id.localeCompare(b.id));

/** How an event makes its days. One with no record of it is read from its days: one day is a one-time event. */
export function productionOf(event: ContentRecord): ProductionInfo | null {
  if (!isLiveEvent(event)) return null;
  if (event.production) return event.production;
  return { mode: daysOfEvent(event.contentId).length > 1 ? "multi_day" : "one_time", templateId: null, eventPlan: null };
}

export const modeLabel = (mode: ProductionMode): string => MODE_LABEL[mode];
export const getTemplate = (id: string): ShowTemplate | undefined => (getDb().showTemplates ?? []).find((t) => t.id === id);
export const templateOfEvent = (eventId: string): ShowTemplate | undefined =>
  (getDb().showTemplates ?? []).find((t) => t.contentId === eventId);

/** A day's call sheet. */
export function sheetOfDay(day: RecordingSession): CallSheet | undefined {
  const sheets = getDb().callSheets;
  return (day.callSheetId ? sheets.find((c) => c.id === day.callSheetId) : undefined) ?? sheets.find((c) => c.instanceId === day.id);
}

/** What a day is called on screen: its name ("Day 2", "Fri Oct 9, 2026"), with its label if it has one. */
export function dayTitle(day: RecordingSession): string {
  const name = day.name?.trim() || `Day ${day.sessionNumber}`;
  const label = day.instance?.label ?? day.label;
  return label ? `${name}, ${label}` : name;
}

/** How many coming dates a new recurring show makes days for (build prompt v2: the next 8). */
export const DEFAULT_HORIZON_COUNT = 8;
export const MAX_HORIZON_COUNT = 52;

/**
 * The last date a recurring show's days are made up to: the date of its next `horizonCount` dates from today, or
 * with no count (shows made before the count) so many weeks ahead.
 */
export function horizonEnd(t: ShowTemplate, today: string): string {
  if (!t.horizonCount) return addDaysIso(today, t.horizonWeeks * 7);
  const coming = occurrencesBetween(t.rule, today, addDaysIso(today, 3 * 366));
  return coming[Math.min(t.horizonCount, coming.length) - 1] ?? today;
}

/** Whether a day still follows its show's template (made from it, and not changed by hand since). */
export const followsTemplate = (day: RecordingSession): boolean => !!day.instance && !day.instance.locked;

/** Whether a day was made from the schedule but the schedule no longer gives its date. */
export function offSchedule(day: RecordingSession, today = todayIso()): boolean {
  if (!day.instance || !day.scheduledDate || day.scheduledDate < today) return false;
  const t = getTemplate(day.instance.templateId);
  if (!t) return false;
  const to = horizonEnd(t, today);
  return (
    day.instance.occurrence >= today &&
    day.instance.occurrence <= to &&
    !occurrencesBetween(t.rule, today, to).includes(day.instance.occurrence)
  );
}

/**
 * Whether a day of an event shows on its own (on the board and the dashboard's horizon). A recurring show would fill
 * them with months of days, so its days show from a week ago to two weeks ahead, and any older one not finished yet.
 * Other days always show.
 */
export function onBoard(day: RecordingSession, today = todayIso()): boolean {
  if (!day.instance || !day.scheduledDate) return true;
  if (day.scheduledDate > addDaysIso(today, BOARD_AHEAD_DAYS)) return false;
  if (day.scheduledDate < addDaysIso(today, -BOARD_PAST_DAYS)) return day.status !== "Closed";
  return true;
}

/** What a day of a recurring show is called: its date, "Fri Oct 9, 2026". */
export const instanceTitle = (date: string): string => `${WEEKDAY_SHORT[weekdayOf(date)]} ${fmtDate(date)}`;

// ── Who may change how an event's days are made ──────────────

/** The Head of Production, someone who manages the pipeline, or the event's show producer. */
export const canPlanEvent = (actor: Actor, event: ContentRecord): boolean =>
  canWrite(actor, event) &&
  (isHop(actor) || can(actor, "pipeline.manage") || (!!event.workflow && event.workflow.showProducerId === actor.personId));

function eventForPlan(actor: Actor, eventId: string): ContentRecord {
  const event = getRecord(eventId);
  if (!isLiveEvent(event)) throw new RuleError("That event no longer exists.");
  if (event.archived) throw new RuleError("This event is closed.");
  if (!canPlanEvent(actor, event))
    throw new RuleError(
      "Only the Head of Production, someone who manages the pipeline, or the event's show producer can change how its days are made.",
    );
  return event;
}

/** A day, and its event if the person may plan it. */
function dayForPlan(actor: Actor, dayId: string): { day: RecordingSession; event: ContentRecord } {
  const day = getDb().recordingSessions.find((s) => s.id === dayId);
  if (!day) throw new RuleError("That day no longer exists.");
  return { day, event: eventForPlan(actor, day.contentId) };
}

// ── Making days and their call sheets ────────────────────────

/** A new day of an event: one of its recording sessions, at Pre-production, with its checklist. The caller saves. */
function makeDay(
  event: ContentRecord,
  date: string,
  name: string,
  extra: { instance?: RecordingSession["instance"]; productionLevel?: ProductionLevel | null } = {},
): RecordingSession {
  const { id, n } = nextSession(event.contentId);
  const at = nowStamp();
  const s: RecordingSession = {
    id,
    contentId: event.contentId,
    sessionNumber: n,
    scheduledDate: date,
    venue: "",
    status: "Planned",
    closedAt: null,
    callSheetId: null,
    runSheet: [], // a live day's running order is its call sheet's run of show
    dailyLog: "",
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    archivedReason: null,
    name,
    label: null,
    startTime: null,
    endTime: null,
    storyboardId: null,
    shotListId: null,
    storageDriveId: null,
    instance: extra.instance ?? null,
    productionLevel: extra.productionLevel ?? null,
  };
  getDb().recordingSessions.push(s);
  ensureChecklist("preSession", "session", id);
  return s;
}

/** A day's call sheet, made from the given content (a template's, the day before's, or a new one). */
function makeSheet(actor: Actor, event: ContentRecord, day: RecordingSession, content: SheetContent): CallSheet {
  const cs = createCallSheet(actor, { contentId: rootOf(event).contentId, date: day.scheduledDate!, title: `${event.title}: ${day.name}` });
  applyContent(cs, content);
  cs.instanceId = day.id;
  day.callSheetId = cs.id;
  day.venue = cs.location;
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

/**
 * What a new event's call sheets start with: its call time and place, the live Tech Check (each line Not checked) and
 * the Rehearsal Log's steps (build prompt v4, section 9).
 */
function startingContent(callTime: string, location: string): SheetContent {
  const c = blankSheetContent();
  c.callTime = callTime || "08:00";
  c.location = location.trim();
  c.technicalCheck = LIVE_TECH_CHECK.map((label) => ({
    id: localId("TC"),
    label,
    done: false,
    note: "",
    state: "Not checked" as const,
    assigneeId: null,
    equipmentId: null,
    result: "",
  }));
  c.rehearsal = { ...c.rehearsal, steps: REHEARSAL_STEPS.map((step) => blankStep(localId("RH"), step)) };
  return c;
}

/** One day of a recurring show, from its template. */
function makeInstance(actor: Actor, event: ContentRecord, t: ShowTemplate, date: string, today: string): RecordingSession {
  const day = makeDay(event, date, instanceTitle(date), {
    instance: { templateId: t.id, occurrence: date, templateVersion: t.version, locked: false, lockedAt: null, lockedBy: null },
    productionLevel: t.productionLevel,
  });
  const cs = makeSheet(actor, event, day, cloneContent(t.sheet));
  bookIfDue(actor, cs, today);
  return day;
}

/** A day nothing has been done on yet: still planned, nothing ticked or logged, its sheet a draft with no gear out. */
function untouched(day: RecordingSession): boolean {
  if (day.status !== "Planned" || rowsOf(day.id).length) return false;
  if (getDb().workflowChecklistItems.some((c) => c.ownerId === day.id && c.done)) return false;
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

/** Keeps a one-time or multi-day event's first and last day on the event itself, for the calendar and the board. */
function spanOfDays(event: ContentRecord): void {
  if (event.production?.mode === "recurring") return; // a recurring show's span is its schedule's
  const all = daysOfEvent(event.contentId)
    .map((d) => d.scheduledDate)
    .filter((x): x is string => !!x)
    .sort();
  event.showStart = all[0] ?? null;
  event.showEnd = all[all.length - 1] ?? null;
}

/**
 * Brings a recurring show's days in line with its schedule, up to its horizon: makes the days missing, brings back a
 * day taken off the schedule if its date is back, and archives (never deletes) a coming day the schedule no longer
 * gives, if nothing was done on it and it was not changed by hand. Books the gear of days within two weeks. Safe to
 * run any number of times.
 */
function syncSchedule(actor: Actor, event: ContentRecord, t: ShowTemplate, today: string): ScheduleResult {
  const out: ScheduleResult = { made: [], restored: [], removed: [], kept: [], booked: 0 };
  const to = horizonEnd(t, today);
  const wanted = occurrencesBetween(t.rule, today, to);
  const wantedSet = new Set(wanted);
  const mine = daysOfEvent(event.contentId, true).filter((d) => d.instance?.templateId === t.id);
  const byDate = new Map<string, RecordingSession>();
  for (const d of mine) if (!byDate.has(d.instance!.occurrence) || !d.archivedAt) byDate.set(d.instance!.occurrence, d);
  for (const date of wanted) {
    if (out.made.length >= MAX_NEW_PER_RUN) break;
    const d = byDate.get(date);
    if (!d) out.made.push(makeInstance(actor, event, t, date, today).id);
    else if (d.archivedAt && d.archivedReason === OFF_SCHEDULE) {
      d.archivedAt = null;
      d.archivedReason = null;
      d.updatedAt = nowStamp();
      out.restored.push(d.id);
    }
  }
  for (const d of mine) {
    if (d.archivedAt || !d.scheduledDate || d.scheduledDate < today || wantedSet.has(d.instance!.occurrence)) continue;
    if (d.instance!.occurrence > to && d.scheduledDate > to) continue; // beyond the horizon: left until it comes near
    if (d.instance!.locked || !untouched(d)) {
      out.kept.push(d.id);
      continue;
    }
    const cs = sheetOfDay(d);
    const m = cs ? manifestForSheet(cs.id) : undefined;
    if (m?.status === "assigned") releaseManifest(actor, m.id);
    d.archivedAt = nowStamp();
    d.archivedReason = OFF_SCHEDULE;
    d.updatedAt = d.archivedAt;
    out.removed.push(d.id);
  }
  for (const d of daysOfEvent(event.contentId).filter((x) => x.instance?.templateId === t.id)) {
    const cs = sheetOfDay(d);
    if (cs) out.booked += bookIfDue(actor, cs, today);
  }
  if (out.made.length || out.restored.length || out.removed.length)
    logAudit(
      actor,
      "schedule-sync",
      "record",
      event.contentId,
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

// ── Setting up an event's days ───────────────────────────────

/** How an event's days are made: given when the event is made. */
export interface EventSetup {
  mode: ProductionMode;
  date?: string | null; // a one-time event
  startDate?: string | null; // a multi-day event
  endDate?: string | null;
  rule?: RecurrenceRule | null; // a recurring show
  productionLevel?: ProductionLevel | null;
  callTime?: string;
  location?: string;
}

/** Checks an event's setup before anything is made, and gives the dates of a one-time or multi-day event. */
export function checkEventSetup(input: EventSetup): string[] {
  checkContent({ callTime: input.callTime ?? "", location: input.location ?? "" });
  if (input.productionLevel && !["small", "medium", "large"].includes(input.productionLevel))
    throw new RuleError("Choose small, medium or large.");
  if (input.mode === "one_time") {
    if (!input.date || !isIsoDate(input.date)) throw new RuleError("Pick the date of the event.");
    return [input.date];
  }
  if (input.mode === "multi_day") {
    if (!input.startDate || !input.endDate || !isIsoDate(input.startDate) || !isIsoDate(input.endDate))
      throw new RuleError("Pick the first and last day of the event.");
    if (input.endDate <= input.startDate)
      throw new RuleError("A multi-day event runs for at least two days. For one day, make it a one-time event.");
    const dates = showDates(input.startDate, input.endDate);
    if (dates.length > MAX_DAYS_OF_SHOW || dates[dates.length - 1] !== input.endDate)
      throw new RuleError(`An event can run for up to ${MAX_DAYS_OF_SHOW} days. Add a longer one in parts.`);
    return dates;
  }
  if (input.mode === "recurring") {
    if (!input.rule) throw new RuleError("Set when the show happens.");
    checkRule(input.rule);
    return [];
  }
  throw new RuleError("Choose a recurring show, a one-time event or a multi-day event.");
}

/**
 * Makes a new event's days, in one of three ways: a one-time event exactly one day and call sheet; a multi-day event a
 * day and call sheet for each date, and an empty Event Plan; a recurring show its Show Template and a day and call
 * sheet for each of its next 8 dates. Called by createWorkflowProject, after checkEventSetup. The caller saves.
 */
export function setUpEventDays(actor: Actor, event: ContentRecord, input: EventSetup): void {
  const dates = checkEventSetup(input);
  event.production = { mode: input.mode, templateId: null, eventPlan: input.mode === "multi_day" ? blankEventPlan() : null };
  event.productionLevel = input.productionLevel ?? null;
  const content = startingContent(input.callTime ?? "", input.location ?? "");
  const today = todayIso();
  if (input.mode === "recurring") {
    const at = nowStamp();
    const t: ShowTemplate = {
      id: claimId(`DOF-TPL-${pad(nextCounter("showTemplate"))}`),
      contentId: event.contentId,
      rule: structuredClone(input.rule!),
      sheet: content,
      productionLevel: input.productionLevel ?? null,
      ownerPersonId: null,
      horizonWeeks: DEFAULT_HORIZON_WEEKS,
      horizonCount: DEFAULT_HORIZON_COUNT,
      version: 1,
      createdAt: at,
      updatedAt: at,
      updatedBy: actor.personId,
    };
    getDb().showTemplates.push(t);
    event.production.templateId = t.id;
    event.showStart = t.rule.startDate;
    event.showEnd = t.rule.until;
    syncSchedule(actor, event, t, today);
  } else
    dates.forEach((date, i) => {
      const day = makeDay(event, date, dates.length === 1 ? "Show day" : `Day ${i + 1}`, {
        productionLevel: input.productionLevel ?? null,
      });
      makeSheet(actor, event, day, cloneContent(content));
    });
  spanOfDays(event);
  logAudit(actor, "create-production", "record", event.contentId, modeLabel(input.mode));
}

// ── Creating a production ────────────────────────────────────

export interface ProductionInput extends EventSetup {
  title: string;
  showId?: string | null; // a new event of an existing live show
  deadline?: string | null;
  notes?: string;
}

/**
 * Makes a live event, as a project in Development, with its days: a new live show with its first event, or a new event
 * of an existing show. Everything is checked before anything is made.
 */
export function createProduction(actor: Actor, input: ProductionInput): ContentRecord {
  const event = createWorkflowProject(actor, {
    category: "live",
    title: input.title,
    seriesId: input.showId ?? null,
    deadline: input.deadline ?? null,
    event: {
      mode: input.mode,
      date: input.date,
      startDate: input.startDate,
      endDate: input.endDate,
      rule: input.rule,
      productionLevel: input.productionLevel,
      callTime: input.callTime,
      location: input.location,
    },
  });
  if (input.notes?.trim()) {
    event.notes = input.notes.trim();
    commit();
  }
  return event;
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
  const event = eventForPlan(actor, t.contentId);
  checkRule(rule);
  t.rule = structuredClone(rule);
  t.updatedAt = nowStamp();
  t.updatedBy = actor.personId;
  event.showStart = rule.startDate;
  event.showEnd = rule.until;
  event.version += 1;
  const r = syncSchedule(actor, event, t, todayIso());
  logAudit(actor, "schedule", "record", event.contentId, "schedule changed");
  commit();
  return r;
}

export interface TemplatePatch {
  sheet?: Partial<SheetContent>;
  productionLevel?: ProductionLevel | null;
  ownerPersonId?: string | null;
  horizonWeeks?: number;
  horizonCount?: number;
  from?: string; // "this and future": only days on or after this date take the change (default: every coming day)
}

export interface TemplateResult {
  updated: string[]; // days that took the change
  kept: string[]; // coming days left as they are: changed by hand, started, or their call sheet is final
}

/**
 * Applies a template to one day still following it: its call sheet takes the template's content (keeping what was
 * ticked on the day), and gear the template no longer has is released. The day's level of production follows too.
 */
function applyTemplateTo(actor: Actor, t: ShowTemplate, day: RecordingSession, cs: CallSheet, today: string): void {
  const was = trackedOf(cs);
  const before = new Map(cs.technicalCheck.map((x) => [x.label, x]));
  const next = cloneContent(t.sheet);
  next.technicalCheck = next.technicalCheck.map((x) => {
    const old = before.get(x.label);
    return old
      ? { ...x, done: old.done, note: old.note, ...(old.state ? { state: old.state } : {}), ...(old.result ? { result: old.result } : {}) }
      : x;
  });
  next.rehearsal.done = cs.rehearsal.done;
  // What was checked at each rehearsal step on the day stays with the day.
  if (next.rehearsal.steps) {
    const was = new Map((cs.rehearsal.steps ?? []).map((x) => [x.step, x]));
    next.rehearsal.steps = next.rehearsal.steps.map((x) => {
      const old = was.get(x.step);
      return old ? { ...x, time: old.time, notes: old.notes, done: old.done, personId: old.personId ?? x.personId } : x;
    });
  }
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
  day.venue = cs.location;
  day.instance!.templateVersion = t.version;
  day.updatedAt = nowStamp();
  bookIfDue(actor, cs, today);
}

/**
 * Changes a recurring show's template: its standard call sheet (crew, talent, location, gear, run of show, checks and
 * the rest), the level of production of its days, or how far ahead days are made. Every coming day still following
 * the template takes the change; a day changed by hand, started, or whose sheet is final, keeps its own.
 */
export function updateShowTemplate(actor: Actor, templateId: string, patch: TemplatePatch): TemplateResult {
  const t = requireTemplate(templateId);
  const event = eventForPlan(actor, t.contentId);
  if (patch.sheet) {
    const c = tidyContent(patch.sheet, t.sheet);
    checkContent(c, c.crewPersonIds ?? t.sheet.crewPersonIds);
    if (c.crewPersonIds) attachCrew(actor, rootOf(event).contentId, c.crewPersonIds);
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
  if (patch.horizonCount !== undefined) {
    if (!Number.isInteger(patch.horizonCount) || patch.horizonCount < 1 || patch.horizonCount > MAX_HORIZON_COUNT)
      throw new RuleError(`Make the next 1 to ${MAX_HORIZON_COUNT} days ahead.`);
    t.horizonCount = patch.horizonCount;
  }
  t.version += 1;
  t.updatedAt = nowStamp();
  t.updatedBy = actor.personId;
  const today = todayIso();
  const out: TemplateResult = { updated: [], kept: [] };
  const from = patch.from && patch.from > today ? patch.from : today;
  for (const day of daysOfEvent(event.contentId).filter((d) => d.instance?.templateId === t.id && (d.scheduledDate ?? "") >= from)) {
    const cs = sheetOfDay(day);
    if (!cs || day.instance!.locked || cs.status === "final" || day.status !== "Planned") {
      out.kept.push(day.id);
      continue;
    }
    applyTemplateTo(actor, t, day, cs, today);
    out.updated.push(day.id);
  }
  if (patch.horizonWeeks !== undefined || patch.horizonCount !== undefined) syncSchedule(actor, event, t, today);
  logAudit(
    actor,
    "template",
    "record",
    event.contentId,
    `${Object.keys(patch).join(", ")}: ${out.updated.length} days follow, ${out.kept.length} kept`,
  );
  commit();
  return out;
}

/**
 * Puts a day changed by hand back on its show's template: its call sheet takes the template's content again (its
 * date stays), gear the template does not have is released, and later template changes reach it again.
 */
export function resetToTemplate(actor: Actor, dayId: string): RecordingSession {
  const day = getDb().recordingSessions.find((s) => s.id === dayId);
  if (!day?.instance) throw new RuleError("This day was not made from a show's template.");
  const event = getRecord(day.contentId);
  if (!event || !canWrite(actor, event) || day.archivedAt) throw new RuleError("You have view-only access to this event.");
  const t = requireTemplate(day.instance.templateId);
  const cs = sheetOfDay(day);
  if (!cs) throw new RuleError("This day has no call sheet.");
  assertSheetOpen(cs);
  const today = todayIso();
  if ((day.scheduledDate ?? "") < today) throw new RuleError("A day that has passed is kept as it was.");
  day.instance.locked = false;
  day.instance.lockedAt = null;
  day.instance.lockedBy = null;
  applyTemplateTo(actor, t, day, cs, today);
  logAudit(actor, "reset-to-template", "session", day.id, `from ${t.id}`);
  commit();
  return day;
}

/** Makes the days a recurring show is missing now, and books gear that has come within two weeks. */
export function topUpShow(actor: Actor, eventId: string): ScheduleResult {
  const event = getRecord(eventId);
  if (!isLiveEvent(event) || event.archived) throw new RuleError("That event no longer exists.");
  if (!canWrite(actor, event)) throw new RuleError("You have view-only access to this event.");
  const t = event.production?.templateId ? getTemplate(event.production.templateId) : undefined;
  if (!t) throw new RuleError("This event does not repeat.");
  const r = syncSchedule(actor, event, t, todayIso());
  commit();
  return r;
}

/** Whether any recurring show is missing days, or has gear to book that has come within two weeks. */
export function recurringDue(today = todayIso()): boolean {
  for (const t of getDb().showTemplates ?? []) {
    const event = getRecord(t.contentId);
    if (!isLiveEvent(event) || event.archived) continue;
    const have = new Set(
      daysOfEvent(event.contentId, true)
        .filter((d) => d.instance?.templateId === t.id)
        .map((d) => d.instance!.occurrence),
    );
    if (occurrencesBetween(t.rule, today, horizonEnd(t, today)).some((d) => !have.has(d))) return true;
    for (const d of daysOfEvent(event.contentId)) {
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
    const event = getRecord(t.contentId);
    if (!isLiveEvent(event) || event.archived) continue;
    const r = syncSchedule(SYSTEM, event, t, today);
    out.made += r.made.length + r.restored.length;
    out.booked += r.booked;
  }
  return out;
}

// ── A one-time or multi-day event: its plan and days ─────────

function datedForPlan(actor: Actor, eventId: string): ContentRecord {
  const event = eventForPlan(actor, eventId);
  if (productionOf(event)?.mode === "recurring") throw new RuleError("A recurring show's days come from its schedule.");
  return event;
}

/** Changes the Event Plan of an event: what it is, who for, where, travel, accommodation, budget and notes. */
export function updateEventPlan(actor: Actor, eventId: string, patch: Partial<EventPlan>): EventPlan {
  const event = datedForPlan(actor, eventId);
  const plan = { ...blankEventPlan(), ...(event.production?.eventPlan ?? {}) };
  for (const f of EVENT_PLAN_FIELDS) {
    const v = patch[f.key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > 4000) throw new RuleError(`Keep the ${f.label.toLowerCase()} under 4,000 characters.`);
    plan[f.key] = v;
  }
  event.production = { ...(event.production ?? productionOf(event)!), eventPlan: plan };
  event.version += 1;
  logAudit(actor, "event-plan", "record", eventId, Object.keys(patch).join(", "));
  commit();
  return plan;
}

/**
 * Adds a day to an event (a one-time event becomes a multi-day one). Its call sheet starts as a copy of the nearest
 * day before it (or the first day), with that day's gear where it is free; the days are numbered again in date order.
 */
export function addEventDay(actor: Actor, eventId: string, date: string): RecordingSession {
  const event = datedForPlan(actor, eventId);
  if (!isIsoDate(date)) throw new RuleError("Pick the day's date.");
  const days = daysOfEvent(eventId);
  if (days.some((d) => d.scheduledDate === date)) throw new RuleError("The event already has a day on that date.");
  if (days.length >= MAX_DAYS_OF_SHOW)
    throw new RuleError(`An event can run for up to ${MAX_DAYS_OF_SHOW} days. Add a longer one in parts.`);
  const dated = days.filter((d) => d.scheduledDate);
  const from = [...dated].reverse().find((d) => d.scheduledDate! < date) ?? dated[0];
  const day = makeDay(event, date, `Day ${days.length + 1}`, { productionLevel: from?.productionLevel ?? event.productionLevel });
  const fromSheet = from ? sheetOfDay(from) : undefined;
  const cs = makeSheet(
    actor,
    event,
    day,
    fromSheet ? cloneContent(fromSheet) : startingContent("", event.production?.eventPlan?.venue ?? ""),
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
  if (event.production?.mode === "one_time")
    event.production = { ...event.production, mode: "multi_day", eventPlan: event.production.eventPlan ?? blankEventPlan() };
  // Days named "Day N" (or the one "Show day") are numbered again in date order; a day someone renamed keeps its name.
  daysOfEvent(eventId).forEach((d, i) => {
    if ((/^Day \d+$/.test(d.name ?? "") || d.name === "Show day") && d.name !== `Day ${i + 1}`) {
      d.name = `Day ${i + 1}`;
      d.updatedAt = nowStamp();
    }
  });
  spanOfDays(event);
  event.version += 1;
  logAudit(actor, "event-day", "record", eventId, `${day.id} on ${date}`);
  commit();
  return day;
}

// ── One occurrence, or this and future ──────────────────────

/**
 * "This and future occurrences": a day's call sheet, as it is now, becomes its show's template, and every later day
 * still following the template takes it; this day follows the template again. Days before it keep what they have.
 */
export function applyDayToFuture(actor: Actor, dayId: string): TemplateResult {
  const day = getDb().recordingSessions.find((s) => s.id === dayId);
  if (!day?.instance || !day.scheduledDate) throw new RuleError("This day was not made from a show's template.");
  const cs = sheetOfDay(day);
  if (!cs) throw new RuleError("This day has no call sheet.");
  const sheet = Object.fromEntries(SHEET_CONTENT_KEYS.map((k) => [k, structuredClone(cs[k])])) as Partial<SheetContent>;
  const out = updateShowTemplate(actor, day.instance.templateId, { sheet, from: day.scheduledDate });
  const t = requireTemplate(day.instance.templateId);
  Object.assign(day.instance, { locked: false, lockedAt: null, lockedBy: null, templateVersion: t.version });
  day.updatedAt = nowStamp();
  logAudit(actor, "template", "session", day.id, "This and future: the day's call sheet is the template from here on");
  commit();
  return out;
}

/** Calls off one date of a recurring show: the day is kept, archived as cancelled, and the schedule leaves the date out. */
export function cancelDay(actor: Actor, dayId: string, reason: string): RecordingSession {
  const { day, event } = dayForPlan(actor, dayId);
  if (!day.instance || !day.scheduledDate) throw new RuleError("Only a day of a recurring show is cancelled this way.");
  if (day.status !== "Planned") throw new RuleError("This day has started. Close it from its own page.");
  const why = reason.trim();
  if (!why) throw new RuleError("Say why this date is cancelled.");
  const t = requireTemplate(day.instance.templateId);
  if (!t.rule.skipDates.includes(day.instance.occurrence)) t.rule.skipDates = [...t.rule.skipDates, day.instance.occurrence].sort();
  t.version += 1;
  const cs = sheetOfDay(day);
  const m = cs ? manifestForSheet(cs.id) : undefined;
  if (m?.status === "assigned") releaseManifest(actor, m.id);
  day.archivedAt = nowStamp();
  day.archivedReason = `Cancelled: ${why}`;
  day.updatedAt = day.archivedAt;
  logAudit(actor, "day-cancelled", "session", day.id, `${event.title}, ${day.scheduledDate}: ${why}`);
  commit();
  return day;
}

export const DAY_LABELS = ["Morning", "Afternoon", "Evening", "Late night", "Full day"];

/**
 * A day's label: Morning, Afternoon, Evening, Late night, Full day, or (on a day of a recurring show) a name of its
 * own. Empty takes it off.
 */
export function setDayLabel(actor: Actor, dayId: string, label: string): RecordingSession {
  const { day } = dayForPlan(actor, dayId);
  const text = label.trim().slice(0, 60);
  if (day.instance) day.instance.label = text || null;
  else if (!text) day.label = null;
  else if (DAY_LABELS.includes(text)) day.label = text as RecordingSession["label"];
  else throw new RuleError("Choose Morning, Afternoon, Evening, Late night or Full day.");
  day.updatedAt = nowStamp();
  commit();
  return day;
}
