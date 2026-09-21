import { useState } from "react";
import { ReportButton } from "../ui/ReportDialog";
import type { EquipCategoryKey, EquipmentItem } from "../types";
import { useApp } from "../ui/AppContext";
import { useDb } from "../data/store";
import { EQUIP_CATEGORIES, equipCategory } from "../config/equipment";
import { Empty, Field } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import {
  allIncidents, displayStatus, hasGearAccess, groupByFamily, isOverdue, listManifests, manifestStatusView, manifestSummary, projectLabel, qtyAssigned, qtyOut, type Family,
} from "../services/equipment";
import { getDb } from "../data/store";
import { nameOf } from "../services/people";
import { fmtDate, fmtShort, relativeDays, todayIso, daysUntil } from "../services/utils";
import { ItemFormModal, NewCheckoutModal, useItemActions } from "./EquipmentForms";

type Tab = "inventory" | "checkouts" | "incidents";
const statusKey = (i: EquipmentItem): string => (i.baseStatus === "in-repair" ? "repair" : i.baseStatus !== "active" ? "retired" : qtyOut(i) > 0 ? "out" : qtyAssigned(i) > 0 ? "assigned" : "available");

export function Equipment({ tab: initial }: { tab?: Tab }) {
  const { actor, go } = useApp();
  useDb();
  const [tab, setTab] = useState<Tab>(initial ?? "inventory");
  const [adding, setAdding] = useState(false);
  const [checkout, setCheckout] = useState(false);
  const actions = useItemActions();
  if (!hasGearAccess(actor)) return <div className="page"><Empty>Equipment is for crew and the Head of Production.</Empty></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Equipment</h1>
          <p className="sub">Every item and every checkout list, tied to the project it was used on.</p>
        </div>
        <div className="seg" role="tablist">
          {(["inventory", "checkouts", "incidents"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "inventory" ? "Inventory" : t === "checkouts" ? "Checkout lists" : "Damage log"}</button>
          ))}
        </div>
        <ReportButton scope="equipment" label="Reports…" />
        <button className="btn" onClick={() => setCheckout(true)}>New checkout</button>
        <button className="btn primary" onClick={() => setAdding(true)}><IconPlus /> Add item</button>
      </div>
      {tab === "inventory" && <Inventory actions={actions} />}
      {tab === "checkouts" && <Checkouts />}
      {tab === "incidents" && <Incidents />}
      {actions.modals}
      {adding && <ItemFormModal onClose={() => setAdding(false)} onSaved={(i) => { setAdding(false); go({ n: "item", id: i.id }); }} />}
      {checkout && <NewCheckoutModal onClose={() => setCheckout(false)} onCreated={(m) => { setCheckout(false); go({ n: "manifest", id: m.id }); }} />}
    </div>
  );
}

function Inventory({ actions }: { actions: ReturnType<typeof useItemActions> }) {
  const { go, menu } = useApp();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<EquipCategoryKey | "">("");
  const [st, setSt] = useState("");
  const [openFam, setOpenFam] = useState<Set<string>>(new Set());
  const all = getDb().equipment;
  const match = (i: EquipmentItem) => (!cat || i.category === cat) && (!st || statusKey(i) === st) && (!q.trim() || `${i.name} ${i.make} ${i.model} ${i.id} ${i.serialNumber ?? ""} ${i.itemFamily ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const serialized = all.filter((i) => i.trackingType === "serialized" && match(i));
  const families = groupByFamily(all).map((f) => ({ ...f, items: f.items.filter(match) })).filter((f) => f.items.length);
  const rows: { key: string; sortName: string; render: () => JSX.Element[] }[] = [
    ...serialized.map((i) => ({ key: i.id, sortName: i.name, render: () => [itemRow(i)] })),
    ...families.map((f) => ({ key: f.key, sortName: f.name, render: () => familyRows(f) })),
  ].sort((a, b) => a.sortName.localeCompare(b.sortName));

  function statusBadge(i: EquipmentItem) {
    const s = displayStatus(i);
    return <span className={`badge ${s.tone}`}>{s.label}</span>;
  }
  function itemRow(i: EquipmentItem, sub = false) {
    return (
      <tr key={i.id} className={`clickable ${sub ? "sub-row" : ""}`} onClick={() => go({ n: "item", id: i.id })} onContextMenu={(e) => menu(e, actions.menuItems(i))}>
        <td><span className="cid">{i.id}</span></td>
        <td>{sub ? <span className="muted">Bought {i.purchaseDate ? fmtShort(i.purchaseDate) : "unknown"}{i.vendor ? `, ${i.vendor}` : ""}</span> : <><div>{i.name}</div><div className="muted" style={{ fontSize: ".82rem" }}>{[i.make, i.model].filter(Boolean).join(" ")}</div></>}</td>
        <td>{sub ? "" : equipCategory(i.category).label}</td>
        <td>{i.trackingType === "aggregate" ? `${i.quantityTotal}` : "1"}</td>
        <td>{i.condition}</td>
        <td>{statusBadge(i)}{displayStatus(i).detail && i.trackingType === "aggregate" && <span className="muted" style={{ fontSize: ".8rem", marginLeft: 6 }}>{displayStatus(i).detail}</span>}</td>
      </tr>
    );
  }
  function familyRows(f: Family & { items: EquipmentItem[] }) {
    const open = openFam.has(f.key);
    const total = f.items.reduce((n, i) => n + i.quantityTotal, 0);
    const free = f.items.reduce((n, i) => n + (i.baseStatus === "active" ? Math.max(0, i.quantityTotal - qtyOut(i) - qtyAssigned(i)) : 0), 0);
    const head = (
      <tr key={f.key} className="clickable fam-row" onClick={() => setOpenFam((s) => { const n = new Set(s); n.has(f.key) ? n.delete(f.key) : n.add(f.key); return n; })}>
        <td><span className="cid">{f.key}</span></td>
        <td><div>{f.name}</div><div className="muted" style={{ fontSize: ".82rem" }}>{f.items.length} batch{f.items.length === 1 ? "" : "es"}. Click to {open ? "hide" : "show"} them.</div></td>
        <td>{equipCategory(f.category).label}</td>
        <td>{total}</td>
        <td>Mixed</td>
        <td><span className={`badge ${free > 0 ? "ok" : "accent"}`}>{free} of {total} free</span></td>
      </tr>
    );
    return [head, ...(open ? f.items.map((i) => itemRow(i, true)) : [])];
  }

  return (
    <section className="glass panel">
      <div className="row" style={{ marginBottom: 14, alignItems: "end" }}>
        <Field label="Search"><input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, make, serial or asset code" /></Field>
        <Field label="Category"><select value={cat} onChange={(e) => setCat(e.target.value as EquipCategoryKey | "")}><option value="">All categories</option>{EQUIP_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
        <Field label="Status">
          <select value={st} onChange={(e) => setSt(e.target.value)}>
            <option value="">Any status</option><option value="available">Available</option><option value="assigned">Assigned in studio</option><option value="out">Checked out</option><option value="repair">In repair</option><option value="retired">Retired or lost</option>
          </select>
        </Field>
      </div>
      {rows.length === 0 ? <Empty>Nothing matches. Adjust the filters or add an item.</Empty> : (
        <table className="table">
          <thead><tr><th>Asset code</th><th>Item</th><th>Category</th><th>Qty</th><th>Condition</th><th>Status</th></tr></thead>
          <tbody>{rows.flatMap((r) => r.render())}</tbody>
        </table>
      )}
      <p className="muted" style={{ marginTop: 10, fontSize: ".84rem" }}>Right-click an item to edit, send to repair, retire or delete it.</p>
    </section>
  );
}

function Checkouts() {
  const { actor, go } = useApp();
  const [showAll, setShowAll] = useState(false);
  const all = listManifests(actor);
  const rows = showAll ? all : all.filter((m) => m.status === "assigned" || m.status === "checked-out");
  return (
    <section className="glass panel">
      <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include returned and released lists</label>
      {rows.length === 0 ? <Empty>No active checkout lists.</Empty> : (
        <table className="table">
          <thead><tr><th>List</th><th>Project</th><th>Dates</th><th>Person responsible</th><th>Items</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((m) => {
              const s = manifestStatusView(m);
              return (
                <tr key={m.id} className="clickable" onClick={() => go({ n: "manifest", id: m.id })}>
                  <td><span className="cid">{m.id}</span><div className="muted" style={{ fontSize: ".82rem" }}>{m.destination === "outside" ? "Leaving the studio" : "In the studio"}</div></td>
                  <td>{projectLabel(actor, m.contentId)}<div className="cid">{m.contentId}</div></td>
                  <td>{fmtShort(m.date)}{m.expectedReturn ? ` to ${fmtShort(m.expectedReturn)}` : ""}{isOverdue(m) && <div className="badge bad" style={{ marginTop: 4 }}>{-daysUntil(m.expectedReturn!)} days late</div>}</td>
                  <td>{nameOf(m.responsiblePersonId)}</td>
                  <td>{manifestSummary(m)}</td>
                  <td><span className={`badge ${s.tone}`}>{s.label}</span></td>
                  <td><ReportButton scope="manifest" params={{ manifestId: m.id }} label="Print or download" small ghost /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Incidents() {
  const { actor, go } = useApp();
  const rows = allIncidents();
  return (
    <section className="glass panel">
      {rows.length === 0 ? <Empty>Nothing has been damaged or lost.</Empty> : (
        <table className="table">
          <thead><tr><th>When</th><th>Item</th><th>What happened</th><th>Who had it</th><th>Project</th></tr></thead>
          <tbody>
            {rows.map((i) => {
              const item = getDb().equipment.find((e) => e.id === i.equipmentId);
              return (
                <tr key={i.id} className="clickable" onClick={() => go({ n: "item", id: i.equipmentId })}>
                  <td>{fmtDate(i.at)}<div className="muted" style={{ fontSize: ".82rem" }}>{relativeDays(i.at.slice(0, 10))}</div></td>
                  <td>{item?.name ?? i.equipmentId}<div className="cid">{i.equipmentId}</div></td>
                  <td><span className={`badge ${i.type === "loss" ? "bad" : "warn"}`}>{i.type === "loss" ? "Lost" : "Damaged"}{i.quantity > 1 ? ` x ${i.quantity}` : ""}</span><div style={{ marginTop: 4 }}>{i.description}</div></td>
                  <td>{nameOf(i.personId)}</td>
                  <td>{projectLabel(actor, i.contentId)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
