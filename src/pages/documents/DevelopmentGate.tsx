import { useState } from "react";
import type { Actor } from "../../types";
import { catalogTypeOf } from "../../config/documentCatalog";
import { isHop } from "../../services/access";
import { can } from "../../services/wrapped/permissions";
import { nameOf } from "../../services/wrapped/people";
import { acceptDevotion, hardGates, setGateOverride, softNudges, type HardGate } from "../../services/wrapped/documents";
import { advanceProject, assignProducer, decideGreenlight, evaluateGate, type Project } from "../../services/wrapped/workflow";
import { fmtDate, todayIso } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/parts";
import { CrewSelect } from "../../ui/workflow/shared";
import { useReason } from "../workflow/common";

// Leaving Development, once the documents are in use: the short list of hard gates (each met, passed by hand with a
// note, or not yet), the nudges that never block (each one can be dismissed), and the button that moves on: "Done:
// move to Pre-production" for a series or documentary, Accept or Decline for a devotion.

const canDecide = (actor: Actor) => isHop(actor) || can(actor, "pipeline.manage");
const canNameProducer = (actor: Actor) => isHop(actor) || can(actor, "pipeline.assign");

// ── Dismissed nudges: each person's own, kept in their browser ──

const dismissedKey = (projectId: string) => `dof-hub-nudges-dismissed:${projectId}`;
function readDismissed(projectId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(dismissedKey(projectId)) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function keepDismissed(projectId: string, list: string[]): void {
  try {
    localStorage.setItem(dismissedKey(projectId), JSON.stringify(list));
  } catch {
    /* lasts until the page is reloaded */
  }
}

function GateLine({ project, gate, write }: { project: Project; gate: HardGate; write: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const [overriding, setOverriding] = useState(false);
  const [note, setNote] = useState("");
  const state = gate.met ? "met" : gate.override ? "passed" : "open";
  const mayOverride = write && gate.overridable && canDecide(actor) && project.workflow.stage === "Development";
  return (
    <li className={`pd-gate ${state}`}>
      <span className="pd-gate-mark" aria-hidden="true">
        {state === "met" ? "✓" : state === "passed" ? "↷" : "○"}
      </span>
      <span className="grow">
        <span className="pd-gate-label">{gate.label}</span>
        <span className="pd-gate-detail">
          {state === "passed" && gate.override
            ? `Passed by hand by ${nameOf(gate.override.byPersonId)}, ${fmtDate(gate.override.at.slice(0, 10))}: ${gate.override.note}`
            : gate.detail}
        </span>
      </span>
      <span className="sr-only">{state === "met" ? "Done" : state === "passed" ? "Passed by hand" : "Not yet"}</span>
      {mayOverride && state === "open" && (
        <button className="btn small ghost" onClick={() => setOverriding(true)}>
          Pass by hand…
        </button>
      )}
      {mayOverride && state === "passed" && (
        <button
          className="btn small ghost"
          onClick={async () => {
            if (
              await confirm({
                title: "Take back passing this gate?",
                body: `${gate.label}. It will need to be met again before the project moves on.`,
                confirmLabel: "Take back",
              })
            )
              attempt(() => setGateOverride(actor, project.contentId, gate.key, null), "Taken back");
          }}
        >
          Take back
        </button>
      )}
      {overriding && (
        <Modal
          title="Pass this gate by hand"
          onClose={() => setOverriding(false)}
          actions={
            <>
              <button className="btn" onClick={() => setOverriding(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!note.trim()}
                onClick={() => {
                  if (attempt(() => setGateOverride(actor, project.contentId, gate.key, note), "Passed by hand, with your note")) {
                    setOverriding(false);
                    setNote("");
                  }
                }}
              >
                Pass it
              </button>
            </>
          }
        >
          <p className="sub">{gate.label}. The note is kept with the project and in the activity log.</p>
          <Field label="Why it can move on without this (a short note)">
            <textarea value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </li>
  );
}

/** The show producer, named by Operations: part of the greenlight gate for a series or documentary. */
export function ProducerField({ project }: { project: Project }) {
  const { actor, attempt } = useApp();
  return (
    <div className="row" style={{ alignItems: "end" }}>
      <Field label="Show producer">
        <CrewSelect
          label="Show producer"
          value={project.workflow.showProducerId}
          disabled={!canNameProducer(actor) || project.archived}
          onChange={(p) =>
            attempt(() => assignProducer(actor, project.contentId, p), p ? `${nameOf(p)} is the show producer` : "Producer removed")
          }
        />
      </Field>
      {project.workflow.producerAssignedAt && (
        <p className="muted" style={{ flex: "none", paddingBottom: 10 }}>
          Named by {nameOf(project.workflow.producerAssignedById)}, {fmtDate(project.workflow.producerAssignedAt.slice(0, 10))}.
        </p>
      )}
    </div>
  );
}

export function DevelopmentGate({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt, confirm, toast } = useApp();
  const [ask, reasonModal] = useReason();
  const [accepting, setAccepting] = useState(false);
  const [acceptNote, setAcceptNote] = useState("");
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed(project.contentId));
  const [showAll, setShowAll] = useState(false);
  const devotion = catalogTypeOf(project.workflow.formType) === "devotion";
  if (project.workflow.stage !== "Development" || project.archived) return null;
  const gates = hardGates(project.contentId);
  const gate = evaluateGate("Development", "project", project.contentId);
  const nudges = softNudges(project.contentId);
  const shown = showAll ? nudges : nudges.filter((n) => !dismissed.includes(n));
  const hidden = nudges.length - nudges.filter((n) => !dismissed.includes(n)).length;
  const dismiss = (n: string) => {
    const next = [...dismissed, n];
    setDismissed(next);
    keepDismissed(project.contentId, next);
  };
  const ready = gates.every((g) => g.met || g.override);
  const decider = canDecide(actor);
  const accept = () => {
    const list = attempt(() => acceptDevotion(actor, project.contentId, acceptNote));
    if (!list) return;
    setAccepting(false);
    setAcceptNote("");
    toast(`Accepted. ${list.episodes.length} devotion${list.episodes.length === 1 ? "" : "s"} listed in Pre-production.`, "success");
  };
  const decline = async () => {
    const reason = await ask(
      `Decline ${project.title}`,
      "Why is it declined? It is kept with the project, which is closed and archived.",
      "Continue",
    );
    if (!reason) return;
    if (
      await confirm({
        title: `Decline ${project.title}?`,
        body: `The devotion is closed and archived, never deleted, with its Content ID. Reason: ${reason}`,
        confirmLabel: "Decline",
        danger: true,
      })
    )
      attempt(
        () => decideGreenlight(actor, project.contentId, { outcome: "Decline", notes: reason, date: todayIso() }),
        "Declined and archived",
      );
  };
  return (
    <section className="glass panel pd-gatebox" aria-label={devotion ? "Accept or decline" : "Leave Development"}>
      <div className="pd-gatebox-head">
        <h2>{devotion ? "Accept or decline" : "Leave Development"}</h2>
        <span className={`badge ${ready ? "ok" : ""}`}>
          {gates.filter((g) => g.met || g.override).length} of {gates.length} ready
        </span>
      </div>
      <ul className="pd-gates" aria-label="What must be in place">
        {gates.map((g) => (
          <GateLine key={g.key} project={project} gate={g} write={write} />
        ))}
      </ul>
      {nudges.length > 0 && (
        <div className="pd-nudges" aria-label="Notes that do not block">
          {shown.map((n) => (
            <div key={n} className="pd-nudge">
              <span className="grow">{n}</span>
              {!dismissed.includes(n) && (
                <button className="btn small ghost" aria-label={`Dismiss: ${n}`} onClick={() => dismiss(n)}>
                  Dismiss
                </button>
              )}
            </div>
          ))}
          {hidden > 0 && (
            <button className="btn small ghost" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Hide dismissed notes" : `Show ${hidden} dismissed note${hidden === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      )}
      <div className="wf-actions">
        {devotion ? (
          <>
            <button
              className="btn primary"
              disabled={!write || !decider || !ready}
              title={!decider ? 'The Head of Production, or someone given "Create projects", accepts a devotion.' : undefined}
              onClick={() => setAccepting(true)}
            >
              Accept
            </button>
            <button className="btn danger" disabled={!write || !decider} onClick={() => void decline()}>
              Decline
            </button>
            {!decider && <span className="muted">The Head of Production, or someone given "Create projects", accepts or declines.</span>}
          </>
        ) : (
          <button
            className="btn primary"
            disabled={!write || !gate.passed}
            onClick={async () => {
              if (
                await confirm({
                  title: "Move to Pre-production?",
                  body: "Development is finished for this project. It cannot move back.",
                  confirmLabel: "Move on",
                })
              )
                attempt(() => advanceProject(actor, project.contentId), "Moved to Pre-production");
            }}
          >
            Done: move to Pre-production
          </button>
        )}
      </div>
      {reasonModal}
      {accepting && (
        <Modal
          title={`Accept ${project.title}?`}
          onClose={() => setAccepting(false)}
          actions={
            <>
              <button className="btn" onClick={() => setAccepting(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={accept}>
                Accept
              </button>
            </>
          }
        >
          <p className="sub">
            The devotion moves to Pre-production, and its devotions are listed there from the script, each with its own Content ID.
          </p>
          <Field label="A note for the record (optional)">
            <textarea value={acceptNote} maxLength={2000} onChange={(e) => setAcceptNote(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </section>
  );
}
