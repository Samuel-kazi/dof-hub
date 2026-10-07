import { useState } from "react";
import type { Actor } from "../../types";
import { catalogTypeOf } from "../../config/documentCatalog";
import { isHop } from "../../services/access";
import { can } from "../../services/wrapped/permissions";
import { nameOf } from "../../services/wrapped/people";
import { acceptDevotion, hardGates } from "../../services/wrapped/documents";
import { advanceProject, assignProducer, decideGreenlight, evaluateGate, type Project } from "../../services/wrapped/workflow";
import { fmtDate, todayIso } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/parts";
import { CrewSelect } from "../../ui/workflow/shared";
import { useReason } from "../workflow/common";
import { openChecks } from "../../ui/checksNav";

// Leaving Development: the button that moves on, "Done: move to Pre-production" for a series or documentary, Accept or
// Decline for a devotion. What it needs (the hard gates, each met, passed by hand with a note, or not yet, and the
// nudges that never block) is in the Checks panel under the stage tracker (src/ui/ChecksPanel.tsx), which opens by
// itself when the button is pressed while something required is missing.

const canDecide = (actor: Actor) => isHop(actor) || can(actor, "pipeline.manage");
const canNameProducer = (actor: Actor) => isHop(actor) || can(actor, "pipeline.assign");

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
  const devotion = catalogTypeOf(project.workflow.formType) === "devotion";
  if (project.workflow.stage !== "Development" || project.archived) return null;
  const gates = hardGates(project.contentId);
  const gate = evaluateGate("Development", "project", project.contentId);
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
        deliberate: true,
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
      <p className="muted">
        {ready
          ? "Everything required is in place."
          : `${gates.filter((g) => !g.met && !g.override).length} still needed: see Checks, under the stage tracker.`}
      </p>
      <div className="wf-actions">
        {devotion ? (
          <>
            <button
              className="btn primary"
              disabled={!write || !decider}
              title={!decider ? 'The Head of Production, or someone given "Create projects", accepts a devotion.' : undefined}
              onClick={() => (ready ? setAccepting(true) : openChecks(project.contentId))}
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
            disabled={!write}
            onClick={async () => {
              if (!gate.passed) return openChecks(project.contentId);
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
          deliberate
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
