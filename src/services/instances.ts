import type { Actor, ContentRecord } from "../types";
import { categoryOf } from "../config/categories";
import { getDb } from "../data/store";
import { logAudit } from "./audit";
import { addDaysIso } from "./utils";

// The days of a production (instances) and their call sheets. Kept apart from the production service so the call
// sheet and equipment services can use it without importing each other: a day made from a show template stops
// following the template once someone changes its call sheet by hand.

/** The day a call sheet is for, if it is the call sheet of a day of a show. */
export const dayOfSheet = (sheetId: string): ContentRecord | undefined => {
  const cs = getDb().callSheets.find((c) => c.id === sheetId);
  return cs?.instanceId ? getDb().records.find((r) => r.contentId === cs.instanceId) : undefined;
};

/**
 * A change made by hand to a day's call sheet: if the day follows a show template, it stops, and keeps its own
 * content from now on (until someone resets it to the template). Ticking the technical check, confirming and
 * commenting are not changes of plan and never call this.
 */
export function lockInstanceOfSheet(actor: Actor, sheetId: string): void {
  const day = dayOfSheet(sheetId);
  if (!day?.instance || day.instance.locked) return;
  day.instance.locked = true;
  day.instance.lockedAt = new Date().toISOString();
  day.instance.lockedBy = actor.personId;
  day.version += 1;
  logAudit(actor, "instance-edited", "record", day.contentId, "changed by hand: later template changes pass it by");
}

/** How many days before (minus) or after the day itself each stage of a live day is due. */
const LIVE_STAGE_OFFSETS: Record<string, number> = { Prep: -3, Build: -1, Rehearse: 0, Show: 0, Wrap: 0, Review: 3, "Post Production": 7 };

/**
 * Sets a day's stage deadlines from its own date, so a day weeks ahead is not due this week: prepared in the days
 * before, shown on the day, reviewed after. Stage tasks follow their stage's new deadline.
 */
export function anchorDeadlines(day: ContentRecord, date: string): void {
  const stages = categoryOf(day.category).stages;
  const show = stages.findIndex((s) => s.name === categoryOf(day.category).footageStage);
  day.stageDeadlines = Object.fromEntries(stages.map((s, i) => [s.name, addDaysIso(date, LIVE_STAGE_OFFSETS[s.name] ?? (i - show) * 2)]));
  for (const t of day.tasks) if (!t.done) t.dueDate = day.stageDeadlines[t.stage] ?? t.dueDate;
}

/** Moves a day to a new date with its call sheet: the day's date, publish date and deadlines follow. */
export function moveDay(day: ContentRecord, date: string): void {
  day.scheduledDate = date;
  day.deadline = date;
  anchorDeadlines(day, date);
  day.version += 1;
}

/**
 * People put on a call sheet's crew (or a show template's) are attached to its project, so they can open the sheet
 * on the day. Volunteers are attached without comments, as when they are assigned work.
 */
export function attachCrew(actor: Actor, projectId: string, personIds: string[]): void {
  const db = getDb();
  for (const pid of personIds) {
    const p = db.people.find((x) => x.personId === pid);
    if (!p || p.category === "HOP" || db.members.some((m) => m.personId === pid && m.projectContentId === projectId)) continue;
    db.members.push({ personId: pid, projectContentId: projectId, roleOnProject: "Crew", canComment: p.category !== "VOL" });
    logAudit(actor, "assign", "person", pid, `${projectId} (on a call sheet's crew)`);
  }
}
