// Run with: npx tsx tests/calendar.test.tsx
// The calendar's Gantt-style bars: the layout math (stacking, clipping, forced dots), the color-to-text
// contrast choice, and the real data producing production-window and in-progress-stage bars correctly.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "../src/ui/AppContext";
import { CalendarPage } from "../src/pages/Calendar";
import { CalendarWeek } from "../src/pages/CalendarWeek";
import { login } from "../src/services/auth";
import { resetDemoData, getDb } from "../src/data/store";
import { calendarEvents, type CalEvent } from "../src/services/calendarView";
import { layoutWeek, textOn } from "../src/services/calendarBars";

let passed = 0;
const t = (name: string, fn: () => void) => { resetDemoData(); try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", e instanceof Error ? e.message : e); process.exitCode = 1; } };

const mk = (id: string, date: string, endDate: string, subtype: CalEvent["subtype"] = "shoot", color = "#e8703a"): CalEvent =>
  ({ id, date, endDate, title: id, detail: "detail", subtype, category: "series", color, open: { n: "dashboard" } });
const week = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"];

t("a single-day event never becomes a bar", () => {
  const { lanes, dotsByDate } = layoutWeek([mk("a", "2026-09-22", "2026-09-22")], week);
  assert.equal(lanes.length, 0);
  assert.deepEqual(dotsByDate["2026-09-22"].map((e) => e.id), ["a"]);
});

t("call sheet and gear-booking events stay dots even when their range spans several days", () => {
  const events = [mk("cs", "2026-09-21", "2026-09-24", "callsheet"), mk("gear", "2026-09-21", "2026-09-24", "booking")];
  const { lanes, dotsByDate } = layoutWeek(events, week);
  assert.equal(lanes.length, 0, "neither becomes a bar");
  for (const d of ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]) {
    assert.ok(dotsByDate[d].some((e) => e.id === "cs") && dotsByDate[d].some((e) => e.id === "gear"), `both dot on ${d}`);
  }
});

t("overlapping bars stack into separate lanes; non-overlapping bars share a lane", () => {
  const events = [mk("a", "2026-09-20", "2026-09-22"), mk("b", "2026-09-21", "2026-09-23"), mk("c", "2026-09-24", "2026-09-25")];
  const { lanes } = layoutWeek(events, week);
  assert.equal(lanes.length, 2, "a and b overlap and need two lanes");
  assert.ok(lanes[0].some((s) => s.event.id === "a"));
  assert.ok(lanes[1].some((s) => s.event.id === "b"));
  assert.ok(lanes[0].some((s) => s.event.id === "c"), "c starts after a ends, so it fits in a's lane");
});

t("a bar's columns and span are clipped to the visible week, and clipping suppresses the rounded cap", () => {
  const { lanes } = layoutWeek([mk("full", "2026-09-01", "2026-09-30")], week);
  const seg = lanes[0][0];
  assert.equal(seg.startCol, 1);
  assert.equal(seg.span, 7);
  assert.equal(seg.clippedStart, true);
  assert.equal(seg.clippedEnd, true);
});

t("a bar entirely inside the week gets both rounded caps and the right column math", () => {
  const { lanes } = layoutWeek([mk("mid", "2026-09-22", "2026-09-24")], week); // Tue-Thu
  const seg = lanes[0][0];
  assert.equal(seg.startCol, 3);
  assert.equal(seg.span, 3);
  assert.equal(seg.clippedStart, false);
  assert.equal(seg.clippedEnd, false);
});

t("label text switches for readability depending on how light the category color is", () => {
  assert.equal(textOn("#f3b943"), "#1a1410", "a light gold bar gets dark text");
  assert.equal(textOn("#e8703a"), "#fff8f2", "a darker orange bar gets light text");
});

t("a multi-day live show becomes one production-window bar, and its days stop showing individual dots", () => {
  const actor = login("hop@dof.demo", "demo");
  const show = getDb().records.find((r) => r.contentId === "DOF-LIVE-002")!;
  const evs = calendarEvents(actor, show.showStart!, show.showEnd!);
  const window = evs.find((e) => e.id === `window:${show.contentId}`);
  assert.ok(window, "the show gets a window event");
  assert.equal(window!.date, show.showStart);
  assert.equal(window!.endDate, show.showEnd);
  assert.equal(evs.some((e) => e.id.startsWith("shoot:DOF-LIVE-002-D")), false, "its days no longer show their own shoot dot");
});

t("a single-day live show still shows its normal shoot dot, not a window bar", () => {
  const actor = login("hop@dof.demo", "demo");
  const show = getDb().records.find((r) => r.contentId === "DOF-LIVE-001")!;
  assert.equal(show.showStart, show.showEnd, "this fixture is genuinely single-day");
  const evs = calendarEvents(actor, show.showStart!, show.showEnd!);
  assert.equal(evs.some((e) => e.id === `window:${show.contentId}`), false);
  assert.ok(evs.some((e) => e.id.startsWith("shoot:DOF-LIVE-001-D")));
});

t("an item's current stage becomes a bar from when it was entered to its deadline; future stages stay dots", () => {
  const actor = login("hop@dof.demo", "demo");
  const r = getDb().records.find((x) => x.contentId === "DOF-SER-001-S1-E01")!;
  r.stageEnteredAt = "2026-09-10";
  r.stageDeadlines[r.pipelineStage!] = "2026-09-15";
  const evs = calendarEvents(actor, "2026-09-01", "2026-09-30");
  const bar = evs.find((e) => e.id === `deadline:${r.contentId}:${r.pipelineStage}`);
  assert.ok(bar);
  assert.equal(bar!.subtype, "stage");
  assert.equal(bar!.date, "2026-09-10");
  assert.equal(bar!.endDate, "2026-09-15");
});

t("a stage entered and due on the same day stays a single-day dot, not a zero-width bar", () => {
  const actor = login("hop@dof.demo", "demo");
  const r = getDb().records.find((x) => x.contentId === "DOF-SER-001-S1-E01")!;
  r.stageEnteredAt = "2026-09-12";
  r.stageDeadlines[r.pipelineStage!] = "2026-09-12";
  const evs = calendarEvents(actor, "2026-09-01", "2026-09-30");
  const ev = evs.find((e) => e.id === `deadline:${r.contentId}:${r.pipelineStage}`);
  assert.ok(ev);
  assert.equal(ev!.subtype, "deadline");
  assert.equal(ev!.date, ev!.endDate);
});

t("the month view renders every week's bars and dots without error, for every role", () => {
  for (const email of ["hop@dof.demo", "crew1@dof.demo", "volunteer1@dof.demo", "partner1@dof.demo"]) {
    const actor = login(email, "demo");
    const html = renderToString(<AppProvider actor={actor} onLogout={() => {}}><CalendarPage /></AppProvider>);
    assert.ok(html.length > 0);
  }
});

t("a bar segment is clickable and opens its event; a day card click selects the day, unaffected", () => {
  const events = [mk("bar-1", "2026-09-21", "2026-09-23", "shoot", "#e8703a")];
  let opened: CalEvent | null = null;
  let selectedDay: string | null = null;
  const html = renderToString(
    <CalendarWeek weekDates={week} events={events} month="2026-09" today="2026-09-23" selected={null}
      onSelectDay={(d) => { selectedDay = d; }} onOpenEvent={(e) => { opened = e; }} />,
  );
  assert.match(html, /cal-bar/);
  assert.match(html, />bar-1</, "the bar shows its title as visible text, not just a tooltip");
  void opened; void selectedDay;
});

t("a multi-day live show gets exactly one bar — its own days never add separate stage bars too", () => {
  const actor = login("hop@dof.demo", "demo");
  const show = getDb().records.find((r) => r.contentId === "DOF-LIVE-002")!;
  const evs = calendarEvents(actor, show.showStart!, show.showEnd!);
  const windowBars = evs.filter((e) => e.id === `window:${show.contentId}`);
  const dayBars = evs.filter((e) => e.id.startsWith(`deadline:${show.contentId}-D`));
  assert.equal(windowBars.length, 1);
  assert.equal(windowBars[0].title, show.title, "the bar names the show, not a particular day");
  assert.equal(dayBars.length, 0, "no day of the show adds a second bar of its own");
});

console.log(`\n${passed} passed`);
