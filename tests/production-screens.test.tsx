// Run with: npm test -- production-screens
// The production screens: a show's panel (its schedule and days, an event's plan and day tabs, a one-time event's
// day), its template page, every call sheet's ten sections, the day's place on its template, and printing any sheet.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import { enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { login } from "../src/services/auth";
import * as CS from "../src/services/wrapped/callsheets";
import * as P from "../src/services/wrapped/production";
import { daysOfShow, sheetOfDay } from "../src/services/production";
import { weeklyFrom } from "../src/services/recurrence";
import { AppProvider } from "../src/ui/AppContext";
import { ProductionPanel } from "../src/pages/production/ProductionPanel";
import { ShowTemplatePage } from "../src/pages/production/ShowTemplatePage";
import { CallSheetBody } from "../src/pages/CallSheets";
import { PrintedCallSheet } from "../src/pages/documents/printCallSheet";
import { Pipeline } from "../src/pages/Pipeline";

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  setDb(buildWorkflowFixture());
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
const hop = () => login("hop@dof.demo", "demo");
const html = (who: string, el: JSX.Element): string =>
  renderToString(
    <AppProvider actor={login(who, "demo")} onLogout={() => {}}>
      {el}
    </AppProvider>,
  )
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const record = (id: string) => getDb().records.find((r) => r.contentId === id)!;
const SECTIONS = [
  "Schedule",
  "Crew",
  "Talent",
  "Location",
  "Equipment",
  "Logistics",
  "Contacts",
  "Run of Show",
  "Technical Check",
  "Rehearsal",
];

await t("a recurring show's panel: its schedule in words, its template, and its coming days, each following it or changed by hand", () => {
  const show = P.createProduction(hop(), { title: "Friday Vespers", mode: "recurring", rule: weeklyFrom("2026-10-02"), callTime: "16:00" });
  const [a, b] = daysOfShow(show.contentId);
  CS.updateCallSheet(hop(), sheetOfDay(b)!.id, { location: "Central Church" });
  const panel = html("hop@dof.demo", <ProductionPanel show={record(show.contentId)} />);
  for (const text of [
    "Recurring show",
    "Every Friday, from Oct 2, 2026",
    "12 weeks ahead",
    "Open the template",
    "Change the schedule",
    "Coming days",
    a.title,
    "Follows the template",
    "Changed by hand",
    "Call sheet",
  ])
    assert.ok(panel.includes(text), text);
  const readOnly = html("crew2@dof.demo", <ProductionPanel show={record(show.contentId)} />);
  assert.ok(!readOnly.includes("Change the schedule"), "only those who plan the show change its schedule");
  // The board shows two weeks of it, not three months.
  const board = html("hop@dof.demo", <Pipeline category="live" />);
  assert.ok(board.includes(a.title) && !board.includes(daysOfShow(show.contentId)[5].title), "the board shows the coming fortnight");
});

await t("the template page: workflow, then the call sheet's sections, with how many coming days follow it", () => {
  const show = P.createProduction(hop(), { title: "Friday Vespers", mode: "recurring", rule: weeklyFrom("2026-10-02") });
  const t0 = getDb().showTemplates[0];
  const page = html("hop@dof.demo", <ShowTemplatePage id={t0.id} />);
  for (const text of [
    "Template: Friday Vespers",
    "reaches the 12 coming days",
    "Level of production",
    "Days made ahead",
    ...SECTIONS,
    "Gear each day books",
  ])
    assert.ok(page.includes(text), text);
  assert.ok(!page.includes("Checked:"), "a template's checks are not ticked");
  assert.ok(record(show.contentId));
});

await t("every call sheet shows its ten sections, and a day of a recurring show says where it stands with the template", () => {
  const show = P.createProduction(hop(), { title: "Friday Vespers", mode: "recurring", rule: weeklyFrom("2026-10-02") });
  const day = daysOfShow(show.contentId)[0];
  const cs = sheetOfDay(day)!;
  const body = html("hop@dof.demo", <CallSheetBody cs={cs} root={record(show.contentId)} />);
  for (const text of [...SECTIONS, "Follows the template", 'aria-label="Sections of the call sheet"', "Days on this sheet"])
    assert.ok(body.includes(text), text);
  CS.updateCallSheet(hop(), cs.id, { notes: "Guest choir" });
  const edited = html("hop@dof.demo", <CallSheetBody cs={CS.getCallSheet(cs.id)!} root={record(show.contentId)} />);
  assert.match(edited, /Changed by hand/);
  assert.match(edited, /Put back on the template/);
});

await t("a multi-day event's panel: its Event Plan, a tab for each day, and a day to add; a one-time event shows its one day", () => {
  const camp = P.createProduction(hop(), { title: "Camp Meeting", mode: "multi_day", startDate: "2026-12-01", endDate: "2026-12-03" });
  const panel = html("hop@dof.demo", <ProductionPanel show={record(camp.contentId)} />);
  for (const text of [
    "Multi-day event",
    "Event Plan",
    "Overview",
    "Accommodation",
    'role="tab"',
    "Day 1",
    "Day 3",
    "Open the call sheet",
    "+ Add day",
  ])
    assert.ok(panel.includes(text), text);
  const rally = P.createProduction(hop(), { title: "Rally", mode: "one_time", date: "2026-11-14" });
  const one = html("hop@dof.demo", <ProductionPanel show={record(rally.contentId)} />);
  assert.match(one, /One-time event/);
  assert.match(one, /Day 1/);
  assert.ok(!one.includes("+ Add day"));
});

await t("any call sheet prints with its sections, and its run sheet alone", () => {
  const rally = P.createProduction(hop(), { title: "Rally", mode: "one_time", date: "2026-11-14", location: "Kasarani" });
  const cs = sheetOfDay(daysOfShow(rally.contentId)[0])!;
  CS.updateCallSheet(hop(), cs.id, {
    talent: [{ id: "TL-bbbbbbbb", name: "Kenya Choir", role: "Performer", contact: "+254 7", callTime: "", notes: "" }],
    logistics: { ...cs.logistics, transport: "Bus from the office at 6" },
    runOfShow: [{ id: "RS-bbbbbbbb", time: "10:00", title: "Opening", durationMin: 10, ownerPersonId: null, notes: "" }],
  });
  const printed = html("hop@dof.demo", <PrintedCallSheet job={{ sheetId: cs.id, only: "all" }} />);
  for (const text of [
    "Rally",
    "Day 1",
    "Nov 14, 2026",
    "Schedule",
    "<h2>Crew</h2>",
    "Kenya Choir",
    "Kasarani",
    "Bus from the office at 6",
    "Opening",
    "Technical check",
  ])
    assert.ok(printed.includes(text), text);
  const run = html("hop@dof.demo", <PrintedCallSheet job={{ sheetId: cs.id, only: "run" }} />);
  assert.ok(run.includes("Opening") && !run.includes("Kenya Choir"));
});

console.log(`\n${passed} passed`);
