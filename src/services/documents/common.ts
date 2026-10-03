import type { Actor, ContentRecord, DocumentPage, ProjectDocument } from "../../types";
import { RuleError } from "../../types";
import { getDb } from "../../data/store";
import { canComment, canView, canWrite, getRecord } from "../access";
import { textOf } from "../html";
import { isWorkflowProject, nowStamp, type Project } from "../workflow/common";

// Shared by the document services: finding a project's documents, pages and boards, and who may change them.

export { nowStamp };

/** The workflow project a document, storyboard or shot list belongs to. */
export function projectOf(contentId: string): Project {
  const r = getRecord(contentId);
  if (!isWorkflowProject(r)) throw new RuleError("Project not found.");
  return r;
}

/** A project this person may write in. A closed project is kept as it was. */
export function projectForWrite(actor: Actor, contentId: string): Project {
  const p = projectOf(contentId);
  if (!canWrite(actor, p)) throw new RuleError("You have view-only access to this project.");
  if (p.archived) throw new RuleError("This project is closed. It is kept as it was and cannot be changed.");
  return p;
}

export function projectForView(actor: Actor, contentId: string): Project {
  const p = projectOf(contentId);
  if (!canView(actor, p)) throw new RuleError("Project not found.");
  return p;
}

export const mayComment = (actor: Actor, r: ContentRecord): boolean => canComment(actor, r);

export const getDocument = (id: string): ProjectDocument | undefined => getDb().projectDocuments.find((d) => d.id === id);

export function requireDocument(id: string): ProjectDocument {
  const d = getDocument(id);
  if (!d) throw new RuleError("Document not found.");
  return d;
}

export function documentForWrite(actor: Actor, id: string): { doc: ProjectDocument; project: Project } {
  const doc = requireDocument(id);
  return { doc, project: projectForWrite(actor, doc.contentId) };
}

export function pageForWrite(actor: Actor, pageId: string): { page: DocumentPage; doc: ProjectDocument; project: Project } {
  const page = getDb().documentPages.find((p) => p.id === pageId);
  if (!page) throw new RuleError("That page no longer exists.");
  const { doc, project } = documentForWrite(actor, page.documentId);
  return { page, doc, project };
}

/** A document's pages in order. Deleted (archived) pages are left out unless asked for. */
export const pagesOf = (documentId: string, includeArchived = false): DocumentPage[] =>
  getDb()
    .documentPages.filter((p) => p.documentId === documentId && (includeArchived || !p.archivedAt))
    .sort((a, b) => a.position - b.position);

/** Numbers a list's positions 0, 1, 2… in its current order. */
export function renumber<T extends { position: number }>(items: T[]): void {
  items.sort((a, b) => a.position - b.position).forEach((it, i) => (it.position = i));
}

/** Moves one item to a place in its list, and renumbers the list. */
export function moveTo<T extends { id: string; position: number }>(items: T[], id: string, toIndex: number): void {
  const ordered = [...items].sort((a, b) => a.position - b.position);
  const from = ordered.findIndex((x) => x.id === id);
  if (from === -1) throw new RuleError("That item is not in this list.");
  const [it] = ordered.splice(from, 1);
  ordered.splice(Math.max(0, Math.min(ordered.length, Math.floor(toIndex))), 0, it);
  ordered.forEach((x, i) => (x.position = i));
}

/**
 * Whether a document has been written in: a link, or a page someone (or the move from the old forms) has written
 * words on. Worked out every time, never set by hand; a tile shows it as a small filled dot.
 */
export function documentHasContent(documentId: string): boolean {
  const db = getDb();
  if (db.documentLinks.some((l) => l.documentId === documentId)) return true;
  return pagesOf(documentId).some(
    (p) => (p.version > 1 || p.updatedBy === "migration") && (textOf(p.bodyHtml) !== "" || p.subtitle.trim() !== ""),
  );
}
