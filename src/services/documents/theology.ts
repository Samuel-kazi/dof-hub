import type { Actor, CallSheet, ReviewNote } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { briefKeyOf, catalogFor, catalogTypeOf } from "../../config/documentCatalog";
import { logAudit } from "../audit";
import { featureOn } from "../settings";
import { checkpoint, isWorkflowProject, nowStamp, type Project } from "../workflow/common";
import { projectForWrite } from "./common";
import { documentOf } from "./pages";
import { reviewsOf, reviewStateOf } from "./reviews";

// The theological review (build prompt v2, section 14). It is a document with named reviewers, comments on each page,
// one Approve for the whole document and Request changes with a reason. It is no longer a gate (with the switch
// "Theological review as a reminder, not a gate" on): while it is not approved the project shows "Theological review
// not done" (on the project, its home and its board card, and in the urgency report), and when someone schedules a
// session, publishes a call sheet or publishes an episode, they are asked "Theological review not completed.
// Continue?" with a short note, which is kept with the project. It never blocks. A page changed after the approval
// says so.

const NOTE_MAX = 300;

export interface TheologyStatus {
  done: boolean;
  what: string; // what is reviewed: "brief" or "script"
  documentId: string | null;
  detail: string; // where it stands, in words
  approvedAt: string | null; // when it became approved (the last reviewer's approval)
}

/** Whether the theological review is a gate (the switch off) or a reminder (on). */
export const reviewIsGate = (): boolean => !featureOn("reviewNotGate");

/** Whether a project has a theological review at all: its kind's Development has one. */
export const hasTheologicalReview = (p: Project): boolean =>
  catalogFor(p.workflow.formType, "Development").some((e) => e.kind === "review");

/** When a document's review became approved: the latest decision, once every reviewer has approved. */
export function approvedAt(documentId: string): string | null {
  if (reviewStateOf(documentId) !== "approved") return null;
  return reviewsOf(documentId).reduce<string | null>((at, r) => (r.decidedAt && (!at || r.decidedAt > at) ? r.decidedAt : at), null);
}

/** Where a project's theological review stands. */
export function theologyStatus(projectId: string): TheologyStatus {
  const p = getDb().records.find((r) => r.contentId === projectId) as Project;
  const what = catalogTypeOf(p.workflow.formType) === "devotion" ? "script" : "brief";
  const doc = documentOf(projectId, "Development", briefKeyOf(p.workflow.formType));
  const state = doc ? reviewStateOf(doc.id) : "no reviewers";
  const rows = doc ? reviewsOf(doc.id) : [];
  // A project reviewed on the earlier pitch and outline checkpoints, before the documents, keeps that review: both of
  // its checkpoints approved count, until reviewers are named on the document.
  const earlier = (["pitch", "outline_script"] as const).every((k) => checkpoint(projectId, k)?.status === "Approved");
  if (state === "no reviewers" && earlier)
    return { done: true, what, documentId: doc?.id ?? null, detail: "Approved on the earlier review checkpoints", approvedAt: null };
  const detail =
    state === "approved"
      ? `Approved by ${rows.length === 1 ? "its reviewer" : `all ${rows.length} reviewers`}`
      : state === "no reviewers"
        ? "No reviewer named yet"
        : state === "changes_requested"
          ? "Changes requested"
          : `${rows.filter((r) => r.status === "approved").length} of ${rows.length} reviewers have approved`;
  return { done: state === "approved", what, documentId: doc?.id ?? null, detail, approvedAt: doc ? approvedAt(doc.id) : null };
}

/**
 * Whether to show "Theological review not done" for a record and ask before going ahead: a five-stage project (or
 * its episode) with a theological review that is not approved, while the review is a reminder rather than a gate.
 */
export function reviewOutstanding(contentId: string | null | undefined): Project | null {
  if (!contentId || reviewIsGate()) return null;
  const db = getDb();
  let r = db.records.find((x) => x.contentId === contentId);
  // An episode or devotion answers for its project.
  while (r && !isWorkflowProject(r) && r.parentId) r = db.records.find((x) => x.contentId === r!.parentId);
  if (!r || !isWorkflowProject(r) || r.archived) return null;
  const p = r as Project;
  if (!hasTheologicalReview(p) || theologyStatus(p.contentId).done) return null;
  return p;
}

/**
 * The record a call sheet answers to for the review: a recording session's sheet is filed under the series, so its
 * session says which season it is; otherwise the episodes on it, then the record it is filed under.
 */
export function sheetOwnerId(cs: CallSheet): string {
  const session = getDb().recordingSessions.find((s) => s.callSheetId === cs.id);
  return session?.contentId ?? cs.linkedEpisodeIds[0] ?? cs.contentId;
}

/** The pages of a document changed after its review was approved. */
export function editedAfterApproval(documentId: string): Set<string> {
  const at = approvedAt(documentId);
  if (!at) return new Set();
  return new Set(
    getDb()
      .documentPages.filter((pg) => pg.documentId === documentId && !pg.archivedAt && pg.updatedAt > at)
      .map((pg) => pg.id),
  );
}

export const REVIEW_ACTIONS: Record<ReviewNote["action"], string> = {
  schedule: "Scheduled a session",
  "publish-sheet": "Published a call sheet",
  "publish-episode": "Published an episode",
};

/**
 * Keeps the note of someone going ahead before the theological review was done: they were asked "Theological review
 * not completed. Continue?" and went on. It never blocks anything; the note may be empty.
 */
export function noteUnreviewed(
  actor: Actor,
  contentId: string,
  input: { action: ReviewNote["action"]; targetId: string; note: string },
): ReviewNote | null {
  const outstanding = reviewOutstanding(contentId);
  if (!outstanding) return null; // done since, or not reviewed at all: nothing to note
  const p = projectForWrite(actor, outstanding.contentId);
  if (!REVIEW_ACTIONS[input.action]) throw new RuleError("That is not something the review is asked about.");
  const entry: ReviewNote = {
    at: nowStamp(),
    byPersonId: actor.personId,
    action: input.action,
    targetId: String(input.targetId).slice(0, 80),
    note: (input.note ?? "").trim().slice(0, NOTE_MAX),
  };
  p.workflow.aheadOfReview = [...(p.workflow.aheadOfReview ?? []), entry];
  logAudit(
    actor,
    "review-not-done",
    "record",
    p.contentId,
    `${REVIEW_ACTIONS[entry.action]} (${entry.targetId}) before the theological review was done${entry.note ? `: ${entry.note}` : ""}`,
  );
  commit();
  return entry;
}

/** The notes kept, newest first. */
export const reviewNotesOf = (p: Project): ReviewNote[] => [...(p.workflow.aheadOfReview ?? [])].reverse();
