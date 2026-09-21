import { useMemo, useState } from "react";
import { useApp } from "./AppContext";
import { useDb } from "../data/store";
import { Modal } from "./Modal";
import { Field } from "./parts";
import { EQUIP_CATEGORIES } from "../config/equipment";
import type { EquipCategoryKey } from "../types";
import { RuleError } from "../types";
import { allocateFifo, pickerRows, type LineRequest, type PickerRow } from "../services/equipment";
import { fmtShort } from "../services/utils";

/**
 * Chooses gear for a date range. Availability is shown next to every item,
 * so a clash is visible before you pick it. Batches roll up under their item family.
 */
export function GearPicker({ from, to, excludeManifestId, alreadyOn = [], title = "Add gear", confirmLabel = "Add to list", onConfirm, onClose }: {
  from: string;
  to: string;
  excludeManifestId?: string;
  alreadyOn?: string[]; // single units already on this list
  title?: string;
  confirmLabel?: string;
  onConfirm: (lines: LineRequest[]) => void;
  onClose: () => void;
}) {
  const { attempt } = useApp();
  useDb();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<EquipCategoryKey | "">("");
  const [qty, setQty] = useState<Record<string, number>>({}); // serialized: 0/1. family: quantity.
  const [batchQty, setBatchQty] = useState<Record<string, number>>({}); // manual per-batch override
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => pickerRows(from, to, excludeManifestId), [from, to, excludeManifestId]);
  const shown = rows.filter((r) => (!cat || r.category === cat) && (!q.trim() || `${r.name} ${r.sub}`.toLowerCase().includes(q.trim().toLowerCase())));

  const picked = rows.filter((r) => (qty[r.key] ?? 0) > 0 || r.batches?.some((b) => (batchQty[b.item.id] ?? 0) > 0));

  const confirm = () => {
    const lines = attempt(() => {
      const out: LineRequest[] = [];
      for (const r of rows) {
        if (r.item) {
          if ((qty[r.key] ?? 0) > 0) out.push({ equipmentId: r.item.id, quantity: 1 });
        } else if (r.batches) {
          const manual = r.batches.filter((b) => (batchQty[b.item.id] ?? 0) > 0);
          if (manual.length) manual.forEach((b) => out.push({ equipmentId: b.item.id, quantity: batchQty[b.item.id] }));
          else if ((qty[r.key] ?? 0) > 0) out.push(...allocateFifo(r.key, qty[r.key], from, to, excludeManifestId));
        }
      }
      if (!out.length) throw new RuleError("Choose at least one item.");
      return out;
    });
    if (lines) onConfirm(lines);
  };

  const chip = (r: PickerRow) => {
    if (r.state === "ok") return <span className="badge ok">Available</span>;
    if (r.state === "partial") return <span className="badge warn">{r.batches ? `${r.availableQty} of ${r.totalQty} free` : "Partly booked"}</span>;
    if (r.state === "repair") return <span className="badge warn">In repair</span>;
    if (r.state === "conflict") return <span className="badge bad">{r.batches ? "None free" : "Booked"}</span>;
    return <span className="badge">{r.reason}</span>;
  };

  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      actions={<><span className="muted" style={{ marginRight: "auto" }}>{picked.length} chosen</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={confirm}>{confirmLabel}</button></>}
    >
      <p className="muted" style={{ marginBottom: 10 }}>Availability is for {from === to ? fmtShort(from) : `${fmtShort(from)} to ${fmtShort(to)}`}.</p>
      <div className="row" style={{ marginBottom: 10 }}>
        <Field label="Search"><input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Camera, XLR, asset code" autoFocus /></Field>
        <Field label="Category">
          <select value={cat} onChange={(e) => setCat(e.target.value as EquipCategoryKey | "")}>
            <option value="">All categories</option>
            {EQUIP_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="picker">
        {shown.length === 0 && <p className="empty">Nothing matches.</p>}
        {shown.map((r) => {
          const onList = !!r.item && alreadyOn.includes(r.item.id);
          const blocked = onList || r.state === "repair" || r.state === "retired" || r.state === "lost" || r.availableQty === 0;
          return (
            <div key={r.key} className={`picker-row ${blocked ? "blocked" : ""}`}>
              <div className="picker-main">
                {r.item ? (
                  <label className="check">
                    <input type="checkbox" disabled={blocked} checked={(qty[r.key] ?? 0) > 0} onChange={(e) => setQty({ ...qty, [r.key]: e.target.checked ? 1 : 0 })} />
                    <span><span className="t">{r.name}</span><br /><span className="cid">{r.sub}</span></span>
                  </label>
                ) : (
                  <div style={{ flex: 1 }}>
                    <span className="t">{r.name}</span><br /><span className="cid">{r.sub}</span>
                  </div>
                )}
                {r.batches && (
                  <div className="qty">
                    <input type="number" min={0} max={r.availableQty} disabled={blocked} value={qty[r.key] ?? 0} onChange={(e) => setQty({ ...qty, [r.key]: Math.max(0, Math.min(r.availableQty, Number(e.target.value) || 0)) })} aria-label={`Quantity of ${r.name}`} />
                  </div>
                )}
                {onList ? <span className="badge accent">On this list</span> : chip(r)}
              </div>
              {r.state === "conflict" && r.reason && <div className="muted" style={{ fontSize: ".82rem", marginLeft: 28 }}>{r.reason}</div>}
              {r.batches && !blocked && (
                <>
                  <button type="button" className="btn small ghost" style={{ marginLeft: 22 }} onClick={() => setOpen(open === r.key ? null : r.key)}>{open === r.key ? "Hide batches" : "Choose batches"}</button>
                  {qty[r.key] > 0 && open !== r.key && <span className="muted" style={{ fontSize: ".82rem", marginLeft: 8 }}>Oldest batch is used first.</span>}
                  {open === r.key && (
                    <div style={{ marginLeft: 22, marginTop: 6 }}>
                      {r.batches.map((b) => (
                        <div key={b.item.id} className="picker-main" style={{ padding: "4px 0" }}>
                          <div style={{ flex: 1 }}><span className="cid">{b.item.id}</span><span className="muted" style={{ fontSize: ".82rem" }}> bought {b.item.purchaseDate ? fmtShort(b.item.purchaseDate) : "unknown"}</span></div>
                          <div className="qty"><input type="number" min={0} max={b.availableQty} disabled={b.availableQty === 0} value={batchQty[b.item.id] ?? 0} onChange={(e) => setBatchQty({ ...batchQty, [b.item.id]: Math.max(0, Math.min(b.availableQty, Number(e.target.value) || 0)) })} aria-label={`Quantity from ${b.item.id}`} /></div>
                          <span className="muted" style={{ fontSize: ".82rem", minWidth: 60 }}>{b.availableQty} free</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
