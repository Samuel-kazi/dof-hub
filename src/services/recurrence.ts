import type { RecurrenceRule } from "../types";
import { RuleError } from "../types";
import { isIsoDate } from "./utils";

// When a recurring show happens: the dates a rule gives between two dates. Plain dates (YYYY-MM-DD), counted in
// whole days, so time zones and clock changes never move a show to another day. Nothing here reads or writes data.

const DAY = 86_400_000;
const toDay = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
};
const fromDay = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
export const weekdayOf = (iso: string): number => new Date(toDay(iso) * DAY).getUTCDay();
export const addDays = (iso: string, n: number): string => fromDay(toDay(iso) + n);

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const iso = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export const MAX_INTERVAL = 12;
export const MAX_COUNT = 520;
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NTH_NAMES: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

/** Refuses a rule that cannot work, in words a person can act on. */
export function checkRule(rule: RecurrenceRule): void {
  if (!isIsoDate(rule.startDate)) throw new RuleError("Pick the date the show starts.");
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_INTERVAL)
    throw new RuleError(`It can repeat every 1 to ${MAX_INTERVAL} ${rule.freq === "weekly" ? "weeks" : "months"}.`);
  if (rule.freq === "weekly") {
    if (!rule.weekdays.length) throw new RuleError("Choose the day of the week it happens on.");
    if (rule.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new RuleError("Choose days of the week.");
  } else if (rule.freq === "monthly") {
    const byDay = rule.monthDay !== null;
    if (byDay === (rule.nth !== null)) throw new RuleError("Choose either a day of the month or, say, the first Friday.");
    if (byDay && (!Number.isInteger(rule.monthDay) || rule.monthDay! < 1 || rule.monthDay! > 31))
      throw new RuleError("Choose a day of the month from 1 to 31.");
    if (rule.nth && (![1, 2, 3, 4, -1].includes(rule.nth.week) || rule.nth.weekday < 0 || rule.nth.weekday > 6))
      throw new RuleError("Choose the first, second, third, fourth or last day of the week in the month.");
  } else throw new RuleError("Choose weekly or monthly.");
  if (rule.until !== null && rule.count !== null) throw new RuleError("End it on a date or after a number of times, not both.");
  if (rule.until !== null && (!isIsoDate(rule.until) || rule.until < rule.startDate))
    throw new RuleError("It cannot end before it starts.");
  if (rule.count !== null && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > MAX_COUNT))
    throw new RuleError(`It can happen from 1 to ${MAX_COUNT} times.`);
  for (const d of [...rule.skipDates, ...rule.extraDates])
    if (!isIsoDate(d)) throw new RuleError("A date left out or added is not a date.");
}

/** The dates of the month a monthly rule picks, in order. */
function monthDates(rule: RecurrenceRule, y: number, m: number): string[] {
  const last = daysInMonth(y, m);
  if (rule.monthDay !== null) return [iso(y, m, Math.min(rule.monthDay, last))];
  const { week, weekday } = rule.nth!;
  const first = weekdayOf(iso(y, m, 1));
  const firstMatch = 1 + ((weekday - first + 7) % 7);
  if (week === -1) {
    let d = firstMatch;
    while (d + 7 <= last) d += 7;
    return [iso(y, m, d)];
  }
  const d = firstMatch + (week - 1) * 7;
  return d <= last ? [iso(y, m, d)] : [];
}

/**
 * Every date the rule gives, in order, from its start, until `to` (inclusive) or its own end: the dates of its
 * pattern (the first `count` of them, if it has a count), less the dates left out, plus the dates added. A date
 * left out still counts towards `count`, so leaving one out never adds one at the end.
 */
export function occurrences(rule: RecurrenceRule, to: string): string[] {
  checkRule(rule);
  const end = rule.until && rule.until < to ? rule.until : to;
  const out: string[] = [];
  const limit = rule.count ?? Infinity;
  if (rule.freq === "weekly") {
    // Weeks are counted from the Sunday of the week the show starts in, so "every 2 weeks" keeps its rhythm.
    const weekStart = toDay(rule.startDate) - weekdayOf(rule.startDate);
    const days = [...new Set(rule.weekdays)].sort((a, b) => a - b);
    for (let w = 0; out.length < limit; w += rule.interval) {
      const sunday = weekStart + w * 7;
      if (fromDay(sunday) > end) break;
      for (const d of days) {
        const date = fromDay(sunday + d);
        if (date < rule.startDate) continue;
        if (date > end || out.length >= limit) break;
        out.push(date);
      }
    }
  } else {
    let [y, m] = rule.startDate.split("-").map(Number);
    while (out.length < limit) {
      if (iso(y, m, 1) > end) break;
      for (const date of monthDates(rule, y, m)) if (date >= rule.startDate && date <= end && out.length < limit) out.push(date);
      m += rule.interval;
      while (m > 12) {
        m -= 12;
        y += 1;
      }
    }
  }
  const skip = new Set(rule.skipDates);
  const extra = rule.extraDates.filter((d) => d >= rule.startDate && d <= to);
  return [...new Set([...out.filter((d) => !skip.has(d)), ...extra])].sort();
}

/** The dates from `from` to `to`, both included, that the rule gives. */
export const occurrencesBetween = (rule: RecurrenceRule, from: string, to: string): string[] =>
  occurrences(rule, to).filter((d) => d >= from);

/** The rule in a sentence: "Every Friday from Oct 9, 2026", "On the last Sunday of every month, 6 times". */
export function describeRule(rule: RecurrenceRule, fmt: (iso: string) => string = (x) => x): string {
  const every = rule.interval === 1 ? "" : ` ${rule.interval}`;
  let what: string;
  if (rule.freq === "weekly") {
    const names = [...new Set(rule.weekdays)].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    what = rule.interval === 1 ? `Every ${list}` : `Every${every} weeks on ${list}`;
  } else if (rule.monthDay !== null) what = `On day ${rule.monthDay} of every${every} month${rule.interval === 1 ? "" : "s"}`;
  else
    what = `On the ${NTH_NAMES[rule.nth!.week]} ${WEEKDAY_NAMES[rule.nth!.weekday]} of every${every} month${rule.interval === 1 ? "" : "s"}`;
  const ends = rule.until ? `, until ${fmt(rule.until)}` : rule.count ? `, ${rule.count} time${rule.count === 1 ? "" : "s"}` : "";
  const changes = [
    rule.skipDates.length ? `${rule.skipDates.length} date${rule.skipDates.length === 1 ? "" : "s"} left out` : "",
    rule.extraDates.length ? `${rule.extraDates.length} added` : "",
  ].filter(Boolean);
  return `${what}, from ${fmt(rule.startDate)}${ends}${changes.length ? ` (${changes.join(", ")})` : ""}`;
}

/** A weekly rule on the start date's day of the week: what a new recurring show starts with. */
export const weeklyFrom = (startDate: string): RecurrenceRule => ({
  freq: "weekly",
  interval: 1,
  weekdays: [weekdayOf(startDate)],
  monthDay: null,
  nth: null,
  startDate,
  until: null,
  count: null,
  skipDates: [],
  extraDates: [],
});
