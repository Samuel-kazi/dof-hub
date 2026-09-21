import { useState } from "react";
import type { ContentRecord, StageLink } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb } from "../data/store";
import { categoryOf, finalStageOf } from "../config/categories";
import { Empty, Field } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { canJoin, canWrite, isHop } from "../services/access";
import { can } from "../services/permissions";
import { PROJECT_STAGE, addLinks, addStageOwner, addTask, ownersOf, removeLink, removeStageOwner, removeTask, setOwnerRoles, setStageDeadline, tasksOf, updateTask, usesPipeline } from "../services/content";
import { teamOf } from "../services/team";
import { effortFor } from "../config/capacity";
import { Modal } from "../ui/Modal";
import { RolePicker } from "../ui/RolePicker";
import { fmtDays, freeDaysBefore, overloadWarning } from "../services/workload";
import { nameOf } from "../services/people";
import { docsForRecord } from "../services/docs";
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
