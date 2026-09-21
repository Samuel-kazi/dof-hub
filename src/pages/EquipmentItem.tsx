import { useApp } from "../ui/AppContext";
import { useDb } from "../data/store";
import { equipCategory } from "../config/equipment";
import { Attachments, PhotoAdd } from "../ui/Photos";
import { Empty } from "../ui/parts";
import { addAttachment, availabilityOn, hasGearAccess, displayStatus, getItem, itemHistory, itemIncidents, manifestStatusView, projectLabel, qtyAssigned, qtyOut, removeAttachment, getManifest } from "../services/wrapped/equipment";
import { getDb } from "../data/store";
import { nameOf } from "../services/wrapped/people";
import { fmtDate, fmtShort } from "../services/utils";
import { useItemActions } from "./EquipmentForms";

export function EquipmentItemPage({ id }: { id: string }) {
  const { actor, go, back, attempt, menu } = useApp();
  useDb();
  const actions = useItemActions(back);
  const item = getItem(id);
  if (!hasGearAccess(actor)) return <div className="page"><Empty>Equipment is for crew and the Head of Production.</Empty></div>;
  if (!item) return <div className="page"><Empty>This item does not exist.</Empty></div>;

  const status = displayStatus(item);
  const cat = equipCategory(item.category);
  const history = itemHistory(id);
  const incidents = itemIncidents(id);
  const uses = getDb().manifests.filter((m) => m.lines.some((l) => l.equipmentId === id)).sort((a, b) => b.date.localeCompare(a.date));
  const out = qtyOut(item);
  const asg = qtyAssigned(item);
  const inService = item.baseStatus === "active";

  return (
    <div className="page">
      <nav className="crumbs"><button onClick={() => go({ n: "equipment" })}>Equipment</button><span aria-hidden> / </span><span>{item.name}</span></nav>
      <div className="page-head">
        <div className="grow">
          <h1>{item.name}</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
            <span className="cid">{item.id}</span>
            <span className={`badge ${status.tone}`}>{status.label}</span>
            <span className="badge">{cat.label}</span>
            <span className="badge">{item.trackingType === "serialized" ? "Single unit" : "Batch"}</span>
            {incidents.length > 0 && <span className="badge warn">{incidents.length} incident{incidents.length > 1 ? "s" : ""}</span>}
          </div>
        </div>
        <button className="btn" onClick={() => actions.setCheckout(item)} disabled={!inService}>Add to checkout list</button>
        <button className="btn" onClick={() => actions.setEdit(item)}>Edit</button>
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); menu({ clientX: e.clientX - 180, clientY: e.clientY + 8, preventDefault: () => {} }, actions.menuItems(item)); }}>More</button>
      </div>

      <div className="grid-2">
        <section className="glass panel">
          <h2>Details</h2>
          <dl className="kv">
            <dt>Make and model</dt><dd>{[item.make, item.model].filter(Boolean).join(" ") || <span className="muted">Not set</span>}</dd>
            {item.trackingType === "serialized" ? (<><dt>Serial number</dt><dd>{item.serialNumber}</dd></>) : (<><dt>Item family</dt><dd>{item.itemFamily}</dd></>)}
            <dt>Condition</dt><dd>{item.condition}</dd>
            <dt>{item.trackingType === "aggregate" ? "Cost per unit" : "Cost"}</dt><dd>{item.unitCost.toLocaleString()}</dd>
            <dt>Purchased</dt><dd>{item.purchaseDate ? fmtDate(item.purchaseDate) : <span className="muted">Not set</span>}{item.vendor ? `, ${item.vendor}` : ""}</dd>
            <dt>Packaging</dt><dd>{item.packaging || <span className="muted">Not set</span>}</dd>
            <dt>Accessories</dt><dd>{item.accessories || <span className="muted">None listed</span>}</dd>
            <dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{item.info || <span className="muted">None</span>}</dd>
          </dl>
        </section>

        {item.trackingType === "aggregate" ? (
          <section className="glass panel">
            <h2>Quantities in this batch</h2>
            <dl className="kv">
              <dt>In the batch</dt><dd>{item.quantityTotal}</dd>
              <dt>Checked out</dt><dd>{out}</dd>
              <dt>Assigned in studio</dt><dd>{asg}</dd>
              <dt>Free now</dt><dd><b>{availabilityOn(item, new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)).availableQty}</b></dd>
              <dt>Removed as damaged</dt><dd>{item.quantityDamaged}</dd>
              <dt>Removed as lost</dt><dd>{item.quantityLost}</dd>
            </dl>
            <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Damaged and lost units are taken off the count and logged against this batch.</p>
          </section>
        ) : (
          <section className="glass panel">
            <h2>Where it is</h2>
            {(() => {
              const active = uses.find((m) => m.status === "checked-out" || m.status === "assigned");
              if (item.baseStatus !== "active") return <p>{item.baseStatus === "in-repair" ? "In repair." : item.baseStatus === "lost" ? "Marked as lost." : "Retired from inventory."}</p>;
              if (!active) return <p>In the studio and free to assign.</p>;
              const s = manifestStatusView(active);
              return (
                <div className="stack">
                  <div><span className={`badge ${s.tone}`}>{s.label}</span></div>
                  <p>{projectLabel(actor, active.contentId)}, {fmtShort(active.date)}{active.expectedReturn ? ` to ${fmtShort(active.expectedReturn)}` : ""}</p>
                  <p className="muted">{nameOf(active.responsiblePersonId)} is responsible.</p>
                  <div><button className="btn small" onClick={() => go({ n: "manifest", id: active.id })}>Open checkout list</button></div>
                </div>
              );
            })()}
          </section>
        )}
      </div>

      <div className="grid-2">
        <section className="glass panel">
          <h2>Photos of its current state</h2>
          <Attachments items={item.photos} empty="No photos yet." onRemove={(aid) => attempt(() => removeAttachment(actor, id, aid))} />
          <div style={{ marginTop: 12 }}><PhotoAdd label="Take or choose a photo" onAdd={(p) => attempt(() => addAttachment(actor, id, "photo", p), "Photo added")} /></div>
        </section>
        <section className="glass panel">
          <h2>Receipts</h2>
          <Attachments items={item.receipts} empty="No receipt attached." onRemove={(aid) => attempt(() => removeAttachment(actor, id, aid))} />
          <div style={{ marginTop: 12 }}><PhotoAdd label="Photograph a receipt" onAdd={(p) => attempt(() => addAttachment(actor, id, "receipt", p), "Receipt attached")} /></div>
        </section>
      </div>

      <section className="glass panel">
        <h2>Damage and loss</h2>
        {incidents.length === 0 ? <Empty>Nothing has been reported.</Empty> : (
          <div className="list">
            {incidents.map((i) => (
              <div key={i.id} className="list-item" style={{ cursor: "default" }}>
                <div className="grow">
                  <div><span className={`badge ${i.type === "loss" ? "bad" : "warn"}`}>{i.type === "loss" ? "Lost" : "Damaged"}{i.quantity > 1 ? ` x ${i.quantity}` : ""}</span> {i.description}</div>
                  <div className="muted" style={{ fontSize: ".84rem" }}>{fmtDate(i.at)}, {nameOf(i.personId)} had it on {projectLabel(actor, i.contentId)}</div>
                </div>
                <button className="btn small ghost" onClick={() => go({ n: "manifest", id: i.manifestId })}>Checkout list</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="glass panel">
        <h2>History</h2>
        {history.length === 0 ? <Empty>No history yet.</Empty> : (
          <table className="table">
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className={h.manifestId ? "clickable" : ""} onClick={() => h.manifestId && getManifest(h.manifestId) && go({ n: "manifest", id: h.manifestId })}>
                  <td className="muted" style={{ whiteSpace: "nowrap", width: 130 }}>{fmtDate(h.at)}</td>
                  <td style={{ width: 130 }}><span className="badge">{historyLabel(h.kind)}</span></td>
                  <td>{h.detail}</td>
                  <td className="muted" style={{ width: 150 }}>{nameOf(h.byPersonId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {actions.modals}
    </div>
  );
}

const historyLabel = (k: string): string => ({ created: "Added", assigned: "Assigned", released: "Released", "checked-out": "Checked out", "checked-in": "Checked in", incident: "Incident", "repair-start": "To repair", "repair-end": "Repaired", retired: "Retired", lost: "Lost", edited: "Edited", photo: "Photo" }[k] ?? k);
