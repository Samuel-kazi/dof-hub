import type { Actor, AppNotification, CalendarReminder, Database, ReminderTarget } from "../types";
import { RuleError } from "../types";
import { commit, getDb } from "../data/store";
import { localId } from "../data/ids";
import { logAudit } from "./audit";
import { canView, getRecord, isHop, visibleCallSheets } from "./access";
import { instanceLine, sessionInstance } from "./productionInstances";
import { addDaysIso, isIsoDate, todayIso } from "./utils";

// The Calendar's reminders and the bell (build prompt v2, section 12). A reminder is attached to something with a date,
// a recording session or show day, a call sheet, an episode's or a project's due date, or a loan's return, or stands
// alone. It fires `offsetMinutes` before that date and time: in the app, into each recipient's bell, and by email if
// chosen. Its date is always read again from what it is attached to, so moving a session moves its reminders.
//
// On Vercel's free plan the server runs on its own only once a day, so email goes out in the morning run for
// everything due before the next one; only reminders a day or more ahead can be emailed. The bell is exact whenever
// anyone has the app open.

export const OFFSETS = [
  { minutes: 0, label: "At the time" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 1440, label: "1 day before" },
  { minutes: 10080, label: "1 week before" },
] as const;
/** The shortest offset that can be emailed on the free plan: a day. */
export const EMAIL_MIN_OFFSET = 1440;
const MAX_OFFSET = 60 * 24 * 60; // 60 days
const NAIROBI_OFFSET_MIN = 180; // Africa/Nairobi is UTC+3 all year
const DEFAULT_TIME = "08:00"; // a reminder for a whole day fires from 08:00

/** A Nairobi date and time as an ISO instant. */
export function nairobiInstant(date: string, time: string): string {
  const [h, m] = (time || DEFAULT_TIME).split(":").map(Number);
  const t = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - NAIROBI_OFFSET_MIN) * 60_000;
  return new Date(t).toISOString();
}

export interface TargetWhen {
  date: string;
  time: string;
  title: string;
  link: string;
}

/** The date and time a reminder's target stands at now, what it is called, and where it opens. Undefined if gone or undated. */
export function targetWhen(db: Database, type: ReminderTarget, id: string): TargetWhen | undefined {
  if (type === "instance") {
    const s = db.recordingSessions.find((x) => x.id === id);
    const inst = s ? sessionInstance(s) : undefined;
    if (!inst?.date || inst.status === "cancelled") return undefined;
    return {
      date: inst.date,
      time: inst.start,
      title: instanceLine(inst),
      link: inst.callSheetId ? `#/callsheet/${inst.callSheetId}` : `#/session/${id}`,
    };
  }
  if (type === "callsheet") {
    const cs = db.callSheets.find((c) => c.id === id);
    return cs?.date ? { date: cs.date, time: cs.callTime, title: cs.title, link: `#/callsheet/${cs.id}` } : undefined;
  }
  if (type === "episode" || type === "project") {
    const r = db.records.find((x) => x.contentId === id);
    if (!r || r.archived) return undefined;
    const due = r.episode ? r.stageDeadlines[r.episode.stage] : (r.workflow ? r.stageDeadlines[r.workflow.stage] : null) || r.deadline;
    return due ? { date: due, time: "", title: `${r.title} due`, link: `#/record/${id}` } : undefined;
  }
  const loan = (db.loans ?? []).find((l) => l.id === id);
  return loan && loan.status === "out"
    ? { date: loan.expectedReturn, time: "", title: `${loan.borrowerName} returns ${loan.id}`, link: `#/equipment` }
    : undefined;
}

/** When a reminder is next due, from its target as it stands (or its own date if it stands alone). */
export function nextFireAt(db: Database, r: CalendarReminder): string | null {
  if (!r.targetType) return r.date ? new Date(Date.parse(nairobiInstant(r.date, r.time)) - r.offsetMinutes * 60_000).toISOString() : null;
  const when = targetWhen(db, r.targetType, r.targetId ?? "");
  if (!when) return null;
  return new Date(Date.parse(nairobiInstant(when.date, when.time)) - r.offsetMinutes * 60_000).toISOString();
}

export interface ReminderInput {
  targetType?: ReminderTarget | null;
  targetId?: string | null;
  title?: string;
  date?: string;
  time?: string;
  offsetMinutes?: number;
  channels?: ("app" | "email")[];
  recipientIds?: string[];
  repeat?: CalendarReminder["repeat"];
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function canSeeTarget(actor: Actor, type: ReminderTarget, id: string): boolean {
  const db = getDb();
  if (type === "loan") return (db.loans ?? []).some((l) => l.id === id);
  if (type === "callsheet") return visibleCallSheets(actor).some((c) => c.id === id);
  const rec = getRecord(id);
  if (rec) return canView(actor, rec.parentId && type === "instance" ? (getRecord(rec.parentId) ?? rec) : rec);
  const s = db.recordingSessions.find((x) => x.id === id);
  const p = s ? getRecord(s.contentId) : undefined;
  return !!p && canView(actor, p);
}

function check(actor: Actor, r: CalendarReminder): void {
  const db = getDb();
  if (r.targetType) {
    if (!r.targetId || !canSeeTarget(actor, r.targetType, r.targetId)) throw new RuleError("That item is not there to be reminded about.");
    if (!targetWhen(db, r.targetType, r.targetId))
      throw new RuleError("That item has no date yet, so there is nothing to time a reminder from.");
    if (r.repeat !== "none") throw new RuleError("Only a reminder standing alone repeats; one on an item follows its date.");
  } else {
    if (!r.title.trim()) throw new RuleError("Say what the reminder is for.");
    if (!isIsoDate(r.date)) throw new RuleError("Pick the reminder's date.");
  }
  if (r.title.length > 200) throw new RuleError("Keep the reminder under 200 characters.");
  if (r.time && !TIME.test(r.time)) throw new RuleError("Enter the time as hours and minutes, for example 09:30.");
  if (!Number.isInteger(r.offsetMinutes) || r.offsetMinutes < 0 || r.offsetMinutes > MAX_OFFSET)
    throw new RuleError("A reminder can come from the moment itself up to 60 days before.");
  if (!r.channels.length) throw new RuleError("Choose the bell, email, or both.");
  if (r.channels.includes("email") && r.offsetMinutes < EMAIL_MIN_OFFSET)
    throw new RuleError("Email reminders need to be a day or more ahead: the server sends email once each morning.");
  if (!r.recipientIds.length) throw new RuleError("Choose who gets the reminder.");
  if (r.recipientIds.length > 50) throw new RuleError("A reminder can go to up to 50 people.");
  for (const pid of r.recipientIds) {
    const p = db.people.find((x) => x.personId === pid);
    if (!p || p.status !== "active") throw new RuleError("Reminders go to active people.");
  }
  if (r.recipientIds.some((pid) => pid !== actor.personId) && !isHop(actor) && actor.role !== "CRW")
    throw new RuleError("You can set reminders for yourself.");
}

/** Sets a reminder on something with a date, or standing alone. */
export function createReminder(actor: Actor, input: ReminderInput): CalendarReminder {
  const at = new Date().toISOString();
  const r: CalendarReminder = {
    id: localId("RM"),
    targetType: input.targetType ?? null,
    targetId: input.targetType ? (input.targetId ?? null) : null,
    title: (input.title ?? "").trim(),
    date: input.targetType ? "" : (input.date ?? ""),
    time: input.time ?? "",
    offsetMinutes: input.offsetMinutes ?? 0,
    channels: [...new Set<"app" | "email">(input.channels ?? ["app"])],
    recipientIds: [...new Set(input.recipientIds?.length ? input.recipientIds : [actor.personId])],
    repeat: input.repeat ?? "none",
    fireAt: null,
    firedAt: null,
    emailedAt: null,
    createdBy: actor.personId,
    createdAt: at,
    updatedAt: at,
  };
  if (r.targetType) r.time = "";
  check(actor, r);
  r.fireAt = nextFireAt(getDb(), r);
  (getDb().calendarReminders ??= []).push(r);
  logAudit(actor, "create", "reminder", r.id, r.targetId ?? r.title);
  commit();
  return r;
}

function ownReminder(actor: Actor, id: string): CalendarReminder {
  const r = (getDb().calendarReminders ?? []).find((x) => x.id === id);
  if (!r) throw new RuleError("That reminder no longer exists.");
  if (r.createdBy !== actor.personId && !isHop(actor)) throw new RuleError("Only the person who set this reminder can change it.");
  return r;
}

/** Changes a reminder. Changing when it comes, or what it is on, lets it fire again. */
export function updateReminder(actor: Actor, id: string, input: ReminderInput): CalendarReminder {
  const r = ownReminder(actor, id);
  const next: CalendarReminder = {
    ...r,
    title: input.title !== undefined ? input.title.trim() : r.title,
    date: r.targetType ? "" : (input.date ?? r.date),
    time: r.targetType ? "" : (input.time ?? r.time),
    offsetMinutes: input.offsetMinutes ?? r.offsetMinutes,
    channels: input.channels ? [...new Set(input.channels)] : r.channels,
    recipientIds: input.recipientIds ? [...new Set(input.recipientIds)] : r.recipientIds,
    repeat: input.repeat ?? r.repeat,
  };
  check(actor, next);
  const fireAt = nextFireAt(getDb(), next);
  const moved = fireAt !== r.fireAt;
  Object.assign(r, next, { fireAt, updatedAt: new Date().toISOString() });
  if (moved) {
    r.firedAt = null;
    r.emailedAt = null;
  }
  logAudit(actor, "update", "reminder", id);
  commit();
  return r;
}

export function deleteReminder(actor: Actor, id: string): void {
  ownReminder(actor, id);
  getDb().calendarReminders = getDb().calendarReminders.filter((x) => x.id !== id);
  logAudit(actor, "delete", "reminder", id);
  commit();
}

/** The reminders on one item. */
export const remindersOn = (type: ReminderTarget, id: string): CalendarReminder[] =>
  (getDb().calendarReminders ?? []).filter((r) => r.targetType === type && r.targetId === id);

// ── Firing ───────────────────────────────────────────────────

/** The next date of a repeating reminder after this one. */
function advance(date: string, repeat: CalendarReminder["repeat"]): string {
  if (repeat === "daily") return addDaysIso(date, 1);
  if (repeat === "weekly") return addDaysIso(date, 7);
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function notifyPerson(db: Database, personId: string, n: Omit<AppNotification, "id" | "personId" | "at" | "readAt">, at: string): boolean {
  db.notifications ??= [];
  if (db.notifications.some((x) => x.personId === personId && x.key === n.key)) return false;
  db.notifications.push({ id: localId("NT"), personId, at, readAt: null, ...n });
  return true;
}

export interface FireResult {
  inApp: number; // notifications made
  emails: { personId: string; to: string; subject: string; body: string; key: string }[]; // to queue (server only)
}

/**
 * Fires what is due, on the data given (the server's, or the demo's on this device). In the app: reminders due by
 * `now`, into each recipient's bell. By email (`emailUntil` set, the server's morning run): reminders due before the
 * next run, so a reminder a day ahead is never emailed late. A repeating reminder moves to its next date once fired.
 */
export function fireReminders(db: Database, now: string, emailUntil?: string): FireResult {
  const out: FireResult = { inApp: 0, emails: [] };
  const people = new Map(db.people.map((p) => [p.personId, p]));
  for (const r of db.calendarReminders ?? []) {
    const fireAt = nextFireAt(db, r);
    if (fireAt !== r.fireAt) {
      // Its target moved: it fires again at the new time.
      r.fireAt = fireAt;
      r.firedAt = null;
      r.emailedAt = null;
    }
    if (!r.fireAt) continue;
    const when = r.targetType ? targetWhen(db, r.targetType, r.targetId ?? "") : undefined;
    const title = when ? `${when.title}${r.title ? `: ${r.title}` : ""}` : r.title;
    const day = when?.date ?? r.date;
    const link = when?.link ?? null;
    if (r.channels.includes("app") && !r.firedAt && r.fireAt <= now) {
      for (const pid of r.recipientIds)
        if (
          notifyPerson(
            db,
            pid,
            {
              title: "Reminder",
              body: `${title}, ${day}${when?.time ? ` at ${when.time}` : ""}`,
              link,
              key: `reminder:${r.id}:${r.fireAt}`,
            },
            now,
          )
        )
          out.inApp++;
      r.firedAt = now;
    }
    if (emailUntil && r.channels.includes("email") && !r.emailedAt && r.fireAt <= emailUntil) {
      for (const pid of r.recipientIds) {
        const p = people.get(pid);
        if (!p?.email || p.status !== "active") continue;
        out.emails.push({
          personId: pid,
          to: p.email,
          subject: `Reminder: ${title}`,
          body: `Hi ${p.name.split(" ")[0]},\n\n${title}: ${day}${when?.time ? ` at ${when.time}` : ""}.\n\nOpen the Production Hub for the details.\n\nDawn of Faith Production Hub`,
          key: `reminder:${r.id}:${r.fireAt}:${pid}`,
        });
      }
      r.emailedAt = now;
    }
    const appDone = !r.channels.includes("app") || !!r.firedAt;
    const emailDone = !r.channels.includes("email") || !!r.emailedAt;
    if (appDone && emailDone && r.repeat !== "none" && !r.targetType) {
      r.date = advance(r.date, r.repeat);
      r.fireAt = nextFireAt(db, r);
      r.firedAt = null;
      r.emailedAt = null;
    }
  }
  return out;
}

// ── The bell ─────────────────────────────────────────────────

/** This person's notifications, newest first. */
export const notificationsFor = (personId: string): AppNotification[] =>
  (getDb().notifications ?? []).filter((n) => n.personId === personId).sort((a, b) => b.at.localeCompare(a.at));

export const unreadCount = (personId: string): number => notificationsFor(personId).filter((n) => !n.readAt).length;

/** Marks some of one's own notifications read, or all of them with no IDs given. */
export function markNotificationsRead(actor: Actor, ids: string[]): number {
  const at = new Date().toISOString();
  let n = 0;
  for (const x of getDb().notifications ?? [])
    if (x.personId === actor.personId && !x.readAt && (!ids.length || ids.includes(x.id))) {
      x.readAt = at;
      n++;
    }
  commit();
  return n;
}

/** Keeps the bell short: read notifications older than 30 days go. */
export function pruneNotifications(db: Database, today = todayIso()): number {
  const before = (db.notifications ?? []).length;
  const cutoff = addDaysIso(today, -30);
  db.notifications = (db.notifications ?? []).filter((n) => !n.readAt || n.readAt.slice(0, 10) >= cutoff);
  return before - db.notifications.length;
}
