import { useState } from "react";
import type { ReviewNote } from "../types";
import { catalogTypeOf } from "../config/documentCatalog";
import { noteUnreviewed, REVIEW_ACTIONS, reviewNotesOf, reviewOutstanding, reviewsOf, theologyStatus } from "../services/wrapped/documents";
import { setReviewedBeforeSystem, type Project } from "../services/wrapped/workflow";
import { fmtDateTime } from "../services/utils";
import { useApp } from "./AppContext";
import { MOD_KEY } from "./keys";
import { Modal } from "./Modal";
import { PersonName } from "./PersonName";

// The theological review as a reminder, not a gate (build prompt v2, section 14): "Theological review not done" on
// the project while it is not approved, and the question asked before scheduling a session, publishing a call sheet
// or publishing an episode: "Theological review not completed. Continue?", with a short note kept with the project.
// Nothing is ever held up by it.

/** The banner on the project (above Project Home and every document), with where the review stands. */
export function ReviewNotDone({ project, onOpen }: { project: Project; onOpen?: () => void }) {
  if (!reviewOutstanding(project.contentId)) return null;
  const t = theologyStatus(project.contentId);
  const notes = reviewNotesOf(project);
  return (
    <div className="banner warn pd-review-due" role="status" aria-label="Theological review not done">
      <div className="grow">
        <b>{t.newRequest ? "New theological review requested." : "Theological review not done."}</b> {t.detail}. It does not hold the
        project up; it is asked about when sessions are scheduled and when call sheets and episodes are published.
        {notes.length > 0 && (
          <details className="pd-review-notes">
            <summary>
              Gone ahead without it {notes.length} time{notes.length === 1 ? "" : "s"}
            </summary>
            <ul>
              {notes.map((n) => (
                <li key={`${n.at}|${n.targetId}`}>
                  {REVIEW_ACTIONS[n.action]} ({n.targetId}), <PersonName id={n.byPersonId} />, {fmtDateTime(n.at)}
                  {n.note ? `: ${n.note}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {project.workflow.imported && <ReviewedBeforeButton project={project} />}
      {onOpen && (
        <button className="btn small" onClick={onOpen}>
          Open the review
        </button>
      )}
    </div>
  );
}

/** An imported project's review may have been done before the system: marking it clears the banner (build prompt v4, 7A). */
function ReviewedBeforeButton({ project }: { project: Project }) {
  const { actor, attempt, confirm } = useApp();
  return (
    <button
      className="btn small"
      onClick={async () => {
        if (
          await confirm({
            title: "Reviewed before the system?",
            body: `${project.title}'s theological review was done before it came into the system. The banner goes; this is noted in the activity log.`,
            confirmLabel: "Reviewed before",
          })
        )
          attempt(() => setReviewedBeforeSystem(actor, project.contentId, true), "Marked reviewed before the system");
      }}
    >
      Reviewed before the system
    </button>
  );
}

/**
 * A board card's line, which opens what needs attention: where the review stands, each reviewer's decision, and each
 * time someone went ahead without it.
 */
export function ReviewDueTag({ contentId }: { contentId: string }) {
  const { go } = useApp();
  const [open, setOpen] = useState(false);
  const project = reviewOutstanding(contentId);
  if (!project) return null;
  const t = theologyStatus(project.contentId);
  const notes = reviewNotesOf(project);
  const rows = t.documentId ? reviewsOf(t.documentId) : [];
  return (
    <>
      <button
        type="button"
        className="badge warn badge-button"
        aria-label={`${t.newRequest ? "New theological review requested" : "Theological review not done"}: see what needs attention`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {t.newRequest ? "New theological review requested" : "Theological review not done"}
      </button>
      {open && (
        <Modal
          title={`Theological review: ${project.title}`}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setOpen(false);
                  go({ n: "record", id: project.contentId });
                }}
              >
                Open the project
              </button>
            </>
          }
        >
          <div onClick={(e) => e.stopPropagation()}>
            <p className="sub">{t.detail}.</p>
            {rows.length > 0 && (
              <ul className="pd-reviewers">
                {rows.map((r) => (
                  <li key={r.id}>
                    <PersonName id={r.reviewerId} />:{" "}
                    {r.status === "approved"
                      ? "approved"
                      : r.status === "changes_requested"
                        ? `changes requested: ${r.note}`
                        : "not decided yet"}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted">
              {notes.length
                ? `Gone ahead without it ${notes.length} time${notes.length === 1 ? "" : "s"}:`
                : "No one has gone ahead without it yet."}
            </p>
            {notes.length > 0 && (
              <ul>
                {notes.map((n) => (
                  <li key={`${n.at}|${n.targetId}`}>
                    {REVIEW_ACTIONS[n.action]} ({n.targetId}), <PersonName id={n.byPersonId} />, {fmtDateTime(n.at)}
                    {n.note ? `: ${n.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

export interface ReviewAsk {
  contentId: string | null | undefined; // the project, episode or call sheet's record
  action: ReviewNote["action"];
  targetId: string;
  confirmLabel?: string; // the button: "Continue" unless given ("Publish anyway")
  deliberate?: boolean; // a click or Ctrl+Enter only (publishing)
}

/** What the question gives back: go on (and keep the note once it is done), or not. */
export interface ReviewGo {
  asked: boolean; // false: the review is done (or not needed), nothing was asked
  done: (targetId?: string) => void; // keeps the note: call it once the action has gone through (with what it made)
}

const NO_ASK: ReviewGo = { asked: false, done: () => {} };

/** Scheduling a session is giving it a date it did not have: only then is the question asked. */
export const askIfScheduling = (
  check: (ask: ReviewAsk) => Promise<ReviewGo | null>,
  contentId: string,
  sessionId: string,
  before: string | null,
  after: string | null,
): Promise<ReviewGo | null> => (!before && after ? check({ contentId, action: "schedule", targetId: sessionId }) : Promise.resolve(NO_ASK));

/**
 * Asks "Theological review not completed. Continue?" before going ahead, when the review is not done. Resolves to
 * null if the person stops; otherwise to what to call once the action has gone through.
 */
export function useReviewCheck(): [(ask: ReviewAsk) => Promise<ReviewGo | null>, React.ReactNode] {
  const { actor, attempt } = useApp();
  const [state, setState] = useState<{ ask: ReviewAsk; project: Project; resolve: (go: ReviewGo | null) => void } | null>(null);
  const [note, setNote] = useState("");
  const check = (ask: ReviewAsk) => {
    const project = reviewOutstanding(ask.contentId);
    if (!project) return Promise.resolve(NO_ASK);
    setNote("");
    return new Promise<ReviewGo | null>((resolve) => setState({ ask, project, resolve }));
  };
  const close = (go: boolean) => {
    if (!state) return;
    const { ask, project, resolve } = state;
    const kept = note;
    setState(null);
    resolve(
      go
        ? {
            asked: true,
            done: (targetId?: string) =>
              attempt(() =>
                noteUnreviewed(actor, project.contentId, { action: ask.action, targetId: targetId ?? ask.targetId, note: kept }),
              ),
          }
        : null,
    );
  };
  const modal = state ? (
    <Modal
      title="Theological review not completed. Continue?"
      deliberate={state.ask.deliberate}
      onClose={() => close(false)}
      actions={
        <>
          <button className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => close(true)}>
            {state.ask.confirmLabel ?? "Continue"}
          </button>
        </>
      }
    >
      <p className="sub">
        The theological review of {state.project.title}&apos;s{" "}
        {catalogTypeOf(state.project.workflow.formType) === "devotion" ? "script" : "brief"} is not done yet (
        {theologyStatus(state.project.contentId).detail.toLowerCase()}). You can go ahead: it does not hold anything up.
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        <span>A short note, kept with the project (optional)</span>
        <input
          type="text"
          value={note}
          maxLength={300}
          autoFocus
          placeholder="For example: the reviewer has it, and is back on Tuesday"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {state.ask.deliberate && (
        <p className="muted" style={{ fontSize: ".84rem" }}>
          Click {state.ask.confirmLabel ?? "Continue"}, or press {MOD_KEY}+Enter.
        </p>
      )}
    </Modal>
  ) : null;
  return [check, modal];
}
