import { useState } from "react";
import type { CategoryKey, WorkflowStage } from "../types";
import type { CalEvent, CalSubtype, TimelineRow } from "../services/calendarView";
import { eventsOnDay, timelineRows } from "../services/calendarView";
import { urgencyReport } from "../services/urgency";
import { addDaysIso, dayNumber, fmtDate, todayIso } from "../services/utils";
import { useApp } from "../ui/AppContext";
import { Empty } from "../ui/parts";

// The Calendar's Timeline, Week and Day views (build prompt v4, section 12), beside Month and Agenda. Large and
// uncluttered: full page width, generous rows. The Timeline shows projects as continuous bars from their start to their
// due date, one lane each, coloured by stage or by urgency; a bar opens to show its sessions, published call sheets and
// episodes' due dates as dated markers. Week and Day list what falls on each day, by time where it has one.

const STAGE_CLASS: Record<WorkflowStage, string> = {
  Development: "st-dev",
  "Pre-production": "st-pre",
  Production: "st-prod",
  "Post production": "st-post",
  "Marketing and distribution": "st-mkt",
};
const LEVEL_CLASS: Record<string, string> = { Critical: "lvl-critical", High: "lvl-high", Watch: "lvl-watch", "On track": "lvl-ok" };
const MARK_LABEL: Record<string, string> = { session: "Session", callsheet: "Call sheet", episode: "Due" };

export const TIMELINE_WEEKS = 13;

/** The first day (a Sunday) of the week a date falls in. */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDaysIso(date, -dow);
}

/** The Timeline's window: from the Sunday a week before the anchor's week, for thirteen weeks. */
export function timelineWindow(anchor: string): { from: string; to: string; days: number } {
  const from = addDaysIso(weekStart(anchor), -7);
  return { from, to: addDaysIso(from, TIMELINE_WEEKS * 7 - 1), days: TIMELINE_WEEKS * 7 };
}

export function Timeline({ anchor, cat, colorBy }: { anchor: string; cat: CategoryKey | null; colorBy: "stage" | "urgency" }) {
  const { actor, go } = useApp();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const { from, to, days } = timelineWindow(anchor);
  const rows = timelineRows(actor, from, to).filter((r) => !cat || r.category === cat);
  const levels = colorBy === "urgency" ? new Map(urgencyReport(actor).map((u) => [u.id, u.level])) : new Map<string, string>();
  const pos = (date: string) => ((dayNumber(date) - dayNumber(from)) / days) * 100;
  const span = (r: TimelineRow) => {
    const a = Math.max(0, pos(r.start));
    const b = Math.min(100, pos(addDaysIso(r.end, 1)));
    return { left: a, width: Math.max(0.6, b - a), clipStart: r.start < from, clipEnd: r.end > to };
  };
  const months: { label: string; at: number }[] = [];
  // A label at each month's first day, and one at the start unless a month begins within the first week (they would overlap).
  for (let d = from; d <= to; d = addDaysIso(d, 1))
    if (d.endsWith("-01") || (d === from && dayNumber(addDaysIso(from.slice(0, 8) + "01", 32).slice(0, 8) + "01") - dayNumber(from) > 7))
      months.push({
        label: new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }),
        at: pos(d),
      });
  const weeks = Array.from({ length: TIMELINE_WEEKS }, (_, i) => addDaysIso(from, i * 7));
  const today = todayIso();
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <section className="glass panel tl" aria-label="Timeline">
      <div className="tl-head">
        <div className="tl-label tl-corner">
          {fmtDate(from)} to {fmtDate(to)}
        </div>
        <div className="tl-track tl-scale" aria-hidden="true">
          {months.map((m) => (
            <span key={m.label + m.at} className="tl-month" style={{ left: `${m.at}%` }}>
              {m.label}
            </span>
          ))}
          {weeks.map((w) => (
            <span key={w} className="tl-week" style={{ left: `${pos(w)}%` }}>
              {Number(w.slice(8))}
            </span>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty>No projects in these weeks.</Empty>
      ) : (
        <ul className="tl-rows">
          {rows.map((r) => {
            const s = span(r);
            const level = levels.get(r.id) ?? "On track";
            const tone = colorBy === "urgency" ? LEVEL_CLASS[level] : (STAGE_CLASS[r.stage as WorkflowStage] ?? "st-dev");
            const expanded = open.has(r.id);
            return (
              <li key={r.id} className="tl-row">
                <div className="tl-line">
                  <div className="tl-label">
                    <button
                      className="tl-expand"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Hide" : "Show"} the dates of ${r.title}`}
                      disabled={r.markers.length === 0}
                      onClick={() => toggle(r.id)}
                    >
                      {r.markers.length ? (expanded ? "▾" : "▸") : "·"}
                    </button>
                    <span className="tl-name">
                      <span className="tl-title">{r.title}</span>
                      <span className="tl-sub">
                        <span className="cat-dot" style={{ ["--cat-color" as string]: r.color }} /> {r.id} ·{" "}
                        {colorBy === "urgency" ? level : r.stage}
                      </span>
                    </span>
                  </div>
                  <div className="tl-track">
                    {today >= from && today <= to && <span className="tl-today" style={{ left: `${pos(today)}%` }} aria-hidden="true" />}
                    <button
                      className={`tl-bar ${tone}${r.openEnded ? " open-ended" : ""}${s.clipStart ? " clip-start" : ""}${s.clipEnd ? " clip-end" : ""}`}
                      style={{ left: `${s.left}%`, width: `${s.width}%` }}
                      title={`${r.title}: ${fmtDate(r.start)} to ${r.openEnded ? "no due date yet" : fmtDate(r.end)}`}
                      onClick={() => go(r.open)}
                    >
                      <span className="tl-bar-text">
                        {r.title}
                        {r.openEnded ? " · no due date" : ` · due ${fmtDate(r.end)}`}
                      </span>
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="tl-line tl-marks-line">
                    <div className="tl-label tl-marks-label">
                      {r.markers.length} date{r.markers.length === 1 ? "" : "s"}
                    </div>
                    <div className="tl-track">
                      {r.markers.map((m) => (
                        <button
                          key={`${m.kind}${m.date}${m.title}`}
                          className={`tl-mark ${m.kind}`}
                          style={{ left: `${pos(m.date) + 50 / days}%` }}
                          aria-label={`${MARK_LABEL[m.kind]}: ${m.title}, ${fmtDate(m.date)}`}
                          title={`${MARK_LABEL[m.kind]}: ${m.title}, ${fmtDate(m.date)}`}
                          onClick={() => go(m.open)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="cal-legend">
        {colorBy === "stage"
          ? (Object.keys(STAGE_CLASS) as WorkflowStage[]).map((st) => (
              <span key={st}>
                <i className={`tl-swatch ${STAGE_CLASS[st]}`} /> {st}
              </span>
            ))
          : Object.keys(LEVEL_CLASS).map((l) => (
              <span key={l}>
                <i className={`tl-swatch ${LEVEL_CLASS[l]}`} /> {l}
              </span>
            ))}
        <span>
          <i className="tl-mark session static" /> Session
        </span>
        <span>
          <i className="tl-mark callsheet static" /> Call sheet published
        </span>
        <span>
          <i className="tl-mark episode static" /> Episode due
        </span>
      </div>
    </section>
  );
}

const byTime = (a: CalEvent, b: CalEvent) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99") || a.title.localeCompare(b.title);

function EventCard({ e, date, onOpen, label }: { e: CalEvent; date: string; onOpen: (e: CalEvent, date: string) => void; label: string }) {
  return (
    <button className="cal-card" style={{ ["--cat-color" as string]: e.color }} onClick={() => onOpen(e, date)}>
      <i className={`cal-mark ${e.subtype}`} />
      <span className="cal-card-text">
        <span className="cal-card-title">
          {e.time && <b>{e.time} </b>}
          {e.days ? `${e.title}, day ${e.days.findIndex((x) => x.date === date) + 1} of ${e.days.length}` : e.title}
        </span>
        <span className="cal-card-sub">{label}</span>
      </span>
    </button>
  );
}

/** Seven days, each with what falls on it, by time where it has one. */
export function WeekView({
  start,
  events,
  labelOf,
  onOpen,
  onDay,
}: {
  start: string; // the Sunday
  events: CalEvent[];
  labelOf: (s: CalSubtype) => string;
  onOpen: (e: CalEvent, date: string) => void;
  onDay: (date: string) => void;
}) {
  const today = todayIso();
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(start, i));
  return (
    <section className="glass panel" aria-label="Week">
      <div className="cal-weekview">
        {days.map((d) => {
          const list = eventsOnDay(events, d)
            .filter((e) => e.subtype !== "stage" || e.endDate === d)
            .sort(byTime);
          return (
            <div key={d} className={`cal-wcol${d === today ? " today" : ""}`} aria-label={fmtDate(d)}>
              <button className="cal-wday" onClick={() => onDay(d)} title="Open this day">
                <span>{new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}</span>
                <b>{Number(d.slice(8))}</b>
              </button>
              {list.length === 0 ? (
                <span className="cal-none">Nothing</span>
              ) : (
                list.map((e) => <EventCard key={e.id} e={e} date={d} onOpen={onOpen} label={labelOf(e.subtype)} />)
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** One day: what falls on it, timed first, then the rest of the day. */
export function DayView({
  date,
  events,
  labelOf,
  onOpen,
  details,
}: {
  date: string;
  events: CalEvent[];
  labelOf: (s: CalSubtype) => string;
  onOpen: (e: CalEvent, date: string) => void;
  details: (e: CalEvent) => React.ReactNode;
}) {
  const list = eventsOnDay(events, date).sort(byTime);
  const timed = list.filter((e) => e.time);
  const allDay = list.filter((e) => !e.time);
  return (
    <section className="glass panel" aria-label="Day">
      <h2>
        {new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" })}, {fmtDate(date)}
        {date === todayIso() ? " · today" : ""}
      </h2>
      {list.length === 0 && <Empty>Nothing on this day.</Empty>}
      {timed.length > 0 && (
        <div className="cal-dayblock" aria-label="At a time">
          {timed.map((e) => (
            <div key={e.id} className="cal-dayrow">
              <span className="cal-daytime">{e.time}</span>
              <div className="grow">
                <EventCard e={e} date={date} onOpen={onOpen} label={labelOf(e.subtype)} />
                {details(e)}
              </div>
            </div>
          ))}
        </div>
      )}
      {allDay.length > 0 && (
        <div className="cal-dayblock" aria-label="All day">
          {allDay.map((e) => (
            <div key={e.id} className="cal-dayrow">
              <span className="cal-daytime muted">All day</span>
              <div className="grow">
                <EventCard e={e} date={date} onOpen={onOpen} label={`${labelOf(e.subtype)}. ${e.detail}`} />
                {details(e)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
