import type { Drive } from "../types";
import { getDb } from "../data/store";
import { todayIso } from "./utils";

// Drive usage is always computed from the recorded allocations, never stored.
// This file has no other dependencies, so anything that changes allocations can refresh it.

export const getDrive = (id: string): Drive | undefined => getDb().drives.find((d) => d.id === id);

export interface DriveUsage {
  drive: Drive;
  usedGB: number;
  freeGB: number;
  pct: number;
  otherGB: number;
  // contentId is null for an entry recorded ahead of a real project; label then identifies it instead.
  projects: { contentId: string | null; label: string; gb: number; kinds: string[] }[];
}

export function driveUsage(drive: Drive): DriveUsage {
  const rows = getDb().allocations.filter((a) => a.driveId === drive.id);
  // Real projects group by Content ID (several entries can belong to one project); an entry with no
  // project yet has no such grouping key, so it stands alone under its own allocation id.
  const by = new Map<string, { contentId: string | null; label: string; gb: number; kinds: Set<string> }>();
  for (const a of rows) {
    const key = a.contentId ?? a.id;
    const cur = by.get(key) ?? { contentId: a.contentId, label: a.label, gb: 0, kinds: new Set<string>() };
    cur.gb += a.sizeGB;
    cur.kinds.add(a.kind);
    by.set(key, cur);
  }
  const projects = [...by.values()].map((v) => ({ contentId: v.contentId, label: v.label, gb: v.gb, kinds: [...v.kinds] })).sort((a, b) => b.gb - a.gb);
  const used = drive.otherUsedGB + projects.reduce((n, p) => n + p.gb, 0);
  return { drive, usedGB: used, freeGB: Math.max(0, drive.capacityGB - used), pct: drive.capacityGB ? (used / drive.capacityGB) * 100 : 0, otherGB: drive.otherUsedGB, projects };
}

export const allDriveUsage = (): DriveUsage[] => getDb().drives.map(driveUsage);

export function fleetTotals(): { used: number; capacity: number } {
  const u = allDriveUsage();
  return { used: u.reduce((n, x) => n + x.usedGB, 0), capacity: u.reduce((n, x) => n + x.drive.capacityGB, 0) };
}

export const isNearlyFull = (u: DriveUsage): boolean => u.pct >= getDb().settings.storageWarningThreshold;

/** Records today's fleet total, so the storage forecast follows every change. */
export function recordSnapshot(): void {
  const t = fleetTotals();
  const db = getDb();
  const today = todayIso();
  const existing = db.snapshots.find((s) => s.date === today);
  if (existing) {
    existing.usedGB = t.used;
    existing.capacityGB = t.capacity;
  } else db.snapshots.push({ date: today, usedGB: t.used, capacityGB: t.capacity });
  db.snapshots.sort((a, b) => a.date.localeCompare(b.date));
}

