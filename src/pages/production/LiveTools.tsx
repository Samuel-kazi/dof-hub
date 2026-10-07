import { useEffect, useState, type ReactNode } from "react";
import type { CallSheet, CheckItem, CheckState, RehearsalStep, RunItem } from "../../types";
import { CHECK_STATES, LIGHT_STATES, LIVE_LIGHTS, REHEARSAL_STEPS, blankStep, checkStateOf } from "../../config/callSheet";
import { getDb, useDb } from "../../data/store";
import { localId } from "../../data/ids";
import { canView, canWrite, getRecord } from "../../services/access";
import { updateCallSheet } from "../../services/wrapped/callsheets";
import {
  advanceRundown,
  copyRundownToDays,
  copyTechCheckFromPrevious,
  gearNotReturned,
  liveNow,
  previousTechSheet,
  rundownOf,
  setLiveLight,
  setRundown,
  techCounts,
} from "../../services/wrapped/live";
import { canPlanEvent, dayTitle, productionOf, sheetOfDay } from "../../services/wrapped/production";
import { nameOf } from "../../services/wrapped/people";
import { sheetLock } from "../../services/sheetLock";
import { TIME_ZONE, fmtDate, timeInNairobi } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { CrewSelect } from "../../ui/workflow/shared";
import { SavedInput } from "../documents/toolkit";
import { SessionPicker, defaultSession } from "../documents/StagePanes";
import type { Project } from "../../services/wrapped/workflow";

// A live show's own tools (build prompt v4, section 9): the Tech Check and the Rehearsal Log of each day (both kept on
// the day's call sheet, so the sheet and the tiles show the same thing), the Broadcast Plan's Rundown, Live Control on
// the night, and the flag for gear not brought back after a show.

/** Whether a day's sheet can be changed: its lines (the plan), and its ticks, states and notes (work on the day). */
function useSheetAccess(cs: CallSheet): { editable: boolean } {
  const { actor } = useApp();
  const root = getRecord(cs.contentId);
  return { editable: !!root && canWrite(actor, root) && !root.archived && !sheetLock(cs).locked };
}

// ── The Tech Check ───────────────────────────────────────────

const STATE_CLASS: Record<CheckState, string> = { "Not checked": "", OK: "ok", Issue: "bad" };

/** A day's Tech Check: each line with who checks it, how it stands, the inventory item, the test result and notes. */
export function TechCheckTable({ cs }: { cs: CallSheet }) {
  const { actor, attempt, confirm, toast } = useApp();
  const { editable } = useSheetAccess(cs);
  const [label, setLabel] = useState("");
  const rows = cs.technicalCheck;
  const gear = getDb()
    .equipment.filter((e) => e.baseStatus === "active")
    .sort((a, b) => a.name.localeCompare(b.name));
  const save = (next: CheckItem[], ok?: string) => attempt(() => updateCallSheet(actor, cs.id, { technicalCheck: next }, cs.version), ok);
  const update = (id: string, patch: Partial<CheckItem>) => save(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const counts = techCounts(cs);
  const prev = previousTechSheet(cs.id);
  return (
    <div className="stack" aria-label="Tech Check">
      <div className="wf-chips">
        <span className={`badge ${counts.issue ? "bad" : counts.notChecked ? "" : "ok"}`}>
          {counts.ok} OK · {counts.issue} issue{counts.issue === 1 ? "" : "s"} · {counts.notChecked} not checked
        </span>
        {editable && prev && (
          <button
            className="btn small"
            onClick={async () => {
              const touched = rows.some((r) => checkStateOf(r) !== "Not checked" || r.result || r.note);
              if (
                touched &&
                !(await confirm({
                  title: "Copy the previous show's Tech Check?",
                  body: `This day's list is replaced by the one from ${prev.title} (${fmtDate(prev.date)}), each line Not checked.`,
                  confirmLabel: "Replace",
                }))
              )
                return;
              const r = attempt(() => copyTechCheckFromPrevious(actor, cs.id));
              if (r) toast(`${r.lines} lines copied from ${prev.title}.`, "success");
            }}
          >
            Copy from the previous show
          </button>
        )}
        {counts.issue > 0 && <span className="muted">Issues are warnings: they never stop the show.</span>}
      </div>
      {rows.length === 0 ? (
        <Empty>No checks listed yet.</Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table wf-table lv-check">
            <thead>
              <tr>
                <th>Check</th>
                <th>Who checks it</th>
                <th>State</th>
                <th>Equipment</th>
                <th>Test result</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const state = checkStateOf(c);
                return (
                  <tr key={c.id} className={state === "Issue" ? "lv-issue" : undefined}>
                    <td>
                      <SavedInput
                        aria-label="Check"
                        value={c.label}
                        disabled={!editable}
                        onSave={(v) => v.trim() && update(c.id, { label: v.trim() })}
                      />
                    </td>
                    <td>
                      <CrewSelect
                        label={`Who checks ${c.label}`}
                        value={c.assigneeId ?? null}
                        disabled={!editable}
                        onChange={(p) => update(c.id, { assigneeId: p })}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`State of ${c.label}`}
                        className={`lv-state ${STATE_CLASS[state]}`}
                        value={state}
                        disabled={!editable}
                        onChange={(e) => update(c.id, { state: e.target.value as CheckState })}
                      >
                        {CHECK_STATES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Equipment for ${c.label}`}
                        value={c.equipmentId ?? ""}
                        disabled={!editable}
                        onChange={(e) => update(c.id, { equipmentId: e.target.value || null })}
                      >
                        <option value="">Not linked</option>
                        {c.equipmentId && !gear.some((g) => g.id === c.equipmentId) && (
                          <option value={c.equipmentId}>{c.equipmentId} (not active)</option>
                        )}
                        {gear.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                            {g.unitLabel ? ` (${g.unitLabel})` : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <SavedInput
                        aria-label={`Test result for ${c.label}`}
                        value={c.result ?? ""}
                        placeholder="Result"
                        disabled={!editable}
                        onSave={(v) => update(c.id, { result: v.trim() })}
                      />
                    </td>
                    <td>
                      <SavedInput
                        aria-label={`Note on ${c.label}`}
                        value={c.note}
                        placeholder="Note"
                        disabled={!editable}
                        onSave={(v) => update(c.id, { note: v.trim() })}
                      />
                    </td>
                    <td>
                      {editable && (
                        <button
                          className="btn small ghost"
                          aria-label={`Remove ${c.label}`}
                          onClick={() => save(rows.filter((r) => r.id !== c.id))}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <div className="row" style={{ alignItems: "end" }}>
          <Field label="Add a check">
            <input type="text" value={label} placeholder="Confidence monitor" onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <div style={{ flex: "none" }}>
            <button
              className="btn"
              disabled={!label.trim()}
              onClick={() => {
                const line: CheckItem = {
                  id: localId("TC"),
                  label: label.trim(),
                  done: false,
                  note: "",
                  state: "Not checked",
                  assigneeId: null,
                  equipmentId: null,
                  result: "",
                };
                if (save([...rows, line])) setLabel("");
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── The Rehearsal Log ────────────────────────────────────────

/** A day's Rehearsal Log: each step, when it was checked, by whom, and notes. Never a gate. */
export function RehearsalSteps({ cs }: { cs: CallSheet }) {
  const { actor, attempt } = useApp();
  const { editable } = useSheetAccess(cs);
  const [step, setStep] = useState("");
  const steps = cs.rehearsal.steps;
  const save = (next: RehearsalStep[]) =>
    attempt(() => updateCallSheet(actor, cs.id, { rehearsal: { ...cs.rehearsal, steps: next } }, cs.version));
  const update = (id: string, patch: Partial<RehearsalStep>) => save((steps ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)));
  if (!steps)
    return (
      <div className="stack" aria-label="Rehearsal Log">
        <Empty>No rehearsal steps on this day yet.</Empty>
        {editable && (
          <div>
            <button className="btn" onClick={() => save(REHEARSAL_STEPS.map((s) => blankStep(localId("RH"), s)))}>
              Use the usual steps
            </button>
          </div>
        )}
      </div>
    );
  const done = steps.filter((x) => x.done).length;
  return (
    <div className="stack" aria-label="Rehearsal Log">
      <div className="wf-chips">
        <span className={`badge ${done === steps.length && steps.length ? "ok" : ""}`}>
          {done} of {steps.length} steps checked
        </span>
        <span className="muted">The Rehearsal Log is a record of the day, never a gate.</span>
      </div>
      <div className="wf-scroll">
        <table className="table wf-table">
          <thead>
            <tr>
              <th>Done</th>
              <th>Step</th>
              <th>Time checked</th>
              <th>Person</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {steps.map((r) => (
              <tr key={r.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Done: ${r.step}`}
                    checked={r.done}
                    disabled={!editable}
                    onChange={(e) =>
                      update(r.id, { done: e.target.checked, ...(e.target.checked && !r.time ? { time: timeInNairobi(new Date()) } : {}) })
                    }
                  />
                </td>
                <td>
                  <SavedInput
                    aria-label="Step"
                    value={r.step}
                    disabled={!editable}
                    onSave={(v) => v.trim() && update(r.id, { step: v.trim() })}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    aria-label={`Time ${r.step} was checked`}
                    value={r.time}
                    disabled={!editable}
                    onChange={(e) => update(r.id, { time: e.target.value })}
                  />
                </td>
                <td>
                  <CrewSelect
                    label={`Who checked ${r.step}`}
                    value={r.personId}
                    disabled={!editable}
                    onChange={(p) => update(r.id, { personId: p })}
                  />
                </td>
                <td>
                  <SavedInput
                    aria-label={`Notes on ${r.step}`}
                    value={r.notes}
                    placeholder="Notes"
                    disabled={!editable}
                    onSave={(v) => update(r.id, { notes: v.trim() })}
                  />
                </td>
                <td>
                  {editable && (
                    <button
                      className="btn small ghost"
                      aria-label={`Remove ${r.step}`}
                      onClick={() => save(steps.filter((x) => x.id !== r.id))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="row" style={{ alignItems: "end" }}>
          <Field label="Add a step">
            <input type="text" value={step} placeholder="Stage manager walk-through" onChange={(e) => setStep(e.target.value)} />
          </Field>
          <div style={{ flex: "none" }}>
            <button
              className="btn"
              disabled={!step.trim()}
              onClick={() => save([...steps, blankStep(localId("RH"), step.trim())]) && setStep("")}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A tile that shows one of a day's tools: the day is chosen above it. */
function DayTool({ project, title, render }: { project: Project; title: string; render: (cs: CallSheet) => ReactNode }) {
  useDb();
  const [dayId, setDayId] = useState<string | null>(() => defaultSession(project.contentId));
  const day = dayId ? getDb().recordingSessions.find((s) => s.id === dayId) : undefined;
  const cs = day ? sheetOfDay(day) : undefined;
  return (
    <div className="stack">
      <h2>{title}</h2>
      {!dayId ? (
        <Empty>No show days yet. They are set in Development, under Show Days.</Empty>
      ) : (
        <>
          <SessionPicker project={project} value={dayId} onChange={setDayId} />
          {cs ? render(cs) : <Empty>This day has no call sheet yet: make it from the day&apos;s page.</Empty>}
        </>
      )}
    </div>
  );
}

export const TechCheckPane = ({ project }: { project: Project }) => (
  <DayTool project={project} title="Tech Check" render={(cs) => <TechCheckTable cs={cs} />} />
);
export const RehearsalLogPane = ({ project }: { project: Project }) => (
  <DayTool project={project} title="Rehearsal Log" render={(cs) => <RehearsalSteps cs={cs} />} />
);

// ── The Broadcast Plan's Rundown ─────────────────────────────

/** The segments every day of the show starts from: time, length, camera, audio, graphics and notes. */
export function RundownSection({ project }: { project: Project }) {
  useDb();
  const { actor, attempt, confirm, toast } = useApp();
  const rows = rundownOf(project.contentId);
  const recurring = productionOf(project)?.mode === "recurring";
  const editable = canPlanEvent(actor, project) && !project.archived;
  const save = (next: RunItem[]) => attempt(() => setRundown(actor, project.contentId, next));
  const update = (id: string, patch: Partial<RunItem>) => save(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const total = rows.reduce((n, r) => n + r.durationMin, 0);
  const last = [...rows].sort((a, b) => a.time.localeCompare(b.time)).pop();
  return (
    <div className="stack" aria-label="Rundown">
      <h2>Rundown</h2>
      <p className="muted">
        {recurring
          ? "The show's standard segments: every coming day still following the show's template takes a change at once."
          : "The segments every day of the show starts from. Copy them to the days, then change a day on its own run of show."}
      </p>
      {rows.length === 0 ? (
        <Empty>No segments yet.</Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table wf-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Segment</th>
                <th>Minutes</th>
                <th>Camera</th>
                <th>Audio</th>
                <th>Graphics</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...rows]
                .sort((a, b) => a.time.localeCompare(b.time))
                .map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="time"
                        aria-label="Start"
                        value={r.time}
                        disabled={!editable}
                        onChange={(e) => e.target.value && update(r.id, { time: e.target.value })}
                      />
                    </td>
                    <td>
                      <SavedInput
                        aria-label="Segment"
                        value={r.title}
                        disabled={!editable}
                        onSave={(v) => v.trim() && update(r.id, { title: v.trim() })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        aria-label="Minutes"
                        min={0}
                        max={600}
                        value={r.durationMin}
                        disabled={!editable}
                        onChange={(e) => update(r.id, { durationMin: Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0))) })}
                      />
                    </td>
                    {(["camera", "audio", "graphics"] as const).map((k) => (
                      <td key={k}>
                        <SavedInput
                          aria-label={k[0].toUpperCase() + k.slice(1)}
                          value={r[k] ?? ""}
                          disabled={!editable}
                          onSave={(v) => update(r.id, { [k]: v.trim() })}
                        />
                      </td>
                    ))}
                    <td>
                      <SavedInput
                        aria-label="Notes"
                        value={r.notes}
                        disabled={!editable}
                        onSave={(v) => update(r.id, { notes: v.trim() })}
                      />
                    </td>
                    <td>
                      {editable && (
                        <button
                          className="btn small ghost"
                          aria-label={`Remove ${r.title}`}
                          onClick={() => save(rows.filter((x) => x.id !== r.id))}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="wf-chips">
        {rows.length > 0 && <span className="muted">{total} minutes in all</span>}
        {editable && (
          <button
            className="btn small"
            onClick={() =>
              save([
                ...rows,
                {
                  id: localId("RS"),
                  time: last ? endOf(last.time, last.durationMin) : "18:00",
                  title: "New segment",
                  durationMin: 10,
                  ownerPersonId: null,
                  notes: "",
                  camera: "",
                  audio: "",
                  graphics: "",
                  status: "Planned",
                },
              ])
            }
          >
            + Segment
          </button>
        )}
        {editable && !recurring && rows.length > 0 && (
          <>
            <button
              className="btn small primary"
              onClick={() => {
                const r = attempt(() => copyRundownToDays(actor, project.contentId, false));
                if (r)
                  toast(
                    `${r.copied.length} day${r.copied.length === 1 ? "" : "s"} took the Rundown; ${r.kept.length} kept their own.`,
                    "success",
                  );
              }}
            >
              Copy to days with no run of show
            </button>
            <button
              className="btn small"
              onClick={async () => {
                if (
                  !(await confirm({
                    title: "Replace every coming day's run of show?",
                    body: "Every day still in Pre-production whose call sheet is not published takes the Rundown, in place of its own run of show.",
                    confirmLabel: "Replace",
                    danger: true,
                  }))
                )
                  return;
                const r = attempt(() => copyRundownToDays(actor, project.contentId, true));
                if (r)
                  toast(
                    `${r.copied.length} day${r.copied.length === 1 ? "" : "s"} took the Rundown; ${r.kept.length} kept their own.`,
                    "success",
                  );
              }}
            >
              Replace on every coming day…
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function endOf(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const t = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// ── Gear not returned ────────────────────────────────────────

/** A day whose show is over with gear still checked out: flagged on its call sheet (build prompt v4, section 9). */
export function NotReturnedBanner({ sheetId }: { sheetId: string }) {
  const { go } = useApp();
  const n = gearNotReturned(sheetId);
  if (!n) return null;
  return (
    <div className="banner bad" role="alert" aria-label="Gear not returned">
      <span className="grow">
        <b>Gear not returned.</b> {n.items} item{n.items === 1 ? "" : "s"} checked out for this day {n.items === 1 ? "was" : "were"} due
        back {fmtDate(n.due)}
        {n.responsiblePersonId ? `, with ${nameOf(n.responsiblePersonId)}` : ""}.
      </span>
      <button className="btn small" onClick={() => go({ n: "manifest", id: n.manifestId })}>
        Open the checkout
      </button>
    </div>
  );
}

// ── Live Control ─────────────────────────────────────────────

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="lv-clock" aria-label="Time now">
      {clock.format(now)}
    </div>
  );
}

function Segment({ label, row, big }: { label: string; row: RunItem | null; big?: boolean }) {
  return (
    <div className={`lv-seg${big ? " big" : ""}${row ? "" : " none"}`} aria-label={label}>
      <span className="lv-seg-label">{label}</span>
      {row ? (
        <>
          <span className="lv-seg-title">{row.title}</span>
          <span className="lv-seg-meta">
            {row.time} · {row.durationMin} min
            {row.actualStart ? ` · on air since ${row.actualStart}` : ""}
          </span>
          {(row.camera || row.audio || row.graphics) && (
            <span className="lv-seg-meta">
              {[row.camera && `Camera: ${row.camera}`, row.audio && `Audio: ${row.audio}`, row.graphics && `Graphics: ${row.graphics}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </>
      ) : (
        <span className="lv-seg-title muted">Nothing</span>
      )}
    </div>
  );
}

/** A live day on the night: the clock, the segment on air, next and up next, moved on by hand, and status lights. */
export function LiveControl({ sessionId }: { sessionId: string }) {
  useDb();
  const { actor, attempt, go } = useApp();
  const day = getDb().recordingSessions.find((s) => s.id === sessionId);
  const cs = day ? sheetOfDay(day) : undefined;
  if (!day || !cs) return <Empty>This day has no call sheet, so no run of show to follow.</Empty>;
  const root = getRecord(day.contentId);
  const write = !!root && canWrite(actor, root) && !root.archived && !day.archivedAt;
  const editable = write && !sheetLock(cs).locked;
  const now = liveNow(cs);
  const lights = day.liveLights ?? {};
  return (
    <div className="lv-control" aria-label="Live Control">
      <div className="lv-top">
        <Clock />
        <div className="lv-progress">
          {now.done} of {now.total} segments done
          <button className="btn small ghost" onClick={() => go({ n: "callsheet", id: cs.id })}>
            Run of show
          </button>
        </div>
      </div>
      {now.total === 0 ? (
        <Empty>The run of show is empty: add its segments on the call sheet, or copy the Rundown to the days.</Empty>
      ) : (
        <div className="lv-segs">
          <Segment label="On air" row={now.current} big />
          <Segment label="Next" row={now.next} />
          <Segment label="Up next" row={now.upNext} />
        </div>
      )}
      {editable && now.total > 0 && (
        <div className="lv-move">
          <button
            className="btn"
            disabled={!now.current && now.done === 0}
            onClick={() => attempt(() => advanceRundown(actor, cs.id, "back"))}
          >
            ◀ Back
          </button>
          <button
            className="btn primary lv-next"
            disabled={!now.next && !now.current}
            onClick={() => attempt(() => advanceRundown(actor, cs.id, "next"))}
          >
            {now.current ? (now.next ? "Next segment ▶" : "End the last segment ■") : "Start the show ▶"}
          </button>
        </div>
      )}
      <div className="lv-lights" role="group" aria-label="Status lights">
        {LIVE_LIGHTS.map((l) => {
          const state = lights[l.key] ?? "off";
          return (
            <div key={l.key} className={`lv-light ${state}`}>
              <span className="lv-dot" aria-hidden="true" />
              <span className="lv-light-name">{l.label}</span>
              <span className="lv-light-pick" role="radiogroup" aria-label={l.label}>
                {LIGHT_STATES.map((s) => (
                  <button
                    key={s.key}
                    role="radio"
                    aria-checked={state === s.key}
                    className={`lv-pick ${s.key}${state === s.key ? " on" : ""}`}
                    disabled={!write}
                    onClick={() => state !== s.key && attempt(() => setLiveLight(actor, day.id, l.key, s.key))}
                  >
                    {s.label}
                  </button>
                ))}
              </span>
            </div>
          );
        })}
      </div>
      {day.liveLightsAt && (
        <p className="muted">
          Lights last set by {nameOf(day.liveLightsBy ?? null)} at {timeInNairobi(new Date(day.liveLightsAt))}.
        </p>
      )}
    </div>
  );
}

/** The Live Control tile: the day is chosen above it, and it opens on its own page for the night. */
export function LiveControlPane({ project }: { project: Project }) {
  useDb();
  const { go } = useApp();
  const [dayId, setDayId] = useState<string | null>(() => defaultSession(project.contentId));
  return (
    <div className="stack">
      <h2>Live Control</h2>
      {!dayId ? (
        <Empty>No show days yet.</Empty>
      ) : (
        <>
          <div className="row" style={{ alignItems: "end" }}>
            <SessionPicker project={project} value={dayId} onChange={setDayId} />
            <button className="btn" style={{ flex: "none" }} onClick={() => go({ n: "livecontrol", id: dayId })}>
              Open on its own page
            </button>
          </div>
          <LiveControl sessionId={dayId} />
        </>
      )}
    </div>
  );
}

/** Live Control on its own page, for the screen in the control room. */
export function LiveControlPage({ id }: { id: string }) {
  useDb();
  const { actor, go } = useApp();
  const day = getDb().recordingSessions.find((s) => s.id === id);
  const root = day ? getRecord(day.contentId) : undefined;
  if (!day || !root || root.category !== "live" || !canView(actor, root))
    return (
      <div className="page">
        <Empty>This day does not exist, or is not part of a live show you are attached to.</Empty>
      </div>
    );
  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => go({ n: "record", id: root.contentId })}>{root.title}</button>
        <span aria-hidden> / </span>
        <button onClick={() => go({ n: "session", id: day.id })}>{dayTitle(day)}</button>
        <span aria-hidden> / </span>
        <span>Live Control</span>
      </nav>
      <div className="page-head">
        <div className="grow">
          <h1>Live Control: {root.title}</h1>
          <div className="wf-chips" style={{ marginTop: 4 }}>
            <span className="cid">{day.id}</span>
            {day.scheduledDate && <span className="muted">{fmtDate(day.scheduledDate)}</span>}
          </div>
        </div>
      </div>
      <LiveControl sessionId={day.id} />
    </div>
  );
}
