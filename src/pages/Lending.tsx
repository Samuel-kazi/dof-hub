import { useState } from "react";
import { createPortal } from "react-dom";
import type { EquipCondition, Loan, RoleKit } from "../types";
import { getDb } from "../data/store";
import { getItem } from "../services/wrapped/equipment";
import {
  cancelLoan,
  createLoan,
  daysLate,
  outstanding,
  returnLoanItems,
  updateLoan,
  type LoanReturnInput,
} from "../services/wrapped/lending";
import { createKit, deleteKit, listKits, updateKit } from "../services/wrapped/kits";
import { nameOf } from "../services/wrapped/people";
import { addDaysIso, fmtDate, todayIso } from "../services/utils";
import { useApp } from "../ui/AppContext";
import { GearPicker } from "../ui/GearPicker";
import { Modal } from "../ui/Modal";
import { Empty, Field } from "../ui/parts";
import { useReason } from "./workflow/common";

// Equipment, Lending (build prompt v2, section 11): gear lent outside a production, to a church, a partner or a
// member, with its own number (DOF-LOAN-0001) and no Content ID. The return date is required. A lent item is not
// free for bookings until it is back; items can come back a few at a time; a loan prints as a receipt with a
// signature line. And Role kits: the gear a role usually takes, offered on call sheets item by item.

const CONDITIONS: EquipCondition[] = ["New", "Good", "Fair", "Poor"];
const itemName = (id: string) => getItem(id)?.name ?? id;

type View = "out" | "overdue" | "returned" | "all";

export function LendingTab() {
  const { actor, attempt } = useApp();
  const [view, setView] = useState<View>("out");
  const [making, setMaking] = useState(false);
  const [checkingIn, setCheckingIn] = useState<Loan | null>(null);
  const [extending, setExtending] = useState<Loan | null>(null);
  const [printing, setPrinting] = useState<Loan | null>(null);
  const [ask, reasonModal] = useReason();
  const today = todayIso();
  const all = [...(getDb().loans ?? [])].sort((a, b) => b.dateOut.localeCompare(a.dateOut) || b.id.localeCompare(a.id));
  const shown = all.filter((l) =>
    view === "all"
      ? true
      : view === "out"
        ? l.status === "out"
        : view === "overdue"
          ? l.status === "out" && l.expectedReturn < today
          : l.status !== "out",
  );
  const late = all.filter((l) => l.status === "out" && l.expectedReturn < today).length;
  const print = (l: Loan) => {
    setPrinting(l);
    setTimeout(() => {
      document.body.classList.add("printing-report");
      const done = () => {
        document.body.classList.remove("printing-report");
        setPrinting(null);
        window.removeEventListener("afterprint", done);
      };
      window.addEventListener("afterprint", done);
      window.print();
    }, 150);
  };
  return (
    <section className="glass panel" aria-label="Lending">
      <div className="wf-head">
        <h2>Lending</h2>
        <div className="seg" role="tablist" aria-label="Which loans">
          {(
            [
              ["out", "Out"],
              ["overdue", `Overdue${late ? ` (${late})` : ""}`],
              ["returned", "Back or called off"],
              ["all", "All"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button className="btn primary" onClick={() => setMaking(true)}>
          New loan
        </button>
      </div>
      <p className="muted">
        Gear lent outside a production, with its own number. A lent item is not free for bookings from the day it goes out until it is back;
        once late, until it is checked in.
      </p>
      {shown.length === 0 ? (
        <Empty>{view === "overdue" ? "No loan is overdue." : view === "out" ? "Nothing is lent out." : "No loans here."}</Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Loan</th>
                <th>Borrower</th>
                <th>Items</th>
                <th>Out</th>
                <th>Due back</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const lateBy = daysLate(l, today);
                return (
                  <tr key={l.id}>
                    <td className="cid">{l.id}</td>
                    <td>
                      <b>{l.borrowerName}</b>
                      {l.organisation && <div className="muted">{l.organisation}</div>}
                      {l.borrowerPhone && <div className="muted">{l.borrowerPhone}</div>}
                    </td>
                    <td>
                      {l.lines.map((x) => (
                        <div key={x.equipmentId}>
                          {itemName(x.equipmentId)} ×{x.quantity}
                          {l.status === "out" && outstanding(x) < x.quantity && (
                            <span className="muted"> ({x.quantity - outstanding(x)} back)</span>
                          )}
                        </div>
                      ))}
                    </td>
                    <td>{fmtDate(l.dateOut)}</td>
                    <td>{fmtDate(l.expectedReturn)}</td>
                    <td>
                      {l.status === "out" ? (
                        lateBy ? (
                          <span className="badge bad">
                            {lateBy} day{lateBy === 1 ? "" : "s"} late
                          </span>
                        ) : (
                          <span className="badge accent">Out</span>
                        )
                      ) : l.status === "returned" ? (
                        <span className="badge ok">Back</span>
                      ) : (
                        <span className="badge">Called off</span>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {l.status === "out" && (
                          <>
                            <button className="btn small primary" onClick={() => setCheckingIn(l)}>
                              Check in…
                            </button>
                            <button className="btn small" onClick={() => setExtending(l)}>
                              Keep longer…
                            </button>
                            {!l.lines.some((x) => x.returns.length) && (
                              <button
                                className="btn small ghost"
                                onClick={async () => {
                                  const why = await ask(
                                    `Call off ${l.id}?`,
                                    "Why is it called off? It is kept, with this reason.",
                                    "Call off",
                                  );
                                  if (why) attempt(() => cancelLoan(actor, l.id, why), "Loan called off");
                                }}
                              >
                                Call off…
                              </button>
                            )}
                          </>
                        )}
                        <button className="btn small ghost" onClick={() => print(l)}>
                          Print receipt
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {making && <NewLoanModal onClose={() => setMaking(false)} />}
      {checkingIn && <CheckInModal loan={checkingIn} onClose={() => setCheckingIn(null)} />}
      {extending && <KeepLongerModal loan={extending} onClose={() => setExtending(null)} />}
      {printing &&
        typeof document !== "undefined" &&
        createPortal(
          <div id="print-root">
            <LoanReceipt loan={printing} />
          </div>,
          document.body,
        )}
      {reasonModal}
    </section>
  );
}

function NewLoanModal({ onClose }: { onClose: () => void }) {
  const { actor, attempt } = useApp();
  const today = todayIso();
  const [form, setForm] = useState({
    borrowerName: "",
    borrowerPhone: "",
    organisation: "",
    dateOut: today,
    expectedReturn: "",
    notes: "",
  });
  const [lines, setLines] = useState<{ equipmentId: string; quantity: number }[]>([]);
  const [picking, setPicking] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const ready = form.borrowerName.trim() && form.dateOut && form.expectedReturn && lines.length;
  const save = () => {
    if (attempt(() => createLoan(actor, { ...form, lines }), "Loan made")) onClose();
  };
  return (
    <Modal
      title="New loan"
      wide
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready} onClick={save}>
            Lend
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row">
          <Field label="Borrower">
            <input value={form.borrowerName} autoFocus onChange={(e) => set({ borrowerName: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input type="tel" value={form.borrowerPhone} onChange={(e) => set({ borrowerPhone: e.target.value })} />
          </Field>
          <Field label="Church or organisation">
            <input value={form.organisation} onChange={(e) => set({ organisation: e.target.value })} />
          </Field>
        </div>
        <div className="row">
          <Field label="Goes out on">
            <input type="date" value={form.dateOut} onChange={(e) => set({ dateOut: e.target.value })} />
          </Field>
          <Field label="Expected back (required)">
            <input type="date" value={form.expectedReturn} min={form.dateOut} onChange={(e) => set({ expectedReturn: e.target.value })} />
          </Field>
        </div>
        <div>
          <div className="wf-head">
            <h3>Items</h3>
            <button className="btn small" disabled={!form.dateOut || !form.expectedReturn} onClick={() => setPicking(true)}>
              {lines.length ? "Change items" : "Choose items"}
            </button>
          </div>
          {!form.expectedReturn && <p className="muted">Pick when it is expected back first: only gear free for those days is offered.</p>}
          {lines.length === 0 ? (
            <p className="muted">No items yet.</p>
          ) : (
            <ul>
              {lines.map((l) => (
                <li key={l.equipmentId}>
                  {itemName(l.equipmentId)} <span className="cid">{l.equipmentId}</span> ×{l.quantity}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Field label="Notes">
          <textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      {picking && (
        <GearPicker
          from={form.dateOut}
          to={form.expectedReturn}
          title="Items to lend"
          confirmLabel="Use these"
          alreadyOn={lines.map((l) => l.equipmentId)}
          onConfirm={(picked) => {
            const next = new Map(lines.map((l) => [l.equipmentId, l]));
            for (const p of picked) next.set(p.equipmentId, { equipmentId: p.equipmentId, quantity: p.quantity });
            setLines([...next.values()]);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Modal>
  );
}

function CheckInModal({ loan, onClose }: { loan: Loan; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const open = loan.lines.filter((l) => outstanding(l) > 0);
  const [rows, setRows] = useState<Record<string, LoanReturnInput>>(() =>
    Object.fromEntries(
      open.map((l) => [l.equipmentId, { equipmentId: l.equipmentId, quantity: outstanding(l), condition: l.conditionOut, note: "" }]),
    ),
  );
  const chosen = Object.values(rows).filter((r) => r.quantity > 0);
  const save = () => {
    if (attempt(() => returnLoanItems(actor, loan.id, chosen), "Checked in")) onClose();
  };
  return (
    <Modal
      title={`Check in ${loan.id}`}
      wide
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!chosen.length} onClick={save}>
            Check in
          </button>
        </>
      }
    >
      <p className="sub">What came back from {loan.borrowerName}, and in what condition. The rest can come back later.</p>
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Back now</th>
            <th>Condition</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {open.map((l) => {
            const r = rows[l.equipmentId];
            const set = (patch: Partial<LoanReturnInput>) => setRows((x) => ({ ...x, [l.equipmentId]: { ...r, ...patch } }));
            return (
              <tr key={l.equipmentId}>
                <td>
                  {itemName(l.equipmentId)} <span className="muted">({outstanding(l)} out)</span>
                </td>
                <td>
                  <input
                    type="number"
                    aria-label={`How many of ${itemName(l.equipmentId)} came back`}
                    min={0}
                    max={outstanding(l)}
                    value={r.quantity}
                    style={{ width: 80 }}
                    onChange={(e) => set({ quantity: Math.max(0, Math.min(outstanding(l), Math.round(Number(e.target.value) || 0))) })}
                  />
                </td>
                <td>
                  <select
                    aria-label={`Condition of ${itemName(l.equipmentId)}`}
                    value={r.condition}
                    onChange={(e) => set({ condition: e.target.value as EquipCondition })}
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`Note on ${itemName(l.equipmentId)}`}
                    value={r.note ?? ""}
                    onChange={(e) => set({ note: e.target.value })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}

function KeepLongerModal({ loan, onClose }: { loan: Loan; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const [date, setDate] = useState(addDaysIso(loan.expectedReturn, 7));
  return (
    <Modal
      title={`Keep ${loan.id} longer`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!date}
            onClick={() => attempt(() => updateLoan(actor, loan.id, { expectedReturn: date }), "Return date changed") && onClose()}
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Expected back">
        <input type="date" value={date} min={loan.dateOut} autoFocus onChange={(e) => setDate(e.target.value)} />
      </Field>
      <p className="muted">Kept longer only if every item still out is free for the extra days.</p>
    </Modal>
  );
}

/** The printed receipt: what was lent, to whom, until when, with signature lines. */
export function LoanReceipt({ loan }: { loan: Loan }) {
  return (
    <div className="print-doc loan-receipt">
      <h1>Dawn of Faith Production Hub: equipment loan</h1>
      <p>
        <b>{loan.id}</b> · Lent by {nameOf(loan.lentBy)} on {fmtDate(loan.dateOut)}
      </p>
      <p>
        <b>Borrower:</b> {loan.borrowerName}
        {loan.organisation ? `, ${loan.organisation}` : ""}
        {loan.borrowerPhone ? `, ${loan.borrowerPhone}` : ""}
      </p>
      <p>
        <b>Expected back:</b> {fmtDate(loan.expectedReturn)}
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th>ID</th>
            <th>Quantity</th>
            <th>Condition out</th>
          </tr>
        </thead>
        <tbody>
          {loan.lines.map((l) => (
            <tr key={l.equipmentId}>
              <td>{itemName(l.equipmentId)}</td>
              <td>{l.equipmentId}</td>
              <td>{l.quantity}</td>
              <td>{l.conditionOut}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {loan.notes && <p>Notes: {loan.notes}</p>}
      <div className="sign-lines">
        <div>
          Borrower&apos;s signature
          <span />
        </div>
        <div>
          Date
          <span />
        </div>
        <div>
          Received back by
          <span />
        </div>
      </div>
    </div>
  );
}

// ── Role kits ────────────────────────────────────────────────

export function KitsTab() {
  const { actor, attempt, confirm } = useApp();
  const [editing, setEditing] = useState<RoleKit | "new" | null>(null);
  const kits = listKits();
  return (
    <section className="glass panel" aria-label="Role kits">
      <div className="wf-head">
        <h2>Role kits</h2>
        <span className="grow" />
        <button className="btn primary" onClick={() => setEditing("new")}>
          New kit
        </button>
      </div>
      <p className="muted">
        The gear a role usually takes, for example a camera operator with an FX6. A call sheet offers a matching kit to its crew&apos;s
        roles, item by item; nothing is booked until someone adds an item.
      </p>
      {kits.length === 0 ? (
        <Empty>No kits yet.</Empty>
      ) : (
        <ul className="kit-list">
          {kits.map((k) => (
            <li key={k.id} className="glass">
              <div className="wf-head">
                <b>{k.role}</b>
                {k.cameraModel && <span className="muted">with {k.cameraModel}</span>}
                <span className="cid">{k.id}</span>
                <span className="grow" />
                <button className="btn small" onClick={() => setEditing(k)}>
                  Edit
                </button>
                <button
                  className="btn small ghost"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Delete the ${k.role} kit?`,
                        body: "Call sheets stop suggesting it.",
                        confirmLabel: "Delete",
                        danger: true,
                      })
                    )
                      attempt(() => deleteKit(actor, k.id), "Kit deleted");
                  }}
                >
                  Delete
                </button>
              </div>
              <div className="muted">
                {k.items.length
                  ? k.items.map((g) => `${itemName(g.equipmentId)}${g.quantity > 1 ? ` ×${g.quantity}` : ""}`).join(", ")
                  : "No items yet"}
              </div>
              {k.keywords.length > 0 && <div className="muted">Matches roles with: {k.keywords.join(", ")}</div>}
            </li>
          ))}
        </ul>
      )}
      {editing && <KitModal kit={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function KitModal({ kit, onClose }: { kit: RoleKit | null; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const [role, setRole] = useState(kit?.role ?? "");
  const [cameraModel, setCameraModel] = useState(kit?.cameraModel ?? "");
  const [keywords, setKeywords] = useState((kit?.keywords ?? []).join(", "));
  const [items, setItems] = useState(kit?.items ?? []);
  const [notes, setNotes] = useState(kit?.notes ?? "");
  const [picking, setPicking] = useState(false);
  const today = todayIso();
  const save = () => {
    const input = {
      role,
      cameraModel,
      keywords: keywords
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean),
      items,
      notes,
    };
    if (attempt(() => (kit ? updateKit(actor, kit.id, input) : createKit(actor, input)), kit ? "Kit saved" : "Kit made")) onClose();
  };
  return (
    <Modal
      title={kit ? `Edit the ${kit.role} kit` : "New role kit"}
      wide
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!role.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row">
          <Field label="Role">
            <input value={role} autoFocus placeholder="Camera operator" onChange={(e) => setRole(e.target.value)} />
          </Field>
          <Field label="Camera model (optional)">
            <input value={cameraModel} placeholder="FX6" onChange={(e) => setCameraModel(e.target.value)} />
          </Field>
        </div>
        <Field label="Words that match a role on a call sheet (optional, separated by commas)">
          <input value={keywords} placeholder="camera, cam" onChange={(e) => setKeywords(e.target.value)} />
        </Field>
        <div>
          <div className="wf-head">
            <h3>Items</h3>
            <button className="btn small" onClick={() => setPicking(true)}>
              Add items
            </button>
          </div>
          {items.length === 0 ? (
            <p className="muted">No items yet.</p>
          ) : (
            <ul>
              {items.map((g) => (
                <li key={g.equipmentId}>
                  {itemName(g.equipmentId)} ×{g.quantity}{" "}
                  <button
                    className="btn small ghost"
                    aria-label={`Remove ${itemName(g.equipmentId)} from the kit`}
                    onClick={() => setItems(items.filter((x) => x.equipmentId !== g.equipmentId))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Field label="Notes">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      {picking && (
        <GearPicker
          from={today}
          to={today}
          title="Items in the kit"
          confirmLabel="Add to the kit"
          alreadyOn={items.map((g) => g.equipmentId)}
          onConfirm={(picked) => {
            const next = new Map(items.map((g) => [g.equipmentId, g]));
            for (const p of picked) next.set(p.equipmentId, { equipmentId: p.equipmentId, quantity: p.quantity });
            setItems([...next.values()]);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Modal>
  );
}
