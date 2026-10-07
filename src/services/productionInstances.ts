import type { Actor, CallSheet, RecordingSession } from "../types";
import { getDb } from "../data/store";
import { canView, getRecord } from "./access";
import { sessionName } from "./workflow/plan";
import { fmtDate } from "./utils";

// One view of every production instance: a recording session of a project, and a day of a live event (since data
// version 23 a session too, with its own call sheet and run of show). The Calendar, the urgency report and search read
// instances from here.

export type InstanceStatus = "draft" | "published" | "done" | "cancelled";

export interface ProductionInstance {
  kind: "day" | "session"; // a day of a live event, or a recording session
  id: string; // the session's code
  projectId: string; // the project the session records, or the event
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

/** What a day of a live event is called: its name, with its label. */
function dayLabel(s: RecordingSession): string {
  const name = s.name?.trim() || `Day ${s.sessionNumber}`;
  const label = s.instance?.label ?? s.label;
  return label ? `${name}, ${label}` : name;
}

export function sessionInstance(s: RecordingSession): ProductionInstance {
  const cs = sheetOf(s.callSheetId) ?? getDb().callSheets.find((c) => c.instanceId === s.id);
  const status: InstanceStatus = s.archivedAt
    ? "cancelled"
    : s.status === "Closed"
      ? "done"
      : cs?.status === "final"
        ? "published"
        : "draft";
  const project = getRecord(s.contentId);
  const live = project?.category === "live";
  return {
    kind: live ? "day" : "session",
    id: s.id,
    projectId: s.contentId,
    projectTitle: project?.title ?? s.contentId,
    label: live ? dayLabel(s) : sessionName(s),
    date: s.scheduledDate,
    start: s.startTime || cs?.startTime || cs?.callTime || "",
    end: s.endTime || cs?.wrapTime || "",
    location: cs?.location || s.venue,
    status,
    callSheetId: cs?.id ?? null,
  };
}

/** Every instance of one project or event, in date order (undated last). */
export function instancesOf(projectId: string): ProductionInstance[] {
  return getDb()
    .recordingSessions.filter((s) => s.contentId === projectId)
    .map(sessionInstance)
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.id.localeCompare(b.id));
}

/** Every instance dated within [from, to] that this person may see. */
export function instancesBetween(actor: Actor, from: string, to: string): ProductionInstance[] {
  const out: ProductionInstance[] = [];
  for (const s of getDb().recordingSessions) {
    if (!s.scheduledDate || s.scheduledDate < from || s.scheduledDate > to) continue;
    const p = getRecord(s.contentId);
    if (p && canView(actor, p)) out.push(sessionInstance(s));
  }
  return out.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** An instance in a few words: "Friday Vespers, Fri Oct 9, 2026". */
export const instanceLine = (i: ProductionInstance): string =>
  `${i.projectTitle}, ${i.label}${i.date && !i.label.includes(fmtDate(i.date)) ? `, ${fmtDate(i.date)}` : ""}`;
