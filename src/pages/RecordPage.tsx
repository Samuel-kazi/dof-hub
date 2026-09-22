import { useState } from "react";
import { ReportButton } from "../ui/ReportDialog";
import type { ContentRecord } from "../types";
import { useApp } from "../ui/AppContext";
import { useDb } from "../data/store";
import { categoryOf, leafLabel } from "../config/categories";
import { levelLabel as productionLabel } from "../config/production";
import { canComment, canView, canWrite, getRecord } from "../services/access";
import {
  addComment, advanceStage, canAdvance, canDelete, childKindFor, currentStageDeadline, deleteRecord, deletionImpact, deletionSummary, getBreadcrumb, getChildren, getComments,
  getRollupStatus, isComplete, levelLabel, sendBackStage, setStageDeadline, setStageOutput, updateRecord, usesPipeline,
} from "../services/wrapped/content";
import { callSheetForRecord, openOrCreateForRecord } from "../services/wrapped/callsheets";
import { nameOf } from "../services/wrapped/people";
import { fmtDate, fmtShort, relativeDays } from "../services/utils";
import { Empty, Field, RiskBadge, StageBadge } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { EditRecordModal, NewRecordModal } from "./RecordForms";
import { useRecordMenu } from "./Pipeline";
import { RecordExtras } from "./RecordExtras";
import { RecordDetails } from "./RecordDetails";
import { CastPanel } from "./CastPanel";
import { LinksPanel, PostProductionPanel, StageChecklist, StagePlan, StrikePlanPanel } from "./StagePanel";

export function RecordPage({ id }: { id: string }) {
  const { actor, go, back, attempt, confirm, menu, toast } = useApp();
  useDb();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [comment, setComment] = useState("");
  const rm = useRecordMenu();
  const rec = getRecord(id);

  if (!rec || !canView(actor, rec)) return <div className="page"><Empty>This record does not exist or is not part of a project you are attached to.</Empty></div>;

  const cfg = categoryOf(rec.category);
  const write = canWrite(actor, rec);
  const leaf = usesPipeline(rec);
  const crumbs = getBreadcrumb(rec.contentId);
  const kind = childKindFor(rec);
  const children = getChildren(rec.contentId);
  const roll = !leaf ? getRollupStatus(rec.contentId) : null;
  const del = canDelete(rec.contentId);
  const comments = getComments(rec.contentId);
  const existingSheet = leaf ? callSheetForRecord(rec) : undefined;

  const stageIdx = leaf ? cfg.stages.findIndex((s) => s.name === rec.pipelineStage) : -1;
  const stage = leaf ? cfg.stages[stageIdx] : null;
  const gate = leaf ? canAdvance(rec) : { ok: false, reason: "" };
  const outputDone = leaf && rec.pipelineStage ? rec.stageOutputs[rec.pipelineStage] : false;
  const isLast = leaf && stageIdx === cfg.stages.length - 1;
  const nextStage = leaf && !isLast ? cfg.stages[stageIdx + 1].name : "";

  const callSheet = () => {
    if (existingSheet) {
      toast("A call sheet already exists for this project. Opening it instead of creating another.", "info");
      go({ n: "callsheet", id: existingSheet.id });
      return;
    }
    const res = attempt(() => openOrCreateForRecord(actor, rec.contentId), "Call sheet created");
    if (res) go({ n: "callsheet", id: res.sheet.id });
  };

  const fieldMenu = (e: React.MouseEvent, label: string, clear?: () => void, hasValue = true) =>
    menu(e, [
      { label: `Edit ${label}…`, disabled: !write, onClick: () => setEditing(true) },
      ...(clear ? [{ label: `Clear ${label}`, danger: true, disabled: !write || !hasValue, onClick: clear }] : []),
    ]);

  const clearField = (patch: Partial<ContentRecord>) => () => attempt(() => updateRecord(actor, rec.contentId, patch, rec.version), "Cleared");

  const postComment = () => {
    if (attempt(() => addComment(actor, rec.contentId, comment), "Comment added")) setComment("");
  };

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => go({ n: "pipeline", category: rec.category })}>{cfg.label}</button>
        {crumbs.map((c, i) => (
          <span key={c.contentId}>
            <span aria-hidden> / </span>
            {i === crumbs.length - 1 ? <span>{c.title}</span> : <button onClick={() => go({ n: "record", id: c.contentId })}>{c.title}</button>}
          </span>
        ))}
      </nav>

      <div className="page-head">
        <div className="grow">
          <h1>{rec.title}</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
            <span className="cid">{rec.contentId}</span>
            <span className="badge">{levelLabel(rec)}</span>
            <StageBadge record={rec} />
            <RiskBadge record={rec} />
          </div>
        </div>
        <ReportButton scope="project" params={{ contentId: rec.contentId }} label="Project report" />
        {leaf && (
          <button className="btn" onClick={callSheet} disabled={!existingSheet && !write}>{existingSheet ? "Open call sheet" : "Create call sheet"}</button>
        )}
        {kind && write && <button className="btn primary" onClick={() => setAdding(true)}><IconPlus /> Add {kind.toLowerCase()}</button>}
        {write && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {write && (
          <button
            className="btn danger"
            disabled={!del.ok}
            title={del.ok ? "" : del.reason}
            onClick={async () => {
              const impact = attempt(() => deletionImpact(actor, rec.contentId));
              if (!impact) return;
              if (impact.blockers.length) { toast(impact.blockers[0], "error"); return; }
              if (await confirm({ title: `Delete “${rec.title}”?`, body: deletionSummary(impact), confirmLabel: "Delete", danger: true })) {
                if (attempt(() => deleteRecord(actor, rec.contentId), "Deleted")) back();
              }
            }}
          >
            Delete
          </button>
        )}
      </div>
      {!del.ok && write && <p className="muted">{del.reason}</p>}
      {!write && <div className="banner"><span className="grow">You have view-only access to this project.{canComment(actor, rec) ? " You can add comments." : ""}</span></div>}

      {leaf && stage && (
        <section className="glass panel" aria-label="Pipeline">
          <h2>Pipeline</h2>
          <div className="rail">
            {cfg.stages.map((s, i) => (
              <div key={s.name} className={`rail-step ${i < stageIdx ? "done" : i === stageIdx ? "now" : ""}`}>{s.name}</div>
            ))}
          </div>
          <PostProductionPanel rec={rec} />
          <div className={`gate ${gate.ok ? "ready" : ""}`}>
            <label className="check">
              <input type="checkbox" checked={outputDone} disabled={!write} onChange={(e) => attempt(() => setStageOutput(actor, rec.contentId, e.target.checked, rec.version))} />
              <span><b>{stage.requiredOutput}</b> is in place</span>
            </label>
            <span className="muted grow" style={{ flex: 1 }}>{isComplete(rec) ? "This item is complete." : gate.ok ? `Ready to move to ${nextStage}.` : gate.reason}</span>
            {write && !isLast && (
              <>
                <button className="btn small ghost" disabled={stageIdx === 0} onClick={() => attempt(() => sendBackStage(actor, rec.contentId, rec.version), "Sent back one stage")}>Send back</button>
                <button className="btn primary" disabled={!gate.ok} onClick={() => attempt(() => advanceStage(actor, rec.contentId, rec.version), `Moved to ${nextStage}`)}>Done, move to {nextStage}</button>
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 14, alignItems: "end" }}>
            <Field label={`${stage.name} deadline (${currentStageDeadline(rec) ? relativeDays(currentStageDeadline(rec)!) : "not set"})`}>
              <input type="date" value={currentStageDeadline(rec) ?? ""} disabled={!write} onChange={(e) => e.target.value && attempt(() => setStageDeadline(actor, rec.contentId, stage.name, e.target.value, rec.version))} />
            </Field>
            <div className="muted" style={{ paddingBottom: 10 }}>The person responsible is reminded before this date.</div>
          </div>
        </section>
      )}

      {leaf && <RecordDetails rec={rec} />}
      {leaf && stage && <StagePlan rec={rec} />}
      {leaf && stage && <StageChecklist rec={rec} />}
      {leaf && stage && <LinksPanel rec={rec} />}

      {roll && (
        <section className="glass panel" aria-label="Rollup">
          <h2>Progress</h2>
          {roll.total === 0 ? (
            <Empty>{kind ? `No ${kind.toLowerCase()}s yet. Add one to start.` : "Nothing here yet."}</Empty>
          ) : (
            <div className="stack">
              <div>
                <b>{roll.complete} of {roll.total}</b> {leafLabel(rec.category).toLowerCase()}s complete
                <div className="meter" style={{ marginTop: 8 }}><i style={{ width: `${(roll.complete / roll.total) * 100}%` }} /></div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {Object.entries(roll.byStage).map(([s, n]) => <span key={s} className="badge">{s}: {n}</span>)}
                {roll.overdue > 0 && <span className="badge bad">{roll.overdue} overdue</span>}
                {roll.atRisk > 0 && <span className="badge warn">{roll.atRisk} at risk</span>}
              </div>
            </div>
          )}
        </section>
      )}

      {kind && (
        <section className="glass panel" aria-label={`${kind}s`}>
          <h2>{kind}s</h2>
          {children.length === 0 ? (
            <Empty>No {kind.toLowerCase()}s yet.</Empty>
          ) : (
            <div className="list">
              {children.map((c) => {
                const r = !usesPipeline(c) ? getRollupStatus(c.contentId) : null;
                return (
                  <div key={c.contentId} className="list-item" onClick={() => go({ n: "record", id: c.contentId })} onContextMenu={(e) => rm.onContext(e, c)}>
                    <div className="grow">
                      <div className="title">{c.title}</div>
                      <span className="cid">{c.contentId}</span>{c.category === "live" && c.scheduledDate && <span className="muted" style={{ fontSize: ".84rem" }}>{`  ${fmtShort(c.scheduledDate)}`}</span>}
                    </div>
                    {c.category === "live" && c.productionLevel && <span className="badge accent">{productionLabel(c.productionLevel)}</span>}
                    {r ? <span className="badge">{r.complete} of {r.total} complete</span> : <><StageBadge record={c} /><RiskBadge record={c} /></>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {!leaf && <RecordDetails rec={rec} />}
      {!leaf && <StrikePlanPanel rec={rec} />}

      {!leaf && <StagePlan rec={rec} />}
      {cfg.key !== "music" && <CastPanel rec={rec} />}
      <RecordExtras rec={rec} />

      <section className="glass panel" aria-label="Comments">
        <h2>Comments</h2>
        {comments.length === 0 ? <Empty>No comments yet.</Empty> : comments.map((c) => (
          <div key={c.id} className="comment">
            <b>{nameOf(c.byPersonId)}</b> <small>{new Date(c.at).toLocaleString()}</small>
            <p>{c.text}</p>
          </div>
        ))}
        {canComment(actor, rec) ? (
          <div className="row" style={{ marginTop: 12, alignItems: "end" }}>
            <Field label="Add a comment"><textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
            <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" onClick={postComment}>Post comment</button></div>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>You can read comments on this project but not add them.</p>
        )}
      </section>

      {rm.modal}
      {editing && <EditRecordModal record={rec} onClose={() => setEditing(false)} />}
      {adding && <NewRecordModal parent={rec} onClose={() => setAdding(false)} onCreated={(r) => { setAdding(false); go({ n: "record", id: r.contentId }); }} />}
    </div>
  );
}
