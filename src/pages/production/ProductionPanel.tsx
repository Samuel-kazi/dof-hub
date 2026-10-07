import { useState } from "react";
import type { ContentRecord, RecordingSession, RecurrenceRule } from "../../types";
import { EVENT_PLAN_FIELDS, MODE_LABEL } from "../../config/callSheet";
import { describeRule } from "../../services/recurrence";
import { fmtDate, todayIso } from "../../services/utils";
import {
  addEventDay,
  canPlanEvent,
  dayTitle,
  daysOfEvent,
  getTemplate,
  offSchedule,
  productionOf,
  setShowSchedule,
  sheetOfDay,
  updateEventPlan,
  horizonEnd,
} from "../../services/wrapped/production";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { RuleEditor } from "./RuleEditor";
import { SavedText } from "./SheetSections";

// A live event's Show Days: how its days are made, and its days (each a session of the event, data version 23). A
// recurring show shows its schedule, its template and its days (coming, then past); a multi-day event its Event Plan
// and a tab for each day; a one-time event its day, and a way to add another. Every day opens its own call sheet and
// its own page, where it is run like any recording session.

export function ProductionPanel({ show }: { show: ContentRecord }) {
  const { actor } = useApp();
  const p = productionOf(show);
  if (!p) return null;
  const plan = canPlanEvent(actor, show) && !show.archived;
  const count = daysOfEvent(show.contentId).length;
  return (
    <section className="glass panel prod-panel" aria-label="Show Days">
      <div className="wf-head">
        <h2>{MODE_LABEL[p.mode]}</h2>
        <span className="badge accent">
          {count} day{count === 1 ? "" : "s"}
        </span>
      </div>
      {p.mode === "recurring" ? <Recurring show={show} plan={plan} /> : <MultiDay show={show} plan={plan} />}
    </section>
  );
}

function Recurring({ show, plan }: { show: ContentRecord; plan: boolean }) {
  const { actor, attempt, go, toast } = useApp();
  const t = show.production?.templateId ? getTemplate(show.production.templateId) : undefined;
  const [editing, setEditing] = useState<RecurrenceRule | null>(null);
  const [past, setPast] = useState(false);
  if (!t) return <Empty>This show's template is missing.</Empty>;
  const today = todayIso();
  const days = daysOfEvent(show.contentId);
  const coming = days.filter((d) => (d.scheduledDate ?? "") >= today);
  const gone = days.filter((d) => (d.scheduledDate ?? "") < today).reverse();
  const save = () => {
    const r = attempt(() => setShowSchedule(actor, t.id, editing!));
    if (!r) return;
    setEditing(null);
    const bits = [
      r.made.length && `${r.made.length} days made`,
      r.restored.length && `${r.restored.length} brought back`,
      r.removed.length && `${r.removed.length} taken off`,
      r.kept.length && `${r.kept.length} off the schedule but kept, as they were changed or worked on`,
    ].filter(Boolean);
    toast(bits.length ? `Schedule saved: ${bits.join(", ")}.` : "Schedule saved.", "success");
  };
  return (
    <div className="stack">
      <div className="prod-rule">
        <span className="grow">
          <b>{describeRule(t.rule, fmtDate)}.</b> Days are made{" "}
          {t.horizonCount ? `for the next ${t.horizonCount} dates` : `${t.horizonWeeks} weeks ahead`}, up to {fmtDate(horizonEnd(t, today))}
          , and topped up every day.
        </span>
        <button className="btn small primary" onClick={() => go({ n: "template", id: t.id })}>
          Open the template
        </button>
        {plan && !editing && (
          <button className="btn small" onClick={() => setEditing(structuredClone(t.rule))}>
            Change the schedule
          </button>
        )}
      </div>
      {editing && (
        <div className="prod-edit">
          <RuleEditor value={editing} onChange={setEditing} />
          <p className="muted">
            Coming days the new schedule no longer gives are taken off (archived, never deleted), unless they were changed by hand or work
            has started on them; those stay, marked off the schedule.
          </p>
          <div className="row">
            <button className="btn primary" onClick={save}>
              Save the schedule
            </button>
            <button className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <h3>Coming days</h3>
      <DayList show={show} days={coming} empty="No coming days. Check the schedule's end." />
      {gone.length > 0 && (
        <>
          <button className="btn small ghost" onClick={() => setPast(!past)} aria-expanded={past}>
            {past ? "Hide" : "Show"} past days ({gone.length})
          </button>
          {past && <DayList show={show} days={gone} />}
        </>
      )}
    </div>
  );
}

/** Days of an event, each with its call sheet's state, whether it follows the template, and the way to its sheet. */
function DayList({ show, days, empty = "No days yet." }: { show: ContentRecord; days: RecordingSession[]; empty?: string }) {
  const { go } = useApp();
  if (!days.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="prod-days">
      {days.map((d) => {
        const cs = sheetOfDay(d);
        return (
          <li key={d.id}>
            <span className="grow">
              <b>{dayTitle(d)}</b>
              {d.scheduledDate && dayTitle(d).indexOf(fmtDate(d.scheduledDate)) < 0 && (
                <span className="muted"> · {fmtDate(d.scheduledDate)}</span>
              )}{" "}
              <span className="cid">{d.id}</span>
              {d.status !== "Planned" && <span className="badge"> {d.status === "Open" ? "On air" : "Closed"}</span>}
            </span>
            <span className="prod-badges">
              {cs ? (
                <span className={`badge ${cs.status === "final" ? "ok" : ""}`}>{cs.status === "final" ? "Final" : "Draft"}</span>
              ) : (
                <span className="badge warn">No call sheet</span>
              )}
              {d.instance &&
                (d.instance.locked ? (
                  <span className="badge warn">Changed by hand</span>
                ) : (
                  <span className="badge">Follows the template</span>
                ))}
              {offSchedule(d) && <span className="badge bad">Off the schedule</span>}
            </span>
            {cs && (
              <button className="btn small" onClick={() => go({ n: "callsheet", id: cs.id })}>
                Call sheet
              </button>
            )}
            <button className="btn small ghost" onClick={() => go({ n: "session", id: d.id })}>
              Open the day
            </button>
          </li>
        );
      })}
      {show.archived && <li className="muted">This event is closed.</li>}
    </ul>
  );
}

function MultiDay({ show, plan }: { show: ContentRecord; plan: boolean }) {
  const { actor, attempt, go } = useApp();
  const days = daysOfEvent(show.contentId);
  const [tab, setTab] = useState<string | null>(days[0]?.id ?? null);
  const [date, setDate] = useState("");
  const ep = show.production?.eventPlan;
  const day = days.find((d) => d.id === tab) ?? days[0];
  const cs = day ? sheetOfDay(day) : undefined;
  return (
    <div className="stack">
      <details className="prod-plan" open={!ep?.overview}>
        <summary>
          <b>Event Plan</b>
          {ep?.overview ? <span className="muted"> · {ep.overview.slice(0, 80)}</span> : null}
        </summary>
        <div className="cs-grid wide">
          {EVENT_PLAN_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              <SavedText
                label={f.label}
                value={ep?.[f.key] ?? ""}
                placeholder={f.hint}
                disabled={!plan}
                rows={2}
                onSave={(v) => attempt(() => updateEventPlan(actor, show.contentId, { [f.key]: v.trim() }), "Event Plan saved")}
              />
            </Field>
          ))}
        </div>
      </details>
      <div className="rp-tabs" role="tablist" aria-label="Days">
        {days.map((d) => (
          <button
            key={d.id}
            role="tab"
            aria-selected={d.id === day?.id}
            className={d.id === day?.id ? "on" : ""}
            onClick={() => setTab(d.id)}
          >
            {dayTitle(d)}
            {d.scheduledDate && <span className="muted"> · {fmtDate(d.scheduledDate)}</span>}
          </button>
        ))}
      </div>
      {day ? (
        <div className="prod-day" role="tabpanel" aria-label={dayTitle(day)}>
          <div className="cs-grid wide">
            <div>
              <small className="muted">Date</small>
              <div>{day.scheduledDate ? fmtDate(day.scheduledDate) : "No date"}</div>
            </div>
            <div>
              <small className="muted">Call sheet</small>
              <div>{cs ? `${cs.status === "final" ? "Final" : "Draft"}, crew call ${cs.callTime || "not set"}` : "None yet"}</div>
            </div>
            <div>
              <small className="muted">Location</small>
              <div>{cs?.location || "Not set"}</div>
            </div>
            <div>
              <small className="muted">Crew and talent</small>
              <div>{cs ? `${cs.crewPersonIds.length} crew, ${cs.talent.length} talent` : "—"}</div>
            </div>
          </div>
          <div className="prod-actions">
            {cs && (
              <button className="btn primary small" onClick={() => go({ n: "callsheet", id: cs.id })}>
                Open the call sheet
              </button>
            )}
            <button className="btn small" onClick={() => go({ n: "session", id: day.id })}>
              Open the day
            </button>
          </div>
        </div>
      ) : (
        <Empty>No days yet.</Empty>
      )}
      {plan && (
        <div className="row cs-add">
          <Field label="Add a day">
            <input type="date" aria-label="Date of the new day" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div style={{ flex: "none" }}>
            <button
              className="btn"
              disabled={!date}
              onClick={() => {
                const d = attempt(() => addEventDay(actor, show.contentId, date), "Day added, its call sheet copied from the day before");
                if (d) {
                  setDate("");
                  setTab(d.id);
                }
              }}
            >
              + Add day
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
