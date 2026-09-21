import { useState } from "react";
import type { ContentRecord, ProductionLevel } from "../types";
import { useApp } from "../ui/AppContext";
import { LevelField } from "../ui/LevelField";
import { Field } from "../ui/parts";
import { levelLabel } from "../config/production";
import { shootDateLabel } from "../config/categories";
import { canWrite } from "../services/access";
import { updateRecord, usesPipeline } from "../services/wrapped/content";
import { nameWithRole } from "../services/wrapped/team";
import { fmtDate, fmtShort, relativeDays } from "../services/utils";

/** Details you can change in place. Click Edit, or click any value. */
export function RecordDetails({ rec }: { rec: ContentRecord }) {
  const { actor, attempt } = useApp();
  const write = canWrite(actor, rec);
  const leaf = usesPipeline(rec);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(rec.title);
  const [scheduled, setScheduled] = useState(rec.scheduledDate ?? "");
  const [deadline, setDeadline] = useState(rec.deadline ?? "");
  const [notes, setNotes] = useState(rec.notes);
  const [level, setLevel] = useState<ProductionLevel | null>(rec.productionLevel);
  const [showStart, setShowStart] = useState(rec.showStart ?? "");
  const [showEnd, setShowEnd] = useState(rec.showEnd ?? "");
  const [version, setVersion] = useState(rec.version);
  const liveDay = rec.category === "live" && leaf;
  const hasShowDates = rec.hierarchyLevel === 0 && (rec.category === "series" || rec.category === "live");

  const start = () => {
    if (!write) return;
    setTitle(rec.title); setScheduled(rec.scheduledDate ?? ""); setDeadline(rec.deadline ?? ""); setNotes(rec.notes); setLevel(rec.productionLevel); setShowStart(rec.showStart ?? ""); setShowEnd(rec.showEnd ?? ""); setVersion(rec.version);
    setEditing(true);
  };
  const save = () => {
    const ok = attempt(() => updateRecord(actor, rec.contentId, { title, scheduledDate: leaf ? scheduled || null : rec.scheduledDate, deadline: deadline || null, notes, ...(liveDay ? { productionLevel: level } : {}), ...(hasShowDates ? { showStart: showStart || null, showEnd: showEnd || null } : {}) }, version), "Saved");
    if (ok) setEditing(false);
  };
  const click = write && !editing ? { onClick: start, style: { cursor: "text" }, title: "Click to edit" } : {};

  return (
    <section className="glass panel" aria-label="Details">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ flex: 1 }}>Details</h2>
        {write && !editing && <button className="btn small" onClick={start}>Edit details</button>}
      </div>
      {editing ? (
        <div className="stack">
          <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
          <div className="row">
            {leaf && <Field label={shootDateLabel(rec.category)}><input type="date" value={scheduled} onChange={(e) => setScheduled(e.target.value)} /></Field>}
            <Field label="Publish date"><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></Field>
          </div>
          {hasShowDates && (
            <div className="row">
              <Field label={rec.category === "live" ? "First day of the show" : "Show starts"}><input type="date" value={showStart} onChange={(e) => setShowStart(e.target.value)} /></Field>
              <Field label={rec.category === "live" ? "Last day of the show" : "Show ends"}><input type="date" value={showEnd} onChange={(e) => setShowEnd(e.target.value)} /></Field>
            </div>
          )}
          {liveDay && <LevelField value={level} onChange={setLevel} />}
          <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save changes</button>
          </div>
        </div>
      ) : (
        <dl className="kv">
          {leaf && (
            <>
              <dt>Responsible now</dt>
              <dd>{nameWithRole(rec.assigneePersonId, rec)}<span className="muted" style={{ fontSize: ".84rem" }}> (owner of {rec.pipelineStage}, changed under Who does what)</span></dd>
              <dt>{shootDateLabel(rec.category)}</dt>
              <dd {...click}>{fmtDate(rec.scheduledDate)}</dd>
            </>
          )}
          {hasShowDates && (
            <>
              <dt>Show runs</dt>
              <dd {...click}>{rec.showStart ? `${fmtDate(rec.showStart)}${rec.showEnd && rec.showEnd !== rec.showStart ? ` to ${fmtDate(rec.showEnd)}` : ""}` : <span className="muted">Not set</span>}</dd>
            </>
          )}
          <dt>Publish date</dt>
          <dd {...click}>{rec.deadline ? `${fmtDate(rec.deadline)} (${relativeDays(rec.deadline)})` : "Not set"}</dd>
          {liveDay && (
            <>
              <dt>Level of production</dt>
              <dd {...click}>{levelLabel(rec.productionLevel)}{rec.productionLevel === "large" && <span className="badge accent" style={{ marginLeft: 8 }}>Call sheet has a run of show</span>}</dd>
            </>
          )}
          <dt>Started</dt>
          <dd>{fmtShort(rec.startDate)}</dd>
          <dt>Notes</dt>
          <dd {...click} style={{ whiteSpace: "pre-wrap", ...(write ? { cursor: "text" } : {}) }}>{rec.notes || <span className="muted">None{write ? ". Click to add." : ""}</span>}</dd>
        </dl>
      )}
    </section>
  );
}
