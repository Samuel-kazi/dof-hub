import { useState } from "react";
import type { CallSheet } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb, useDb } from "../data/store";
import { canComment, canWrite, getRecord, visibleCallSheets, visibleRecords } from "../services/access";
import {
  createCallSheet, crewConflicts, deleteCallSheet, duplicateCallSheet, finalizeCallSheet, getCallSheet, getMismatches,
  reopenCallSheet, resolveMismatches, updateCallSheet,
  addRunItem, daysOf, removeRunItem, runOfShowRequired, runOfShowTotals, sheetLevel, sortedRunOfShow, updateRunItem,
} from "../services/callsheets";
import { addComment, featuredFor, getComments, updateRecord } from "../services/content";
import { roleOn } from "../services/team";
import { levelLabel } from "../config/production";
import { nameOf } from "../services/people";
import { fmtDate, relativeDays } from "../services/utils";
import { Modal } from "../ui/Modal";
import { Empty, Field } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { GearPicker } from "../ui/GearPicker";
import { addGearToSheet, getItem, gearIssues, hasGearAccess, manifestForSheet, manifestStatusView, removeGearFromSheet } from "../services/equipment";

export function CallSheets() {
  const { actor, go, menu, confirm, attempt } = useApp();
  useDb();
  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState<CallSheet | null>(null);
  const sheets = visibleCallSheets(actor).sort((a, b) => a.date.localeCompare(b.date));
  const writableProjects = visibleRecords(actor).filter((r) => r.hierarchyLevel === 0 && canWrite(actor, r));

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Call sheets</h1>
          <p className="sub">Each sheet is linked to its project's episodes on the shoot date.</p>
        </div>
        {writableProjects.length > 0 && <button className="btn primary" onClick={() => setCreating(true)}><IconPlus /> New call sheet</button>}
      </div>
      <section className="glass panel">
        {sheets.length === 0 ? (
          <Empty>No call sheets yet. Use the call sheet button on a pipeline record, or create one here.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Call sheet</th><th>Project</th><th>Date</th><th>Linked</th><th>Status</th></tr></thead>
            <tbody>
              {sheets.map((cs) => {
                const mm = getMismatches(cs);
                const drift = mm.moved.length + mm.unlinked.length > 0;
                const clash = crewConflicts(cs).length > 0;
                const write = canWrite(actor, getRecord(cs.contentId)!);
                return (
                  <tr
                    key={cs.id}
                    className="clickable"
                    onClick={() => go({ n: "callsheet", id: cs.id })}
                    onContextMenu={(e) =>
                      menu(e, [
                        { label: "Open", onClick: () => go({ n: "callsheet", id: cs.id }) },
                        { label: "Duplicate for another date…", disabled: !write, onClick: () => setDuplicating(cs) },
                        { divider: true, label: "", onClick: () => {} },
                        {
                          label: "Delete",
                          danger: true,
                          disabled: !write,
                          onClick: async () => {
                            if (await confirm({ title: `Delete ${cs.title}?`, body: "This removes the call sheet. The episodes are not affected.", confirmLabel: "Delete", danger: true })) attempt(() => deleteCallSheet(actor, cs.id), "Deleted");
                          },
                        },
                      ])
                    }
                  >
                    <td><div>{cs.title}</div><span className="cid">{cs.id}</span></td>
                    <td>{getRecord(cs.contentId)?.title}</td>
                    <td>{fmtDate(cs.date)}<div className="muted" style={{ fontSize: ".82rem" }}>{relativeDays(cs.date)}</div></td>
                    <td>{cs.linkedEpisodeIds.length}</td>
                    <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <span className={`badge ${cs.status === "final" ? "ok" : ""}`}>{cs.status === "final" ? "Final" : "Draft"}</span>
                      {drift && <span className="badge warn">Dates changed</span>}
                      {clash && <span className="badge bad">Crew clash</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {sheets.length > 0 && <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Right-click a call sheet to duplicate or delete it.</p>}
      </section>
      {creating && <NewSheetModal projects={writableProjects.map((p) => ({ id: p.contentId, title: p.title }))} onClose={() => setCreating(false)} onCreated={(cs) => { setCreating(false); go({ n: "callsheet", id: cs.id }); }} />}
      {duplicating && <DuplicateModal sheet={duplicating} onClose={() => setDuplicating(null)} onCreated={(cs) => { setDuplicating(null); go({ n: "callsheet", id: cs.id }); }} />}
    </div>
  );
}

function NewSheetModal({ projects, onClose, onCreated }: { projects: { id: string; title: string }[]; onClose: () => void; onCreated: (c: CallSheet) => void }) {
  const { actor, attempt } = useApp();
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [date, setDate] = useState("");
  const save = () => {
    const cs = attempt(() => createCallSheet(actor, { contentId: project, date }), "Call sheet created");
    if (cs) onCreated(cs);
  };
  return (
    <Modal title="New call sheet" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Create</button></>}>
      <div className="stack">
        <Field label="Project"><select value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
        <Field label="Shoot date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus /></Field>
        <p className="muted">Episodes and days in this project with a shoot date on that day are attached automatically. Other projects are never pulled in.</p>
      </div>
    </Modal>
  );
}

function DuplicateModal({ sheet, onClose, onCreated }: { sheet: CallSheet; onClose: () => void; onCreated: (c: CallSheet) => void }) {
  const { actor, attempt, toast } = useApp();
  const [date, setDate] = useState("");
  const save = () => {
    const res = attempt(() => duplicateCallSheet(actor, sheet.id, date), "Call sheet duplicated");
    if (!res) return;
    if (res.gear.skipped.length) toast(`Copied ${res.gear.copied} gear item${res.gear.copied === 1 ? "" : "s"}. Skipped: ${res.gear.skipped.join(" ")}`, "info");
    onCreated(res.sheet);
  };
  return (
    <Modal title="Duplicate call sheet" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Duplicate</button></>}>
      <div className="stack">
        <Field label="New shoot date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus /></Field>
        <p className="muted">Crew, location, format and gear carry over. Episodes are matched again for the new date, and gear already booked that day is skipped.</p>
      </div>
    </Modal>
  );
}

export function CallSheetPage({ id }: { id: string }) {
  const { actor, go, back, attempt, confirm } = useApp();
  useDb();
  const [comment, setComment] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const cs = getCallSheet(id);
  const root = cs ? getRecord(cs.contentId) : undefined;
  const [draft, setDraft] = useState<Partial<CallSheet> | null>(null);

  if (!cs || !root) return <div className="page"><Empty>This call sheet does not exist or is not part of a project you are attached to.</Empty></div>;

  const write = canWrite(actor, root);
  const editable = write && cs.status === "draft";
  const mm = getMismatches(cs);
  const drift = mm.moved.length + mm.unlinked.length > 0;
  const clashes = crewConflicts(cs);
  const value = <K extends keyof CallSheet>(k: K): CallSheet[K] => ((draft && k in draft ? draft[k] : cs[k]) as CallSheet[K]);
  const set = (patch: Partial<CallSheet>) => setDraft((d) => ({ ...(d ?? {}), ...patch }));
  const dirty = !!draft && Object.keys(draft).length > 0;

  const db = getDb();
  const projectMemberIds = new Set(db.members.filter((m) => m.projectContentId === cs.contentId).map((m) => m.personId));
  const candidates = db.people.filter((p) => p.status === "active" && projectMemberIds.has(p.personId) && (p.category === "CRW" || p.category === "VOL"));
  const comments = getComments(cs.contentId, cs.id);

  const save = () => {
    if (!draft) return;
    if (attempt(() => updateCallSheet(actor, cs.id, draft, cs.version), "Saved")) setDraft(null);
  };
  const toggleCrew = (pid: string, on: boolean) => {
    const next = on ? [...cs.crewPersonIds, pid] : cs.crewPersonIds.filter((x) => x !== pid);
    attempt(() => updateCallSheet(actor, cs.id, { crewPersonIds: next }, cs.version));
  };

  return (
    <div className="page">
      <nav className="crumbs"><button onClick={() => go({ n: "callsheets" })}>Call sheets</button><span aria-hidden> / </span><span>{cs.title}</span></nav>
      <div className="page-head">
        <div className="grow">
          <h1>{cs.title}</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
            <span className="cid">{cs.id}</span>
            <span className={`badge ${cs.status === "final" ? "ok" : ""}`}>{cs.status === "final" ? "Final" : "Draft"}</span>
            <button className="badge accent" style={{ cursor: "pointer" }} onClick={() => go({ n: "record", id: root.contentId })}>{root.title}</button>
          </div>
        </div>
        {write && <button className="btn" onClick={() => setDuplicating(true)}>Duplicate</button>}
        {write && (cs.status === "draft" ? (
          <button className="btn primary" onClick={() => attempt(() => finalizeCallSheet(actor, cs.id, cs.version), "Call sheet finalized")}>Finalize</button>
        ) : (
          <button className="btn" onClick={() => attempt(() => reopenCallSheet(actor, cs.id), "Reopened as draft")}>Reopen</button>
        ))}
        {write && (
          <button className="btn danger" onClick={async () => {
            if (await confirm({ title: `Delete ${cs.title}?`, body: "This removes the call sheet. The episodes are not affected.", confirmLabel: "Delete", danger: true })) {
              if (attempt(() => deleteCallSheet(actor, cs.id), "Deleted")) back();
            }
          }}>Delete</button>
        )}
      </div>

      {drift && (
        <div className="banner warn" role="alert">
          <div className="grow">
            <b>Episode dates no longer match this call sheet.</b>
            {mm.moved.length > 0 && <div>Moved away from {fmtDate(cs.date)}: {mm.moved.map((r) => r.title).join(", ")}</div>}
            {mm.unlinked.length > 0 && <div>Now scheduled for this date but not linked: {mm.unlinked.map((r) => r.title).join(", ")}</div>}
          </div>
          {write && <button className="btn" onClick={() => attempt(() => resolveMismatches(actor, cs.id, cs.version), "Linked episodes updated")}>Re-link to {fmtDate(cs.date)}</button>}
        </div>
      )}
      {clashes.length > 0 && (
        <div className="banner bad" role="alert">
          <div className="grow"><b>Crew double-booked.</b> {[...new Set(clashes.map((c) => `${nameOf(c.personId)} is also on ${c.otherSheet.title}`))].join("; ")}</div>
        </div>
      )}

      <section className="glass panel">
        <h2>Shoot details</h2>
        <div className="stack">
          <div className="row">
            <Field label="Title"><input type="text" value={value("title")} disabled={!editable} onChange={(e) => set({ title: e.target.value })} /></Field>
            <Field label="Date"><input type="date" value={value("date")} disabled={!editable} onChange={(e) => set({ date: e.target.value })} /></Field>
            <Field label="Call time"><input type="time" value={value("callTime")} disabled={!editable} onChange={(e) => set({ callTime: e.target.value })} /></Field>
          </div>
          <div className="row">
            <Field label="Location"><input type="text" value={value("location")} disabled={!editable} onChange={(e) => set({ location: e.target.value })} /></Field>
            <Field label="Format"><input type="text" value={value("format")} disabled={!editable} onChange={(e) => set({ format: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><textarea value={value("notes")} disabled={!editable} onChange={(e) => set({ notes: e.target.value })} /></Field>
          {editable && dirty && <div><button className="btn primary" onClick={save}>Save changes</button> <button className="btn ghost" onClick={() => setDraft(null)}>Discard</button></div>}
          {cs.status === "final" && write && <p className="muted">Final call sheets are locked. Reopen to edit.</p>}
        </div>
      </section>

      <div className="grid-2">
        <section className="glass panel">
          <h2>{root?.category === "live" ? "Days on this sheet" : "Episodes on this sheet"}</h2>
          {cs.linkedEpisodeIds.length === 0 ? <Empty>No episodes were scheduled for this date when the sheet was created.</Empty> : (
            <div className="list">
              {cs.linkedEpisodeIds.map((eid) => {
                const r = getRecord(eid);
                return r ? (
                  <div key={eid} className="list-item" onClick={() => go({ n: "record", id: eid })}>
                    <div className="grow">
                      <div className="title">{r.category === "live" ? `${root?.title ?? ""}, ${r.title}` : r.title}</div>
                      <span className="cid">{eid}</span>
                      {(() => { const f = featuredFor(r); const hosts = [...f.inherited.map((x) => x.person), ...f.own.filter((x) => x.kind === "host")]; const guests = f.own.filter((x) => x.kind === "guest"); return hosts.length + guests.length > 0 ? <div className="muted" style={{ fontSize: ".84rem" }}>{hosts.length > 0 && `Host: ${hosts.map((h) => h.name).join(", ")}. `}{guests.length > 0 && `Guest: ${guests.map((g) => g.name).join(", ")}.`}</div> : null; })()}
                    </div>
                    {r.scheduledDate !== cs.date && <span className="badge warn">Now {fmtDate(r.scheduledDate)}</span>}
                  </div>
                ) : null;
              })}
            </div>
          )}
          <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Linked when the sheet was created. Changing an episode's date later flags a mismatch instead of changing this list.</p>
        </section>

        <section className="glass panel">
          <h2>Crew</h2>
          {candidates.length === 0 ? <Empty>No one is attached to this project yet.</Empty> : (
            <div className="stack">
              {candidates.map((p) => {
                const on = cs.crewPersonIds.includes(p.personId);
                const clash = clashes.some((c) => c.personId === p.personId);
                return (
                  <label key={p.personId} className="check">
                    <input type="checkbox" checked={on} disabled={!editable} onChange={(e) => toggleCrew(p.personId, e.target.checked)} />
                    <span>{p.name} <span className="cid">{p.personId}</span>{root && roleOn(p.personId, root) && <span className="badge accent" style={{ marginLeft: 8 }}>{roleOn(p.personId, root)}</span>}</span>
                    {clash && <span className="badge bad">Clash</span>}
                  </label>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <RunOfShowPanel cs={cs} editable={editable} />

      <GearPanel cs={cs} editable={editable} />

      <section className="glass panel">
        <h2>Comments</h2>
        {comments.length === 0 ? <Empty>No comments yet.</Empty> : comments.map((c) => (
          <div key={c.id} className="comment"><b>{nameOf(c.byPersonId)}</b> <small>{new Date(c.at).toLocaleString()}</small><p>{c.text}</p></div>
        ))}
        {canComment(actor, root) ? (
          <div className="row" style={{ marginTop: 12, alignItems: "end" }}>
            <Field label="Add a comment"><textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
            <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" onClick={() => { if (attempt(() => addComment(actor, cs.contentId, comment, cs.id), "Comment added")) setComment(""); }}>Post comment</button></div>
          </div>
        ) : <p className="muted" style={{ marginTop: 10 }}>You can read comments on this project but not add them.</p>}
      </section>
      {duplicating && <DuplicateModal sheet={cs} onClose={() => setDuplicating(false)} onCreated={(n) => { setDuplicating(false); go({ n: "callsheet", id: n.id }); }} />}
    </div>
  );
}

function GearPanel({ cs, editable }: { cs: CallSheet; editable: boolean }) {
  const { actor, go, attempt } = useApp();
  const [picking, setPicking] = useState(false);
  const access = hasGearAccess(actor);
  const m = manifestForSheet(cs.id);
  const issues = gearIssues(cs.id);
  const view = m ? manifestStatusView(m) : null;
  const canEditGear = editable && access && (!m || m.status === "assigned");

  return (
    <section className="glass panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ flex: 1 }}>Gear</h2>
        {view && <span className={`badge ${view.tone}`}>{view.label}</span>}
        {access && m && <button className="btn small" onClick={() => go({ n: "manifest", id: m.id })}>Open checkout list</button>}
        {canEditGear && <button className="btn small primary" onClick={() => setPicking(true)}><IconPlus /> Add gear</button>}
      </div>
      {issues.length > 0 && <div className="banner warn" role="alert" style={{ marginBottom: 12 }}><div className="grow"><b>Gear needs attention.</b>{issues.map((t) => <div key={t}>{t}</div>)}</div></div>}
      {!m || m.lines.length === 0 ? (
        <Empty>{access ? "No gear assigned yet. Add gear to reserve it for this shoot." : "No gear listed."}</Empty>
      ) : (
        <div className="list">
          {m.lines.map((l) => {
            const item = getItem(l.equipmentId);
            return (
              <div key={l.equipmentId} className="list-item" style={{ cursor: access ? "pointer" : "default" }} onClick={() => access && go({ n: "item", id: l.equipmentId })}>
                <div className="grow"><div className="title">{item?.name ?? l.equipmentId}{l.quantity > 1 ? ` x ${l.quantity}` : ""}</div><span className="cid">{l.equipmentId}</span></div>
                {canEditGear && <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); attempt(() => removeGearFromSheet(actor, cs.id, l.equipmentId), "Removed"); }}>Remove</button>}
              </div>
            );
          })}
        </div>
      )}
      {m && m.status === "assigned" && <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Reserved in the studio for {fmtDate(cs.date)}. When it leaves the building, mark it as gone out on the checkout list.</p>}
      {picking && <GearPicker from={cs.date} to={cs.date} excludeManifestId={m?.id} alreadyOn={m?.lines.map((l) => l.equipmentId) ?? []} onClose={() => setPicking(false)} onConfirm={(lines) => { if (attempt(() => addGearToSheet(actor, { id: cs.id, contentId: cs.contentId, date: cs.date }, lines), "Gear added")) setPicking(false); }} />}
    </section>
  );
}

/** Minute-by-minute plan for a large live production. Fields save when you leave them. */
function RunOfShowPanel({ cs, editable }: { cs: CallSheet; editable: boolean }) {
  const { actor, go, attempt } = useApp();
  const root = getRecord(cs.contentId);
  const required = runOfShowRequired(cs);
  const [time, setTime] = useState("");
  const [title, setTitle] = useState("");
  const [len, setLen] = useState("10");
  const [owner, setOwner] = useState("");
  const items = sortedRunOfShow(cs);
  const totals = runOfShowTotals(cs);
  const people = getDb().people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"));
  if (!root || (root.category !== "live" && items.length === 0)) return null;
  const write = canWrite(actor, root);
  const days = daysOf(cs);
  const level = sheetLevel(cs);

  if (!required && items.length === 0) {
    return (
      <section className="glass panel" aria-label="Run of show">
        <h2>Run of show</h2>
        <p className="muted">{days.length ? `${days.map((d) => d.title).join(", ")} ${days.length > 1 ? "are" : "is"} set as a ${levelLabel(level).toLowerCase()} production.` : "No day of the show is linked to this sheet."} A run of show is planned for large productions.</p>
        {write && days.length > 0 && <div style={{ marginTop: 12 }}><button className="btn" onClick={() => { for (const d of days) { const ok = attempt(() => updateRecord(actor, d.contentId, { productionLevel: "large" }, d.version)); if (!ok) return; } }}>{days.length > 1 ? "These are large productions" : "This is a large production"}</button></div>}
      </section>
    );
  }

  const add = () => {
    if (attempt(() => addRunItem(actor, cs.id, { time, title, durationMin: Number(len), ownerPersonId: owner || null }), "Segment added")) { setTitle(""); setTime(""); setLen("10"); setOwner(""); }
  };
  const save = (itemId: string, patch: Parameters<typeof updateRunItem>[3]) => attempt(() => updateRunItem(actor, cs.id, itemId, patch));

  return (
    <section className="glass panel" aria-label="Run of show">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ flex: 1 }}>Run of show</h2>
        <button className="badge accent" style={{ cursor: "pointer" }} onClick={() => go({ n: "record", id: (days[0] ?? root).contentId })}>{levelLabel(level)} production</button>
        {items.length > 0 && <span className="badge">{totals.minutes} min, ends {totals.ends}</span>}
      </div>
      {items.length === 0 ? <Empty>{required ? "A large production needs a run of show before the call sheet can be final. Add the first segment below." : "No segments yet."}</Empty> : (
        <table className="table">
          <thead><tr><th style={{ width: 110 }}>Start</th><th>Segment</th><th style={{ width: 90 }}>Minutes</th><th style={{ width: 190 }}>Who</th><th>Notes</th>{editable && <th />}</tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td><input type="time" defaultValue={it.time} disabled={!editable} onBlur={(e) => e.target.value !== it.time && save(it.id, { time: e.target.value })} aria-label="Start time" /></td>
                <td><input type="text" defaultValue={it.title} disabled={!editable} onBlur={(e) => e.target.value !== it.title && save(it.id, { title: e.target.value })} aria-label="Segment" /></td>
                <td><input type="number" min={0} defaultValue={it.durationMin} disabled={!editable} onBlur={(e) => Number(e.target.value) !== it.durationMin && save(it.id, { durationMin: Number(e.target.value) })} aria-label="Minutes" /></td>
                <td>
                  <select value={it.ownerPersonId ?? ""} disabled={!editable} onChange={(e) => save(it.id, { ownerPersonId: e.target.value || null })} aria-label="Who">
                    <option value="">Unassigned</option>
                    {people.map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}
                  </select>
                </td>
                <td><input type="text" defaultValue={it.notes} disabled={!editable} onBlur={(e) => e.target.value !== it.notes && save(it.id, { notes: e.target.value })} aria-label="Notes" /></td>
                {editable && <td><button className="btn small ghost" onClick={() => attempt(() => removeRunItem(actor, cs.id, it.id), "Removed")}>Remove</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <div className="task-add" style={{ marginTop: 14 }}>
          <Field label="Start"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          <Field label="Segment"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Worship, message, announcements" onKeyDown={(e) => e.key === "Enter" && add()} /></Field>
          <Field label="Minutes"><input type="number" min={0} value={len} onChange={(e) => setLen(e.target.value)} /></Field>
          <Field label="Who"><select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Unassigned</option>{people.map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}</select></Field>
          <div style={{ flex: "none", minWidth: 0 }}><button className="btn primary" onClick={add}><IconPlus /> Add segment</button></div>
        </div>
      )}
    </section>
  );
}
