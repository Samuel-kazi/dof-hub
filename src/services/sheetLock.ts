import type { CallSheet, ContentRecord } from "../types";
import { RuleError } from "../types";
import { getDb } from "../data/store";
import { categoryOf } from "../config/categories";
import { isComplete } from "./content";

// When a call sheet stops changing. A sheet stays open to edit while its production is still to happen or happening,
// published or not (changes to a published sheet are logged, and clear the confirmations they affect). Once the work
// it was for has moved on to Post production, the sheet is the record of the day, and it is locked:
// - a recording session's sheet, once the session is closed (its episodes are then in Post production);
// - a live show day's sheet, once the day reaches Post Production (or is done);
// - any other sheet, once every episode or item linked to it is past shooting.
// A sheet linked to nothing is never locked by this. Reopening a session opens its sheet again.

export interface SheetLock {
  locked: boolean;
  why: string;
}

const OPEN: SheetLock = { locked: false, why: "" };

/** Whether a record on its own pipeline has gone past its shoot or show (into post production). */
function pastShooting(r: ContentRecord): boolean {
  if (r.episode) return r.episode.stage === "Post production" || r.episode.stage === "Marketing and distribution";
  if (isComplete(r)) return true;
  const stages = categoryOf(r.category).stages.map((s) => s.name);
  const at = stages.indexOf(r.pipelineStage ?? "");
  if (at < 0) return false;
  if (r.category === "live") {
    const post = stages.indexOf("Post production");
    return post >= 0 && at >= post;
  }
  return at > stages.indexOf(categoryOf(r.category).footageStage);
}

export function sheetLock(cs: CallSheet): SheetLock {
  const db = getDb();
  const session = db.recordingSessions.find((s) => s.callSheetId === cs.id);
  if (session) {
    if (session.status !== "Closed") return OPEN;
    // A live event's day is closed once the show is over: what it recorded is in Post production.
    const live = db.records.find((r) => r.contentId === session.contentId)?.category === "live";
    return live
      ? { locked: true, why: `${session.name?.trim() || "Day"} (${session.id}) is closed: what it recorded is in Post production.` }
      : { locked: true, why: `Recording session ${session.id} is closed: its episodes are in Post production.` };
  }
  if (cs.instanceId) {
    const day = db.records.find((r) => r.contentId === cs.instanceId);
    return day && pastShooting(day) ? { locked: true, why: `${day.title} has reached Post production.` } : OPEN;
  }
  const linked = cs.linkedEpisodeIds
    .map((id) => db.records.find((r) => r.contentId === id))
    .filter((r): r is ContentRecord => !!r && !r.archived);
  if (linked.length && linked.every(pastShooting)) return { locked: true, why: "Everything on this sheet is in Post production." };
  return OPEN;
}

export const isSheetLocked = (cs: CallSheet): boolean => sheetLock(cs).locked;

/** Refuses a change to a locked sheet, saying why. */
export function assertSheetOpen(cs: CallSheet): void {
  const l = sheetLock(cs);
  if (l.locked) throw new RuleError(`This call sheet is locked. ${l.why}`);
}
