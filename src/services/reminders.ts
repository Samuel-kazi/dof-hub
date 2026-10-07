import type { Actor, CategoryKey, OutboxEntry, Person } from "../types";
import { RuleError } from "../types";
import { commit, getDb } from "../data/store";
import { logId } from "../data/ids";
import { categoryOf } from "../config/categories";
import { logAudit } from "./audit";
import { daysInStage, displayTitle, isComplete, isOwnerNow, isStale, ownersOf, usesPipeline } from "./content";
import { getRecord } from "./access";
import { can, requireCan } from "./permissions";
import { getPerson } from "./people";
import { allWorkItems } from "./workItems";
import { dayNumber, fmtShort, fromDayNumber, hoursUntilEndOfDay, todayIso } from "./utils";
import { isHistory } from "./workflow/history";

// Everything a person has coming up that they should not forget: stage deadlines, checklist items,
// shoot days, recording sessions, reviews and gear to bring back. These feed the bell, the calendar file and the
// email and text messages.

export interface Reminder {
  key: string; // stable, so a reminder that was already sent can be recognised
  kind: "stage" | "task" | "shoot" | "gear" | "stale" | "session" | "review";
  title: string;
  detail: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM for shoot days
  contentId: string;
  sessionId: string | null; // a recording session's reminder opens the session rather than its project
  category: CategoryKey; // for colouring, matching the calendar's category colours
  overdue: boolean;
}

type NewReminder = Omit<Reminder, "overdue" | "sessionId"> & { sessionId?: string };

/**
 * The five-stage workflow's reminders (src/services/workItems.ts): a project's stage deadline to its owner, a
 * session's date to its producer, an episode's stage deadline to whoever moves it on, and a waiting review to each
 * reviewer named on it. Only episodes are ever overdue, so a project's deadline and a session's day are shown until
 * that day and then dropped, and a waiting review of a project is never late.
 */
function workflowReminders(personId: string, asOf: string, add: (r: NewReminder) => void): void {
  const sheets = getDb().callSheets;
  for (const item of allWorkItems()) {
    if (item.done) continue;
    const base = { contentId: item.level === "session" ? item.project.contentId : item.id, category: item.category, time: null };
    for (const review of item.reviews) {
      if (!review.reviewerIds.includes(personId)) continue;
      add({
        ...base,
        key: `review:${review.checkpointId}`,
        kind: "review",
        title: `${item.level === "episode" ? `${item.context}, ${item.title}` : item.title}: ${review.label} waiting for you`,
        detail: `${item.id}. Approve it, or send it back with what needs to change.`,
        date: item.level === "episode" && item.due ? item.due : asOf,
      });
    }
    if (item.ownerId !== personId || !item.due || !item.waitingOn.includes(personId)) continue;
    // An imported project's dates from before the import are history: no reminders for them.
    if (isHistory(item.project, item.due)) continue;
    if (item.level === "project" && item.due >= asOf)
      add({
        ...base,
        key: `stage:${item.id}:${item.stage}`,
        kind: "stage",
        title: `${item.title}: ${item.stage} due`,
        detail: `${item.id}. ${item.step}.`,
        date: item.due,
      });
    if (item.level === "session") {
      // A session is never overdue: it is a reminder of its day, until that day. Someone on its call sheet is already
      // reminded of the day as a shoot.
      const sheet = sheets.find((c) => c.id === getDb().recordingSessions.find((s) => s.id === item.id)?.callSheetId);
      if (item.due < asOf || sheet?.crewPersonIds.includes(personId)) continue;
      add({
        ...base,
        key: `session:${item.id}`,
        kind: "session",
        title: `${item.context}: ${item.title.toLowerCase()} recording`,
        detail: `${item.id}. ${item.step}.`,
        date: item.due,
        sessionId: item.id,
      });
    }
    if (item.level === "episode")
      add({
        ...base,
        key: `stage:${item.id}:${item.stage}`,
        kind: "stage",
        title: `${item.context}, ${item.title}: ${item.stage} due`,
        detail: `${item.id}. ${item.step}.`,
        date: item.due,
      });
  }
}

/** What is coming up for a person, from `asOf` for the next `days` days, plus anything already overdue. */
export function remindersFor(personId: string, asOf: string = todayIso(), days = 21): Reminder[] {
  const db = getDb();
  const horizon = fromDayNumber(dayNumber(asOf) + days);
  const out: Reminder[] = [];
  const add = (r: NewReminder) => {
    if (r.date <= horizon) out.push({ ...r, sessionId: r.sessionId ?? null, overdue: r.date < asOf });
  };

  for (const r of db.records) {
    if (r.archived || !usesPipeline(r) || !r.pipelineStage || isComplete(r) || r.category === "devotional" || r.category === "general")
      continue;
    const stages = categoryOf(r.category).stages;
    const idx = stages.findIndex((s) => s.name === r.pipelineStage);
    stages.forEach((s, i) => {
      const due = r.stageDeadlines[s.name];
      const mine = i === idx ? isOwnerNow(r, personId) : ownersOf(r, s.name).some((o) => o.personId === personId);
      if (i >= idx && due && mine && !r.stageOutputs[s.name])
        add({
          key: `stage:${r.contentId}:${s.name}`,
          kind: "stage",
          title: `${displayTitle(r)}: ${s.name} due`,
          detail: `${r.contentId}. ${s.requiredOutput}.`,
          date: due,
          time: null,
          contentId: r.contentId,
          category: r.category,
        });
    });
    // A stall has no deadline of its own to be "due", so it is surfaced right away, to the person
    // currently responsible for the stage — the same wording would be misleading for a real deadline.
    if (isOwnerNow(r, personId) && isStale(r)) {
      add({
        key: `stale:${r.contentId}:${r.pipelineStage}`,
        kind: "stale",
        title: `${displayTitle(r)}: no update in ${r.pipelineStage}`,
        detail: `${r.contentId}. No update in ${daysInStage(r)} days.`,
        date: asOf,
        time: null,
        contentId: r.contentId,
        category: r.category,
      });
    }
    for (const t of r.tasks)
      if (t.assigneePersonId === personId && !t.done && t.dueDate)
        add({
          key: `task:${t.id}`,
          kind: "task",
          title: `${displayTitle(r)}: ${t.label} due`,
          detail: `${r.contentId}, ${t.stage}.`,
          date: t.dueDate,
          time: null,
          contentId: r.contentId,
          category: r.category,
        });
  }
  for (const cs of db.callSheets) {
    if (cs.crewPersonIds.includes(personId) && cs.date >= asOf)
      add({
        key: `sheet:${cs.id}`,
        kind: "shoot",
        title: `Shoot: ${cs.title}`,
        detail: `${cs.location || "Location to be confirmed"}. Call time ${cs.callTime}.`,
        date: cs.date,
        time: cs.callTime,
        contentId: cs.contentId,
        category: getRecord(cs.contentId)?.category ?? "series",
      });
  }
  for (const m of db.manifests) {
    if (m.responsiblePersonId === personId && m.destination === "outside" && m.status === "checked-out" && m.expectedReturn)
      add({
        key: `gear:${m.id}`,
        kind: "gear",
        title: `Bring back the gear on ${m.id}`,
        detail: `${m.contentId}. ${m.lines.length} item${m.lines.length === 1 ? "" : "s"}.`,
        date: m.expectedReturn,
        time: null,
        contentId: m.contentId,
        category: getRecord(m.contentId)?.category ?? "series",
      });
  }
  workflowReminders(personId, asOf, add);
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

const insideLead = (r: Reminder, leadHours: number, asOf: string): boolean =>
  r.overdue || (asOf === todayIso() ? hoursUntilEndOfDay(r.date) : (dayNumber(r.date) - dayNumber(asOf) + 1) * 24) <= leadHours;

/** The ones inside the lead time, or already late. These are what a message should mention. */
export function dueSoon(personId: string, leadHours: number = getDb().settings.stageReminderHours, asOf: string = todayIso()): Reminder[] {
  return remindersFor(personId, asOf, 30).filter((r) => insideLead(r, leadHours, asOf));
}

/**
 * The five-stage workflow's reminders inside the lead time (24 hours unless changed in Settings), or late. The bell
 * shows these next to its stage deadlines, which come from getReminders in content.ts.
 */
export function workflowDueSoon(
  personId: string,
  leadHours: number = getDb().settings.stageReminderHours,
  asOf: string = todayIso(),
): Reminder[] {
  const out: Reminder[] = [];
  const horizon = fromDayNumber(dayNumber(asOf) + 30);
  workflowReminders(personId, asOf, (r) => {
    if (r.date <= horizon) out.push({ ...r, sessionId: r.sessionId ?? null, overdue: r.date < asOf });
  });
  return out.filter((r) => insideLead(r, leadHours, asOf)).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

export interface Message {
  subject: string;
  email: string;
  text: string;
}

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

export const mailtoLink = (person: Person, m: Message): string =>
  `mailto:${encodeURIComponent(person.email)}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.email)}`;
export const smsLink = (person: Person, m: Message): string =>
  `sms:${person.phone.replace(/[^+\d]/g, "")}?body=${encodeURIComponent(m.text)}`;

// ── The record of what was sent ──────────────────────────────

/** Notes that a message was sent or opened, so the same reminder is not sent twice by accident. */
export function logSent(
  actor: Actor,
  personId: string,
  channel: OutboxEntry["channel"],
  subject: string,
  body: string,
  keys: string[],
): OutboxEntry {
  if (personId !== actor.personId) requireCan(actor, "reminders.sendOthers", "send reminders to other people");
  else if (!can(actor, "reminders.use")) throw new RuleError("You do not have access to reminders.");
  if (!getPerson(personId)) throw new RuleError("Person not found.");
  const e: OutboxEntry = {
    id: logId("MSG"),
    personId,
    channel,
    subject,
    body,
    keys,
    at: new Date().toISOString(),
    byPersonId: actor.personId,
  };
  getDb().outbox.push(e);
  logAudit(actor, `reminder-${channel}`, "person", personId, `${keys.length} item${keys.length === 1 ? "" : "s"}`);
  commit();
  return e;
}

export const lastSent = (personId: string): OutboxEntry | undefined =>
  getDb()
    .outbox.filter((o) => o.personId === personId && o.channel !== "calendar")
    .sort((a, b) => b.at.localeCompare(a.at))[0];

/** Which of these reminders have already been sent to the person, by any channel. */
export function alreadySent(personId: string, rems: Reminder[]): Set<string> {
  const sent = new Set(
    getDb()
      .outbox.filter((o) => o.personId === personId && o.channel !== "calendar")
      .flatMap((o) => o.keys),
  );
  return new Set(rems.filter((r) => sent.has(r.key)).map((r) => r.key));
}
