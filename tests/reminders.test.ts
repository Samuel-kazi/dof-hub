// Run with: npx tsx tests/reminders.test.ts
// Reminders, the calendar file and the messages that go out.
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { RuleError } from "../src/types";
import { login } from "../src/services/auth";
import * as R from "../src/services/reminders";
import * as P from "../src/services/permissions";
import { fold, googleCalendarLink, icsFor } from "../src/services/calendar";
import { getPerson } from "../src/services/people";
import { isoDay } from "../src/data/seed";

let passed = 0;
const t = (name: string, fn: () => void) => { resetDemoData(); try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; } };
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof RuleError && (!match || match.test(e.message)));
const hop = () => login("hop@dof.demo", "demo");
const crew2 = () => login("crew2@dof.demo", "demo");
const B = "DOF-P-CRW-002";
const W = "DOF-P-CRW-001";

t("reminders gather stage deadlines, checklist items, shoot days and gear to return", () => {
  const kinds = new Set(R.remindersFor(B).map((r) => r.kind));
  assert.ok(kinds.has("shoot") && kinds.has("gear") && kinds.has("stage") || kinds.has("task"), [...kinds].join());
  const w = R.remindersFor(W);
  assert.ok(w.some((r) => r.key === "task:T-0002"), "Picture lock checklist item");
  assert.ok(w.some((r) => r.key === "stage:DOF-SER-001-S1-E01:Editorial"), "the Editorial stage");
});
t("a shoot day has its call time, and late gear is marked late", () => {
  const rems = R.remindersFor(B);
  const shoot = rems.find((r) => r.key === "sheet:DOF-CS-001")!;
  assert.equal(shoot.time, "08:00"); assert.equal(shoot.date, isoDay(2));
  const gear = rems.find((r) => r.key === "gear:DOF-MF-002")!;
  assert.equal(gear.overdue, true);
});
t("reminders are in date order, and finished work is left out", () => {
  const rems = R.remindersFor(W);
  assert.deepEqual(rems.map((r) => r.date), [...rems.map((r) => r.date)].sort());
  assert.ok(!rems.some((r) => r.key === "task:T-0001"), "Story lock is done");
});
t("what is due soon depends on the lead time, and late items always count", () => {
  const short = R.dueSoon(B, 1);
  assert.ok(short.length > 0 && short.every((r) => r.overdue));
  assert.ok(R.dueSoon(B, 24 * 30).length > short.length);
});
t("someone with nothing on gets nothing", () => {
  assert.deepEqual(R.remindersFor("DOF-P-VOL-001"), []);
});

t("the email lists every item and the text is shorter", () => {
  const rems = R.remindersFor(B).slice(0, 5);
  const m = R.messageFor(getPerson(B)!, rems);
  assert.match(m.subject, /5 things coming up/);
  assert.ok(m.email.startsWith("Hi Brian,")); assert.equal(m.email.split("\n").filter((l) => l.startsWith("- ")).length, 5);
  assert.ok(m.text.length < m.email.length); assert.match(m.text, /and 1 more/);
  assert.ok(R.messageFor(getPerson(B)!, R.remindersFor(B).filter((r) => r.overdue)).email.includes("LATE"));
});
t("the mail and message links are safely encoded", () => {
  const p = { ...getPerson(B)!, email: "brian+ops@dof.demo", phone: "+254 700 123 456" };
  const m = { subject: "A & B", email: "Line one\nLine two", text: "Hi there" };
  assert.equal(R.mailtoLink(p, m), "mailto:brian%2Bops%40dof.demo?subject=A%20%26%20B&body=Line%20one%0ALine%20two");
  assert.equal(R.smsLink(p, m), "sms:+254700123456?body=Hi%20there");
});

t("the calendar file is valid, with an alert on every event", () => {
  const rems = R.remindersFor(B);
  const ics = icsFor(getPerson(B)!, rems, 24, new Date("2030-01-07T09:00:00Z"));
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")); assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends with CRLF");
  const events = ics.split("BEGIN:VEVENT").length - 1;
  assert.equal(events, rems.length); assert.equal(ics.split("BEGIN:VALARM").length - 1, events); assert.equal(ics.split("TRIGGER:-PT24H").length - 1, events);
  assert.ok(ics.includes("DTSTAMP:20300107T090000Z"));
});
t("all-day deadlines end the next day, and shoots start at their call time", () => {
  const ics = icsFor(getPerson(B)!, [{ key: "a", kind: "stage", title: "T", detail: "d", date: "2030-01-31", time: null, contentId: "x", category: "series", overdue: false }, { key: "b", kind: "shoot", title: "S", detail: "d", date: "2030-02-01", time: "08:30", contentId: "x", category: "series", overdue: false }], 12);
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20300131\r\nDTEND;VALUE=DATE:20300201"));
  assert.ok(ics.includes("DTSTART:20300201T083000\r\nDURATION:PT8H"));
  assert.ok(ics.includes("TRIGGER:-PT12H"));
});
t("commas, semicolons and line breaks are escaped, and each event has its own ID", () => {
  const ics = icsFor(getPerson(B)!, [{ key: "stage:A-1:Editorial", kind: "stage", title: "One, two; three", detail: "line\nbreak", date: "2030-01-31", time: null, contentId: "x", category: "series", overdue: false }, { key: "stage:A-2:Editorial", kind: "stage", title: "Two", detail: "d", date: "2030-01-31", time: null, contentId: "x", category: "series", overdue: false }], 24);
  assert.ok(ics.includes("SUMMARY:▢ One\\, two\\; three")); assert.ok(ics.includes("DESCRIPTION:line\\nbreak"));
  const uids = ics.match(/UID:.+/g)!; assert.equal(new Set(uids).size, 2);
});
t("long lines are folded at 75 bytes and unfold to the original", () => {
  const long = "SUMMARY:" + "Why do we doubt? ".repeat(12);
  const folded = fold(long);
  assert.ok(folded.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75));
  assert.equal(folded.replace(/\r\n /g, ""), long);
  const accented = fold("SUMMARY:" + "é".repeat(60));
  assert.ok(accented.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75));
});
t("the Google Calendar link carries the title, date and details", () => {
  const link = googleCalendarLink({ key: "k", kind: "stage", title: "Why do we doubt?: Editorial due", detail: "DOF-SER-001-S1-E01.", date: "2030-01-31", time: null, contentId: "x", category: "series", overdue: false });
  const u = new URL(link);
  assert.equal(u.host, "calendar.google.com"); assert.equal(u.searchParams.get("action"), "TEMPLATE");
  assert.equal(u.searchParams.get("text"), "▢ Why do we doubt?: Editorial due"); assert.equal(u.searchParams.get("dates"), "20300131/20300201");
  assert.equal(u.searchParams.get("colorId"), "6", "series gets its own Google colour");
  const timed = new URL(googleCalendarLink({ key: "k", kind: "shoot", title: "S", detail: "d", date: "2030-02-01", time: "08:00", contentId: "x", category: "series", overdue: false }));
  assert.equal(timed.searchParams.get("dates"), "20300201T080000/20300201T160000");
});

t("sending is recorded, and already-sent reminders are recognised", () => {
  const rems = R.dueSoon(B, 24 * 7);
  const e = R.logSent(hop(), B, "email", "Subject", "Body", rems.map((r) => r.key));
  assert.equal(getDb().outbox.length, 1); assert.equal(e.byPersonId, "DOF-P-HOP-001");
  assert.equal(R.alreadySent(B, rems).size, rems.length);
  assert.equal(R.lastSent(B)!.id, e.id);
  assert.ok(getDb().audit.some((a) => a.action === "reminder-email"));
});
t("crew can log their own calendar, but not send to others unless allowed", () => {
  assert.ok(R.logSent(crew2(), B, "calendar", "File", "3 events", ["a"]));
  throwsRule(() => R.logSent(crew2(), W, "email", "s", "b", ["a"]), /send reminders to other people/);
  P.setPersonGrant(hop(), B, "reminders.sendOthers", true);
  assert.ok(R.logSent(crew2(), W, "email", "s", "b", ["a"]));
});
t("reminders can be switched off for a person", () => {
  P.setPersonGrant(hop(), B, "reminders.use", false);
  throwsRule(() => R.logSent(crew2(), B, "calendar", "File", "x", []), /access to reminders/);
  assert.ok(!P.modulesFor(crew2()).includes("reminders"));
});

console.log(`\n${passed} passed`);
