import { useSyncExternalStore } from "react";
import type { Database } from "../types";
import { buildSeed } from "./seed";
import { buildGearSeed } from "./seedGear";
import { upgradeToV10, upgradeToV11, upgradeToV12, upgradeToV3, upgradeToV4, upgradeToV5, upgradeToV6, upgradeToV7, upgradeToV8, upgradeToV9 } from "./migrate";

// In-memory store with localStorage persistence.
// This is the ONLY file that knows where data lives. When the real database
// arrives, services keep their signatures and only this layer changes.

const KEY = "dof-hub-db";
const SCHEMA_VERSION = 12;

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

/** Brings saved data of any older version up to the current one. Returns null if it is not recognisable. */
export function upgradeDb(parsed: Database): Database | null {
  switch (parsed.schemaVersion) {
    case SCHEMA_VERSION: return parsed;
    case 1: return upgradeToV12(upgradeToV11(upgradeToV10(upgradeToV9(upgradeToV8(upgradeToV7(upgradeToV6(upgradeToV5(upgradeToV4(upgradeToV3(migrate(parsed)))))))))));
    case 2: return upgradeToV12(upgradeToV11(upgradeToV10(upgradeToV9(upgradeToV8(upgradeToV7(upgradeToV6(upgradeToV5(upgradeToV4(upgradeToV3(parsed))))))))));
    case 3: return upgradeToV12(upgradeToV11(upgradeToV10(upgradeToV9(upgradeToV8(upgradeToV7(upgradeToV6(upgradeToV5(upgradeToV4(parsed)))))))));
    case 4: return upgradeToV12(upgradeToV11(upgradeToV10(upgradeToV9(upgradeToV8(upgradeToV7(upgradeToV6(upgradeToV5(parsed))))))));
    case 5: return upgradeToV12(upgradeToV11(upgradeToV10(upgradeToV9(upgradeToV8(upgradeToV7(upgradeToV6(parsed)))))));
    case 6: return upgradeToV12(upgradeToV11(upgradeToV10(upgradeToV9(upgradeToV8(upgradeToV7(parsed))))));
    case 7: return upgradeToV12(upgradeToV11(upgradeToV10(upgradeToV9(upgradeToV8(parsed)))));
    case 8: return upgradeToV12(upgradeToV11(upgradeToV10(upgradeToV9(parsed))));
    case 9: return upgradeToV12(upgradeToV11(upgradeToV10(parsed)));
    case 10: return upgradeToV12(upgradeToV11(parsed));
    case 11: return upgradeToV12(parsed);
    default: return null;
  }
}

export const CURRENT_SCHEMA = SCHEMA_VERSION;

function load(): Database {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const up = upgradeDb(JSON.parse(raw) as Database);
      if (up) return up;
    }
  } catch {
    /* fall through to seed data */
  }
  return buildSeed();
}

let db: Database = load();
let tick = 0;
const listeners = new Set<() => void>();

export const getDb = (): Database => db;

let saveFailed = false;
/** True when the last save to this device failed, usually because photos filled the space. */
export const didSaveFail = (): boolean => saveFailed;

let persist = true;
/** Signed-in sessions on the server keep data off this device. Only the local demo saves here. */
export const setPersist = (on: boolean): void => { persist = on; };

/** Counts every change. The action recorder uses it to tell a change from a read. */
export const getTick = (): number => tick;

/** Replaces everything, for example with what the server sent. */
export function setDb(next: Database): void {
  db = next;
  tick++;
  listeners.forEach((l) => l());
}

export function commit(): void {
  tick++;
  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
      saveFailed = false;
    } catch {
      saveFailed = true; // keep working in memory, but tell the user
    }
  }
  listeners.forEach((l) => l());
}

export function resetDemoData(): void {
  db = buildSeed();
  commit();
}

export function nextCounter(name: string): number {
  db.counters[name] = (db.counters[name] ?? 0) + 1;
  return db.counters[name];
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Components call this to re-render whenever any data changes.
export function useDb(): Database {
  useSyncExternalStore(subscribe, () => tick, () => tick);
  return db;
}
