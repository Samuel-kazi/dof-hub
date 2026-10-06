import type { Actor, CallSheet, ContentRecord, RecordingSession } from "../types";
import { getDb } from "../data/store";
import { categoryOf } from "../config/categories";
import { canView, getRecord } from "./access";
import { isComplete } from "./content";
import { sessionName } from "./workflow/plan";
import { fmtDate } from "./utils";

// One view of every production instance: a day of a live show (a record of its own) and a recording session of a
// series, devotion or documentary (a session). Both have one call sheet, the same sections and a date; underneath they
// stay as they are, so nothing is migrated. The Calendar, the urgency report and search read instances from here.

export type InstanceStatus = "draft" | "published" | "done" | "cancelled";

export interface ProductionInstance {
  kind: "day" | "session";
  id: string; // the day's Content ID, or the session's code
  projectId: string; // the show, or the project the session records
  projectTitle: string;
  label: string; // "Day 2", "Fri Oct 9, 2026", or the session's name
  date: string | null;
  start: string; // HH:MM, or empty
  end: string;
  location: string;
  status: InstanceStatus;
  callSheetId: string | null;
}

const sheetOf = (id: string | null): CallSheet | undefined => (id ? getDb().callSheets.find((c) => c.id === id) : undefined);

/** Where a day of a live show stands: done once its show stage has passed. */
function dayDone(day: ContentRecord): boolean {
  if (isComplete(day)) return true;
  const stages = categoryOf("live").stages.map((s) => s.name);
  const show = stages.indexOf(categoryOf("live").footageStage);
  return show >= 0 && stages.indexOf(day.pipelineStage ?? "") > show;
}

export function dayInstance(day: ContentRecord): ProductionInstance {
  const show = day.parentId ? getRecord(day.parentId) : undefined;
  const cs = getDb().callSheets.find((c) => c.instanceId === day.contentId);
  const status: InstanceStatus = day.archived ? "cancelled" : dayDone(day) ? "done" : cs?.status === "final" ? "published" : "draft";
  return {
    kind: "day",
    id: day.contentId,
    projectId: day.parentId ?? day.contentId,
    projectTitle: show?.title ?? day.title,
    label: day.instance?.label ? `${day.title}, ${day.instance.label}` : day.title,
    date: day.scheduledDate,
    start: cs?.startTime || cs?.callTime || "",
    end: cs?.wrapTime ?? "",
    location: cs?.location ?? "",
    status,
    callSheetId: cs?.id ?? null,
  };
}

export function sessionInstance(s: RecordingSession): ProductionInstance {
  const cs = sheetOf(s.callSheetId);
  const status: InstanceStatus = s.archivedAt
    ? "cancelled"
    : s.status === "Closed"
      ? "done"
      : cs?.status === "final"
        ? "published"
        : "draft";
  return {
    kind: "session",
    id: s.id,
    projectId: s.contentId,
    projectTitle: getRecord(s.contentId)?.title ?? s.contentId,
    label: sessionName(s),
    date: s.scheduledDate,
    start: s.startTime || cs?.callTime || "",
    end: s.endTime || cs?.wrapTime || "",
    location: cs?.location || s.venue,
    status,
    callSheetId: cs?.id ?? null,
  };
}

/** Every instance of one project or show, in date order (undated last). */
export function instancesOf(projectId: string): ProductionInstance[] {
  const db = getDb();
  const days = db.records.filter((r) => r.category === "live" && r.parentId === projectId && r.hierarchyLevel === 1).map(dayInstance);
  const sessions = db.recordingSessions.filter((s) => s.contentId === projectId).map(sessionInstance);
  return [...days, ...sessions].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.id.localeCompare(b.id));
}

/** Every instance dated within [from, to] that this person may see. */
export function instancesBetween(actor: Actor, from: string, to: string): ProductionInstance[] {
  const db = getDb();
  const out: ProductionInstance[] = [];
  for (const r of db.records) {
    if (r.category !== "live" || r.hierarchyLevel !== 1 || !r.scheduledDate || r.scheduledDate < from || r.scheduledDate > to) continue;
    const show = r.parentId ? getRecord(r.parentId) : undefined;
    if (show && canView(actor, show)) out.push(dayInstance(r));
  }
  for (const s of db.recordingSessions) {
    if (!s.scheduledDate || s.scheduledDate < from || s.scheduledDate > to) continue;
    const p = getRecord(s.contentId);
    if (p && canView(actor, p)) out.push(sessionInstance(s));
  }
  return out.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** An instance in a few words: "Friday Vespers, Fri Oct 9, 2026". */
export const instanceLine = (i: ProductionInstance): string =>
  `${i.projectTitle}, ${i.label}${i.date && !i.label.includes(fmtDate(i.date)) ? `, ${fmtDate(i.date)}` : ""}`;
