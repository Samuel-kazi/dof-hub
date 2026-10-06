import { useState } from "react";
import type { Actor, DocumentPage, ProjectDocument } from "../../types";
import { canComment, canWrite, isHop } from "../../services/access";
import { cleanHtml } from "../../services/html";
import { can } from "../../services/wrapped/permissions";
import { nameOf } from "../../services/wrapped/people";
import {
  addReviewComment,
  askForReviewAgain,
  commentsOf,
  decideDocumentReview,
  editedAfterApproval,
  pagesOf,
  resolveReviewComment,
  reviewIsGate,
  reviewsOf,
  reviewStateOf,
  setDocumentReviewers,
} from "../../services/wrapped/documents";
import type { Project } from "../../services/wrapped/workflow";
import { fmtDateTime } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty } from "../../ui/parts";
import { CrewSelect } from "../../ui/workflow/shared";
import { useReason } from "../workflow/common";
import { pageFields } from "./ProjectDetails";

// The theological review of a project's Development document (its brief, or a devotion's script): the document shown
// read-only, page by page, with a comment box beside each page; the named reviewers, chosen from the crew list; one
// Approve for the whole document; and Request changes, with the reason, which goes back to the writers on the document
// itself. Comments can be resolved, and are kept.

// The same rules the services apply (src/services/documents/reviews.ts), so the screen only offers what will work.
const mayChooseReviewers = (actor: Actor, p: Project) =>
  isHop(actor) || can(actor, "pipeline.assign") || can(actor, "pipeline.manage") || p.workflow.showProducerId === actor.personId;

const STATE_LABEL = {
  approved: "Approved",
  pending: "Waiting for review",
  changes_requested: "Changes requested",
  "no reviewers": "No reviewer yet",
};
const STATE_TONE = { approved: "ok", pending: "accent", changes_requested: "bad", "no reviewers": "" };

/** The comments beside one page: open ones first, resolved ones folded below, and a box to add one. */
export function PageComments({ project, doc, page }: { project: Project; doc: ProjectDocument; page: DocumentPage }) {
  const { actor, attempt } = useApp();
  const [text, setText] = useState("");
  const all = commentsOf(doc.id).filter((c) => c.pageId === page.id);
  const open = all.filter((c) => !c.resolved);
  const resolved = all.filter((c) => c.resolved);
  const mayAdd = canComment(actor, project) && !project.archived;
  const mayResolve = canWrite(actor, project) && !project.archived;
  const one = (c: (typeof all)[number]) => (
    <li key={c.id} className={`pd-comment${c.resolved ? " resolved" : ""}`}>
      <div className="pd-comment-head">
        <b>{nameOf(c.authorId)}</b>
        <span className="muted">{fmtDateTime(c.createdAt)}</span>
      </div>
      <p>{c.body}</p>
      {c.resolved && <p className="muted pd-comment-by">Resolved by {nameOf(c.resolvedBy)}</p>}
      {mayResolve && (
        <button
          className="btn small ghost"
          onClick={() => attempt(() => resolveReviewComment(actor, c.id, !c.resolved), c.resolved ? "Opened again" : "Resolved")}
        >
          {c.resolved ? "Open again" : "Resolve"}
        </button>
      )}
    </li>
  );
  return (
    <aside className="pd-comments" aria-label={`Comments on ${page.title || "this page"}`}>
      <h3>
        Comments <span className="muted">{open.length ? `${open.length} open` : "none open"}</span>
      </h3>
      {open.length > 0 && <ul>{open.map(one)}</ul>}
      {resolved.length > 0 && (
        <details>
          <summary className="muted">Resolved ({resolved.length})</summary>
          <ul>{resolved.map(one)}</ul>
        </details>
      )}
      {mayAdd && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (attempt(() => addReviewComment(actor, page.id, text), "Comment added")) setText("");
          }}
        >
          <textarea
            aria-label={`Comment on ${page.title || "this page"}`}
            placeholder="Comment on this page…"
            value={text}
            maxLength={5000}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn small" type="submit" disabled={!text.trim()}>
            Comment
          </button>
        </form>
      )}
    </aside>
  );
}

/** On the reviewed document itself: where its review stands, and, when changes were asked for, why. */
export function ReviewBanner({ doc, write }: { doc: ProjectDocument; write: boolean }) {
  const { actor, attempt } = useApp();
  const state = reviewStateOf(doc.id);
  const rows = reviewsOf(doc.id);
  if (state === "no reviewers")
    return <p className="muted pd-review-line">Not sent for theological review yet. Name a reviewer under Theological Review.</p>;
  if (state === "approved") return <div className="banner ok pd-review-line">Theological review: approved.</div>;
  if (state === "pending")
    return (
      <p className="muted pd-review-line">
        Waiting for theological review: {rows.filter((r) => r.status === "approved").length} of {rows.length} approved.
      </p>
    );
  return (
    <div className="banner bad pd-review-line" role="status">
      <div className="grow">
        <b>Changes requested.</b>
        {rows
          .filter((r) => r.status === "changes_requested")
          .map((r) => (
            <div key={r.id}>
              {nameOf(r.reviewerId)}: {r.note}
            </div>
          ))}
      </div>
      {write && (
        <button
          className="btn small"
          onClick={() => attempt(() => askForReviewAgain(actor, doc.id), "The reviewers are asked to look again")}
        >
          Ask for review again
        </button>
      )}
    </div>
  );
}

/** The reviewers, each one's decision, and Approve or Request changes for a named reviewer or the Head of Production. */
function ReviewDecisions({ project, doc, write }: { project: Project; doc: ProjectDocument; write: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const [ask, reasonModal] = useReason();
  const rows = reviewsOf(doc.id);
  const state = reviewStateOf(doc.id);
  const ids = rows.map((r) => r.reviewerId);
  // Decided while the project is in Development; afterwards it is kept as it was, and comments can still be added. With
  // the review a reminder rather than a gate, a project can move on before it is approved, and it can still be decided.
  const late = !reviewIsGate() && state !== "approved";
  const open = write && (project.workflow.stage === "Development" || late);
  const choose = open && mayChooseReviewers(actor, project);
  const named = ids.includes(actor.personId);
  const mayDecide = open && rows.length > 0 && (named || isHop(actor));
  return (
    <section className="pd-review" aria-label="Review decision">
      <div className="pd-review-head">
        <h3>Theological review of the {doc.title}</h3>
        <span className={`badge ${STATE_TONE[state]}`}>{STATE_LABEL[state]}</span>
      </div>
      <ul className="pd-reviewers" aria-label="Reviewers">
        {rows.length === 0 && <li className="muted">No reviewer named yet.</li>}
        {rows.map((r) => (
          <li key={r.id}>
            <span className="grow">
              <b>{nameOf(r.reviewerId)}</b>{" "}
              <span className={`badge ${r.status === "approved" ? "ok" : r.status === "changes_requested" ? "bad" : ""}`}>
                {r.status === "approved" ? "Approved" : r.status === "changes_requested" ? "Changes requested" : "Not decided"}
              </span>
              {r.decidedAt && <span className="muted"> {fmtDateTime(r.decidedAt)}</span>}
              {r.status === "changes_requested" && r.note && <span className="pd-review-note">{r.note}</span>}
            </span>
            {choose && (
              <button
                className="btn small ghost"
                aria-label={`Remove ${nameOf(r.reviewerId)} as a reviewer`}
                onClick={() =>
                  attempt(
                    () =>
                      setDocumentReviewers(
                        actor,
                        doc.id,
                        ids.filter((x) => x !== r.reviewerId),
                      ),
                    "Reviewer removed",
                  )
                }
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {choose && (
        <CrewSelect
          label="Add a reviewer"
          value={null}
          none="Add a reviewer…"
          onChange={(p) => p && attempt(() => setDocumentReviewers(actor, doc.id, [...ids, p]), `${nameOf(p)} is a reviewer`)}
        />
      )}
      {!open && project.workflow.stage !== "Development" && (
        <p className="muted">The review was decided in Development, and is kept as it was.</p>
      )}
      {open && late && project.workflow.stage !== "Development" && (
        <p className="muted">The project has moved on before this review was done. It can still be decided here.</p>
      )}
      {mayDecide && (
        <div className="wf-actions">
          <button
            className="btn primary"
            onClick={async () => {
              if (
                await confirm({
                  title: `Approve ${doc.title}?`,
                  body: "The theological review of the whole document is recorded as approved. A page edited afterwards shows that it changed after approval.",
                  confirmLabel: "Approve",
                  deliberate: true,
                })
              )
                attempt(() => decideDocumentReview(actor, doc.id, { status: "approved", note: "" }), "Approved");
            }}
          >
            {isHop(actor) && !named ? "Approve for every reviewer" : "Approve the whole document"}
          </button>
          <button
            className="btn"
            onClick={async () => {
              const note = await ask(`Request changes: ${doc.title}`, "What needs to change? This goes back to the writers.", "Send back");
              if (note)
                attempt(() => decideDocumentReview(actor, doc.id, { status: "changes_requested", note }), "Sent back with your reason");
            }}
          >
            Request changes
          </button>
        </div>
      )}
      {reasonModal}
    </section>
  );
}

/** The review's two panes: the document's pages, then the chosen page read-only with its comments beside it. */
export function ReviewPanes({
  project,
  doc,
  title,
  write,
  pageId,
  onSelectPage,
}: {
  project: Project;
  doc: ProjectDocument | undefined;
  title: string;
  write: boolean;
  pageId: string | null;
  onSelectPage: (id: string) => void;
}) {
  if (!doc)
    return (
      <div className="pd-write pd-span2">
        <Empty>The {title} has not been started yet, so there is nothing to review.</Empty>
      </div>
    );
  const pages = pagesOf(doc.id);
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  const comments = commentsOf(doc.id);
  const changed = editedAfterApproval(doc.id);
  return (
    <>
      <div className="pd-pages">
        <ol aria-label={`Pages of ${doc.title}`}>
          {pages.map((p, i) => {
            const open = comments.filter((c) => c.pageId === p.id && !c.resolved).length;
            return (
              <li key={p.id} className={`pd-card${p.id === page?.id ? " on" : ""}`}>
                <button className="pd-card-main" aria-current={p.id === page?.id ? "page" : undefined} onClick={() => onSelectPage(p.id)}>
                  <span className="pd-card-num">{i + 1}</span>
                  <span className="pd-card-text">
                    <span className="pd-card-title">{p.title || "Untitled page"}</span>
                    {p.subtitle && <span className="pd-card-sub">{p.subtitle}</span>}
                    <span className="pd-card-snip">
                      {changed.has(p.id) && <span className="badge warn">Edited after approval</span>}{" "}
                      {open ? `${open} open comment${open === 1 ? "" : "s"}` : "No open comments"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="pd-write">
        <ReviewDecisions project={project} doc={doc} write={write} />
        {page ? (
          <div className="pd-with-comments">
            <article className="pd-read" aria-label={`Page: ${page.title}`}>
              <h2 className="pd-read-title">{page.title || "Untitled page"}</h2>
              {changed.has(page.id) && (
                <p className="banner warn" role="status">
                  Edited after approval, on {fmtDateTime(page.updatedAt)}.
                </p>
              )}
              {page.subtitle && <p className="pd-read-sub">{page.subtitle}</p>}
              {pageFields(project, doc, page, pages).map(([label, value]) => (
                <div key={label} className="pd-read-field">
                  <span className="pd-read-label">{label}</span>
                  <span>{value || <em className="muted">Not written yet</em>}</span>
                </div>
              ))}
              <div className="pd-paper">
                {/* Cleaned to the editor's allow-list, as on every load. */}
                <div
                  className="pd-prose"
                  dangerouslySetInnerHTML={{ __html: cleanHtml(page.bodyHtml) || "<p><em>Nothing written on this page.</em></p>" }}
                />
              </div>
            </article>
            <PageComments project={project} doc={doc} page={page} />
          </div>
        ) : (
          <Empty>This document has no pages.</Empty>
        )}
      </div>
    </>
  );
}
