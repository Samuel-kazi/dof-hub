import type { Actor, DocumentReview, DocumentReviewStatus, ReviewComment } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { localId } from "../../data/ids";
import { logAudit } from "../audit";
import { isHop } from "../access";
import { canDecide, canManageTeam, joinProject, requireCrew } from "../workflow/common";
import { documentForWrite, mayComment, nowStamp, projectForView, requireDocument } from "./common";

// The theological review of a document: named reviewers from the crew list, each with one decision on the whole
// document, Approve or Request changes (with the reason, which goes back to its writer). Comments sit beside a page
// and can be resolved; resolved, they stay.

export const reviewsOf = (documentId: string): DocumentReview[] => getDb().documentReviews.filter((r) => r.documentId === documentId);

/** Where a document's review stands: approved once every named reviewer has approved it. */
export function reviewStateOf(documentId: string): DocumentReviewStatus | "no reviewers" {
  const rows = reviewsOf(documentId);
  if (!rows.length) return "no reviewers";
  if (rows.some((r) => r.status === "changes_requested")) return "changes_requested";
  return rows.every((r) => r.status === "approved") ? "approved" : "pending";
}

/** Names the reviewers. A reviewer already named keeps their decision; one taken off is removed. */
export function setDocumentReviewers(actor: Actor, documentId: string, reviewerIds: string[]): DocumentReview[] {
  const { doc, project } = documentForWrite(actor, documentId);
  if (!canManageTeam(actor, project) && !canDecide(actor))
    throw new RuleError("Only the show producer or the Head of Production chooses the reviewers.");
  const ids = [...new Set(reviewerIds)];
  if (ids.length > 10) throw new RuleError("Choose up to 10 reviewers.");
  // A reviewer joins the project, so they can read it and decide.
  for (const id of ids) {
    requireCrew(id, "A reviewer");
    joinProject(actor, id, project);
  }
  const db = getDb();
  const at = nowStamp();
  db.documentReviews = db.documentReviews.filter((r) => r.documentId !== doc.id || ids.includes(r.reviewerId));
  for (const reviewerId of ids)
    if (!db.documentReviews.some((r) => r.documentId === doc.id && r.reviewerId === reviewerId))
      db.documentReviews.push({
        id: `${doc.id}|${reviewerId}`,
        documentId: doc.id,
        reviewerId,
        status: "pending",
        note: "",
        decidedAt: null,
        createdAt: at,
        updatedAt: at,
      });
  logAudit(actor, "document-reviewers", "record", doc.contentId, `${doc.title}: ${ids.length} reviewer${ids.length === 1 ? "" : "s"}`);
  commit();
  return reviewsOf(doc.id);
}

export interface ReviewDecision {
  status: "approved" | "changes_requested";
  note: string;
}

/** A named reviewer's decision, or the Head of Production's for every reviewer. Requesting changes needs the reason. */
export function decideDocumentReview(actor: Actor, documentId: string, decision: ReviewDecision): DocumentReview[] {
  const { doc } = documentForWrite(actor, documentId);
  const note = decision.note.trim();
  if (decision.status === "changes_requested" && !note)
    throw new RuleError("Write what needs to change. The reason goes back to the writer.");
  const mine = reviewsOf(doc.id).filter((r) => r.reviewerId === actor.personId || isHop(actor));
  if (!reviewsOf(doc.id).length) throw new RuleError("Name a reviewer first.");
  if (!mine.length) throw new RuleError("Only a reviewer named on this document, or the Head of Production, can decide it.");
  const at = nowStamp();
  for (const r of mine) Object.assign(r, { status: decision.status, note, decidedAt: at, updatedAt: at });
  logAudit(
    actor,
    "document-review",
    "record",
    doc.contentId,
    `${doc.title}: ${decision.status === "approved" ? "approved" : `changes requested: ${note}`}`,
  );
  commit();
  return reviewsOf(doc.id);
}

/**
 * After changes were requested, the writer asks the reviewers to look again: each request for changes goes back to
 * pending (its reason stays in the activity log). Approvals stand.
 */
export function askForReviewAgain(actor: Actor, documentId: string): DocumentReview[] {
  const { doc } = documentForWrite(actor, documentId);
  const sentBack = reviewsOf(doc.id).filter((r) => r.status === "changes_requested");
  if (!sentBack.length) throw new RuleError("No reviewer has asked for changes.");
  const at = nowStamp();
  for (const r of sentBack) Object.assign(r, { status: "pending", decidedAt: null, updatedAt: at });
  logAudit(actor, "document-review", "record", doc.contentId, `${doc.title}: changes made, review asked for again`);
  commit();
  return reviewsOf(doc.id);
}

export const commentsOf = (documentId: string): ReviewComment[] =>
  getDb()
    .reviewComments.filter((c) => c.documentId === documentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function addReviewComment(actor: Actor, pageId: string, body: string): ReviewComment {
  const page = getDb().documentPages.find((p) => p.id === pageId);
  if (!page) throw new RuleError("That page no longer exists.");
  const doc = requireDocument(page.documentId);
  const project = projectForView(actor, doc.contentId);
  if (!mayComment(actor, project)) throw new RuleError("You can read this document but not comment on it.");
  const text = body.trim();
  if (!text) throw new RuleError("Write the comment first.");
  const c: ReviewComment = {
    id: localId("RC"),
    documentId: doc.id,
    pageId: page.id,
    authorId: actor.personId,
    body: text.slice(0, 5000),
    resolved: false,
    resolvedBy: null,
    createdAt: nowStamp(),
  };
  getDb().reviewComments.push(c);
  logAudit(actor, "document-comment", "record", doc.contentId, `${doc.title}, ${page.title}: ${text.slice(0, 60)}`);
  commit();
  return c;
}

/** Marks a comment resolved, or open again. Anyone who may write in the document can. */
export function resolveReviewComment(actor: Actor, commentId: string, resolved = true): ReviewComment {
  const c = getDb().reviewComments.find((x) => x.id === commentId);
  if (!c) throw new RuleError("That comment no longer exists.");
  documentForWrite(actor, c.documentId);
  c.resolved = resolved;
  c.resolvedBy = resolved ? actor.personId : null;
  commit();
  return c;
}
