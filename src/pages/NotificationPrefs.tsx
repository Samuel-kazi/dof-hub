import { useState } from "react";
import { getDb, useDb } from "../data/store";
import { OFFSETS } from "../services/alerts";
import { updateOwnProfile } from "../services/wrapped/people";
import { useApp } from "../ui/AppContext";
import { Field } from "../ui/parts";

// Each person's own notification preferences (build prompt v4, section 12): email on top of the bell, quiet hours (no
// email in between; the bell still shows everything), and when a new reminder starts. The workspace's time zone is
// shown, as every date and time in the hub is in it.

export function NotificationPrefs() {
  useDb();
  const { actor, me: shell, attempt } = useApp();
  // Read straight from the data, so a change shows at once.
  const me = getDb().people.find((p) => p.personId === actor.personId) ?? shell;
  const [quiet, setQuiet] = useState(!!me.quietHours);
  const [from, setFrom] = useState(me.quietHours?.from ?? "21:00");
  const [to, setTo] = useState(me.quietHours?.to ?? "07:00");
  const zone = getDb().settings.timeZone || "Africa/Nairobi";
  const changed = quiet !== !!me.quietHours || (quiet && (from !== me.quietHours?.from || to !== me.quietHours?.to));
  return (
    <section className="glass panel" aria-label="Notifications">
      <h2>Notifications</h2>
      <div className="stack">
        <label className="check">
          <input
            type="checkbox"
            checked={!!me.notifyEmail}
            onChange={(e) => attempt(() => updateOwnProfile(actor, { notifyEmail: e.target.checked }), "Saved")}
          />
          <span>Email me my reminders too, not only in the bell</span>
        </label>
        <Field label="New reminders start">
          <select
            aria-label="New reminders start"
            value={me.reminderLead ?? 1440}
            onChange={(e) => attempt(() => updateOwnProfile(actor, { reminderLead: Number(e.target.value) }), "Saved")}
          >
            {OFFSETS.map((o) => (
              <option key={o.minutes} value={o.minutes}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
          <span>Quiet hours: no email from the hub between these times (the bell still shows everything)</span>
        </label>
        {quiet && (
          <div className="row" style={{ alignItems: "end" }}>
            <Field label="From">
              <input type="time" aria-label="Quiet from" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <input type="time" aria-label="Quiet to" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        )}
        {changed && (
          <div>
            <button
              className="btn primary"
              onClick={() => attempt(() => updateOwnProfile(actor, { quietHours: quiet ? { from, to } : null }), "Quiet hours saved")}
            >
              Save quiet hours
            </button>
          </div>
        )}
        <p className="muted">
          Every date and time in the hub is in{" "}
          {zone === "Africa/Nairobi" ? "Nairobi time (Africa/Nairobi, East Africa Time, UTC+3, no daylight saving)" : zone}, and so are the
          events it puts in Google Calendar.
        </p>
      </div>
    </section>
  );
}
