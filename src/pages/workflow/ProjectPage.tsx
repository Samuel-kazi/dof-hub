import { useState } from "react";
import { categoryOf } from "../../config/categories";
import { formTypeOf } from "../../config/workflow";
import { canWrite, isHop } from "../../services/access";
import { can } from "../../services/wrapped/permissions";
import { getBreadcrumb, updateRecord } from "../../services/wrapped/content";
import { nameOf } from "../../services/wrapped/people";
import { closeProject, projectSummary, setWorkflowDeadline, type Project } from "../../services/wrapped/workflow";
import { fmtDate } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/parts";
import { StageRail, useReason } from "./common";
import { ProjectDocuments } from "../documents/ProjectDocuments";

// A project of the five-stage workflow: a season of a series, a devotion or a documentary. Its stage is worked
// out from its sessions and episodes. Below its header and stage tracker are its documents: Project Home, with a row
// of tiles for each stage (src/pages/documents/ProjectDocuments.tsx).

function EditProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const [title, setTitle] = useState(project.title);
  const [publish, setPublish] = useState(project.deadline ?? "");
  const [notes, setNotes] = useState(project.notes);
  const [dev, setDev] = useState(project.stageDeadlines.Development ?? "");
  const [pre, setPre] = useState(project.stageDeadlines["Pre-production"] ?? "");
  const save = () => {
    const ok =
      attempt(() => updateRecord(actor, project.contentId, { title, deadline: publish || null, notes })) &&
      (dev === (project.stageDeadlines.Development ?? "") ||
        attempt(() => setWorkflowDeadline(actor, project.contentId, "Development", dev || null))) &&
      (pre === (project.stageDeadlines["Pre-production"] ?? "") ||
        attempt(() => setWorkflowDeadline(actor, project.contentId, "Pre-production", pre || null)));
    if (ok) onClose();
  };
  return (
    <Modal
      title={`Edit ${project.title}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title">
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <p className="muted">The Content ID, {project.contentId}, never changes.</p>
        <div className="row">
          <Field label="Publish date">
            <input type="date" value={publish} onChange={(e) => setPublish(e.target.value)} />
          </Field>
          <Field label="Development deadline">
            <input type="date" value={dev} onChange={(e) => setDev(e.target.value)} />
          </Field>
          <Field label="Pre-production deadline">
            <input type="date" value={pre} onChange={(e) => setPre(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function WorkflowProjectPage({ project }: { project: Project }) {
  const { actor, go, attempt, confirm } = useApp();
  const summary = projectSummary(project);
  const [editing, setEditing] = useState(false);
  const [ask, reasonModal] = useReason();
  const cfg = categoryOf(project.category);
  const write = canWrite(actor, project) && !project.archived;
  const crumbs = getBreadcrumb(project.contentId);
  const mayClose = isHop(actor) || can(actor, "pipeline.manage") || project.workflow.showProducerId === actor.personId;
  const close = async () => {
    const reason = await ask(
      `Close ${project.title}`,
      "Why is it being closed (withdrawn, or the guest did not comply)? It is archived with this reason, and kept.",
      "Continue",
    );
    if (!reason) return;
    if (
      await confirm({
        title: `Close ${project.title}?`,
        body: `It is archived with its Content ID, form, sessions and episodes, and cannot be changed afterwards. Reason: ${reason}`,
        confirmLabel: "Close project",
        danger: true,
      })
    )
      attempt(() => closeProject(actor, project.contentId, reason), "Project closed");
  };
  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => go({ n: "pipeline", category: project.category })}>{cfg.label}</button>
        {crumbs.map((c, i) => (
          <span key={c.contentId}>
            <span aria-hidden> / </span>
            {i === crumbs.length - 1 ? (
              <span>{c.title}</span>
            ) : (
              <button onClick={() => go({ n: "record", id: c.contentId })}>{c.title}</button>
            )}
          </span>
        ))}
      </nav>
      <div className="page-head">
        <div className="grow">
          <h1>{project.title}</h1>
          <div className="wf-chips" style={{ marginTop: 4 }}>
            <span className="cid">{project.contentId}</span>
            <span className="badge">{formTypeOf(project.workflow.formType).label}</span>
            <span className={`badge ${project.archived ? "bad" : project.workflow.status === "Completed" ? "ok" : "accent"}`}>
              {summary.stage}
            </span>
            {project.deadline && <span className="muted">Publish {fmtDate(project.deadline)}</span>}
            <span className="muted">
              Producer: {project.workflow.showProducerId ? nameOf(project.workflow.showProducerId) : "not named"}
            </span>
          </div>
        </div>
        {write && (
          <button className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {write && mayClose && (
          <button className="btn danger" onClick={() => void close()}>
            Close project
          </button>
        )}
      </div>
      {project.archived && (
        <div className="banner bad">
          <span className="grow">
            {project.workflow.status === "Advice only" ? "Advice only" : "Closed"}: {project.closedReason}. The project is kept as it was.
          </span>
        </div>
      )}
      {!canWrite(actor, project) && <div className="banner">You have view-only access to this project.</div>}
      <section className="glass panel" aria-label="Where it stands">
        <StageRail current={summary.stage} />
        <p style={{ marginTop: 10 }}>{summary.text}</p>
      </section>
      <ProjectDocuments project={project} write={write} />
      {editing && <EditProjectModal project={project} onClose={() => setEditing(false)} />}
      {reasonModal}
    </div>
  );
}
