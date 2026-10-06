import { createHash } from "node:crypto";
import type { FileDoc, Item } from "./stores";

// How the app's data is laid out in the database.
//
// Each part of the data (people, records, call sheets, the activity log and so on) is a list in the app. In
// the database every element of every list is its own document, so no part can outgrow MongoDB's 16 MB limit
// on one document, and a save writes only the elements that changed. Settings and counters, which are single
// objects, are one document each.

/** Every part of the data that lives in the database. Logins are kept apart, and never appear here. */
export const KEYS = [
  "people",
  "members",
  "records",
  "callSheets",
  "comments",
  "audit",
  "equipment",
  "manifests",
  "incidents",
  "equipmentHistory",
  "drives",
  "allocations",
  "snapshots",
  "docs",
  "docRevisions",
  "outbox",
  // The five-stage workflow (src/config/workflow.ts)
  "developmentForms",
  "plannedEpisodes",
  "projectRoles",
  "workflowChecklistItems",
  "recordingSessions",
  "sessionLogEntries",
  "reviewCheckpoints",
  "shareLinks",
  // Project documents, storyboards and shot lists
  "projectDocuments",
  "documentPages",
  "documentLinks",
  "documentReviews",
  "reviewComments",
  "storyboards",
  "storyboardFrames",
  "shotLists",
  "shotListRows",
  // Productions: recurring shows' templates (data version 19)
  "showTemplates",
  // Saved locations for call sheets (data version 20)
  "locations",
  "settings",
  "counters",
] as const;

/** Single objects rather than lists. */
const SINGLE = new Set<string>(["settings", "counters"]);

/**
 * Logs. Entries are added (and the newest revision of a document is updated while someone keeps typing), but no
 * rule depends on what is in them, so two people writing to them at the same moment is not a conflict. Every
 * other part has a version: a save that would overwrite someone else's change starts again from the newest data.
 */
export const LOG_KEYS = new Set<string>(["audit", "comments", "equipmentHistory", "docRevisions", "outbox", "snapshots"]);

/** The activity log is never loaded in full. Changes only add to it, and people are sent its newest entries. */
export const APPEND_ONLY = new Set<string>(["audit"]);

export const versionedKeys = (): string[] => KEYS.filter((k) => !LOG_KEYS.has(k));
export const loadedKeys = (): string[] => KEYS.filter((k) => !APPEND_ONLY.has(k));

/** The ID of one element within its part. */
export function idOf(key: string, el: unknown): string {
  const x = (el ?? {}) as Record<string, unknown>;
  switch (key) {
    case "people":
      return String(x.personId);
    case "members":
      return `${x.personId}|${x.projectContentId}`;
    case "records":
      return String(x.contentId);
    case "snapshots":
      return String(x.date);
    default:
      return String(x.id);
  }
}

/** A part as its elements. If older data ever repeated an ID, the repeats are told apart as ID#2, ID#3. */
export function elementsOf(key: string, value: unknown): { i: string; d: unknown }[] {
  if (SINGLE.has(key)) return [{ i: "_", d: value ?? {} }];
  const seen = new Map<string, number>();
  return (Array.isArray(value) ? value : []).map((d) => {
    const base = idOf(key, d);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { i: n > 1 ? `${base}#${n}` : base, d };
  });
}

/** Puts the parts back together. `items` must be in order within each part. */
export function assemble(items: Item[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) out[k] = SINGLE.has(k) ? {} : [];
  for (const it of items) {
    if (SINGLE.has(it.k)) out[it.k] = it.d;
    else if (Array.isArray(out[it.k])) (out[it.k] as unknown[]).push(it.d);
  }
  return out;
}

/** All of the data as elements, in the order the app keeps it. */
export function toItems(data: Record<string, unknown>): Item[] {
  return KEYS.flatMap((k) => (k in data ? elementsOf(k, data[k]).map((e, o) => ({ k, i: e.i, o, d: e.d })) : []));
}

// ── Photos ───────────────────────────────────────────────────
// Photos arrive from the browser as data: URLs. Kept inside the data they made every download heavy, so the
// server stores each one as a file and keeps only a link to it.

export const FILE_URL = /^\/api\/file\?id=[a-f0-9]{32}$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

/** A photo given as a data: URL, as a stored file and the link to it. Named after its content, so a copy is stored once. */
export function fileFromDataUrl(url: string): { doc: FileDoc; url: string } | null {
  const m = DATA_URL.exec(url);
  if (!m) return null;
  const id = createHash("sha256").update(url).digest("hex").slice(0, 32);
  return {
    doc: { _id: id, type: m[1], data: m[2], size: Math.floor((m[2].length * 3) / 4), at: new Date().toISOString() },
    url: `/api/file?id=${id}`,
  };
}

/** Replaces every photo given as a data: URL, anywhere in `value`, with a link, and adds the file to `files`. */
export function extractFiles<T>(value: T, files: FileDoc[]): T {
  if (typeof value === "string") {
    if (!value.startsWith("data:image/")) return value;
    const f = fileFromDataUrl(value);
    if (!f) return value;
    files.push(f.doc);
    return f.url as T;
  }
  if (Array.isArray(value)) return value.map((v) => extractFiles(v, files)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, extractFiles(v, files)])) as T;
  return value;
}

/** Data saved in the earlier layout (one document per part, photos inside), as elements and files. */
export function layout1ToItems(data: Record<string, unknown>): { items: Item[]; files: FileDoc[] } {
  const files: FileDoc[] = [];
  const items = toItems(extractFiles(data, files));
  return { items, files };
}
