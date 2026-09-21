import type { Actor, Drive, DriveAllocation, ContentRecord } from "../types";
import { RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { canWrite, getRecord, isHop, selfAndAncestors } from "./access";
import { getChildren, isComplete, leavesUnder } from "./content";
import { logAudit } from "./audit";
import { can, requireCan } from "./permissions";
import { allDriveUsage, driveUsage, fleetTotals, getDrive, recordSnapshot } from "./driveUsage";
import { dayNumber, fmtDate, fmtSize, fromDayNumber, pad, todayIso } from "./utils";

export const hasStorageAccess = (actor: Actor): boolean => can(actor, "storage.use");
function requireStorageAccess(actor: Actor): void {
  if (!hasStorageAccess(actor)) throw new RuleError("Storage is managed by crew and the Head of Production.");
}

export { allDriveUsage, driveUsage, fleetTotals, getDrive, isNearlyFull, recordSnapshot } from "./driveUsage";
export type { DriveUsage } from "./driveUsage";

// ── Drives ───────────────────────────────────────────────────

export interface DriveInput { name: string; capacityGB: number; otherUsedGB?: number; notes?: string }

function validateDrive(input: DriveInput, selfId?: string): void {
  if (!input.name.trim()) throw new RuleError("Give the drive a name.");
  if (getDb().drives.some((d) => d.id !== selfId && d.name.toLowerCase() === input.name.trim().toLowerCase())) throw new RuleError("A drive with that name already exists.");
  if (!Number.isFinite(input.capacityGB) || input.capacityGB <= 0) throw new RuleError("Capacity must be more than zero.");
  if (input.otherUsedGB !== undefined && (!Number.isFinite(input.otherUsedGB) || input.otherUsedGB < 0)) throw new RuleError("Other used space cannot be negative.");
}

export function createDrive(actor: Actor, input: DriveInput): Drive {
  requireCan(actor, "storage.admin", "add drives");
  validateDrive(input);
  const d: Drive = { id: `DRV-${pad(nextCounter("drive"))}`, name: input.name.trim(), capacityGB: input.capacityGB, otherUsedGB: input.otherUsedGB ?? 0, notes: input.notes ?? "" };
  if (d.otherUsedGB > d.capacityGB) throw new RuleError("Used space is larger than the drive.");
  getDb().drives.push(d);
  logAudit(actor, "create", "drive", d.id, d.name);
  recordSnapshot();
  commit();
  return d;
}

export function updateDrive(actor: Actor, id: string, patch: Partial<DriveInput>): Drive {
  requireStorageAccess(actor);
  const d = getDrive(id);
  if (!d) throw new RuleError("Drive not found.");
  const structural = patch.name !== undefined || patch.capacityGB !== undefined;
  if (structural) requireCan(actor, "storage.admin", "rename a drive or change its capacity");
  const next = { name: patch.name ?? d.name, capacityGB: patch.capacityGB ?? d.capacityGB, otherUsedGB: patch.otherUsedGB ?? d.otherUsedGB, notes: patch.notes ?? d.notes };
  validateDrive(next, id);
  const allocated = getDb().allocations.filter((a) => a.driveId === id).reduce((n, a) => n + a.sizeGB, 0);
  if (allocated + next.otherUsedGB > next.capacityGB) throw new RuleError(`That would put ${fmtSize(allocated + next.otherUsedGB)} on a ${fmtSize(next.capacityGB)} drive.`);
  Object.assign(d, { name: next.name.trim(), capacityGB: next.capacityGB, otherUsedGB: next.otherUsedGB, notes: next.notes });
  logAudit(actor, "update", "drive", id, Object.keys(patch).join(", "));
  recordSnapshot();
  commit();
  return d;
}

export function deleteDrive(actor: Actor, id: string): void {
  requireCan(actor, "storage.admin", "remove drives");
  const d = getDrive(id);
  if (!d) throw new RuleError("Drive not found.");
  if (getDb().allocations.some((a) => a.driveId === id)) throw new RuleError("Projects are still recorded on this drive. Remove them first.");
  getDb().drives = getDb().drives.filter((x) => x.id !== id);
  logAudit(actor, "delete", "drive", id, d.name);
  recordSnapshot();
  commit();
}

// ── Allocations (what project occupies which drive) ──────────

export interface AllocationInput { driveId: string; contentId: string; sizeGB: number; kind: DriveAllocation["kind"]; note?: string }

function requireProjectWrite(actor: Actor, contentId: string): ContentRecord {
  const rec = getRecord(contentId);
  if (!rec) throw new RuleError("Choose the project this footage belongs to.");
  if (!canWrite(actor, rec)) throw new RuleError("You are not attached to this project.");
  return rec;
}

export function addAllocation(actor: Actor, input: AllocationInput): DriveAllocation {
  requireStorageAccess(actor);
  const drive = getDrive(input.driveId);
  if (!drive) throw new RuleError("Drive not found.");
  requireProjectWrite(actor, input.contentId);
  if (!Number.isFinite(input.sizeGB) || input.sizeGB <= 0) throw new RuleError("Enter the size in GB.");
  const u = driveUsage(drive);
  if (input.sizeGB > u.freeGB + 1e-6) throw new RuleError(`${drive.name} has only ${fmtSize(u.freeGB)} free.`);
  const a: DriveAllocation = { id: `ALC-${pad(nextCounter("allocation"), 4)}`, driveId: drive.id, contentId: input.contentId, sizeGB: input.sizeGB, kind: input.kind, note: input.note ?? "", updatedAt: todayIso() };
  getDb().allocations.push(a);
  logAudit(actor, "allocate", "drive", drive.id, `${input.contentId} ${fmtSize(a.sizeGB)}`);
  recordSnapshot();
  commit();
  return a;
}

/** Edits the size, type or note, or moves the entry to another drive. Space is checked on the drive it ends up on. */
export function updateAllocation(actor: Actor, id: string, patch: { sizeGB?: number; kind?: DriveAllocation["kind"]; note?: string; driveId?: string }): DriveAllocation {
  requireStorageAccess(actor);
  const a = getDb().allocations.find((x) => x.id === id);
  if (!a) throw new RuleError("Entry not found.");
  requireProjectWrite(actor, a.contentId);
  const target = getDrive(patch.driveId ?? a.driveId);
  if (!target) throw new RuleError("Drive not found.");
  const newSize = patch.sizeGB ?? a.sizeGB;
  if (!Number.isFinite(newSize) || newSize <= 0) throw new RuleError("Enter the size in GB.");
  const u = driveUsage(target);
  const alreadyThere = target.id === a.driveId ? a.sizeGB : 0;
  if (newSize - alreadyThere > u.freeGB + 1e-6) throw new RuleError(`${target.name} has only ${fmtSize(u.freeGB + alreadyThere)} free.`);
  Object.assign(a, patch, { updatedAt: todayIso() });
  logAudit(actor, "update", "allocation", id, Object.keys(patch).join(", "));
  recordSnapshot();
  commit();
  return a;
}

/** Raw footage stays on the drive until every episode it belongs to is Delivered. */
export function removeAllocation(actor: Actor, id: string): void {
  requireStorageAccess(actor);
  const a = getDb().allocations.find((x) => x.id === id);
  if (!a) throw new RuleError("Entry not found.");
  const rec = requireProjectWrite(actor, a.contentId);
  if (a.kind === "raw") {
    const leaves = leavesUnder(rec);
    if (leaves.some((l) => !isComplete(l))) throw new RuleError(`Raw footage for ${rec.title} cannot be removed until everything under it is Delivered.`);
  }
  getDb().allocations = getDb().allocations.filter((x) => x.id !== id);
  logAudit(actor, "deallocate", "drive", a.driveId, `${a.contentId} ${fmtSize(a.sizeGB)}`);
  recordSnapshot();
  commit();
}

/** Clears a record from every drive it is on, for example once it is done. Raw footage waits for Delivered. */
export function clearRecordFromDrives(actor: Actor, contentId: string): { count: number; gb: number } {
  requireStorageAccess(actor);
  const rec = requireProjectWrite(actor, contentId);
  const mine = getDb().allocations.filter((a) => a.contentId === contentId);
  if (!mine.length) throw new RuleError("Nothing is recorded on drives for this item.");
  if (mine.some((a) => a.kind === "raw") && leavesUnder(rec).some((l) => !isComplete(l))) throw new RuleError(`Raw footage for ${rec.title} cannot be cleared until everything under it is Delivered.`);
  const gb = mine.reduce((n, a) => n + a.sizeGB, 0);
  for (const a of mine) logAudit(actor, "deallocate", "drive", a.driveId, `${contentId} ${fmtSize(a.sizeGB)}`);
  getDb().allocations = getDb().allocations.filter((a) => a.contentId !== contentId);
  recordSnapshot();
  commit();
  return { count: mine.length, gb };
}

function descendantIds(r: ContentRecord): string[] {
  return [r.contentId, ...getChildren(r.contentId, true).flatMap(descendantIds)];
}

/** Allocations that belong to this record, to anything under it, or to the show it sits inside. */
export function allocationsForRecord(record: ContentRecord): DriveAllocation[] {
  const ids = new Set([...descendantIds(record), ...selfAndAncestors(record).map((r) => r.contentId)]);
  return getDb().allocations.filter((a) => ids.has(a.contentId));
}

// ── Forecast ─────────────────────────────────────────────────

export interface Forecast {
  history: { date: string; usedGB: number }[];
  projected: { date: string; usedGB: number }[];
  capacityGB: number;
  thresholdGB: number;
  slopeGBPerDay: number;
  fillDate: string | null;
}

export function forecast(horizonDays = 90): Forecast {
  const t = fleetTotals();
  const snaps = getDb().snapshots.slice(-16);
  const history = snaps.map((s) => ({ date: s.date, usedGB: s.usedGB }));
  const thresholdGB = (t.capacity * getDb().settings.storageWarningThreshold) / 100;
  let slope = 0;
  if (snaps.length >= 2) {
    const xs = snaps.map((s) => dayNumber(s.date));
    const ys = snaps.map((s) => s.usedGB);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const den = xs.reduce((n, x) => n + (x - mx) ** 2, 0);
    slope = den ? xs.reduce((n, x, i) => n + (x - mx) * (ys[i] - my), 0) / den : 0;
  }
  const today = dayNumber(todayIso());
  const projected: { date: string; usedGB: number }[] = [{ date: todayIso(), usedGB: t.used }];
  if (slope > 0) for (let d = 7; d <= horizonDays; d += 7) projected.push({ date: fromDayNumber(today + d), usedGB: Math.min(t.capacity * 1.05, t.used + slope * d) });
  let fillDate: string | null = null;
  if (slope > 0 && t.used < thresholdGB) fillDate = fromDayNumber(today + Math.ceil((thresholdGB - t.used) / slope));
  else if (t.used >= thresholdGB) fillDate = todayIso();
  return { history, projected, capacityGB: t.capacity, thresholdGB, slopeGBPerDay: slope, fillDate };
}

// ── Reports (plain text so they can be copied or printed) ────

export function driveReportText(driveId: string): string {
  const d = getDrive(driveId);
  if (!d) throw new RuleError("Drive not found.");
  const u = driveUsage(d);
  const lines = [
    `Drive report: ${d.name}`,
    `Date: ${fmtDate(todayIso())}`,
    `Capacity ${fmtSize(d.capacityGB)}, used ${fmtSize(u.usedGB)} (${u.pct.toFixed(1)}%), free ${fmtSize(u.freeGB)}`,
    "",
    "Projects on this drive:",
    ...(u.projects.length ? u.projects.map((p) => `  ${p.contentId}  ${getRecord(p.contentId)?.title ?? ""}  ${fmtSize(p.gb)}  (${p.kinds.join(", ")})`) : ["  None recorded"]),
    ...(u.otherGB ? [`  Other files  ${fmtSize(u.otherGB)}`] : []),
  ];
  return lines.join("\n");
}

export function fleetReportText(): string {
  const t = fleetTotals();
  const rows = allDriveUsage();
  return [
    "Storage report: all drives",
    `Date: ${fmtDate(todayIso())}`,
    `Total capacity ${fmtSize(t.capacity)}, used ${fmtSize(t.used)}, free ${fmtSize(t.capacity - t.used)}`,
    "",
    ...rows.map((u) => `${u.drive.name}: ${fmtSize(u.usedGB)} of ${fmtSize(u.drive.capacityGB)} (${u.pct.toFixed(0)}%)${u.projects.length ? `. Projects: ${u.projects.map((p) => `${p.contentId} ${fmtSize(p.gb)}`).join(", ")}` : ""}`),
  ].join("\n");
}
