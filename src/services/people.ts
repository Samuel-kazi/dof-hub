import type { Actor, Person, ProjectMember, RoleCode, User, ContentRecord } from "../types";
import { RuleError } from "../types";
import { commit, getDb } from "../data/store";
import { ROLES } from "../config/roles";
import { cleanRoles } from "../config/projectRoles";
import { requireCan } from "./permissions";
import { getRecord, isHop } from "./access";
import { logAudit } from "./audit";
import { pad, todayIso } from "./utils";

/** Highest existing number for the role prefix, plus one. Called once, at save time. */
export function generatePersonId(category: RoleCode): string {
  const prefix = ROLES[category].idPrefix;
  const nums = getDb()
    .people.filter((p) => p.personId.startsWith(prefix + "-"))
    .map((p) => parseInt(p.personId.slice(prefix.length + 1), 10))
    .filter((n) => !Number.isNaN(n));
  return `${prefix}-${pad((nums.length ? Math.max(...nums) : 0) + 1)}`;
}

function requireHop(actor: Actor, what: string) {
  requireCan(actor, "people.manage", what);
}

export interface PersonInput {
  category: Exclude<RoleCode, "HOP">;
  name: string;
  email: string;
  phone: string;
  skills: string[];
  equipmentFamiliarity: string[];
}

export function getPerson(id: string): Person | undefined {
  return getDb().people.find((p) => p.personId === id);
}

export const nameOf = (id: string | null | undefined): string => (id ? getPerson(id)?.name ?? id : "Unassigned");

export function createLoginForPerson(actor: Actor, personId: string, email: string, password: string): User {
  requireHop(actor, "create logins");
  const p = getPerson(personId);
  if (!p) throw new RuleError("Person not found.");
  if (getDb().users.some((u) => u.personId === personId)) throw new RuleError("This person already has a login.");
  if (!email.trim()) throw new RuleError("Enter an email address for the login.");
  if (getDb().users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) throw new RuleError("That email is already used by another login.");
  if (password.length < 4) throw new RuleError("Password must be at least 4 characters.");
  const user: User = {
    userId: `U-${pad(getDb().users.length + 1)}`,
    personId,
    email: email.trim(),
    password, // MOCK ONLY: hash with bcrypt once a real backend exists
    role: p.category, // auto-set from category, overridable later without touching the profile
    active: true,
  };
  getDb().users.push(user);
  p.hasLogin = true;
  logAudit(actor, "create-login", "person", personId, email);
  commit();
  return user;
}

/** Creates the profile, then the login if requested, as a single action from the user's view. */
export function createPerson(actor: Actor, input: PersonInput, login?: { email: string; password: string }): Person {
  requireHop(actor, "add people");
  if (!input.name.trim()) throw new RuleError("Enter a name.");
  if (login) {
    // Validate the login half up front so we never end up with a half-created person.
    if (!login.email.trim()) throw new RuleError("Enter an email address for the login.");
    if (getDb().users.some((u) => u.email.toLowerCase() === login.email.trim().toLowerCase())) throw new RuleError("That email is already used by another login.");
    if (login.password.length < 4) throw new RuleError("Password must be at least 4 characters.");
  }
  const person: Person = {
    personId: generatePersonId(input.category),
    category: input.category,
    name: input.name.trim(),
    email: input.email.trim(),
    phone: input.phone.trim(),
    skills: input.skills,
    equipmentFamiliarity: input.equipmentFamiliarity,
    hasLogin: false,
    status: "active",
    createdAt: todayIso(),
  };
  getDb().people.push(person);
  logAudit(actor, "create", "person", person.personId, person.name);
  commit();
  if (login) createLoginForPerson(actor, person.personId, login.email, login.password);
  return person;
}

export function updatePerson(actor: Actor, personId: string, patch: Partial<Pick<Person, "name" | "email" | "phone" | "skills" | "equipmentFamiliarity">>): Person {
  requireHop(actor, "edit people");
  const p = getPerson(personId);
  if (!p) throw new RuleError("Person not found.");
  Object.assign(p, patch);
  logAudit(actor, "update", "person", personId, Object.keys(patch).join(", "));
  commit();
  return p;
}

/** Anyone can correct their own name and contact details. Access level and ID stay with the Head of Production. */
export function updateOwnProfile(actor: Actor, patch: Partial<Pick<Person, "name" | "email" | "phone" | "notifyEmail" | "notifySms">>): Person {
  const p = getPerson(actor.personId);
  if (!p) throw new RuleError("Person not found.");
  if (patch.name !== undefined && !patch.name.trim()) throw new RuleError("Enter your name.");
  Object.assign(p, {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.email !== undefined ? { email: patch.email.trim() } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone.trim() } : {}),
    ...(patch.notifyEmail !== undefined ? { notifyEmail: patch.notifyEmail } : {}),
    ...(patch.notifySms !== undefined ? { notifySms: patch.notifySms } : {}),
  });
  logAudit(actor, "update-profile", "person", actor.personId, Object.keys(patch).join(", "));
  commit();
  return p;
}

/** Promotion: the number in the ID never changes; only the category and login role do. */
export function updatePersonCategory(actor: Actor, personId: string, newCategory: Exclude<RoleCode, "HOP">): Person {
  requireHop(actor, "change someone's category");
  const p = getPerson(personId);
  if (!p) throw new RuleError("Person not found.");
  if (p.category === "HOP") throw new RuleError("The Head of Production category cannot be changed here.");
  const from = p.category;
  p.category = newCategory;
  const u = getDb().users.find((x) => x.personId === personId);
  if (u) u.role = newCategory;
  logAudit(actor, "change-category", "person", personId, `${from} → ${newCategory}`);
  commit();
  return p;
}

/** Deactivate, never delete: their history stays on past call sheets and projects. */
export function deactivatePerson(actor: Actor, personId: string): void {
  requireHop(actor, "deactivate people");
  const p = getPerson(personId);
  if (!p) throw new RuleError("Person not found.");
  if (p.category === "HOP") throw new RuleError("The Head of Production cannot be deactivated.");
  p.status = "inactive";
  const u = getDb().users.find((x) => x.personId === personId);
  if (u) u.active = false;
  logAudit(actor, "deactivate", "person", personId);
  commit();
}

export function reactivatePerson(actor: Actor, personId: string): void {
  requireHop(actor, "reactivate people");
  const p = getPerson(personId);
  if (!p) throw new RuleError("Person not found.");
  p.status = "active";
  const u = getDb().users.find((x) => x.personId === personId);
  if (u) u.active = true;
  logAudit(actor, "reactivate", "person", personId);
  commit();
}

export function projectHistory(personId: string): { member: ProjectMember; record: ContentRecord }[] {
  return getDb()
    .members.filter((m) => m.personId === personId)
    .map((member) => ({ member, record: getRecord(member.projectContentId)! }))
    .filter((x) => !!x.record);
}

export function assignToProject(actor: Actor, personId: string, contentId: string, roleOnProject: string, canComment: boolean): void {
  requireHop(actor, "assign people to projects");
  const rec = getRecord(contentId);
  if (!rec) throw new RuleError("Project not found.");
  if (getDb().members.some((m) => m.personId === personId && m.projectContentId === contentId)) throw new RuleError("Already assigned to this project.");
  const roles = cleanRoles(roleOnProject.split(","));
  getDb().members.push({ personId, projectContentId: contentId, roleOnProject: roles.join(", ") || "Team member", canComment });
  logAudit(actor, "assign", "person", personId, contentId);
  commit();
}

/** Stages and tasks a person still owns on a project. They have to be handed over before the person can leave it. */
export function workOwnedOn(personId: string, contentId: string): { stages: number; tasks: number } {
  const under = getDb().records.filter((r) => !r.archived && (r.contentId === contentId || r.contentId.startsWith(`${contentId}-`)));
  return {
    stages: under.reduce((n, r) => n + Object.values(r.stageAssignees).filter((list) => list.some((o) => o.personId === personId)).length, 0),
    tasks: under.reduce((n, r) => n + r.tasks.filter((t) => t.assigneePersonId === personId && !t.done).length, 0),
  };
}

export function removeFromProject(actor: Actor, personId: string, contentId: string): void {
  requireHop(actor, "remove people from projects");
  const owned = workOwnedOn(personId, contentId);
  if (owned.stages || owned.tasks) {
    const parts = [owned.stages ? `${owned.stages} stage${owned.stages > 1 ? "s" : ""}` : "", owned.tasks ? `${owned.tasks} open task${owned.tasks > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
    throw new RuleError(`${getPerson(personId)?.name ?? personId} still owns ${parts} on this project. Hand them to someone else first.`);
  }
  getDb().members = getDb().members.filter((m) => !(m.personId === personId && m.projectContentId === contentId));
  logAudit(actor, "unassign", "person", personId, contentId);
  commit();
}

/** Active crew not booked on any call sheet for the given date. */
export function crewAvailableOn(date: string): { available: Person[]; total: Person[] } {
  const db = getDb();
  const total = db.people.filter((p) => p.category === "CRW" && p.status === "active");
  const busy = new Set(db.callSheets.filter((cs) => cs.date === date).flatMap((cs) => cs.crewPersonIds));
  return { available: total.filter((p) => !busy.has(p.personId)), total };
}
