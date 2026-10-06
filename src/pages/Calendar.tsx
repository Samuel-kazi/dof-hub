import { useState } from "react";
import { createPortal } from "react-dom";
import type { CalendarReminder, CategoryKey, ReminderTarget } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb, useDb } from "../data/store";
import { CATEGORIES } from "../config/categories";
import { URGENCY_LEVELS } from "../config/urgency";
import { calendarEvents, eventsOnDay, type CalEvent, type CalSubtype } from "../services/calendarView";
import { urgencyReport } from "../services/urgency";
import { getRecord } from "../services/access";
import { sheetOfDay } from "../services/wrapped/production";
import { createReminder, deleteReminder } from "../services/wrapped/alerts";
import { EMAIL_MIN_OFFSET, OFFSETS } from "../services/alerts";
import { featureOn } from "../services/wrapped/settings";
import { nameOf } from "../services/wrapped/people";
import { addDaysIso, fmtDate, todayIso } from "../services/utils";
import { CalendarWeek } from "./CalendarWeek";
import { DeadlineReminders } from "./Reminders";
import { IconBack } from "../ui/Icons";
import { Modal } from "../ui/Modal";
import { Empty, Field } from "../ui/parts";

// The Calendar (build prompt v2, section 12): it absorbs Reminders. Month and Agenda views of everything with a date,
// worked out from the records themselves; a recurring show sits on each of its dates (never a bar across months), a
// multi-day event is one bar from its first day to its last, and clicking a day of it shows that day's details. Then
// one's reminders (on anything with a date, or standing alone, in the bell and by email), the deadlines coming up,
// and the urgency report.

const SUBTYPE_LABEL: Record<CalSubtype, string> = {
  shoot: "Shoot / show day",
  session: "Recording session",
  deadline: "Stage deadline",
  callsheet: "Call sheet published",
  booking: "Gear booked",
  window: "Multi-day event",
  stage: "Stage in progress",
  loan: "Loan due back",
  reminder: "Reminder",
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad2 = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** The Sun-to-Sat cells needed to show a whole month, padded with the days of the months either side. */
function monthGrid(monthIso: string): { cells: string[]; from: string; to: string; label: string } {
  const [y, m] = monthIso.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const gridStart = new Date(y, m - 1, 1 - startOffset);
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const cells = Array.from({ length: totalCells }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return iso(d);
  });
  return {
    cells,
    from: cells[0],
    to: cells[cells.length - 1],
    label: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
}

const shiftMonth = (monthIso: string, delta: number): string => {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};

type View = "month" | "agenda" | "reminders" | "urgency";
type Target = { type: ReminderTarget; id: string };

/** What a reminder on a calendar event is attached to, if it can have one. */
function targetOf(e: CalEvent): Target | null {
  const [kind, id, stage] = e.id.split(":");
  if (kind === "session") return { type: "instance", id };
  if (kind === "shoot") {
    const r = getRecord(id);
    if (r?.category === "live" && r.hierarchyLevel === 1) return { type: "instance", id };
  }
  if (kind === "callsheet") return { type: "callsheet", id };
  if (kind === "loan") return { type: "loan", id };
  if (kind === "deadline" && stage) {
    const r = getRecord(id);
    if (r?.episode) return { type: "episode", id };
    if (r?.workflow) return { type: "project", id };
  }
  return null;
}

export function CalendarPage({ initialView = "month" }: { initialView?: View }) {
  const { actor, go } = useApp();
  useDb();
  const v2 = featureOn("calendar2");
  const [view, setView] = useState<View>(initialView);
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [cat, setCat] = useState<CategoryKey | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reminding, setReminding] = useState<{ target: Target | null; title: string } | null>(null);

  const { cells, from, to, label } = monthGrid(month);
  const all = calendarEvents(actor, from, to);
  const events = cat ? all.filter((e) => e.category === cat) : all;
  const today = todayIso();
  const dayEvents = selected ? eventsOnDay(events, selected) : [];

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Calendar</h1>
          <p className="sub">
            Shoot and show days, recording sessions, deadlines, published call sheets, gear and loans, worked out from the records
            themselves{v2 ? ", and your reminders" : ""}. Change a date on its record and the calendar follows.
          </p>
        </div>
        {v2 && (
          <div className="seg" role="tablist" aria-label="View">
            {(
              [
                ["month", "Month"],
                ["agenda", "Agenda"],
                ["reminders", "Reminders"],
                ["urgency", "Urgency"],
              ] as const
            ).map(([v, l]) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                {l}
              </button>
            ))}
          </div>
        )}
        {view === "month" && (
          <div className="seg" role="group" aria-label="Month">
            <button
              aria-label="Previous month"
              title="Previous month"
              onClick={() => {
                setMonth((m) => shiftMonth(m, -1));
                setSelected(null);
              }}
            >
              <span style={{ display: "inline-flex" }}>
                <IconBack />
              </span>
            </button>
            <button
              onClick={() => {
                setMonth(todayIso().slice(0, 7));
                setSelected(today);
              }}
            >
              Today
            </button>
            <button
              aria-label="Next month"
              title="Next month"
              onClick={() => {
                setMonth((m) => shiftMonth(m, 1));
                setSelected(null);
              }}
            >
              <span style={{ display: "inline-flex", transform: "scaleX(-1)" }}>
                <IconBack />
              </span>
            </button>
          </div>
        )}
      </div>

      {(view === "month" || view === "agenda") && (
        <div className="chips" role="group" aria-label="Category">
          {view === "month" && (
            <span className="sub" style={{ marginRight: 4 }}>
              {label}
            </span>
          )}
          <button className={`chip ${cat ? "" : "on"}`} onClick={() => setCat(null)}>
            All
          </button>
          {CATEGORIES.filter((c) => c.key !== "general").map((c) => (
            <button
              key={c.key}
              className={`chip ${cat === c.key ? "on" : ""}`}
              style={{ ["--cat-color" as string]: c.color }}
              onClick={() => setCat(cat === c.key ? null : c.key)}
            >
              <span className="cat-dot" />
              {c.label}
            </button>
          ))}
        </div>
      )}

      {view === "month" && (
        <>
          <section className="glass panel" aria-label="Month grid">
            <div className="cal-dow-row">
              {DOW.map((d) => (
                <div key={d} className="cal-dow">
                  {d}
                </div>
              ))}
            </div>
            <div className="stack" style={{ gap: 4 }}>
              {Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7)).map((weekDates) => (
                <CalendarWeek
                  key={weekDates[0]}
                  weekDates={weekDates}
                  events={events}
                  month={month}
                  today={today}
                  selected={selected}
                  onSelectDay={(date) => setSelected(date === selected ? null : date)}
                  onOpenEvent={(e: CalEvent, date: string) => (e.days ? setSelected(date) : go(e.open))}
                />
              ))}
            </div>
            <div className="cal-legend">
              <span>
                <i className="cal-mark shoot" /> Shoot / show day
              </span>
              <span>
                <i className="cal-mark session" /> Recording session
              </span>
              <span>
                <i className="cal-mark deadline" /> Deadline
              </span>
              <span>
                <i className="cal-mark callsheet" /> Call sheet published
              </span>
              <span>
                <i className="cal-mark booking" /> Gear booked
              </span>
              {v2 && (
                <>
                  <span>
                    <i className="cal-mark loan" /> Loan due back
                  </span>
                  <span>
                    <i className="cal-mark reminder" /> Reminder
                  </span>
                </>
              )}
              <span>
                <span className="bar-swatch" /> Multi-day event / stage in progress
              </span>
            </div>
          </section>

          {selected && (
            <section className="glass panel" aria-label="Selected day">
              <h2>{fmtDate(selected)}</h2>
              {dayEvents.length === 0 ? (
                <Empty>Nothing on this day.</Empty>
              ) : (
                <div className="stack" style={{ marginTop: 10 }}>
                  {dayEvents.map((e) => {
                    const day = e.days?.find((d) => d.date === selected);
                    const target = v2 ? targetOf(e) : null;
                    return (
                      <div key={e.id} className="stack" style={{ gap: 6 }}>
                        <div className="cal-row" style={{ ["--cat-color" as string]: e.color }} onClick={() => go(e.open)}>
                          <i className={`cal-mark ${e.subtype}`} />
                          <div className="grow">
                            <div>{e.title}</div>
                            <div className="muted" style={{ fontSize: ".84rem" }}>
                              {SUBTYPE_LABEL[e.subtype]}. {e.detail}
                            </div>
                          </div>
                          {target && (
                            <button
                              className="btn small"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setReminding({ target, title: e.title });
                              }}
                            >
                              Remind me…
                            </button>
                          )}
                        </div>
                        {day && <DayDetails dayId={day.id} />}
                      </div>
                    );
                  })}
                </div>
              )}
              {v2 && (
                <button className="btn small" style={{ marginTop: 10 }} onClick={() => setReminding({ target: null, title: "" })}>
                  + Reminder on this day
                </button>
              )}
            </section>
          )}
        </>
      )}

      {view === "agenda" && <Agenda cat={cat} onRemind={(target, title) => setReminding({ target, title })} />}
      {view === "reminders" && (
        <>
          <MyReminders onNew={() => setReminding({ target: null, title: "" })} />
          <section className="glass panel">
            <DeadlineReminders />
          </section>
        </>
      )}
      {view === "urgency" && <UrgencyReport />}
      {reminding && (
        <ReminderModal target={reminding.target} about={reminding.title} date={selected ?? today} onClose={() => setReminding(null)} />
      )}
    </div>
  );
}

/** One day of a multi-day event: its crew call, place, crew and run of show, with its call sheet. */
function DayDetails({ dayId }: { dayId: string }) {
  const { go } = useApp();
  const day = getRecord(dayId);
  const cs = day ? sheetOfDay(day) : undefined;
  if (!day) return null;
  return (
    <div className="cal-day-details" aria-label={`${day.title} details`}>
      <b>{day.title}</b>
      {cs ? (
        <>
          <div className="muted">
            Crew call {cs.callTime || "not set"} · {cs.location || "Location to be confirmed"}
            {cs.status === "final" ? " · published" : " · draft"}
          </div>
          {cs.crewPersonIds.length > 0 && (
            <div>Crew: {cs.crewPersonIds.map((p) => `${nameOf(p)}${cs.crewRoles[p] ? ` (${cs.crewRoles[p]})` : ""}`).join(", ")}</div>
          )}
          {cs.runOfShow.length > 0 && (
            <ol className="cal-run">
              {[...cs.runOfShow]
                .sort((a, b) => a.time.localeCompare(b.time))
                .map((r) => (
                  <li key={r.id}>
                    <span className="cid">{r.time}</span> {r.title}
                  </li>
                ))}
            </ol>
          )}
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small primary" onClick={() => go({ n: "callsheet", id: cs.id })}>
              Open the call sheet
            </button>
            <button className="btn small" onClick={() => go({ n: "record", id: day.contentId })}>
              Open the day
            </button>
          </div>
        </>
      ) : (
        <div className="muted">No call sheet yet.</div>
      )}
    </div>
  );
}

/** The next 30 days as a list, day by day. */
function Agenda({ cat, onRemind }: { cat: CategoryKey | null; onRemind: (t: Target, title: string) => void }) {
  const { actor, go } = useApp();
  const today = todayIso();
  const to = addDaysIso(today, 30);
  const events = calendarEvents(actor, today, to).filter((e) => !cat || e.category === cat);
  const days: string[] = [];
  for (let d = today; d <= to; d = addDaysIso(d, 1)) days.push(d);
  // A bar (a stage in progress) is listed on its last day; a multi-day event on each of its days.
  const shown = days
    .map((d) => [d, eventsOnDay(events, d).filter((e) => e.subtype !== "stage" || e.endDate === d)] as const)
    .filter(([, list]) => list.length);
  return (
    <section className="glass panel" aria-label="Agenda">
      <h2>The next 30 days</h2>
      {shown.length === 0 ? (
        <Empty>Nothing in the next 30 days.</Empty>
      ) : (
        <div className="stack">
          {shown.map(([d, list]) => (
            <div key={d}>
              <h3 className="cal-agenda-day">
                {fmtDate(d)}
                {d === today ? " · today" : ""}
              </h3>
              {list.map((e) => {
                const target = targetOf(e);
                return (
                  <div key={`${d}-${e.id}`} className="cal-row" style={{ ["--cat-color" as string]: e.color }} onClick={() => go(e.open)}>
                    <i className={`cal-mark ${e.subtype}`} />
                    <div className="grow">
                      <div>{e.days ? `${e.title}, day ${e.days.findIndex((x) => x.date === d) + 1} of ${e.days.length}` : e.title}</div>
                      <div className="muted" style={{ fontSize: ".84rem" }}>
                        {SUBTYPE_LABEL[e.subtype]}. {e.detail}
                      </div>
                    </div>
                    {target && (
                      <button
                        className="btn small"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onRemind(target, e.title);
                        }}
                      >
                        Remind me…
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const describeOffset = (m: number) => OFFSETS.find((o) => o.minutes === m)?.label ?? `${m} minutes before`;

function MyReminders({ onNew }: { onNew: () => void }) {
  const { actor, attempt } = useApp();
  const mine = (getDb().calendarReminders ?? [])
    .filter((r) => r.recipientIds.includes(actor.personId) || r.createdBy === actor.personId)
    .sort((a, b) => (a.fireAt ?? "9999").localeCompare(b.fireAt ?? "9999"));
  return (
    <section className="glass panel" aria-label="My reminders">
      <div className="wf-head">
        <h2 className="grow">My reminders</h2>
        <button className="btn primary" onClick={onNew}>
          + Reminder
        </button>
      </div>
      <p className="muted">
        In the bell when it is due, and by email if you choose (a day or more ahead: the server sends email each morning). A reminder on a
        session, show day, call sheet, deadline or loan follows its date when it moves. Set one from a day on the calendar, or here.
      </p>
      {mine.length === 0 ? (
        <Empty>No reminders yet.</Empty>
      ) : (
        <ul className="rm-list">
          {mine.map((r: CalendarReminder) => (
            <li key={r.id}>
              <span className="grow">
                <b>{r.title || (r.targetId ?? "Reminder")}</b>
                <span className="muted">
                  {" "}
                  · {r.targetType ? `${r.targetType} ${r.targetId}` : `${fmtDate(r.date)}${r.time ? ` ${r.time}` : ""}`} ·{" "}
                  {describeOffset(r.offsetMinutes)} · {r.channels.map((c) => (c === "app" ? "bell" : "email")).join(" and ")}
                  {r.repeat !== "none" ? ` · repeats ${r.repeat}` : ""}
                  {r.fireAt ? ` · next ${fmtDate(r.fireAt.slice(0, 10))}` : " · done"}
                </span>
              </span>
              {r.createdBy === actor.personId && (
                <button className="btn small ghost" onClick={() => attempt(() => deleteReminder(actor, r.id), "Reminder deleted")}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReminderModal({
  target,
  about,
  date: initialDate,
  onClose,
}: {
  target: Target | null;
  about: string;
  date: string;
  onClose: () => void;
}) {
  const { actor, attempt } = useApp();
  const [title, setTitle] = useState(target ? "" : about);
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState("");
  const [offset, setOffset] = useState<number>(target ? 1440 : 0);
  const [bell, setBell] = useState(true);
  const [email, setEmail] = useState(false);
  const [repeat, setRepeat] = useState<CalendarReminder["repeat"]>("none");
  const emailOk = offset >= EMAIL_MIN_OFFSET;
  const channels = [...(bell ? ["app" as const] : []), ...(email && emailOk ? ["email" as const] : [])];
  const save = () => {
    const ok = attempt(
      () =>
        createReminder(actor, {
          targetType: target?.type ?? null,
          targetId: target?.id ?? null,
          title,
          date: target ? undefined : date,
          time: target ? undefined : time,
          offsetMinutes: offset,
          channels,
          repeat: target ? "none" : repeat,
        }),
      "Reminder set",
    );
    if (ok) onClose();
  };
  return (
    <Modal
      title={target ? `Remind me: ${about}` : "New reminder"}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!channels.length || (!target && (!title.trim() || !date))} onClick={save}>
            Set reminder
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={target ? "A note (optional)" : "What it is for"}>
          <input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {!target && (
          <div className="row">
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Time (optional)">
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field label="Repeats">
              <select value={repeat} onChange={(e) => setRepeat(e.target.value as CalendarReminder["repeat"])}>
                <option value="none">No</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </select>
            </Field>
          </div>
        )}
        <Field label="When">
          <select aria-label="When to remind" value={offset} onChange={(e) => setOffset(Number(e.target.value))}>
            {OFFSETS.map((o) => (
              <option key={o.minutes} value={o.minutes}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={bell} onChange={(e) => setBell(e.target.checked)} />
          <span>In the bell</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={email && emailOk} disabled={!emailOk} onChange={(e) => setEmail(e.target.checked)} />
          <span>By email{emailOk ? "" : " (a day or more ahead only)"}</span>
        </label>
      </div>
    </Modal>
  );
}

/** The urgency report: each project's level and reasons, filterable, sortable and printable. */
function UrgencyReport() {
  const { actor, go } = useApp();
  const [kind, setKind] = useState<string>("all");
  const [sort, setSort] = useState<"level" | "date" | "name">("level");
  const [printing, setPrinting] = useState(false);
  const rows = urgencyReport(actor)
    .filter((r) => kind === "all" || r.category === kind || (kind === "attention" && r.level !== "On track"))
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : sort === "date"
          ? (a.soonest ?? "9999").localeCompare(b.soonest ?? "9999")
          : URGENCY_LEVELS.indexOf(a.level) - URGENCY_LEVELS.indexOf(b.level),
    );
  const tone = (l: string) => (l === "Critical" ? "bad" : l === "High" ? "warn" : l === "Watch" ? "accent" : "ok");
  const table = (
    <table className="table urgency-table">
      <thead>
        <tr>
          <th>Level</th>
          <th>Project</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.kind}:${r.id}`} onClick={() => (window.location.hash = r.link)} style={{ cursor: "pointer" }}>
            <td>
              <span className={`badge ${tone(r.level)}`}>{r.level}</span>
            </td>
            <td>
              <b>{r.title}</b> <span className="cid">{r.id}</span>
            </td>
            <td>{r.reasons.length ? r.reasons.join(" ") : "Nothing needs attention."}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const print = () => {
    setPrinting(true);
    setTimeout(() => {
      document.body.classList.add("printing-report");
      const done = () => {
        document.body.classList.remove("printing-report");
        setPrinting(false);
        window.removeEventListener("afterprint", done);
      };
      window.addEventListener("afterprint", done);
      window.print();
    }, 150);
  };
  return (
    <section className="glass panel" aria-label="Urgency report">
      <div className="wf-head">
        <h2 className="grow">Urgency report</h2>
        <select aria-label="Which" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">Everything</option>
          <option value="attention">Needs attention</option>
          {CATEGORIES.filter((c) => c.key !== "general").map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
          <option value="loan">Loans</option>
        </select>
        <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="level">Most urgent first</option>
          <option value="date">Soonest first</option>
          <option value="name">By name</option>
        </select>
        <button className="btn" onClick={print}>
          Print
        </button>
      </div>
      <p className="muted">
        Each project gets Critical, High, Watch or On track, with its reasons in plain words, from fixed rules (no AI). Overdue comes only
        from episodes and devotions.
      </p>
      {rows.length === 0 ? <Empty>Nothing to report.</Empty> : <div className="wf-scroll">{table}</div>}
      {printing &&
        createPortal(
          <div id="print-root">
            <div className="print-doc">
              <h1>Urgency report, {fmtDate(todayIso())}</h1>
              {table}
            </div>
          </div>,
          document.body,
        )}
      <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => go({ n: "settings" })}>
        Settings
      </button>
    </section>
  );
}
