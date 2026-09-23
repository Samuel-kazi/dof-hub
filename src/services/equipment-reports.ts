import type { EquipCategoryKey, EquipCondition, EquipmentHistory, EquipmentItem, Incident } from "../types";
import { getDb } from "../data/store";
import { EQUIP_CATEGORIES } from "../config/equipment";
import { fmtShort } from "./utils";
import { displayStatus, familyOf, qtyFree } from "./equipment-items";

export interface ReportRow { id: string; name: string; detail: string; serial: string; qty: number; free: number; condition: EquipCondition; status: string; cost: number; vendor: string; purchased: string; packaging: string; accessories: string }
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
      vendor: i.vendor,
      purchased: i.purchaseDate ? fmtShort(i.purchaseDate) : "",
      packaging: i.packaging,
      accessories: i.accessories,
    }));
    groups.push({ category: cat.key, label: cat.label, rows, units: rows.reduce((n, r) => n + r.qty, 0) });
  }
  return groups;
}

// ── Grouping ─────────────────────────────────────────────────

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

// ── History and incidents ───────────────────────────────────

export const itemHistory = (id: string): EquipmentHistory[] => getDb().equipmentHistory.filter((h) => h.equipmentId === id).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
export const itemIncidents = (id: string): Incident[] => getDb().incidents.filter((i) => i.equipmentId === id).sort((a, b) => b.at.localeCompare(a.at));
export const allIncidents = (): Incident[] => [...getDb().incidents].sort((a, b) => b.at.localeCompare(a.at));
