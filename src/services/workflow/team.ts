import type { Actor, ProjectRole, RoleKey, WorkflowChecklistItem } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { localId } from "../../data/ids";
import { PROJECT_ROLE_DEFS, roleLabel } from "../../config/workflow";
import { logAudit } from "../audit";
import { getPerson } from "../people";
import { canManageTeam, episodeForWrite, joinProject, nowStamp, projectForWrite, requireCrew, sessionForWrite } from "./common";

// The people on a project, and its checklists.

// ── Project roles ────────────────────────────────────────────

export interface RoleInput {
  crewId?: string | null; // someone on the crew list
  guestName?: string | null; // hosts and guests only: someone not on the crew list
}

/**
 * Gives a role to someone on the crew list, chosen from a dropdown. The producer assigns roles at Pre-production.
 * Every role but host or guest is held by one person, so assigning it again replaces who holds it. A host or
 * guest can also be someone outside the crew, by name.
 */
export function assignRole(actor: Actor, projectId: string, roleKey: RoleKey, who: RoleInput): ProjectRole {
  const p = projectForWrite(actor, projectId);
  if (!canManageTeam(actor, p))
    throw new RuleError(
      'Only the show producer, the Head of Production, or someone given "Assign other people\'s work", can assign roles.',
    );
  const def = PROJECT_ROLE_DEFS.find((r) => r.key === roleKey);
  if (!def) throw new RuleError("That is not a project role.");
  if (p.workflow.stage !== "Pre-production")
    throw new RuleError("Roles are assigned at Pre-production, once the project is greenlit and handed off.");
  const crewId = who.crewId || null;
  const guestName = (who.guestName ?? "").trim();
  if (def.exclusive && !crewId) throw new RuleError(`Choose who is the ${def.label.toLowerCase()} from the crew list.`);
  if (crewId && guestName) throw new RuleError("Choose someone on the crew list, or type the name of someone outside it, not both.");
  if (!crewId && !guestName) throw new RuleError("Choose someone on the crew list, or type the name of someone outside it.");
  if (crewId) requireCrew(crewId, def.label);
  if (guestName.length > 120) throw new RuleError("That name is too long.");
  const db = getDb();
  const at = nowStamp();
  if (def.exclusive) {
    const id = `${projectId}|${roleKey}`;
    const existing = db.projectRoles.find((r) => r.id === id);
    if (existing) {
      Object.assign(existing, { crewId, assignedById: actor.personId, assignedAt: at, updatedAt: at });
      joinProject(actor, crewId!, p);
      logAudit(actor, "role", "record", projectId, `${def.label}: ${getPerson(crewId!)?.name ?? crewId}`);
      commit();
      return existing;
    }
  } else {
    const same = db.projectRoles.find(
      (r) =>
        r.contentId === projectId &&
        r.roleKey === roleKey &&
        ((crewId && r.crewId === crewId) || (guestName && r.guestName.toLowerCase() === guestName.toLowerCase())),
    );
    if (same) throw new RuleError(`${crewId ? getPerson(crewId)?.name : guestName} is already a host or guest on this project.`);
  }
  const role: ProjectRole = {
    id: def.exclusive
      ? `${projectId}|${roleKey}`
      : `${projectId}|${roleKey}|${localId("G", (x) => db.projectRoles.some((r) => r.id.endsWith(`|${x}`)))}`,
    contentId: projectId,
    roleKey,
    exclusive: def.exclusive,
    crewId,
    guestName: crewId ? "" : guestName,
    assignedById: actor.personId,
    assignedAt: at,
    createdAt: at,
    updatedAt: at,
  };
  db.projectRoles.push(role);
  if (crewId) joinProject(actor, crewId, p);
  logAudit(actor, "role", "record", projectId, `${def.label}: ${crewId ? (getPerson(crewId)?.name ?? crewId) : guestName}`);
  commit();
  return role;
}

export function removeRole(actor: Actor, roleId: string): void {
  const db = getDb();
  const role = db.projectRoles.find((r) => r.id === roleId);
  if (!role) throw new RuleError("That role is no longer assigned.");
  const p = projectForWrite(actor, role.contentId);
  if (!canManageTeam(actor, p))
    throw new RuleError(
      'Only the show producer, the Head of Production, or someone given "Assign other people\'s work", can change roles.',
    );
  db.projectRoles = db.projectRoles.filter((r) => r.id !== roleId);
  logAudit(actor, "role-remove", "record", role.contentId, roleLabel(role.roleKey));
  commit();
}

// ── Checklists ───────────────────────────────────────────────

/** Ticks or unticks a checklist item, or changes its note. A closed session's checklists stay as they were. */
export function setChecklistItem(actor: Actor, itemId: string, change: { done?: boolean; note?: string }): WorkflowChecklistItem {
  const item = getDb().workflowChecklistItems.find((c) => c.id === itemId);
  if (!item) throw new RuleError("Checklist item not found.");
  if (item.ownerType === "project") projectForWrite(actor, item.ownerId);
  else if (item.ownerType === "episode") episodeForWrite(actor, item.ownerId);
  else {
    const { session } = sessionForWrite(actor, item.ownerId);
    if (session.status === "Closed") throw new RuleError("This session is closed. Reopen it to change its checklists.");
  }
  if (change.note !== undefined) {
    if (change.note.length > 2000) throw new RuleError("Keep the note under 2,000 characters.");
    item.note = change.note.trim();
  }
  if (change.done !== undefined && change.done !== item.done) {
    item.done = change.done;
    item.doneAt = change.done ? nowStamp() : null;
    item.doneById = change.done ? actor.personId : null;
  }
  item.updatedAt = nowStamp();
  logAudit(
    actor,
    "checklist",
    item.ownerType === "session" ? "session" : "record",
    item.ownerId,
    `${item.label}${change.done === undefined ? "" : item.done ? ": done" : ": not done"}`,
  );
  commit();
  return item;
}
