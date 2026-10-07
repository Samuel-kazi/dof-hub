import type { ContentRecord } from "../../types";
import { getDb } from "../../data/store";

// A project imported from before the system (build prompt v4, section 7A): its dates from before the import are
// history. They show on the Calendar, and stay out of reminders, overdue, the urgency report and Google sync.

/** The project a record answers to: itself if it is one, or the project its episode belongs to. */
function projectFor(r: ContentRecord | undefined): ContentRecord | undefined {
  if (!r) return undefined;
  if (r.workflow) return r;
  return r.parentId ? getDb().records.find((x) => x.contentId === r.parentId && x.workflow) : undefined;
}

/** Whether a date of this record (or its project) is history: before its project was imported. */
export function isHistory(record: ContentRecord | string | undefined, date: string | null | undefined): boolean {
  const r = typeof record === "string" ? getDb().records.find((x) => x.contentId === record) : record;
  const p = projectFor(r);
  if (!p?.workflow?.imported || !date) return false;
  const since = (p.workflow.importedAt ?? "").slice(0, 10);
  return !!since && date.slice(0, 10) <= since;
}

/** Whether a project (or the project of an episode) was imported from before the system. */
export const isImported = (record: ContentRecord | string | undefined): boolean => {
  const r = typeof record === "string" ? getDb().records.find((x) => x.contentId === record) : record;
  return !!projectFor(r)?.workflow?.imported;
};
