import type { Database } from "../types";

// Data version 24 (build prompt v4): the Recording Log, storage assigned in Production, and the rest of this round.
// Nothing is deleted and no record is made or lost. Running it again changes nothing.
//
//   - A session's recorded footage, entered on a drive before, is its main drive in the Recording Log ("primary").
//   - A Recording Plan's "Cards and storage" page is called "Cards": the drive is no longer chosen in Pre-production,
//     but in each session's Recording Log. The page keeps what was written on it. (The drive chosen there is kept on
//     the project and offered first in the Recording Log.)

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
  return { lines, changed: lines.length > 0 };
}
