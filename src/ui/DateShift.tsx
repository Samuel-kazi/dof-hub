import { addDaysIso } from "../services/utils";

/** Quick date shifts from a sheet's or session's date: the next day, a week on, two weeks on. */
export function DateShift({ from, value, onChange }: { from: string | null; value: string; onChange: (d: string) => void }) {
  if (!from) return null;
  return (
    <div className="row date-shift" role="group" aria-label="Shift the date">
      {[
        { days: 1, label: "+1 day" },
        { days: 7, label: "+1 week" },
        { days: 14, label: "+2 weeks" },
      ].map((s) => {
        const d = addDaysIso(from, s.days);
        return (
          <button key={s.days} type="button" className={`btn small ${value === d ? "primary" : ""}`} onClick={() => onChange(d)}>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
