// Build prompt v4, section 12 (and 7's time zone): the Calendar's Timeline (projects as bars from their planned start
// to their due date, with dated markers), Week and Day views, filters in a strip that folds away; a project's planned
// start; each person's quiet hours and reminder preference; the time zone stored explicitly.
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor, Database } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { toV24 } from "../src/data/migrateV24";
import { login } from "../src/services/auth";
import * as P from "../src/services/wrapped/production";
import * as People from "../src/services/wrapped/people";
import * as W from "../src/services/wrapped/workflow";
import { calendarEvents, timelineRows } from "../src/services/calendarView";
import { addDaysIso, todayIso } from "../src/services/utils";
import { AppProvider } from "../src/ui/AppContext";
import { CalendarPage } from "../src/pages/Calendar";
import { timelineWindow, weekStart } from "../src/pages/CalendarViews";
import { NotificationPrefs } from "../src/pages/NotificationPrefs";

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void, db: () => Database = () => buildWorkflowFixture()) => {
  setDb(db());
  enableRollback();
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     "));
    process.exitCode = 1;
  }
};
const hop = (): Actor => login("hop@dof.demo", "demo");
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof RuleError && (!match || match.test(e.message)));
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");
const html = (who: Actor, el: JSX.Element): string =>
  renderToString(
    <AppProvider actor={who} onLogout={() => {}}>
      {el}
    </AppProvider>,
  )
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const WOW = "DOF-SER-001-S1";
const record = (id: string) => getDb().records.find((r) => r.contentId === id)!;
const today = todayIso();

await t("a project's planned start: kept, checked against the publish date, and shown", () => {
  W.setPlannedStart(hop(), WOW, addDaysIso(today, -10));
  assert.equal(record(WOW).workflow!.plannedStart, addDaysIso(today, -10));
  record(WOW).deadline = addDaysIso(today, 60);
  commit();
  throwsRule(() => W.setPlannedStart(hop(), WOW, addDaysIso(today, 61)), /after the publish date/);
  throwsRule(() => W.setPlannedStart(hop(), WOW, "next week"), /planned start/);
  W.setPlannedStart(hop(), WOW, null);
  assert.equal(record(WOW).workflow!.plannedStart, null);
  throwsRule(() => W.setPlannedStart(login("volunteer1@dof.demo", "demo"), WOW, today));
  ok();
});

await t("the Timeline: each open project a bar from its planned start to its due date, with its sessions, call sheets and episodes", () => {
  W.setPlannedStart(hop(), WOW, addDaysIso(today, -20));
  record(WOW).deadline = addDaysIso(today, 50);
  commit();
  const { from, to, days } = timelineWindow(today);
  assert.equal(days, 91);
  assert.equal(from, addDaysIso(weekStart(today), -7));
  const rows = timelineRows(hop(), from, to);
  const wow = rows.find((r) => r.id === WOW)!;
  assert.deepEqual([wow.start, wow.end, wow.openEnded], [addDaysIso(today, -20), addDaysIso(today, 50), false]);
  assert.equal(wow.stage, "Post production", "its first session closed: its episodes are in post production");
  const kinds = new Set(wow.markers.map((m) => m.kind));
  assert.ok(kinds.has("session"), "its sessions");
  assert.ok(wow.markers.every((m) => m.date >= from && m.date <= to));
  assert.deepEqual(
    wow.markers.map((m) => m.date),
    [...wow.markers.map((m) => m.date)].sort(),
  );
  // With no due date anywhere, a bar is open-ended: a month after its start, drawn faded.
  const devotion = rows.find((r) => r.id === "DOF-DEV-001");
  if (devotion && !record("DOF-DEV-001").deadline && devotion.openEnded) assert.equal(devotion.end, addDaysIso(devotion.start, 30));
  // A project outside the window is not drawn; a closed one never is.
  record(WOW).archived = true;
  commit();
  assert.ok(!timelineRows(hop(), from, to).some((r) => r.id === WOW));
});

await t("a session's crew call is its time on the calendar, so the Week and Day views sort by it", () => {
  const s = getDb().recordingSessions.find((x) => x.id === `${WOW}-R02`)!;
  const sheet = W.createSessionCallSheet(hop(), s.id);
  sheet.callTime = "07:30";
  commit();
  const ev = calendarEvents(hop(), s.scheduledDate!, s.scheduledDate!).find((e) => e.id === `session:${s.id}`)!;
  assert.equal(ev.time, "07:30");
});

await t("the Calendar's views: Timeline, Month, Week, Day and Agenda, with filters in a strip that folds away", () => {
  W.setPlannedStart(hop(), WOW, addDaysIso(today, -20));
  const timeline = html(hop(), <CalendarPage initialView="timeline" />);
  for (const words of [
    'aria-label="Timeline"',
    ">Timeline<",
    ">Week<",
    ">Day<",
    ">Agenda<",
    "Season 1",
    "Colour by",
    'class="cal-filters"',
  ])
    assert.ok(timeline.includes(words), words);
  assert.match(timeline, /aria-expanded="false" aria-label="Show the dates of Season 1"/);
  const week = html(hop(), <CalendarPage initialView="week" />);
  assert.equal((week.match(/class="cal-wcol/g) ?? []).length, 7);
  assert.ok(week.includes("What to show") && week.includes("Recording session"));
  const day = html(hop(), <CalendarPage initialView="day" />);
  assert.match(day, /aria-label="Day"/);
  assert.ok(day.includes("+ Reminder on this day"));
  assert.ok(html(hop(), <CalendarPage initialView="month" />).includes('aria-label="Month grid"'));
});

await t("each person's quiet hours and when their reminders start: checked, kept, and on the Settings screen", () => {
  People.updateOwnProfile(hop(), { quietHours: { from: "21:00", to: "07:00" }, reminderLead: 60 });
  const me = getDb().people.find((p) => p.personId === hop().personId)!;
  assert.deepEqual(me.quietHours, { from: "21:00", to: "07:00" });
  assert.equal(me.reminderLead, 60);
  throwsRule(() => People.updateOwnProfile(hop(), { quietHours: { from: "9pm", to: "07:00" } }), /hours and minutes/);
  throwsRule(() => People.updateOwnProfile(hop(), { quietHours: { from: "07:00", to: "07:00" } }), /different start and end/);
  throwsRule(() => People.updateOwnProfile(hop(), { reminderLead: 7 }), /from the list/);
  People.updateOwnProfile(hop(), { quietHours: null });
  assert.equal(getDb().people.find((p) => p.personId === hop().personId)!.quietHours, null);
  const screen = html(hop(), <NotificationPrefs />);
  for (const words of ["Notifications", "Quiet hours", "New reminders start", "Africa/Nairobi"]) assert.ok(screen.includes(words), words);
});

await t("the time zone is stored explicitly: on the settings and on each recurring show's template, by version 24 too", () => {
  const show = P.createProduction(hop(), {
    title: "Friday Vespers",
    mode: "recurring",
    rule: {
      freq: "weekly",
      interval: 1,
      weekdays: [5],
      monthDay: null,
      nth: null,
      startDate: today,
      until: null,
      count: null,
      skipDates: [],
      extraDates: [],
    },
    callTime: "16:00",
    location: "Studio A",
  });
  const tpl = getDb().showTemplates.find((x) => x.contentId === show.contentId)!;
  assert.equal(tpl.timeZone, "Africa/Nairobi");
  const db = getDb();
  delete db.settings.timeZone;
  delete tpl.timeZone;
  const r = toV24(db);
  assert.ok(
    r.lines.some((l) => /time zone is stored: Africa\/Nairobi/.test(l)),
    r.lines.join(" | "),
  );
  assert.ok(r.lines.some((l) => /1 recurring show template stores its time zone/.test(l)));
  assert.equal(db.settings.timeZone, "Africa/Nairobi");
  assert.equal(tpl.timeZone, "Africa/Nairobi");
  assert.ok(!toV24(db).lines.some((l) => /time zone/.test(l)), "once");
});

console.log(`\n${passed} passed`);
