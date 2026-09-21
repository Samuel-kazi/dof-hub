import { useState } from "react";
import { can } from "../services/permissions";
import type { EquipCategoryKey, EquipCondition, EquipmentItem, Manifest, TrackingType } from "../types";
import { useApp, type MenuItem } from "../ui/AppContext";
import { getDb } from "../data/store";
import { CONDITIONS, EQUIP_CATEGORIES, equipCategory } from "../config/equipment";
import { Modal } from "../ui/Modal";
import { PromptModal } from "../ui/Prompt";
import { Field } from "../ui/parts";
import { GearPicker } from "../ui/GearPicker";
import { canWrite, isHop } from "../services/access";
import { addDays, createItem, createManifest, deleteItem, finishRepair, getItem, reinstateItem, retireItem, startRepair, updateItem, type LineRequest } from "../services/equipment";
import { todayIso } from "../services/utils";
import { IconPlus } from "../ui/Icons";

const numOrNaN = (s: string) => (s.trim() === "" ? NaN : Number(s));

export function ItemFormModal({ item, onClose, onSaved }: { item?: EquipmentItem; onClose: () => void; onSaved: (i: EquipmentItem) => void }) {
  const { actor, attempt } = useApp();
  const editing = !!item;
  const [category, setCategory] = useState<EquipCategoryKey>(item?.category ?? "camera");
  const [tracking, setTracking] = useState<TrackingType>(item?.trackingType ?? equipCategory("camera").defaultTracking);
  const [touchedTracking, setTouchedTracking] = useState(false);
  const [name, setName] = useState(item?.name ?? "");
  const [make, setMake] = useState(item?.make ?? "");
  const [model, setModel] = useState(item?.model ?? "");
  const [serial, setSerial] = useState(item?.serialNumber ?? "");
  const [family, setFamily] = useState(item?.itemFamily ?? "");
  const [quantity, setQuantity] = useState(String(item?.quantityTotal ?? 1));
  const [cost, setCost] = useState(String(item?.unitCost ?? ""));
  const [bought, setBought] = useState(item?.purchaseDate ?? "");
  const [vendor, setVendor] = useState(item?.vendor ?? "");
  const [condition, setCondition] = useState<EquipCondition>(item?.condition ?? "Good");
  const [packaging, setPackaging] = useState(item?.packaging ?? "");
  const [accessories, setAccessories] = useState(item?.accessories ?? "");
  const [info, setInfo] = useState(item?.info ?? "");

  const pickCategory = (c: EquipCategoryKey) => {
    setCategory(c);
    if (!touchedTracking && !editing) setTracking(equipCategory(c).defaultTracking);
  };

  const save = () => {
    const saved = attempt(() => {
      const unitCost = numOrNaN(cost === "" ? "0" : cost);
      if (editing) {
        return updateItem(actor, item!.id, { name, make, model, vendor, packaging, accessories, info, unitCost, purchaseDate: bought || null, condition, ...(item!.trackingType === "serialized" ? { serialNumber: serial } : { quantityTotal: Number(quantity) }) });
      }
      return createItem(actor, { trackingType: tracking, name, make, model, category, itemFamily: family, serialNumber: serial, quantity: Number(quantity), unitCost, purchaseDate: bought || null, vendor, condition, packaging, accessories, info });
    }, editing ? "Saved" : "Added to inventory");
    if (saved) onSaved(saved);
  };

  return (
    <Modal title={editing ? `Edit ${item!.name}` : "Add equipment"} onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>{editing ? "Save changes" : "Add item"}</button></>}>
      <div className="stack">
        {!editing && (
          <>
            <Field label="Category">
              <select value={category} onChange={(e) => pickCategory(e.target.value as EquipCategoryKey)}>{EQUIP_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            </Field>
            <div>
              <div className="seg" role="group" aria-label="Tracking">
                <button type="button" className={tracking === "serialized" ? "on" : ""} onClick={() => { setTracking("serialized"); setTouchedTracking(true); }}>One unit at a time</button>
                <button type="button" className={tracking === "aggregate" ? "on" : ""} onClick={() => { setTracking("aggregate"); setTouchedTracking(true); }}>Batch of identical items</button>
              </div>
              <p className="muted" style={{ marginTop: 6, fontSize: ".84rem" }}>{tracking === "serialized" ? "Each unit gets its own asset code and serial number. Best for cameras, mics and lights." : "One row per purchase. Best for cables and small accessories. Each purchase keeps its own cost and history."}</p>
            </div>
          </>
        )}
        <Field label="Item name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={tracking === "aggregate" ? "XLR cable 10 m" : "Sony FX3 camera body"} /></Field>
        <div className="row">
          <Field label="Make"><input type="text" value={make} onChange={(e) => setMake(e.target.value)} /></Field>
          <Field label="Model"><input type="text" value={model} onChange={(e) => setModel(e.target.value)} /></Field>
        </div>
        {(editing ? item!.trackingType : tracking) === "serialized" ? (
          <Field label="Serial number"><input type="text" value={serial} onChange={(e) => setSerial(e.target.value)} /></Field>
        ) : (
          <div className="row">
            {!editing && <Field label="Item family (groups batches)"><input type="text" value={family} onChange={(e) => setFamily(e.target.value)} placeholder="XLR-10M" /></Field>}
            <Field label="Quantity in this batch"><input type="text" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
          </div>
        )}
        <div className="row">
          <Field label={(editing ? item!.trackingType : tracking) === "aggregate" ? "Cost per unit" : "Cost"}><input type="text" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
          <Field label="Purchase date"><input type="date" value={bought} onChange={(e) => setBought(e.target.value)} /></Field>
        </div>
        <div className="row">
          <Field label="Vendor"><input type="text" value={vendor} onChange={(e) => setVendor(e.target.value)} /></Field>
          <Field label="Condition"><select value={condition} onChange={(e) => setCondition(e.target.value as EquipCondition)}>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select></Field>
        </div>
        <Field label="Packaging"><input type="text" value={packaging} onChange={(e) => setPackaging(e.target.value)} placeholder="Case, bag or box it lives in" /></Field>
        <Field label="Accessories included"><input type="text" value={accessories} onChange={(e) => setAccessories(e.target.value)} placeholder="Batteries, charger, cage" /></Field>
        <Field label="Additional information"><textarea value={info} onChange={(e) => setInfo(e.target.value)} /></Field>
        {!editing && <p className="muted">The asset code is generated when you save and never changes.</p>}
      </div>
    </Modal>
  );
}

/** Reserve or check out gear for a project. Availability is checked against the chosen dates. */
export function NewCheckoutModal({ initialLines, initialContentId, onClose, onCreated }: { initialLines?: LineRequest[]; initialContentId?: string; onClose: () => void; onCreated: (m: Manifest) => void }) {
  const { actor, attempt } = useApp();
  const projects = getDb().records.filter((r) => !r.archived && canWrite(actor, r)).sort((a, b) => a.contentId.localeCompare(b.contentId));
  const crew = getDb().people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"));
  const [contentId, setContentId] = useState(initialContentId ?? projects[0]?.contentId ?? "");
  const [destination, setDestination] = useState<"studio" | "outside">("outside");
  const [date, setDate] = useState(todayIso());
  const [ret, setRet] = useState(addDays(todayIso(), getDb().settings.checkoutReturnDays));
  const [responsible, setResponsible] = useState(actor.personId);
  const [lines, setLines] = useState<LineRequest[]>(initialLines ?? []);
  const [notes, setNotes] = useState("");
  const [picking, setPicking] = useState(false);

  const to = destination === "outside" ? ret || date : date;
  const create = (status: "assigned" | "checked-out") => {
    const m = attempt(() => createManifest(actor, { contentId, date, destination, status, expectedReturn: destination === "outside" ? ret : null, responsiblePersonId: responsible, lines, notes }), status === "checked-out" ? "Checked out" : "Reserved");
    if (m) onCreated(m);
  };
  const merge = (add: LineRequest[]) => {
    const map = new Map(lines.map((l) => [l.equipmentId, l.quantity]));
    for (const l of add) map.set(l.equipmentId, (map.get(l.equipmentId) ?? 0) + l.quantity);
    setLines([...map].map(([equipmentId, quantity]) => ({ equipmentId, quantity })));
    setPicking(false);
  };

  return (
    <Modal title="New checkout list" wide onClose={onClose} actions={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => create("assigned")}>{destination === "studio" ? "Assign in studio" : "Reserve for later"}</button>
        {destination === "outside" && <button className="btn primary" onClick={() => create("checked-out")}>Check out now</button>}
      </>
    }>
      <div className="stack">
        <Field label="Project (every list is tied to a Content ID)">
          <select value={contentId} onChange={(e) => setContentId(e.target.value)}>{projects.map((p) => <option key={p.contentId} value={p.contentId}>{p.title}, {p.contentId}</option>)}</select>
        </Field>
        <div className="seg" role="group" aria-label="Where is the gear going">
          <button type="button" className={destination === "outside" ? "on" : ""} onClick={() => setDestination("outside")}>Leaving the studio</button>
          <button type="button" className={destination === "studio" ? "on" : ""} onClick={() => setDestination("studio")}>Used in the studio</button>
        </div>
        <div className="row">
          <Field label={destination === "outside" ? "Out from" : "Shoot date"}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          {destination === "outside" && <Field label="Expected back"><input type="date" value={ret} onChange={(e) => setRet(e.target.value)} /></Field>}
        </div>
        <Field label="Person responsible"><select value={responsible} onChange={(e) => setResponsible(e.target.value)}>{crew.map((p) => <option key={p.personId} value={p.personId}>{p.name}</option>)}</select></Field>
        <div>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <b style={{ flex: 1 }}>Gear ({lines.length})</b>
            <button type="button" className="btn small" onClick={() => setPicking(true)} disabled={!date}><IconPlus /> Add gear</button>
          </div>
          {lines.length === 0 ? <p className="muted">Nothing added yet.</p> : lines.map((l) => (
            <div key={l.equipmentId} className="picker-main" style={{ padding: "5px 0" }}>
              <div style={{ flex: 1 }}>{getItem(l.equipmentId)?.name}{l.quantity > 1 ? ` x ${l.quantity}` : ""} <span className="cid">{l.equipmentId}</span></div>
              <button type="button" className="btn small ghost" onClick={() => setLines(lines.filter((x) => x.equipmentId !== l.equipmentId))}>Remove</button>
            </div>
          ))}
        </div>
        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <p className="muted">Reserving keeps gear in the studio for that shoot. Checking out records that it has left the building.</p>
      </div>
      {picking && <GearPicker from={date} to={to} onConfirm={merge} onClose={() => setPicking(false)} confirmLabel="Add to list" />}
    </Modal>
  );
}

/** Menu actions and their dialogs, shared by the inventory list and the item page. */
export function useItemActions(onDeleted?: () => void) {
  const { actor, go, confirm, attempt } = useApp();
  const [edit, setEdit] = useState<EquipmentItem | null>(null);
  const [repair, setRepair] = useState<EquipmentItem | null>(null);
  const [back, setBack] = useState<EquipmentItem | null>(null);
  const [retire, setRetire] = useState<{ item: EquipmentItem; kind: "retired" | "lost" } | null>(null);
  const [checkout, setCheckout] = useState<EquipmentItem | null>(null);
  const [backCond, setBackCond] = useState<EquipCondition>("Good");
  const hop = can(actor, "equipment.admin");

  const menuItems = (i: EquipmentItem): MenuItem[] => {
    const inService = i.baseStatus === "active";
    return [
      { label: "Open", onClick: () => go({ n: "item", id: i.id }) },
      { label: "Edit details…", onClick: () => setEdit(i) },
      { label: "Add to a checkout list…", disabled: !inService, onClick: () => setCheckout(i) },
      { divider: true, label: "", onClick: () => {} },
      ...(i.trackingType === "serialized"
        ? [i.baseStatus === "in-repair" ? { label: "Back from repair…", onClick: () => { setBackCond(i.condition); setBack(i); } } : { label: "Send to repair…", disabled: !inService, onClick: () => setRepair(i) }]
        : []),
      ...(i.baseStatus === "retired" || i.baseStatus === "lost"
        ? [{ label: "Put back in service", disabled: !hop, onClick: () => attempt(() => reinstateItem(actor, i.id), "Back in service") }]
        : [{ label: "Retire…", disabled: !hop, onClick: () => setRetire({ item: i, kind: "retired" }) }, { label: "Mark as lost…", disabled: !hop, onClick: () => setRetire({ item: i, kind: "lost" }) }]),
      {
        label: "Delete",
        danger: true,
        disabled: !hop,
        onClick: async () => {
          if (await confirm({ title: `Delete ${i.name}?`, body: "Only items with no checkout history can be deleted. Otherwise retire it so its history is kept.", confirmLabel: "Delete", danger: true })) {
            if (attempt(() => deleteItem(actor, i.id), "Deleted")) onDeleted?.();
          }
        },
      },
    ];
  };

  const modals = (
    <>
      {edit && <ItemFormModal item={edit} onClose={() => setEdit(null)} onSaved={() => setEdit(null)} />}
      {repair && <PromptModal title={`Send ${repair.name} to repair`} label="What is wrong?" confirmLabel="Send to repair" onClose={() => setRepair(null)} onSubmit={(t) => { if (attempt(() => startRepair(actor, repair.id, t), "Marked as in repair")) setRepair(null); }} />}
      {back && (
        <PromptModal
          title={`${back.name} is back from repair`}
          label="What was done?"
          confirmLabel="Back in service"
          extra={<Field label="Condition now"><select value={backCond} onChange={(e) => setBackCond(e.target.value as EquipCondition)}>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select></Field>}
          onClose={() => setBack(null)}
          onSubmit={(t) => { if (attempt(() => finishRepair(actor, back.id, backCond, t), "Back in service")) setBack(null); }}
        />
      )}
      {retire && <PromptModal title={retire.kind === "lost" ? `Mark ${retire.item.name} as lost` : `Retire ${retire.item.name}`} label="What happened?" confirmLabel={retire.kind === "lost" ? "Mark as lost" : "Retire"} onClose={() => setRetire(null)} onSubmit={(t) => { if (attempt(() => retireItem(actor, retire.item.id, retire.kind, t), retire.kind === "lost" ? "Marked as lost" : "Retired")) setRetire(null); }} />}
      {checkout && <NewCheckoutModal initialLines={[{ equipmentId: checkout.id, quantity: 1 }]} onClose={() => setCheckout(null)} onCreated={(m) => { setCheckout(null); go({ n: "manifest", id: m.id }); }} />}
    </>
  );
  return { menuItems, modals, setEdit, setRepair, setBack: (i: EquipmentItem) => { setBackCond(i.condition); setBack(i); }, setRetire, setCheckout, hop };
}
