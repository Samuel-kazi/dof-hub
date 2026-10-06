import { commit, getDb, transaction } from "./store";
import { applyReviewWindows } from "../services/workflow";
import { recurringDue, topUpRecurring } from "../services/production";
import { fireReminders } from "../services/alerts";

/**
 * The desktop app and the local demo have no server to run the daily check, so they run it themselves: when the app
 * opens, and every hour while it stays open. It only acts on a project whose review window has passed with no
 * decision, so running it often changes nothing more. Reminders fire into the bell every minute; there is no email
 * without the server. Returns a function that stops it.
 */
export function startLocalDailyChecks(): () => void {
  const run = () =>
    transaction(() => {
      if (applyReviewWindows().length) commit();
      // Recurring shows: their coming days, and the gear of days within two weeks.
      if (recurringDue()) {
        topUpRecurring();
        commit();
      }
    });
  const reminders = () =>
    transaction(() => {
      const now = new Date().toISOString();
      const due = (getDb().calendarReminders ?? []).some((r) => r.fireAt && r.fireAt <= now && !r.firedAt && r.channels.includes("app"));
      if (!due) return;
      fireReminders(getDb(), now);
      commit();
    });
  run();
  reminders();
  const timer = setInterval(run, 60 * 60 * 1000);
  const minute = setInterval(reminders, 60 * 1000);
  return () => {
    clearInterval(timer);
    clearInterval(minute);
  };
}
