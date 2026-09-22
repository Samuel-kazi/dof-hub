import type { Actor, RoleCode } from "../types";
import { RuleError } from "../types";
import { commit, getDb } from "../data/store";
import { ALL_CAPABILITIES, DEFAULT_GRANTS, capabilityDef, type Capability } from "../config/permissions";
import { MODULE_LABELS, ROLES, type ModuleKey } from "../config/roles";
import { logAudit } from "./audit";

// One place decides what a person may do. The Head of Production always may. For everyone else the
// answer is their own setting if the Head of Production gave one, then their role's setting, then the default.

export interface PermissionSettings {
  roles: Partial<Record<RoleCode, Partial<Record<Capability, boolean>>>>;
  people: Record<string, Partial<Record<Capability, boolean>>>;
}

const store = (): PermissionSettings => {
  const s = getDb().settings;
  s.permissions ??= { roles: {}, people: {} };
  return s.permissions;
};

export type GrantSource = "always" | "person" | "role" | "default";

export function grantFor(role: RoleCode, personId: string | null, cap: Capability): { value: boolean; source: GrantSource } {
  if (role === "HOP") return { value: true, source: "always" };
  const p = store();
  const own = personId ? p.people[personId]?.[cap] : undefined;
  if (own !== undefined) return { value: own, source: "person" };
  const byRole = p.roles[role]?.[cap];
  if (byRole !== undefined) return { value: byRole, source: "role" };
  return { value: DEFAULT_GRANTS[role].includes(cap), source: "default" };
}

export const can = (actor: Actor, cap: Capability): boolean => grantFor(actor.role, actor.personId, cap).value;

export function requireCan(actor: Actor, cap: Capability, what: string): void {
  if (!can(actor, cap)) throw new RuleError(`Only the Head of Production, or someone given "${capabilityDef(cap).label}", can ${what}.`);
}

function requireAdmin(actor: Actor): void {
  if (actor.role !== "HOP") throw new RuleError("Only the Head of Production can change who can do what.");
}

/** Sets a role's default for one capability. `null` goes back to the built-in default. */
export function setRoleGrant(actor: Actor, role: RoleCode, cap: Capability, value: boolean | null): void {
  requireAdmin(actor);
  if (role === "HOP") throw new RuleError("The Head of Production always has full access.");
  const r = (store().roles[role] ??= {});
  if (value === null) delete r[cap];
  else r[cap] = value;
  logAudit(actor, "permission-role", "settings", role, `${cap}: ${value === null ? "default" : value ? "allowed" : "denied"}`);
  commit();
}

/** Gives one person more or less than their role has. `null` goes back to their role. */
export function setPersonGrant(actor: Actor, personId: string, cap: Capability, value: boolean | null): void {
  requireAdmin(actor);
  const person = getDb().people.find((p) => p.personId === personId);
  if (!person) throw new RuleError("Person not found.");
  if (person.category === "HOP") throw new RuleError("The Head of Production always has full access.");
  const p = (store().people[personId] ??= {});
  if (value === null) delete p[cap];
  else p[cap] = value;
  if (Object.keys(p).length === 0) delete store().people[personId];
  logAudit(actor, "permission-person", "person", personId, `${cap}: ${value === null ? "role default" : value ? "allowed" : "denied"}`);
  commit();
}

export function resetPermissions(actor: Actor): void {
  requireAdmin(actor);
  getDb().settings.permissions = { roles: {}, people: {} };
  logAudit(actor, "permission-reset", "settings", "all", "back to the defaults");
  commit();
}

/** How many settings differ from the defaults, for the summary line. */
export function customisations(): { roles: number; people: number } {
  const p = store();
  return { roles: Object.values(p.roles).reduce((n, r) => n + Object.keys(r ?? {}).length, 0), people: Object.keys(p.people).length };
}

export function effectiveGrants(role: RoleCode, personId: string): Record<Capability, { value: boolean; source: GrantSource }> {
  return Object.fromEntries(ALL_CAPABILITIES.map((c) => [c, grantFor(role, personId, c)])) as Record<Capability, { value: boolean; source: GrantSource }>;
}

// ── Modules in the side menu ─────────────────────────────────

const ORDER: ModuleKey[] = ["dashboard", "pipeline", "callsheets", "calendar", "equipment", "storage", "crew", "documents", "reminders", "settings"];
const MODULE_CAP: Partial<Record<ModuleKey, Capability>> = { equipment: "equipment.use", storage: "storage.use", crew: "people.directory", reminders: "reminders.use", calendar: "reminders.use" };

/** The modules a person sees. Those that depend on a permission follow it. */
export function modulesFor(actor: Actor): ModuleKey[] {
  return ORDER.filter((m) => (MODULE_CAP[m] ? can(actor, MODULE_CAP[m]!) : ROLES[actor.role].modules.includes(m)));
}

export { MODULE_LABELS };
