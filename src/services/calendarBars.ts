import type { CalEvent, CalSubtype } from "./calendarView";

// The month grid lays out one week at a time, so a bar never has to cross a week's line wrap — the
// same way every calendar app does it. Two kinds of subtype are always shown as dots, whatever their
// real date range, because a checkout period or a publish moment reads better as a single mark than
// a span: a call sheet is published at one moment, and a gear booking's most useful day to see is the
// one it goes out.
const ALWAYS_DOT: ReadonlySet<CalSubtype> = new Set(["callsheet", "booking"]);

export interface BarSegment {
  event: CalEvent;
  startCol: number; // 1-7, the week's Sun=1..Sat=7 column this segment starts in
  span: number; // how many columns wide, 1-7
  clippedStart: boolean; // the event began before this week, so the left end has no rounded cap
  clippedEnd: boolean; // the event continues after this week, so the right end has no rounded cap
}

export interface WeekLayout {
  lanes: BarSegment[][]; // each lane is a row of non-overlapping segments; earlier lanes fill first
  dotsByDate: Record<string, CalEvent[]>; // single-day marks, keyed by date, unaffected by lane stacking
}

const isBarEvent = (e: CalEvent): boolean => e.endDate > e.date && !ALWAYS_DOT.has(e.subtype);

/** White or near-black label text, whichever reads better on a solid fill of this color — the bar's
 *  own color varies by category, so this is decided per bar rather than assumed. */
export function textOn(hex: string): string {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.42 ? "#1a1410" : "#fff8f2";
}

/**
 * Assigns each multi-day event in this window to a lane (like a Gantt chart): the first lane that has
 * room takes it, so two events only share a lane if their dates never overlap. Longer, earlier-starting
 * events are placed first, so a short event tucks into a gap instead of pushing a long one down.
 */
export function layoutWeek(events: CalEvent[], weekDates: string[]): WeekLayout {
  const from = weekDates[0];
  const to = weekDates[weekDates.length - 1];
  const colOf = (date: string): number => weekDates.indexOf(date) + 1;

  const touching = events.filter((e) => e.date <= to && e.endDate >= from);
  const dotsByDate: Record<string, CalEvent[]> = {};
  for (const date of weekDates) dotsByDate[date] = [];
  for (const e of touching) {
    if (isBarEvent(e)) continue;
    for (const date of weekDates) if (date >= e.date && date <= e.endDate) dotsByDate[date].push(e);
  }

  const bars = touching
    .filter(isBarEvent)
    .map((event): BarSegment => {
      const clippedStart = event.date < from;
      const clippedEnd = event.endDate > to;
      const startCol = colOf(clippedStart ? from : event.date);
      const endCol = colOf(clippedEnd ? to : event.endDate);
      return { event, startCol, span: endCol - startCol + 1, clippedStart, clippedEnd };
    })
    .sort((a, b) => a.startCol - b.startCol || b.span - a.span);

  const lanes: BarSegment[][] = [];
  for (const seg of bars) {
    const lane = lanes.find((row) => row.every((placed) => seg.startCol >= placed.startCol + placed.span));
    if (lane) lane.push(seg);
    else lanes.push([seg]);
  }

  return { lanes, dotsByDate };
}
