import type { RoleCode } from "../types";

export type ModuleKey =
  | "dashboard"
  | "pipeline"
  | "callsheets"
  | "calendar"
  | "equipment"
  | "storage"
  | "crew"
  | "documents"
  | "reminders"
  | "settings";

export interface RoleInfo {
  code: RoleCode;
  label: string;
  idPrefix: string; // DOF-P-CRW
  canWrite: boolean; // write on assigned projects (HOP: everywhere)
  canComment: boolean;
  globalAccess: boolean; // bypasses project_members
  modules: ModuleKey[];
}

export const ROLES: Record<RoleCode, RoleInfo> = {
  HOP: {
    code: "HOP",
    label: "Head of Production",
    idPrefix: "DOF-P-HOP",
    canWrite: true,
    canComment: true,
    globalAccess: true,
    modules: ["dashboard", "pipeline", "callsheets", "equipment", "storage", "crew", "documents", "settings"],
  },
  CRW: {
    code: "CRW",
    label: "Crew",
    idPrefix: "DOF-P-CRW",
    canWrite: true,
    canComment: true,
    globalAccess: false,
    modules: ["dashboard", "pipeline", "callsheets", "equipment", "storage", "crew", "documents", "settings"],
  },
  VOL: {
    code: "VOL",
    label: "Volunteer",
    idPrefix: "DOF-P-VOL",
    canWrite: false,
    canComment: false,
    globalAccess: false,
    modules: ["dashboard", "pipeline", "callsheets", "documents", "settings"],
  },
  PTR: {
    code: "PTR",
    label: "Partner",
    idPrefix: "DOF-P-PTR",
    canWrite: false,
    canComment: true, // still needs the per-project can_comment flag
    globalAccess: false,
    modules: ["dashboard", "pipeline", "callsheets", "documents", "settings"],
  },
};

export const MODULE_LABELS: Record<ModuleKey, string> = {
  dashboard: "Dashboard",
  pipeline: "Content Pipeline",
  callsheets: "Call Sheets",
  calendar: "Calendar",
  equipment: "Equipment",
  storage: "Storage & Media",
  crew: "Crew",
  documents: "Documents",
  reminders: "Reminders",
  settings: "Settings",
};
