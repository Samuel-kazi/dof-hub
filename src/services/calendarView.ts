import type { Actor, CategoryKey } from "../types";
import { categoryOf, shootDateLabel } from "../config/categories";
import { getRecord, visibleCallSheets, visibleRecords } from "./access";
import { displayTitle, isComplete, usesPipeline } from "./content";
import { endOf, hasGearAccess, listManifests } from "./equipment";
import type { Route } from "../ui/AppContext";

// The calendar has no table of its own. Every event is worked out here, on the fly, from records,
// call sheets and equipment bookings that already exist — so there is nothing to keep in sync, and
// changing a date on its source record is all it takes to change what the calendar shows next render.

export type CalSubtype = "shoot" | "deadline" | "callsheet" | "booking" | "window" | "stage";

export interface CalEvent {
  id: string; // stable key: kind + source id, so React can key on it and nothing is ever duplicated
  date: string; // YYYY-MM-DD, the day this marker sits on
  endDate: string; // inclusive end date; equal to `date` unless the event spans days (a gear booking)
  title: string;
  detail: string;
  subtype: CalSubtype;
  category: CategoryKey;
  color: string; // always categoryOf(category).color — never chosen here
  open: Route; // where "open" on this event should take the person
}

const inRange = (date: string, from: string, to: string): boolean => date >= from && date <= to;
const overlaps = (start: string, end: string, from: string, to: string): boolean => start <= to && end >= from;

/** Every calendar event touching the [from, to] window (inclusive), that this person may see. */
export function calendarEvents(actor: Actor, from: string, to: string): CalEvent[] {
  const out: CalEvent[] = [];

  for (const r of visibleRecords(actor)) {
    // Source 1: content_registry.scheduled_recording_date — the shoot or show day itself. A live
    // show spanning several days gets one bar instead (below), so its individual days are skipped here.
    const show = r.category === "live" && r.parentId ? getRecord(r.parentId) : null;
    const showIsWindow = !!show?.showStart && !!show.showEnd && show.showEnd > show.showStart;
    if (r.scheduledDate && inRange(r.scheduledDate, from, to) && !showIsWindow) {
      out.push({
        id: `shoot:${r.contentId}`,
        date: r.scheduledDate,
        endDate: r.scheduledDate,
        title: displayTitle(r),
        detail: `${shootDateLabel(r.category)}. ${r.contentId}.`,
        subtype: "shoot",
        category: r.category,
        color: categoryOf(r.category).color,
        open: { n: "record", id: r.contentId },
      });
    }
    // Source 2: per-stage deadlines, the same ones the 24hr reminder system reads — every stage from
    // the current one onward that has a deadline and is not yet done. The current stage becomes a bar
    // spanning from when it was entered, so it reads as a window of active work, not just a due date;
    // stages still to come stay as a single mark on their deadline, since there is no start to draw from.
    if (usesPipeline(r) && r.pipelineStage && !isComplete(r)) {
      const stages = categoryOf(r.category).stages;
      const idx = stages.findIndex((s) => s.name === r.pipelineStage);
      for (let i = idx; i < stages.length; i++) {
        const st = stages[i];
        const due = r.stageDeadlines[st.name];
        if (!due || r.stageOutputs[st.name]) continue;
        const isCurrent = i === idx;
        const start = isCurrent && r.stageEnteredAt <= due ? r.stageEnteredAt : due;
        if (!overlaps(start, due, from, to)) continue;
        out.push({
          id: `deadline:${r.contentId}:${st.name}`,
          date: start,
          endDate: due,
          title: `${displayTitle(r)}: ${st.name}`,
          detail: `${st.name} due. ${r.contentId}.`,
          subtype: isCurrent && start < due ? "stage" : "deadline",
          category: r.category,
          color: categoryOf(r.category).color,
          open: { n: "record", id: r.contentId },
        });
      }
    }
  }

  // Source 1b: a live show's production window, when it runs more than one day — the bar that
  // replaces its days' individual shoot markers above.
  for (const r of visibleRecords(actor)) {
    if (r.category !== "live" || r.hierarchyLevel !== 0 || !r.showStart || !r.showEnd || r.showEnd <= r.showStart) continue;
    if (!overlaps(r.showStart, r.showEnd, from, to)) continue;
    out.push({
      id: `window:${r.contentId}`,
      date: r.showStart,
      endDate: r.showEnd,
      title: r.title,
      detail: `Production window. ${r.contentId}.`,
      subtype: "window",
      category: r.category,
      color: categoryOf(r.category).color,
      open: { n: "record", id: r.contentId },
    });
  }

  // Source 3: Call Sheet module dates — once a sheet is published (final), it marks its shoot day.
  for (const cs of visibleCallSheets(actor)) {
    if (cs.status !== "final" || !inRange(cs.date, from, to)) continue;
    const root = getRecord(cs.contentId);
    const category = root?.category ?? "series";
    out.push({
      id: `callsheet:${cs.id}`,
      date: cs.date,
      endDate: cs.date,
      title: cs.title,
      detail: `Call time ${cs.callTime}. ${cs.location || "Location to be confirmed"}.`,
      subtype: "callsheet",
      category,
      color: categoryOf(category).color,
      open: { n: "callsheet", id: cs.id },
    });
  }

  // Source 4: equipment bookings, the same reservations the availability/conflict check already
  // uses — shown so a clash is visible on the calendar before it becomes a conflict at checkout.
  if (hasGearAccess(actor)) {
    for (const m of listManifests(actor)) {
      if (m.status !== "assigned" && m.status !== "checked-out") continue;
      const end = endOf(m);
      if (!overlaps(m.date, end, from, to)) continue;
      const root = getRecord(m.contentId);
      const category = root?.category ?? "series";
      out.push({
        id: `booking:${m.id}`,
        date: m.date,
        endDate: end,
        title: `Gear: ${m.id}`,
        detail: `${root ? root.title : m.contentId}. ${m.lines.length} item${m.lines.length === 1 ? "" : "s"}.`,
        subtype: "booking",
        category,
        color: categoryOf(category).color,
        open: { n: "manifest", id: m.id },
      });
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** Every event that touches a given day, from a window already fetched (so a month grid asks once). */
export function eventsOnDay(events: CalEvent[], date: string): CalEvent[] {
  return events.filter((e) => e.date <= date && e.endDate >= date);
}
