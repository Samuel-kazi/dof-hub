// Build prompt v4: the Call Sheets module as a read-only index (a sheet is made from its session or show day), and a
// recurring show's day marking, field by field, what it changed from its template (section 7).
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor, Database } from "../src/types";
import { enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { login } from "../src/services/auth";
import * as CS from "../src/services/wrapped/callsheets";
import * as P from "../src/services/wrapped/production";
import { daysOfEvent, sheetOfDay } from "../src/services/production";
import { todayIso } from "../src/services/utils";
import { AppProvider } from "../src/ui/AppContext";
import { CallSheetBody, CallSheets } from "../src/pages/CallSheets";
import { InstanceStrip } from "../src/pages/production/InstanceStrip";

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
const vespers = () =>
  P.createProduction(hop(), {
    title: "Friday Vespers",
    mode: "recurring",
    rule: {
      freq: "weekly",
      interval: 1,
      weekdays: [5],
      monthDay: null,
      nth: null,
      startDate: todayIso(),
      until: null,
      count: null,
      skipDates: [],
      extraDates: [],
    },
    callTime: "16:00",
    location: "Studio A",
  });

await t("the Call Sheets module is an index: every sheet to find and open, where it was made, and nothing made here", () => {
  // A sheet made on its own, before the rework, stays listed and opens.
  const own = CS.createCallSheet(hop(), { contentId: "DOF-SER-001-S1", title: "Old pickup day", date: todayIso() });
  const page = html(hop(), <CallSheets />);
  assert.ok(!page.includes("New call sheet"), "no New call sheet");
  assert.ok(page.includes("<th>Made from</th>"));
  assert.ok(page.includes("Session R01"), "a recording session's sheet says so");
  assert.ok(page.includes("On its own") && page.includes(own.title), "a sheet made on its own before stays here");
  assert.match(page, /made from its recording session or show day/);
});

await t("a recurring show's day says, field by field, what it changed from its template; ticks on the day are not changes", () => {
  const show = vespers();
  const [a, b] = daysOfEvent(show.contentId);
  assert.deepEqual(P.templateDiff(a.id), [], "a day just made is its template");
  // Work on the day: ticks, states and results are the day's own.
  const sa = sheetOfDay(a)!;
  CS.updateCallSheet(hop(), sa.id, {
    technicalCheck: sa.technicalCheck.map((x, i) => (i === 0 ? { ...x, state: "OK" as const, result: "Fine" } : x)),
  });
  assert.deepEqual(P.templateDiff(a.id), []);
  // A change of plan, by hand.
  const sb = sheetOfDay(b)!;
  CS.updateCallSheet(hop(), sb.id, { location: "Central Church", callTime: "15:00" });
  assert.deepEqual(
    P.templateDiff(b.id).map((f) => f.label),
    ["Crew call", "Location"],
  );
  const strip = html(hop(), <InstanceStrip day={getDb().recordingSessions.find((s) => s.id === b.id)!} write />);
  assert.match(strip, /Differs from the template in: Crew call, Location\./);
  const body = html(
    hop(),
    <CallSheetBody
      cs={sheetOfDay(getDb().recordingSessions.find((s) => s.id === b.id)!)!}
      root={getDb().records.find((r) => r.contentId === show.parentId)!}
    />,
  );
  assert.match(body, /Changed from the template: Crew call/);
  assert.match(body, /Changed from the template: Location/);
  // Put back on the template: no differences.
  P.resetToTemplate(hop(), b.id);
  assert.deepEqual(P.templateDiff(b.id), []);
  // A day of a one-time event has no template to differ from.
  const rally = P.createProduction(hop(), { title: "Rally", mode: "one_time", date: todayIso() });
  assert.deepEqual(P.templateDiff(daysOfEvent(rally.contentId)[0].id), []);
});

console.log(`\n${passed} passed`);
