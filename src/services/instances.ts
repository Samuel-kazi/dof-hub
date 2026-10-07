import type { Actor, RecordingSession } from "../types";
import { getDb } from "../data/store";
import { logAudit } from "./audit";

// The days of a live event (its sessions, data version 23) and their call sheets. Kept apart from the production
// service so the call sheet and equipment services can use it without importing each other: a day made from a show
// template stops following the template once someone changes its call sheet by hand.

/** The day of a live event a call sheet is for, if it is one. */
export const dayOfSheet = (sheetId: string): RecordingSession | undefined => {
  const cs = getDb().callSheets.find((c) => c.id === sheetId);
  return cs?.instanceId ? getDb().recordingSessions.find((s) => s.id === cs.instanceId) : undefined;
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
  day.updatedAt = day.instance.lockedAt;
  logAudit(actor, "instance-edited", "session", day.id, "changed by hand: later template changes pass it by");
}

/** Moves a day of an event to a new date, with its call sheet. */
export function moveDay(day: RecordingSession, date: string): void {
  day.scheduledDate = date;
  day.updatedAt = new Date().toISOString();
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
