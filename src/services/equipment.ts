import type { Actor, Attachment, EquipCategoryKey, EquipCondition, EquipmentHistory, EquipmentItem, Incident, Manifest, ManifestLine, ManifestStatus, TrackingType } from "../types";
import { RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { EQUIP_CATEGORIES, conditionRank, equipCategory } from "../config/equipment";
import { canView, canWrite, getRecord, isHop } from "./access";
import { logAudit } from "./audit";
import { can, requireCan } from "./permissions";
import { getPerson } from "./people";
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
export const getManifest = (id: string): Manifest | undefined => getDb().manifests.find((m) => m.id === id);
const isActive = (m: Manifest) => m.status === "assigned" || m.status === "checked-out";
export const familyOf = (i: EquipmentItem): string => (i.itemFamily ? i.itemFamily.toUpperCase() : i.id);

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

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

function qtyIn(item: EquipmentItem, status: ManifestStatus): number {
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
function endOf(m: Manifest): string {
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
    if (!serial) throw new RuleError("Serialized items need a serial number.");
    const dupe = getDb().equipment.find((e) => e.serialNumber && e.serialNumber.toLowerCase() === serial.toLowerCase());
    if (dupe) throw new RuleError(`Serial number ${serial} is already registered as ${dupe.id}.`);
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
    serialNumber: input.trackingType === "serialized" ? serial : null,
    unitLabel: input.trackingType === "serialized" ? (input.unitLabel ?? "").trim() || null : null,
    quantityTotal: quantity,
    quantityDamaged: 0,
    quantityLost: 0,
    unitCost: input.unitCost,
    purchaseDate: input.purchaseDate || null,
    vendor: input.vendor.trim(),
    condition: input.condition,
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
    if (!serial) throw new RuleError(`Unit ${i + 1} needs a serial number.`);
    const key = serial.toLowerCase();
    if (seen.has(key)) throw new RuleError(`Serial number ${serial} is entered twice, for unit ${seen.get(key)! + 1} and unit ${i + 1}.`);
    seen.set(key, i);
    const existing = getDb().equipment.find((e) => e.serialNumber && e.serialNumber.toLowerCase() === key);
    if (existing) throw new RuleError(`Serial number ${serial} is already registered as ${existing.id} (${existing.name}).`);
    return { serial, label: (u.label ?? "").trim() || null };
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

export type ItemPatch = Partial<Pick<EquipmentItem, "name" | "make" | "model" | "vendor" | "packaging" | "accessories" | "info" | "unitCost" | "purchaseDate" | "serialNumber" | "unitLabel" | "condition" | "quantityTotal">>;

export function updateItem(actor: Actor, id: string, patch: ItemPatch): EquipmentItem {
  requireGearAccess(actor);
  const item = getItem(id);
  if (!item) throw new RuleError("Item not found.");
  if (patch.name !== undefined && !patch.name.trim()) throw new RuleError("Name cannot be empty.");
  if (patch.unitCost !== undefined && (!Number.isFinite(patch.unitCost) || patch.unitCost < 0)) throw new RuleError("Cost must be zero or more.");
  if (patch.serialNumber !== undefined && item.trackingType === "serialized") {
    const s = patch.serialNumber?.trim() ?? "";
    if (!s) throw new RuleError("Serialized items need a serial number.");
    const dupe = getDb().equipment.find((e) => e.id !== id && e.serialNumber && e.serialNumber.toLowerCase() === s.toLowerCase());
    if (dupe) throw new RuleError(`Serial number ${s} is already registered as ${dupe.id}.`);
    patch.serialNumber = s;
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
  Object.assign(item, patch);
  hist(actor, id, "edited", changes.length ? changes.join(", ") : "Details updated");
  logAudit(actor, "update", "equipment", id, Object.keys(patch).join(", "));
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

// ── Manifests (checkout lists) ───────────────────────────────

function checkLine(item: EquipmentItem | undefined, qty: number, from: string, to: string, excludeManifestId?: string): EquipmentItem {
  if (!item) throw new RuleError("That item no longer exists.");
  if (!Number.isInteger(qty) || qty < 1) throw new RuleError("Quantity must be at least 1.");
  if (item.trackingType === "serialized" && qty !== 1) throw new RuleError(`${item.name} is a single unit.`);
  if (item.baseStatus !== "active") {
    const word = item.baseStatus === "in-repair" ? "in repair" : item.baseStatus;
    throw new RuleError(`${item.name} (${item.id}) is ${word} and cannot be assigned.`);
  }
  const a = availabilityOn(item, from, to, excludeManifestId);
  if (a.availableQty < qty) {
    throw new RuleError(
      item.trackingType === "aggregate" && a.availableQty > 0
        ? `Only ${a.availableQty} of ${item.name} (${item.id}) are free for those dates. ${a.reason}.`
        : `${item.name} (${item.id}) is not free for those dates. ${a.reason}.`,
    );
  }
  return item;
}

function loadManifest(actor: Actor, id: string): Manifest {
  requireGearAccess(actor);
  const m = getManifest(id);
  if (!m) throw new RuleError("Checkout list not found.");
  const rec = getRecord(m.contentId);
  if (rec ? !canWrite(actor, rec) : !isHop(actor)) throw new RuleError("You are not attached to this project.");
  return m;
}

function newLine(item: EquipmentItem, quantity: number): ManifestLine {
  return { equipmentId: item.id, quantity, conditionOut: item.condition, photosOut: [], conditionIn: null, photosIn: [], returnedGood: 0, damaged: 0, lost: 0 };
}

export interface LineRequest { equipmentId: string; quantity: number }
export interface ManifestInput {
  contentId: string;
  date: string;
  expectedReturn?: string | null;
  destination: "studio" | "outside";
  status: "assigned" | "checked-out";
  responsiblePersonId?: string;
  lines: LineRequest[];
  notes?: string;
  callSheetId?: string | null;
}

function mergeRequests(lines: LineRequest[]): LineRequest[] {
  const map = new Map<string, number>();
  for (const l of lines) map.set(l.equipmentId, (map.get(l.equipmentId) ?? 0) + l.quantity);
  return [...map].map(([equipmentId, quantity]) => ({ equipmentId, quantity }));
}

export function createManifest(actor: Actor, input: ManifestInput): Manifest {
  requireGearAccess(actor);
  const rec = getRecord(input.contentId);
  if (!rec) throw new RuleError("Choose the project this gear is for.");
  if (!canWrite(actor, rec)) throw new RuleError("You are not attached to this project.");
  if (!input.date) throw new RuleError("Choose a date.");
  const lines = mergeRequests(input.lines);
  if (!lines.length) throw new RuleError("Add at least one item.");
  const outside = input.destination === "outside" || input.status === "checked-out";
  const expectedReturn = outside ? input.expectedReturn || addDays(input.date, getDb().settings.checkoutReturnDays) : null;
  if (expectedReturn && expectedReturn < input.date) throw new RuleError("The return date cannot be before the start date.");
  const to = expectedReturn ?? input.date;
  const responsible = input.responsiblePersonId ?? actor.personId;
  const person = getPerson(responsible);
  if (!person || person.status !== "active" || (person.category !== "CRW" && person.category !== "HOP")) throw new RuleError("The person responsible must be active crew.");
  const items = lines.map((l) => checkLine(getItem(l.equipmentId), l.quantity, input.date, to));
  const m: Manifest = {
    id: `DOF-MF-${pad(nextCounter("manifest"))}`,
    contentId: input.contentId,
    callSheetId: input.callSheetId ?? null,
    destination: outside ? "outside" : "studio",
    status: input.status,
    date: input.date,
    expectedReturn,
    responsiblePersonId: responsible,
    lines: lines.map((l, i) => newLine(items[i], l.quantity)),
    notes: input.notes ?? "",
    createdAt: new Date().toISOString(),
    createdBy: actor.personId,
    checkedOutAt: input.status === "checked-out" ? new Date().toISOString() : null,
    returnedAt: null,
  };
  getDb().manifests.push(m);
  for (const l of m.lines) hist(actor, l.equipmentId, m.status === "checked-out" ? "checked-out" : "assigned", `${l.quantity > 1 ? `${l.quantity} units, ` : ""}${m.contentId}, ${fmtShort(m.date)}`, { contentId: m.contentId, manifestId: m.id });
  logAudit(actor, "create", "manifest", m.id, `${m.status}, ${m.lines.length} lines`);
  syncSheetEquipment(m.callSheetId);
  commit();
  return m;
}

export function addLine(actor: Actor, manifestId: string, equipmentId: string, quantity: number): Manifest {
  const m = loadManifest(actor, manifestId);
  if (m.status !== "assigned") throw new RuleError("Items can only be added before the gear goes out.");
  const existing = m.lines.find((l) => l.equipmentId === equipmentId);
  const item = checkLine(getItem(equipmentId), (existing?.quantity ?? 0) + quantity, m.date, m.expectedReturn ?? m.date, m.id);
  if (existing) existing.quantity += quantity;
  else m.lines.push(newLine(item, quantity));
  hist(actor, equipmentId, "assigned", `${quantity > 1 ? `${quantity} units, ` : ""}${m.contentId}, ${fmtShort(m.date)}`, { contentId: m.contentId, manifestId: m.id });
  syncSheetEquipment(m.callSheetId);
  commit();
  return m;
}

/** Adds several items at once. Every line is checked first, so a failure changes nothing. */
export function addLines(actor: Actor, manifestId: string, lines: LineRequest[]): Manifest {
  const m = loadManifest(actor, manifestId);
  if (m.status !== "assigned") throw new RuleError("Items can only be added before the gear goes out.");
  const merged = mergeRequests(lines);
  for (const l of merged) {
    const cur = m.lines.find((x) => x.equipmentId === l.equipmentId)?.quantity ?? 0;
    checkLine(getItem(l.equipmentId), cur + l.quantity, m.date, m.expectedReturn ?? m.date, m.id);
  }
  for (const l of merged) addLine(actor, manifestId, l.equipmentId, l.quantity);
  return m;
}

export function removeLine(actor: Actor, manifestId: string, equipmentId: string): Manifest {
  const m = loadManifest(actor, manifestId);
  if (m.status !== "assigned") throw new RuleError("Items can only be removed before the gear goes out.");
  m.lines = m.lines.filter((l) => l.equipmentId !== equipmentId);
  hist(actor, equipmentId, "released", `Taken off ${m.id}`, { contentId: m.contentId, manifestId: m.id });
  if (!m.lines.length) m.status = "released";
  syncSheetEquipment(m.callSheetId);
  commit();
  return m;
}

export interface PhotoInput { url: string; caption?: string }

export function goneOutDefaults(m: Manifest): string {
  return m.expectedReturn ?? addDays(m.date > todayIso() ? m.date : todayIso(), getDb().settings.checkoutReturnDays);
}

/** Assigned in the studio to gone out. Items must be in service; the return window is re-checked. */
export function markGoneOut(actor: Actor, manifestId: string, opts: { expectedReturn?: string; responsiblePersonId?: string; photos?: Record<string, PhotoInput[]> } = {}): Manifest {
  const m = loadManifest(actor, manifestId);
  if (m.status !== "assigned") throw new RuleError("Only assigned gear can be marked as gone out.");
  const expectedReturn = opts.expectedReturn || goneOutDefaults(m);
  if (expectedReturn < m.date) throw new RuleError("The return date cannot be before the start date.");
  const responsible = opts.responsiblePersonId ?? m.responsiblePersonId;
  const person = getPerson(responsible);
  if (!person || person.status !== "active") throw new RuleError("The person responsible must be active crew.");
  const items = m.lines.map((l) => checkLine(getItem(l.equipmentId), l.quantity, m.date, expectedReturn, m.id));
  const photoAtts = m.lines.map((l) => (opts.photos?.[l.equipmentId] ?? []).map((p) => makeAttachment(actor, p)));
  m.lines.forEach((l, i) => {
    l.conditionOut = items[i].condition;
    l.photosOut.push(...photoAtts[i]);
    hist(actor, l.equipmentId, "checked-out", `${m.contentId}, back by ${fmtShort(expectedReturn)}`, { contentId: m.contentId, manifestId: m.id });
  });
  m.status = "checked-out";
  m.destination = "outside";
  m.expectedReturn = expectedReturn;
  m.responsiblePersonId = responsible;
  m.checkedOutAt = new Date().toISOString();
  logAudit(actor, "check-out", "manifest", m.id, `back by ${expectedReturn}`);
  commit();
  return m;
}

export interface ReturnInput {
  equipmentId: string;
  returnedGood: number;
  damaged: number;
  lost: number;
  conditionIn?: EquipCondition;
  description?: string;
  sendToRepair?: boolean;
  photos?: PhotoInput[];
}

const nonNeg = (n: number) => Number.isInteger(n) && n >= 0;

/** Validates every line first, then applies everything, so a return is never half-recorded. */
export function checkIn(actor: Actor, manifestId: string, returns: ReturnInput[]): Manifest {
  const m = loadManifest(actor, manifestId);
  if (m.status !== "checked-out") throw new RuleError("This gear is not checked out.");

  interface Plan { line: ManifestLine; item: EquipmentItem; good: number; damaged: number; lost: number; cond: EquipCondition | null; desc: string; repair: boolean; photos: Attachment[] }
  const plans: Plan[] = m.lines.map((line) => {
    const item = getItem(line.equipmentId);
    if (!item) throw new RuleError("An item on this list no longer exists.");
    const r = returns.find((x) => x.equipmentId === line.equipmentId);
    if (!r) throw new RuleError(`Record the return for ${item.name}.`);
    if (![r.returnedGood, r.damaged, r.lost].every(nonNeg)) throw new RuleError(`Counts for ${item.name} must be whole numbers.`);
    if (r.returnedGood + r.damaged + r.lost !== line.quantity) throw new RuleError(`${item.name}: returned, damaged and lost must add up to ${line.quantity}.`);
    let good = r.returnedGood;
    let damaged = r.damaged;
    const lost = r.lost;
    let cond: EquipCondition | null = null;
    if (item.trackingType === "serialized") {
      if (good + damaged > 0) {
        if (!r.conditionIn) throw new RuleError(`Choose the condition ${item.name} came back in.`);
        cond = r.conditionIn;
        // A drop in condition since checkout is damage, whether or not it was ticked.
        if (good === 1 && conditionRank(cond) > conditionRank(line.conditionOut)) {
          good = 0;
          damaged = 1;
        }
      }
    }
    const desc = (r.description ?? "").trim();
    if (damaged + lost > 0 && !desc) throw new RuleError(`Describe what happened to ${item.name}.`);
    if (damaged + lost > item.quantityTotal) throw new RuleError(`${item.name}: more units damaged or lost than the batch holds.`);
    return { line, item, good, damaged, lost, cond, desc, repair: !!r.sendToRepair && item.trackingType === "serialized" && damaged === 1, photos: (r.photos ?? []).map((p) => makeAttachment(actor, p)) };
  });

  const now = new Date().toISOString();
  for (const p of plans) {
    p.line.returnedGood = p.good;
    p.line.damaged = p.damaged;
    p.line.lost = p.lost;
    p.line.conditionIn = p.cond;
    p.line.photosIn.push(...p.photos);
    if (p.item.trackingType === "serialized") {
      if (p.cond) p.item.condition = p.cond;
    } else {
      p.item.quantityTotal -= p.damaged + p.lost;
      p.item.quantityDamaged += p.damaged;
      p.item.quantityLost += p.lost;
    }
    const addIncident = (type: Incident["type"], qty: number) => {
      const inc: Incident = { id: `DOF-INC-${pad(nextCounter("incident"))}`, equipmentId: p.item.id, at: now, type, quantity: qty, description: p.desc, personId: m.responsiblePersonId, contentId: m.contentId, manifestId: m.id };
      getDb().incidents.push(inc);
      hist(actor, p.item.id, "incident", `${type === "damage" ? "Damaged" : "Lost"}${qty > 1 ? ` (${qty} units)` : ""}: ${p.desc}`, { contentId: m.contentId, manifestId: m.id });
    };
    if (p.damaged) addIncident("damage", p.damaged);
    if (p.lost) {
      addIncident("loss", p.lost);
      if (p.item.trackingType === "serialized") p.item.baseStatus = "lost";
    }
    if (p.repair) {
      p.item.baseStatus = "in-repair";
      hist(actor, p.item.id, "repair-start", `Sent for repair after ${m.contentId}`, { contentId: m.contentId, manifestId: m.id });
    }
    hist(actor, p.item.id, "checked-in", `${m.contentId}${p.cond ? `, back in ${p.cond} condition` : ""}${p.good && p.item.trackingType === "aggregate" ? `, ${p.good} returned` : ""}`, { contentId: m.contentId, manifestId: m.id });
  }
  m.status = "returned";
  m.returnedAt = now;
  logAudit(actor, "check-in", "manifest", m.id, plans.some((p) => p.damaged + p.lost) ? "with incidents" : "clean");
  syncSheetEquipment(m.callSheetId);
  commit();
  return m;
}

/** Attaches an existing checkout list to a project by its ID. Lists made for a call sheet stay with that sheet. */
export function attachManifest(actor: Actor, manifestId: string, contentId: string): Manifest {
  requireGearAccess(actor);
  const m = getManifest(manifestId);
  if (!m) throw new RuleError("Checkout list not found.");
  const target = getRecord(contentId);
  if (!target) throw new RuleError("Project not found.");
  const current = getRecord(m.contentId);
  if (!canWrite(actor, target) || (current ? !canWrite(actor, current) : !isHop(actor))) throw new RuleError("You are not attached to both projects.");
  if (m.callSheetId) throw new RuleError("This list belongs to a call sheet. It moves with that sheet.");
  if (m.status === "released") throw new RuleError("This list was released, so it cannot be attached.");
  if (m.contentId === contentId) throw new RuleError("This list is already attached here.");
  const from = m.contentId;
  m.contentId = contentId;
  for (const l of m.lines) hist(actor, l.equipmentId, "edited", `${m.id} moved from ${from} to ${contentId}`, { contentId, manifestId: m.id });
  logAudit(actor, "attach", "manifest", m.id, `${from} to ${contentId}`);
  commit();
  return m;
}

export interface ReportRow { id: string; name: string; detail: string; serial: string; qty: number; free: number; condition: EquipCondition; status: string; cost: number }
export interface ReportGroup { category: EquipCategoryKey; label: string; rows: ReportRow[]; units: number }

/** The full equipment list, grouped by category, for printing. */
export function inventoryReport(category: EquipCategoryKey | "all", includeOutOfService: boolean): ReportGroup[] {
  const groups: ReportGroup[] = [];
  for (const cat of EQUIP_CATEGORIES) {
    if (category !== "all" && cat.key !== category) continue;
    const items = getDb().equipment.filter((i) => i.category === cat.key && (includeOutOfService || i.baseStatus === "active" || i.baseStatus === "in-repair")).sort((a, b) => a.id.localeCompare(b.id));
    if (!items.length) continue;
    const rows = items.map((i): ReportRow => ({
      id: i.id,
      name: i.name,
      detail: [i.make, i.model].filter(Boolean).join(" "),
      serial: [i.serialNumber, i.unitLabel].filter(Boolean).join(" ") || "",
      qty: i.quantityTotal,
      free: qtyFree(i),
      condition: i.condition,
      status: displayStatus(i).label,
      cost: i.unitCost,
    }));
    groups.push({ category: cat.key, label: cat.label, rows, units: rows.reduce((n, r) => n + r.qty, 0) });
  }
  return groups;
}

/** Gear that is out under a Content ID. A project cannot be deleted while its gear is away. */
export const checkedOutFor = (contentId: string): Manifest[] => getDb().manifests.filter((m) => m.contentId === contentId && m.status === "checked-out");
export const reservedFor = (contentId: string): Manifest[] => getDb().manifests.filter((m) => m.contentId === contentId && m.status === "assigned");

/** Releases every reserved list for a Content ID, so the gear is free again. Used when the project is deleted. */
export function releaseReservedFor(actor: Actor, contentId: string): number {
  const lists = reservedFor(contentId);
  for (const m of lists) {
    m.status = "released";
    for (const l of m.lines) hist(actor, l.equipmentId, "released", `Released: ${contentId} was deleted`, { contentId, manifestId: m.id });
    logAudit(actor, "release", "manifest", m.id, "project deleted");
    syncSheetEquipment(m.callSheetId);
  }
  return lists.length;
}

/** Ends an in-studio assignment that never left the building. */
export function releaseManifest(actor: Actor, manifestId: string): Manifest {
  const m = loadManifest(actor, manifestId);
  if (m.status !== "assigned") throw new RuleError("Only assigned gear can be released. Checked-out gear is checked in.");
  m.status = "released";
  for (const l of m.lines) hist(actor, l.equipmentId, "released", `Released from ${m.contentId}`, { contentId: m.contentId, manifestId: m.id });
  logAudit(actor, "release", "manifest", m.id);
  syncSheetEquipment(m.callSheetId);
  commit();
  return m;
}

export function addLinePhoto(actor: Actor, manifestId: string, equipmentId: string, input: PhotoInput): void {
  const m = loadManifest(actor, manifestId);
  if (m.status !== "assigned" && m.status !== "checked-out") throw new RuleError("Photos are added while the gear is out.");
  const line = m.lines.find((l) => l.equipmentId === equipmentId);
  if (!line) throw new RuleError("That item is not on this list.");
  line.photosOut.push(makeAttachment(actor, input));
  commit();
}

// ── Reading ──────────────────────────────────────────────────

export function listManifests(actor: Actor): Manifest[] {
  requireGearAccess(actor);
  return getDb()
    .manifests.filter((m) => {
      if (isHop(actor) || m.responsiblePersonId === actor.personId) return true;
      const rec = getRecord(m.contentId);
      return !!rec && canView(actor, rec);
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export const manifestsForContent = (contentId: string): Manifest[] => getDb().manifests.filter((m) => m.contentId === contentId && m.status !== "released").sort((a, b) => a.date.localeCompare(b.date));
export const overdueManifests = (): Manifest[] => getDb().manifests.filter(isOverdue).sort((a, b) => (a.expectedReturn ?? "").localeCompare(b.expectedReturn ?? ""));
export const checkedOutManifests = (): Manifest[] => getDb().manifests.filter((m) => m.status === "checked-out").sort((a, b) => (a.expectedReturn ?? "").localeCompare(b.expectedReturn ?? ""));
export const itemHistory = (id: string): EquipmentHistory[] => getDb().equipmentHistory.filter((h) => h.equipmentId === id).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
export const itemIncidents = (id: string): Incident[] => getDb().incidents.filter((i) => i.equipmentId === id).sort((a, b) => b.at.localeCompare(a.at));
export const allIncidents = (): Incident[] => [...getDb().incidents].sort((a, b) => b.at.localeCompare(a.at));

export function manifestSummary(m: Manifest): string {
  const units = m.lines.reduce((n, l) => n + l.quantity, 0);
  return `${m.lines.length} item${m.lines.length === 1 ? "" : "s"}, ${units} unit${units === 1 ? "" : "s"}`;
}

export function manifestStatusView(m: Manifest): { label: string; tone: "ok" | "warn" | "bad" | "accent" | "" } {
  if (isOverdue(m)) return { label: "Overdue", tone: "bad" };
  switch (m.status) {
    case "assigned": return { label: "Assigned", tone: "accent" };
    case "checked-out": return { label: "Checked out", tone: "warn" };
    case "returned": return { label: "Returned", tone: "ok" };
    case "released": return { label: "Released", tone: "" };
  }
}

// ── Grouping and the gear picker ─────────────────────────────

export interface Family { key: string; name: string; category: EquipCategoryKey; items: EquipmentItem[] }

/** Aggregate batches roll up under their item family, oldest purchase first (FIFO order). */
export function groupByFamily(items: EquipmentItem[]): Family[] {
  const map = new Map<string, Family>();
  for (const i of items.filter((x) => x.trackingType === "aggregate")) {
    const k = familyOf(i);
    if (!map.has(k)) map.set(k, { key: k, name: i.name, category: i.category, items: [] });
    map.get(k)!.items.push(i);
  }
  for (const f of map.values()) f.items.sort((a, b) => (a.purchaseDate ?? a.createdAt).localeCompare(b.purchaseDate ?? b.createdAt));
  return [...map.values()];
}

/** Same make and same model, letter for letter once extra spaces and capitals are ignored. Blank make or model never groups. */
export const modelKeyOf = (i: EquipmentItem): string | null => {
  const make = i.make.trim().toLowerCase();
  const model = i.model.trim().toLowerCase();
  return make && model ? `${i.category}::${make}::${model}` : null;
};

/** Serialized units of the same make and model (for example three Sony FX6 bodies) roll up together, oldest first. */
export function groupSerializedByModel(items: EquipmentItem[]): Family[] {
  const map = new Map<string, Family>();
  for (const i of items.filter((x) => x.trackingType === "serialized")) {
    const k = modelKeyOf(i);
    if (!k) continue;
    if (!map.has(k)) map.set(k, { key: k, name: `${i.make.trim()} ${i.model.trim()}`.trim(), category: i.category, items: [] });
    map.get(k)!.items.push(i);
  }
  for (const f of map.values()) f.items.sort((a, b) => (a.purchaseDate ?? a.createdAt).localeCompare(b.purchaseDate ?? b.createdAt));
  return [...map.values()];
}

export interface PickerRow {
  key: string;
  name: string;
  sub: string;
  category: EquipCategoryKey;
  item?: EquipmentItem; // serialized
  batches?: { item: EquipmentItem; availableQty: number; state: Availability["state"]; reason: string }[]; // aggregate family
  availableQty: number;
  totalQty: number;
  state: Availability["state"];
  reason: string;
}

export function pickerRows(from: string, to: string, excludeManifestId?: string): PickerRow[] {
  const all = getDb().equipment;
  const rows: PickerRow[] = [];
  for (const i of all.filter((x) => x.trackingType === "serialized")) {
    const a = availabilityOn(i, from, to, excludeManifestId);
    rows.push({ key: i.id, name: i.name, sub: [i.make, i.model].filter(Boolean).join(" ") + (i.make || i.model ? ", " : "") + i.id, category: i.category, item: i, availableQty: a.availableQty, totalQty: 1, state: a.state, reason: a.reason });
  }
  for (const f of groupByFamily(all)) {
    const batches = f.items.map((item) => {
      const a = availabilityOn(item, from, to, excludeManifestId);
      return { item, availableQty: a.availableQty, state: a.state, reason: a.reason };
    });
    const available = batches.reduce((n, b) => n + b.availableQty, 0);
    const total = f.items.filter((b) => b.baseStatus === "active").reduce((n, b) => n + b.quantityTotal, 0);
    rows.push({ key: f.key, name: f.name, sub: `${f.key}, ${f.items.length} batch${f.items.length === 1 ? "" : "es"}`, category: f.category, batches, availableQty: available, totalQty: total, state: available === 0 ? "conflict" : available < total ? "partial" : "ok", reason: available === 0 ? "None free for those dates" : "" });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Draw a quantity from a family, oldest batch first. */
export function allocateFifo(familyKey: string, quantity: number, from: string, to: string, excludeManifestId?: string): LineRequest[] {
  const fam = groupByFamily(getDb().equipment).find((f) => f.key === familyKey);
  if (!fam) throw new RuleError("That item family no longer exists.");
  let need = quantity;
  const lines: LineRequest[] = [];
  for (const b of fam.items) {
    if (need <= 0) break;
    const a = availabilityOn(b, from, to, excludeManifestId);
    const take = Math.min(a.availableQty, need);
    if (take > 0) {
      lines.push({ equipmentId: b.id, quantity: take });
      need -= take;
    }
  }
  if (need > 0) throw new RuleError(`Only ${quantity - need} of ${fam.name} are free for those dates.`);
  return lines;
}

// ── Call sheet gear ──────────────────────────────────────────

export interface SheetRef { id: string; contentId: string; date: string }

function syncSheetEquipment(sheetId: string | null): void {
  if (!sheetId) return;
  const cs = getDb().callSheets.find((c) => c.id === sheetId);
  if (!cs) return;
  const m = manifestForSheet(sheetId);
  cs.equipmentIds = m && m.status !== "released" ? m.lines.map((l) => l.equipmentId) : [];
}

/** The live checkout list behind a call sheet's gear, if any. */
export function manifestForSheet(sheetId: string): Manifest | undefined {
  return getDb()
    .manifests.filter((m) => m.callSheetId === sheetId && m.status !== "released")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function addGearToSheet(actor: Actor, sheet: SheetRef, lines: LineRequest[]): Manifest {
  requireGearAccess(actor);
  const existing = manifestForSheet(sheet.id);
  if (existing) {
    if (existing.status !== "assigned") throw new RuleError("This call sheet's gear has already gone out. Manage it from the checkout list.");
    return addLines(actor, existing.id, lines);
  }
  return createManifest(actor, { contentId: sheet.contentId, date: sheet.date, destination: "studio", status: "assigned", lines, callSheetId: sheet.id });
}

export function removeGearFromSheet(actor: Actor, sheetId: string, equipmentId: string): void {
  const m = manifestForSheet(sheetId);
  if (!m) return;
  removeLine(actor, m.id, equipmentId);
}

/** Copies gear to another sheet. Anything already booked on the new date is skipped and reported. */
export function copyGearBetweenSheets(actor: Actor, srcSheetId: string, dst: SheetRef): { copied: number; skipped: string[] } {
  const src = manifestForSheet(srcSheetId);
  if (!src) return { copied: 0, skipped: [] };
  const ok: LineRequest[] = [];
  const skipped: string[] = [];
  for (const l of src.lines) {
    const item = getItem(l.equipmentId);
    try {
      checkLine(item, l.quantity, dst.date, dst.date);
      ok.push({ equipmentId: l.equipmentId, quantity: l.quantity });
    } catch (e) {
      skipped.push(e instanceof RuleError ? e.message : `${item?.name ?? l.equipmentId} could not be copied.`);
    }
  }
  if (ok.length) addGearToSheet(actor, dst, ok);
  return { copied: ok.length, skipped };
}

/** Moves a sheet's bookings to a new date, or refuses if any item is already booked there. */
export function rebookSheetGear(actor: Actor, sheetId: string, newDate: string): void {
  const m = manifestForSheet(sheetId);
  if (!m) return;
  if (m.status !== "assigned") throw new RuleError("This sheet's gear has already gone out, so its date cannot change.");
  for (const l of m.lines) checkLine(getItem(l.equipmentId), l.quantity, newDate, newDate, m.id);
  m.date = newDate;
  logAudit(actor, "rebook", "manifest", m.id, newDate);
  commit();
}

export function gearIssues(sheetId: string): string[] {
  const m = manifestForSheet(sheetId);
  if (!m || m.status !== "assigned") return [];
  const out: string[] = [];
  for (const l of m.lines) {
    const item = getItem(l.equipmentId);
    if (!item) continue;
    try {
      checkLine(item, l.quantity, m.date, m.expectedReturn ?? m.date, m.id);
    } catch (e) {
      if (e instanceof RuleError) out.push(e.message);
    }
  }
  return out;
}

/** Called when a call sheet is deleted: gear that never left the studio is released. */
export function releaseSheetGear(actor: Actor, sheetId: string): void {
  const m = manifestForSheet(sheetId);
  if (!m) return;
  if (m.status === "checked-out") throw new RuleError("This sheet's gear is checked out. Check it in before deleting the call sheet.");
  if (m.status === "assigned") releaseManifest(actor, m.id);
}
