import type { Actor, ContentRecord, Person, ProjectMember } from "../types";
import { RuleError } from "../types";
import { commit, getDb } from "../data/store";
import { PROJECT_ROLES, cleanRoles, rolesOf } from "../config/projectRoles";
export { cleanRoles, rolesOf };
import { getRecord, isHop, rootOf, selfAndAncestors } from "./access";
import { logAudit } from "./audit";
import { requireCan } from "./permissions";
import { getPerson } from "./people";

// A project team is a list of people with the roles they do on it. Being on the team is also what gives
// someone access to the project, so only the Head of Production changes it.

export interface TeamEntry { member: ProjectMember; person: Person; roles: string[] }

const GENERIC_ROLES = ["assigned", "team member"];

/**
 * What a person does on a project: the roles they hold on its stages and on the project itself,
 * plus any role recorded when they were attached from the Crew page.
 */
export function rolesOnProject(personId: string, rec: ContentRecord): string[] {
  const root = rootOf(rec);
  const under = getDb().records.filter((r) => r.contentId === root.contentId || r.contentId.startsWith(`${root.contentId}-`));
  const out: string[] = [];
  const add = (role: string) => { if (!GENERIC_ROLES.includes(role.toLowerCase()) && !out.some((x) => x.toLowerCase() === role.toLowerCase())) out.push(role); };
  for (const r of under) for (const list of Object.values(r.stageAssignees)) for (const o of list) if (o.personId === personId) o.roles.forEach(add);
  const m = getDb().members.find((x) => x.personId === personId && x.projectContentId === root.contentId);
  if (m) rolesOf(m).forEach(add);
  return out;
}

/** Everyone attached to the project this record belongs to, with what each does on it. */
export function teamOf(rec: ContentRecord): TeamEntry[] {
  const ids = new Set(selfAndAncestors(rec).map((r) => r.contentId));
  return getDb()
    .members.filter((m) => ids.has(m.projectContentId))
    .map((member) => ({ member, person: getPerson(member.personId)!, roles: rolesOnProject(member.personId, rec) }))
    .filter((x) => !!x.person)
    .sort((a, b) => a.person.name.localeCompare(b.person.name));
}

/** The role someone does on this record's project, for showing next to their name. */
export function roleOn(personId: string | null | undefined, rec: ContentRecord): string | null {
  if (!personId) return null;
  const roles = rolesOnProject(personId, rec);
  if (roles.length) return roles.join(", ");
  return getPerson(personId)?.category === "HOP" ? "Head of Production" : null;
}

/** "Wanjiru Kamau (Director, Editor)" style label. */
export function nameWithRole(personId: string | null | undefined, rec: ContentRecord, fallback = "Unassigned"): string {
  if (!personId) return fallback;
  const name = getPerson(personId)?.name ?? personId;
  const role = roleOn(personId, rec);
  return role && role !== name ? `${name} (${role})` : name;
}

/** Suggestions for the role box: the standard list plus any role the team has already used. */
export function knownRoles(): string[] {
  const used = getDb().members.flatMap(rolesOf);
  return [...new Set([...PROJECT_ROLES, ...used])].sort((a, b) => a.localeCompare(b));
}

function requireHop(actor: Actor): void {
  requireCan(actor, "people.manage", "change who is on a project");
}

function rootFor(contentId: string): ContentRecord {
  const rec = getRecord(contentId);
  if (!rec) throw new RuleError("Project not found.");
  return rootOf(rec);
}

export function addTeamMember(actor: Actor, contentId: string, personId: string, roles: string[], canComment: boolean): void {
  requireHop(actor);
  const root = rootFor(contentId);
  const person = getPerson(personId);
  if (!person || person.status !== "active") throw new RuleError("Choose an active person.");
  if (person.category === "HOP") throw new RuleError("The Head of Production already has access to every project.");
  if (getDb().members.some((m) => m.personId === personId && m.projectContentId === root.contentId)) throw new RuleError(`${person.name} is already on this project. Change their roles instead.`);
  const cleaned = cleanRoles(roles);
  getDb().members.push({ personId, projectContentId: root.contentId, roleOnProject: cleaned.join(", ") || "Team member", canComment: person.category === "CRW" ? true : canComment });
  logAudit(actor, "assign", "person", personId, `${root.contentId}: ${cleaned.join(", ")}`);
  commit();
}

export function setMemberRoles(actor: Actor, contentId: string, personId: string, roles: string[], canComment?: boolean): void {
  requireHop(actor);
  const root = rootFor(contentId);
  const m = getDb().members.find((x) => x.personId === personId && x.projectContentId === root.contentId);
  if (!m) throw new RuleError("That person is not on this project.");
  const cleaned = cleanRoles(roles);
  m.roleOnProject = cleaned.join(", ") || "Team member";
  if (canComment !== undefined && getPerson(personId)?.category !== "CRW") m.canComment = canComment;
  logAudit(actor, "update-role", "person", personId, `${root.contentId}: ${m.roleOnProject}`);
  commit();
}
