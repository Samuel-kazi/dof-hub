import type { CallSheet, EquipCategoryKey, EventPlan, Logistics, Rehearsal, SheetContent } from "../types";

// What every call sheet contains, whichever way its day was made (a recurring show's template, a one-time or
// multi-day event, or a recording session): one shape, one list of sections, the same screens.

/** The call sheet's sections, in the order they are shown and printed. */
export const SHEET_SECTIONS = [
  { key: "schedule", label: "Schedule" },
  { key: "crew", label: "Crew" },
  { key: "talent", label: "Talent" },
  { key: "location", label: "Location" },
  { key: "equipment", label: "Equipment" },
  { key: "logistics", label: "Logistics" },
  { key: "contacts", label: "Contacts" },
  { key: "runOfShow", label: "Run of Show" },
  { key: "technicalCheck", label: "Technical Check" },
  { key: "rehearsal", label: "Rehearsal" },
] as const;
export type SheetSectionKey = (typeof SHEET_SECTIONS)[number]["key"];

/** The fields of a sheet's content, as SheetContent lists them. */
export const SHEET_CONTENT_KEYS = [
  "callTime",
  "talentCall",
  "startTime",
  "wrapTime",
  "location",
  "locationAddress",
  "locationNotes",
  "locationId",
  "format",
  "notes",
  "crewPersonIds",
  "crewRoles",
  "crewLeadId",
  "talent",
  "logistics",
  "contacts",
  "runOfShow",
  "technicalCheck",
  "rehearsal",
  "plannedGear",
] as const satisfies readonly (keyof SheetContent)[];

export const LOGISTICS_FIELDS: { key: keyof Logistics; label: string; hint: string }[] = [
  { key: "transport", label: "Transport", hint: "Who drives, pick-up times, the van" },
  { key: "parking", label: "Parking and access", hint: "Where to park, which entrance, gate codes" },
  { key: "meals", label: "Meals", hint: "Breakfast, lunch, water" },
  { key: "accommodation", label: "Accommodation", hint: "Where the team stays, if anywhere" },
  { key: "other", label: "Other", hint: "Anything else the team needs to know" },
];

/** A technical check to start from, for a new sheet or template. Lines can be renamed, added and removed. */
export const DEFAULT_TECH_CHECK = [
  "Cameras: white balance, focus and sync",
  "Audio: mic levels and backup recording",
  "Lighting: set and checked on camera",
  "Recording media and batteries",
  "Stream or recording test",
  "Power and backup",
];

export const blankLogistics = (): Logistics => ({ transport: "", parking: "", meals: "", accommodation: "", other: "" });
export const blankRehearsal = (): Rehearsal => ({ time: "", notes: "", done: false });

/** Everything a sheet holds, empty. */
export function blankSheetContent(): SheetContent {
  return {
    callTime: "",
    talentCall: "",
    startTime: "",
    wrapTime: "",
    location: "",
    locationAddress: "",
    locationNotes: "",
    locationId: null,
    format: "",
    notes: "",
    crewPersonIds: [],
    crewRoles: {},
    crewLeadId: null,
    talent: [],
    logistics: blankLogistics(),
    contacts: [],
    runOfShow: [],
    technicalCheck: [],
    rehearsal: blankRehearsal(),
    plannedGear: [],
  };
}

export const blankEventPlan = (): EventPlan => ({
  overview: "",
  venue: "",
  audience: "",
  travel: "",
  accommodation: "",
  budget: "",
  notes: "",
});

export const EVENT_PLAN_FIELDS: { key: keyof EventPlan; label: string; hint: string }[] = [
  { key: "overview", label: "Overview", hint: "What the event is and what it is for" },
  { key: "audience", label: "Audience", hint: "Who it is for, and how many are expected" },
  { key: "venue", label: "Venue", hint: "Where it happens, and the venue's contact" },
  { key: "travel", label: "Travel", hint: "How the team and gear get there and back" },
  { key: "accommodation", label: "Accommodation", hint: "Where the team stays" },
  { key: "budget", label: "Budget", hint: "What it may cost, and who approved it" },
  { key: "notes", label: "Notes", hint: "Anything else for every day of the event" },
];

/** Labels for the three ways a production makes its days. */
export const MODE_LABEL = { recurring: "Recurring show", one_time: "One-time event", multi_day: "Multi-day event" } as const;

/** What a new call sheet starts with besides its content: not shared yet, no one confirmed, nothing changed. */
export const blankSheetTracking = (): Pick<CallSheet, "sharedAt" | "confirmations" | "changeLog"> => ({
  sharedAt: null,
  confirmations: {},
  changeLog: [],
});

/** How many days before a sheet's date crew who have not confirmed are flagged. */
export const CONFIRM_WARN_DAYS = 3;

/**
 * Gear to suggest for the roles on a sheet's crew: a role whose name has one of these words gets one item from each
 * category. Suggestions are only offered; nothing is booked until someone adds it.
 */
export const ROLE_GEAR: { words: string[]; categories: EquipCategoryKey[] }[] = [
  { words: ["camera", "dop", "cinematographer", "videographer", "shooter"], categories: ["camera"] },
  { words: ["audio", "sound", "boom", "mixer"], categories: ["audio"] },
  { words: ["light", "gaffer"], categories: ["lighting"] },
  { words: ["stream", "switcher", "vision", "broadcast", "technical director"], categories: ["live"] },
  { words: ["editor", "dit", "data", "media manager"], categories: ["computing"] },
  { words: ["grip"], categories: ["power"] },
  { words: ["worship", "musician", "band", "interpret"], categories: ["ministry"] },
];

/**
 * The item a role needs most in each category, by words in its name: a camera operator needs a camera body before
 * a lens or a tripod. Offered first, and what counts as having one. A category not listed counts any of its items.
 */
export const MAIN_GEAR: Partial<Record<EquipCategoryKey, string[]>> = {
  camera: ["camera", "body", "camcorder"],
  audio: ["microphone", "mic", "lavalier", "recorder"],
  lighting: ["light", "panel", "fresnel"],
  live: ["switcher", "encoder"],
  computing: ["laptop", "workstation"],
};
