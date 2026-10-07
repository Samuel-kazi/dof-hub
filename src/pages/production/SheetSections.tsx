import { useContext, createContext, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  CheckItem,
  ContactEntry,
  GearRequest,
  Person,
  RunItem,
  RunStatus,
  SavedLocation,
  SheetContent,
  TalentEntry,
} from "../../types";

// A live show's segments also say where they stand on the night.
const RUN_STATUSES: RunStatus[] = ["Planned", "Live", "Done", "Cut"];
import { LOGISTICS_FIELDS, SHEET_SECTIONS, type SheetSectionKey } from "../../config/callSheet";
import { getDb } from "../../data/store";
import { localId } from "../../data/ids";
import { isHop, redactPerson } from "../../services/access";
import { can } from "../../services/wrapped/permissions";
import { getItem } from "../../services/wrapped/equipment";
import type { SheetTimes } from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { GearPicker } from "../../ui/GearPicker";
import { Empty, Field } from "../../ui/parts";
import { PersonName } from "../../ui/PersonName";
import { SavedInput } from "../documents/toolkit";
import { useFocusRow } from "../../ui/keys";

// The sections every call sheet has (Schedule, Crew, Talent, Location, Equipment, Logistics, Contacts, Run of Show,
// Technical Check, Rehearsal), written once. A call sheet, a recording session's call sheet in the Recording Plan,
// and a recurring show's template all use these: each gives the content it holds and how to save a change.
// Fields save when the person leaves them, so typing never sends a change per key.

export interface SectionProps {
  value: SheetContent;
  editable: boolean;
  onChange: (patch: Partial<SheetContent>) => void;
}

/**
 * What a recurring show's day changed from its template, by section (build prompt v4, section 7): each section shows a
 * mark naming its fields that differ. Empty for a template itself, and for days of other events.
 */
export const TemplateDiffContext = createContext<Record<string, string[]>>({});

/** A section's frame: a panel with an anchor, so the jump bar can go to it, and what it is missing (`warn`). */
export function Section({
  id,
  title,
  aside,
  warn,
  children,
}: {
  id: SheetSectionKey;
  title: string;
  aside?: ReactNode;
  warn?: string[];
  children: ReactNode;
}) {
  const changed = useContext(TemplateDiffContext)[id] ?? [];
  return (
    <section className="glass panel cs-section" id={`sec-${id}`} aria-label={title}>
      <div className="wf-head">
        <h2>{title}</h2>
        {changed.length > 0 && (
          <span className="badge warn cs-changed" title="Changed on this day by hand: the show's template has something else">
            Changed from the template: {changed.join(", ")}
          </span>
        )}
        {aside}
      </div>
      {!!warn?.length && (
        <ul className="cs-warn" aria-label={`${title}: needs attention`}>
          {warn.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

/** Ticks that someone on the sheet will be there. `of` says whether they have and who recorded it; `canTick` who may change it. */
export interface ConfirmProps {
  of: (key: string) => { confirmed: boolean; note: string };
  canTick: (key: string) => boolean;
  onTick: (key: string, yes: boolean) => void;
}

function ConfirmTick({ k, name, confirm }: { k: string; name: string; confirm: ConfirmProps }) {
  const c = confirm.of(k);
  return (
    <label className={`check cs-confirm ${c.confirmed ? "on" : ""}`} title={c.note}>
      <input
        type="checkbox"
        aria-label={`${name} confirmed`}
        checked={c.confirmed}
        disabled={!confirm.canTick(k)}
        onChange={(e) => confirm.onTick(k, e.target.checked)}
      />
      <span>{c.confirmed ? "Confirmed" : "Not confirmed"}</span>
    </label>
  );
}

/** Chips that jump to each section: on a phone the sheet is long, and crew look for one part of it. */
export function SectionNav({ only }: { only?: SheetSectionKey[] }) {
  return (
    <nav className="cs-nav no-print" aria-label="Sections of the call sheet">
      {SHEET_SECTIONS.filter((s) => !only || only.includes(s.key)).map((s) => (
        <a
          key={s.key}
          href={`#sec-${s.key}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(`sec-${s.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

/** A text area that saves when the person leaves it, or on Ctrl+Enter (Cmd+Enter). Enter starts a new line; Esc puts back the edit. */
export function SavedText({
  value,
  onSave,
  disabled,
  label,
  placeholder,
  rows = 3,
}: {
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
  label: string;
  placeholder?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  return (
    <textarea
      aria-label={label}
      value={draft}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        dirty.current = true;
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (dirty.current && draft !== value) onSave(draft);
        dirty.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation(); // saved here; a dialog it is in is not confirmed by it
          if (dirty.current && draft !== value) onSave(draft);
          dirty.current = false;
        } else if (e.key === "Escape" && dirty.current) {
          e.preventDefault();
          e.stopPropagation();
          dirty.current = false;
          setDraft(value);
        }
      }}
    />
  );
}

/** A time field that saves as soon as a whole time is chosen, or when it is cleared. */
function TimeField({
  label,
  value,
  disabled,
  onSave,
  hint,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onSave: (v: string) => void;
  hint?: string | null;
}) {
  return (
    <Field label={label}>
      <input
        type="time"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => e.target.value !== value && onSave(e.target.value)}
      />
      {!value && hint && <small className="muted">From the run sheet: {hint}</small>}
    </Field>
  );
}

// ── Schedule ─────────────────────────────────────────────────

export function ScheduleSection({
  value,
  editable,
  onChange,
  date,
  derived,
  warn,
}: SectionProps & { date?: { value: string; onChange: (d: string) => void }; derived?: SheetTimes; warn?: string[] }) {
  return (
    <Section id="schedule" title="Schedule" warn={warn}>
      <div className="cs-grid">
        {date && (
          <Field label="Date">
            <input
              type="date"
              aria-label="Date"
              value={date.value}
              disabled={!editable}
              onChange={(e) => e.target.value && e.target.value !== date.value && date.onChange(e.target.value)}
            />
          </Field>
        )}
        <TimeField
          label="Crew call"
          value={value.callTime}
          disabled={!editable}
          onSave={(v) => onChange({ callTime: v })}
          hint={derived?.crewCall}
        />
        <TimeField
          label="Talent call"
          value={value.talentCall}
          disabled={!editable}
          onSave={(v) => onChange({ talentCall: v })}
          hint={derived?.talentArrival}
        />
        <TimeField
          label="Start"
          value={value.startTime}
          disabled={!editable}
          onSave={(v) => onChange({ startTime: v })}
          hint={derived?.startRecording}
        />
        <TimeField
          label="Wrap"
          value={value.wrapTime}
          disabled={!editable}
          onSave={(v) => onChange({ wrapTime: v })}
          hint={derived?.wrap}
        />
      </div>
    </Section>
  );
}

// ── Crew ─────────────────────────────────────────────────────

/**
 * The people who may be on a sheet: the active crew and the Head of Production, volunteers attached to the project,
 * and anyone already on it. Putting someone on the crew attaches them to the project, so they can open the sheet.
 */
export function crewCandidates(contentId: string, onSheet: string[]): Person[] {
  const db = getDb();
  const members = new Set(db.members.filter((m) => m.projectContentId === contentId).map((m) => m.personId));
  return db.people
    .filter(
      (p) =>
        onSheet.includes(p.personId) ||
        (p.status === "active" && (p.category === "CRW" || p.category === "HOP" || (p.category === "VOL" && members.has(p.personId)))),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function CrewSection({
  value,
  editable,
  onChange,
  candidates,
  roleHint,
  clashes,
  confirm,
  warn,
}: SectionProps & {
  candidates: Person[];
  roleHint?: (personId: string) => string | null;
  clashes?: Map<string, string>;
  confirm?: ConfirmProps;
  warn?: string[];
}) {
  const on = new Set(value.crewPersonIds);
  const toggle = (pid: string, yes: boolean) =>
    onChange({ crewPersonIds: yes ? [...value.crewPersonIds, pid] : value.crewPersonIds.filter((x) => x !== pid) });
  const confirmed = confirm ? value.crewPersonIds.filter((pid) => confirm.of(pid).confirmed).length : 0;
  return (
    <Section
      id="crew"
      title="Crew"
      warn={warn}
      aside={
        <span className="badge">
          {value.crewPersonIds.length} on the sheet{confirm && value.crewPersonIds.length > 0 ? `, ${confirmed} confirmed` : ""}
        </span>
      }
    >
      {candidates.length === 0 ? (
        <Empty>No one is attached to this project yet. Attach crew from the People page.</Empty>
      ) : (
        <ul className="cs-crew">
          {candidates.map((p) => {
            const isOn = on.has(p.personId);
            const hint = roleHint?.(p.personId);
            return (
              <li key={p.personId} className={isOn ? "on" : ""}>
                <span className="check">
                  <input
                    type="checkbox"
                    aria-label={p.name}
                    checked={isOn}
                    disabled={!editable}
                    onChange={(e) => toggle(p.personId, e.target.checked)}
                  />
                  <span>
                    <PersonName id={p.personId} role={value.crewRoles[p.personId] || hint || undefined} />
                    {p.status !== "active" && <span className="muted"> (no longer active)</span>}
                  </span>
                </span>
                {isOn && (
                  <>
                    <SavedInput
                      aria-label={`Role of ${p.name}`}
                      value={value.crewRoles[p.personId] ?? ""}
                      placeholder={hint ?? "Role, e.g. Camera 1"}
                      disabled={!editable}
                      maxLength={120}
                      onSave={(role) => onChange({ crewRoles: { ...value.crewRoles, [p.personId]: role.trim() } })}
                    />
                    <label className="check cs-lead">
                      <input
                        type="radio"
                        name="crew-lead"
                        checked={value.crewLeadId === p.personId}
                        disabled={!editable}
                        onChange={() => onChange({ crewLeadId: p.personId })}
                      />
                      <span>Lead</span>
                    </label>
                    {confirm && <ConfirmTick k={p.personId} name={p.name} confirm={confirm} />}
                  </>
                )}
                {clashes?.has(p.personId) && (
                  <span className="badge bad" title={clashes.get(p.personId)}>
                    Clash
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ── Lists of rows: talent, contacts, technical check, run of show ──

function useRows<T extends { id: string }>(rows: T[], key: keyof SheetContent, onChange: SectionProps["onChange"]) {
  const set = (next: T[]) => onChange({ [key]: next } as Partial<SheetContent>);
  return {
    update: (id: string, patch: Partial<T>) => set(rows.map((r) => (r.id === id ? { ...r, ...patch } : r))),
    remove: (id: string) => set(rows.filter((r) => r.id !== id)),
    add: (row: T) => set([...rows, row]),
  };
}

export function TalentSection({ value, editable, onChange, confirm }: SectionProps & { confirm?: ConfirmProps }) {
  const { update, remove, add } = useRows<TalentEntry>(value.talent, "talent", onChange);
  const [name, setName] = useState("");
  return (
    <Section id="talent" title="Talent">
      {value.talent.length === 0 ? (
        <Empty>No hosts, guests or performers listed yet.</Empty>
      ) : (
        <ul className="cs-rows">
          {value.talent.map((t) => (
            <li key={t.id}>
              <SavedInput
                aria-label="Talent name"
                value={t.name}
                disabled={!editable}
                onSave={(v) => v.trim() && update(t.id, { name: v.trim() })}
              />
              <SavedInput
                aria-label={`Role of ${t.name}`}
                value={t.role}
                placeholder="Host, guest, speaker"
                disabled={!editable}
                onSave={(v) => update(t.id, { role: v.trim() })}
              />
              <SavedInput
                aria-label={`Contact for ${t.name}`}
                value={t.contact}
                placeholder="Phone or email"
                disabled={!editable}
                onSave={(v) => update(t.id, { contact: v.trim() })}
              />
              <input
                type="time"
                aria-label={`Call time for ${t.name}`}
                value={t.callTime}
                disabled={!editable}
                onChange={(e) => update(t.id, { callTime: e.target.value })}
              />
              {confirm && <ConfirmTick k={`talent:${t.id}`} name={t.name} confirm={confirm} />}
              {editable && (
                <button className="btn small ghost" aria-label={`Remove ${t.name}`} onClick={() => remove(t.id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <AddRow
          label="Add a host, guest or performer"
          value={name}
          onValue={setName}
          onAdd={() => {
            add({ id: localId("TL"), name: name.trim(), role: "", contact: "", callTime: "", notes: "" });
            setName("");
          }}
        />
      )}
    </Section>
  );
}

function AddRow({
  label,
  value,
  onValue,
  onAdd,
  placeholder,
}: {
  label: string;
  value: string;
  onValue: (v: string) => void;
  onAdd: () => void;
  placeholder?: string;
}) {
  return (
    <div className="row cs-add">
      <Field label={label}>
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value.trim() && onAdd()}
        />
      </Field>
      <div style={{ flex: "none" }}>
        <button className="btn" disabled={!value.trim()} onClick={onAdd}>
          + Add
        </button>
      </div>
    </div>
  );
}

// ── Location and logistics ───────────────────────────────────

/** The saved locations a sheet can pick from, and whether the viewer may add the sheet's place to them. */
export interface SavedPlaces {
  list: SavedLocation[];
  onSave?: () => void;
}

export function LocationSection({ value, editable, onChange, saved, warn }: SectionProps & { saved?: SavedPlaces; warn?: string[] }) {
  const picked = saved?.list.find((l) => l.id === value.locationId);
  const pick = (id: string) => {
    const l = saved?.list.find((x) => x.id === id);
    if (!l) return onChange({ locationId: null });
    onChange({ locationId: l.id, location: l.name, locationAddress: l.address, locationNotes: l.notes || value.locationNotes });
  };
  return (
    <Section id="location" title="Location" warn={warn}>
      <div className="stack">
        {saved && (saved.list.length > 0 || value.locationId) && (
          <Field label="Saved location">
            <select aria-label="Saved location" value={value.locationId ?? ""} disabled={!editable} onChange={(e) => pick(e.target.value)}>
              <option value="">{value.location ? "Typed in below" : "Choose a saved location"}</option>
              {value.locationId && !picked && <option value={value.locationId}>No longer on the list</option>}
              {saved.list.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Location">
          <SavedInput
            aria-label="Location"
            value={value.location}
            placeholder="DOF Studio A"
            disabled={!editable}
            maxLength={500}
            onSave={(v) => onChange({ location: v.trim() })}
          />
        </Field>
        <Field label="Address">
          <SavedText
            label="Address"
            value={value.locationAddress}
            disabled={!editable}
            rows={2}
            onSave={(v) => onChange({ locationAddress: v.trim() })}
          />
        </Field>
        <Field label="Getting in">
          <SavedText
            label="Location notes"
            value={value.locationNotes}
            placeholder="Entrance, gate codes, who opens up"
            disabled={!editable}
            rows={2}
            onSave={(v) => onChange({ locationNotes: v.trim() })}
          />
        </Field>
        {editable && saved?.onSave && !value.locationId && value.location.trim() && (
          <div>
            <button className="btn small" onClick={saved.onSave}>
              Save as a saved location
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

export function LogisticsSection({ value, editable, onChange }: SectionProps) {
  return (
    <Section id="logistics" title="Logistics">
      <div className="cs-grid wide">
        {LOGISTICS_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <SavedText
              label={f.label}
              value={value.logistics[f.key]}
              placeholder={f.hint}
              disabled={!editable}
              rows={2}
              onSave={(v) => onChange({ logistics: { ...value.logistics, [f.key]: v.trim() } })}
            />
          </Field>
        ))}
      </div>
    </Section>
  );
}

// ── Contacts ─────────────────────────────────────────────────

export interface ContactRow {
  role: string;
  name: string;
  phone: string;
  personId?: string; // someone in the directory: their name opens their contact card
}

/** Whether this person may see contact details of people outside the crew (talent, the venue). */
export const seesOutsideContacts = (actor: ReturnType<typeof useApp>["actor"]): boolean =>
  isHop(actor) || can(actor, "people.contacts") || (actor.role !== "VOL" && actor.role !== "PTR");

/** The crew on a sheet, with their roles and phones where the viewer may see them. */
export function crewContactRows(
  value: SheetContent,
  actor: ReturnType<typeof useApp>["actor"],
  roleHint?: (pid: string) => string | null,
): ContactRow[] {
  const people = getDb().people;
  return value.crewPersonIds.flatMap((pid) => {
    const p = people.find((x) => x.personId === pid);
    if (!p) return [];
    const shown = redactPerson(actor, p);
    const role = value.crewRoles[pid] || roleHint?.(pid) || "Crew";
    return [
      {
        role: value.crewLeadId === pid ? `${role} (lead)` : role,
        name: p.name,
        phone: shown.contactHidden ? "Private" : shown.phone,
        personId: pid,
      },
    ];
  });
}

export function ContactsSection({
  value,
  editable,
  onChange,
  crewRows,
  more = [],
}: SectionProps & { crewRows: ContactRow[]; more?: ContactRow[] }) {
  const { actor } = useApp();
  const { update, remove, add } = useRows<ContactEntry>(value.contacts, "contacts", onChange);
  const [name, setName] = useState("");
  const open = seesOutsideContacts(actor);
  const talent = value.talent.map((t) => ({ role: t.role || "Talent", name: t.name, phone: open ? t.contact : "Private" }));
  const fixed: ContactRow[] = [...crewRows, ...talent, ...more];
  return (
    <Section id="contacts" title="Contacts">
      {fixed.length > 0 && (
        <div className="wf-scroll">
          <table className="table cs-contacts">
            <thead>
              <tr>
                <th>Role</th>
                <th>Name</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {fixed.map((c, i) => (
                <tr key={`${c.name}|${i}`}>
                  <td>{c.role}</td>
                  <td>{c.personId ? <PersonName id={c.personId} role={c.role} /> : c.name}</td>
                  <td>
                    {c.phone ? (
                      c.phone.startsWith("+") || /\d/.test(c.phone) ? (
                        <a href={`tel:${c.phone.replace(/\s/g, "")}`}>{c.phone}</a>
                      ) : (
                        c.phone
                      )
                    ) : (
                      <span className="muted">None on file</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Others to call on the day</h3>
      {value.contacts.length === 0 ? (
        <Empty>No one else listed: the venue's manager, security, a driver.</Empty>
      ) : (
        <ul className="cs-rows">
          {value.contacts.map((c) => (
            <li key={c.id}>
              <SavedInput
                aria-label="Contact name"
                value={c.name}
                disabled={!editable}
                onSave={(v) => v.trim() && update(c.id, { name: v.trim() })}
              />
              <SavedInput
                aria-label={`Role of ${c.name}`}
                value={c.role}
                placeholder="Venue, security"
                disabled={!editable}
                onSave={(v) => update(c.id, { role: v.trim() })}
              />
              {open ? (
                <>
                  <SavedInput
                    aria-label={`Phone for ${c.name}`}
                    value={c.phone}
                    placeholder="Phone"
                    disabled={!editable}
                    onSave={(v) => update(c.id, { phone: v.trim() })}
                  />
                  <SavedInput
                    aria-label={`Email for ${c.name}`}
                    value={c.email}
                    placeholder="Email"
                    disabled={!editable}
                    onSave={(v) => update(c.id, { email: v.trim() })}
                  />
                </>
              ) : (
                <span className="muted">Private</span>
              )}
              {editable && (
                <button className="btn small ghost" aria-label={`Remove ${c.name}`} onClick={() => remove(c.id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <AddRow
          label="Add someone to call"
          value={name}
          onValue={setName}
          onAdd={() => {
            add({ id: localId("CT"), name: name.trim(), role: "", phone: "", email: "" });
            setName("");
          }}
        />
      )}
    </Section>
  );
}

// ── Run of show ──────────────────────────────────────────────

const endOf = (time: string, minutes: number): string => {
  const [h, m] = time.split(":").map(Number);
  const t = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

export function RunOfShowSection({
  value,
  editable,
  onChange,
  required,
  live = false,
}: SectionProps & { required?: boolean; live?: boolean }) {
  const { update, remove, add } = useRows<RunItem>(value.runOfShow, "runOfShow", onChange);
  // Enter in a row's last field adds a row below it, and the cursor goes to the new row's segment.
  const focusRow = useFocusRow('input[aria-label="Segment"]');
  const people = getDb().people.filter(
    (p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP" || p.category === "VOL"),
  );
  const items = [...value.runOfShow].sort((a, b) => a.time.localeCompare(b.time));
  const sort = (next: RunItem[]) => onChange({ runOfShow: [...next].sort((a, b) => a.time.localeCompare(b.time)) });
  const last = items[items.length - 1];
  const total = items.reduce((n, i) => n + i.durationMin, 0);
  return (
    <Section
      id="runOfShow"
      title="Run of Show"
      aside={
        items.length > 0 ? (
          <span className="badge">
            {total} min, ends {endOf(last.time, last.durationMin)}
          </span>
        ) : undefined
      }
    >
      {required && items.length === 0 && (
        <p className="banner warn">A large production needs a run of show before the call sheet can be final.</p>
      )}
      {items.length === 0 ? (
        <Empty>No segments yet.</Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table cs-run">
            <thead>
              <tr>
                <th>Start</th>
                <th>End</th>
                <th>Segment</th>
                <th>Minutes</th>
                <th>Who</th>
                {live && (
                  <>
                    <th>Camera</th>
                    <th>Audio</th>
                    <th>Graphics</th>
                    <th>Status</th>
                    <th>Actual</th>
                  </>
                )}
                <th>Notes</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} data-row={it.id}>
                  <td>
                    <input
                      type="time"
                      aria-label={`Start of ${it.title}`}
                      value={it.time}
                      disabled={!editable}
                      onChange={(e) =>
                        e.target.value && sort(value.runOfShow.map((x) => (x.id === it.id ? { ...x, time: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td className="muted">{endOf(it.time, it.durationMin)}</td>
                  <td>
                    <SavedInput
                      aria-label="Segment"
                      value={it.title}
                      disabled={!editable}
                      onSave={(v) => v.trim() && update(it.id, { title: v.trim() })}
                    />
                  </td>
                  <td>
                    <SavedInput
                      type="number"
                      min={0}
                      max={600}
                      aria-label={`Minutes of ${it.title}`}
                      value={String(it.durationMin)}
                      disabled={!editable}
                      onSave={(v) => update(it.id, { durationMin: Math.max(0, Math.min(600, Math.round(Number(v) || 0))) })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`Who runs ${it.title}`}
                      value={it.ownerPersonId ?? ""}
                      disabled={!editable}
                      onChange={(e) => update(it.id, { ownerPersonId: e.target.value || null })}
                    >
                      <option value="">No one yet</option>
                      {people.map((p) => (
                        <option key={p.personId} value={p.personId}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  {live && (
                    <>
                      {(["camera", "audio", "graphics"] as const).map((k) => (
                        <td key={k}>
                          <SavedInput
                            aria-label={`${k.charAt(0).toUpperCase() + k.slice(1)} for ${it.title}`}
                            value={it[k] ?? ""}
                            disabled={!editable}
                            onSave={(v) => update(it.id, { [k]: v.trim() })}
                          />
                        </td>
                      ))}
                      <td>
                        <select
                          aria-label={`Status of ${it.title}`}
                          value={it.status ?? "Planned"}
                          disabled={!editable}
                          onChange={(e) => update(it.id, { status: e.target.value as RunStatus })}
                        >
                          {RUN_STATUSES.map((st) => (
                            <option key={st}>{st}</option>
                          ))}
                        </select>
                      </td>
                      <td className="cs-actual">
                        <input
                          type="time"
                          aria-label={`Actual start of ${it.title}`}
                          value={it.actualStart ?? ""}
                          disabled={!editable}
                          onChange={(e) => update(it.id, { actualStart: e.target.value })}
                        />
                        <input
                          type="time"
                          aria-label={`Actual end of ${it.title}`}
                          value={it.actualEnd ?? ""}
                          disabled={!editable}
                          onChange={(e) => update(it.id, { actualEnd: e.target.value })}
                        />
                      </td>
                    </>
                  )}
                  <td>
                    <SavedInput
                      aria-label={`Notes on ${it.title}`}
                      value={it.notes}
                      disabled={!editable}
                      onSave={(v) => update(it.id, { notes: v.trim() })}
                      onEnterAdd={(notes) => {
                        const row: RunItem = {
                          id: localId("RS"),
                          time: endOf(it.time, it.durationMin),
                          title: "New segment",
                          durationMin: 10,
                          ownerPersonId: null,
                          notes: "",
                        };
                        sort([...value.runOfShow.map((x) => (x.id === it.id ? { ...x, notes: notes.trim() } : x)), row]);
                        focusRow(row.id);
                      }}
                    />
                  </td>
                  {editable && (
                    <td>
                      <button className="btn small ghost" aria-label={`Remove ${it.title}`} onClick={() => remove(it.id)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <button
          className="btn small"
          style={{ marginTop: 8 }}
          onClick={() =>
            add({
              id: localId("RS"),
              time: last ? endOf(last.time, last.durationMin) : value.startTime || "09:00",
              title: "New segment",
              durationMin: 10,
              ownerPersonId: null,
              notes: "",
            })
          }
        >
          + Segment
        </button>
      )}
    </Section>
  );
}

// ── Technical check and rehearsal ────────────────────────────

/**
 * `canTick`: a sheet's check is ticked on the day; a template's lines are only the list to start from. `tickable`:
 * whether ticks and notes can be changed (on a final sheet too), where `editable` is whether the lines can.
 */
export function TechnicalCheckSection({
  value,
  editable,
  onChange,
  canTick,
  tickable = editable,
}: SectionProps & { canTick: boolean; tickable?: boolean }) {
  const { update, remove, add } = useRows<CheckItem>(value.technicalCheck, "technicalCheck", onChange);
  const [label, setLabel] = useState("");
  const done = value.technicalCheck.filter((x) => x.done).length;
  return (
    <Section
      id="technicalCheck"
      title="Technical Check"
      aside={
        canTick && value.technicalCheck.length > 0 ? (
          <span className={`badge ${done === value.technicalCheck.length ? "ok" : ""}`}>
            {done} of {value.technicalCheck.length} checked
          </span>
        ) : undefined
      }
    >
      {value.technicalCheck.length === 0 ? (
        <Empty>No checks listed.</Empty>
      ) : (
        <ul className="cs-checks">
          {value.technicalCheck.map((c) => (
            <li key={c.id}>
              {canTick && (
                <input
                  type="checkbox"
                  aria-label={`Checked: ${c.label}`}
                  checked={c.done}
                  disabled={!tickable}
                  onChange={(e) => update(c.id, { done: e.target.checked })}
                />
              )}
              <SavedInput
                aria-label="Check"
                value={c.label}
                disabled={!editable}
                onSave={(v) => v.trim() && update(c.id, { label: v.trim() })}
              />
              {canTick && (
                <SavedInput
                  aria-label={`Note on ${c.label}`}
                  value={c.note}
                  placeholder="Note"
                  disabled={!tickable}
                  onSave={(v) => update(c.id, { note: v.trim() })}
                />
              )}
              {editable && (
                <button className="btn small ghost" aria-label={`Remove ${c.label}`} onClick={() => remove(c.id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <AddRow
          label="Add a check"
          value={label}
          onValue={setLabel}
          placeholder="Wireless mics charged"
          onAdd={() => {
            add({ id: localId("TC"), label: label.trim(), done: false, note: "" });
            setLabel("");
          }}
        />
      )}
    </Section>
  );
}

export function RehearsalSection({
  value,
  editable,
  onChange,
  canTick,
  tickable = editable,
}: SectionProps & { canTick: boolean; tickable?: boolean }) {
  const r = value.rehearsal;
  return (
    <Section id="rehearsal" title="Rehearsal">
      <div className="cs-grid">
        <Field label="Time">
          <input
            type="time"
            aria-label="Rehearsal time"
            value={r.time}
            disabled={!editable}
            onChange={(e) => onChange({ rehearsal: { ...r, time: e.target.value } })}
          />
        </Field>
        {canTick && (
          <label className="check" style={{ alignSelf: "end" }}>
            <input
              type="checkbox"
              checked={r.done}
              disabled={!tickable}
              onChange={(e) => onChange({ rehearsal: { ...r, done: e.target.checked } })}
            />
            <span>Rehearsed</span>
          </label>
        )}
      </div>
      <Field label="What is rehearsed">
        <SavedText
          label="Rehearsal notes"
          value={r.notes}
          placeholder="Full run with the choir, camera moves for the opening"
          disabled={!editable}
          onSave={(v) => onChange({ rehearsal: { ...r, notes: v.trim() } })}
        />
      </Field>
    </Section>
  );
}

// ── Gear still to book ───────────────────────────────────────

/**
 * Gear a sheet still has to book (a template's gear on a day more than two weeks ahead, or anything that was not
 * free), or, on a template, the gear every day books. `onBook` books what is free now.
 */
export function PlannedGear({
  value,
  editable,
  onChange,
  pickDate,
  onBook,
  template,
}: SectionProps & { pickDate: string; onBook?: () => void; template?: boolean }) {
  const [picking, setPicking] = useState(false);
  const rows = value.plannedGear;
  const nameOf = (g: GearRequest) => {
    const item = getItem(g.equipmentId);
    return item ? `${item.name}${g.quantity > 1 ? ` x ${g.quantity}` : ""}` : g.equipmentId;
  };
  return (
    <div className="cs-planned">
      <div className="wf-head">
        <h3>{template ? "Gear each day books" : "Still to book"}</h3>
        {editable && onBook && rows.length > 0 && (
          <button className="btn small primary" onClick={onBook}>
            Book what is free now
          </button>
        )}
        {editable && template && (
          <button className="btn small" onClick={() => setPicking(true)}>
            + Add gear
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="muted">
          {template ? "No gear yet. Each day books it once the day is two weeks away, if it is free." : "Nothing waiting to be booked."}
        </p>
      ) : (
        <ul className="cs-rows">
          {rows.map((g) => (
            <li key={g.equipmentId}>
              <span className="grow">
                {nameOf(g)} <span className="cid">{g.equipmentId}</span>
              </span>
              {editable && (
                <button
                  className="btn small ghost"
                  aria-label={`Remove ${nameOf(g)}`}
                  onClick={() => onChange({ plannedGear: rows.filter((x) => x.equipmentId !== g.equipmentId) })}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!template && rows.length > 0 && (
        <p className="muted">
          Booked once the day is two weeks away, if it is free; anything booked elsewhere that day stays here to sort out.
        </p>
      )}
      {picking && (
        <GearPicker
          from={pickDate}
          to={pickDate}
          alreadyOn={rows.map((r) => r.equipmentId)}
          title="Gear each day books"
          confirmLabel="Add to the template"
          onClose={() => setPicking(false)}
          onConfirm={(lines) => {
            const next = [...rows];
            for (const l of lines) {
              const at = next.findIndex((x) => x.equipmentId === l.equipmentId);
              if (at >= 0) next[at] = { ...next[at], quantity: next[at].quantity + l.quantity };
              else next.push({ equipmentId: l.equipmentId, quantity: l.quantity });
            }
            onChange({ plannedGear: next });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
