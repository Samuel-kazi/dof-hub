import type { Actor, Attachment, EquipCategoryKey, EquipCondition, EquipmentHistory, EquipmentItem, Manifest, TrackingType } from "../types";
import { RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { CONDITIONS, equipCategory } from "../config/equipment";
import { canView, getRecord } from "./access";
import { logAudit } from "./audit";
import { can, requireCan } from "./permissions";
import { fmtShort, pad, todayIso } from "./utils";

// ── Access ───────────────────────────────────────────────────

export const hasGearAccess = (actor: Actor): boolean => can(actor, "equipment.use");
export function requireGearAccess(actor: Actor): void {
  if (!hasGearAccess(actor)) throw new RuleError("Equipment is managed by crew and the Head of Production. Ask the Head of Production for access.");
}
function requireHop(actor: Actor, what: string): void {
  requireCan(actor, "equipment.admin", what);
}

/** Project title if this person can see the project, otherwise just the Content ID. */
export function projectLabel(actor: Actor, contentId: string): string {
  const r = getRecord(contentId);
  return r && canView(actor, r) ? r.title : contentId;
}

// ── Small helpers ────────────────────────────────────────────

export const getItem = (id: string): EquipmentItem | undefined => getDb().equipment.find((e) => e.id === id);
const isActive = (m: Manifest) => m.status === "assigned" || m.status === "checked-out";

// ── Condition breakdown (aggregate/batch items only) ────────────
// A batch has no unit identity, so "which one is faulty" is tracked as counts per condition
// (for example 8 Good, 2 Fair) rather than by a specific physical unit.

export type ConditionBreakdown = Partial<Record<EquipCondition, number>>;

export const breakdownTotal = (bd: ConditionBreakdown): number => CONDITIONS.reduce((n, c) => n + (bd[c] ?? 0), 0);

/** The worst condition with at least one unit in it, or null for an empty breakdown. */
export function worstCondition(bd: ConditionBreakdown): EquipCondition | null {
  for (let i = CONDITIONS.length - 1; i >= 0; i--) if ((bd[CONDITIONS[i]] ?? 0) > 0) return CONDITIONS[i];
  return null;
}

/** Removes `n` units from a breakdown, taking from the worst condition present first. Used when units are damaged, lost, or a batch's quantity is reduced. */
export function removeWorstFirst(bd: ConditionBreakdown, n: number): ConditionBreakdown {
  const next = { ...bd };
  let left = n;
  for (let i = CONDITIONS.length - 1; i >= 0 && left > 0; i--) {
    const c = CONDITIONS[i];
    const have = next[c] ?? 0;
    const take = Math.min(have, left);
    if (take > 0) {
      next[c] = have - take;
      if (next[c] === 0) delete next[c];
      left -= take;
    }
  }
  return next;
}

/**
 * Removes `n` units, preferring the given condition first (typically the condition they were checked
 * out at), then whatever is worst for any remainder. Always removes exactly `n` when the breakdown
 * holds at least that many, keeping the total exact rather than approximate.
 */
export function removeFromThenWorst(bd: ConditionBreakdown, first: EquipCondition, n: number): ConditionBreakdown {
  const have = bd[first] ?? 0;
  const take = Math.min(have, n);
  let next = bd;
  if (take > 0) {
    next = { ...bd, [first]: have - take };
    if (next[first] === 0) delete next[first];
  }
  const remaining = n - take;
  return remaining > 0 ? removeWorstFirst(next, remaining) : next;
}

/** Adds `n` units to a breakdown, in the given condition (defaulting to the best condition present, or New for an empty breakdown). */
export function addUnits(bd: ConditionBreakdown, n: number, into?: EquipCondition): ConditionBreakdown {
  if (n <= 0) return bd;
  const target = into ?? worstCondition(bd) ?? "New";
  return { ...bd, [target]: (bd[target] ?? 0) + n };
}

export function applyConditionBreakdown(item: EquipmentItem, bd: ConditionBreakdown): void {
  item.conditionBreakdown = bd;
  item.condition = worstCondition(bd) ?? item.condition;
}
export const familyOf = (i: EquipmentItem): string => (i.itemFamily ? i.itemFamily.toUpperCase() : i.id);

function hist(actor: Actor, equipmentId: string, kind: EquipmentHistory["kind"], detail: string, extra: { contentId?: string; manifestId?: string } = {}): void {
  getDb().equipmentHistory.push({
    id: `H-${pad(nextCounter("history"), 5)}`,
    equipmentId,
    at: new Date().toISOString(),
    byPersonId: actor.personId,
    kind,
    detail,
    contentId: extra.contentId ?? null,
    manifestId: extra.manifestId ?? null,
  });
}

function makeAttachment(actor: Actor, input: { url: string; caption?: string }): Attachment {
  const url = input.url.trim();
  if (!url) throw new RuleError("Add a photo or paste a link.");
  if (url.startsWith("data:")) {
    if (!url.startsWith("data:image/")) throw new RuleError("Only images can be attached.");
    if (url.length > 420_000) throw new RuleError("That image is too large. Try a smaller photo.");
  } else if (!/^https?:\/\//i.test(url)) {
    throw new RuleError("Links must start with http:// or https://.");
  }
  return { id: `ATT-${pad(nextCounter("attachment"), 5)}`, url, caption: (input.caption ?? "").trim(), at: new Date().toISOString(), byPersonId: actor.personId };
}

// ── Quantities, status and availability (all computed, never stored) ──

function qtyIn(item: EquipmentItem, status: Manifest["status"]): number {
  let n = 0;
  for (const m of getDb().manifests) {
    if (m.status !== status) continue;
    for (const l of m.lines) if (l.equipmentId === item.id) n += l.quantity;
  }
  return n;
}
export const qtyOut = (i: EquipmentItem): number => qtyIn(i, "checked-out");
export const qtyAssigned = (i: EquipmentItem): number => qtyIn(i, "assigned");
export const qtyFree = (i: EquipmentItem): number => (i.baseStatus === "active" ? Math.max(0, i.quantityTotal - qtyOut(i) - qtyAssigned(i)) : 0);

export function isOverdue(m: Manifest): boolean {
  return m.status === "checked-out" && !!m.expectedReturn && m.expectedReturn < todayIso();
}

/** A checked-out manifest occupies its items until it is checked in, even past the planned return. */
export function endOf(m: Manifest): string {
  const planned = m.expectedReturn ?? m.date;
  if (m.status === "checked-out") {
    const t = todayIso();
    return planned < t ? t : planned;
  }
  return planned;
}

export interface Availability {
  state: "ok" | "partial" | "conflict" | "repair" | "retired" | "lost";
  availableQty: number;
  conflicts: Manifest[];
  reason: string;
}

export function availabilityOn(item: EquipmentItem, from: string, to: string, excludeManifestId?: string): Availability {
  if (item.baseStatus === "in-repair") return { state: "repair", availableQty: 0, conflicts: [], reason: "In repair" };
  if (item.baseStatus === "retired") return { state: "retired", availableQty: 0, conflicts: [], reason: "Retired" };
  if (item.baseStatus === "lost") return { state: "lost", availableQty: 0, conflicts: [], reason: "Lost" };
  const conflicts = getDb().manifests.filter((m) => isActive(m) && m.id !== excludeManifestId && m.lines.some((l) => l.equipmentId === item.id) && m.date <= to && from <= endOf(m));
  const booked = conflicts.reduce((n, m) => n + m.lines.filter((l) => l.equipmentId === item.id).reduce((a, l) => a + l.quantity, 0), 0);
  const availableQty = Math.max(0, item.quantityTotal - booked);
  if (availableQty === 0) {
    const c = conflicts[0];
    return { state: "conflict", availableQty, conflicts, reason: c ? `Booked for ${c.contentId}, ${fmtShort(c.date)}${endOf(c) !== c.date ? ` to ${fmtShort(endOf(c))}` : ""}` : "Not available" };
  }
  return { state: booked > 0 ? "partial" : "ok", availableQty, conflicts, reason: booked > 0 ? `${booked} booked elsewhere` : "" };
}

export interface StatusView {
  label: string;
  tone: "ok" | "warn" | "bad" | "accent" | "";
  detail: string;
}

export function displayStatus(item: EquipmentItem): StatusView {
  if (item.baseStatus === "lost") return { label: "Lost", tone: "bad", detail: "" };
  if (item.baseStatus === "retired") return { label: "Retired", tone: "", detail: "" };
  if (item.baseStatus === "in-repair") return { label: "In repair", tone: "warn", detail: "" };
  const out = qtyOut(item);
  const asg = qtyAssigned(item);
  const overdue = getDb().manifests.some((m) => isOverdue(m) && m.lines.some((l) => l.equipmentId === item.id));
  if (item.trackingType === "serialized") {
    if (out) return overdue ? { label: "Overdue", tone: "bad", detail: "Not returned" } : { label: "Checked out", tone: "accent", detail: "" };
    if (asg) return { label: "Assigned", tone: "accent", detail: "In studio, reserved" };
    return { label: "Available", tone: "ok", detail: "" };
  }
  const free = qtyFree(item);
  const detail = `${free} of ${item.quantityTotal} free`;
  if (overdue) return { label: "Overdue", tone: "bad", detail };
  if (free > 0) return { label: "Available", tone: "ok", detail };
  return { label: out ? "All out" : "All assigned", tone: "accent", detail };
}

// ── Items ────────────────────────────────────────────────────

export interface ItemInput {
  trackingType: TrackingType;
  name: string;
  make: string;
  model: string;
  category: EquipCategoryKey;
  itemFamily?: string;
  serialNumber?: string;
  unitLabel?: string;
  quantity?: number;
  unitCost: number;
  purchaseDate?: string | null;
  vendor: string;
  condition: EquipCondition;
  packaging: string;
  accessories: string;
  info: string;
}

function nextAssetCode(cat: EquipCategoryKey): string {
  const prefix = `DOF-EQ-${equipCategory(cat).code}-`;
  const nums = getDb().equipment.filter((e) => e.trackingType === "serialized" && e.id.startsWith(prefix)).map((e) => parseInt(e.id.slice(prefix.length), 10)).filter((n) => !Number.isNaN(n));
  return `${prefix}${pad((nums.length ? Math.max(...nums) : 0) + 1)}`;
}

/** The next `count` asset codes for this category, in order, as if reserved one after another. */
function nextAssetCodes(cat: EquipCategoryKey, count: number): string[] {
  const prefix = `DOF-EQ-${equipCategory(cat).code}-`;
  const nums = getDb().equipment.filter((e) => e.trackingType === "serialized" && e.id.startsWith(prefix)).map((e) => parseInt(e.id.slice(prefix.length), 10)).filter((n) => !Number.isNaN(n));
  const start = (nums.length ? Math.max(...nums) : 0) + 1;
  return Array.from({ length: count }, (_, i) => `${prefix}${pad(start + i)}`);
}
function nextBatchCode(cat: EquipCategoryKey, family: string): string {
  const token = family.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefix = `DOF-EQ-${equipCategory(cat).code}-${token}-B`;
  const nums = getDb().equipment.filter((e) => e.trackingType === "aggregate" && e.id.startsWith(prefix)).map((e) => parseInt(e.id.slice(prefix.length), 10)).filter((n) => !Number.isNaN(n));
  return `${prefix}${pad((nums.length ? Math.max(...nums) : 0) + 1, 2)}`;
}

export function createItem(actor: Actor, input: ItemInput): EquipmentItem {
  requireGearAccess(actor);
  if (!input.name.trim()) throw new RuleError("Give the item a name.");
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) throw new RuleError("Cost must be zero or more.");
  const serial = (input.serialNumber ?? "").trim();
  const family = (input.itemFamily ?? "").trim();
  let quantity = 1;
  if (input.trackingType === "serialized") {
    if (serial) {
      const dupe = getDb().equipment.find((e) => e.serialNumber && e.serialNumber.toLowerCase() === serial.toLowerCase());
      if (dupe) throw new RuleError(`Serial number ${serial} is already registered as ${dupe.id}.`);
    }
  } else {
    if (!family) throw new RuleError("Give this batch an item family, for example XLR-10M, so batches group together.");
    quantity = input.quantity ?? 0;
    if (!Number.isInteger(quantity) || quantity < 1) throw new RuleError("Quantity must be a whole number of at least 1.");
  }
  const item: EquipmentItem = {
    id: input.trackingType === "serialized" ? nextAssetCode(input.category) : nextBatchCode(input.category, family),
    trackingType: input.trackingType,
    name: input.name.trim(),
    make: input.make.trim(),
    model: input.model.trim(),
    category: input.category,
    itemFamily: input.trackingType === "aggregate" ? family : null,
    serialNumber: input.trackingType === "serialized" ? (serial || null) : null,
    unitLabel: input.trackingType === "serialized" ? (input.unitLabel ?? "").trim() || null : null,
    quantityTotal: quantity,
    quantityDamaged: 0,
    quantityLost: 0,
    unitCost: input.unitCost,
    purchaseDate: input.purchaseDate || null,
    vendor: input.vendor.trim(),
    condition: input.condition,
    conditionBreakdown: input.trackingType === "aggregate" ? { [input.condition]: quantity } : null,
    packaging: input.packaging.trim(),
    accessories: input.accessories.trim(),
    info: input.info.trim(),
    photos: [],
    receipts: [],
    baseStatus: "active",
    createdAt: new Date().toISOString(),
  };
  getDb().equipment.push(item);
  hist(actor, item.id, "created", input.trackingType === "aggregate" ? `New batch of ${quantity}` : "Added to inventory");
  logAudit(actor, "create", "equipment", item.id, item.name);
  commit();
  return item;
}

export interface UnitInput { serialNumber: string; label?: string }

export interface UnitsInput {
  name: string;
  make: string;
  model: string;
  category: EquipCategoryKey;
  unitCost: number;
  purchaseDate?: string | null;
  vendor: string;
  condition: EquipCondition;
  packaging: string;
  accessories: string;
  info: string;
  units: UnitInput[];
}

/**
 * Several identical units of the same equipment (for example three Sony FX6 bodies), added in one go.
 * The general details are typed once; each unit gets its own serial number, an optional label, and its own asset code.
 * All or nothing: if any serial number is missing, repeated in the list, or already in the inventory, nothing is added.
 */
export function createSerializedUnits(actor: Actor, input: UnitsInput): EquipmentItem[] {
  requireGearAccess(actor);
  if (!input.name.trim()) throw new RuleError("Give the item a name.");
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) throw new RuleError("Cost must be zero or more.");
  if (input.units.length < 1) throw new RuleError("Add at least one serial number.");
  if (input.units.length > 200) throw new RuleError("Add units in smaller groups of 200 or fewer.");

  const seen = new Map<string, number>(); // lowercase serial -> position, to catch repeats within this list
  const cleaned = input.units.map((u, i) => {
    const serial = u.serialNumber.trim();
    if (serial) {
      const key = serial.toLowerCase();
      if (seen.has(key)) throw new RuleError(`Serial number ${serial} is entered twice, for unit ${seen.get(key)! + 1} and unit ${i + 1}.`);
      seen.set(key, i);
      const existing = getDb().equipment.find((e) => e.serialNumber && e.serialNumber.toLowerCase() === key);
      if (existing) throw new RuleError(`Serial number ${serial} is already registered as ${existing.id} (${existing.name}).`);
    }
    return { serial: serial || null, label: (u.label ?? "").trim() || null };
  });

  const codes = nextAssetCodes(input.category, cleaned.length);
  const now = new Date().toISOString();
  const items: EquipmentItem[] = cleaned.map((u, i) => ({
    id: codes[i],
    trackingType: "serialized",
    name: input.name.trim(),
    make: input.make.trim(),
    model: input.model.trim(),
    category: input.category,
    itemFamily: null,
    serialNumber: u.serial,
    unitLabel: u.label,
    quantityTotal: 1,
    quantityDamaged: 0,
    quantityLost: 0,
    unitCost: input.unitCost,
    purchaseDate: input.purchaseDate || null,
    vendor: input.vendor.trim(),
    condition: input.condition,
    conditionBreakdown: null,
    packaging: input.packaging.trim(),
    accessories: input.accessories.trim(),
    info: input.info.trim(),
    photos: [],
    receipts: [],
    baseStatus: "active",
    createdAt: now,
  }));

  getDb().equipment.push(...items);
  for (const it of items) {
    hist(actor, it.id, "created", cleaned.length > 1 ? `Added with ${cleaned.length - 1} other unit${cleaned.length - 1 === 1 ? "" : "s"} of ${it.name}` : "Added to inventory");
    logAudit(actor, "create", "equipment", it.id, it.name);
  }
  commit();
  return items;
}

export type ItemPatch = Partial<Pick<EquipmentItem, "name" | "make" | "model" | "vendor" | "packaging" | "accessories" | "info" | "unitCost" | "purchaseDate" | "serialNumber" | "unitLabel" | "condition" | "quantityTotal" | "category">>;

export function updateItem(actor: Actor, id: string, patch: ItemPatch): EquipmentItem {
  requireGearAccess(actor);
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  if (patch.name !== undefined && !patch.name.trim()) throw new RuleError("Name cannot be empty.");
  if (patch.category !== undefined && !equipCategory(patch.category)) throw new RuleError("Choose a valid category.");
  if (patch.unitCost !== undefined && (!Number.isFinite(patch.unitCost) || patch.unitCost < 0)) throw new RuleError("Cost must be zero or more.");
  if (patch.serialNumber !== undefined && item.trackingType === "serialized") {
    const s = patch.serialNumber?.trim() ?? "";
    if (s) {
      const dupe = getDb().equipment.find((e) => e.id !== id && e.serialNumber && e.serialNumber.toLowerCase() === s.toLowerCase());
      if (dupe) throw new RuleError(`Serial number ${s} is already registered as ${dupe.id}.`);
    }
    patch.serialNumber = s || null;
  }
  if (patch.unitLabel !== undefined) {
    if (item.trackingType !== "serialized") throw new RuleError("Only single units can have a label.");
    patch.unitLabel = patch.unitLabel?.trim() || null;
  }
  if (patch.quantityTotal !== undefined) {
    if (item.trackingType !== "aggregate") throw new RuleError("Only batches have a quantity.");
    if (!Number.isInteger(patch.quantityTotal) || patch.quantityTotal < 1) throw new RuleError("Quantity must be a whole number of at least 1.");
    const committed = qtyOut(item) + qtyAssigned(item);
    if (patch.quantityTotal < committed) throw new RuleError(`${committed} are checked out or assigned. The count cannot go below that.`);
  }
  const changes: string[] = [];
  if (patch.condition && patch.condition !== item.condition) changes.push(`Condition ${item.condition} to ${patch.condition}`);
  if (patch.quantityTotal !== undefined && patch.quantityTotal !== item.quantityTotal) changes.push(`Count ${item.quantityTotal} to ${patch.quantityTotal}`);
  if (patch.category && patch.category !== item.category) changes.push(`Category ${equipCategory(item.category).label} to ${equipCategory(patch.category).label}`);
  const oldCondition = item.condition;
  const oldQty = item.quantityTotal;
  Object.assign(item, patch);
  if (item.trackingType === "aggregate") {
    let bd: ConditionBreakdown = item.conditionBreakdown ?? {};
    if (patch.condition !== undefined && patch.condition !== oldCondition) {
      // Setting the condition on a batch resets it uniformly across every active unit.
      // Use "Split condition by unit…" on the item page to give individual units their own condition again.
      bd = { [item.condition]: item.quantityTotal };
    } else if (patch.quantityTotal !== undefined && patch.quantityTotal !== oldQty) {
      const delta = item.quantityTotal - oldQty;
      bd = delta > 0 ? addUnits(bd, delta) : removeWorstFirst(bd, -delta);
    }
    applyConditionBreakdown(item, bd);
  }
  hist(actor, id, "edited", changes.length ? changes.join(", ") : "Details updated");
  logAudit(actor, "update", "equipment", id, Object.keys(patch).join(", "));
  commit();
  return item;
}

/**
 * Sets exactly how many active units of a batch are in each condition (for example 8 Good, 2 Fair).
 * The counts must add up to the batch's current quantity. The item's single `condition` field is
 * then kept as the worst condition present, so existing lists, badges and reports still make sense.
 */
export function setConditionBreakdown(actor: Actor, id: string, counts: ConditionBreakdown): EquipmentItem {
  requireGearAccess(actor);
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  if (item.trackingType !== "aggregate") throw new RuleError("Only batches can split their condition by unit.");
  const clean: ConditionBreakdown = {};
  for (const c of CONDITIONS) {
    const n = counts[c] ?? 0;
    if (!Number.isInteger(n) || n < 0) throw new RuleError("Each condition's count must be zero or a whole number.");
    if (n > 0) clean[c] = n;
  }
  const total = breakdownTotal(clean);
  if (total !== item.quantityTotal) throw new RuleError(`Those counts add up to ${total}, but this batch has ${item.quantityTotal} units.`);
  applyConditionBreakdown(item, clean);
  hist(actor, id, "edited", `Condition split: ${CONDITIONS.filter((c) => clean[c]).map((c) => `${clean[c]} ${c}`).join(", ")}`);
  logAudit(actor, "update", "equipment", id, "condition breakdown");
  commit();
  return item;
}

export function addAttachment(actor: Actor, id: string, kind: "photo" | "receipt", input: { url: string; caption?: string }): Attachment {
  requireGearAccess(actor);
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  const att = makeAttachment(actor, input);
  (kind === "photo" ? item.photos : item.receipts).push(att);
  hist(actor, id, "photo", kind === "photo" ? "Reference photo added" : "Receipt attached");
  commit();
  return att;
}

export function removeAttachment(actor: Actor, id: string, attachmentId: string): void {
  requireGearAccess(actor);
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  item.photos = item.photos.filter((a) => a.id !== attachmentId);
  item.receipts = item.receipts.filter((a) => a.id !== attachmentId);
  commit();
}

export function startRepair(actor: Actor, id: string, note: string): void {
  requireGearAccess(actor);
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  if (item.trackingType === "aggregate") throw new RuleError("Batches are not repaired. Record damaged units when they are checked in.");
  if (item.baseStatus !== "active") throw new RuleError("Only items in service can be sent to repair.");
  if (qtyOut(item) > 0) throw new RuleError("This item is checked out. Check it in first.");
  item.baseStatus = "in-repair";
  hist(actor, id, "repair-start", note.trim() || "Sent for repair");
  logAudit(actor, "repair-start", "equipment", id, note);
  commit();
}

export function finishRepair(actor: Actor, id: string, condition: EquipCondition, note: string): void {
  requireGearAccess(actor);
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  if (item.baseStatus !== "in-repair") throw new RuleError("This item is not in repair.");
  item.baseStatus = "active";
  item.condition = condition;
  hist(actor, id, "repair-end", `${note.trim() || "Back from repair"}. Condition: ${condition}`);
  logAudit(actor, "repair-end", "equipment", id, condition);
  commit();
}

export function retireItem(actor: Actor, id: string, kind: "retired" | "lost", note: string): void {
  requireHop(actor, "retire equipment");
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  if (item.baseStatus === "retired" || item.baseStatus === "lost") throw new RuleError("This item is already out of service.");
  if (getDb().manifests.some((m) => isActive(m) && m.lines.some((l) => l.equipmentId === id))) throw new RuleError("This item is on an active checkout list. Check it in or release it first.");
  item.baseStatus = kind;
  hist(actor, id, kind, note.trim() || (kind === "lost" ? "Marked lost" : "Retired from inventory"));
  logAudit(actor, kind, "equipment", id, note);
  commit();
}

export function reinstateItem(actor: Actor, id: string): void {
  requireHop(actor, "reinstate equipment");
  const item = getItem(id);
  if (!item || (item.baseStatus !== "retired" && item.baseStatus !== "lost")) throw new RuleError("This item is not retired or lost.");
  item.baseStatus = "active";
  hist(actor, id, "edited", "Back in service");
  logAudit(actor, "reinstate", "equipment", id);
  commit();
}

/** Items with any history are retired, never deleted. */
export function deleteItem(actor: Actor, id: string): void {
  requireHop(actor, "delete equipment");
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  const used = getDb().manifests.some((m) => m.lines.some((l) => l.equipmentId === id)) || getDb().incidents.some((i) => i.equipmentId === id);
  if (used) throw new RuleError("This item has checkout history. Retire it instead so the history is kept.");
  getDb().equipment = getDb().equipment.filter((e) => e.id !== id);
  getDb().equipmentHistory = getDb().equipmentHistory.filter((h) => h.equipmentId !== id);
  logAudit(actor, "delete", "equipment", id, item.name);
  commit();
}
