import React, { useState } from "react";
import { ReportButton } from "../ui/ReportDialog";
import type { EquipCondition, Manifest } from "../types";
import { useApp } from "../ui/AppContext";
import { useDb } from "../data/store";
import { CONDITIONS, EQUIP_CATEGORIES } from "../config/equipment";
import { Modal } from "../ui/Modal";
import { Attachments, PhotoList } from "../ui/Photos";
import { Empty, Field } from "../ui/parts";
import { GearPicker } from "../ui/GearPicker";
import { canWrite, getRecord } from "../services/access";
import {
  addLines, checkIn, hasGearAccess, getItem, getManifest, goneOutDefaults, isOverdue, manifestStatusView, markGoneOut, projectLabel, releaseManifest, removeLine, type PhotoInput, type ReturnInput,
} from "../services/wrapped/equipment";
import { getDb } from "../data/store";
import { nameOf } from "../services/wrapped/people";
import { daysUntil, fmtDate, fmtDateTime } from "../services/utils";

export function ManifestPage({ id }: { id: string }) {
  const { actor, go, attempt, confirm } = useApp();
  useDb();
  const [going, setGoing] = useState(false);
  const [returning, setReturning] = useState(false);
  const [adding, setAdding] = useState(false);
  const m = getManifest(id);
  if (!hasGearAccess(actor)) return <div className="page"><Empty>Equipment is for crew and the Head of Production.</Empty></div>;
  if (!m) return <div className="page"><Empty>This checkout list does not exist.</Empty></div>;
  const rec = getRecord(m.contentId);
  const write = rec ? canWrite(actor, rec) : false;
  const s = manifestStatusView(m);
  const overdue = isOverdue(m);

  return (
    <div className="page">
      <nav className="crumbs no-print"><button onClick={() => go({ n: "equipment", tab: "checkouts" })}>Checkout lists</button><span aria-hidden> / </span><span>{m.id}</span></nav>
      <div className="page-head">
        <div className="grow">
          <h1>Checkout list {m.id}</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
            <span className={`badge ${s.tone}`}>{s.label}</span>
            <span className="badge">{m.destination === "outside" ? "Leaving the studio" : "Used in the studio"}</span>
            <button className="badge accent no-print" style={{ cursor: "pointer" }} onClick={() => rec && go({ n: "record", id: m.contentId })}>{projectLabel(actor, m.contentId)}</button>
            <span className="cid">{m.contentId}</span>
          </div>
        </div>
        <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ReportButton scope="manifest" params={{ manifestId: m.id }} label="Print or download" />
          {write && m.status === "assigned" && <button className="btn" onClick={() => setAdding(true)}>Add gear</button>}
          {write && m.status === "assigned" && <button className="btn" onClick={async () => { if (await confirm({ title: "Release this list?", body: "The gear goes back to free without ever leaving the studio.", confirmLabel: "Release" })) attempt(() => releaseManifest(actor, m.id), "Released"); }}>Release</button>}
          {write && m.status === "assigned" && <button className="btn primary" onClick={() => setGoing(true)}>Mark as gone out</button>}
          {write && m.status === "checked-out" && <button className="btn primary" onClick={() => setReturning(true)}>Check in</button>}
        </div>
      </div>

      {overdue && <div className="banner bad" role="alert"><span className="grow"><b>{-daysUntil(m.expectedReturn!)} days overdue.</b> Expected back {fmtDate(m.expectedReturn)}. {nameOf(m.responsiblePersonId)} is responsible.</span></div>}
      {m.callSheetId && <div className="banner no-print"><span className="grow">Created from a call sheet for this shoot.</span><button className="btn small" onClick={() => go({ n: "callsheet", id: m.callSheetId! })}>Open call sheet</button></div>}

      <section className="glass panel">
        <dl className="kv">
          <dt>Person responsible</dt><dd>{nameOf(m.responsiblePersonId)}</dd>
          <dt>{m.destination === "outside" ? "Out from" : "Shoot date"}</dt><dd>{fmtDate(m.date)}</dd>
          {m.expectedReturn && <><dt>Expected back</dt><dd>{fmtDate(m.expectedReturn)}</dd></>}
          {m.checkedOutAt && <><dt>Left the studio</dt><dd>{fmtDateTime(m.checkedOutAt)}</dd></>}
          {m.returnedAt && <><dt>Checked in</dt><dd>{fmtDateTime(m.returnedAt)}</dd></>}
          {m.notes && <><dt>Notes</dt><dd>{m.notes}</dd></>}
        </dl>
      </section>

      <section className="glass panel">
        <h2>Items</h2>
        {m.lines.length === 0 ? <Empty>No items on this list.</Empty> : (
          <table className="table">
            <thead><tr><th>Item</th><th>Make/Model</th><th>Qty</th><th>Condition out</th><th>Photos out</th><th>Accessories</th><th>Info</th>{m.status === "returned" && <><th>Came back</th><th>Photos in</th></>}{write && m.status === "assigned" && <th className="no-print"></th>}</tr></thead>
            <tbody>
              {(() => {
                const catLabel = (key: string | undefined) => EQUIP_CATEGORIES.find((c) => c.key === key)?.label ?? "Other";
                const sorted = [...m.lines].sort((a, b) => catLabel(getItem(a.equipmentId)?.category).localeCompare(catLabel(getItem(b.equipmentId)?.category)));
                const colSpan = 7 + (m.status === "returned" ? 2 : 0) + (write && m.status === "assigned" ? 1 : 0);
                let lastCat = "";
                return sorted.map((l) => {
                const item = getItem(l.equipmentId);
                const cat = catLabel(item?.category);
                const heading = cat !== lastCat;
                lastCat = cat;
                return (
                  <React.Fragment key={l.equipmentId}>
                  {heading && <tr className="table-group"><td colSpan={colSpan}>{cat}</td></tr>}
                  <tr>
                    <td><div>{item?.name ?? l.equipmentId}</div><span className="cid">{l.equipmentId}</span></td>
                    <td>{[item?.make, item?.model].filter(Boolean).join(" ") || <span className="muted">—</span>}</td>
                    <td>{l.quantity}</td>
                    <td>{l.conditionOut}</td>
                    <td><Attachments items={l.photosOut} empty="None" /></td>
                    <td>{item?.accessories || <span className="muted">None listed</span>}</td>
                    <td style={{ maxWidth: 220 }}>{item?.info || <span className="muted">None</span>}</td>
                    {m.status === "returned" && (
                      <>
                        <td>
                          {l.damaged > 0 && <span className="badge warn">Damaged{l.damaged > 1 ? ` x ${l.damaged}` : ""}</span>} {l.lost > 0 && <span className="badge bad">Lost{l.lost > 1 ? ` x ${l.lost}` : ""}</span>} {l.returnedGood > 0 && <span className="badge ok">Back{l.returnedGood > 1 ? ` x ${l.returnedGood}` : ""}</span>}
                          {l.conditionIn && <div className="muted" style={{ fontSize: ".82rem", marginTop: 4 }}>Condition {l.conditionIn}</div>}
                        </td>
                        <td><Attachments items={l.photosIn} empty="None" /></td>
                      </>
                    )}
                    {write && m.status === "assigned" && <td className="no-print"><button className="btn small ghost" onClick={() => attempt(() => removeLine(actor, m.id, l.equipmentId), "Removed")}>Remove</button></td>}
                  </tr>
                  </React.Fragment>
                );
                });
              })()}
            </tbody>
          </table>
        )}
      </section>

      <div className="signoff" aria-hidden="true">
        <div>Released by: ______________________ Date: __________</div>
        <div>Received by: ______________________ Date: __________</div>
      </div>

      {going && <GoneOutModal manifest={m} onClose={() => setGoing(false)} />}
      {returning && <CheckInModal manifest={m} onClose={() => setReturning(false)} />}
      {adding && <GearPicker from={m.date} to={m.expectedReturn ?? m.date} excludeManifestId={m.id} alreadyOn={m.lines.map((l) => l.equipmentId)} onClose={() => setAdding(false)} onConfirm={(lines) => { if (attempt(() => addLines(actor, m.id, lines), "Added")) setAdding(false); }} />}
    </div>
  );
}

function GoneOutModal({ manifest, onClose }: { manifest: Manifest; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const crew = getDb().people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"));
  const [ret, setRet] = useState(goneOutDefaults(manifest));
  const [who, setWho] = useState(manifest.responsiblePersonId);
  const [photos, setPhotos] = useState<Record<string, PhotoInput[]>>({});
  const save = () => { if (attempt(() => markGoneOut(actor, manifest.id, { expectedReturn: ret, responsiblePersonId: who, photos }), "Marked as gone out")) onClose(); };
  return (
    <Modal title="Gear is leaving the studio" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Mark as gone out</button></>}>
      <div className="stack">
        <div className="row">
          <Field label="Expected back"><input type="date" value={ret} onChange={(e) => setRet(e.target.value)} /></Field>
          <Field label="Person responsible"><select value={who} onChange={(e) => setWho(e.target.value)}>{crew.map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}</select></Field>
        </div>
        <p className="muted">Take a photo of each item as it leaves. Each photo is timestamped and stored with this checkout, so condition can be compared when it comes back.</p>
        {manifest.lines.map((l) => (
          <div key={l.equipmentId} className="glass" style={{ padding: 12 }}>
            <b>{getItem(l.equipmentId)?.name}{l.quantity > 1 ? ` x ${l.quantity}` : ""}</b> <span className="cid">{l.equipmentId}</span>
            <div style={{ marginTop: 8 }}><PhotoList value={photos[l.equipmentId] ?? []} onChange={(v) => setPhotos({ ...photos, [l.equipmentId]: v })} label="Take or choose a photo" /></div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

interface RetState { outcome: "good" | "damaged" | "lost"; cond: EquipCondition; desc: string; repair: boolean; good: string; damaged: string; lost: string; photos: PhotoInput[] }

function CheckInModal({ manifest, onClose }: { manifest: Manifest; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const init = (): Record<string, RetState> =>
    Object.fromEntries(manifest.lines.map((l) => [l.equipmentId, { outcome: "good", cond: l.conditionOut, desc: "", repair: false, good: String(l.quantity), damaged: "0", lost: "0", photos: [] }]));
  const [state, setState] = useState<Record<string, RetState>>(init);
  const patch = (id: string, p: Partial<RetState>) => setState((s) => ({ ...s, [id]: { ...s[id], ...p } }));

  const save = () => {
    const returns: ReturnInput[] = manifest.lines.map((l) => {
      const st = state[l.equipmentId];
      const item = getItem(l.equipmentId);
      if (item?.trackingType === "aggregate") return { equipmentId: l.equipmentId, returnedGood: Number(st.good), damaged: Number(st.damaged), lost: Number(st.lost), description: st.desc, photos: st.photos };
      return { equipmentId: l.equipmentId, returnedGood: st.outcome === "good" ? 1 : 0, damaged: st.outcome === "damaged" ? 1 : 0, lost: st.outcome === "lost" ? 1 : 0, conditionIn: st.outcome === "lost" ? undefined : st.cond, description: st.desc, sendToRepair: st.repair, photos: st.photos };
    });
    if (attempt(() => checkIn(actor, manifest.id, returns), "Checked in")) onClose();
  };

  return (
    <Modal title="Check gear back in" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Complete check-in</button></>}>
      <div className="stack">
        <p className="muted">Record how each item came back. Photograph anything that has changed since it left. A drop in condition is logged as damage.</p>
        {manifest.lines.map((l) => {
          const item = getItem(l.equipmentId);
          const st = state[l.equipmentId];
          const agg = item?.trackingType === "aggregate";
          const worse = !agg && st.outcome === "good" && CONDITIONS.indexOf(st.cond) > CONDITIONS.indexOf(l.conditionOut);
          const needsDesc = agg ? Number(st.damaged) + Number(st.lost) > 0 : st.outcome !== "good" || worse;
          return (
            <div key={l.equipmentId} className="glass" style={{ padding: 12 }}>
              <div><b>{item?.name}{l.quantity > 1 ? ` x ${l.quantity}` : ""}</b> <span className="cid">{l.equipmentId}</span></div>
              <div className="muted" style={{ fontSize: ".82rem" }}>Left in {l.conditionOut} condition{l.photosOut.length ? `, ${l.photosOut.length} photo${l.photosOut.length > 1 ? "s" : ""}` : ", no photo"}</div>
              <div className="stack" style={{ marginTop: 10 }}>
                {agg ? (
                  <div className="row">
                    <Field label="Returned fine"><input type="text" inputMode="numeric" value={st.good} onChange={(e) => patch(l.equipmentId, { good: e.target.value })} /></Field>
                    <Field label="Damaged"><input type="text" inputMode="numeric" value={st.damaged} onChange={(e) => patch(l.equipmentId, { damaged: e.target.value })} /></Field>
                    <Field label="Lost"><input type="text" inputMode="numeric" value={st.lost} onChange={(e) => patch(l.equipmentId, { lost: e.target.value })} /></Field>
                  </div>
                ) : (
                  <>
                    <div className="seg" role="group" aria-label="Outcome">
                      {(["good", "damaged", "lost"] as const).map((o) => <button key={o} type="button" className={st.outcome === o ? "on" : ""} onClick={() => patch(l.equipmentId, { outcome: o })}>{o === "good" ? "Came back" : o === "damaged" ? "Damaged" : "Lost"}</button>)}
                    </div>
                    {st.outcome !== "lost" && <Field label="Condition now"><select value={st.cond} onChange={(e) => patch(l.equipmentId, { cond: e.target.value as EquipCondition })}>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select></Field>}
                    {worse && <div className="banner warn">This is worse than when it left, so it will be logged as damage.</div>}
                    {st.outcome === "damaged" && <label className="check"><input type="checkbox" checked={st.repair} onChange={(e) => patch(l.equipmentId, { repair: e.target.checked })} /> Send to repair</label>}
                  </>
                )}
                {needsDesc && <Field label="What happened?"><textarea value={st.desc} onChange={(e) => patch(l.equipmentId, { desc: e.target.value })} /></Field>}
                <PhotoList value={st.photos} onChange={(v) => patch(l.equipmentId, { photos: v })} label="Photo at check-in" />
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
