import nodemailer, { type Transporter } from "nodemailer";
import type { Database } from "../src/types";
import { fireReminders, pruneNotifications } from "../src/services/alerts";
import { pruneEmails, queueEmail, takeDue, recordSend } from "../src/services/emailQueue";
import { loadDb, mutateState, withDb } from "./state";
import type { Store } from "./stores";

// Email, through the workspace's Google Workspace account (build prompt v2, section 12). The account is set in the
// server's environment, never in the code:
//   SMTP_USER   the sending address, for example hub@dawnoffaith.org (a Workspace mailbox)
//   SMTP_PASS   an app password for that mailbox (Google Account, Security, 2-Step Verification, App passwords)
//   SMTP_HOST   smtp.gmail.com unless set;  SMTP_PORT  465 unless set;  SMTP_FROM  the From line, SMTP_USER unless set
// Without SMTP_USER and SMTP_PASS nothing is sent and nothing is queued; the bell still works.
//
// Vercel's free plan runs the server on its own once a day (the cron in vercel.json, early morning in Nairobi): that
// run queues the emails of every reminder due before the next one, and sends them. Retries go out with later requests.

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}
export type Sender = (m: OutgoingEmail) => Promise<void>;

const env = () => ({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER ?? "",
  pass: process.env.SMTP_PASS ?? "",
  from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
});

export const emailAvailable = (): boolean => !!(env().user && env().pass);

let transport: Transporter | null = null;
/** Sends one email through the configured SMTP account. */
export const smtpSender: Sender = async (m) => {
  const c = env();
  transport ??= nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass } });
  await transport.sendMail({ from: c.from, to: m.to, subject: m.subject, text: m.text });
};

const SEND_LIMIT = 15; // per run, to stay well inside a function's time limit
const MORNING = 6 * 60; // 06:00 in Nairobi: the day's reminder emails are not queued before this

/**
 * Sends what is due in the queue, up to a limit. Each message is leased first, in one save, so two requests at the
 * same moment never send the same one; then sent; then its result saved.
 */
export async function drainEmail(
  store: Store,
  send: Sender = smtpSender,
  now = new Date().toISOString(),
): Promise<{ sent: number; failed: number }> {
  if (send === smtpSender && !emailAvailable()) return { sent: 0, failed: 0 };
  const taken = (await mutateState(store, (db) => takeDue(db, now, SEND_LIMIT).map((m) => ({ ...m })))).result;
  if (!taken.length) return { sent: 0, failed: 0 };
  const results: { id: string; error: string | null }[] = [];
  for (const m of taken) {
    try {
      await send({ to: m.to, subject: m.subject, text: m.body });
      results.push({ id: m.id, error: null });
    } catch (e) {
      results.push({ id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const done = new Date().toISOString();
  await mutateState(store, (db) => results.forEach((r) => recordSend(db, r.id, done, r.error)));
  const failed = results.filter((r) => r.error).length;
  if (failed) console.warn(`Email: ${failed} of ${results.length} could not be sent this time; they are tried again later.`);
  return { sent: results.length - failed, failed };
}

const nairobiMinutes = (iso: string): number => {
  const d = new Date(Date.parse(iso) + 180 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const nairobiDay = (iso: string): string => new Date(Date.parse(iso) + 180 * 60_000).toISOString().slice(0, 10);

/** Whether anything in the app's reminders is due by now (read only, cheap). */
function anyDue(db: Database, now: string): boolean {
  return (db.calendarReminders ?? []).some((r) => r.fireAt && r.fireAt <= now && r.channels.includes("app") && !r.firedAt);
}

const lastAppRun = new WeakMap<Store, number>();
const emailedOn = new WeakMap<Store, string>();
const lastDrain = new WeakMap<Store, number>();

/**
 * Reminders and email, riding on requests (and run in full by the morning cron with `morning`):
 * - the bell: reminders due by now fire into each recipient's bell, checked at most once a minute;
 * - email: once a day, from 06:00 in Nairobi (or at the cron), reminders due before the next day's run are queued;
 * - the queue is worked through then, and retried at most every five minutes.
 * A failure is logged and never stops the request it rode on.
 */
export async function alertChecks(store: Store, opts: { morning?: boolean; send?: Sender; now?: string } = {}): Promise<void> {
  const now = opts.now ?? new Date().toISOString();
  const t = Date.parse(now);
  try {
    const loaded = await loadDb(store);
    if (!loaded) return;
    const mailing = opts.send !== undefined || emailAvailable();
    const day = nairobiDay(now);
    const morningDue = mailing && (opts.morning || (emailedOn.get(store) !== day && nairobiMinutes(now) >= MORNING));
    const appDue = t - (lastAppRun.get(store) ?? 0) >= 60_000 && withDb(loaded.db, () => anyDue(loaded.db, now));
    if (morningDue || appDue) {
      const until = morningDue ? new Date(t + 24 * 3_600_000).toISOString() : undefined;
      await mutateState(store, (db) => {
        const fired = fireReminders(db, now, until);
        for (const e of fired.emails) queueEmail(db, e, now);
        if (morningDue) {
          pruneNotifications(db, day);
          pruneEmails(db, now);
        }
      });
      lastAppRun.set(store, t);
      if (morningDue) emailedOn.set(store, day);
    }
    if (mailing && (morningDue || t - (lastDrain.get(store) ?? 0) >= 5 * 60_000)) {
      lastDrain.set(store, t);
      await drainEmail(store, opts.send ?? smtpSender, now);
    }
  } catch (e) {
    console.error("Reminders and email check failed", e);
  }
}
