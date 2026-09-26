import { useState } from "react";
import { ReportButton } from "../ui/ReportDialog";
import { can } from "../services/wrapped/permissions";
import type { Drive, DriveAllocation } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb, useDb } from "../data/store";
import { Modal } from "../ui/Modal";
import { Empty, Field } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { ForecastChart, ForecastNote, StorageBar } from "../ui/StorageViz";
import { canWrite, getRecord, isHop } from "../services/access";
import {
  addAllocation, allDriveUsage, createDrive, deleteDrive, driveReportText, driveUsage, fleetReportText, fleetTotals, forecast, getDrive, isNearlyFull, hasStorageAccess, moveAllocation, removeAllocation, updateAllocation, updateDrive,
} from "../services/wrapped/storage";
import { fmtDate, fmtSize, todayIso } from "../services/utils";

const KIND_LABEL: Record<DriveAllocation["kind"], string> = { raw: "Raw footage", project: "Project files", delivered: "Delivered files", other: "Other" };

function SizeInput({ gb, onChange, label }: { gb: string; onChange: (gb: string) => void; label: string }) {
  const [unit, setUnit] = useState<"GB" | "TB">("GB");
  const shown = gb === "" ? "" : String(unit === "TB" ? Number(gb) / 1000 : gb);
  return (
    <Field label={label}>
      <div style={{ display: "flex", gap: 8 }}>
        <input type="text" inputMode="decimal" value={shown} onChange={(e) => { const v = e.target.value; onChange(v === "" ? "" : String(unit === "TB" ? Number(v) * 1000 : Number(v))); }} />
        <select value={unit} onChange={(e) => setUnit(e.target.value as "GB" | "TB")} style={{ width: 84 }}><option>GB</option><option>TB</option></select>
      </div>
    </Field>
  );
}

export function Storage() {
  const { actor, go, menu, confirm, attempt, toast } = useApp();
  useDb();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Drive | null>(null);
  const usage = allDriveUsage();
  const total = fleetTotals();
  const fc = forecast();
  const hop = can(actor, "storage.admin");
  if (!hasStorageAccess(actor)) return <div className="page"><Empty>Storage is for crew and the Head of Production.</Empty></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Storage and media</h1>
          <p className="sub">{fmtSize(total.used)} used of {fmtSize(total.capacity)} across {usage.length} drives.</p>
        </div>
        <ReportButton scope="storage" />
        {hop && <button className="btn primary no-print" onClick={() => setAdding(true)}><IconPlus /> Add drive</button>}
      </div>

      <section className="glass panel">
        <h2>Forecast</h2>
        <ForecastChart data={fc} />
        <ForecastNote data={fc} />
      </section>

      <div className="drive-grid">
        {usage.map((u) => (
          <div
            key={u.drive.id}
            className="glass drive-card"
            tabIndex={0}
            onClick={() => go({ n: "drive", id: u.drive.id })}
            onKeyDown={(e) => e.key === "Enter" && go({ n: "drive", id: u.drive.id })}
            onContextMenu={(e) => menu(e, [
              { label: "Open", onClick: () => go({ n: "drive", id: u.drive.id }) },
              { label: "Edit drive…", onClick: () => setEditing(u.drive) },
              { divider: true, label: "", onClick: () => {} },
              { label: "Remove drive", danger: true, disabled: !hop, onClick: async () => { if (await confirm({ title: `Remove ${u.drive.name}?`, body: "Only drives with no projects recorded on them can be removed.", confirmLabel: "Remove", danger: true })) attempt(() => deleteDrive(actor, u.drive.id), "Drive removed"); } },
            ])}
          >
            <div className="top"><b>{u.drive.name}</b>{isNearlyFull(u) && <span className="badge warn">Nearly full</span>}<span className="muted">{u.pct.toFixed(0)}%</span></div>
            <StorageBar usage={u} />
            <div className="muted" style={{ fontSize: ".86rem" }}>{fmtSize(u.usedGB)} of {fmtSize(u.drive.capacityGB)}, {fmtSize(u.freeGB)} free</div>
          </div>
        ))}
      </div>
      <p className="muted no-print" style={{ fontSize: ".84rem" }}>Right-click a drive to edit or remove it.</p>

      {adding && <DriveFormModal onClose={() => setAdding(false)} onSaved={(d) => { setAdding(false); go({ n: "drive", id: d.id }); }} />}
      {editing && <DriveFormModal drive={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
    </div>
  );
}

function DriveFormModal({ drive, onClose, onSaved }: { drive?: Drive; onClose: () => void; onSaved: (d: Drive) => void }) {
  const { actor, attempt } = useApp();
  const hop = can(actor, "storage.admin");
  const [name, setName] = useState(drive?.name ?? "");
  const [cap, setCap] = useState(String(drive?.capacityGB ?? 4000));
  const [other, setOther] = useState(String(drive?.otherUsedGB ?? 0));
  const [notes, setNotes] = useState(drive?.notes ?? "");
  const save = () => {
    const d = attempt(() => (drive
      ? updateDrive(actor, drive.id, hop ? { name, capacityGB: Number(cap), otherUsedGB: Number(other), notes } : { otherUsedGB: Number(other), notes })
      : createDrive(actor, { name, capacityGB: Number(cap), otherUsedGB: Number(other), notes })), "Saved");
    if (d) onSaved(d);
  };
  return (
    <Modal title={drive ? `Edit ${drive.name}` : "Add a drive"} onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <Field label="Drive name"><input type="text" value={name} disabled={!!drive && !hop} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        {(!drive || hop) && <SizeInput label="Capacity" gb={cap} onChange={setCap} />}
        <SizeInput label="Space used by files that belong to no project" gb={other} onChange={setOther} />
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where it is kept, who has it" /></Field>
      </div>
    </Modal>
  );
}

export function DrivePage({ id }: { id: string }) {
  const { actor, go, menu, confirm, attempt, toast } = useApp();
  useDb();
  const [adding, setAdding] = useState(false);
  const [editingDrive, setEditingDrive] = useState(false);
  const [editRow, setEditRow] = useState<DriveAllocation | null>(null);
  const [attachRow, setAttachRow] = useState<DriveAllocation | null>(null);
  const drive = getDrive(id);
  if (!hasStorageAccess(actor)) return <div className="page"><Empty>Storage is for crew and the Head of Production.</Empty></div>;
  if (!drive) return <div className="page"><Empty>This drive does not exist.</Empty></div>;
  const u = driveUsage(drive);
  const rows = getDb().allocations.filter((a) => a.driveId === id).sort((a, b) => b.sizeGB - a.sizeGB);

  return (
    <div className="page">
      <nav className="crumbs no-print"><button onClick={() => go({ n: "storage" })}>Storage and media</button><span aria-hidden> / </span><span>{drive.name}</span></nav>
      <div className="page-head">
        <div className="grow">
          <h1>{drive.name}</h1>
          <p className="sub">{fmtSize(u.usedGB)} used of {fmtSize(drive.capacityGB)}, {fmtSize(u.freeGB)} free, as of {fmtDate(todayIso())}</p>
        </div>
        <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ReportButton scope="drive" params={{ driveId: id }} />
          <button className="btn" onClick={() => setEditingDrive(true)}>Edit drive</button>
          <button className="btn primary" onClick={() => setAdding(true)}><IconPlus /> Add project</button>
        </div>
      </div>
      {isNearlyFull(u) && <div className="banner warn"><span className="grow"><b>This drive is nearly full.</b> {fmtSize(u.freeGB)} left before it fills.</span></div>}
      <section className="glass panel">
        <StorageBar usage={u} legend />
        {drive.notes && <p className="muted" style={{ marginTop: 10 }}>{drive.notes}</p>}
      </section>

      <section className="glass panel">
        <h2>What is on this drive</h2>
        {rows.length === 0 && u.otherGB === 0 ? <Empty>No projects recorded on this drive yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Project</th><th>Type</th><th>Size</th><th>Note</th><th>Updated</th></tr></thead>
            <tbody>
              {rows.map((a) => {
                const rec = a.contentId ? getRecord(a.contentId) : undefined;
                const write = a.contentId === null ? hasStorageAccess(actor) : rec ? canWrite(actor, rec) : false;
                return (
                  <tr key={a.id} className="clickable" onClick={() => (rec ? go({ n: "record", id: a.contentId! }) : write && setEditRow(a))}
                    onContextMenu={(e) => menu(e, [
                      { label: "Edit…", disabled: !write, onClick: () => setEditRow(a) },
                      ...(a.contentId === null ? [{ label: "Attach to a project…", disabled: !write, onClick: () => setAttachRow(a) }] : []),
                      { label: "Remove from this drive", danger: true, disabled: !write, onClick: async () => { if (await confirm({ title: "Remove from this drive?", body: `${rec?.title ?? a.label} (${fmtSize(a.sizeGB)}) will no longer be counted here. Raw footage stays until everything under it is Delivered.`, confirmLabel: "Remove", danger: true })) attempt(() => removeAllocation(actor, a.id), "Removed"); } },
                    ])}>
                    <td><div>{rec?.title ?? a.label}</div><span className="cid">{a.contentId ?? "No project yet"}</span></td>
                    <td>{KIND_LABEL[a.kind]}</td>
                    <td>{fmtSize(a.sizeGB)}</td>
                    <td className="muted">{a.note}</td>
                    <td className="muted">{fmtDate(a.updatedAt)}</td>
                  </tr>
                );
              })}
              {u.otherGB > 0 && <tr><td>Other files</td><td>Not tied to a project</td><td>{fmtSize(u.otherGB)}</td><td /><td /></tr>}
            </tbody>
          </table>
        )}
        <p className="muted no-print" style={{ marginTop: 10, fontSize: ".84rem" }}>Right-click a row to edit or remove it.</p>
      </section>
      {adding && <AllocationModal driveId={id} onClose={() => setAdding(false)} />}
      {editRow && <AllocationModal driveId={id} row={editRow} onClose={() => setEditRow(null)} />}
      {attachRow && <AttachToProjectModal row={attachRow} onClose={() => setAttachRow(null)} />}
      {editingDrive && <DriveFormModal drive={drive} onClose={() => setEditingDrive(false)} onSaved={() => setEditingDrive(false)} />}
    </div>
  );
}

/**
 * Records a project on a drive, or edits an entry. Used from the drive page (drive fixed),
 * from a project page (project fixed), and to move an entry to another drive.
 */
export function AllocationModal({ driveId, contentId, row, onClose }: { driveId?: string; contentId?: string; row?: DriveAllocation; onClose: () => void }) {
  const { actor, attempt, confirm } = useApp();
  const projects = getDb().records.filter((r) => !r.archived && canWrite(actor, r)).sort((a, b) => a.contentId.localeCompare(b.contentId));
  const drives = allDriveUsage();
  const [drive, setDrive] = useState(row?.driveId ?? driveId ?? drives[0]?.drive.id ?? "");
  const [noProject, setNoProject] = useState(!!row && row.contentId === null);
  const [project, setProject] = useState(row?.contentId ?? contentId ?? projects[0]?.contentId ?? "");
  const [label, setLabel] = useState(row?.label ?? "");
  const [size, setSize] = useState(row ? String(row.sizeGB) : "");
  const [kind, setKind] = useState<DriveAllocation["kind"]>(row?.kind ?? "raw");
  const [note, setNote] = useState(row?.note ?? "");
  const showDrive = !driveId || !!row;
  const showProjectChoice = !contentId && !row;
  const selected = drives.find((d) => d.drive.id === drive);
  const save = () => {
    const ok = attempt(() => (row
      ? updateAllocation(actor, row.id, { sizeGB: Number(size), kind, note, label: row.contentId === null ? label : undefined, driveId: drive })
      : addAllocation(actor, noProject ? { driveId: drive, contentId: null, label, sizeGB: Number(size), kind, note } : { driveId: drive, contentId: project, sizeGB: Number(size), kind, note })), "Saved");
    if (ok) onClose();
  };
  const remove = async () => {
    if (!row) return;
    if (await confirm({ title: "Remove from this drive?", body: "It will no longer be counted on this drive. Raw footage stays until everything under it is Delivered.", confirmLabel: "Remove", danger: true })) {
      if (attempt(() => removeAllocation(actor, row.id), "Removed")) onClose();
    }
  };
  return (
    <Modal title={row ? "Edit storage entry" : "Assign to a drive"} onClose={onClose} actions={<>{row && <button className="btn danger" style={{ marginRight: "auto" }} onClick={remove}>Remove</button>}<button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <div className="stack">
        {showProjectChoice && (
          <div className="seg" role="group" aria-label="Ties to a project">
            <button type="button" className={!noProject ? "on" : ""} onClick={() => setNoProject(false)}>Tie to a project</button>
            <button type="button" className={noProject ? "on" : ""} onClick={() => setNoProject(true)}>No project yet</button>
          </div>
        )}
        {showProjectChoice && !noProject && <Field label="Project or episode"><select value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.contentId} value={p.contentId}>{p.title}, {p.contentId}</option>)}</select></Field>}
        {((showProjectChoice && noProject) || (row && row.contentId === null)) && (
          <Field label="Label (identifies this entry, since it has no project yet)"><input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="For example: Youth Camp 2025 raw footage" autoFocus /></Field>
        )}
        {showProjectChoice && noProject && <p className="muted">Record this now to track the space it uses. Once the project is ready to work on, attach it from the drive page and its process can start from Recording.</p>}
        {showDrive && (
          <Field label="Drive">
            <select value={drive} onChange={(e) => setDrive(e.target.value)}>
              {drives.map((d) => <option key={d.drive.id} value={d.drive.id}>{d.drive.name}, {fmtSize(d.freeGB)} free</option>)}
            </select>
          </Field>
        )}
        {!showDrive && selected && <p className="muted">{selected.drive.name} has {fmtSize(selected.freeGB)} free.</p>}
        <SizeInput label="Space it has taken" gb={size} onChange={setSize} />
        <Field label="What is stored"><select value={kind} onChange={(e) => setKind(e.target.value as DriveAllocation["kind"])}>{(Object.keys(KIND_LABEL) as DriveAllocation["kind"][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Note"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: camera A cards, day 1" /></Field>
        {kind === "raw" && <p className="muted">Raw footage cannot be removed from a drive until the episodes it belongs to are Delivered. You can update the size at any time.</p>}
      </div>
    </Modal>
  );
}

/** Ties a standalone entry (recorded ahead of a project) to a real project for the first time. */
function AttachToProjectModal({ row, onClose }: { row: DriveAllocation; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const projects = getDb().records.filter((r) => !r.archived && canWrite(actor, r)).sort((a, b) => a.contentId.localeCompare(b.contentId));
  const [project, setProject] = useState(projects[0]?.contentId ?? "");
  const save = () => {
    if (attempt(() => moveAllocation(actor, row.id, project), "Attached")) onClose();
  };
  return (
    <Modal title="Attach to a project" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!project} onClick={save}>Attach</button></>}>
      {projects.length === 0 ? <Empty>There is no project you can attach this to.</Empty> : (
        <div className="stack">
          <p className="muted">{row.label} ({fmtSize(row.sizeGB)}) will be tied to the project you choose. Its pipeline can then continue from Recording.</p>
          <Field label="Project or episode"><select value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.contentId} value={p.contentId}>{p.title}, {p.contentId}</option>)}</select></Field>
        </div>
      )}
    </Modal>
  );
}
