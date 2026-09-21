import { useState } from "react";
import type { CategoryKey, ContentRecord, ProductionLevel } from "../types";
import { LevelField } from "../ui/LevelField";
import { getDb } from "../data/store";
import { CATEGORIES, categoryOf, shootDateLabel } from "../config/categories";
import { useApp } from "../ui/AppContext";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/parts";
import { createChildRecord, createRecord, childKindFor, updateRecord } from "../services/content";

// Assigning someone also attaches them to the project (see ensureMember in the content service).
function assigneeOptions() {
  return getDb().people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"));
}

/** New top-level project, or a child (Season / Episode / Album / Track) when `parent` is given. */
export function NewRecordModal({ category, parent, onClose, onCreated }: { category?: CategoryKey; parent?: ContentRecord; onClose: () => void; onCreated: (r: ContentRecord) => void }) {
  const { actor, attempt } = useApp();
  const [cat, setCat] = useState<CategoryKey>(parent?.category ?? category ?? "series");
  const [title, setTitle] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [deadline, setDeadline] = useState("");
  const [assignee, setAssignee] = useState("");
  const [notes, setNotes] = useState("");
  const [level, setLevel] = useState<ProductionLevel | null>(null);
  const [showStart, setShowStart] = useState("");
  const [showEnd, setShowEnd] = useState("");

  const cfg = categoryOf(cat);
  const kind = parent ? childKindFor(parent) : null;
  const willUsePipeline = parent ? parent.hierarchyLevel + 1 === cfg.leafLevel : cfg.leafLevel === 0;
  const hasShowDates = !parent && (cat === "series" || cat === "live");
  const liveShow = !parent && cat === "live";
  const heading = parent ? `Add ${kind?.toLowerCase()} to ${parent.title}` : `New ${cfg.singular.toLowerCase()}`;
  const options = assigneeOptions();

  const save = () => {
    const input = { title, scheduledDate: scheduled || null, deadline: deadline || null, assigneePersonId: assignee || null, notes, productionLevel: cat === "live" ? level : null, showStart: hasShowDates ? showStart || null : null, showEnd: hasShowDates ? showEnd || null : null };
    const rec = attempt(() => (parent ? createChildRecord(actor, parent.contentId, input) : createRecord(actor, { ...input, category: cat })), "Created");
    if (rec) onCreated(rec);
  };

  return (
    <Modal
      title={heading}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Create</button>
        </>
      }
    >
      <div className="stack">
        {!parent && (
          <Field label="Category">
            <select value={cat} onChange={(e) => setCat(e.target.value as CategoryKey)}>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Title">
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder={parent ? `${kind} title` : "Project title"} />
        </Field>
        {!parent && cfg.supportsChildren && !liveShow && <p className="muted">{cfg.label} projects hold {cfg.childLevelLabel?.toLowerCase()}s and {cfg.grandchildLevelLabel?.toLowerCase()}s. The {cfg.grandchildLevelLabel?.toLowerCase()}s move through the pipeline.</p>}
        {hasShowDates && (
          <div className="row">
            <Field label={liveShow ? "First day of the show" : "Show starts"}><input type="date" value={showStart} onChange={(e) => setShowStart(e.target.value)} /></Field>
            <Field label={liveShow ? "Last day of the show" : "Show ends"}><input type="date" value={showEnd} onChange={(e) => setShowEnd(e.target.value)} /></Field>
          </div>
        )}
        {liveShow && <p className="muted">Each day between those dates is created as its own item, with its own pipeline, call sheet and run of show. A one-day show is a single day. Leave the dates empty to add days later.</p>}
        <div className="row">
          {willUsePipeline && (
            <Field label={shootDateLabel(cat)}>
              <input type="date" value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
            </Field>
          )}
          <Field label="Publish date">
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
        </div>
        {willUsePipeline && (
          <Field label="Responsible person">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {options.map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {cat === "live" && (liveShow || willUsePipeline) && <LevelField value={level} onChange={setLevel} />}
        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function EditRecordModal({ record, onClose }: { record: ContentRecord; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const [title, setTitle] = useState(record.title);
  const [scheduled, setScheduled] = useState(record.scheduledDate ?? "");
  const [deadline, setDeadline] = useState(record.deadline ?? "");
  const [assignee, setAssignee] = useState(record.assigneePersonId ?? "");
  const [notes, setNotes] = useState(record.notes);
  const [level, setLevel] = useState<ProductionLevel | null>(record.productionLevel);
  const [showStart, setShowStart] = useState(record.showStart ?? "");
  const [showEnd, setShowEnd] = useState(record.showEnd ?? "");
  const [version] = useState(record.version); // captured at open, checked at save
  const hasShowDates = record.hierarchyLevel === 0 && (record.category === "series" || record.category === "live");
  const carriesPipeline = !!record.pipelineStage;

  const save = () => {
    const ok = attempt(
      () => updateRecord(actor, record.contentId, { title, scheduledDate: scheduled || null, deadline: deadline || null, assigneePersonId: assignee || null, notes, ...(record.category === "live" && carriesPipeline ? { productionLevel: level } : {}), ...(hasShowDates ? { showStart: showStart || null, showEnd: showEnd || null } : {}) }, version),
      "Saved",
    );
    if (ok) onClose();
  };

  return (
    <Modal title={`Edit ${record.title}`} onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save changes</button></>}>
      <div className="stack">
        <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <div className="row">
          {carriesPipeline && <Field label={shootDateLabel(record.category)}><input type="date" value={scheduled} onChange={(e) => setScheduled(e.target.value)} /></Field>}
          <Field label="Publish date"><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></Field>
        </div>
        {hasShowDates && (
          <div className="row">
            <Field label="Show starts"><input type="date" value={showStart} onChange={(e) => setShowStart(e.target.value)} /></Field>
            <Field label="Show ends"><input type="date" value={showEnd} onChange={(e) => setShowEnd(e.target.value)} /></Field>
          </div>
        )}
        {carriesPipeline && (
          <Field label="Responsible person">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {assigneeOptions().map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {record.category === "live" && carriesPipeline && <LevelField value={level} onChange={setLevel} />}
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
