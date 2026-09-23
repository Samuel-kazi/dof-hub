import { useState } from "react";
import type { ContentRecord, StageLink } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb } from "../data/store";
import { categoryOf, finalStageOf } from "../config/categories";
import { Empty, Field } from "../ui/parts";
import { Modal } from "../ui/Modal";
import { IconPlus } from "../ui/Icons";
import { canJoin, canWrite, isHop } from "../services/access";
import { can } from "../services/wrapped/permissions";
import { PROJECT_STAGE, addLinks, addStageOwner, addTask, approveDevotionalReview, approveGuestReview, closeDevotional, ownersOf, removeLink, removeStageOwner, removeTask, sendBackDevotionalToEditing, setDevotionalReadyForReview, setOwnerRoles, setPostProductionNeeded, setStageDeadline, setStrikePlan, spinOffsOf, splitRecording, tasksOf, updateTask, usesPipeline } from "../services/wrapped/content";
import { teamOf } from "../services/wrapped/team";
import { effortFor } from "../config/capacity";
import { RolePicker } from "../ui/RolePicker";
import { fmtDays, freeDaysBefore, overloadWarning } from "../services/workload";
import { nameOf } from "../services/wrapped/people";
import { docsForRecord } from "../services/wrapped/docs";
import { fmtDateTime, fmtShort } from "../services/utils";

const crew = () => getDb().people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"));

/**
 * Who does what, and when. Every stage lists its owners, and each owner has the roles they do there.
 * The Head of Production adds anyone. Crew on the project can add themselves and change their own roles.
 * On a show or season (no stages of its own) the same table holds the people who work across the whole project.
 */
export function StagePlan({ rec }: { rec: ContentRecord }) {
  const { actor, attempt, toast } = useApp();
  const cfg = categoryOf(rec.category);
  const write = canWrite(actor, rec);
  const join = !write && canJoin(actor, rec);
  const hop = can(actor, "pipeline.assign");
  const leaf = usesPipeline(rec);
  const idx = cfg.stages.findIndex((s) => s.name === rec.pipelineStage);
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ stage: string; personId: string } | null>(null);
  const rows = leaf ? cfg.stages.map((s) => s.name) : [PROJECT_STAGE];
  const team = teamOf(rec);

  const warn = (personId: string) => { const msg = overloadWarning(personId); if (msg) toast(msg, "info"); };
  const mayChange = (personId: string) => hop || ((write || join) && personId === actor.personId);

  return (
    <section className="glass panel" aria-label="Who does what">
      <h2>Who does what, and when</h2>
      {join && !hop && <div className="banner" style={{ marginBottom: 12 }}><span className="grow">You can see this project but you are not on it. Choose <b>Jump in</b> on a stage to help. You will be added to the project and can work on it.</span></div>}
      <table className="table">
        <thead><tr><th style={{ width: 170 }}>{leaf ? "Stage" : "Whole project"}</th><th>People and their roles</th><th style={{ width: 190 }}>{leaf ? "Due" : "When"}</th></tr></thead>
        <tbody>
          {rows.map((stage) => {
            const i = leaf ? cfg.stages.findIndex((s) => s.name === stage) : -1;
            const list = ownersOf(rec, stage);
            const iAmOn = list.some((o) => o.personId === actor.personId);
            return (
              <tr key={stage}>
                <td>
                  <span style={{ fontWeight: leaf && i === idx ? 600 : 400 }}>{leaf ? stage : "People across the project"}</span>
                  {leaf && i < idx && <span className="badge ok" style={{ marginLeft: 8 }}>Done</span>}
                  {leaf && i === idx && <span className="badge accent" style={{ marginLeft: 8 }}>Now</span>}
                </td>
                <td>
                  <div className="stack" style={{ gap: 6 }}>
                    {list.length === 0 && <span className="muted">No one yet</span>}
                    {list.map((o, n) => (
                      <div key={o.personId} className="owner-row">
                        <div className="grow">
                          <b>{nameOf(o.personId)}</b>
                          {leaf && n === 0 && i === idx && list.length > 1 && <span className="badge" style={{ marginLeft: 6 }}>Lead</span>}
                          <div className="chips" style={{ marginTop: 3 }}>{o.roles.length ? o.roles.map((r) => <span key={r} className="badge accent">{r}</span>) : <span className="muted" style={{ fontSize: ".84rem" }}>No role set</span>}</div>
                        </div>
                        {mayChange(o.personId) && <button className="btn small ghost" onClick={() => setEditing({ stage, personId: o.personId })}>Roles</button>}
                        {mayChange(o.personId) && <button className="btn small ghost" aria-label={`Remove ${nameOf(o.personId)} from ${stage}`} onClick={() => attempt(() => removeStageOwner(actor, rec.contentId, stage, o.personId), "Removed")}>Remove</button>}
                      </div>
                    ))}
                    {(write || join || hop) && (hop || !iAmOn) && <div><button className="btn small" onClick={() => setAdding(stage)}><IconPlus /> {hop ? "Add a person" : join ? "Jump in" : "Add me"}</button></div>}
                  </div>
                </td>
                <td>
                  {leaf ? (
                    <input type="date" value={rec.stageDeadlines[stage] ?? ""} disabled={!write} aria-label={`Deadline for ${stage}`} onChange={(e) => e.target.value && attempt(() => setStageDeadline(actor, rec.contentId, stage, e.target.value, rec.version))} />
                  ) : (
                    <span className="muted">{rec.showStart ? `Show runs ${fmtShort(rec.showStart)}${rec.showEnd && rec.showEnd !== rec.showStart ? ` to ${fmtShort(rec.showEnd)}` : ""}` : rec.deadline ? `Publish ${fmtShort(rec.deadline)}` : "No dates set"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {team.length > 0 && (
        <p className="muted" style={{ marginTop: 12, fontSize: ".86rem" }}>
          <b style={{ color: "var(--ink-2)" }}>On this project:</b> {team.map((t) => `${t.person.name}${t.roles.length ? ` (${t.roles.join(", ")})` : ""}`).join("; ")}.
        </p>
      )}
      <p className="muted" style={{ marginTop: 8, fontSize: ".84rem" }}>
        {hop ? "Add as many people as a stage needs, and give each their roles. The first person on the current stage is the one responsible, and adding someone gives them access to the project. Volunteers and partners are attached from the People page." : write || join ? "You can add yourself to a stage and choose your roles. The Head of Production assigns everyone else." : "Only the Head of Production and crew on this project can change who does what."}
      </p>
      {adding && <AddOwnerModal rec={rec} stage={adding} onClose={() => setAdding(null)} onAdded={warn} />}
      {editing && <OwnerRolesModal rec={rec} stage={editing.stage} personId={editing.personId} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** Adds someone to a stage. It shows how much time each person has before the stage is due. */
function AddOwnerModal({ rec, stage, onClose, onAdded }: { rec: ContentRecord; stage: string; onClose: () => void; onAdded: (personId: string) => void }) {
  const { actor, attempt } = useApp();
  const hop = can(actor, "pipeline.assign");
  const onIt = new Set(ownersOf(rec, stage).map((o) => o.personId));
  const options = crew().filter((p) => !onIt.has(p.personId) && (hop || p.personId === actor.personId));
  const [who, setWho] = useState(options[0]?.personId ?? "");
  const [roles, setRoles] = useState<string[]>([]);
  const due = stage === PROJECT_STAGE ? null : rec.stageDeadlines[stage] ?? null;
  const need = stage === PROJECT_STAGE ? 0 : effortFor(rec.category, stage, getDb().settings.effortOverrides) / (onIt.size + 1);
  const free = who && due ? freeDaysBefore(who, due) : null;
  const tight = free !== null && need > 0 && free < need - 0.05;
  return (
    <Modal title={stage === PROJECT_STAGE ? "Add someone to the project" : `Add someone to ${stage}`} onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!who} onClick={() => { if (attempt(() => addStageOwner(actor, rec.contentId, stage, who, roles), "Added")) { onAdded(who); onClose(); } }}>Add</button></>}>
      <div className="stack">
        {options.length === 0 ? <p className="muted">Everyone is already on this stage.</p> : (
          <Field label="Person">
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              {options.map((p) => <option key={p.personId} value={p.personId}>{p.name}{due ? `, ${fmtDays(freeDaysBefore(p.personId, due))} free before ${fmtShort(due)}` : ""}</option>)}
            </select>
          </Field>
        )}
        {free !== null && need > 0 && (
          <p className={tight ? "banner warn" : "muted"} style={tight ? { padding: "10px 14px" } : undefined}>
            {tight ? `${nameOf(who)} has ${fmtDays(free)} free before ${fmtShort(due!)}, and this stage needs about ${fmtDays(need)} of their time. That is more than they can fit.` : `${nameOf(who)} has ${fmtDays(free)} free before ${fmtShort(due!)}. This stage needs about ${fmtDays(need)} of their time.`}
          </p>
        )}
        <div><div style={{ fontSize: ".86rem", color: "var(--ink-2)", marginBottom: 5 }}>Roles they do here (pick from the list or type your own)</div><RolePicker value={roles} onChange={setRoles} /></div>
      </div>
    </Modal>
  );
}

function OwnerRolesModal({ rec, stage, personId, onClose }: { rec: ContentRecord; stage: string; personId: string; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const [roles, setRoles] = useState<string[]>(ownersOf(rec, stage).find((o) => o.personId === personId)?.roles ?? []);
  return (
    <Modal title={`Roles for ${nameOf(personId)}`} onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => { if (attempt(() => setOwnerRoles(actor, rec.contentId, stage, personId, roles), "Roles saved")) onClose(); }}>Save</button></>}>
      <RolePicker value={roles} onChange={setRoles} />
    </Modal>
  );
}

/** Checklist items inside a stage, each with its own person and date. Every item must be ticked to finish the stage. */
export function StageChecklist({ rec }: { rec: ContentRecord }) {
  const { actor, attempt } = useApp();
  const cfg = categoryOf(rec.category);
  const write = canWrite(actor, rec);
  const options = crew();
  const [label, setLabel] = useState("");
  const [due, setDue] = useState("");
  const [who, setWho] = useState("");
  const stagesWithTasks = cfg.stages.filter((s) => tasksOf(rec, s.name).length > 0 || s.name === rec.pipelineStage);
  const current = rec.pipelineStage ?? "";

  const block = (stage: string) => {
    const items = tasksOf(rec, stage);
    return (
      <div key={stage} className="stack" style={{ gap: 8 }}>
        {items.length === 0 && <p className="muted">No checklist items yet for {stage}.</p>}
        {items.map((t) => (
          <div key={t.id} className="task-row">
            <label className="check" style={{ flex: "1 1 180px" }}>
              <input type="checkbox" checked={t.done} disabled={!write} onChange={(e) => attempt(() => updateTask(actor, rec.contentId, t.id, { done: e.target.checked }))} />
              <span style={{ textDecoration: t.done ? "line-through" : "none", color: t.done ? "var(--ink-3)" : undefined }}>{t.label}</span>
            </label>
            <select value={t.assigneePersonId ?? ""} disabled={!write} aria-label={`Who does ${t.label}`} onChange={(e) => attempt(() => updateTask(actor, rec.contentId, t.id, { assigneePersonId: e.target.value || null }))}>
              <option value="">Unassigned</option>
              {options.map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}
            </select>
            <input type="date" value={t.dueDate ?? ""} disabled={!write} aria-label={`Due date for ${t.label}`} onChange={(e) => attempt(() => updateTask(actor, rec.contentId, t.id, { dueDate: e.target.value || null }))} />
            {write && <button className="btn small ghost" aria-label={`Remove ${t.label}`} onClick={() => attempt(() => removeTask(actor, rec.contentId, t.id))}>Remove</button>}
            {t.done && t.doneAt && <span className="muted" style={{ fontSize: ".78rem", flexBasis: "100%" }}>Done by {nameOf(t.doneBy)}, {fmtDateTime(t.doneAt)}</span>}
          </div>
        ))}
      </div>
    );
  };

  const currentItems = tasksOf(rec, current);
  const done = currentItems.filter((t) => t.done).length;

  return (
    <section className="glass panel" aria-label="Checklist">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
        <h2 style={{ flex: 1 }}>{current} checklist</h2>
        {currentItems.length > 0 && <span className={`badge ${done === currentItems.length ? "ok" : ""}`}>{done} of {currentItems.length} done</span>}
      </div>
      {block(current)}
      {write && (
        <div className="task-add">
          <Field label="Add an item"><input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="For example: Voice-over recorded" onKeyDown={(e) => { if (e.key === "Enter" && label.trim() && attempt(() => addTask(actor, rec.contentId, { label, dueDate: due || null, assigneePersonId: who || null }), "Item added")) { setLabel(""); setDue(""); setWho(""); } }} /></Field>
          <Field label="Person"><select value={who} onChange={(e) => setWho(e.target.value)}><option value="">Unassigned</option>{options.map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}</select></Field>
          <Field label="Due"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" onClick={() => { if (attempt(() => addTask(actor, rec.contentId, { label, dueDate: due || null, assigneePersonId: who || null }), "Item added")) { setLabel(""); setDue(""); setWho(""); } }}><IconPlus /> Add</button></div>
        </div>
      )}
      <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Every item must be ticked before this stage can be marked done.</p>
      {stagesWithTasks.filter((s) => s.name !== current && tasksOf(rec, s.name).length > 0).map((s) => (
        <details key={s.name} style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>{s.name} checklist ({tasksOf(rec, s.name).filter((t) => t.done).length} of {tasksOf(rec, s.name).length} done)</summary>
          <div style={{ marginTop: 8 }}>{block(s.name)}</div>
        </details>
      ))}
    </section>
  );
}

const KIND_LABEL: Record<StageLink["kind"], string> = { review: "Review", final: "Final", analysis: "Analysis", reference: "Reference" };

/** Review links at any stage, the final published link at the last stage, and analysis notes. */
export function LinksPanel({ rec }: { rec: ContentRecord }) {
  const { actor, attempt, toast } = useApp();
  const cfg = categoryOf(rec.category);
  const write = canWrite(actor, rec);
  const finalStage = finalStageOf(rec.category).name;
  const atFinal = rec.pipelineStage === finalStage;
  const [kind, setKind] = useState<StageLink["kind"]>("review");
  const [stage, setStage] = useState(rec.pipelineStage ?? cfg.stages[0].name);
  const [rows, setRows] = useState<{ url: string; note: string }[]>([{ url: "", note: "" }]);
  const analysisDoc = docsForRecord(actor, rec).find((d) => d.contentId === rec.contentId && d.templateKey === "analysis");
  const { go } = useApp();
  const finals = rec.links.filter((l) => l.kind === "final");

  const copy = async (u: string) => { try { await navigator.clipboard.writeText(u); toast("Link copied", "success"); } catch { toast("Could not copy the link.", "error"); } };
  const add = () => {
    const made = attempt(() => addLinks(actor, rec.contentId, { kind, stage: kind === "final" ? finalStage : stage, links: rows }), undefined);
    if (made) { toast(made.length > 1 ? `${made.length} links posted` : kind === "final" ? "Final link posted" : "Link posted", "success"); setRows([{ url: "", note: "" }]); }
  };
  const setRow = (i: number, patch: Partial<{ url: string; note: string }>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const row = (l: StageLink) => (
    <div key={l.id} className="list-item" style={{ cursor: "default", alignItems: "flex-start" }}>
      <span className={`badge ${l.kind === "final" ? "ok" : l.kind === "analysis" ? "accent" : ""}`} style={{ marginTop: 2 }}>{KIND_LABEL[l.kind]}</span>
      <div className="grow">
        {l.url && <a href={l.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent-hi)", wordBreak: "break-all" }}>{l.url}</a>}
        {l.note && <div style={{ whiteSpace: "pre-wrap" }}>{l.note}</div>}
        <div className="muted" style={{ fontSize: ".8rem" }}>{l.stage}, {nameOf(l.byPersonId)}, {fmtDateTime(l.at)}</div>
      </div>
      {l.url && <button className="btn small ghost" onClick={() => copy(l.url)}>Copy</button>}
      {write && <button className="btn small ghost" onClick={() => attempt(() => removeLink(actor, rec.contentId, l.id), "Removed")}>Remove</button>}
    </div>
  );

  return (
    <section className="glass panel" aria-label="Links and review">
      <h2>Links, review and publishing</h2>
      {atFinal && (
        <div className={`gate ${finals.length ? "ready" : ""}`} style={{ marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <b>{finals.length ? "Published" : `Ready to publish?`}</b>
            <div className="muted">{finals.length ? `${finals.length} final link${finals.length > 1 ? "s" : ""} posted.` : "Post the final link when it is live. Then use the analysis document to record how it performed."}</div>
          </div>
          {analysisDoc && <button className="btn" onClick={() => go({ n: "doc", id: analysisDoc.id })}>Open the analysis document</button>}
        </div>
      )}
      {rec.links.length === 0 ? <Empty>No links yet. Post a review link at any stage so people can watch and comment.</Empty> : (
        <div className="list">
          {cfg.stages.filter((s) => rec.links.some((l) => l.stage === s.name)).flatMap((s) => rec.links.filter((l) => l.stage === s.name).map(row))}
        </div>
      )}
      {write && (
        <div className="stack" style={{ marginTop: 14 }}>
          <div className="task-add" style={{ marginTop: 0 }}>
            <Field label="Type">
              <select value={kind} onChange={(e) => setKind(e.target.value as StageLink["kind"])}>
                <option value="review">Link for review</option>
                <option value="final" disabled={!atFinal}>{atFinal ? "Final published link" : `Final link (at ${finalStage})`}</option>
                <option value="analysis">Analysis or audience retention</option>
                <option value="reference">Reference</option>
              </select>
            </Field>
            {kind !== "final" && <Field label="Stage"><select value={stage} onChange={(e) => setStage(e.target.value)}>{cfg.stages.map((s) => <option key={s.name}>{s.name}</option>)}</select></Field>}
          </div>
          {rows.map((r, i) => (
            <div key={i} className="task-add" style={{ marginTop: 0 }}>
              <Field label={i === 0 ? (kind === "analysis" ? "Link (optional)" : "Link") : `Link ${i + 1}`}><input type="text" value={r.url} onChange={(e) => setRow(i, { url: e.target.value })} placeholder="https://" /></Field>
              <Field label={kind === "analysis" ? "Analysis" : "Label (for example YouTube, Facebook)"}><input type="text" value={r.note} onChange={(e) => setRow(i, { note: e.target.value })} placeholder={kind === "analysis" ? "For example: retention drops at 2:10" : "What is this link?"} /></Field>
              {rows.length > 1 && <div style={{ flex: "none", minWidth: 0 }}><button className="btn small ghost" aria-label={`Remove link ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></div>}
            </div>
          ))}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" onClick={() => setRows([...rows, { url: "", note: "" }])}><IconPlus /> Add another link</button>
            <button className="btn primary" onClick={add}>Post {rows.filter((r) => r.url.trim() || r.note.trim()).length > 1 ? `${rows.filter((r) => r.url.trim() || r.note.trim()).length} links` : "link"}</button>
          </div>
        </div>
      )}
      <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Links are kept with the stage they were posted at.</p>
    </section>
  );
}

/**
 * A live day's Post Production stage asks one question first: did this day record anything that needs work?
 * If yes, the recording has to be split into its own Music track or Series episode — already past the stages
 * that assume there is no footage yet — before the day itself can be marked done.
 */
export function PostProductionPanel({ rec }: { rec: ContentRecord }) {
  const { actor, attempt } = useApp();
  const write = canWrite(actor, rec);
  const [splitting, setSplitting] = useState(false);
  if (rec.category !== "live" || rec.pipelineStage !== "Post Production") return null;
  const spinOffs = spinOffsOf(rec.contentId);

  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      <div className="seg" role="group" aria-label="Did this day record anything?">
        <button type="button" className={rec.postProductionNeeded === true ? "on" : ""} disabled={!write} onClick={() => attempt(() => setPostProductionNeeded(actor, rec.contentId, true, rec.version))}>Yes, something was recorded</button>
        <button type="button" className={rec.postProductionNeeded === false ? "on" : ""} disabled={!write} onClick={() => attempt(() => setPostProductionNeeded(actor, rec.contentId, false, rec.version))}>No, nothing to post-produce</button>
      </div>
      {rec.postProductionNeeded === true && (
        <div className="stack" style={{ gap: 8 }}>
          {spinOffs.length > 0 && (
            <table className="table">
              <thead><tr><th>New item</th><th>Now at</th></tr></thead>
              <tbody>{spinOffs.map((s) => <tr key={s.contentId}><td>{s.contentId}: {s.title}</td><td>{s.pipelineStage}</td></tr>)}</tbody>
            </table>
          )}
          {write && <button type="button" className="btn small" onClick={() => setSplitting(true)}><IconPlus /> Split off a recording</button>}
          {!spinOffs.length && <p className="muted" style={{ fontSize: ".84rem" }}>Split at least one recording into a Music track or Series episode before this day can be marked done.</p>}
        </div>
      )}
      {splitting && <SplitRecordingModal day={rec} onClose={() => setSplitting(false)} />}
    </div>
  );
}

function SplitRecordingModal({ day, onClose }: { day: ContentRecord; onClose: () => void }) {
  const { actor, attempt, go } = useApp();
  const [dest, setDest] = useState<"music" | "series">("series");
  const options = getDb().records.filter((r) => r.category === dest && r.hierarchyLevel === 1 && canWrite(actor, r));
  const [parentId, setParentId] = useState(options[0]?.contentId ?? "");
  const [title, setTitle] = useState("");
  const cfg = categoryOf(dest);

  const save = () => {
    const created = attempt(() => splitRecording(actor, day.contentId, { destCategory: dest, parentId, title }), "Split off");
    if (created) { onClose(); go({ n: "record", id: created.contentId }); }
  };

  return (
    <Modal title="Split off a recording" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!parentId || !title.trim()}>Split off</button></>}>
      <div className="stack">
        <p className="muted">This creates a new item for what was recorded on {day.title}, already past the stages that assume there is no footage — it starts at {SPIN_OFF_LABEL[dest]}.</p>
        <div className="seg" role="group" aria-label="Kind">
          <button type="button" className={dest === "series" ? "on" : ""} onClick={() => { setDest("series"); setParentId(""); }}>A sermon (Series)</button>
          <button type="button" className={dest === "music" ? "on" : ""} onClick={() => { setDest("music"); setParentId(""); }}>A song (Music)</button>
        </div>
        <Field label={cfg.childLevelLabel ?? "Put it in"}>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="" disabled>Choose a {(cfg.childLevelLabel ?? "").toLowerCase()}…</option>
            {options.map((o) => <option key={o.contentId} value={o.contentId}>{o.title}</option>)}
          </select>
        </Field>
        {!options.length && <p className="muted">No {(cfg.childLevelLabel ?? "").toLowerCase()} you can edit exists yet. Create one under {cfg.label} first.</p>}
        <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={dest === "series" ? "Why do we doubt?" : "Song title"} autoFocus /></Field>
      </div>
    </Modal>
  );
}

const SPIN_OFF_LABEL: Record<"music" | "series", string> = { music: "Audio post-production", series: "Editorial" };

/**
 * A live show's strike plan: what comes down every night, and what stays rigged until the last day.
 * A day picks up whichever list applies once it reaches Wrap — every day gets the nightly list, and
 * the show's last day gets the nightly list plus everything that stays up until then.
 */
export function StrikePlanPanel({ rec }: { rec: ContentRecord }) {
  const { actor, attempt } = useApp();
  const write = canWrite(actor, rec);
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState<"daily" | "continuous">(rec.strikePattern ?? "daily");
  const [daily, setDaily] = useState((rec.strikeChecklist?.daily ?? []).join("\n"));
  const [final, setFinal] = useState((rec.strikeChecklist?.final ?? []).join("\n"));
  if (rec.category !== "live" || rec.hierarchyLevel !== 0) return null;

  const start = () => { setPattern(rec.strikePattern ?? "daily"); setDaily((rec.strikeChecklist?.daily ?? []).join("\n")); setFinal((rec.strikeChecklist?.final ?? []).join("\n")); setEditing(true); };
  const save = () => {
    const ok = attempt(() => setStrikePlan(actor, rec.contentId, pattern, daily.split("\n"), final.split("\n"), rec.version), "Strike plan saved");
    if (ok) setEditing(false);
  };

  return (
    <section className="glass panel" aria-label="Strike plan">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ flex: 1 }}>Strike plan</h2>
        {write && !editing && <button className="btn small" onClick={start}>{rec.strikeChecklist ? "Edit" : "Set up"}</button>}
      </div>
      {editing ? (
        <div className="stack">
          <div className="seg" role="group" aria-label="How the rig is struck">
            <button type="button" className={pattern === "daily" ? "on" : ""} onClick={() => setPattern("daily")}>Struck down every day</button>
            <button type="button" className={pattern === "continuous" ? "on" : ""} onClick={() => setPattern("continuous")}>Built once, struck on the last day</button>
          </div>
          <Field label="Comes down every night, one per line"><textarea rows={4} value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={"Cameras and tripods\nWireless mics"} /></Field>
          <Field label="Stays rigged until the show's last day, one per line"><textarea rows={4} value={final} onChange={(e) => setFinal(e.target.value)} placeholder={"FOH snake\nLED screen and truss"} /></Field>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </div>
      ) : rec.strikeChecklist ? (
        <div className="row">
          <div>
            <p className="muted" style={{ fontSize: ".84rem" }}>{pattern === "continuous" ? "Built once, struck on the last day." : "Struck down every day."} Every night:</p>
            {rec.strikeChecklist.daily.length ? <ul>{rec.strikeChecklist.daily.map((x, i) => <li key={i}>{x}</li>)}</ul> : <Empty>Nothing listed.</Empty>}
          </div>
          <div>
            <p className="muted" style={{ fontSize: ".84rem" }}>Only on the last day:</p>
            {rec.strikeChecklist.final.length ? <ul>{rec.strikeChecklist.final.map((x, i) => <li key={i}>{x}</li>)}</ul> : <Empty>Nothing listed.</Empty>}
          </div>
        </div>
      ) : (
        <Empty>No strike plan yet. Each day's Wrap stage will have no checklist until one is set.</Empty>
      )}
    </section>
  );
}

/**
 * Devotional's own branch points, in place of the generic advance/send-back buttons: the Guest
 * stage's Approved-or-Closed decision, Editing's ready-for-review checkbox, Review's Approve-or-
 * send-back-with-reason decision, and a plain summary once the project is Closed.
 */
export function DevotionalPanel({ rec }: { rec: ContentRecord }) {
  const { actor, attempt } = useApp();
  const write = canWrite(actor, rec);
  const [reviewer, setReviewer] = useState("");
  const [closing, setClosing] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const [backReason, setBackReason] = useState("");
  if (rec.category !== "devotional") return null;

  if (rec.pipelineStage === "Closed") {
    return (
      <div className="stack" style={{ marginBottom: 12 }}>
        <div className="banner">
          <span className="grow"><b>Closed.</b> {rec.closedReason}</span>
        </div>
      </div>
    );
  }

  if (rec.pipelineStage === "Guest") {
    return (
      <div className="stack" style={{ marginBottom: 12, gap: 10 }}>
        <div className="row" style={{ alignItems: "end" }}>
          <Field label="Reviewer's name"><input type="text" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Who did the theological review" disabled={!write} /></Field>
          <button className="btn primary" disabled={!write || !reviewer.trim()} onClick={() => attempt(() => approveGuestReview(actor, rec.contentId, reviewer, rec.version), "Approved")}>Approved, move to Prep/Scripting</button>
        </div>
        {write && <button className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setClosing(true)}>Guest is non-compliant, close this project…</button>}
        {closing && (
          <Modal title="Close this project" onClose={() => setClosing(false)} actions={<><button className="btn" onClick={() => setClosing(false)}>Cancel</button><button className="btn danger" disabled={!closeReason.trim()} onClick={() => { if (attempt(() => closeDevotional(actor, rec.contentId, closeReason, rec.version), "Closed")) setClosing(false); }}>Close project</button></>}>
            <Field label="Why the guest did not work out"><textarea rows={4} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} autoFocus /></Field>
          </Modal>
        )}
      </div>
    );
  }

  if (rec.pipelineStage === "Editing") {
    return (
      <div className="gate" style={{ marginBottom: 12 }}>
        <label className="check">
          <input type="checkbox" checked={rec.readyForReview} disabled={!write} onChange={(e) => attempt(() => setDevotionalReadyForReview(actor, rec.contentId, e.target.checked, rec.version))} />
          <span>Ready for review</span>
        </label>
        <span className="muted grow" style={{ flex: 1 }}>{rec.readyForReview ? "Once its output is confirmed below, it can move to Review." : "Tick this once the edit is ready to be reviewed."}</span>
      </div>
    );
  }

  if (rec.pipelineStage === "Review") {
    return (
      <div className="stack" style={{ marginBottom: 12, gap: 10 }}>
        <div className="gate">
          <span className="muted grow" style={{ flex: 1 }}>{rec.readyForReview ? "Editing marked this ready for review." : "Editing has not marked this ready yet."}</span>
          {write && <button className="btn primary" disabled={!rec.readyForReview} onClick={() => attempt(() => approveDevotionalReview(actor, rec.contentId, rec.version), "Approved, published")}>Approve, move to Published</button>}
          {write && <button className="btn small ghost" onClick={() => setSendingBack(true)}>Send back to Editing</button>}
        </div>
        {sendingBack && (
          <Modal title="Send back to Editing" onClose={() => setSendingBack(false)} actions={<><button className="btn" onClick={() => setSendingBack(false)}>Cancel</button><button className="btn primary" disabled={!backReason.trim()} onClick={() => { if (attempt(() => sendBackDevotionalToEditing(actor, rec.contentId, backReason, rec.version), "Sent back")) setSendingBack(false); }}>Send back</button></>}>
            <Field label="Why it is going back"><textarea rows={4} value={backReason} onChange={(e) => setBackReason(e.target.value)} autoFocus /></Field>
          </Modal>
        )}
      </div>
    );
  }

  return null;
}
