// Run with: npm test -- callsheet-improvements
// Call sheet improvements: duplicating a sheet or a session to another date, soft warnings, crew and talent
// confirming, saved locations, the change log once a sheet is shared or confirmed, and gear suggested from roles.
import assert from "node:assert/strict";
import type { Actor, CallSheet } from "../src/types";
import { RuleError } from "../src/types";
import { enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { buildSeed } from "../src/data/seed";
import { integrityProblems } from "../src/data/constraints";
import { upgradeToV20 } from "../src/data/migrate";
import { login } from "../src/services/auth";
import * as CS from "../src/services/wrapped/callsheets";
import * as E from "../src/services/wrapped/equipment";
import * as L from "../src/services/wrapped/locations";
import * as P from "../src/services/wrapped/production";
import * as W from "../src/services/wrapped/workflow";
import { daysOfShow, sheetOfDay } from "../src/services/production";
import { gearSuggestions, sheetWarnings, unconfirmedCrew } from "../src/services/sheetAdvice";
import { changesOf, confirmationHolds } from "../src/services/sheetTracking";
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
const crew = (n: number): Actor => login(`crew${n}@dof.demo`, "demo");
const vol = (): Actor => login("volunteer1@dof.demo", "demo");
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e) => (e instanceof RuleError && (!match || match.test(e.message))) || assert.fail((e as Error).message));
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");
const get = (id: string) => getDb().callSheets.find((c) => c.id === id)!;
const camera = (id: string) => getDb().equipment.find((e) => e.id === id)!;
// Today, in the tests, is Saturday 26 September 2026.

/** A one-time event's call sheet, with two crew (camera and audio), a lead, a location and a talent row. */
function eventSheet(date = "2026-10-20"): CallSheet {
  const show = P.createProduction(hop(), { title: "Youth Rally", mode: "one_time", date, callTime: "07:30", location: "Kasarani" });
  const cs = sheetOfDay(daysOfShow(show.contentId)[0])!;
  CS.updateCallSheet(hop(), cs.id, {
    crewPersonIds: ["DOF-P-CRW-002", "DOF-P-CRW-003"],
    crewRoles: { "DOF-P-CRW-002": "Camera 1", "DOF-P-CRW-003": "Audio" },
    crewLeadId: "DOF-P-CRW-002",
    talent: [{ id: "TL-aaaaaaaa", name: "Pastor Mwangi", role: "Speaker", contact: "", callTime: "", notes: "" }],
    talentCall: "09:00",
  });
  return get(cs.id);
}

// ── Duplicating ──────────────────────────────────────────────

await t(
  "duplicating a call sheet to another date copies every section, clears ticks and confirmations, and never double-books gear",
  () => {
    const cs = eventSheet();
    CS.updateCallSheet(hop(), cs.id, {
      runOfShow: [{ id: "RS-aaaaaaaa", time: "09:00", title: "Opening", durationMin: 10, ownerPersonId: null, notes: "" }],
      rehearsal: { time: "08:00", notes: "", done: true },
    });
    CS.confirmOnSheet(crew(2), cs.id, "DOF-P-CRW-002", true);
    E.addGearToSheet(hop(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [
      { equipmentId: "DOF-EQ-CAM-001", quantity: 1 },
      { equipmentId: "DOF-EQ-CAM-002", quantity: 1 },
    ]);
    // A week on, one of the two bodies is already booked by another sheet.
    const other = CS.createCallSheet(hop(), { contentId: "DOF-SER-001", date: "2026-10-27" });
    E.addGearToSheet(hop(), { id: other.id, contentId: other.contentId, date: other.date }, [
      { equipmentId: "DOF-EQ-CAM-002", quantity: 1 },
    ]);
    const { sheet: copy, gear } = CS.duplicateCallSheet(hop(), cs.id, "2026-10-27");
    assert.equal(copy.date, "2026-10-27");
    assert.deepEqual(
      [copy.callTime, copy.talentCall, copy.location, copy.crewPersonIds, copy.crewRoles["DOF-P-CRW-002"], copy.crewLeadId],
      ["07:30", "09:00", "Kasarani", ["DOF-P-CRW-002", "DOF-P-CRW-003"], "Camera 1", "DOF-P-CRW-002"],
    );
    assert.equal(copy.runOfShow[0].title, "Opening");
    assert.notEqual(copy.runOfShow[0].id, "RS-aaaaaaaa");
    assert.equal(copy.rehearsal.done, false);
    assert.deepEqual([copy.confirmations, copy.changeLog, copy.sharedAt], [{}, [], null], "the copy starts unconfirmed and unshared");
    assert.equal(gear.copied, 1);
    assert.equal(gear.skipped.length, 1, "the body booked elsewhere that day is skipped, not booked twice");
    assert.deepEqual(
      E.manifestForSheet(copy.id)!.lines.map((l) => l.equipmentId),
      ["DOF-EQ-CAM-001"],
    );
    assert.equal(get(cs.id).confirmations["DOF-P-CRW-002"]?.by, "DOF-P-CRW-002", "the original keeps its confirmation");
    ok();
  },
);

await t("duplicating a session copies its plan, run sheet and call sheet to the new date, without its episodes", () => {
  const s2 = getDb().recordingSessions.find((s) => s.contentId === "DOF-SER-001-S1" && s.sessionNumber === 2)!;
  const sheet = W.createSessionCallSheet(hop(), s2.id);
  CS.updateCallSheet(hop(), sheet.id, {
    locationNotes: "Side gate",
    logistics: { transport: "Van at 6", parking: "", meals: "Lunch at 1", accommodation: "", other: "" },
    crewRoles: { "DOF-P-CRW-002": "Camera 1" },
  });
  const item = W.addRunSheetItem(hop(), s2.id, { time: "08:00", title: "Setup", durationMin: 60, notes: "Two cameras" });
  W.addLogRow(hop(), s2.id, { plannedEpisodeId: W.availableForLog(s2.id)[0] });
  E.addGearToSheet(hop(), { id: sheet.id, contentId: sheet.contentId, date: sheet.date }, [{ equipmentId: "DOF-EQ-AUD-001", quantity: 1 }]);
  const date = "2026-12-17";
  const r = W.duplicateSession(hop(), s2.id, date);
  assert.notEqual(r.session.id, s2.id);
  assert.deepEqual([r.session.scheduledDate, r.session.venue, r.session.status], [date, s2.venue, "Planned"]);
  const copied = r.session.runSheet.find((x) => x.title === "Setup")!;
  assert.equal(copied.notes, "Two cameras", "the run sheet as the producer left it");
  assert.equal(r.session.runSheet.length, getDb().recordingSessions.find((s) => s.id === s2.id)!.runSheet.length);
  assert.notEqual(copied.id, item.id);
  assert.equal(W.rowsOf(r.session.id).length, 0, "its episodes stay on the original session");
  const copy = r.sheet!;
  assert.equal(r.session.callSheetId, copy.id);
  assert.deepEqual(
    [copy.date, copy.locationNotes, copy.logistics.meals, copy.crewRoles["DOF-P-CRW-002"]],
    [date, "Side gate", "Lunch at 1", "Camera 1"],
  );
  assert.match(copy.notes, new RegExp(r.session.id), "its notes name the new session, not the old one");
  assert.equal(r.gear.copied, 1);
  throwsRule(() => W.duplicateSession(vol(), s2.id, date));
  throwsRule(() => W.duplicateSession(hop(), s2.id, "next week"), /date/);
  ok();
});

// ── Warnings ─────────────────────────────────────────────────

await t("a sheet warns, never blocks, when it has no call time, location or crew lead, or crew have not confirmed near the day", () => {
  const show = P.createProduction(hop(), { title: "Prayer night", mode: "one_time", date: "2026-10-30" });
  const cs = sheetOfDay(daysOfShow(show.contentId)[0])!;
  CS.updateCallSheet(hop(), cs.id, { callTime: "", location: "" });
  const texts = (c: CallSheet, today = "2026-09-26") => sheetWarnings(get(c.id), today).map((w) => `${w.section}: ${w.text}`);
  assert.deepEqual(texts(cs), ["schedule: No crew call time.", "location: No location.", "crew: No crew on the sheet."]);
  CS.updateCallSheet(hop(), cs.id, { callTime: "18:00", location: "Chapel", crewPersonIds: ["DOF-P-CRW-002", "DOF-P-CRW-003"] });
  assert.deepEqual(texts(cs), ["crew: No crew lead."], "two weeks out, nobody is chased to confirm yet");
  CS.updateCallSheet(hop(), cs.id, { crewLeadId: "DOF-P-CRW-002" });
  assert.deepEqual(texts(cs), []);
  assert.deepEqual(texts(cs, "2026-10-28"), ["crew: 2 days to go and 2 not confirmed: Brian Otieno, Faith Mwangi."]);
  CS.confirmOnSheet(crew(2), cs.id, "DOF-P-CRW-002", true);
  assert.deepEqual(texts(cs, "2026-10-30"), ["crew: It is today and 1 not confirmed: Faith Mwangi."]);
  assert.deepEqual(texts(cs, "2026-10-31"), [], "a sheet whose day has passed has nothing to warn about");
  // Soft: a sheet with warnings can still be made final.
  CS.updateCallSheet(hop(), cs.id, { location: "" });
  CS.finalizeCallSheet(hop(), cs.id);
  assert.equal(get(cs.id).status, "final");
  ok();
});

// ── Confirmations ────────────────────────────────────────────

await t("crew confirm for themselves, anyone on the project records it for others and talent; it is not a change of plan", () => {
  const show = P.createProduction(hop(), { title: "Vespers", mode: "recurring", rule: weeklyFrom("2026-10-02"), callTime: "16:00" });
  const day = daysOfShow(show.contentId)[0];
  const cs = sheetOfDay(day)!;
  // Follows its template until changed by hand; a confirmation does not count as a change.
  P.updateShowTemplate(hop(), getDb().showTemplates.find((x) => x.contentId === show.contentId)!.id, {
    sheet: { crewPersonIds: ["DOF-P-CRW-002", "DOF-P-VOL-001"], crewRoles: { "DOF-P-VOL-001": "Floor" } },
  });
  const version = get(cs.id).version;
  CS.confirmOnSheet(vol(), cs.id, "DOF-P-VOL-001", true);
  throwsRule(() => CS.confirmOnSheet(vol(), cs.id, "DOF-P-CRW-002", true), /Only the person themself/);
  CS.confirmOnSheet(crew(2), cs.id, "DOF-P-VOL-001", false); // crew on the project can record it for a colleague
  CS.confirmOnSheet(crew(2), cs.id, "DOF-P-VOL-001", true);
  CS.confirmOnSheet(hop(), cs.id, "DOF-P-CRW-002", true);
  // Crew who can see the show but do not work on it confirm only for themselves, and only if they are on the sheet.
  throwsRule(() => CS.confirmOnSheet(crew(3), cs.id, "DOF-P-CRW-002", true), /Only the person themself/);
  throwsRule(() => CS.confirmOnSheet(crew(3), cs.id, "DOF-P-CRW-003", true), /not on the crew/);
  throwsRule(() => CS.confirmOnSheet(hop(), cs.id, "DOF-P-CRW-001", true), /not on the crew/);
  throwsRule(() => CS.confirmOnSheet(hop(), cs.id, "talent:TL-nothere1", true), /talent list/);
  const c = get(cs.id).confirmations;
  assert.deepEqual(
    [c["DOF-P-VOL-001"].by, c["DOF-P-VOL-001"].callTime, c["DOF-P-VOL-001"].role, c["DOF-P-CRW-002"].by],
    ["DOF-P-CRW-002", "16:00", "Floor", "DOF-P-HOP-001"],
  );
  assert.equal(get(cs.id).version, version, "the sheet's version is unchanged, so no one's edit is refused because of it");
  assert.equal(getDb().records.find((r) => r.contentId === day.contentId)!.instance!.locked, false, "the day still follows its template");
  // A final sheet takes confirmations too.
  CS.finalizeCallSheet(hop(), cs.id);
  CS.confirmOnSheet(vol(), cs.id, "DOF-P-VOL-001", false);
  assert.equal(get(cs.id).confirmations["DOF-P-VOL-001"], undefined);
  assert.deepEqual(unconfirmedCrew(get(cs.id)), ["DOF-P-VOL-001"]);
  ok();
});

await t("a change to the call time, the location or someone's role clears the confirmations it affects, and only those", () => {
  const cs = eventSheet();
  CS.confirmOnSheet(crew(2), cs.id, "DOF-P-CRW-002", true);
  CS.confirmOnSheet(crew(3), cs.id, "DOF-P-CRW-003", true);
  CS.confirmOnSheet(hop(), cs.id, "talent:TL-aaaaaaaa", true);
  const keys = () => Object.keys(get(cs.id).confirmations).sort();
  // Things nobody confirmed to: notes, logistics, the run of show. Nothing is cleared.
  CS.updateCallSheet(hop(), cs.id, { notes: "Bring water", logistics: { ...cs.logistics, meals: "Lunch" } });
  CS.addRunItem(hop(), cs.id, { time: "10:00", title: "Worship", durationMin: 30 });
  assert.deepEqual(keys(), ["DOF-P-CRW-002", "DOF-P-CRW-003", "talent:TL-aaaaaaaa"]);
  // One person's role: only theirs.
  CS.updateCallSheet(hop(), cs.id, { crewRoles: { ...get(cs.id).crewRoles, "DOF-P-CRW-003": "Audio and lights" } });
  assert.deepEqual(keys(), ["DOF-P-CRW-002", "talent:TL-aaaaaaaa"]);
  // The talent call: talent only, crew are called at the crew call.
  CS.updateCallSheet(hop(), cs.id, { talentCall: "09:30" });
  assert.deepEqual(keys(), ["DOF-P-CRW-002"]);
  CS.confirmOnSheet(hop(), cs.id, "talent:TL-aaaaaaaa", true);
  CS.confirmOnSheet(crew(3), cs.id, "DOF-P-CRW-003", true);
  // The crew call: every crew member; talent with a call of their own keep theirs.
  CS.updateCallSheet(hop(), cs.id, { callTime: "07:00" });
  assert.deepEqual(keys(), ["talent:TL-aaaaaaaa"]);
  CS.confirmOnSheet(crew(2), cs.id, "DOF-P-CRW-002", true);
  // The place: everyone.
  CS.updateCallSheet(hop(), cs.id, { locationAddress: "Thika Road" });
  assert.deepEqual(keys(), []);
  // Someone taken off the crew takes their confirmation with them.
  CS.confirmOnSheet(crew(3), cs.id, "DOF-P-CRW-003", true);
  CS.updateCallSheet(hop(), cs.id, { crewPersonIds: ["DOF-P-CRW-002"] });
  assert.deepEqual(keys(), []);
  const cleared = get(cs.id).changeLog.filter((c) => c.what === "Confirmation cleared");
  assert.deepEqual(
    cleared.map((c) => `${c.from}: ${c.to}`),
    [
      "Faith Mwangi had confirmed: role changed",
      "Pastor Mwangi had confirmed: call time changed",
      "Brian Otieno had confirmed: call time changed",
      "Faith Mwangi had confirmed: call time changed",
      "Brian Otieno had confirmed: location changed",
      "Pastor Mwangi had confirmed: location changed",
      "Faith Mwangi had confirmed: taken off the crew",
    ],
  );
  assert.ok(
    cleared.every((c) => c.by === "DOF-P-HOP-001"),
    "the person who made the change is named",
  );
  ok();
});

await t("a template change that reaches a day clears the confirmations it makes stale, and logs it", () => {
  const show = P.createProduction(hop(), { title: "Vespers", mode: "recurring", rule: weeklyFrom("2026-10-02"), callTime: "16:00" });
  const tpl = getDb().showTemplates.find((x) => x.contentId === show.contentId)!;
  P.updateShowTemplate(hop(), tpl.id, { sheet: { crewPersonIds: ["DOF-P-CRW-002"], location: "Studio A" } });
  const cs = sheetOfDay(daysOfShow(show.contentId)[0])!;
  CS.confirmOnSheet(crew(2), cs.id, "DOF-P-CRW-002", true);
  P.updateShowTemplate(hop(), tpl.id, { sheet: { callTime: "15:30" } });
  assert.equal(get(cs.id).callTime, "15:30");
  assert.equal(get(cs.id).confirmations["DOF-P-CRW-002"], undefined);
  assert.deepEqual(
    changesOf(get(cs.id)).map((c) => [c.what, c.from, c.to]),
    [
      ["Confirmation cleared", "Brian Otieno had confirmed", "call time changed"],
      ["Crew call", "16:00", "15:30"],
    ],
    "confirmed, so the change is logged even before the sheet is shared",
  );
  ok();
});

// ── The change log ───────────────────────────────────────────

await t("once a sheet is shared, changes to its call time, location, crew, talent and schedule are logged with who and when", () => {
  const cs = eventSheet();
  CS.updateCallSheet(hop(), cs.id, { callTime: "07:00" });
  assert.deepEqual(get(cs.id).changeLog, [], "a draft nobody has seen or confirmed logs nothing");
  CS.finalizeCallSheet(hop(), cs.id);
  const shared = get(cs.id).sharedAt;
  assert.ok(shared, "made final: shared with the team");
  CS.reopenCallSheet(hop(), cs.id);
  CS.updateCallSheet(crew(2), cs.id, { callTime: "06:30", location: "Nyayo Stadium" });
  CS.updateCallSheet(crew(2), cs.id, {
    crewPersonIds: ["DOF-P-CRW-002", "DOF-P-CRW-001"],
    crewRoles: { "DOF-P-CRW-002": "Camera 2", "DOF-P-CRW-001": "Director" },
  });
  CS.updateCallSheet(hop(), cs.id, {
    talent: [
      { id: "TL-aaaaaaaa", name: "Pastor Mwangi", role: "Speaker", contact: "", callTime: "08:00", notes: "" },
      { id: "TL-bbbbbbbb", name: "Choir", role: "Music", contact: "", callTime: "", notes: "" },
    ],
  });
  CS.updateCallSheet(hop(), cs.id, { date: "2026-10-21", wrapTime: "13:00", notes: "Not logged", format: "Not logged either" });
  const seg = CS.addRunItem(hop(), cs.id, { time: "09:00", title: "Opening", durationMin: 10 });
  CS.updateRunItem(hop(), cs.id, seg.id, { durationMin: 15 });
  CS.removeRunItem(hop(), cs.id, seg.id);
  const log = get(cs.id).changeLog;
  assert.deepEqual(
    log.map((c) => [c.what, c.from, c.to]),
    [
      ["Crew call", "07:00", "06:30"],
      ["Location", "Kasarani", "Nyayo Stadium"],
      ["Crew added", "", "Wanjiru Kamau (Director)"],
      ["Crew removed", "Faith Mwangi", ""],
      ["Role of Brian Otieno", "Camera 1", "Camera 2"],
      ["Talent changed", "Pastor Mwangi (Speaker)", "Pastor Mwangi (Speaker), call 08:00"],
      ["Talent added", "", "Choir (Music)"],
      ["Date", "Oct 20, 2026", "Oct 21, 2026"],
      ["Wrap", "not set", "13:00"],
      ["Run of show added", "", "09:00 Opening (10 min)"],
      ["Run of show changed", "09:00 Opening (10 min)", "09:00 Opening (15 min)"],
      ["Run of show removed", "09:00 Opening (15 min)", ""],
    ],
  );
  assert.deepEqual([...new Set(log.slice(0, 5).map((c) => c.by))], ["DOF-P-CRW-002"]);
  assert.ok(log.every((c) => c.at >= shared!));
  assert.equal(new Set(log.map((c) => c.id)).size, log.length);
  assert.equal(changesOf(get(cs.id))[0].what, "Run of show removed", "shown newest first");
  // Sharing again keeps the first time it was shared.
  CS.finalizeCallSheet(hop(), cs.id);
  assert.equal(get(cs.id).sharedAt, shared);
  ok();
});

// ── Saved locations ──────────────────────────────────────────

await t("saved locations are kept by the Head of Production and crew, picked on any sheet, and archived rather than deleted", () => {
  const hall = L.createLocation(crew(2), { name: "Church hall", address: "Ngong Road", notes: "Gate B" });
  assert.match(hall.id, /^DOF-LOC-\d{3}$/);
  throwsRule(() => L.createLocation(vol(), { name: "My house" }), /Head of Production and crew/);
  throwsRule(() => L.createLocation(hop(), { name: "church HALL " }), /already a saved location/);
  throwsRule(() => L.createLocation(hop(), { name: "  " }), /name/);
  L.updateLocation(hop(), hall.id, { notes: "Gate B, ask for the key" });
  const cs = eventSheet();
  CS.updateCallSheet(hop(), cs.id, { locationId: hall.id, location: hall.name, locationAddress: hall.address });
  assert.equal(get(cs.id).locationId, hall.id);
  // Changing a saved location later leaves sheets that used it as they are.
  L.updateLocation(hop(), hall.id, { address: "Ngong Road, gate B" });
  assert.equal(get(cs.id).locationAddress, "Ngong Road");
  // A place changed by hand no longer points at the saved location.
  CS.updateCallSheet(hop(), cs.id, { locationAddress: "Thika Road" });
  assert.equal(get(cs.id).locationId, null);
  L.archiveLocation(hop(), hall.id, true);
  assert.ok(!L.listLocations().some((l) => l.id === hall.id), "archived: off the pickers");
  assert.ok(
    L.listLocations(true).some((l) => l.id === hall.id),
    "but kept",
  );
  throwsRule(() => CS.updateCallSheet(hop(), cs.id, { locationId: hall.id }), /no longer on the list/);
  throwsRule(() => CS.updateCallSheet(hop(), cs.id, { locationId: "DOF-LOC-999" }), /no longer on the list/);
  L.archiveLocation(hop(), hall.id, false);
  CS.updateCallSheet(hop(), cs.id, { locationId: hall.id, location: hall.name, locationAddress: "Ngong Road, gate B" });
  assert.equal(L.sheetsUsing(hall.id, "2026-09-26"), 1);
  ok();
});

// ── Gear suggestions ─────────────────────────────────────────

await t("gear is suggested from the crew's roles, one per person, skipping gear already on the sheet or booked that day", () => {
  const cs = eventSheet();
  CS.updateCallSheet(hop(), cs.id, {
    crewPersonIds: ["DOF-P-CRW-002", "DOF-P-CRW-003", "DOF-P-CRW-001"],
    crewRoles: { "DOF-P-CRW-002": "Camera 1", "DOF-P-CRW-003": "Audio", "DOF-P-CRW-001": "Camera 2" },
  });
  const byCategory = () => new Map(gearSuggestions(get(cs.id), 20).map((s) => [s.category, s]));
  let s = byCategory();
  assert.deepEqual([...s.keys()].sort(), ["audio", "camera"]);
  assert.deepEqual([s.get("camera")!.needed, s.get("camera")!.have], [2, 0]);
  assert.deepEqual(
    s
      .get("camera")!
      .options.slice(0, 2)
      .map((o) => o.item.id),
    ["DOF-EQ-CAM-001", "DOF-EQ-CAM-002"],
    "camera bodies are offered before lenses and tripods",
  );
  // Booked elsewhere that day: left out.
  const other = CS.createCallSheet(hop(), { contentId: "DOF-SER-001", date: cs.date });
  E.addGearToSheet(hop(), { id: other.id, contentId: other.contentId, date: other.date }, [{ equipmentId: "DOF-EQ-CAM-002", quantity: 1 }]);
  s = byCategory();
  assert.ok(!s.get("camera")!.options.some((o) => o.item.id === "DOF-EQ-CAM-002"), "booked on another sheet that day");
  // Nothing is booked until someone adds it; once added, it counts and is not offered again.
  assert.equal(E.manifestForSheet(cs.id), undefined);
  E.addGearToSheet(hop(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }]);
  s = byCategory();
  assert.deepEqual([s.get("camera")!.needed, s.get("camera")!.have], [2, 1]);
  assert.ok(!s.get("camera")!.options.some((o) => o.item.id === "DOF-EQ-CAM-001"));
  E.addGearToSheet(hop(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-CAM-004", quantity: 1 }]);
  assert.equal(byCategory().get("camera")!.have, 1, "a tripod is not a camera");
  // The other body is free again once the other sheet lets it go.
  E.removeGearFromSheet(hop(), other.id, "DOF-EQ-CAM-002");
  E.addGearToSheet(hop(), { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-CAM-002", quantity: 1 }]);
  assert.ok(!byCategory().has("camera"), "two cameras for two camera operators: nothing more to suggest");
  // A role with no gear of its own suggests nothing.
  CS.updateCallSheet(hop(), cs.id, { crewRoles: { "DOF-P-CRW-002": "Producer", "DOF-P-CRW-003": "Runner", "DOF-P-CRW-001": "Host" } });
  assert.deepEqual(gearSuggestions(get(cs.id)), []);
  assert.equal(camera("DOF-EQ-CAM-001").baseStatus, "active");
  ok();
});

// ── Data version 20 ──────────────────────────────────────────

await t("upgrading to version 20 gives every sheet its saved location, confirmations and change log, empty, once", () => {
  const db = buildSeed();
  for (const c of db.callSheets as unknown as Record<string, unknown>[]) {
    delete c.locationId;
    delete c.sharedAt;
    delete c.confirmations;
    delete c.changeLog;
  }
  db.callSheets[1].status = "final";
  delete (db as { locations?: unknown }).locations;
  db.schemaVersion = 19;
  const before = JSON.stringify(db.callSheets.map((c) => [c.id, c.title, c.location, c.callTime, c.crewPersonIds, c.status]));
  const up = upgradeToV20(structuredClone(db));
  assert.equal(up.schemaVersion, 20);
  assert.deepEqual(up.locations, []);
  for (const c of up.callSheets) {
    assert.deepEqual([c.locationId, c.confirmations, c.changeLog], [null, {}, []]);
    assert.equal(!!c.sharedAt, c.status === "final", "a final sheet was already issued: its changes are logged from now on");
  }
  assert.equal(JSON.stringify(up.callSheets.map((c) => [c.id, c.title, c.location, c.callTime, c.crewPersonIds, c.status])), before);
  assert.equal(JSON.stringify(upgradeToV20(structuredClone(up))), JSON.stringify(up), "running it again changes nothing");
  assert.deepEqual(integrityProblems(up), []);
});

await t("a confirmation holds only while its call time, place and role are what was confirmed", () => {
  const cs = eventSheet();
  CS.confirmOnSheet(crew(2), cs.id, "DOF-P-CRW-002", true);
  const now = get(cs.id);
  assert.ok(confirmationHolds(now, "DOF-P-CRW-002"));
  assert.ok(!confirmationHolds({ ...now, callTime: "05:00" }, "DOF-P-CRW-002"));
  assert.ok(!confirmationHolds({ ...now, location: "Elsewhere" }, "DOF-P-CRW-002"));
  assert.ok(!confirmationHolds({ ...now, crewRoles: { ...now.crewRoles, "DOF-P-CRW-002": "Lights" } }, "DOF-P-CRW-002"));
  assert.ok(!confirmationHolds(now, "DOF-P-CRW-003"), "nobody confirmed for Faith");
});

console.log(`\n${passed} passed`);
