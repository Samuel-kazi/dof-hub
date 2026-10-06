// Run with: npm test -- production
// One production system with three ways of making its days: a recurring show from its Show Template and schedule,
// a one-time event, and a multi-day event with its Event Plan. Every day has one call sheet; a day made from a
// template follows later template changes until someone edits it, and can be put back on the template.
import assert from "node:assert/strict";
import type { Actor, RecurrenceRule } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { buildSeed } from "../src/data/seed";
import { integrityProblems } from "../src/data/constraints";
import { upgradeToV19 } from "../src/data/migrate";
import { login } from "../src/services/auth";
import { visibleCallSheets } from "../src/services/access";
import * as CS from "../src/services/wrapped/callsheets";
import * as E from "../src/services/wrapped/equipment";
import * as P from "../src/services/wrapped/production";
import { daysOfShow, onBoard, productionOf, sheetOfDay, topUpRecurring, recurringDue } from "../src/services/production";
import { weeklyFrom } from "../src/services/recurrence";

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
const hop = (): Actor => login("hop@dof.demo", "demo");
const crew2 = (): Actor => login("crew2@dof.demo", "demo");
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e) => (e instanceof RuleError && (!match || match.test(e.message))) || assert.fail((e as Error).message));
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");
const record = (id: string) => getDb().records.find((r) => r.contentId === id)!;
const sheet = (dayId: string) => sheetOfDay(record(dayId))!;
const dates = (showId: string) => daysOfShow(showId).map((d) => d.scheduledDate);
// Today, in the tests, is Saturday 26 September 2026.
const FRIDAYS: RecurrenceRule = weeklyFrom("2026-10-02");

function vespers() {
  return P.createProduction(hop(), {
    title: "Friday Vespers",
    mode: "recurring",
    rule: FRIDAYS,
    callTime: "16:00",
    location: "DOF Studio A",
    assigneePersonId: "DOF-P-CRW-004",
  });
}
const templateOf = (showId: string) => getDb().showTemplates.find((x) => x.contentId === showId)!;

// ── One-time and multi-day events ────────────────────────────

await t("a one-time event has exactly one day and one call sheet, due around its own date", () => {
  const show = P.createProduction(hop(), {
    title: "Youth Rally",
    mode: "one_time",
    date: "2026-11-14",
    callTime: "07:30",
    location: "Kasarani",
  });
  assert.equal(productionOf(show)!.mode, "one_time");
  const days = daysOfShow(show.contentId);
  assert.equal(days.length, 1);
  const cs = sheetOfDay(days[0])!;
  assert.deepEqual([cs.date, cs.callTime, cs.location, cs.instanceId], ["2026-11-14", "07:30", "Kasarani", days[0].contentId]);
  assert.ok(cs.technicalCheck.length >= 4, "it starts with the usual technical check");
  assert.deepEqual(
    [days[0].stageDeadlines.Prep, days[0].stageDeadlines.Show, days[0].stageDeadlines.Review],
    ["2026-11-11", "2026-11-14", "2026-11-17"],
  );
  throwsRule(() => P.addEventDay(hop(), show.contentId, "2026-11-15"), /Only a multi-day event/);
  throwsRule(() => P.createProduction(hop(), { title: "No date", mode: "one_time" }), /date of the event/);
  throwsRule(() => P.createProduction(crew2(), { title: "Not mine", mode: "one_time", date: "2026-11-14" }), /Head of Production/);
  ok();
});

await t("a multi-day event has an Event Plan and a day and call sheet for each date; a day added copies the day before", () => {
  throwsRule(
    () => P.createProduction(hop(), { title: "Camp", mode: "multi_day", startDate: "2026-12-01", endDate: "2026-12-01" }),
    /at least two days/,
  );
  const show = P.createProduction(hop(), {
    title: "Camp Meeting",
    mode: "multi_day",
    startDate: "2026-12-01",
    endDate: "2026-12-03",
    location: "Kamagambo",
  });
  assert.deepEqual(dates(show.contentId), ["2026-12-01", "2026-12-02", "2026-12-03"]);
  assert.equal(new Set(daysOfShow(show.contentId).map((d) => sheetOfDay(d)?.id)).size, 3, "each day its own sheet");
  P.updateEventPlan(hop(), show.contentId, { overview: "Annual camp meeting", accommodation: "Dorm block B" });
  assert.equal(record(show.contentId).production!.eventPlan!.accommodation, "Dorm block B");
  const [first, second] = daysOfShow(show.contentId);
  CS.updateCallSheet(hop(), sheetOfDay(second)!.id, {
    callTime: "06:00",
    logistics: { ...sheetOfDay(second)!.logistics, meals: "Breakfast at 6" },
  });
  const added = P.addEventDay(hop(), show.contentId, "2026-11-30");
  assert.equal(added.scheduledDate, "2026-11-30");
  assert.deepEqual(
    daysOfShow(show.contentId).map((d) => d.title),
    ["Day 1", "Day 2", "Day 3", "Day 4"],
    "numbered again in date order",
  );
  assert.equal(sheetOfDay(added)!.location, "Kamagambo", "a day before the first copies the first day");
  const later = P.addEventDay(hop(), show.contentId, "2026-12-04");
  assert.equal(sheetOfDay(later)!.callTime, "08:00", "a day after the last copies the last day");
  const mid = sheetOfDay(record(second.contentId))!;
  assert.equal(mid.logistics.meals, "Breakfast at 6");
  throwsRule(() => P.addEventDay(hop(), show.contentId, "2026-12-01"), /already has a day/);
  assert.equal(record(show.contentId).showStart, "2026-11-30");
  assert.equal(record(show.contentId).showEnd, "2026-12-04");
  assert.ok(first);
  ok();
});

// ── Recurring shows ──────────────────────────────────────────

await t("a recurring show makes a day and call sheet for each date of its schedule, 12 weeks ahead, once", () => {
  const show = vespers();
  const t0 = templateOf(show.contentId);
  assert.equal(record(show.contentId).production!.templateId, t0.id);
  assert.deepEqual(dates(show.contentId), [
    "2026-10-02",
    "2026-10-09",
    "2026-10-16",
    "2026-10-23",
    "2026-10-30",
    "2026-11-06",
    "2026-11-13",
    "2026-11-20",
    "2026-11-27",
    "2026-12-04",
    "2026-12-11",
    "2026-12-18",
  ]);
  const d1 = daysOfShow(show.contentId)[0];
  assert.equal(d1.title, "Fri Oct 2, 2026");
  assert.deepEqual([d1.instance!.templateId, d1.instance!.occurrence, d1.instance!.locked], [t0.id, "2026-10-02", false]);
  assert.deepEqual([sheet(d1.contentId).callTime, sheet(d1.contentId).location], ["16:00", "DOF Studio A"]);
  assert.equal(recurringDue(), false, "nothing is missing");
  const before = getDb().records.length;
  assert.deepEqual(topUpRecurring(), { made: 0, booked: 0 });
  assert.equal(getDb().records.length, before, "running it again makes nothing");
  // Weeks later, the daily check makes the days that have come within 12 weeks.
  assert.equal(recurringDue("2026-10-20"), true);
  assert.equal(topUpRecurring("2026-10-20").made, 3);
  assert.equal(dates(show.contentId).at(-1), "2027-01-08");
  // The board shows the days from a week ago to two weeks ahead.
  const days = daysOfShow(show.contentId);
  assert.deepEqual(
    days.filter((d) => onBoard(d)).map((d) => d.scheduledDate),
    ["2026-10-02", "2026-10-09"],
  );
  ok();
});

await t("a template change reaches every coming day still following it; a day edited by hand keeps its own until reset", () => {
  const show = vespers();
  const t0 = templateOf(show.contentId);
  const [a, b, c] = daysOfShow(show.contentId);
  // Ticking the technical check on the day is not a change of plan.
  const tc = sheet(a.contentId).technicalCheck.map((x, i) => (i === 0 ? { ...x, done: true, note: "Synced" } : x));
  CS.updateCallSheet(hop(), sheet(a.contentId).id, { technicalCheck: tc });
  assert.equal(record(a.contentId).instance!.locked, false, "ticking does not lock");
  // Changing the location of the second Friday by hand does.
  CS.updateCallSheet(hop(), sheet(b.contentId).id, { location: "Central Church" });
  assert.equal(record(b.contentId).instance!.locked, true);
  // The third Friday's call sheet is issued (final).
  sheet(c.contentId).status = "final";
  commit();
  const r = P.updateShowTemplate(hop(), t0.id, {
    sheet: { location: "DOF Studio B", crewPersonIds: ["DOF-P-CRW-001", "DOF-P-CRW-003"], crewRoles: { "DOF-P-CRW-001": "Camera" } },
  });
  assert.ok(r.kept.includes(b.contentId) && r.kept.includes(c.contentId));
  assert.equal(r.updated.length, 10);
  assert.equal(sheet(a.contentId).location, "DOF Studio B");
  assert.deepEqual(sheet(a.contentId).crewPersonIds, ["DOF-P-CRW-001", "DOF-P-CRW-003"]);
  assert.ok(
    ["DOF-P-CRW-001", "DOF-P-CRW-003"].every((p) => getDb().members.some((m) => m.personId === p && m.projectContentId === show.contentId)),
    "people put on the crew are attached to the show, so they can open its call sheets",
  );
  throwsRule(() => P.updateShowTemplate(hop(), t0.id, { sheet: { crewPersonIds: ["DOF-P-PTR-001"] } }), /Partners review work/);
  assert.equal(sheet(a.contentId).technicalCheck[0].done, true, "what was ticked on the day stays ticked");
  assert.equal(sheet(b.contentId).location, "Central Church", "edited by hand: kept");
  assert.equal(sheet(c.contentId).location, "DOF Studio A", "final: kept");
  assert.equal(record(a.contentId).instance!.templateVersion, templateOf(show.contentId).version);
  // Put back on the template.
  P.resetToTemplate(hop(), b.contentId);
  assert.equal(record(b.contentId).instance!.locked, false);
  assert.equal(sheet(b.contentId).location, "DOF Studio B");
  // A published sheet is not changed by the template on its own, but can be put back on it by hand.
  P.resetToTemplate(hop(), c.contentId);
  assert.equal(sheet(c.contentId).location, "DOF Studio B");
  // Moving a day's date by hand moves the day, and it keeps its own from then on.
  CS.updateCallSheet(hop(), sheet(a.contentId).id, { date: "2026-10-03" });
  assert.deepEqual(
    [record(a.contentId).scheduledDate, record(a.contentId).stageDeadlines.Show, record(a.contentId).instance!.locked],
    ["2026-10-03", "2026-10-03", true],
  );
  throwsRule(() => CS.updateCallSheet(hop(), sheet(a.contentId).id, { date: "2026-10-09" }), /already on that date/);
  // Only those who plan the show change its template.
  throwsRule(() => P.updateShowTemplate(crew2(), t0.id, { sheet: { location: "x" } }), /Head of Production|view-only/);
  ok();
});

await t("a new schedule takes off coming days it no longer gives, unless they were edited or worked on, and brings them back", () => {
  const show = vespers();
  const t0 = templateOf(show.contentId);
  const days = daysOfShow(show.contentId);
  CS.updateCallSheet(hop(), sheet(days[2].contentId).id, { notes: "Guest choir" }); // edited by hand
  const r = P.setShowSchedule(hop(), t0.id, { ...FRIDAYS, weekdays: [6], startDate: "2026-10-03" }); // Saturdays instead
  assert.equal(r.removed.length, 11, "eleven untouched Fridays taken off (archived, not deleted)");
  assert.deepEqual(r.kept, [days[2].contentId], "the one edited by hand is left for a person to decide");
  assert.equal(r.made.length, 12, "the Saturdays made");
  assert.ok(record(days[0].contentId).archived && getDb().records.some((x) => x.contentId === days[0].contentId));
  assert.ok(!visibleCallSheets(hop()).some((cs) => cs.instanceId === days[0].contentId), "its sheet goes with it");
  const back = P.setShowSchedule(hop(), t0.id, FRIDAYS);
  assert.equal(back.restored.length, 11, "back on Fridays: the same days come back");
  assert.equal(record(days[0].contentId).archived, false);
  ok();
});

await t("template gear is booked on days within two weeks, never double-booked; later days keep it as a list until they come near", () => {
  const show = vespers();
  const t0 = templateOf(show.contentId);
  const cam = getDb().equipment.find((e) => e.trackingType === "serialized" && e.baseStatus === "active")!;
  // Already booked on 9 October by another call sheet.
  const other = CS.createCallSheet(hop(), { contentId: "DOF-SER-001-S1", date: "2026-10-09" });
  E.addGearToSheet(hop(), { id: other.id, contentId: other.contentId, date: other.date }, [{ equipmentId: cam.id, quantity: 1 }]);
  P.updateShowTemplate(hop(), t0.id, { sheet: { plannedGear: [{ equipmentId: cam.id, quantity: 1 }] } });
  const [oct2, oct9, oct16] = daysOfShow(show.contentId);
  assert.ok(
    E.manifestForSheet(sheet(oct2.contentId).id)?.lines.some((l) => l.equipmentId === cam.id),
    "2 October: booked",
  );
  assert.deepEqual(sheet(oct2.contentId).plannedGear, []);
  assert.ok(!E.manifestForSheet(sheet(oct9.contentId).id), "9 October: already booked elsewhere, so not booked twice");
  assert.equal(sheet(oct9.contentId).plannedGear.length, 1, "it stays on the list, to sort out by hand");
  assert.equal(sheet(oct16.contentId).plannedGear.length, 1, "16 October: more than two weeks ahead, still a list");
  assert.equal(record(oct2.contentId).instance!.locked, false, "booking the template's gear is not an edit");
  // A week later the daily check books it for 16 October.
  topUpRecurring("2026-10-03");
  assert.ok(E.manifestForSheet(sheet(oct16.contentId).id)?.lines.some((l) => l.equipmentId === cam.id));
  // The template drops the camera: the days following it release it.
  P.updateShowTemplate(hop(), t0.id, { sheet: { plannedGear: [] } });
  assert.ok(!E.manifestForSheet(sheet(oct2.contentId).id)?.lines.length);
  ok();
});

// ── Call sheets: every section, copied whole ─────────────────

await t("every call sheet has every section, and duplicating copies them all to the new date with nothing ticked", () => {
  const show = P.createProduction(hop(), { title: "Concert", mode: "one_time", date: "2026-11-20" });
  const cs = sheetOfDay(daysOfShow(show.contentId)[0])!;
  CS.updateCallSheet(hop(), cs.id, {
    talentCall: "15:00",
    startTime: "17:00",
    wrapTime: "21:00",
    locationAddress: "Ngong Road",
    talent: [{ id: "TL-aaaaaaaa", name: "Kenya Choir", role: "Performer", contact: "+254 7", callTime: "", notes: "" }],
    contacts: [{ id: "CT-aaaaaaaa", name: "Venue manager", role: "Venue", phone: "+254 8", email: "" }],
    runOfShow: [{ id: "RS-aaaaaaaa", time: "17:00", title: "Opening", durationMin: 10, ownerPersonId: null, notes: "" }],
    rehearsal: { time: "14:00", notes: "Full run", done: true },
  });
  throwsRule(() => CS.updateCallSheet(hop(), cs.id, { talentCall: "3pm" }), /hours and minutes/);
  throwsRule(() => CS.updateCallSheet(hop(), cs.id, { crewLeadId: "DOF-P-CRW-002" }), /lead must be on the crew/);
  const { sheet: copy } = CS.duplicateCallSheet(hop(), cs.id, "2026-11-27");
  assert.deepEqual(
    [copy.talentCall, copy.locationAddress, copy.talent[0].name, copy.contacts[0].role, copy.runOfShow[0].title],
    ["15:00", "Ngong Road", "Kenya Choir", "Venue", "Opening"],
  );
  assert.notEqual(copy.talent[0].id, "TL-aaaaaaaa", "new row IDs");
  assert.equal(copy.rehearsal.done, false, "nothing ticked on the copy");
  assert.equal(copy.instanceId, null, "a copy is no day's sheet");
  ok();
});

// ── Data version 19 ──────────────────────────────────────────

await t("upgrading to version 19 makes every live show a production and gives every coming day its call sheet, once", () => {
  const db = buildSeed() as ReturnType<typeof buildSeed>;
  for (const c of db.callSheets) {
    const x = c as unknown as Record<string, unknown>;
    for (const k of ["talent", "talentCall", "logistics", "contacts", "technicalCheck", "rehearsal", "instanceId", "plannedGear"])
      delete x[k];
  }
  for (const r of db.records) {
    delete r.production;
    delete r.instance;
  }
  delete (db as { showTemplates?: unknown }).showTemplates;
  const before = JSON.stringify(db.callSheets.map((c) => [c.id, c.title, c.location, c.callTime, c.crewPersonIds, c.runOfShow]));
  const up = upgradeToV19(structuredClone(db) as never);
  assert.equal(up.schemaVersion, 19);
  const one = up.records.find((r) => r.contentId === "DOF-LIVE-001")!;
  const five = up.records.find((r) => r.contentId === "DOF-LIVE-002")!;
  assert.equal(one.production!.mode, "one_time");
  assert.equal(five.production!.mode, "multi_day");
  assert.ok(five.production!.eventPlan, "with an empty Event Plan");
  assert.equal(up.callSheets.find((c) => c.id === "DOF-CS-002")!.instanceId, "DOF-LIVE-001-D1", "a day is linked to its sheet");
  const made = up.callSheets.filter((c) => c.contentId === "DOF-LIVE-002");
  assert.equal(made.length, 5, "each coming day without one gets a draft call sheet");
  assert.ok(made.every((c) => c.status === "draft" && c.instanceId));
  assert.equal(
    JSON.stringify(
      up.callSheets.filter((c) => !made.includes(c)).map((c) => [c.id, c.title, c.location, c.callTime, c.crewPersonIds, c.runOfShow]),
    ),
    before,
    "existing sheets keep what they had",
  );
  assert.ok(up.audit.some((a) => a.action === "migrate-productions"));
  assert.equal(JSON.stringify(upgradeToV19(structuredClone(up))), JSON.stringify(up), "running it again changes nothing");
  setDb(up);
  ok();
});

console.log(`\n${passed} passed`);
