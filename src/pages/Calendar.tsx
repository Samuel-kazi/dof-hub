import { useState } from "react";
import { useApp } from "../ui/AppContext";
import { useDb } from "../data/store";
import { CATEGORIES } from "../config/categories";
import { calendarEvents, eventsOnDay, type CalSubtype } from "../services/calendarView";
import { fmtDate, todayIso } from "../services/utils";
import type { CategoryKey } from "../types";
import { IconBack } from "../ui/Icons";
import { Empty } from "../ui/parts";

const SUBTYPE_LABEL: Record<CalSubtype, string> = { shoot: "Shoot / show day", deadline: "Stage deadline", callsheet: "Call sheet published", booking: "Gear booked" };
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
  return { cells, from: cells[0], to: cells[cells.length - 1], label: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}

const shiftMonth = (monthIso: string, delta: number): string => {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};

export function CalendarPage() {
  const { actor, go } = useApp();
  useDb();
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [cat, setCat] = useState<CategoryKey | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

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
          <p className="sub">Shoot days, stage deadlines, published call sheets and gear bookings, worked out from the pipeline. Nothing here is entered by hand, so changing a date on its own record is all it takes.</p>
        </div>
        <div className="seg" role="group" aria-label="Month">
          <button aria-label="Previous month" title="Previous month" onClick={() => { setMonth((m) => shiftMonth(m, -1)); setSelected(null); }}><span style={{ display: "inline-flex" }}><IconBack /></span></button>
          <button onClick={() => { setMonth(todayIso().slice(0, 7)); setSelected(today); }}>Today</button>
          <button aria-label="Next month" title="Next month" onClick={() => { setMonth((m) => shiftMonth(m, 1)); setSelected(null); }}><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><IconBack /></span></button>
        </div>
      </div>

      <div className="chips" role="group" aria-label="Category">
        <span className="sub" style={{ marginRight: 4 }}>{label}</span>
        <button className={`chip ${cat ? "" : "on"}`} onClick={() => setCat(null)}>All</button>
        {CATEGORIES.map((c) => (
          <button key={c.key} className={`chip ${cat === c.key ? "on" : ""}`} style={{ ["--cat-color" as string]: c.color }} onClick={() => setCat(cat === c.key ? null : c.key)}>
            <span className="cat-dot" />{c.label}
          </button>
        ))}
      </div>

      <section className="glass panel" aria-label="Month grid">
        <div className="cal-grid cal-head">
          {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
        </div>
        <div className="cal-grid">
          {cells.map((date) => {
            const dayEvs = eventsOnDay(events, date);
            const inMonth = date.slice(0, 7) === month;
            return (
              <button
                key={date}
                className={`cal-cell ${inMonth ? "" : "out"} ${date === today ? "today" : ""} ${date === selected ? "sel" : ""}`}
                onClick={() => setSelected(date === selected ? null : date)}
                aria-label={fmtDate(date)}
                aria-pressed={date === selected}
              >
                <span className="cal-num">{Number(date.slice(8))}</span>
                <span className="cal-marks">
                  {dayEvs.slice(0, 4).map((e) => <i key={e.id} className={`cal-mark ${e.subtype}`} style={{ ["--cat-color" as string]: e.color }} title={e.title} />)}
                  {dayEvs.length > 4 && <span className="cal-more">+{dayEvs.length - 4}</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="cal-legend">
          <span><i className="cal-mark shoot" /> Shoot / show day</span>
          <span><i className="cal-mark deadline" /> Stage deadline</span>
          <span><i className="cal-mark callsheet" /> Call sheet published</span>
          <span><i className="cal-mark booking" /> Gear booked</span>
        </div>
      </section>

      {selected && (
        <section className="glass panel" aria-label="Selected day">
          <h2>{fmtDate(selected)}</h2>
          {dayEvents.length === 0 ? <Empty>Nothing on this day.</Empty> : (
            <div className="stack" style={{ marginTop: 10 }}>
              {dayEvents.map((e) => (
                <div key={e.id} className="cal-row" style={{ ["--cat-color" as string]: e.color }} onClick={() => go(e.open)}>
                  <i className={`cal-mark ${e.subtype}`} />
                  <div className="grow">
                    <div>{e.title}</div>
                    <div className="muted" style={{ fontSize: ".84rem" }}>{SUBTYPE_LABEL[e.subtype]}. {e.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
