import { useState } from "react";
import type { Actor, CriterionKey, GreenlightOutcome } from "../../types";
import { CRITERIA, formTypeOf } from "../../config/workflow";
import { DEV_FORMS, type SectionDef } from "../../config/devForms";
import { getDb } from "../../data/store";
import { isHop } from "../../services/access";
import { can } from "../../services/wrapped/permissions";
import { nameOf } from "../../services/wrapped/people";
import {
  addPlannedEpisode,
  advanceProject,
  archivePlannedEpisode,
  assignProducer,
  decideGreenlight,
  evaluateGate,
  formProblems,
  greenlightBlockers,
  greenlightStageOf,
  plannedOf,
  saveFormSection,
  setCriterion,
  setReviewWindow,
  updatePlannedEpisode,
  type Project,
} from "../../services/wrapped/workflow";
import { fmtDate, todayIso } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { CrewSelect, GatePanel } from "../../ui/workflow/shared";
import { CheckpointCard, ConfigChecklist, FieldInput, useDraft, useReason } from "./common";

// Development: the form, section by section, the planned episodes, the six criteria, the pitch and outline
// review checkpoints, the review window and the greenlight decision, and the handoff to Pre-production.

// The same rules the services apply (src/services/workflow/common.ts), so the screen only offers what will work.
const canDecideGreenlight = (actor: Actor) => isHop(actor) || can(actor, "pipeline.manage");
const canNameProducer = (actor: Actor) => isHop(actor) || can(actor, "pipeline.assign");

// ── One section of the form ──────────────────────────────────

function SectionEditor({ project, section, write, open }: { project: Project; section: SectionDef; write: boolean; open: boolean }) {
  const { actor, attempt } = useApp();
  const form = getDb().developmentForms.find((f) => f.contentId === project.contentId);
  const stored = (form?.sections[section.key] ?? {}) as Record<string, unknown>;
  const [draft, setDraft, dirty, saved] = useDraft(stored);
  const missing = formProblems(project.contentId, 2).filter((m) => m.startsWith(`${section.label}:`));
  const save = () => {
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(stored[k])));
    if (attempt(() => saveFormSection(actor, project.contentId, section.key, changed), `${section.label} saved`)) saved();
  };
  return (
    <details className="glass panel wf-section" open={open}>
      <summary>
        <h2>{section.label}</h2>
        {missing.length ? <span className="badge warn">{missing.length} to fill in</span> : <span className="badge ok">Complete</span>}
      </summary>
      {section.fields.length > 0 && (
        <div className="wf-fields">
          {section.fields.map((f) => (
            <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`}>
              <FieldInput def={f} value={draft[f.key]} disabled={!write} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
              {f.hint && <small className="muted">{f.hint}</small>}
            </Field>
          ))}
        </div>
      )}
      {section.fields.length > 0 && write && (
        <div className="wf-actions">
          <button className="btn primary" disabled={!dirty} onClick={save}>
            Save {section.label.toLowerCase()}
          </button>
          {dirty && <span className="muted">Not saved yet.</span>}
        </div>
      )}
      {section.planned && <PlannedEditor project={project} section={section} write={write} />}
      {missing.length > 0 && (
        <ul className="wf-missing" aria-label={`Still needed in ${section.label}`}>
          {missing.map((m) => (
            <li key={m}>{m.slice(section.label.length + 2)}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

// ── Planned episodes ─────────────────────────────────────────

function PlannedRow({ id, section, write }: { id: string; section: SectionDef; write: boolean }) {
  const { actor, attempt } = useApp();
  const [ask, reasonModal] = useReason();
  const p = getDb().plannedEpisodes.find((x) => x.id === id)!;
  const stored = { workingTitle: p.workingTitle, question: p.question, guest: p.guest, notes: p.notes, details: p.details };
  const [draft, setDraft, dirty, saved] = useDraft(stored);
  const recorded = getDb().records.some((r) => r.episode?.plannedEpisodeId === id && !r.archived);
  return (
    <tr>
      <td className="cid">{p.id.slice(p.contentId.length + 1)}</td>
      <td>
        <input
          type="text"
          aria-label={`Working title of ${p.id}`}
          value={draft.workingTitle}
          disabled={!write}
          onChange={(e) => setDraft({ ...draft, workingTitle: e.target.value })}
        />
      </td>
      <td>
        <input
          type="text"
          aria-label={`Question of ${p.id}`}
          value={draft.question}
          disabled={!write}
          onChange={(e) => setDraft({ ...draft, question: e.target.value })}
        />
      </td>
      <td>
        <input
          type="text"
          aria-label={`Guest of ${p.id}`}
          value={draft.guest}
          disabled={!write}
          onChange={(e) => setDraft({ ...draft, guest: e.target.value })}
        />
      </td>
      {section.planned!.details.map((d) => (
        <td key={d.key}>
          <FieldInput
            def={d}
            value={draft.details[d.key] ?? ""}
            disabled={!write}
            onChange={(v) => setDraft({ ...draft, details: { ...draft.details, [d.key]: String(v ?? "") } })}
          />
        </td>
      ))}
      <td>
        <input
          type="text"
          aria-label={`Notes of ${p.id}`}
          value={draft.notes}
          disabled={!write}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        {recorded && <span className="badge ok">Recorded</span>}
        {write && (
          <>
            <button
              className="btn small"
              disabled={!dirty}
              onClick={() => attempt(() => updatePlannedEpisode(actor, id, draft), "Saved") && saved()}
            >
              Save
            </button>
            {!recorded && (
              <button
                className="btn small ghost"
                onClick={async () => {
                  const reason = await ask(
                    `Take ${p.id} off the plan`,
                    "Why is it coming off the plan? It is kept, archived, with this reason.",
                    "Archive",
                  );
                  if (reason) attempt(() => archivePlannedEpisode(actor, id, reason), "Archived");
                }}
              >
                Archive
              </button>
            )}
          </>
        )}
        {reasonModal}
      </td>
    </tr>
  );
}

function PlannedEditor({ project, section, write }: { project: Project; section: SectionDef; write: boolean }) {
  const { actor, attempt } = useApp();
  const [title, setTitle] = useState("");
  const planned = plannedOf(project.contentId);
  const def = section.planned!;
  const full = def.max !== undefined && planned.length >= def.max;
  return (
    <div className="stack" style={{ marginTop: 14 }}>
      <h3>
        {def.label}{" "}
        <span className="muted">
          ({planned.length}
          {def.max ? ` of ${def.max}` : ""})
        </span>
      </h3>
      {planned.length === 0 ? (
        <Empty>
          No planned episodes yet.{def.min ? ` At least ${def.min} ${def.min === 1 ? "is" : "are"} needed before the greenlight.` : ""}
        </Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table wf-table">
            <thead>
              <tr>
                <th>No.</th>
                <th>Working title</th>
                <th>Question</th>
                <th>Guest</th>
                {def.details.map((d) => (
                  <th key={d.key}>{d.label}</th>
                ))}
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {planned.map((p) => (
                <PlannedRow key={p.id} id={p.id} section={section} write={write} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {write && !full && (
        <div className="row" style={{ alignItems: "end" }}>
          <Field label="Add a planned episode">
            <input
              type="text"
              value={title}
              placeholder="Working title"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  title.trim() &&
                  attempt(() => addPlannedEpisode(actor, project.contentId, { workingTitle: title }), "Added")
                )
                  setTitle("");
              }}
            />
          </Field>
          <div style={{ flex: "none" }}>
            <button
              className="btn primary"
              disabled={!title.trim()}
              onClick={() => attempt(() => addPlannedEpisode(actor, project.contentId, { workingTitle: title }), "Added") && setTitle("")}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Greenlight ───────────────────────────────────────────────

function CriteriaPanel({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt } = useApp();
  const form = getDb().developmentForms.find((f) => f.contentId === project.contentId)!;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <h3>The six criteria</h3>
      {CRITERIA.map((c) => {
        const v = form.criteria[c.key] ?? { met: null, note: "" };
        return (
          <div key={c.key} className="task-row">
            <span style={{ flex: "1 1 160px" }}>{c.label}</span>
            <select
              aria-label={c.label}
              value={v.met === null ? "" : v.met ? "met" : "not"}
              disabled={!write}
              onChange={(e) =>
                attempt(() =>
                  setCriterion(actor, project.contentId, c.key as CriterionKey, {
                    met: e.target.value === "" ? null : e.target.value === "met",
                    note: v.note,
                  }),
                )
              }
            >
              <option value="">Not assessed</option>
              <option value="met">Met</option>
              <option value="not">Not met</option>
            </select>
            <input
              type="text"
              className="wf-note"
              aria-label={`Note on ${c.label}`}
              placeholder="Note"
              defaultValue={v.note}
              disabled={!write}
              onBlur={(e) =>
                e.target.value !== v.note &&
                attempt(
                  () => setCriterion(actor, project.contentId, c.key as CriterionKey, { met: v.met, note: e.target.value }),
                  "Note saved",
                )
              }
            />
          </div>
        );
      })}
    </div>
  );
}

/** The greenlight decision at the project's current greenlight stage, with what blocks "Greenlight" and the history. */
export function DecisionPanel({ project, write, active }: { project: Project; write: boolean; active: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const form = getDb().developmentForms.find((f) => f.contentId === project.contentId)!;
  const type = formTypeOf(form.formType);
  const stage = greenlightStageOf(form);
  const [outcome, setOutcome] = useState<GreenlightOutcome | "">("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(todayIso());
  const blockers = greenlightBlockers(project, stage);
  const mayDecide = active && canDecideGreenlight(actor) && !project.archived;
  const closes = outcome === "Decline" || outcome === "Advice only";
  const record = async () => {
    if (!outcome) return;
    if (
      closes &&
      !(await confirm({
        title: `${outcome}: close this project?`,
        body: "The project is archived with your reason, and kept. It cannot be reopened from here.",
        confirmLabel: outcome,
        danger: true,
      }))
    )
      return;
    if (attempt(() => decideGreenlight(actor, project.contentId, { outcome, notes, date }), `Recorded: ${outcome}`)) {
      setOutcome("");
      setNotes("");
    }
  };
  return (
    <div className="stack">
      <h3>
        {type.greenlights === 2
          ? stage === 1
            ? "First greenlight: thesis, treatment and research budget"
            : "Second greenlight: shoot budget, interview sets and shot list"
          : "Greenlight decision"}
      </h3>
      <p>
        Current decision: <b>{form.outcome ?? "none yet"}</b>
        {form.decisionDate ? `, ${fmtDate(form.decisionDate)}` : ""}
        {form.reviewNotes ? `. ${form.reviewNotes}` : ""}
      </p>
      <div className="row" style={{ alignItems: "end" }}>
        <Field label="Review window: no decision by this date moves it to Hold">
          <input
            type="date"
            min={todayIso()}
            value={form.reviewWindowDate ?? ""}
            disabled={!write || !active}
            onChange={(e) => attempt(() => setReviewWindow(actor, project.contentId, e.target.value || null), "Review window set")}
          />
        </Field>
      </div>
      {blockers.length > 0 && (
        <div className="banner warn">
          <span className="grow">
            Before a greenlight: {blockers.slice(0, 6).join("; ")}
            {blockers.length > 6 ? `; and ${blockers.length - 6} more` : ""}.
          </span>
        </div>
      )}
      {mayDecide ? (
        <div className="row" style={{ alignItems: "end" }}>
          <Field label="Decision">
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as GreenlightOutcome | "")}>
              <option value="">Choose…</option>
              {type.outcomes.map((o) => (
                <option key={o} value={o} disabled={o === "Greenlight" && blockers.length > 0}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Decision date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={closes ? "Reason (required, kept with the project)" : "Review notes"}>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div style={{ flex: "none" }}>
            <button
              className={`btn ${closes ? "danger" : "primary"}`}
              disabled={!outcome || (closes && !notes.trim())}
              onClick={() => void record()}
            >
              Record decision
            </button>
          </div>
        </div>
      ) : active ? (
        <p className="muted">The Head of Production, or someone given "Create projects", records the decision.</p>
      ) : null}
      <DecisionHistory projectId={project.contentId} />
    </div>
  );
}

/** Every greenlight decision so far, the automatic ones included. */
export function DecisionHistory({ projectId }: { projectId: string }) {
  const form = getDb().developmentForms.find((f) => f.contentId === projectId);
  if (!form?.decisions.length) return null;
  return (
    <details>
      <summary className="muted">Greenlight decisions ({form.decisions.length})</summary>
      <ul>
        {form.decisions.map((d) => (
          <li key={d.at}>
            {fmtDate(d.date)}: {d.stage === 2 ? "second greenlight, " : ""}
            <b>{d.outcome}</b> by {d.byPersonId === "system" ? "the app (review window passed)" : nameOf(d.byPersonId)}
            {d.notes ? `. ${d.notes}` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

// ── The tab ──────────────────────────────────────────────────

export function DevelopmentTab({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const form = getDb().developmentForms.find((f) => f.contentId === project.contentId);
  if (!form) return <Empty>This project has no development form.</Empty>;
  const inDevelopment = project.workflow.stage === "Development";
  const sections = DEV_FORMS[form.formType];
  const firstIncomplete = sections.find((s) => formProblems(project.contentId, 2).some((m) => m.startsWith(`${s.label}:`)))?.key;
  const gate = evaluateGate("Development", "project", project.contentId);
  return (
    <div className="stack">
      {!inDevelopment && (
        <div className="banner">Development is done. The form is kept here as the project's record; it can still be corrected.</div>
      )}
      {sections.map((s) => (
        <SectionEditor key={s.key} project={project} section={s} write={write} open={inDevelopment && s.key === firstIncomplete} />
      ))}
      <section className="glass panel" aria-label="Greenlight">
        <h2>Greenlight</h2>
        <div className="grid-2">
          <CriteriaPanel project={project} write={write && inDevelopment} />
          <div className="stack">
            <h3>Theological review</h3>
            {(["pitch", "outline_script"] as const).map((k) => (
              <CheckpointCard key={k} id={`${project.contentId}|${k}`} canChooseReviewers={write} />
            ))}
          </div>
        </div>
        {inDevelopment ? <DecisionPanel project={project} write={write} active /> : <DecisionHistory projectId={project.contentId} />}
      </section>
      <section className="glass panel" aria-label="Show producer">
        <h2>Show producer</h2>
        <p className="muted">Named by Operations. The producer coordinates the show and assigns its other roles at Pre-production.</p>
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
        </div>
        {project.workflow.producerAssignedAt && (
          <p className="muted">
            Named by {nameOf(project.workflow.producerAssignedById)}, {fmtDate(project.workflow.producerAssignedAt.slice(0, 10))}.
          </p>
        )}
      </section>
      <ConfigChecklist
        title="Handoff"
        listKey="handoff"
        ownerId={project.contentId}
        disabled={!write || !inDevelopment}
        auto={{
          producer_named: [
            !!project.workflow.showProducerId,
            project.workflow.showProducerId ? nameOf(project.workflow.showProducerId) : "Name the producer above",
          ],
          project_created: [true, project.contentId],
        }}
      />
      {inDevelopment && (
        <GatePanel
          title="Leave Development"
          gate={gate}
          action="Done: move to Pre-production"
          disabled={!write}
          onDone={async () => {
            if (
              await confirm({
                title: "Move to Pre-production?",
                body: "Development is finished for this project. It cannot move back.",
                confirmLabel: "Move on",
              })
            )
              attempt(() => advanceProject(actor, project.contentId), "Moved to Pre-production");
          }}
        />
      )}
    </div>
  );
}
