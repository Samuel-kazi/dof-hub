import type { Actor, CallSheet, ContentRecord, Person } from "../types";
import { getDb } from "../data/store";
import { ROLES } from "../config/roles";
import { can } from "./permissions";

// The single place where project scoping and role rules are enforced.
// Every module's fetch goes through these helpers (no RLS, so discipline matters).

export const getRecord = (id: string): ContentRecord | undefined => getDb().records.find((r) => r.contentId === id);

/** The record itself followed by each ancestor up to the root. */
export function selfAndAncestors(record: ContentRecord): ContentRecord[] {
  const out: ContentRecord[] = [record];
  let cur = record;
  while (cur.parentId) {
    const parent = getRecord(cur.parentId);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

export const rootOf = (record: ContentRecord): ContentRecord => selfAndAncestors(record).slice(-1)[0];

export function membershipFor(actor: Actor, record: ContentRecord) {
  const ids = new Set(selfAndAncestors(record).map((r) => r.contentId));
  return getDb().members.find((m) => m.personId === actor.personId && ids.has(m.projectContentId));
}

export function isHop(actor: Actor): boolean {
  return ROLES[actor.role].globalAccess;
}

export function canView(actor: Actor, record: ContentRecord): boolean {
  if (isHop(actor)) return true;
  if (can(actor, "pipeline.viewAll") || can(actor, "pipeline.editAll")) return true;
  return !!membershipFor(actor, record);
}

export function canWrite(actor: Actor, record: ContentRecord): boolean {
  if (isHop(actor)) return true;
  if (can(actor, "pipeline.editAll")) return true;
  return ROLES[actor.role].canWrite && !!membershipFor(actor, record);
}

/** Can this person add themselves to the record's project to help? Adding themselves makes them part of it. */
export function canJoin(actor: Actor, record: ContentRecord): boolean {
  return canView(actor, record) && can(actor, "pipeline.join");
}

export function canComment(actor: Actor, record: ContentRecord): boolean {
  if (isHop(actor)) return true;
  if (actor.role === "CRW" && canView(actor, record)) return true;
  const m = membershipFor(actor, record);
  if (!m) return false;
  if (actor.role === "CRW") return true;
  if (actor.role === "PTR") return m.canComment; // explicit per-project flag
  return false;
}

export function visibleRecords(actor: Actor, includeArchived = false): ContentRecord[] {
  return getDb().records.filter((r) => (includeArchived || !r.archived) && canView(actor, r));
}

export function visibleCallSheets(actor: Actor): CallSheet[] {
  return getDb().callSheets.filter((cs) => {
    const root = getRecord(cs.contentId);
    return !!root && canView(actor, root);
  });
}

/**
 * Field-level rules. Contact details of volunteers and partners stay with the Head of Production unless
 * it is granted to someone. Whether someone has a login is for the Head of Production too.
 */
export function redactPerson(actor: Actor, p: Person): Person {
  if (isHop(actor) || actor.personId === p.personId) return p;
  let out = p;
  const hideContact = !can(actor, "people.contacts") && (actor.role === "VOL" || actor.role === "PTR" || p.category === "VOL" || p.category === "PTR");
  if (hideContact) out = { ...out, email: "Hidden", phone: "Hidden", equipmentFamiliarity: [] };
  if (!can(actor, "people.loginStatus")) out = { ...out, hasLogin: false, username: undefined, loginOff: undefined };
  return out;
}
