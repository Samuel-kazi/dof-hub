import type { Actor, CallSheet, EquipmentItem, GearRequest, RoleKit } from "../types";
import { RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { claimId } from "../data/ids";
import { logAudit } from "./audit";
import { availabilityOn, getItem, requireGearAccess } from "./equipment-items";
import { manifestForSheet } from "./equipment-manifests";
import { pad, pickKeys } from "./utils";

// Role kits: the gear a role usually takes ("Camera operator with an FX6: the FX6, CFexpress cards, batteries,
// tripod, monitor, SDI cable"). A call sheet offers a matching kit's items to its crew's roles, one by one; accepting
// one books it through the usual availability and conflict checks. Kits are editable defaults, never forced. Where no
// kit matches a role, the call sheet falls back to suggesting by category (src/services/sheetAdvice.ts).

export const listKits = (): RoleKit[] =>
  [...(getDb().roleKits ?? [])].sort((a, b) => a.role.localeCompare(b.role) || a.cameraModel.localeCompare(b.cameraModel));
export const getKit = (id: string): RoleKit | undefined => (getDb().roleKits ?? []).find((k) => k.id === id);

export interface KitInput {
  role?: string;
  keywords?: string[];
  cameraModel?: string;
  items?: GearRequest[];
  notes?: string;
}
const KIT_EDITABLE = ["role", "keywords", "cameraModel", "items", "notes"] as const;

/** The words a kit is matched on: its own, or the words of its role's name. */
const wordsOf = (k: RoleKit): string[] =>
  (k.keywords.length ? k.keywords : k.role.split(/[\s/,-]+/)).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3);

const startsWord = (text: string, word: string): boolean => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text);

/** The kits for a role named on a call sheet ("Camera 1" matches the kit for "Camera operator"). */
export const kitsForRole = (role: string): RoleKit[] =>
  role.trim() ? listKits().filter((k) => wordsOf(k).some((w) => startsWord(role, w))) : [];

function check(input: KitInput): void {
  if (input.role !== undefined && (!input.role.trim() || input.role.length > 120)) throw new RuleError("Name the role the kit is for.");
  if (input.cameraModel !== undefined && input.cameraModel.length > 80) throw new RuleError("Keep the camera model short.");
  if (input.notes !== undefined && input.notes.length > 2000) throw new RuleError("Keep the notes under 2,000 characters.");
  if (input.keywords !== undefined && (input.keywords.length > 20 || input.keywords.some((w) => typeof w !== "string" || w.length > 40)))
    throw new RuleError("Up to 20 short words to match roles by.");
  if (input.items !== undefined) {
    if (input.items.length > 60) throw new RuleError("A kit can hold up to 60 items.");
    const seen = new Set<string>();
    for (const g of input.items) {
      if (!getItem(g.equipmentId)) throw new RuleError("A kit item no longer exists in the inventory.");
      if (!Number.isInteger(g.quantity) || g.quantity < 1) throw new RuleError("Kit quantities start at 1.");
      if (seen.has(g.equipmentId)) throw new RuleError("Each item is listed once in a kit.");
      seen.add(g.equipmentId);
    }
  }
}

const tidy = (words: string[] | undefined): string[] => [...new Set((words ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean))];

export function createKit(actor: Actor, input: KitInput): RoleKit {
  requireGearAccess(actor);
  const patch = pickKeys(input, KIT_EDITABLE);
  if (!patch.role?.trim()) throw new RuleError("Name the role the kit is for.");
  check(patch);
  const at = new Date().toISOString();
  const kit: RoleKit = {
    id: claimId(`DOF-KIT-${pad(nextCounter("kit"))}`),
    role: patch.role.trim(),
    keywords: tidy(patch.keywords),
    cameraModel: (patch.cameraModel ?? "").trim(),
    items: patch.items ?? [],
    notes: (patch.notes ?? "").trim(),
    createdAt: at,
    updatedAt: at,
    updatedBy: actor.personId,
  };
  (getDb().roleKits ??= []).push(kit);
  logAudit(actor, "create", "kit", kit.id, `${kit.role}${kit.cameraModel ? ` (${kit.cameraModel})` : ""}`);
  commit();
  return kit;
}

export function updateKit(actor: Actor, id: string, input: KitInput): RoleKit {
  requireGearAccess(actor);
  const kit = getKit(id);
  if (!kit) throw new RuleError("That kit no longer exists.");
  const patch = pickKeys(input, KIT_EDITABLE);
  check(patch);
  if (patch.role !== undefined) kit.role = patch.role.trim();
  if (patch.keywords !== undefined) kit.keywords = tidy(patch.keywords);
  if (patch.cameraModel !== undefined) kit.cameraModel = patch.cameraModel.trim();
  if (patch.items !== undefined) kit.items = patch.items;
  if (patch.notes !== undefined) kit.notes = patch.notes.trim();
  kit.updatedAt = new Date().toISOString();
  kit.updatedBy = actor.personId;
  logAudit(actor, "update", "kit", id, Object.keys(patch).join(", "));
  commit();
  return kit;
}

/** Removes a kit. It is a default to offer, not a record of anything, so it goes; booked gear is not touched. */
export function deleteKit(actor: Actor, id: string): void {
  requireGearAccess(actor);
  const kit = getKit(id);
  if (!kit) throw new RuleError("That kit no longer exists.");
  getDb().roleKits = (getDb().roleKits ?? []).filter((k) => k.id !== id);
  logAudit(actor, "delete", "kit", id, kit.role);
  commit();
}

export interface KitSuggestion {
  kit: RoleKit;
  roles: string[]; // the sheet's roles it is offered for
  items: { item: EquipmentItem; quantity: number; free: boolean; reason: string }[]; // not on the sheet yet
}

/**
 * The kits matching the roles on a call sheet's crew, each with the items not on the sheet yet, and whether each is
 * free on the sheet's date (booked elsewhere or lent out: not free, with the reason). Nothing is booked here.
 */
export function kitSuggestions(cs: CallSheet): KitSuggestion[] {
  const m = manifestForSheet(cs.id);
  const onSheet = new Set([
    ...(m?.status === "released" ? [] : (m?.lines ?? [])).map((l) => l.equipmentId),
    ...cs.plannedGear.map((g) => g.equipmentId),
  ]);
  const byKit = new Map<string, KitSuggestion>();
  for (const pid of cs.crewPersonIds) {
    const role = cs.crewRoles[pid] ?? "";
    for (const kit of kitsForRole(role)) {
      const s = byKit.get(kit.id) ?? { kit, roles: [], items: [] };
      if (!s.roles.includes(role)) s.roles.push(role);
      byKit.set(kit.id, s);
    }
  }
  for (const s of byKit.values())
    for (const g of s.kit.items) {
      const item = getItem(g.equipmentId);
      if (!item || onSheet.has(item.id)) continue;
      const a = availabilityOn(item, cs.date, cs.date, m?.id);
      s.items.push({
        item,
        quantity: g.quantity,
        free: a.availableQty >= g.quantity,
        reason: a.availableQty >= g.quantity ? "" : a.reason,
      });
    }
  return [...byKit.values()].filter((s) => s.items.length).sort((a, b) => a.kit.role.localeCompare(b.kit.role));
}
