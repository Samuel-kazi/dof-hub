import type { Actor, Settings } from "../types";
import { RuleError } from "../types";
import { commit, getDb } from "../data/store";
import { requireCan } from "./permissions";
import { isHop } from "./access";
import { ACCENTS, FONT_PAIRINGS } from "../config/appearance";
import { FEATURES, FEATURE_KEYS, type FeatureKey } from "../config/features";
import { CATEGORIES, type CategoryConfig } from "../config/categories";
import { logAudit } from "./audit";
import { pickKeys } from "./utils";

/**
 * The system settings this form changes. Permissions and the workspace look are deliberately not here: they
 * belong to the Head of Production alone, through setRoleGrant / setPersonGrant and updateWorkspaceAppearance.
 */
export const SETTINGS_EDITABLE = [
  "stageReminderHours",
  "storageWarningThreshold",
  "checkoutReturnDays",
  "workDays",
  "effortOverrides",
  "storageFolderPattern",
] as const;

/** A session's folder on a drive, unless Settings says otherwise: the project's Content ID, then the date and label. */
export const DEFAULT_FOLDER_PATTERN = "{contentId}/{date}_{label}";

export function updateSettings(actor: Actor, input: Partial<Pick<Settings, (typeof SETTINGS_EDITABLE)[number]>>): void {
  requireCan(actor, "backend.settings", "change system settings");
  const patch = pickKeys(input, SETTINGS_EDITABLE);
  if (patch.stageReminderHours !== undefined && !(patch.stageReminderHours >= 1 && patch.stageReminderHours <= 240)) {
    throw new RuleError("Reminder window must be between 1 and 240 hours.");
  }
  if (
    patch.checkoutReturnDays !== undefined &&
    !(Number.isInteger(patch.checkoutReturnDays) && patch.checkoutReturnDays >= 1 && patch.checkoutReturnDays <= 60)
  ) {
    throw new RuleError("Return window must be a whole number of days, 1 to 60.");
  }
  if (patch.storageWarningThreshold !== undefined && !(patch.storageWarningThreshold >= 50 && patch.storageWarningThreshold <= 99)) {
    throw new RuleError("Flag drives as full between 50% and 99%.");
  }
  if (
    patch.workDays !== undefined &&
    !(Array.isArray(patch.workDays) && patch.workDays.length > 0 && patch.workDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
  ) {
    throw new RuleError("Choose at least one working day.");
  }
  if (patch.effortOverrides !== undefined) {
    if (!patch.effortOverrides || typeof patch.effortOverrides !== "object" || Array.isArray(patch.effortOverrides))
      throw new RuleError("Those stage estimates are not valid.");
    for (const [key, v] of Object.entries(patch.effortOverrides)) {
      if (!Number.isFinite(v) || v < 0 || v > 30 || Math.round(v * 4) !== v * 4)
        throw new RuleError(`${key.split(":")[1] ?? key}: use a number of days from 0 to 30, in steps of a quarter day.`);
    }
  }
  if (patch.storageFolderPattern !== undefined) {
    const pattern = patch.storageFolderPattern.trim();
    if (pattern.length > 120 || /[<>:"|?*\\]/.test(pattern))
      throw new RuleError('Keep the folder pattern short, with no < > : " | ? * or backslash.');
    patch.storageFolderPattern = pattern || DEFAULT_FOLDER_PATTERN;
  }
  Object.assign(getDb().settings, patch);
  logAudit(actor, "settings", "settings", "system", Object.keys(patch).join(", "));
  commit();
}

/**
 * The workspace's accent colour and font pairing. Unlike the rest of Settings, this is not covered
 * by the "change system settings" capability: only the Head of Production sets the workspace look,
 * same as access and permissions.
 */
export function updateWorkspaceAppearance(actor: Actor, input: Partial<NonNullable<Settings["appearance"]>>): void {
  if (!isHop(actor)) throw new RuleError("Only the Head of Production can change the workspace's accent colour and font.");
  const patch = pickKeys(input, ["accent", "fontPairing"] as const);
  if (patch.accent !== undefined && !ACCENTS.some((a) => a.key === patch.accent))
    throw new RuleError("Choose one of the accent colours offered.");
  if (patch.fontPairing !== undefined && !FONT_PAIRINGS.some((f) => f.key === patch.fontPairing))
    throw new RuleError("Choose one of the font pairings offered.");
  const db = getDb();
  db.settings.appearance = { ...(db.settings.appearance ?? { accent: "terracotta", fontPairing: "modern" }), ...patch };
  logAudit(actor, "settings", "settings", "appearance", Object.keys(patch).join(", "));
  commit();
}

export function changePassword(actor: Actor, current: string, next: string): void {
  const u = getDb().users.find((x) => x.personId === actor.personId);
  if (!u || u.password !== current) throw new RuleError("Your current password is not correct.");
  if (next.length < 4) throw new RuleError("New password must be at least 4 characters.");
  u.password = next; // MOCK ONLY: bcrypt hash once a real backend exists
  logAudit(actor, "change-password", "person", actor.personId);
  commit();
}

// ── The rework's parts, switched on or off (src/config/features.ts) ──

/**
 * The categories the Content Pipeline offers. General Use is no longer one once lending (Equipment, Lending) replaces
 * it (build prompt v2): with lending on it is left out of the menu, the filters, the board and the "Add" menus. Until
 * then it stays, so gear can still go out for non-production use. Its records stay either way, and still open by their
 * links and search.
 */
export const pipelineCategories = (): CategoryConfig[] =>
  featureOn("lending") ? CATEGORIES.filter((c) => c.key !== "general") : CATEGORIES;

/** Whether a part of the rework is on: one not built yet never is; a built one is, unless switched off. */
export function featureOn(key: FeatureKey): boolean {
  const f = FEATURES.find((x) => x.key === key);
  if (!f?.built) return false;
  return getDb().settings.features?.[key] ?? true;
}

/** Switches a part of the rework on or off for everyone. The Head of Production's alone; no data changes either way. */
export function setFeature(actor: Actor, key: FeatureKey, on: boolean): void {
  if (!isHop(actor)) throw new RuleError("Only the Head of Production switches parts of the app on and off.");
  if (!FEATURE_KEYS.includes(key)) throw new RuleError("There is no such part of the app.");
  const s = getDb().settings;
  s.features = { ...(s.features ?? {}), [key]: on };
  logAudit(actor, on ? "feature-on" : "feature-off", "system", key);
  commit();
}
