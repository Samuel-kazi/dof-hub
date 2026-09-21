import type { EquipCategoryKey, EquipCondition, TrackingType } from "../types";

export interface EquipCategory {
  key: EquipCategoryKey;
  label: string;
  code: string; // used in asset codes: DOF-EQ-CAM-001
  defaultTracking: TrackingType; // a helpful default, overridable per item
  covers: string;
}

export const EQUIP_CATEGORIES: EquipCategory[] = [
  { key: "camera", label: "Camera", code: "CAM", defaultTracking: "serialized", covers: "Bodies, lenses, support, batteries, memory cards, filters, rigs" },
  { key: "audio", label: "Audio", code: "AUD", defaultTracking: "serialized", covers: "Microphones, wireless, mixers, recorders, stands, monitoring" },
  { key: "lighting", label: "Lighting", code: "LGT", defaultTracking: "serialized", covers: "Key and fill lights, modifiers, stands, power distribution" },
  { key: "live", label: "Live Broadcast & Streaming", code: "LIV", defaultTracking: "serialized", covers: "Switchers, encoders, capture devices, monitors, intercom" },
  { key: "studio", label: "Studio & Set", code: "STU", defaultTracking: "serialized", covers: "Backdrops, set pieces, staging, furniture" },
  { key: "computing", label: "Computing & Post-Production", code: "CMP", defaultTracking: "serialized", covers: "Workstations, drives, reference monitors, RAID" },
  { key: "cabling", label: "Cabling & Connectivity", code: "CAB", defaultTracking: "aggregate", covers: "XLR, HDMI, SDI, network and power cables" },
  { key: "power", label: "Power & Grip", code: "PWR", defaultTracking: "serialized", covers: "Batteries, chargers, power banks, clamps, sandbags" },
  { key: "transport", label: "Transport & Field", code: "TRN", defaultTracking: "serialized", covers: "Hard cases, carts, field bags" },
  { key: "ministry", label: "Ministry & Presentation", code: "MIN", defaultTracking: "serialized", covers: "Instruments, in-ear monitors, lectern AV, projection, interpretation headsets" },
  { key: "safety", label: "Safety & Compliance", code: "SAF", defaultTracking: "serialized", covers: "Fire extinguishers, first aid kits, PPE" },
];

export const equipCategory = (k: EquipCategoryKey): EquipCategory => EQUIP_CATEGORIES.find((c) => c.key === k)!;

/** Ordered best to worst, so a lower rank at check-in than at checkout means damage. */
export const CONDITIONS: EquipCondition[] = ["New", "Good", "Fair", "Poor"];
export const conditionRank = (c: EquipCondition): number => CONDITIONS.indexOf(c);
