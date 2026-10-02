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

export type HitKind = "project" | "session" | "doc" | "callsheet" | "gear" | "drive";
export interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  sub: string;
}

const KIND_ORDER: HitKind[] = ["project", "session", "doc", "callsheet", "gear", "drive"];

/** Finds projects, call sheets, gear and drives. It only looks where this person is allowed to look. */
export function searchAll(actor: Actor, query: string, perKind = 4): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || query.trim().length < 2) return [];
  const match = (hay: string) => terms.every((t) => hay.toLowerCase().includes(t));
  const rank = (a: Hit, b: Hit) =>
    Number(b.title.toLowerCase().startsWith(terms[0])) - Number(a.title.toLowerCase().startsWith(terms[0])) ||
    a.title.localeCompare(b.title);
  const out: Record<HitKind, Hit[]> = { project: [], session: [], doc: [], callsheet: [], gear: [], drive: [] };

  const visible = visibleRecords(actor);
  for (const r of visible) {
    if (!r.archived && match(`${displayTitle(r)} ${r.contentId}`))
      out.project.push({
        kind: "project",
        id: r.contentId,
        title: displayTitle(r),
        sub: `${categoryOf(r.category).label}, ${r.contentId}`,
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
      });
  }
  for (const d of listDocs(actor)) {
    if (match(`${d.title} ${d.id} ${d.contentId}`)) out.doc.push({ kind: "doc", id: d.id, title: d.title, sub: `${d.id}, ${d.contentId}` });
  }
  for (const c of visibleCallSheets(actor)) {
    if (match(`${c.title} ${c.location} ${c.id}`))
      out.callsheet.push({ kind: "callsheet", id: c.id, title: c.title, sub: `${fmtShort(c.date)}${c.location ? `, ${c.location}` : ""}` });
  }
  if (hasGearAccess(actor)) {
    for (const e of getDb().equipment) {
      if (match(`${e.name} ${e.make} ${e.model} ${e.id} ${e.serialNumber ?? ""} ${e.unitLabel ?? ""} ${e.itemFamily ?? ""}`))
        out.gear.push({ kind: "gear", id: e.id, title: e.name, sub: e.id });
    }
  }
  if (hasStorageAccess(actor)) {
    for (const d of getDb().drives) if (match(d.name)) out.drive.push({ kind: "drive", id: d.id, title: d.name, sub: "Drive" });
  }
  return KIND_ORDER.flatMap((k) => out[k].sort(rank).slice(0, perKind));
}
