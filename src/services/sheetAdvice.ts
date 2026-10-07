import type { CallSheet, EquipCategoryKey, EquipmentItem } from "../types";
import { CONFIRM_WARN_DAYS, MAIN_GEAR, ROLE_GEAR, checkStateOf, type SheetSectionKey } from "../config/callSheet";
import { equipCategory } from "../config/equipment";
import { getDb } from "../data/store";
import { availabilityOn, getItem } from "./equipment-items";
import { manifestForSheet } from "./equipment-manifests";
import { confirmationHolds } from "./sheetTracking";
import { dayNumber } from "./utils";

// Advice on a call sheet, never rules: what it is missing, and gear its crew's roles usually need. Nothing here
// blocks a sheet or changes it.

export interface SheetWarning {
  section: SheetSectionKey;
  text: string;
}

const nameOf = (personId: string): string => getDb().people.find((p) => p.personId === personId)?.name ?? personId;

/** Crew who have not confirmed (or whose confirmation a change cleared). */
export const unconfirmedCrew = (cs: CallSheet): string[] => cs.crewPersonIds.filter((pid) => !confirmationHolds(cs, pid));

/**
 * What a sheet still to come is missing: a call time, a location, a crew lead, and, within a few days of the date,
 * crew who have not confirmed. A sheet whose date has passed has none.
 */
export function sheetWarnings(cs: CallSheet, today: string): SheetWarning[] {
  if (cs.date < today) return [];
  const out: SheetWarning[] = [];
  if (!cs.callTime) out.push({ section: "schedule", text: "No crew call time." });
  if (!cs.location.trim()) out.push({ section: "location", text: "No location." });
  if (!cs.crewPersonIds.length) out.push({ section: "crew", text: "No crew on the sheet." });
  else if (!cs.crewLeadId) out.push({ section: "crew", text: "No crew lead." });
  const days = dayNumber(cs.date) - dayNumber(today);
  const waiting = unconfirmedCrew(cs);
  if (days <= CONFIRM_WARN_DAYS && waiting.length) {
    const when = days === 0 ? "It is today" : days === 1 ? "It is tomorrow" : `${days} days to go`;
    out.push({ section: "crew", text: `${when} and ${waiting.length} not confirmed: ${waiting.map(nameOf).join(", ")}.` });
  }
  // A live show's Tech Check: an issue is a warning, never a block (build prompt v4, section 9).
  const issues = cs.technicalCheck.filter((c) => checkStateOf(c) === "Issue");
  if (issues.length)
    out.push({
      section: "technicalCheck",
      text: `Tech Check: ${issues.length === 1 ? "an issue" : `${issues.length} issues`} (${issues.map((c) => c.label).join(", ")}).`,
    });
  return out;
}

export interface GearSuggestion {
  category: EquipCategoryKey;
  label: string;
  roles: string[]; // the roles that call for it
  needed: number; // one for each person in those roles
  have: number; // already booked or planned on the sheet
  options: { item: EquipmentItem; availableQty: number }[]; // free on the sheet's date, not on the sheet yet
}

const roleMatches = (role: string, word: string): boolean =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(role);

/** The gear categories a role calls for. */
export function categoriesForRole(role: string): EquipCategoryKey[] {
  const out = new Set<EquipCategoryKey>();
  for (const r of ROLE_GEAR) if (r.words.some((w) => roleMatches(role, w))) r.categories.forEach((c) => out.add(c));
  return [...out];
}

/**
 * Gear the crew's roles usually need, where the sheet has less of it than there are people in those roles: one
 * camera for each camera operator, and so on. Each suggestion offers what is free on the sheet's date, skipping
 * anything already on the sheet, booked elsewhere, lent out or out of service. Only offered: someone adds it.
 */
export function gearSuggestions(cs: CallSheet, max = 4): GearSuggestion[] {
  const m = manifestForSheet(cs.id);
  const onSheet = new Map<string, number>();
  for (const l of m?.status === "released" ? [] : (m?.lines ?? []))
    onSheet.set(l.equipmentId, (onSheet.get(l.equipmentId) ?? 0) + l.quantity);
  for (const g of cs.plannedGear) onSheet.set(g.equipmentId, (onSheet.get(g.equipmentId) ?? 0) + g.quantity);
  const wanted = new Map<EquipCategoryKey, string[]>();
  for (const pid of cs.crewPersonIds) {
    const role = cs.crewRoles[pid] ?? "";
    for (const c of categoriesForRole(role)) wanted.set(c, [...(wanted.get(c) ?? []), role]);
  }
  const out: GearSuggestion[] = [];
  for (const [category, roles] of wanted) {
    // The main item of the category (a camera body, not a lens) is what counts, and is offered first.
    const main = (i: EquipmentItem): boolean => {
      const words = MAIN_GEAR[category];
      return !words || words.some((w) => roleMatches(i.name, w));
    };
    let have = 0;
    for (const [id, qty] of onSheet) {
      const item = getItem(id);
      if (item?.category === category && main(item)) have += qty;
    }
    if (have >= roles.length) continue;
    const options = getDb()
      .equipment.filter((i) => i.category === category && !onSheet.has(i.id))
      .map((item) => ({ item, availableQty: availabilityOn(item, cs.date, cs.date, m?.id).availableQty }))
      .filter((o) => o.availableQty > 0)
      .sort((a, b) => Number(main(b.item)) - Number(main(a.item)) || a.item.name.localeCompare(b.item.name))
      .slice(0, max);
    out.push({ category, label: equipCategory(category).label, roles: [...new Set(roles)], needed: roles.length, have, options });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
