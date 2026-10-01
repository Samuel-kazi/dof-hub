import type { CategoryKey, ContentRecord, Database } from "../types";
import { ConflictError } from "../types";
import { categoryOf } from "../config/categories";

// How new IDs are made, so that the browser and the server always agree on them.
//
// Signed in to the server, every change runs twice: first in the browser, so the result shows straight away,
// then on the server, which has the final say. The browser sends along the IDs it gave anything new, and the
// server runs the change expecting exactly those (server/actions.ts):
// - Sequential IDs that people see and quote (DOF-SER-007, DOF-CS-012) come from counters that every browser
//   is sent. If someone else took the next number in the meantime, the server refuses the change instead of
//   saving it under a different ID from the one on screen. The screen refreshes and the person does it again.
// - IDs nobody sees (a checklist item, a link, a photo) are random, made in the browser, and the server keeps
//   them, so two people working at the same moment never collide.

export class IdMismatch extends ConflictError {
  constructor() {
    super(
      "Someone else added something at the same moment, so this change was not saved. Your screen now shows the latest. Please do it again.",
    );
    this.name = "IdMismatch";
  }
}

let recording: string[] | null = null;
let expecting: { ids: string[]; at: number } | null = null;

/** Runs `fn` and returns every ID it gave out, in order. The browser sends these with the change. */
export function recordIds<T>(fn: () => T): { out: T; ids: string[] } {
  const prev = recording;
  const ids: string[] = [];
  recording = ids;
  try {
    return { out: fn(), ids };
  } finally {
    recording = prev;
  }
}

/** Runs `fn` on the server, giving out exactly the IDs the browser showed, or refusing. Without `ids` (an older page), IDs are made as usual. */
export function expectIds<T>(ids: string[] | undefined, fn: () => T): T {
  if (!ids) return fn();
  const prev = expecting;
  const run = { ids, at: 0 };
  expecting = run;
  try {
    const out = fn();
    if (run.at !== ids.length) throw new IdMismatch();
    return out;
  } finally {
    expecting = prev;
  }
}

/** Every new sequential ID that a person might see, or that a later change might refer to, goes through here. */
export function claimId(id: string): string {
  if (expecting) {
    const want = expecting.ids[expecting.at++];
    if (want !== id) throw new IdMismatch();
  }
  recording?.push(id);
  return id;
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
function randomPart(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % 36]).join("");
}

/**
 * A new internal ID, such as T-mf3k9q2xa81c for a checklist item. In the browser it is random; on the server
 * it is the one the browser chose, as long as it is well formed and not already used.
 */
export function localId(prefix: string, taken: (id: string) => boolean = () => false): string {
  let id: string;
  if (expecting) {
    const want = expecting.ids[expecting.at++];
    if (typeof want !== "string" || !new RegExp(`^${prefix}-[a-z0-9]{8,24}$`).test(want) || taken(want)) throw new IdMismatch();
    id = want;
  } else {
    do id = `${prefix}-${Date.now().toString(36)}${randomPart(6)}`;
    while (taken(id));
  }
  recording?.push(id);
  return id;
}

/**
 * An ID for a log entry: the activity log, an item's history, a comment, a document revision, a sent message.
 * Random, and not compared with the browser's, because no change refers to these by ID. Being random rather
 * than numbered means writing a log entry never touches the shared counters, so it never conflicts.
 */
export const logId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}${randomPart(6)}`;

// ── Content IDs ──────────────────────────────────────────────
// A project's number comes from a counter rather than from the highest number on screen, because the
// browser is not sent archived projects, or projects the person cannot see. Counters are sent to everyone.

/** The counter for top-level projects of one category: DOF-SER-007 counts under "record:SER". */
export const topLevelCounter = (category: CategoryKey): string => `record:${categoryOf(category).code}`;
/** The counter for one record's children: the episodes of DOF-SER-001-S1 count under "record:DOF-SER-001-S1". */
export const childCounter = (parentId: string): string => `record:${parentId}`;
/** The letters before a child's number: "S" for a season of a series, "E" for its episodes, and so on. */
export const childToken = (parent: ContentRecord): string => {
  const cfg = categoryOf(parent.category);
  return (parent.hierarchyLevel === 0 ? cfg.childToken : cfg.grandchildToken) ?? "";
};

export const topLevelNumber = (contentId: string): number => parseInt(contentId.split("-")[2], 10);
export const childNumber = (contentId: string, parent: ContentRecord): number =>
  parseInt(contentId.slice(parent.contentId.length + 1 + childToken(parent).length), 10);

/** Raises each project counter to at least the highest number already used, archived projects included. */
export function syncRecordCounters(db: Database): void {
  const byId = new Map(db.records.map((r) => [r.contentId, r]));
  const raise = (key: string, n: number) => {
    if (!Number.isNaN(n) && n > (db.counters[key] ?? 0)) db.counters[key] = n;
  };
  for (const r of db.records) {
    if (r.hierarchyLevel === 0) raise(topLevelCounter(r.category), topLevelNumber(r.contentId));
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    if (parent) raise(childCounter(parent.contentId), childNumber(r.contentId, parent));
  }
}
