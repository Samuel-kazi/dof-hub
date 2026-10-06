import { useState } from "react";
import type { CategoryKey, ContentRecord, ProductionLevel } from "../types";
import { LevelField } from "../ui/LevelField";
import { getDb } from "../data/store";
import { CATEGORIES, categoryOf, shootDateLabel } from "../config/categories";
import { useApp } from "../ui/AppContext";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/parts";
import { createChildRecord, createRecord, childKindFor, updateRecord } from "../services/wrapped/content";
import { createWorkflowProject } from "../services/wrapped/workflow";
import { FORM_TYPES, SERIES_TYPES, isWorkflowCategory } from "../config/workflow";
import type { FormType, ProductionMode, RecurrenceRule, SeriesType } from "../types";
import { createProduction } from "../services/wrapped/production";
import { weeklyFrom } from "../services/recurrence";
import { todayIso } from "../services/utils";
import { RuleEditor } from "./production/RuleEditor";

// Assigning someone also attaches them to the project (see ensureMember in the content service).
function assigneeOptions() {
  return getDb().people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"));
}

/** New top-level project, or a child (Season / Episode / Album / Track) when `parent` is given. */
export function NewRecordModal({
  category,
  parent,
  onClose,
  onCreated,
}: {
  category?: CategoryKey;
  parent?: ContentRecord;
  onClose: () => void;
  onCreated: (r: ContentRecord) => void;
}) {
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
  const [seriesType, setSeriesType] = useState<SeriesType | "">("");
  const [docKind, setDocKind] = useState<FormType | "">("");
  // A live show is a production: a recurring show, a one-time event or a multi-day event.
  const [mode, setMode] = useState<ProductionMode>("one_time");
  const [rule, setRule] = useState<RecurrenceRule>(() => weeklyFrom(todayIso()));
  const [callTime, setCallTime] = useState("08:00");
  const [location, setLocation] = useState("");

  // Series, devotions and documentaries start in Development, in the five-stage workflow (src/config/workflow.ts).
  const workflowSeason = !!parent?.seriesType;
  const workflow = workflowSeason || (!parent && isWorkflowCategory(cat));
  const cfg = categoryOf(cat);
  const kind = parent ? childKindFor(parent) : null;
  const willUsePipeline = parent ? parent.hierarchyLevel + 1 === cfg.leafLevel : cfg.leafLevel === 0;
  const liveShow = !parent && cat === "live";
  const heading = parent ? `Add ${kind?.toLowerCase()} to ${parent.title}` : `New ${cfg.singular.toLowerCase()}`;
  const options = assigneeOptions();

  const saveWorkflow = () => {
    const project = attempt(
      () =>
        createWorkflowProject(actor, {
          category: cat as "series" | "devotional" | "documentary",
          title,
          seriesType: seriesType || null,
          seriesId: workflowSeason ? parent!.contentId : null,
          formType: cat === "documentary" ? docKind || null : null,
          deadline: deadline || null,
        }),
      "Created. It starts in Development.",
    );
    if (project) onCreated(project);
  };

  const saveProduction = () => {
    const show = attempt(
      () =>
        createProduction(actor, {
          title,
          mode,
          date: mode === "one_time" ? showStart || null : null,
          startDate: mode === "multi_day" ? showStart || null : null,
          endDate: mode === "multi_day" ? showEnd || null : null,
          rule: mode === "recurring" ? rule : null,
          productionLevel: level,
          assigneePersonId: assignee || null,
          callTime,
          location,
          notes,
        }),
      mode === "recurring" ? "Created, with its days for the next 12 weeks" : "Created, with a call sheet for each day",
    );
    if (show) onCreated(show);
  };

  const save = () => {
    if (workflow) return saveWorkflow();
    if (liveShow) return saveProduction();
    const input = {
      title,
      scheduledDate: scheduled || null,
      deadline: deadline || null,
      assigneePersonId: assignee || null,
      notes,
      productionLevel: cat === "live" ? level : null,
      showStart: null,
      showEnd: null,
    };
    const rec = attempt(
      () => (parent ? createChildRecord(actor, parent.contentId, input) : createRecord(actor, { ...input, category: cat })),
      "Created",
    );
    if (rec) onCreated(rec);
  };

  return (
    <Modal
      title={heading}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Create
          </button>
        </>
      }
    >
      <div className="stack">
        {!parent && (
          <Field label="Category">
            <select value={cat} onChange={(e) => setCat(e.target.value as CategoryKey)}>
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={workflowSeason ? "Season title (optional)" : cat === "series" && workflow ? "Series title" : "Title"}>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder={workflowSeason ? "Season 2" : parent ? `${kind} title` : "Project title"}
          />
        </Field>
        {workflow && (
          <>
            {cat === "series" && !workflowSeason && (
              <Field label="Kind of series">
                <select value={seriesType} onChange={(e) => setSeriesType(e.target.value as SeriesType | "")}>
                  <option value="">Choose…</option>
                  {SERIES_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {cat === "documentary" && (
              <Field label="Who is making it">
                <select value={docKind} onChange={(e) => setDocKind(e.target.value as FormType | "")}>
                  <option value="">Choose…</option>
                  {FORM_TYPES.filter((f) => f.category === "documentary").map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Publish date">
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </Field>
            <p className="muted">
              {cat === "series"
                ? "Each season is its own project. It starts in Development with its form, planned episodes and greenlight; episodes are made when recording sessions close."
                : cat === "devotional"
                  ? "One guest's five-day sharing: five episodes, Day 1 to Day 5, recorded in one session. It starts in Development."
                  : "One film, unless it is planned in several parts. It starts in Development."}
            </p>
          </>
        )}
        {!workflow && !parent && cfg.supportsChildren && !liveShow && (
          <p className="muted">
            {cfg.label} projects hold {cfg.childLevelLabel?.toLowerCase()}s and {cfg.grandchildLevelLabel?.toLowerCase()}s. The{" "}
            {cfg.grandchildLevelLabel?.toLowerCase()}s move through the pipeline.
          </p>
        )}
        {liveShow && (
          <>
            <fieldset className="mode-pick">
              <legend>How does it run?</legend>
              {(
                [
                  ["recurring", "Recurring show", "Friday Vespers, the weekly Sabbath service: a day for each date, from one template"],
                  ["one_time", "One-time event", "One day, with one call sheet"],
                  ["multi_day", "Multi-day event", "A camp meeting or conference: an Event Plan, and a day and call sheet for each date"],
                ] as const
              ).map(([key, label, hint]) => (
                <label key={key} className={`mode-card${mode === key ? " on" : ""}`}>
                  <input type="radio" name="mode" checked={mode === key} onChange={() => setMode(key)} />
                  <span>
                    <b>{label}</b>
                    <small>{hint}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            {mode === "one_time" && (
              <Field label="Date">
                <input type="date" aria-label="Date of the event" value={showStart} onChange={(e) => setShowStart(e.target.value)} />
              </Field>
            )}
            {mode === "multi_day" && (
              <div className="row">
                <Field label="First day">
                  <input type="date" aria-label="First day" value={showStart} onChange={(e) => setShowStart(e.target.value)} />
                </Field>
                <Field label="Last day">
                  <input type="date" aria-label="Last day" value={showEnd} onChange={(e) => setShowEnd(e.target.value)} />
                </Field>
              </div>
            )}
            {mode === "recurring" && <RuleEditor value={rule} onChange={setRule} />}
            <div className="row">
              <Field label="Crew call">
                <input type="time" aria-label="Crew call" value={callTime} onChange={(e) => setCallTime(e.target.value)} />
              </Field>
              <Field label="Location">
                <input
                  type="text"
                  aria-label="Location"
                  value={location}
                  placeholder="DOF Studio A"
                  onChange={(e) => setLocation(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Responsible person">
              <select aria-label="Responsible person" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {options.map((p) => (
                  <option key={p.personId} value={p.personId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className="muted">
              {mode === "recurring"
                ? "Its days are made 12 weeks ahead and kept topped up. Set its standard crew, gear, run of show and call sheet in its template once it is made."
                : "Each day is its own item, with its own pipeline and call sheet."}
            </p>
          </>
        )}

        {!workflow && !liveShow && (
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
        )}
        {!workflow && willUsePipeline && (
          <Field label="Responsible person">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {options.map((p) => (
                <option key={p.personId} value={p.personId}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {cat === "live" && (liveShow || willUsePipeline) && <LevelField value={level} onChange={setLevel} />}
        {!workflow && (
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        )}
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
  // A production's days come from its schedule or its Event Plan, not from these dates.
  const hasShowDates = record.hierarchyLevel === 0 && (record.category === "series" || record.category === "live") && !record.production;
  const carriesPipeline = !!record.pipelineStage;

  const save = () => {
    const ok = attempt(
      () =>
        updateRecord(
          actor,
          record.contentId,
          {
            title,
            scheduledDate: scheduled || null,
            deadline: deadline || null,
            assigneePersonId: assignee || null,
            notes,
            ...(record.category === "live" && carriesPipeline ? { productionLevel: level } : {}),
            ...(hasShowDates ? { showStart: showStart || null, showEnd: showEnd || null } : {}),
          },
          version,
        ),
      "Saved",
    );
    if (ok) onClose();
  };

  return (
    <Modal
      title={`Edit ${record.title}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save changes
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title">
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="row">
          {carriesPipeline && (
            <Field label={shootDateLabel(record.category)}>
              <input type="date" value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
            </Field>
          )}
          <Field label="Publish date">
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
        </div>
        {hasShowDates && (
          <div className="row">
            <Field label="Show starts">
              <input type="date" value={showStart} onChange={(e) => setShowStart(e.target.value)} />
            </Field>
            <Field label="Show ends">
              <input type="date" value={showEnd} onChange={(e) => setShowEnd(e.target.value)} />
            </Field>
          </div>
        )}
        {carriesPipeline && (
          <Field label="Responsible person">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {assigneeOptions().map((p) => (
                <option key={p.personId} value={p.personId}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {record.category === "live" && carriesPipeline && <LevelField value={level} onChange={setLevel} />}
        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
