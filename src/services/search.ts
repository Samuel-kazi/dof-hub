import type { Actor } from "../types";
import { getDb } from "../data/store";
import { categoryOf } from "../config/categories";
import { visibleCallSheets, visibleRecords } from "./access";
import { hasGearAccess } from "./equipment";
import { displayTitle } from "./content";
import { hasStorageAccess } from "./storage";
import { listDocs } from "./docs";
import { projectName } from "./workItems";
import { isWorkflowProject } from "./workflow/common";
import { fmtShort } from "./utils";
import { can } from "./permissions";
import { ROLES } from "../config/roles";
import type { Route } from "../ui/AppContext";

export type HitKind = "project" | "episode" | "session" | "document" | "doc" | "callsheet" | "person" | "gear" | "loan" | "drive";
export interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  sub: string;
  open: Route; // where the result opens
}

/** What each kind of result is called on screen. */
export const KIND_LABEL: Record<HitKind, string> = {
  project: "Project",
  episode: "Episode",
  session: "Session",
  document: "Document",
  doc: "Document",
  callsheet: "Call sheet",
  person: "Crew",
  gear: "Gear",
  loan: "Loan",
  drive: "Drive",
};

const KIND_ORDER: HitKind[] = ["project", "episode", "session", "document", "doc", "callsheet", "person", "gear", "loan", "drive"];

/**
 * Finds projects, episodes and devotions, recording sessions, documents, call sheets, crew, gear, loans and drives.
 * It only looks where this person is allowed to look: the projects they may see, and the people, gear, loans and drives
 * their permissions open to them.
 */
export function searchAll(actor: Actor, query: string, perKind = 4): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || query.trim().length < 2) return [];
  const match = (hay: string) => terms.every((t) => hay.toLowerCase().includes(t));
  const rank = (a: Hit, b: Hit) =>
    Number(b.title.toLowerCase().startsWith(terms[0])) - Number(a.title.toLowerCase().startsWith(terms[0])) ||
    a.title.localeCompare(b.title);
  const out = Object.fromEntries(KIND_ORDER.map((k) => [k, [] as Hit[]])) as Record<HitKind, Hit[]>;

  const visible = visibleRecords(actor);
  const byId = new Map(visible.map((r) => [r.contentId, r]));
  for (const r of visible) {
    if (r.archived || !match(`${displayTitle(r)} ${r.contentId}`)) continue;
    // A project is a top-level record or a workflow project (a season); everything under one is an episode, a
    // devotion's day, a track or a show's day.
    const isProject = r.hierarchyLevel === 0 || !!r.workflow;
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    out[isProject ? "project" : "episode"].push({
      kind: isProject ? "project" : "episode",
      id: r.contentId,
      title: displayTitle(r),
      sub: `${categoryOf(r.category).label}${parent && !isProject ? `, ${displayTitle(parent)}` : ""}, ${r.contentId}`,
      open: { n: "record", id: r.contentId },
    });
  }
  // The documents of the five-stage workflow (a Show Brief, a Recording Plan), by their title or their project's.
  for (const d of getDb().projectDocuments ?? []) {
    const p = byId.get(d.contentId);
    if (!p || p.archived || !match(`${d.title} ${displayTitle(p)}`)) continue;
    out.document.push({
      kind: "document",
      id: d.id,
      title: d.title,
      sub: `${displayTitle(p)}, ${d.stage}`,
      open: { n: "record", id: p.contentId },
    });
  }
  // A recording session of the five-stage workflow is found by its code, its project's name or its venue.
  const projects = new Map(visible.filter(isWorkflowProject).map((p) => [p.contentId, p]));
  for (const s of getDb().recordingSessions) {
    const p = projects.get(s.contentId);
    if (!p || s.archivedAt) continue;
    const name = projectName(p);
    if (match(`${s.id} ${name} session ${s.sessionNumber} ${s.venue}`))
      out.session.push({
        kind: "session",
        id: s.id,
        title: `${name}: session ${s.sessionNumber}`,
        sub: `${s.id}${s.scheduledDate ? `, ${fmtShort(s.scheduledDate)}` : ""}`,
        open: { n: "session", id: s.id },
      });
  }
  for (const d of listDocs(actor)) {
    if (match(`${d.title} ${d.id} ${d.contentId}`))
      out.doc.push({ kind: "doc", id: d.id, title: d.title, sub: `${d.id}, ${d.contentId}`, open: { n: "doc", id: d.id } });
  }
  for (const c of visibleCallSheets(actor)) {
    if (match(`${c.title} ${c.location} ${c.id}`))
      out.callsheet.push({
        kind: "callsheet",
        id: c.id,
        title: c.title,
        sub: `${fmtShort(c.date)}${c.location ? `, ${c.location}` : ""}`,
        open: { n: "callsheet", id: c.id },
      });
  }
  // Crew, by name: only for those who may see the People page, and only names and roles (contact details stay private).
  if (actor.role === "HOP" || can(actor, "people.directory"))
    for (const p of getDb().people)
      if (p.status === "active" && match(`${p.name} ${p.personId}`))
        out.person.push({
          kind: "person",
          id: p.personId,
          title: p.name,
          sub: ROLES[p.category].label,
          open: { n: "person", id: p.personId },
        });
  if (hasGearAccess(actor)) {
    for (const e of getDb().equipment) {
      if (match(`${e.name} ${e.make} ${e.model} ${e.id} ${e.serialNumber ?? ""} ${e.unitLabel ?? ""} ${e.itemFamily ?? ""}`))
        out.gear.push({ kind: "gear", id: e.id, title: e.name, sub: e.id, open: { n: "item", id: e.id } });
    }
    for (const l of getDb().loans ?? [])
      if (match(`${l.borrowerName} ${l.organisation} ${l.id}`))
        out.loan.push({
          kind: "loan",
          id: l.id,
          title: `${l.borrowerName}${l.organisation ? ` (${l.organisation})` : ""}`,
          sub: `${l.id}, ${l.status === "out" ? `due back ${fmtShort(l.expectedReturn)}` : l.status}`,
          open: { n: "equipment" },
        });
  }
  if (hasStorageAccess(actor)) {
    for (const d of getDb().drives)
      if (match(d.name)) out.drive.push({ kind: "drive", id: d.id, title: d.name, sub: "Drive", open: { n: "drive", id: d.id } });
  }
  return KIND_ORDER.flatMap((k) => out[k].sort(rank).slice(0, perKind));
}
