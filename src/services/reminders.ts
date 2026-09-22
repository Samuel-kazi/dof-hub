import type { Actor, OutboxEntry, Person } from "../types";
import { RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { categoryOf } from "../config/categories";
import { logAudit } from "./audit";
import { displayTitle, isComplete, isOwnerNow, ownersOf, usesPipeline } from "./content";
import { can, requireCan } from "./permissions";
import { getPerson } from "./people";
import { dayNumber, fmtShort, fromDayNumber, hoursUntilEndOfDay, pad, todayIso } from "./utils";

// Everything a person has coming up that they should not forget: stage deadlines, checklist items,
// shoot days and gear to bring back. These feed the bell, the calendar file and the email and text messages.

export interface Reminder {
  key: string; // stable, so a reminder that was already sent can be recognised
  kind: "stage" | "task" | "shoot" | "gear";
  title: string;
  detail: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM for shoot days
  contentId: string;
  overdue: boolean;
}

/** What is coming up for a person, from `asOf` for the next `days` days, plus anything already overdue. */
export function remindersFor(personId: string, asOf: string = todayIso(), days = 21): Reminder[] {
  const db = getDb();
  const horizon = fromDayNumber(dayNumber(asOf) + days);
  const out: Reminder[] = [];
  const add = (r: Omit<Reminder, "overdue">) => { if (r.date <= horizon) out.push({ ...r, overdue: r.date < asOf }); };

  for (const r of db.records) {
    if (r.archived || !usesPipeline(r) || !r.pipelineStage || isComplete(r)) continue;
    const stages = categoryOf(r.category).stages;
    const idx = stages.findIndex((s) => s.name === r.pipelineStage);
    stages.forEach((s, i) => {
      const due = r.stageDeadlines[s.name];
      const mine = i === idx ? isOwnerNow(r, personId) : ownersOf(r, s.name).some((o) => o.personId === personId);
      if (i >= idx && due && mine && !r.stageOutputs[s.name]) add({ key: `stage:${r.contentId}:${s.name}`, kind: "stage", title: `${displayTitle(r)}: ${s.name} due`, detail: `${r.contentId}. ${s.requiredOutput}.`, date: due, time: null, contentId: r.contentId });
    });
    for (const t of r.tasks) if (t.assigneePersonId === personId && !t.done && t.dueDate) add({ key: `task:${t.id}`, kind: "task", title: `${displayTitle(r)}: ${t.label} due`, detail: `${r.contentId}, ${t.stage}.`, date: t.dueDate, time: null, contentId: r.contentId });
  }
  for (const cs of db.callSheets) {
    if (cs.crewPersonIds.includes(personId) && cs.date >= asOf) add({ key: `sheet:${cs.id}`, kind: "shoot", title: `Shoot: ${cs.title}`, detail: `${cs.location || "Location to be confirmed"}. Call time ${cs.callTime}.`, date: cs.date, time: cs.callTime, contentId: cs.contentId });
  }
  for (const m of db.manifests) {
    if (m.responsiblePersonId === personId && m.destination === "outside" && m.status === "checked-out" && m.expectedReturn) add({ key: `gear:${m.id}`, kind: "gear", title: `Bring back the gear on ${m.id}`, detail: `${m.contentId}. ${m.lines.length} item${m.lines.length === 1 ? "" : "s"}.`, date: m.expectedReturn, time: null, contentId: m.contentId });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** The ones inside the lead time, or already late. These are what a message should mention. */
export function dueSoon(personId: string, leadHours: number = getDb().settings.stageReminderHours, asOf: string = todayIso()): Reminder[] {
  return remindersFor(personId, asOf, 30).filter((r) => r.overdue || (asOf === todayIso() ? hoursUntilEndOfDay(r.date) : (dayNumber(r.date) - dayNumber(asOf) + 1) * 24) <= leadHours);
}

export interface Message { subject: string; email: string; text: string }

/** A message for email and a shorter one for text. */
export function messageFor(person: Person, rems: Reminder[]): Message {
  const first = person.name.split(" ")[0];
  const line = (r: Reminder) => `${r.overdue ? "LATE, was " : ""}${fmtShort(r.date)}${r.time ? ` ${r.time}` : ""}: ${r.title}`;
  const n = rems.length;
  return {
    subject: `Dawn of Faith: ${n} thing${n === 1 ? "" : "s"} coming up`,
    email: `Hi ${first},\n\nThese are coming up for you:\n\n${rems.map((r) => `- ${line(r)}`).join("\n")}\n\nOpen the Production Hub for the details.\n\nDawn of Faith Production Hub`,
    text: `Dawn of Faith: ${rems.slice(0, 4).map(line).join("; ")}${n > 4 ? `; and ${n - 4} more` : ""}. Details in the Production Hub.`,
  };
}

export const mailtoLink = (person: Person, m: Message): string => `mailto:${encodeURIComponent(person.email)}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.email)}`;
export const smsLink = (person: Person, m: Message): string => `sms:${person.phone.replace(/[^+\d]/g, "")}?body=${encodeURIComponent(m.text)}`;

// ── The record of what was sent ──────────────────────────────

/** Notes that a message was sent or opened, so the same reminder is not sent twice by accident. */
export function logSent(actor: Actor, personId: string, channel: OutboxEntry["channel"], subject: string, body: string, keys: string[]): OutboxEntry {
  if (personId !== actor.personId) requireCan(actor, "reminders.sendOthers", "send reminders to other people");
  else if (!can(actor, "reminders.use")) throw new RuleError("You do not have access to reminders.");
  if (!getPerson(personId)) throw new RuleError("Person not found.");
  const e: OutboxEntry = { id: `MSG-${pad(nextCounter("outbox"), 5)}`, personId, channel, subject, body, keys, at: new Date().toISOString(), byPersonId: actor.personId };
  getDb().outbox.push(e);
  logAudit(actor, `reminder-${channel}`, "person", personId, `${keys.length} item${keys.length === 1 ? "" : "s"}`);
  commit();
  return e;
}

export const lastSent = (personId: string): OutboxEntry | undefined => getDb().outbox.filter((o) => o.personId === personId && o.channel !== "calendar").sort((a, b) => b.at.localeCompare(a.at))[0];

/** Which of these reminders have already been sent to the person, by any channel. */
export function alreadySent(personId: string, rems: Reminder[]): Set<string> {
  const sent = new Set(getDb().outbox.filter((o) => o.personId === personId && o.channel !== "calendar").flatMap((o) => o.keys));
  return new Set(rems.filter((r) => sent.has(r.key)).map((r) => r.key));
}
