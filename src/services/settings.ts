import type { Actor, Settings } from "../types";
import { RuleError } from "../types";
import { commit, getDb } from "../data/store";
import { requireCan } from "./permissions";
import { isHop } from "./access";
import { ACCENTS, FONT_PAIRINGS } from "../config/appearance";
import { logAudit } from "./audit";

export function updateSettings(actor: Actor, patch: Partial<Settings>): void {
  requireCan(actor, "backend.settings", "change system settings");
  if (patch.stageReminderHours !== undefined && !(patch.stageReminderHours >= 1 && patch.stageReminderHours <= 240)) {
    throw new RuleError("Reminder window must be between 1 and 240 hours.");
  }
  if (patch.checkoutReturnDays !== undefined && !(Number.isInteger(patch.checkoutReturnDays) && patch.checkoutReturnDays >= 1 && patch.checkoutReturnDays <= 60)) {
    throw new RuleError("Return window must be a whole number of days, 1 to 60.");
  }
  if (patch.storageWarningThreshold !== undefined && !(patch.storageWarningThreshold >= 50 && patch.storageWarningThreshold <= 99)) {
    throw new RuleError("Flag drives as full between 50% and 99%.");
  }
  if (patch.workDays !== undefined && !(Array.isArray(patch.workDays) && patch.workDays.length > 0 && patch.workDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) {
    throw new RuleError("Choose at least one working day.");
  }
  if (patch.effortOverrides !== undefined) {
    for (const [key, v] of Object.entries(patch.effortOverrides)) {
      if (!Number.isFinite(v) || v < 0 || v > 30 || Math.round(v * 4) !== v * 4) throw new RuleError(`${key.split(":")[1] ?? key}: use a number of days from 0 to 30, in steps of a quarter day.`);
    }
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
export function updateWorkspaceAppearance(actor: Actor, patch: Partial<NonNullable<Settings["appearance"]>>): void {
  if (!isHop(actor)) throw new RuleError("Only the Head of Production can change the workspace's accent colour and font.");
  if (patch.accent !== undefined && !ACCENTS.some((a) => a.key === patch.accent)) throw new RuleError("Choose one of the accent colours offered.");
  if (patch.fontPairing !== undefined && !FONT_PAIRINGS.some((f) => f.key === patch.fontPairing)) throw new RuleError("Choose one of the font pairings offered.");
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
