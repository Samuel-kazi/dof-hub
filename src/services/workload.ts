import type { Actor, ContentRecord, Person } from "../types";
import { getDb } from "../data/store";
import { categoryOf } from "../config/categories";
import { DEFAULT_WORK_DAYS, HORIZON_DAYS, LOAD_BANDS, effortFor } from "../config/capacity";
import { can } from "./permissions";
import { docSubject } from "./docs";
import { isComplete, ownersOf, usesPipeline } from "./content";
import { dayNumber, fmtShort, fromDayNumber, todayIso } from "./utils";

// Capacity: how much each person has on, day by day.
//
// Work has two kinds. Fixed commitments (a shoot day on a call sheet, being away with gear) take the
// whole day. Stage and checklist work is measured in person-days and spread evenly over the working
// days between when it can start and when it is due. Add the two up for a day and you have that
// person's load: 1.0 is a full day, more than 1.0 is more than one person can do.

export type LoadStatus = "off" | "free" | "ok" | "busy" | "over";

export interface LoadItem {
  id: string;
  kind: "stage" | "task" | "shoot" | "away";
  label: string;
  contentId: string;
  effort: number; // person-days still to do (1 for a fixed day)
  from: string;
  to: string;
  days: string[]; // the days it is spread over
  perDay: number;
  late: boolean; // already past its date, so shown as catch-up work from today
}

export interface DayLoad {
  date: string;
  workDay: boolean;
  load: number;
  status: LoadStatus;
  parts: { item: LoadItem; amount: number }[];
}

export interface Workload {
  personId: string;
  days: DayLoad[];
  items: LoadItem[];
  undated: string[]; // work with no date, which cannot be scheduled
  overDays: string[];
  freeDays: number; // working days with room to spare
  peak: number;
}

const weekday = (iso: string): number => new Date(`${iso}T12:00:00Z`).getUTCDay();
const addDay = (iso: string, n: number): string => fromDayNumber(dayNumber(iso) + n);
const workDaysSetting = (): number[] => getDb().settings.workDays ?? DEFAULT_WORK_DAYS;
const isWorkDay = (iso: string): boolean => workDaysSetting().includes(weekday(iso));

/** Working days from `from` to `to`, both included. */
function workingDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let n = dayNumber(from); n <= dayNumber(to) && out.length < 400; n++) if (isWorkDay(fromDayNumber(n))) out.push(fromDayNumber(n));
  return out;
}

function nextWorkingDates(from: string, count: number): string[] {
  const out: string[] = [];
  for (let n = dayNumber(from); out.length < count && n < dayNumber(from) + 400; n++) if (isWorkDay(fromDayNumber(n))) out.push(fromDayNumber(n));
  return out;
}

export const fmtDays = (n: number): string => `${Math.round(n * 10) / 10} day${Math.round(n * 10) / 10 === 1 ? "" : "s"}`;

let seq = 0;

/** Turns some effort and a window into an item. Work already past its date becomes catch-up from today. */
function makeItem(kind: LoadItem["kind"], label: string, contentId: string, effort: number, start: string, end: string, asOf: string): LoadItem {
  let days: string[];
  let late = false;
  if (end < asOf) {
    days = nextWorkingDates(asOf, Math.max(1, Math.ceil(effort)));
    late = true;
  } else {
    days = workingDates(start < asOf ? asOf : start, end);
    if (!days.length) {
      // The window holds no working day. Use the last one before it ends, or the next one if that is already gone.
      const before = workingDates(asOf, end);
      days = before.length ? [before[before.length - 1]] : nextWorkingDates(end, 1);
      late = !before.length;
    }
  }
  return { id: `${contentId}#${++seq}`, kind, label, contentId, effort, from: days[0] ?? start, to: end, days, perDay: effort / days.length, late };
}

/** Everything a person has on, as items. */
function itemsFor(personId: string, asOf: string): { items: LoadItem[]; undated: string[] } {
  const db = getDb();
  const items: LoadItem[] = [];
  const undated: string[] = [];
  const overrides = db.settings.effortOverrides ?? {};
  const shootKeys = new Set<string>();

  // Call sheets: being on one is a full shoot day.
  for (const cs of db.callSheets) {
    if (!cs.crewPersonIds.includes(personId) || cs.date < asOf) continue;
    shootKeys.add(`${cs.contentId}|${cs.date}`);
    items.push({ id: `${cs.id}#shoot`, kind: "shoot", label: `Call sheet: ${cs.title}`, contentId: cs.contentId, effort: 1, from: cs.date, to: cs.date, days: [cs.date], perDay: 1, late: false });
  }

  for (const r of db.records) {
    if (r.archived || !usesPipeline(r) || !r.pipelineStage || isComplete(r) || r.pipelineStage === "Closed" || r.category === "general") continue;
    const cfg = categoryOf(r.category);
    const stages = cfg.stages;
    const idx = stages.findIndex((s) => s.name === r.pipelineStage);
    if (idx === -1) continue; // stage name doesn't match this category's current stages — skip rather than crash
    const subject = docSubject(r);
    const rootId = r.contentId.split("-").slice(0, 3).join("-");

    // A shoot that is booked but has no call sheet yet still takes the crew's day.
    const footageIdx = stages.findIndex((s) => s.name === cfg.footageStage);
    if (r.scheduledDate && r.scheduledDate >= asOf && idx <= footageIdx && !shootKeys.has(`${rootId}|${r.scheduledDate}`)) {
      const crew = ownersOf(r, cfg.footageStage);
      if (crew.some((o) => o.personId === personId)) {
        items.push({ id: `${r.contentId}#shoot`, kind: "shoot", label: `${cfg.footageStage === "Show" ? "Show" : "Shoot"}: ${subject}`, contentId: r.contentId, effort: 1, from: r.scheduledDate, to: r.scheduledDate, days: [r.scheduledDate], perDay: 1, late: false });
      }
    }

    for (let i = Math.max(0, idx); i < stages.length; i++) {
      const stage = stages[i];
      if (stage.name === cfg.footageStage || r.stageOutputs[stage.name]) continue;
      const total = effortFor(r.category, stage.name, overrides);
      if (total <= 0) continue;
      const stageDue = r.stageDeadlines[stage.name] ?? null;
      const start = i === idx ? asOf : addDay(r.stageDeadlines[stages[i - 1].name] ?? asOf, 1);
      let owners = ownersOf(r, stage.name).map((o) => o.personId);
      if (i === idx && !owners.length && r.assigneePersonId) owners = [r.assigneePersonId];
      const tasks = r.tasks.filter((t) => t.stage === stage.name);
      const shares: { who: string; effort: number; end: string | null; label: string }[] = [];
      if (tasks.length) {
        for (const t of tasks.filter((x) => !x.done)) {
          const who = t.assigneePersonId ? [t.assigneePersonId] : owners;
          for (const w of who) shares.push({ who: w, effort: total / tasks.length / who.length, end: t.dueDate ?? stageDue, label: `${subject}: ${t.label}` });
        }
      } else {
        for (const w of owners) shares.push({ who: w, effort: total / owners.length, end: stageDue, label: `${subject}: ${stage.name}` });
      }
      for (const sh of shares.filter((x) => x.who === personId)) {
        if (!sh.end) { undated.push(sh.label); continue; }
        items.push(makeItem(tasks.length ? "task" : "stage", sh.label, r.contentId, sh.effort, start, sh.end, asOf));
      }
    }
  }

  // Being away with gear takes the whole day, weekends included.
  for (const m of db.manifests) {
    if (m.responsiblePersonId !== personId || m.destination !== "outside" || (m.status !== "assigned" && m.status !== "checked-out")) continue;
    const end = m.expectedReturn ?? m.date;
    if (end < asOf) continue;
    const days: string[] = [];
    for (let n = dayNumber(m.date < asOf ? asOf : m.date); n <= dayNumber(end); n++) days.push(fromDayNumber(n));
    items.push({ id: `${m.id}#away`, kind: "away", label: `Away with gear: ${m.id}`, contentId: m.contentId, effort: days.length, from: days[0], to: end, days, perDay: 1, late: false });
  }
  return { items, undated };
}

function statusFor(load: number, workDay: boolean): LoadStatus {
  if (!workDay) return load > 0 ? "busy" : "off";
  if (load >= LOAD_BANDS.over) return "over";
  if (load >= LOAD_BANDS.busy) return "busy";
  if (load >= LOAD_BANDS.ok) return "ok";
  return "free";
}

/** One person's load for each day from `asOf`. */
export function workloadFor(personId: string, asOf: string = todayIso(), horizon: number = HORIZON_DAYS): Workload {
  const { items, undated } = itemsFor(personId, asOf);
  const days: DayLoad[] = [];
  for (let n = 0; n < horizon; n++) {
    const date = addDay(asOf, n);
    const parts = items.filter((it) => it.days.includes(date)).map((item) => ({ item, amount: item.perDay }));
    const fixed = Math.max(new Set(parts.filter((p) => p.item.kind === "shoot").map((p) => p.item.id)).size, parts.some((p) => p.item.kind === "away") ? 1 : 0);
    const effort = parts.filter((p) => p.item.kind === "stage" || p.item.kind === "task").reduce((a, p) => a + p.amount, 0);
    const load = Math.round((fixed + effort) * 100) / 100;
    const workDay = isWorkDay(date);
    days.push({ date, workDay, load, status: statusFor(load, workDay), parts });
  }
  return {
    personId,
    days,
    items,
    undated,
    overDays: days.filter((d) => d.status === "over").map((d) => d.date),
    freeDays: days.filter((d) => d.workDay && d.status === "free").length,
    peak: Math.max(0, ...days.map((d) => d.load)),
  };
}

export interface Risk { item: LoadItem; needed: number; free: number; shortfall: number; reason: string }

/** Work that cannot be finished in the time it has, given everything else the person is doing. */
export function assignmentRisks(personId: string, asOf: string = todayIso(), horizon: number = HORIZON_DAYS): Risk[] {
  const w = workloadFor(personId, asOf, horizon);
  const risks: Risk[] = [];
  for (const item of w.items.filter((i) => i.kind === "stage" || i.kind === "task")) {
    if (item.late) {
      risks.push({ item, needed: item.effort, free: 0, shortfall: item.effort, reason: `${item.label} is past its date and needs ${fmtDays(item.effort)} more.` });
      continue;
    }
    const window = workingDates(item.days[0], item.to);
    const free = window.reduce((sum, date) => {
      const day = w.days.find((d) => d.date === date);
      const others = (day?.load ?? 0) - (day?.parts.find((p) => p.item.id === item.id)?.amount ?? 0);
      return sum + Math.max(0, 1 - others);
    }, 0);
    const shortfall = item.effort - free;
    if (shortfall > 0.05) {
      risks.push({ item, needed: item.effort, free, shortfall, reason: `${item.label} needs ${fmtDays(item.effort)} but only ${fmtDays(free)} ${free === 1 ? "is" : "are"} free between ${fmtShort(item.days[0])} and ${fmtShort(item.to)}.` });
    }
  }
  return risks.sort((a, b) => b.shortfall - a.shortfall);
}

/** Free working days between `asOf` and a date, after everything the person already has on. */
export function freeDaysBefore(personId: string, date: string, asOf: string = todayIso()): number {
  const w = workloadFor(personId, asOf, Math.max(1, dayNumber(date) - dayNumber(asOf) + 1));
  return w.days.filter((d) => d.workDay && d.date <= date).reduce((sum, d) => sum + Math.max(0, 1 - d.load), 0);
}

/** A sentence to show after giving someone work, when it leaves them over capacity. */
export function overloadWarning(personId: string, asOf: string = todayIso()): string | null {
  const w = workloadFor(personId, asOf);
  const name = getDb().people.find((p) => p.personId === personId)?.name ?? personId;
  if (!w.overDays.length) {
    const risk = assignmentRisks(personId, asOf)[0];
    return risk ? `Heads up: ${risk.reason}` : null;
  }
  const shown = w.overDays.slice(0, 3).map(fmtShort).join(", ");
  return `Heads up: ${name} is over capacity on ${shown}${w.overDays.length > 3 ? ` and ${w.overDays.length - 3} more days` : ""}.`;
}

/** Who can see whose workload: the Head of Production sees everyone, crew see their own. */
export function crewWorkload(actor: Actor, asOf: string = todayIso(), horizon: number = HORIZON_DAYS): { person: Person; workload: Workload }[] {
  const people = getDb().people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"));
  const mine = can(actor, "workload.viewAll") ? people : people.filter((p) => p.personId === actor.personId);
  return mine
    .map((person) => ({ person, workload: workloadFor(person.personId, asOf, horizon) }))
    .filter((x) => x.person.category === "CRW" || x.workload.items.length > 0)
    .sort((a, b) => b.workload.overDays.length - a.workload.overDays.length || b.workload.peak - a.workload.peak || a.person.name.localeCompare(b.person.name));
}

export const canSeeWorkload = (actor: Actor, personId: string): boolean => can(actor, "workload.viewAll") || actor.personId === personId;

export function subjectOf(r: ContentRecord): string {
  return docSubject(r);
}
