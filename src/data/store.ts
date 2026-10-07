import { useSyncExternalStore } from "react";
import type { Database } from "../types";
import { buildSampleData } from "./sampleData";
import { buildGearSeed } from "./seedGear";
import { assertIntegrity } from "./constraints";
import {
  upgradeToV10,
  upgradeToV11,
  upgradeToV12,
  upgradeToV13,
  upgradeToV14,
  upgradeToV15,
  upgradeToV16,
  upgradeToV17,
  upgradeToV18,
  upgradeToV19,
  upgradeToV20,
  upgradeToV21,
  upgradeToV22,
  upgradeToV23,
  upgradeToV24,
  upgradeToV3,
  upgradeToV4,
  upgradeToV5,
  upgradeToV6,
  upgradeToV7,
  upgradeToV8,
  upgradeToV9,
} from "./migrate";

// In-memory store with localStorage persistence.
// This is the ONLY file that knows where data lives. When the real database
// arrives, services keep their signatures and only this layer changes.

const KEY = "dof-hub-db";
const SCHEMA_VERSION = 24;

/** Older saved data keeps everything it has and gains the new modules with sample data. */
function migrate(old: Database): Database {
  const gear = buildGearSeed();
  const next: Database = {
    ...gear,
    ...old,
    equipment: old.equipment ?? gear.equipment,
    manifests: old.manifests ?? gear.manifests,
    incidents: old.incidents ?? gear.incidents,
    equipmentHistory: old.equipmentHistory ?? gear.equipmentHistory,
    drives: old.drives ?? gear.drives,
    allocations: old.allocations ?? gear.allocations,
    snapshots: old.snapshots ?? gear.snapshots,
    counters: { ...gear.counters, ...old.counters },
    settings: Object.assign({ stageReminderHours: 24, storageWarningThreshold: 85, checkoutReturnDays: 3 }, old.settings),
    schemaVersion: 2,
  };
  // Keep call sheet links honest: a checkout list must point at a sheet that still exists.
  for (const m of next.manifests) {
    const cs = m.callSheetId ? next.callSheets.find((c) => c.id === m.callSheetId) : undefined;
    if (m.callSheetId && !cs) m.callSheetId = null;
    if (cs && m.status !== "released") cs.equipmentIds = m.lines.map((l) => l.equipmentId);
  }
  next.manifests = next.manifests.filter((m) => next.records.some((r) => r.contentId === m.contentId));
  return next;
}

/** Each upgrade step, by the version it starts from. Each one sets the version it brings the data to. */
const UPGRADES: Record<number, (db: Database) => Database> = {
  2: upgradeToV3,
  3: upgradeToV4,
  4: upgradeToV5,
  5: upgradeToV6,
  6: upgradeToV7,
  7: upgradeToV8,
  8: upgradeToV9,
  9: upgradeToV10,
  10: upgradeToV11,
  11: upgradeToV12,
  12: upgradeToV13,
  13: upgradeToV14,
  14: upgradeToV15,
  15: upgradeToV16,
  16: upgradeToV17,
  17: upgradeToV18,
  18: upgradeToV19,
  19: upgradeToV20,
  20: upgradeToV21,
  21: upgradeToV22,
  22: upgradeToV23,
  23: upgradeToV24,
};

/** Brings saved data of any older version up to the current one. Returns null if it is not recognisable. */
export function upgradeDb(parsed: Database): Database | null {
  let db = parsed.schemaVersion === 1 ? migrate(parsed) : parsed;
  if (typeof db.schemaVersion !== "number" || db.schemaVersion < 2 || db.schemaVersion > SCHEMA_VERSION) return null;
  while (db.schemaVersion < SCHEMA_VERSION) {
    const from = db.schemaVersion;
    db = UPGRADES[from](db);
    if (db.schemaVersion <= from) throw new Error(`The upgrade from version ${from} did not set the version it brings the data to.`);
  }
  return db;
}

export const CURRENT_SCHEMA = SCHEMA_VERSION;

/**
 * Before saved data is upgraded, or set aside because it cannot be read, a copy is kept next to it, so the
 * desktop app and the demo never lose what was saved. If there is no room for the copy, the upgrade still
 * goes ahead: it only adds, and the original stays where it is until the next save.
 */
function keepCopy(raw: string, label: string): void {
  try {
    localStorage.setItem(`${KEY}-${label}`, raw);
  } catch {
    console.warn(`No room to keep a copy of the saved data (${label}).`);
  }
}

/**
 * Keeps a copy of everything as it is now, next to the saved data, before a change that rewrites it (moving projects
 * into the five-stage workflow). Unlike the copy before an upgrade, the change must not go ahead without it, so
 * this gives where the copy is, or null if there was no room.
 */
export function keepCopyOfData(label: string): string | null {
  try {
    localStorage.setItem(`${KEY}-${label}`, JSON.stringify(db));
    return `${KEY}-${label}`;
  } catch {
    return null;
  }
}

function load(): Database {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Database;
      const older = parsed.schemaVersion !== SCHEMA_VERSION;
      if (older) keepCopy(raw, `before-v${SCHEMA_VERSION}`);
      const up = upgradeDb(parsed);
      if (up) {
        // Saved at once, so what the upgrade made (documents moved from the old forms) is the same on the next load.
        if (older && persist) {
          try {
            localStorage.setItem(KEY, JSON.stringify(up));
          } catch {
            /* kept in memory; saved with the next change */
          }
        }
        return up;
      }
      keepCopy(raw, "unreadable");
    }
  } catch {
    /* fall through to the sample data */
  }
  return buildSampleData();
}

// Loaded on first use, not when this file loads: the sample data is built by the move into the workflow, whose own
// files may still be loading at that moment.
let db: Database | undefined;
const data = (): Database => (db ??= load());
let tick = 0;
const listeners = new Set<() => void>();

export const getDb = (): Database => data();

let saveFailed = false;
/** True when the last save to this device failed, usually because photos filled the space. */
export const didSaveFail = (): boolean => saveFailed;

let persist = true;
/** Signed-in sessions on the server keep data off this device. Only the local demo saves here. */
export const setPersist = (on: boolean): void => {
  persist = on;
};

/** Counts every change. The action recorder uses it to tell a change from a read. */
export const getTick = (): number => tick;

/** Replaces everything, for example with what the server sent. */
export function setDb(next: Database): void {
  db = next;
  if (rollback) committed = JSON.stringify(next);
  tick++;
  listeners.forEach((l) => l());
}

// ── Changes are all or nothing ───────────────────────────────
// Every change a person makes runs inside transaction() (see src/data/rpc.ts). Saves inside it wait until it
// ends, and if anything in it fails, the data goes back to how it was before it started, with nothing saved.
// On the server, the same is true of every change by construction: it is made on a copy that is only saved if
// the whole change succeeds (server/state.ts).

let rollback = false;
let committed: string | null = null; // the data as last saved or received, to go back to
let depth = 0;
let dirty = false;

/** Turns on going back after a failed change. The browser does; the server has its own way. */
export function enableRollback(): void {
  rollback = true;
  committed = JSON.stringify(data());
}

function restore(): void {
  if (!rollback || committed === null) return;
  if (JSON.stringify(data()) === committed) return; // nothing was changed, so nothing to undo or redraw
  db = JSON.parse(committed) as Database;
  tick++;
  listeners.forEach((l) => l());
}

export function transaction<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth = 1;
  let out: T;
  try {
    out = fn();
    // Kept on this device, this is the whole of the data, so the data's own rules are checked before it is
    // saved. Signed in to the server, the server checks them against everything, including what this person
    // is not sent.
    if (dirty && persist) assertIntegrity(data());
  } catch (e) {
    depth = 0;
    dirty = false;
    restore();
    throw e;
  }
  depth = 0;
  if (dirty) {
    dirty = false;
    save();
  }
  return out;
}

export function commit(): void {
  if (depth > 0) dirty = true;
  else save();
}

function save(): void {
  tick++;
  const json = persist || rollback ? JSON.stringify(data()) : null;
  if (persist && json !== null) {
    try {
      localStorage.setItem(KEY, json);
      saveFailed = false;
    } catch {
      saveFailed = true; // keep working in memory, but tell the user
    }
  }
  if (rollback) committed = json;
  listeners.forEach((l) => l());
}

export function resetDemoData(): void {
  db = buildSampleData();
  commit();
}

export function nextCounter(name: string): number {
  const counters = data().counters;
  counters[name] = (counters[name] ?? 0) + 1;
  return counters[name];
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Components call this to re-render whenever any data changes.
export function useDb(): Database {
  useSyncExternalStore(
    subscribe,
    () => tick,
    () => tick,
  );
  return data();
}
