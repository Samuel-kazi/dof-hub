import type { Database, SheetContent } from "../types";
import { REHEARSAL_STEPS, blankStep } from "../config/callSheet";
import { localId } from "./ids";

// Data version 24 (build prompt v4): the Recording Log, storage assigned in Production, and the rest of this round.
// Nothing is deleted and no record is made or lost. Running it again changes nothing.
//
//   - A session's recorded footage, entered on a drive before, is its main drive in the Recording Log ("primary").
//   - A Recording Plan's "Cards and storage" page is called "Cards": the drive is no longer chosen in Pre-production,
//     but in each session's Recording Log. The page keeps what was written on it. (The drive chosen there is kept on
//     the project and offered first in the Recording Log.)
//   - Live shows (build prompt v4, section 9): their documents take their new names where they kept the old ones
//     (Event Brief is the Show Plan, Recording Plan the Broadcast Plan, Show Day Sheet the Live Day, Show Report the
//     Production Report); every line of a live day's technical check gets its state from its tick (ticked is OK, not
//     ticked is Not checked); and the days still to come, and recurring shows' templates, get the Rehearsal Log's steps.

export interface V24Change {
  lines: string[]; // what it does, in words, for the dry run (npm run db:upgrade)
  changed: boolean;
}

/** What version 24 changes, without changing anything: for the dry run. */
export function v24Plan(db: Database): string[] {
  return toV24(structuredClone(db)).lines;
}

/** Makes the changes in place. */
export function toV24(db: Database): V24Change {
  const lines: string[] = [];
  const footage = db.allocations.filter((a) => a.sessionId && !a.role);
  for (const a of footage) a.role = "primary";
  if (footage.length)
    lines.push(
      `${footage.length} session footage ${footage.length === 1 ? "entry becomes its" : "entries become their"} session's main drive in the Recording Log`,
    );
  const plans = new Set(db.projectDocuments.filter((d) => d.docKey === "recording_plan").map((d) => d.id));
  const pages = db.documentPages.filter((p) => plans.has(p.documentId) && p.title === "Cards and storage");
  for (const p of pages) p.title = "Cards";
  if (pages.length)
    lines.push(
      `${pages.length} Recording Plan ${pages.length === 1 ? "page" : "pages"} "Cards and storage" renamed "Cards" (storage is now chosen in Production)`,
    );
  liveShows(db, lines);
  return { lines, changed: lines.length > 0 };
}

const LIVE_TITLES: Record<string, [string, string]> = {
  event_brief: ["Event Brief", "Show Plan"],
  recording_plan: ["Recording Plan", "Broadcast Plan"],
  show_day_sheet: ["Show Day Sheet", "Live Day"],
  show_report: ["Show Report", "Production Report"],
};

function liveShows(db: Database, lines: string[]): void {
  const live = new Set(db.records.filter((r) => r.category === "live" && r.workflow).map((r) => r.contentId));
  if (!live.size) return;
  // The documents' new names, where they kept the old ones; a document someone renamed keeps its own name.
  let renamed = 0;
  for (const d of db.projectDocuments) {
    const t = LIVE_TITLES[d.docKey];
    if (!t || !live.has(d.contentId) || !d.title.startsWith(t[0])) continue;
    d.title = t[1] + d.title.slice(t[0].length);
    renamed++;
  }
  if (renamed)
    lines.push(
      `${renamed} live show ${renamed === 1 ? "document takes its" : "documents take their"} new name (Show Plan, Broadcast Plan, Live Day, Production Report)`,
    );
  // A live day's sheet, and a recurring show's template: the Tech Check's states, and the Rehearsal Log's steps.
  const days = db.recordingSessions.filter((s) => live.has(s.contentId));
  const sheets: { content: SheetContent; upcoming: boolean }[] = [
    ...db.callSheets
      .map((c) => ({ c, day: days.find((d) => d.callSheetId === c.id || c.instanceId === d.id) }))
      .filter((x) => !!x.day)
      .map((x) => ({ content: x.c as SheetContent, upcoming: x.day!.status !== "Closed" && !x.day!.archivedAt })),
    ...(db.showTemplates ?? []).filter((t) => live.has(t.contentId)).map((t) => ({ content: t.sheet, upcoming: true })),
  ];
  let states = 0;
  let stepped = 0;
  for (const { content, upcoming } of sheets) {
    for (const c of content.technicalCheck)
      if (c.state === undefined) {
        c.state = c.done ? "OK" : "Not checked";
        c.assigneeId ??= null;
        c.equipmentId ??= null;
        c.result ??= "";
        states++;
      }
    if (upcoming && !content.rehearsal.steps) {
      content.rehearsal.steps = REHEARSAL_STEPS.map((step) => blankStep(localId("RH"), step));
      stepped++;
    }
  }
  if (states)
    lines.push(
      `${states} live Tech Check ${states === 1 ? "line gets its state" : "lines get their state"} from ${states === 1 ? "its" : "their"} tick`,
    );
  if (stepped) lines.push(`${stepped} live ${stepped === 1 ? "day or template gets" : "days and templates get"} the Rehearsal Log's steps`);
}
