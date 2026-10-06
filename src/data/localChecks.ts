import { commit, transaction } from "./store";
import { applyReviewWindows } from "../services/workflow";
import { recurringDue, topUpRecurring } from "../services/production";

/**
 * The desktop app and the local demo have no server to run the daily check, so they run it themselves: when the app
 * opens, and every hour while it stays open. It only acts on a project whose review window has passed with no
 * decision, so running it often changes nothing more. Returns a function that stops it.
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
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  return () => clearInterval(timer);
}
