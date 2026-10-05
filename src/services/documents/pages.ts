import type { Actor, DocumentLink, DocumentPage, ProjectDocument, WorkflowStage } from "../../types";
import { ConflictError, RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { localId } from "../../data/ids";
import { documentIdOf } from "../../data/constraints";
import { catalogEntry, type CatalogEntry } from "../../config/documentCatalog";
import { WORKFLOW_STAGE_NAMES } from "../../config/workflow";
import { logAudit } from "../audit";
import { requireWebUrl } from "../urls";
import { cleanHtml, textToHtml } from "../html";
import { canWrite, getRecord } from "../access";
import { episodesOf, getSession } from "../workflow/common";
import { documentForWrite, nowStamp, pageForWrite, pagesOf, projectForView, projectForWrite, moveTo, renumber } from "./common";

// A project's documents and their pages. A document is made the first time it is needed, from the catalogue
// (src/config/documentCatalog.ts), with its starting pages. Pages save as people type: each save carries the version
// it was made from, and one made from an older version is refused rather than overwriting someone else's words.

/** The longest a page's body may be. A longer piece of writing is split over more pages. */
export const MAX_PAGE_HTML = 400_000;
const MAX_LINE = 300;

function entryFor(formType: Parameters<typeof catalogEntry>[0], stage: WorkflowStage, docKey: string): CatalogEntry {
  const entry = catalogEntry(formType, stage, docKey);
  if (!entry || entry.kind !== "document") throw new RuleError("This kind of project has no such document at that stage.");
  return entry;
}

/** The document, if it has been made yet. */
export const documentOf = (
  contentId: string,
  stage: WorkflowStage,
  docKey: string,
  ownerId: string | null = null,
): ProjectDocument | undefined => getDb().projectDocuments.find((d) => d.id === documentIdOf(contentId, stage, docKey, ownerId));

/** Makes a document's record and its starting pages. The caller saves. */
export function makeDocument(
  contentId: string,
  stage: WorkflowStage,
  entry: CatalogEntry,
  ownerId: string | null,
  by: string,
  migrated = false,
): ProjectDocument {
  const at = nowStamp();
  const doc: ProjectDocument = {
    id: documentIdOf(contentId, stage, entry.key, ownerId),
    contentId,
    stage,
    docKey: entry.key,
    ownerId,
    title: entry.title,
    migrated,
    createdAt: at,
    updatedAt: at,
  };
  const db = getDb();
  db.projectDocuments.push(doc);
  // A page that is a structured form (a session's run sheet or wrap checklist) is the session's own, shown beside the
  // pages; it is not a page of writing.
  (entry.pages ?? [])
    .filter((p) => !p.form)
    .forEach((p, i) =>
      db.documentPages.push({
        id: localId("PG"),
        documentId: doc.id,
        position: i,
        title: p.title,
        subtitle: p.subtitle ?? "",
        bodyHtml: p.body ? cleanHtml(p.body) : "",
        version: 1,
        archivedAt: null,
        updatedAt: at,
        updatedBy: by,
      }),
    );
  return doc;
}

/**
 * The project's document of this kind at this stage, made from the catalogue the first time it is opened. A
 * document of a session or an episode (a Recording Day Sheet) names it as `ownerId`.
 */
export function ensureDocument(
  actor: Actor,
  contentId: string,
  stage: WorkflowStage,
  docKey: string,
  ownerId: string | null = null,
): ProjectDocument {
  if (!WORKFLOW_STAGE_NAMES.includes(stage)) throw new RuleError("That is not a stage of the workflow.");
  const existing = documentOf(contentId, stage, docKey, ownerId);
  if (existing) {
    projectForView(actor, contentId);
    return existing;
  }
  const project = projectForWrite(actor, contentId);
  const entry = entryFor(project.workflow.formType, stage, docKey);
  if (entry.onlyIfMade) throw new RuleError(`The ${entry.title} is only made by the move from the old forms.`);
  const session = entry.per === "session" && ownerId ? getSession(ownerId) : undefined;
  if (entry.per === "session") {
    if (!session || session.contentId !== contentId) throw new RuleError("Choose one of this project's recording sessions.");
  } else if (entry.per === "episode") {
    const ep = ownerId ? getRecord(ownerId) : undefined;
    if (!ep?.episode || ep.parentId !== contentId) throw new RuleError("Choose one of this project's episodes.");
  } else if (ownerId) throw new RuleError("This document is for the whole project.");
  const doc = makeDocument(contentId, stage, entry, ownerId, actor.personId);
  // A session's day sheet starts its notes with the daily log already written on the session: the page's first save.
  if (session?.dailyLog.trim()) {
    const notes = pagesOf(doc.id)[0];
    if (notes) {
      notes.bodyHtml = cleanHtml(textToHtml(session.dailyLog));
      notes.version = 2;
    }
  }
  logAudit(actor, "document", "record", contentId, `${entry.title} started`);
  commit();
  return doc;
}

const REVIEW_THREAD = "review_thread";

/**
 * The project's Review Thread, with a page for each of its episodes (or a documentary's cuts): a page is added for an
 * episode that has none yet, so the thread keeps up as sessions close. Someone who may only read gets it as it is.
 * Pages are never taken away: an episode archived later keeps its page and what was written there.
 */
export function syncReviewThread(actor: Actor, contentId: string): ProjectDocument | undefined {
  const project = projectForView(actor, contentId);
  const existing = documentOf(contentId, "Post production", REVIEW_THREAD);
  if (!canWrite(actor, project) || project.archived) return existing;
  const entry = entryFor(project.workflow.formType, "Post production", REVIEW_THREAD);
  if (!entry.pagePerEpisode) throw new RuleError("This document has no page for each episode.");
  const doc = existing ?? makeDocument(contentId, "Post production", entry, null, actor.personId);
  const covered = new Set(pagesOf(doc.id, true).map((p) => p.episodeId));
  const missing = episodesOf(contentId).filter((ep) => !covered.has(ep.contentId));
  if (!existing || missing.length) {
    const at = nowStamp();
    let position = pagesOf(doc.id).length;
    for (const ep of missing)
      getDb().documentPages.push({
        id: localId("PG"),
        documentId: doc.id,
        position: position++,
        title: ep.title.trim().slice(0, MAX_LINE) || ep.contentId,
        subtitle: ep.contentId,
        bodyHtml: "",
        version: 1,
        archivedAt: null,
        updatedAt: at,
        updatedBy: actor.personId,
        episodeId: ep.contentId,
      });
    if (!existing) logAudit(actor, "document", "record", contentId, `${entry.title} started`);
    commit();
  }
  return doc;
}

export interface PageInput {
  title?: string;
  subtitle?: string;
  afterPageId?: string | null; // where it goes; at the end if not given
}

export function addPage(actor: Actor, documentId: string, input: PageInput = {}): DocumentPage {
  const { doc } = documentForWrite(actor, documentId);
  const pages = pagesOf(doc.id);
  const at = nowStamp();
  const after = input.afterPageId ? pages.findIndex((p) => p.id === input.afterPageId) : pages.length - 1;
  const page: DocumentPage = {
    id: localId("PG"),
    documentId: doc.id,
    position: after + 0.5,
    title: (input.title ?? "").trim().slice(0, MAX_LINE) || "New page",
    subtitle: (input.subtitle ?? "").trim().slice(0, MAX_LINE),
    bodyHtml: "",
    version: 1,
    archivedAt: null,
    updatedAt: at,
    updatedBy: actor.personId,
  };
  getDb().documentPages.push(page);
  renumber(pagesOf(doc.id));
  doc.updatedAt = at;
  logAudit(actor, "document-page", "record", doc.contentId, `${doc.title}: page "${page.title}" added`);
  commit();
  return page;
}

export interface PageEdit {
  title?: string;
  subtitle?: string;
  bodyHtml?: string;
}

/**
 * Saves a page as it is typed. `baseVersion` is the version the writer started from: if someone else saved the page
 * since, this is refused, and the writer's words stay on their screen to keep or merge. The body is cleaned to the
 * allow-list first. Saves are not written to the activity log; the page keeps who saved it last and when.
 */
export function savePage(actor: Actor, pageId: string, edit: PageEdit, baseVersion: number): DocumentPage {
  const { page, doc } = pageForWrite(actor, pageId);
  if (page.archivedAt) throw new RuleError("This page was deleted. Restore it to write in it.");
  if (page.version !== baseVersion)
    throw new ConflictError(
      "Someone else saved this page while you were writing. Your words are kept here: copy them, then reload the page.",
    );
  if (edit.title !== undefined) page.title = edit.title.trim().slice(0, MAX_LINE) || "Untitled page";
  if (edit.subtitle !== undefined) page.subtitle = edit.subtitle.trim().slice(0, MAX_LINE);
  if (edit.bodyHtml !== undefined) {
    if (edit.bodyHtml.length > MAX_PAGE_HTML) throw new RuleError("This page is too long to save. Split it over two pages.");
    page.bodyHtml = cleanHtml(edit.bodyHtml);
  }
  page.version += 1;
  page.updatedAt = nowStamp();
  page.updatedBy = actor.personId;
  doc.updatedAt = page.updatedAt;
  // The script page is the source of a devotion's title and scripture: the copy its planned episode keeps (to name the
  // episode when it is recorded) follows it, until it is recorded.
  for (const planned of getDb().plannedEpisodes)
    if (planned.sourcePageId === page.id && !getDb().records.some((r) => r.episode?.plannedEpisodeId === planned.id)) {
      if (page.title.trim()) planned.workingTitle = page.title.trim();
      planned.details = { ...planned.details, scripture: page.subtitle };
      planned.updatedAt = page.updatedAt;
    }
  commit();
  return page;
}

export function movePage(actor: Actor, pageId: string, toIndex: number): DocumentPage {
  const { page, doc } = pageForWrite(actor, pageId);
  moveTo(pagesOf(doc.id), page.id, toIndex);
  commit();
  return page;
}

/** Deletes a page from view. It is kept, archived, and can be restored: no writing is ever lost. */
export function archivePage(actor: Actor, pageId: string): DocumentPage {
  const { page, doc } = pageForWrite(actor, pageId);
  if (page.archivedAt) return page;
  page.archivedAt = nowStamp();
  renumber(pagesOf(doc.id));
  logAudit(actor, "document-page", "record", doc.contentId, `${doc.title}: page "${page.title}" deleted (kept, archived)`);
  commit();
  return page;
}

export function restorePage(actor: Actor, pageId: string): DocumentPage {
  const { page, doc } = pageForWrite(actor, pageId);
  if (!page.archivedAt) return page;
  page.archivedAt = null;
  page.position = pagesOf(doc.id).length;
  logAudit(actor, "document-page", "record", doc.contentId, `${doc.title}: page "${page.title}" restored`);
  commit();
  return page;
}

// ── Links: files that stay in Google Docs, Drive, WhatsApp and the like ──

export const linksOf = (documentId: string): DocumentLink[] => getDb().documentLinks.filter((l) => l.documentId === documentId);

export function addDocumentLink(actor: Actor, documentId: string, url: string, label: string): DocumentLink {
  const { doc } = documentForWrite(actor, documentId);
  const link: DocumentLink = {
    id: localId("DL"),
    documentId: doc.id,
    url: requireWebUrl(url, "The link"),
    label: label.trim().slice(0, MAX_LINE),
    addedBy: actor.personId,
    addedAt: nowStamp(),
  };
  getDb().documentLinks.push(link);
  logAudit(actor, "document-link", "record", doc.contentId, `${doc.title}: ${link.label || link.url}`);
  commit();
  return link;
}

export function removeDocumentLink(actor: Actor, linkId: string): void {
  const db = getDb();
  const link = db.documentLinks.find((l) => l.id === linkId);
  if (!link) throw new RuleError("That link no longer exists.");
  const { doc } = documentForWrite(actor, link.documentId);
  db.documentLinks = db.documentLinks.filter((l) => l.id !== linkId);
  logAudit(actor, "document-link", "record", doc.contentId, `${doc.title}: removed ${link.label || link.url}`);
  commit();
}
