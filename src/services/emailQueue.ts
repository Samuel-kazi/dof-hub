import type { Database, EmailMessage } from "../types";
import { localId } from "../data/ids";

// The email queue (build prompt v2, section 12). Emails are queued on the server, never in a browser, and sent through
// the workspace's Google Workspace SMTP account (server/email.ts). A failed send is tried again later, five times in
// all, waiting longer each time; a person's quiet hours hold their email until the hours end. On Vercel's free plan
// the queue is worked through by the morning run and by later requests, so retries come when the app is next used.

export const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = [5, 30, 120, 720]; // after the 1st, 2nd, 3rd and 4th failure
const LEASE_MINUTES = 5; // a message being sent is not picked up again for this long
const NAIROBI_OFFSET_MIN = 180;

export interface NewEmail {
  personId: string | null;
  to: string;
  subject: string;
  body: string;
  key: string; // what it is about: the same key is never queued twice
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Queues an email unless one with the same key is already queued or sent. Returns whether it was queued. */
export function queueEmail(db: Database, e: NewEmail, now: string): boolean {
  db.emailQueue ??= [];
  if (!EMAIL.test(e.to.trim())) return false;
  if (db.emailQueue.some((m) => m.key === e.key)) return false;
  db.emailQueue.push({
    id: localId("EM"),
    personId: e.personId,
    to: e.to.trim(),
    subject: e.subject.slice(0, 300),
    body: e.body.slice(0, 20_000),
    key: e.key,
    status: "queued",
    attempts: 0,
    nextTryAt: now,
    createdAt: now,
    sentAt: null,
    lastError: "",
  });
  return true;
}

/** Minutes past Nairobi midnight for an instant. */
const nairobiMinutes = (iso: string): number => {
  const d = new Date(Date.parse(iso) + NAIROBI_OFFSET_MIN * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** When a person's quiet hours end, if `now` falls inside them; null if it does not (or they have none). */
export function quietUntil(quiet: { from: string; to: string } | null | undefined, now: string): string | null {
  if (!quiet?.from || !quiet.to || quiet.from === quiet.to) return null;
  const m = nairobiMinutes(now);
  const from = toMinutes(quiet.from);
  const to = toMinutes(quiet.to);
  const inside = from < to ? m >= from && m < to : m >= from || m < to;
  if (!inside) return null;
  const wait = (to - m + 24 * 60) % (24 * 60);
  return new Date(Date.parse(now) + wait * 60_000).toISOString();
}

/**
 * Takes the messages due to be sent now, up to `limit`, and leases them: they are not due again for a few minutes, so
 * two requests working through the queue at the same moment do not send the same message twice. Messages for someone
 * in their quiet hours are moved to when the hours end instead.
 */
export function takeDue(db: Database, now: string, limit: number): EmailMessage[] {
  const people = new Map(db.people.map((p) => [p.personId, p]));
  const due: EmailMessage[] = [];
  for (const m of db.emailQueue ?? []) {
    if (m.status !== "queued" || m.nextTryAt > now) continue;
    const quiet = quietUntil(m.personId ? people.get(m.personId)?.quietHours : null, now);
    if (quiet) {
      m.nextTryAt = quiet;
      continue;
    }
    if (due.length >= limit) break;
    m.nextTryAt = new Date(Date.parse(now) + LEASE_MINUTES * 60_000).toISOString();
    due.push(m);
  }
  return due;
}

/** Records how a send went: sent, or failed and tried again later, until the last try. */
export function recordSend(db: Database, id: string, now: string, error: string | null): void {
  const m = (db.emailQueue ?? []).find((x) => x.id === id);
  if (!m) return;
  m.attempts += 1;
  if (!error) {
    m.status = "sent";
    m.sentAt = now;
    m.lastError = "";
    return;
  }
  m.lastError = error.slice(0, 500);
  if (m.attempts >= MAX_ATTEMPTS) {
    m.status = "failed";
    return;
  }
  m.nextTryAt = new Date(Date.parse(now) + RETRY_MINUTES[Math.min(m.attempts - 1, RETRY_MINUTES.length - 1)] * 60_000).toISOString();
}

/** Keeps the queue short: sent and failed messages older than 60 days go. */
export function pruneEmails(db: Database, now: string): number {
  const cutoff = new Date(Date.parse(now) - 60 * 86_400_000).toISOString();
  const before = (db.emailQueue ?? []).length;
  db.emailQueue = (db.emailQueue ?? []).filter((m) => m.status === "queued" || m.createdAt >= cutoff);
  return before - db.emailQueue.length;
}
