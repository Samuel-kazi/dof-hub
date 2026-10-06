import { useState } from "react";
import type { RecurrenceRule } from "../../types";
import { describeRule, WEEKDAY_NAMES, weekdayOf } from "../../services/recurrence";
import { fmtDate } from "../../services/utils";
import { Field } from "../../ui/parts";

// When a recurring show happens: weekly on chosen days or monthly (by date, or "the first Friday"), every so many
// weeks or months, from a first date, until a date, a number of times, or with no end; dates left out and added.

type Ends = "never" | "until" | "count";
const NTH = [
  { v: 1, label: "first" },
  { v: 2, label: "second" },
  { v: 3, label: "third" },
  { v: 4, label: "fourth" },
  { v: -1, label: "last" },
] as const;

export function RuleEditor({
  value,
  onChange,
  disabled,
}: {
  value: RecurrenceRule;
  onChange: (r: RecurrenceRule) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<RecurrenceRule>) => onChange({ ...value, ...patch });
  const ends: Ends = value.until ? "until" : value.count ? "count" : "never";
  const byNth = value.freq === "monthly" && value.nth !== null;
  const [skip, setSkip] = useState("");
  const [extra, setExtra] = useState("");
  const startDay = value.startDate ? weekdayOf(value.startDate) : 5;
  const startDom = value.startDate ? Number(value.startDate.slice(8, 10)) : 1;
  return (
    <div className="stack rule-editor">
      <div className="cs-grid">
        <Field label="First date">
          <input
            type="date"
            aria-label="First date"
            value={value.startDate}
            disabled={disabled}
            onChange={(e) => {
              const d = e.target.value;
              if (!d) return;
              // A weekly show on one day follows the first date's day of the week.
              set({ startDate: d, ...(value.freq === "weekly" && value.weekdays.length <= 1 ? { weekdays: [weekdayOf(d)] } : {}) });
            }}
          />
        </Field>
        <Field label="Repeats">
          <select
            aria-label="Repeats"
            value={value.freq}
            disabled={disabled}
            onChange={(e) =>
              e.target.value === "weekly"
                ? set({ freq: "weekly", weekdays: [startDay], monthDay: null, nth: null })
                : set({ freq: "monthly", weekdays: [], monthDay: startDom, nth: null })
            }
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </Field>
        <Field label={value.freq === "weekly" ? "Every how many weeks" : "Every how many months"}>
          <input
            type="number"
            aria-label="Every how many"
            min={1}
            max={12}
            value={value.interval}
            disabled={disabled}
            onChange={(e) => set({ interval: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })}
          />
        </Field>
      </div>
      {value.freq === "weekly" ? (
        <fieldset className="rule-days" disabled={disabled}>
          <legend>On</legend>
          {WEEKDAY_NAMES.map((name, i) => (
            <label key={name} className="check">
              <input
                type="checkbox"
                checked={value.weekdays.includes(i)}
                onChange={(e) =>
                  set({ weekdays: e.target.checked ? [...value.weekdays, i].sort() : value.weekdays.filter((d) => d !== i) })
                }
              />
              <span>{name.slice(0, 3)}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="cs-grid">
          <Field label="On">
            <select
              aria-label="Monthly on"
              value={byNth ? "nth" : "day"}
              disabled={disabled}
              onChange={(e) =>
                e.target.value === "nth"
                  ? set({ monthDay: null, nth: { week: 1, weekday: startDay } })
                  : set({ monthDay: startDom, nth: null })
              }
            >
              <option value="day">A day of the month</option>
              <option value="nth">A day of the week</option>
            </select>
          </Field>
          {byNth ? (
            <>
              <Field label="Which">
                <select
                  aria-label="Which week"
                  value={value.nth!.week}
                  disabled={disabled}
                  onChange={(e) => set({ nth: { ...value.nth!, week: Number(e.target.value) as 1 | 2 | 3 | 4 | -1 } })}
                >
                  {NTH.map((n) => (
                    <option key={n.v} value={n.v}>
                      {n.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Day">
                <select
                  aria-label="Day of the week"
                  value={value.nth!.weekday}
                  disabled={disabled}
                  onChange={(e) => set({ nth: { ...value.nth!, weekday: Number(e.target.value) } })}
                >
                  {WEEKDAY_NAMES.map((n, i) => (
                    <option key={n} value={i}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <Field label="Day of the month">
              <input
                type="number"
                aria-label="Day of the month"
                min={1}
                max={31}
                value={value.monthDay ?? 1}
                disabled={disabled}
                onChange={(e) => set({ monthDay: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })}
              />
            </Field>
          )}
        </div>
      )}
      <div className="cs-grid">
        <Field label="Ends">
          <select
            aria-label="Ends"
            value={ends}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value as Ends;
              set(
                v === "never"
                  ? { until: null, count: null }
                  : v === "until"
                    ? { until: value.startDate, count: null }
                    : { until: null, count: 10 },
              );
            }}
          >
            <option value="never">No end</option>
            <option value="until">On a date</option>
            <option value="count">After a number of times</option>
          </select>
        </Field>
        {ends === "until" && (
          <Field label="Last date">
            <input
              type="date"
              aria-label="Last date"
              value={value.until ?? ""}
              disabled={disabled}
              onChange={(e) => e.target.value && set({ until: e.target.value })}
            />
          </Field>
        )}
        {ends === "count" && (
          <Field label="Times">
            <input
              type="number"
              aria-label="Times"
              min={1}
              max={520}
              value={value.count ?? 1}
              disabled={disabled}
              onChange={(e) => set({ count: Math.max(1, Math.min(520, Number(e.target.value) || 1)) })}
            />
          </Field>
        )}
      </div>
      <div className="cs-grid">
        <DateList
          label="Leave out"
          hint="A holiday"
          dates={value.skipDates}
          draft={skip}
          onDraft={setSkip}
          disabled={disabled}
          onChange={(skipDates) => set({ skipDates })}
        />
        <DateList
          label="Add a date"
          hint="A special service"
          dates={value.extraDates}
          draft={extra}
          onDraft={setExtra}
          disabled={disabled}
          onChange={(extraDates) => set({ extraDates })}
        />
      </div>
      {value.startDate && <p className="muted rule-summary">{describeRule(value, fmtDate)}</p>}
    </div>
  );
}

function DateList({
  label,
  hint,
  dates,
  draft,
  onDraft,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  dates: string[];
  draft: string;
  onDraft: (v: string) => void;
  onChange: (d: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rule-dates">
      <Field label={label}>
        <div className="row">
          <input type="date" aria-label={label} value={draft} disabled={disabled} title={hint} onChange={(e) => onDraft(e.target.value)} />
          <button
            className="btn small"
            disabled={disabled || !draft || dates.includes(draft)}
            onClick={() => {
              onChange([...dates, draft].sort());
              onDraft("");
            }}
          >
            + Add
          </button>
        </div>
      </Field>
      {dates.length > 0 && (
        <ul className="rule-chips">
          {dates.map((d) => (
            <li key={d}>
              {fmtDate(d)}
              {!disabled && (
                <button aria-label={`Remove ${fmtDate(d)}`} onClick={() => onChange(dates.filter((x) => x !== d))}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
