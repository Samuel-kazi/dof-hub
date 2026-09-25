import type { Actor, ContentRecord, DocRecord, DocRevision } from "../types";
import { ConflictError, RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { categoryOf } from "../config/categories";
import { templateOf } from "../config/docTemplates";
import { canView, canWrite, getRecord, selfAndAncestors } from "./access";
import { logAudit } from "./audit";
import { pad } from "./utils";

// Documents belong to a project by Content ID. Anyone who can view the project can read them,
// anyone who can write to the project can edit them, and every save is kept as a revision.

const MAX_BODY = 200_000;
const COALESCE_MS = 10 * 60 * 1000; // quick saves by the same person merge into one revision

/** What a document is about. A day of a live show carries the show's name, so five Day 1s stay apart. */
export function docSubject(r: ContentRecord): string {
  const parent = r.parentId ? getRecord(r.parentId) : undefined;
  return r.category === "live" && parent ? `${parent.title}, ${r.title}` : r.title;
}

export const getDoc = (id: string): DocRecord | undefined => getDb().docs.find((d) => d.id === id);

export function canViewDoc(actor: Actor, d: DocRecord): boolean {
  const r = getRecord(d.contentId);
  return !!r && canView(actor, r);
}
export function canEditDoc(actor: Actor, d: DocRecord): boolean {
  const r = getRecord(d.contentId);
  return !!r && canWrite(actor, r) && !d.archived;
}

export function listDocs(actor: Actor): DocRecord[] {
  return getDb().docs.filter((d) => !d.archived && canViewDoc(actor, d)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function descendantIds(r: ContentRecord): string[] {
  return [r.contentId, ...getDb().records.filter((c) => c.parentId === r.contentId && !c.archived).flatMap(descendantIds)];
}

/** Documents for this record, for anything under it, and for the show above it. */
export function docsForRecord(actor: Actor, r: ContentRecord): DocRecord[] {
  const ids = new Set([...descendantIds(r), ...selfAndAncestors(r).map((x) => x.contentId)]);
  return listDocs(actor).filter((d) => ids.has(d.contentId));
}

export const revisionsOf = (docId: string): DocRevision[] =>
  getDb().docRevisions.filter((v) => v.docId === docId).sort((a, b) => b.at.localeCompare(a.at) || b.version - a.version);

function pushRevision(d: DocRecord, byPersonId: string, note: string): DocRevision {
  const rev: DocRevision = { id: `REV-${pad(nextCounter("docrev"), 5)}`, docId: d.id, version: d.version, at: new Date().toISOString(), byPersonId, title: d.title, body: d.body, note };
  getDb().docRevisions.push(rev);
  return rev;
}

/** Creates a document without saving to storage. The caller commits. Used for automatic attachment. */
function makeDoc(actor: Actor, contentId: string, title: string, body: string, templateKey: string | null, stage: string | null): DocRecord {
  const now = new Date().toISOString();
  const d: DocRecord = { id: `DOF-DCS-${pad(nextCounter("doc"))}`, contentId, title, body, templateKey, stage, version: 1, createdBy: actor.personId, createdAt: now, updatedAt: now, updatedBy: actor.personId, archived: false };
  getDb().docs.push(d);
  pushRevision(d, actor.personId, templateKey ? "Created from template" : "Created");
  logAudit(actor, "create", "document", d.id, title);
  return d;
}

export interface NewDocInput { contentId: string; title?: string; templateKey?: string | null; body?: string }

export function createDoc(actor: Actor, input: NewDocInput): DocRecord {
  const r = getRecord(input.contentId);
  if (!r) throw new RuleError("Choose the project this document belongs to.");
  if (!canWrite(actor, r)) throw new RuleError("You have view-only access to this project.");
  const tpl = input.templateKey ? templateOf(input.templateKey) : undefined;
  const title = (input.title ?? "").trim() || (tpl ? `${tpl.title}: ${docSubject(r)}` : "");
  if (!title) throw new RuleError("Give the document a title.");
  const d = makeDoc(actor, r.contentId, title, input.body ?? tpl?.body ?? "", tpl?.key ?? null, null);
  commit();
  return d;
}

/** Moves a document to a different project. */
export function attachDoc(actor: Actor, id: string, contentId: string): DocRecord {
  const d = getDoc(id);
  if (!d) throw new RuleError("Document not found.");
  if (!canEditDoc(actor, d)) throw new RuleError("You have view-only access to this document.");
  if (d.contentId === contentId) throw new RuleError("This document is already attached here.");
  const target = getRecord(contentId);
  if (!target) throw new RuleError("Project not found.");
  if (!canWrite(actor, target)) throw new RuleError("You are not attached to that project.");
  const from = d.contentId;
  d.contentId = contentId;
  d.updatedAt = new Date().toISOString();
  d.updatedBy = actor.personId;
  logAudit(actor, "attach", "document", id, `${from} to ${contentId}`);
  commit();
  return d;
}

/** Attaches the documents a stage calls for, once. Returns what it created. The caller commits. */
export function attachStageDocs(actor: Actor, r: ContentRecord, stage: string): DocRecord[] {
  const def = categoryOf(r.category).stages.find((s) => s.name === stage);
  const made: DocRecord[] = [];
  for (const key of def?.docs ?? []) {
    const tpl = templateOf(key);
    if (!tpl) continue;
    if (getDb().docs.some((d) => d.contentId === r.contentId && d.templateKey === key)) continue;
    made.push(makeDoc(actor, r.contentId, `${tpl.title}: ${docSubject(r)}`, tpl.body, key, stage));
  }
  return made;
}

/**
 * Saves the title and text. `baseVersion` is the version the editor started from, so two people
 * editing at once never overwrite each other silently.
 */
export function saveDoc(actor: Actor, id: string, patch: { title?: string; body?: string }, baseVersion: number): DocRecord {
  const d = getDoc(id);
  if (!d) throw new RuleError("Document not found.");
  if (!canEditDoc(actor, d)) throw new RuleError("You can read this document but not edit it.");
  if (d.version !== baseVersion) throw new ConflictError();
  const title = patch.title !== undefined ? patch.title.trim() : d.title;
  const body = patch.body !== undefined ? patch.body : d.body;
  if (!title) throw new RuleError("The title cannot be empty.");
  if (body.length > MAX_BODY) throw new RuleError("This document is too long to save.");
  if (title === d.title && body === d.body) return d;
  d.title = title;
  d.body = body;
  d.version += 1;
  d.updatedAt = new Date().toISOString();
  d.updatedBy = actor.personId;
  const last = revisionsOf(d.id)[0];
  if (last && last.byPersonId === actor.personId && !/^(Created|Restored)/.test(last.note) && Date.now() - new Date(last.at).getTime() < COALESCE_MS) {
    Object.assign(last, { version: d.version, at: d.updatedAt, title, body });
  } else {
    pushRevision(d, actor.personId, "Edited");
  }
  commit();
  return d;
}

/** Puts an earlier version back as a new revision. Nothing is ever deleted from the history. */
export function restoreRevision(actor: Actor, docId: string, revisionId: string): DocRecord {
  const d = getDoc(docId);
  const rev = getDb().docRevisions.find((v) => v.id === revisionId && v.docId === docId);
  if (!d || !rev) throw new RuleError("That version no longer exists.");
  if (!canEditDoc(actor, d)) throw new RuleError("You can read this document but not edit it.");
  d.title = rev.title;
  d.body = rev.body;
  d.version += 1;
  d.updatedAt = new Date().toISOString();
  d.updatedBy = actor.personId;
  pushRevision(d, actor.personId, `Restored version from ${new Date(rev.at).toLocaleString()}`);
  logAudit(actor, "restore", "document", d.id, rev.id);
  commit();
  return d;
}

/** Documents are archived, never destroyed, so the history stays. */
export function archiveDoc(actor: Actor, id: string): void {
  const d = getDoc(id);
  if (!d) throw new RuleError("Document not found.");
  if (!canEditDoc(actor, d)) throw new RuleError("You can read this document but not edit it.");
  d.archived = true;
  logAudit(actor, "archive", "document", id, d.title);
  commit();
}

/** Archives every document under a Content ID when its project is deleted. History is kept. */
export function archiveDocsFor(actor: Actor, contentId: string): number {
  const mine = getDb().docs.filter((d) => d.contentId === contentId && !d.archived);
  for (const d of mine) {
    d.archived = true;
    logAudit(actor, "archive", "document", d.id, "project deleted");
  }
  return mine.length;
}

export interface DiffLine { type: "same" | "add" | "del"; text: string }

/** Line-by-line comparison, for showing what a revision changed. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: "del", text: a[i++] });
    else out.push({ type: "add", text: b[j++] });
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}
