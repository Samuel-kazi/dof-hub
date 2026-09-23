import type { Actor, Attachment, EquipCondition, EquipmentHistory, EquipmentItem, Incident, Manifest, ManifestLine } from "../types";
import { RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { conditionRank } from "../config/equipment";
import { canView, canWrite, getRecord, isHop } from "./access";
import { logAudit } from "./audit";
import { getPerson } from "./people";
import { fmtShort, pad, todayIso } from "./utils";
import {
  availabilityOn, endOf, getItem, isOverdue, requireGearAccess,
  type Availability,
} from "./equipment-items";
import { groupByFamily } from "./equipment-reports";

// Private copies of two small equipment-items.ts helpers: history logging and attachment validation.
// Kept as plain (unexported) duplicates rather than shared across files, so neither takes an actor
// first as a publicly importable symbol here and neither risks being picked up as its own server action.
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

export const getManifest = (id: string): Manifest | undefined => getDb().manifests.find((m) => m.id === id);

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
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

// ── The gear picker ──────────────────────────────────────────

export interface PickerRow {
  key: string;
  name: string;
  sub: string;
  category: EquipmentItem["category"];
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
