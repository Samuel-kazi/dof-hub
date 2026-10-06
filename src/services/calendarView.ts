import type { Actor, CategoryKey, ContentRecord } from "../types";
import { getDb } from "../data/store";
import { todayIso } from "./utils";
import { categoryOf, shootDateLabel } from "../config/categories";
import { getRecord, visibleCallSheets, visibleRecords } from "./access";
import { displayTitle, isComplete, usesPipeline } from "./content";
import { endOf, hasGearAccess, listManifests } from "./equipment";
import { workItems } from "./workItems";
import type { Route } from "../ui/AppContext";

// The calendar has no table of its own. Every event is worked out here, on the fly, from records, recording
// sessions, call sheets and equipment bookings that already exist — so there is nothing to keep in sync, and
// changing a date on its source record is all it takes to change what the calendar shows next render.

export type CalSubtype = "shoot" | "session" | "deadline" | "callsheet" | "booking" | "window" | "stage" | "loan" | "reminder";

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
  days?: { date: string; id: string }[]; // a multi-day event's bar: each of its days, so a click on one opens that day
}

/**
 * Whether a live show is drawn as one bar across its days: a multi-day event (Monday to Friday, one bar). A recurring
 * show never is (it shows on each of its dates, Fridays only, never as a bar across months), nor a one-time event.
 * A show from before productions, with a start and an end, still is.
 */
export function isWindowShow(show: ContentRecord | null | undefined): boolean {
  if (!show || show.category !== "live" || show.hierarchyLevel !== 0) return false;
  if (show.production) return show.production.mode === "multi_day";
  return !!show.showStart && !!show.showEnd && show.showEnd > show.showStart;
}

const inRange = (date: string, from: string, to: string): boolean => date >= from && date <= to;
const overlaps = (start: string, end: string, from: string, to: string): boolean => start <= to && end >= from;

/** Every calendar event touching the [from, to] window (inclusive), that this person may see. */
export function calendarEvents(actor: Actor, from: string, to: string): CalEvent[] {
  const out: CalEvent[] = [];

  for (const r of visibleRecords(actor)) {
    if (r.category === "general") continue; // a placeholder project, not a production — nothing here to put on a calendar
    // The five-stage workflow's projects and episodes come from its own work list (Source 5): an episode carries its
    // session's date, and that day is already the session's own marker.
    if (r.workflow || r.episode) continue;
    // Source 1: content_registry.scheduled_recording_date — the shoot or show day itself. A live
    // show spanning several days gets one bar instead (below), so its individual days are skipped here.
    const show = r.category === "live" && r.parentId ? getRecord(r.parentId) : null;
    const showIsWindow = isWindowShow(show);
    if (r.scheduledDate && inRange(r.scheduledDate, from, to) && !showIsWindow && r.pipelineStage !== "Closed") {
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
    // A live show with several days is one production, the same as on the Dashboard: its window bar
    // above already stands for the whole run, so its individual days do not also add their own bars here.
    // A show's days are production instances: each sits on its own date, with no stage bars or deadlines of their own
    // (those stacked up, a bar per coming day, before).
    const showDay = r.category === "live" && r.hierarchyLevel === 1;
    if (usesPipeline(r) && r.pipelineStage && !isComplete(r) && !showIsWindow && !showDay && r.category !== "devotional") {
      const stages = categoryOf(r.category).stages;
      const idx = stages.findIndex((s) => s.name === r.pipelineStage);
      for (let i = Math.max(idx, 0); idx >= 0 && i < stages.length; i++) {
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
  const records = visibleRecords(actor);
  for (const r of records) {
    if (!isWindowShow(r)) continue;
    const days = records
      .filter((d) => d.parentId === r.contentId && !d.archived && d.scheduledDate)
      .map((d) => ({ date: d.scheduledDate!, id: d.contentId }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const start = days[0]?.date ?? r.showStart;
    const end = days[days.length - 1]?.date ?? r.showEnd;
    if (!start || !end || !overlaps(start, end, from, to)) continue;
    out.push({
      id: `window:${r.contentId}`,
      date: start,
      endDate: end,
      title: r.title,
      detail: `${days.length} day${days.length === 1 ? "" : "s"}, ${r.contentId}. Click a day for its details.`,
      subtype: "window",
      category: r.category,
      color: categoryOf(r.category).color,
      open: { n: "record", id: r.contentId },
      days,
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

  // Source 5: the five-stage workflow. Each recording session's date (kept after it closes, like any shoot day),
  // and the stage deadlines of projects and episodes: the stage an episode is in as a bar from when it began, the
  // stage after it as a mark on its deadline. A project's own deadline is shown while it is in that stage.
  for (const item of workItems(actor, false)) {
    const color = categoryOf(item.category).color;
    if (item.level === "session") {
      if (!item.due || !inRange(item.due, from, to)) continue;
      out.push({
        id: `session:${item.id}`,
        date: item.due,
        endDate: item.due,
        title: `${item.context}: ${item.title.toLowerCase()}`,
        detail: `${item.id}. ${item.step}.`,
        subtype: "session",
        category: item.category,
        color,
        open: item.open,
      });
      continue;
    }
    if (item.done) continue;
    const marks: { stage: string; due: string; start: string }[] = [];
    if (item.level === "project" && item.due) marks.push({ stage: item.stage, due: item.due, start: item.due });
    if (item.level === "episode") {
      if (item.due) marks.push({ stage: item.stage, due: item.due, start: item.start <= item.due ? item.start : item.due });
      const next = item.stage === "Post production" ? getRecord(item.id)?.stageDeadlines["Marketing and distribution"] : null;
      if (next) marks.push({ stage: "Marketing and distribution", due: next, start: next });
    }
    for (const m of marks) {
      if (!overlaps(m.start, m.due, from, to)) continue;
      out.push({
        id: `deadline:${item.id}:${m.stage}`,
        date: m.start,
        endDate: m.due,
        title: `${item.level === "episode" ? `${item.context}, ${item.title}` : item.title}: ${m.stage}`,
        detail: `${m.stage} due. ${item.id}.`,
        subtype: m.start < m.due ? "stage" : "deadline",
        category: item.category,
        color,
        open: item.open,
      });
    }
  }

  // Source 6: loans (Equipment, Lending), on the day each is due back; a late one says so, on today.
  if (hasGearAccess(actor)) {
    const today = todayIso();
    for (const l of getDb().loans ?? []) {
      if (l.status !== "out") continue;
      const late = l.expectedReturn < today;
      const date = late ? today : l.expectedReturn;
      if (!inRange(date, from, to)) continue;
      out.push({
        id: `loan:${l.id}`,
        date,
        endDate: date,
        title: `${late ? "Overdue: " : "Back: "}${l.borrowerName}`,
        detail: `Loan ${l.id}, due back ${l.expectedReturn}.`,
        subtype: "loan",
        category: "general",
        color: "#8a8a92",
        open: { n: "equipment" },
      });
    }
  }

  // Source 7: one's own reminders that stand alone (those on an item show with the item).
  for (const rm of getDb().calendarReminders ?? []) {
    if (rm.targetType || !rm.recipientIds.includes(actor.personId) || !rm.date || !inRange(rm.date, from, to)) continue;
    out.push({
      id: `reminder:${rm.id}`,
      date: rm.date,
      endDate: rm.date,
      title: rm.title || "Reminder",
      detail: `Reminder${rm.time ? ` at ${rm.time}` : ""}${rm.repeat !== "none" ? `, repeats ${rm.repeat}` : ""}.`,
      subtype: "reminder",
      category: "general",
      color: "#8a8a92",
      open: { n: "calendar" },
    });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** Every event that touches a given day, from a window already fetched (so a month grid asks once). */
export function eventsOnDay(events: CalEvent[], date: string): CalEvent[] {
  return events.filter((e) => e.date <= date && e.endDate >= date);
}
