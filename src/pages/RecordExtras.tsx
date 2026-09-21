import { useState } from "react";
import { ReportButton } from "../ui/ReportDialog";
import type { ContentRecord, DriveAllocation } from "../types";
import { useApp } from "../ui/AppContext";
import { useDb } from "../data/store";
import { Empty } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { categoryOf } from "../config/categories";
import { attachManifest, hasGearAccess, listManifests, manifestStatusView, manifestsForContent, projectLabel } from "../services/wrapped/equipment";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/parts";
import { NewCheckoutModal } from "./EquipmentForms";
import { allocationsForRecord, clearRecordFromDrives, getDrive, hasStorageAccess } from "../services/wrapped/storage";
import { canWrite, getRecord, selfAndAncestors } from "../services/access";
import { usesPipeline } from "../services/wrapped/content";
import { docsForRecord } from "../services/wrapped/docs";
import { nameOf } from "../services/wrapped/people";
import { fmtShort, fmtSize, relativeDays } from "../services/utils";
import { AllocationModal } from "./Storage";
import { NewDocModal } from "./Documents";

const KIND: Record<DriveAllocation["kind"], string> = { raw: "raw footage", project: "project files", delivered: "delivered files", other: "other" };

/** Gear, media storage and documents linked to this record by Content ID. */
export function RecordExtras({ rec }: { rec: ContentRecord }) {
  const { actor, go, attempt, confirm } = useApp();
  useDb();
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState<DriveAllocation | null>(null);
  const [newDoc, setNewDoc] = useState(false);
  const [newList, setNewList] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const gear = hasGearAccess(actor);
  const storage = hasStorageAccess(actor);
  const write = canWrite(actor, rec);
  const ids = selfAndAncestors(rec).map((r) => r.contentId);
  const manifests = ids.flatMap((id) => manifestsForContent(id));
  const allocs = storage ? allocationsForRecord(rec) : [];
  const total = allocs.reduce((n, a) => n + a.sizeGB, 0);
  const docs = docsForRecord(actor, rec);

  // Prompt for a drive once footage exists: from the recording stage on.
  const cfg = categoryOf(rec.category);
  const stageIdx = cfg.stages.findIndex((s) => s.name === rec.pipelineStage);
  const footageIdx = cfg.stages.findIndex((s) => s.name === cfg.footageStage);
  const needsDrive = usesPipeline(rec) && stageIdx >= footageIdx && !allocs.some((a) => a.contentId === rec.contentId);

  return (
    <>
      <div className="grid-2">
        {gear && (
          <section className="glass panel" aria-label="Gear">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <h2 style={{ flex: 1 }}>Gear</h2>
              {write && <button className="btn small ghost" onClick={() => setAttaching(true)}>Attach a list</button>}
              {write && <button className="btn small primary" onClick={() => setNewList(true)}><IconPlus /> New checkout list</button>}
            </div>
            {manifests.length === 0 ? <Empty>No checkout list is attached to this project.</Empty> : (
              <div className="list">
                {manifests.map((m) => {
                  const s = manifestStatusView(m);
                  return (
                    <div key={m.id} className="list-item" onClick={() => go({ n: "manifest", id: m.id })}>
                      <div className="grow"><div className="title"><span className="cid" style={{ fontSize: ".95rem", color: "var(--ink)" }}>{m.id}</span></div><div className="muted" style={{ fontSize: ".84rem" }}>{fmtShort(m.date)}{m.expectedReturn ? ` to ${fmtShort(m.expectedReturn)}` : ""}</div></div>
                      <span className={`badge ${s.tone}`}>{s.label}</span>
                      <ReportButton scope="manifest" params={{ manifestId: m.id }} label="Print" small ghost />
                    </div>
                  );
                })}
              </div>
            )}
            <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Only the checkout list ID is kept here. Open a list, or print it, from the Equipment module to attach it to the project report.</p>
          </section>
        )}
        {storage && (
          <section className="glass panel" aria-label="Media storage">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h2 style={{ flex: 1 }}>Media storage</h2>
              {write && allocs.some((a) => a.contentId === rec.contentId) && (
                <button
                  className="btn small ghost"
                  onClick={async () => {
                    const mine = allocs.filter((a) => a.contentId === rec.contentId);
                    const gb = mine.reduce((n, a) => n + a.sizeGB, 0);
                    if (await confirm({ title: `Clear ${rec.title} from the drives?`, body: `${fmtSize(gb)} on ${mine.map((a) => getDrive(a.driveId)?.name).join(", ")} is released, so the drives show that space as free. This updates the records here. The files on the drives are not touched. Raw footage can only be cleared once it is Delivered.`, confirmLabel: "Clear from drives", danger: true })) attempt(() => clearRecordFromDrives(actor, rec.contentId), "Cleared from the drives");
                  }}
                >
                  Clear from drives
                </button>
              )}
              {write && <button className="btn small primary" onClick={() => setAssigning(true)}><IconPlus /> Assign to a drive</button>}
            </div>
            {needsDrive && write && (
              <div className="banner warn" style={{ marginBottom: 12 }}>
                <span className="grow"><b>Footage exists now.</b> Assign this to the drive it is stored on and record the space it has taken. You can update the size at any time.</span>
                <button className="btn small primary" onClick={() => setAssigning(true)}>Assign now</button>
              </div>
            )}
            {allocs.length === 0 ? <Empty>No drives are recorded for this project.</Empty> : (
              <>
                <div className="list">
                  {allocs.map((a) => {
                    const target = getRecord(a.contentId);
                    const mayEdit = !!target && canWrite(actor, target);
                    return (
                      <div key={a.id} className="list-item" title={mayEdit ? "Click to edit" : ""} onClick={() => (mayEdit ? setEditing(a) : go({ n: "drive", id: a.driveId }))}>
                        <div className="grow"><div className="title">{getDrive(a.driveId)?.name ?? a.driveId}</div><div className="muted" style={{ fontSize: ".84rem" }}>{a.contentId === rec.contentId ? "This record" : a.contentId}, {KIND[a.kind]}, updated {relativeDays(a.updatedAt)}{a.note ? `, ${a.note}` : ""}</div></div>
                        <span>{fmtSize(a.sizeGB)}</span>
                        {mayEdit && <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); setEditing(a); }}>Edit</button>}
                      </div>
                    );
                  })}
                </div>
                <p className="muted" style={{ marginTop: 8 }}>{fmtSize(total)} in total.</p>
              </>
            )}
          </section>
        )}
      </div>

      <section className="glass panel" aria-label="Documents">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <h2 style={{ flex: 1 }}>Documents</h2>
          {write && <button className="btn small" onClick={() => setNewDoc(true)}><IconPlus /> New document</button>}
        </div>
        {docs.length === 0 ? <Empty>No documents yet. They are attached when an item reaches a stage that needs one.</Empty> : (
          <div className="list">
            {docs.map((d) => (
              <div key={d.id} className="list-item" onClick={() => go({ n: "doc", id: d.id })}>
                <div className="grow"><div className="title">{d.title}</div><div className="muted" style={{ fontSize: ".84rem" }}>{d.stage ? `Attached at ${d.stage}. ` : ""}Edited {relativeDays(d.updatedAt.slice(0, 10))} by {nameOf(d.updatedBy)}</div></div>
                <span className="badge">v{d.version}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {newList && <NewCheckoutModal initialContentId={rec.contentId} onClose={() => setNewList(false)} onCreated={(m) => { setNewList(false); go({ n: "manifest", id: m.id }); }} />}
      {attaching && <AttachListModal rec={rec} onClose={() => setAttaching(false)} />}
      {assigning && <AllocationModal contentId={rec.contentId} onClose={() => setAssigning(false)} />}
      {editing && <AllocationModal row={editing} onClose={() => setEditing(null)} />}
      {newDoc && <NewDocModal contentId={rec.contentId} onClose={() => setNewDoc(false)} onCreated={(id) => { setNewDoc(false); go({ n: "doc", id }); }} />}
    </>
  );
}

/** Pick an existing checkout list by its ID and attach it to this project. */
function AttachListModal({ rec, onClose }: { rec: ContentRecord; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const options = listManifests(actor).filter((m) => m.status !== "released" && !m.callSheetId && m.contentId !== rec.contentId);
  const [id, setId] = useState(options[0]?.id ?? "");
  return (
    <Modal title="Attach a checkout list" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!id} onClick={() => { if (attempt(() => attachManifest(actor, id, rec.contentId), "Attached")) onClose(); }}>Attach</button></>}>
      {options.length === 0 ? <p className="muted">There is no other checkout list to attach. Lists made from a call sheet stay with that sheet.</p> : (
        <Field label="Checkout list">
          <select value={id} onChange={(e) => setId(e.target.value)}>{options.map((m) => <option key={m.id} value={m.id}>{m.id}, {projectLabel(actor, m.contentId)}, {fmtShort(m.date)}</option>)}</select>
        </Field>
      )}
    </Modal>
  );
}
