import type { RoleCode } from "../types";

// What each kind of person can do. The Head of Production can always do everything, and can change
// these defaults for a whole role, or give one person more or less than their role normally has.

export type Capability =
  | "pipeline.viewAll"
  | "pipeline.join"
  | "pipeline.editAll"
  | "pipeline.assign"
  | "pipeline.manage"
  | "equipment.use"
  | "equipment.admin"
  | "storage.use"
  | "storage.admin"
  | "people.directory"
  | "people.loginStatus"
  | "people.contacts"
  | "people.manage"
  | "workload.viewAll"
  | "reports.export"
  | "reminders.use"
  | "reminders.sendOthers"
  | "backend.audit"
  | "backend.settings";

export interface CapabilityDef {
  key: Capability;
  group: string;
  label: string;
  hint: string;
}

export const CAPABILITIES: CapabilityDef[] = [
  { key: "pipeline.viewAll", group: "Content pipeline", label: "See every project", hint: "View all ongoing and completed projects with their stages, documents and call sheets, not only the ones they are attached to." },
  { key: "pipeline.join", group: "Content pipeline", label: "Jump in on any project", hint: "Add themselves to any stage or project so they can help. Once they are on it, they can edit it." },
  { key: "pipeline.editAll", group: "Content pipeline", label: "Edit any project", hint: "Change stages, checklists, links and documents on every project without being attached first." },
  { key: "pipeline.assign", group: "Content pipeline", label: "Assign other people's work", hint: "Put other people on stages and choose their roles." },
  { key: "pipeline.manage", group: "Content pipeline", label: "Create projects", hint: "Create new shows, series, live shows and other top-level projects." },
  { key: "equipment.use", group: "Equipment and storage", label: "Use equipment", hint: "See the inventory, and reserve, check out and check in gear." },
  { key: "equipment.admin", group: "Equipment and storage", label: "Manage equipment", hint: "Retire, mark lost, reinstate and delete equipment." },
  { key: "storage.use", group: "Equipment and storage", label: "Use storage", hint: "See drives and record what is stored on them." },
  { key: "storage.admin", group: "Equipment and storage", label: "Manage drives", hint: "Add, rename, resize and remove drives." },
  { key: "people.directory", group: "People", label: "See the People page", hint: "See the list of crew and volunteers." },
  { key: "people.loginStatus", group: "People", label: "See who has a login", hint: "See which people have logins and whether they are active." },
  { key: "people.contacts", group: "People", label: "See volunteer and partner contact details", hint: "See their email addresses and phone numbers." },
  { key: "people.manage", group: "People", label: "Add and change people", hint: "Add people, edit their details, give logins and attach them to projects." },
  { key: "workload.viewAll", group: "Workload", label: "See everyone's workload", hint: "See how much every crew member has on. Without it, people see only their own." },
  { key: "reports.export", group: "Reports and reminders", label: "Print, copy and download reports", hint: "Produce reports as PDF, print them, or copy them." },
  { key: "reminders.use", group: "Reports and reminders", label: "Use reminders and calendar", hint: "See their reminders and add them to a calendar." },
  { key: "reminders.sendOthers", group: "Reports and reminders", label: "Send reminders to other people", hint: "Email or text other people about their deadlines." },
  { key: "backend.audit", group: "Back end", label: "See the activity log", hint: "See who changed what and when." },
  { key: "backend.settings", group: "Back end", label: "Change system settings", hint: "Change reminder timing, thresholds, working days and stage estimates." },
];

export const ALL_CAPABILITIES: Capability[] = CAPABILITIES.map((c) => c.key);

/** What each role has before the Head of Production changes anything. */
export const DEFAULT_GRANTS: Record<RoleCode, Capability[]> = {
  HOP: ALL_CAPABILITIES,
  CRW: ["pipeline.viewAll", "pipeline.join", "equipment.use", "storage.use", "people.directory", "reports.export", "reminders.use"],
  VOL: [],
  PTR: [],
};

export const capabilityDef = (key: Capability): CapabilityDef => CAPABILITIES.find((c) => c.key === key)!;
