import { useState } from "react";
import type { ReviewNote } from "../types";
import { catalogTypeOf } from "../config/documentCatalog";
import { noteUnreviewed, REVIEW_ACTIONS, reviewNotesOf, reviewOutstanding, theologyStatus } from "../services/wrapped/documents";
import type { Project } from "../services/wrapped/workflow";
import { fmtDateTime } from "../services/utils";
import { useApp } from "./AppContext";
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
        <b>Theological review not done.</b> {t.detail}. It does not hold the project up; it is asked about when sessions are scheduled and
        when call sheets and episodes are published.
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
      {onOpen && (
        <button className="btn small" onClick={onOpen}>
          Open the review
        </button>
      )}
    </div>
  );
}

/** A board card's line. */
export function ReviewDueTag({ contentId }: { contentId: string }) {
  return reviewOutstanding(contentId) ? <span className="badge warn">Theological review not done</span> : null;
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
    </Modal>
  ) : null;
  return [check, modal];
}
