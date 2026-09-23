import type { CalEvent } from "../services/calendarView";
import { layoutWeek, textOn } from "../services/calendarBars";

const BAR_HEIGHT = 19;
const BAR_GAP = 3;
const BAR_ROW = BAR_HEIGHT + BAR_GAP;

/**
 * One week of the calendar: each day is its own card, and a bar for anything spanning more than a
 * day floats on top of that row of cards — not a separate strip below them — positioned by percentage
 * so it reads as one continuous piece crossing the days it covers, with its title readable right on it.
 * Single-day events stay as small dots, at the bottom of the day they fall on, the same as before.
 *
 * Not wired into CalendarPage yet — this is the piece to look at on its own first.
 */
export function CalendarWeek({
  weekDates, events, month, today, selected, onSelectDay, onOpenEvent,
}: {
  weekDates: string[]; // 7 ISO dates, Sunday to Saturday
  events: CalEvent[]; // every event touching this week (or a wider window — layoutWeek clips to weekDates)
  month: string; // YYYY-MM, to grey out days outside the shown month
  today: string;
  selected: string | null;
  onSelectDay: (date: string) => void;
  onOpenEvent: (event: CalEvent) => void;
}) {
  const { lanes, dotsByDate } = layoutWeek(events, weekDates);
  const barSpace = lanes.length ? lanes.length * BAR_ROW + 6 : 0;

  return (
    <div className="cal-week">
      <div className="cal-week-days">
        {weekDates.map((date) => {
          const inMonth = date.slice(0, 7) === month;
          const dots = dotsByDate[date];
          return (
            <button
              key={date}
              className={`cal-day-card ${inMonth ? "" : "out"} ${date === today ? "today" : ""} ${date === selected ? "sel" : ""}`}
              onClick={() => onSelectDay(date)}
              aria-label={date}
              aria-pressed={date === selected}
            >
              <span className="cal-daynum">{Number(date.slice(8))}</span>
              {barSpace > 0 && <span className="cal-bar-space" style={{ height: barSpace }} />}
              {dots.length > 0 && (
                <span className="cal-marks">
                  {dots.slice(0, 4).map((e) => <i key={e.id} className={`cal-mark ${e.subtype}`} style={{ ["--cat-color" as string]: e.color }} title={`${e.title}${e.detail ? `. ${e.detail}` : ""}`} />)}
                  {dots.length > 4 && <span className="cal-more">+{dots.length - 4}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {lanes.length > 0 && (
        <div className="cal-bars-layer" style={{ height: barSpace }}>
          {lanes.map((lane, laneIdx) =>
            lane.map((seg) => (
              <button
                key={seg.event.id}
                className={`cal-bar ${seg.clippedStart ? "clip-start" : "cap-start"} ${seg.clippedEnd ? "clip-end" : "cap-end"}`}
                style={{
                  left: `${((seg.startCol - 1) / 7) * 100}%`,
                  width: `${(seg.span / 7) * 100}%`,
                  top: laneIdx * BAR_ROW,
                  ["--cat-color" as string]: seg.event.color,
                  color: textOn(seg.event.color),
                }}
                title={`${seg.event.title}${seg.event.detail ? `. ${seg.event.detail}` : ""}`}
                onClick={() => onOpenEvent(seg.event)}
              >
                {seg.event.title}
              </button>
            )),
          )}
        </div>
      )}
    </div>
  );
}
