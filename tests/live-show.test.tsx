// Build prompt v4, section 9: Live Shows completed. The Show Plan, Broadcast Plan, Tech Check, Rehearsal Log, Live Day,
// Live Control and Production Report; the live gate (a show date and a producer; the Greenlight is a document); the
// Rundown copied to the days; the Tech Check's states, copied from the previous show, with issues as warnings; Live
// Control on the night; gear not returned after a show; and what data version 24 adds for existing live shows.
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor, CallSheet, Database, Manifest } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { toV24 } from "../src/data/migrateV24";
import { catalogFor } from "../src/config/documentCatalog";
import { LIVE_TECH_CHECK, REHEARSAL_STEPS } from "../src/config/callSheet";
import { login } from "../src/services/auth";
import * as C from "../src/services/wrapped/checks";
import * as CS from "../src/services/wrapped/callsheets";
import * as D from "../src/services/wrapped/documents";
import * as L from "../src/services/wrapped/live";
import * as P from "../src/services/wrapped/production";
import * as W from "../src/services/wrapped/workflow";
import { daysOfEvent, sheetOfDay } from "../src/services/production";
import { sheetWarnings } from "../src/services/sheetAdvice";
import { urgencyReport } from "../src/services/urgency";
import { addDaysIso, todayIso } from "../src/services/utils";
import { AppProvider } from "../src/ui/AppContext";
import { CallSheetBody } from "../src/pages/CallSheets";
import { SessionPage } from "../src/pages/workflow/SessionPage";
import { LiveControl, RundownSection, TechCheckPane } from "../src/pages/production/LiveTools";
import type { Project } from "../src/services/workflow";

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
const record = (id: string) => getDb().records.find((r) => r.contentId === id)!;
const PRODUCER = "DOF-P-CRW-004";
const camp = () => {
  const start = addDaysIso(todayIso(), 10);
  return P.createProduction(hop(), { title: "Youth Camp", mode: "multi_day", startDate: start, endDate: addDaysIso(start, 2) });
};
const sheetOf = (dayId: string): CallSheet => sheetOfDay(getDb().recordingSessions.find((s) => s.id === dayId)!)!;
const sheet = (id: string): CallSheet => getDb().callSheets.find((c) => c.id === id)!;

await t("a live show's documents: Show Plan, Broadcast Plan, Tech Check, Rehearsal Log, Live Day, Live Control, Production Report", () => {
  const titles = (stage: Parameters<typeof catalogFor>[1]) => catalogFor("live_event", stage).map((e) => e.title);
  assert.deepEqual(titles("Development"), ["Show Plan", "Theological Review", "Greenlight", "Show Days"]);
  assert.ok(
    ["Broadcast Plan", "Tech Check", "Rehearsal Log", "Storyboard", "Shot List", "Gear"].every((x) => titles("Pre-production").includes(x)),
  );
  assert.deepEqual(titles("Production"), ["Live Day", "Show Log", "Live Control"]);
  assert.ok(titles("Marketing and distribution").includes("Production Report"));
  const plan = catalogFor("live_event", "Development").find((e) => e.key === "event_brief")!;
  assert.deepEqual(
    plan.pages!.map((p) => p.title),
    ["Objective", "Venue", "Audience and streaming", "Production type and duration", "Creative notes", "Logistics"],
  );
  assert.ok(
    catalogFor("live_event", "Marketing and distribution")
      .find((e) => e.key === "show_report")!
      .pages!.some((p) => p.title === "Lessons learned"),
  );
});

await t("the live gate is a show date and a producer; the Greenlight can be recorded at any time, and is not needed to move on", () => {
  const event = camp();
  const gates = () => D.hardGates(event.contentId);
  assert.deepEqual(
    gates().map((g) => [g.key, g.met, g.overridable]),
    [
      ["date", true, false],
      ["producer", false, false],
    ],
  );
  assert.match(gates()[0].detail, /First show .*3 days/);
  throwsRule(() => W.advanceProject(hop(), event.contentId), /producer/i);
  W.assignProducer(hop(), event.contentId, PRODUCER);
  assert.ok(gates().every((g) => g.met));
  W.advanceProject(hop(), event.contentId);
  assert.equal(record(event.contentId).workflow!.stage, "Pre-production");
  // A show with no day yet has no show date.
  const one = P.createProduction(hop(), { title: "Rally", mode: "one_time", date: addDaysIso(todayIso(), 5) });
  for (const d of daysOfEvent(one.contentId)) d.archivedAt = new Date().toISOString();
  commit();
  assert.equal(D.hardGates(one.contentId)[0].met, false);
  // The Checks panel goes to Show Days and the Greenlight document to fix them.
  const checks = C.projectChecks(one.contentId);
  assert.deepEqual(checks.required.find((i) => i.gate?.key === "date")!.go, { doc: { stage: "Development", key: "show_days" } });
  W.decideGreenlight(hop(), one.contentId, { outcome: "Greenlight", notes: "" });
  ok();
});

await t("a new show's days start with the live Tech Check, each line Not checked, and the Rehearsal Log's steps", () => {
  const event = camp();
  const cs = sheetOf(daysOfEvent(event.contentId)[0].id);
  assert.deepEqual(
    cs.technicalCheck.map((c) => c.label),
    LIVE_TECH_CHECK,
  );
  assert.ok(cs.technicalCheck.every((c) => c.state === "Not checked" && !c.done));
  assert.deepEqual(
    cs.rehearsal.steps!.map((s) => s.step),
    REHEARSAL_STEPS,
  );
});

await t("a Tech Check line's state and its tick never disagree; its person, gear and result are checked", () => {
  const event = camp();
  const cs = sheetOf(daysOfEvent(event.contentId)[0].id);
  const camera = getDb().equipment.find((e) => e.baseStatus === "active")!;
  const set = (patch: Record<string, unknown>, i = 0) =>
    CS.updateCallSheet(hop(), cs.id, { technicalCheck: sheet(cs.id).technicalCheck.map((x, n) => (n === i ? { ...x, ...patch } : x)) });
  set({ state: "OK", assigneeId: "DOF-P-CRW-001", equipmentId: camera.id, result: "Sharp" });
  assert.equal(sheet(cs.id).technicalCheck[0].done, true, "OK is ticked");
  set({ state: "Issue", result: "Cam 2 flickers" }, 1);
  assert.equal(sheet(cs.id).technicalCheck[1].done, false);
  // A screen that only ticks sets the state.
  set({ done: false });
  assert.equal(sheet(cs.id).technicalCheck[0].state, "Not checked");
  set({ done: true });
  assert.equal(sheet(cs.id).technicalCheck[0].state, "OK");
  throwsRule(() => set({ state: "Maybe" }), /Not checked, OK or Issue/);
  throwsRule(() => set({ equipmentId: "DOF-EQ-NOPE" }), /no longer in the inventory/);
  throwsRule(() => set({ assigneeId: "DOF-P-NOPE-999" }), /active person/);
  // Issues are warnings on the sheet and before the show, never a block.
  assert.ok(sheetWarnings(sheet(cs.id), todayIso()).some((w) => w.section === "technicalCheck" && /Lenses/.test(w.text)));
  const day = daysOfEvent(event.contentId)[0];
  const gate = W.evaluateGate("Pre-production", "session", day.id);
  assert.ok(gate.warnings.some((w) => /^Tech Check: Lenses has an issue \(Cam 2 flickers\)/.test(w)));
  assert.ok(!gate.missing.some((m) => /Tech Check/.test(m)));
  assert.deepEqual(C.sessionChecks(day.id).suggestions.find((i) => /^Tech Check/.test(i.label))!.go, {
    doc: { stage: "Pre-production", key: "tech_check" },
  });
  ok();
});

await t("the Rehearsal Log's steps: when each was checked, by whom, and notes, kept on the day; never a gate", () => {
  const event = camp();
  const day = daysOfEvent(event.contentId)[0];
  const cs = sheetOf(day.id);
  const steps = cs.rehearsal.steps!.map((s, i) =>
    i === 1 ? { ...s, time: "16:30", personId: "DOF-P-CRW-001", notes: "All mics fine", done: true } : s,
  );
  CS.updateCallSheet(hop(), cs.id, { rehearsal: { ...cs.rehearsal, steps } });
  assert.equal(sheet(cs.id).rehearsal.steps![1].notes, "All mics fine");
  throwsRule(
    () => CS.updateCallSheet(hop(), cs.id, { rehearsal: { ...cs.rehearsal, steps: [{ ...steps[0], step: " " }] } }),
    /rehearsal step a name/,
  );
  assert.ok(!W.evaluateGate("Pre-production", "session", day.id).missing.some((m) => /Rehearsal Log|rehearsal step/i.test(m)));
});

await t("a recurring show's template change keeps what was checked on the day: states, results and rehearsal steps", () => {
  const show = P.createProduction(hop(), {
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
  const day = daysOfEvent(show.contentId)[0];
  const cs = sheetOf(day.id);
  CS.updateCallSheet(hop(), cs.id, {
    technicalCheck: cs.technicalCheck.map((x, i) => (i === 0 ? { ...x, state: "Issue" as const, result: "Hum on channel 3" } : x)),
    rehearsal: { ...cs.rehearsal, steps: cs.rehearsal.steps!.map((s, i) => (i === 0 ? { ...s, time: "15:00", done: true } : s)) },
  });
  assert.equal(getDb().recordingSessions.find((s) => s.id === day.id)!.instance!.locked, false, "work on the day is not a change of plan");
  const t0 = getDb().showTemplates.find((x) => x.contentId === show.contentId)!;
  P.updateShowTemplate(hop(), t0.id, { sheet: { location: "Studio B" } });
  const after = sheetOf(day.id);
  assert.equal(after.location, "Studio B");
  assert.equal(after.technicalCheck[0].state, "Issue");
  assert.equal(after.technicalCheck[0].result, "Hum on channel 3");
  assert.equal(after.rehearsal.steps![0].time, "15:00");
  // A recurring show's Rundown is its template's run of show: a change reaches the days following it.
  L.setRundown(hop(), show.contentId, [
    { id: "RS-a1", time: "17:00", title: "Worship", durationMin: 25, ownerPersonId: null, notes: "", camera: "Wide" },
  ]);
  assert.equal(L.rundownOf(show.contentId)[0].title, "Worship");
  assert.equal(sheetOf(day.id).runOfShow[0].title, "Worship");
  throwsRule(
    () =>
      L.copyRundownToDays(hop(), show.contentId, false) &&
      L.setRundown(hop(), show.contentId, [{ id: "x", time: "nine", title: "A", durationMin: 1, ownerPersonId: null, notes: "" }]),
    /hours and minutes/,
  );
  ok();
});

await t(
  "the Broadcast Plan's Rundown is copied to the days: to those with none, or to every coming one; a published or started day keeps its own",
  () => {
    const event = camp();
    const [d1, d2, d3] = daysOfEvent(event.contentId);
    throwsRule(() => L.copyRundownToDays(hop(), event.contentId), /no segments/);
    L.setRundown(hop(), event.contentId, [
      {
        id: "RS-a1",
        time: "18:00",
        title: "Worship",
        durationMin: 20,
        ownerPersonId: null,
        notes: "",
        camera: "Cam 1",
        audio: "Choir",
        graphics: "Title",
      },
      { id: "RS-a2", time: "18:20", title: "Message", durationMin: 30, ownerPersonId: null, notes: "" },
    ]);
    CS.updateCallSheet(hop(), sheetOf(d2.id).id, {
      runOfShow: [{ id: "RS-own", time: "09:00", title: "Morning prayer", durationMin: 15, ownerPersonId: null, notes: "" }],
    });
    sheetOf(d3.id).status = "final";
    commit();
    const first = L.copyRundownToDays(hop(), event.contentId, false);
    assert.deepEqual(first.copied, [d1.id]);
    assert.deepEqual(
      sheetOf(d1.id).runOfShow.map((r) => [r.title, r.camera ?? "", r.status]),
      [
        ["Worship", "Cam 1", "Planned"],
        ["Message", "", "Planned"],
      ],
    );
    assert.notEqual(sheetOf(d1.id).runOfShow[0].id, "RS-a1", "each day's rows are its own");
    assert.equal(sheetOf(d2.id).runOfShow[0].title, "Morning prayer");
    const again = L.copyRundownToDays(hop(), event.contentId, true);
    assert.ok(again.copied.includes(d2.id) && again.kept.includes(d3.id));
    assert.equal(sheetOf(d2.id).runOfShow[0].title, "Worship");
    // Only those who plan the show change its Rundown.
    throwsRule(() => L.setRundown(login("crew1@dof.demo", "demo"), event.contentId, []));
    ok();
  },
);

await t("a day's Tech Check is copied from the previous show: the same lines, people and gear, each Not checked again", () => {
  const event = camp();
  const [d1, d2] = daysOfEvent(event.contentId);
  const s1 = sheetOf(d1.id);
  CS.updateCallSheet(hop(), s1.id, {
    technicalCheck: [
      {
        id: "TC-1",
        label: "Cameras",
        done: true,
        note: "Fine",
        state: "OK",
        assigneeId: "DOF-P-CRW-001",
        equipmentId: null,
        result: "Sharp",
      },
      { id: "TC-2", label: "Stream key", done: false, note: "", state: "Issue", assigneeId: null, equipmentId: null, result: "Expired" },
    ],
  });
  assert.equal(L.previousTechSheet(sheetOf(d2.id).id)!.id, s1.id);
  const r = L.copyTechCheckFromPrevious(hop(), sheetOf(d2.id).id);
  assert.deepEqual(r, { from: s1.id, lines: 2 });
  assert.deepEqual(
    sheetOf(d2.id).technicalCheck.map((c) => [c.label, c.state, c.assigneeId, c.result, c.note]),
    [
      ["Cameras", "Not checked", "DOF-P-CRW-001", "", ""],
      ["Stream key", "Not checked", null, "", ""],
    ],
  );
  throwsRule(() => L.copyTechCheckFromPrevious(hop(), "DOF-CS-NOPE"), /not found/);
  ok();
});

await t("Live Control: the rundown moved on by hand with actual times, and status lights set by hand", () => {
  const event = camp();
  const day = daysOfEvent(event.contentId)[0];
  const cs = sheetOf(day.id);
  CS.updateCallSheet(hop(), cs.id, {
    runOfShow: [
      { id: "RS-1", time: "18:00", title: "Worship", durationMin: 20, ownerPersonId: null, notes: "" },
      { id: "RS-2", time: "18:20", title: "Notices", durationMin: 5, ownerPersonId: null, notes: "", status: "Cut" },
      { id: "RS-3", time: "18:25", title: "Message", durationMin: 30, ownerPersonId: null, notes: "" },
      { id: "RS-4", time: "18:55", title: "Prayer", durationMin: 10, ownerPersonId: null, notes: "" },
    ],
  });
  let now = L.liveNow(sheet(cs.id));
  assert.equal(now.current, null);
  assert.equal(now.next!.title, "Worship");
  assert.equal(now.total, 3, "a cut segment is left out");
  assert.equal(L.advanceRundown(hop(), cs.id, "next")!.title, "Worship");
  now = L.liveNow(sheet(cs.id));
  assert.equal(now.current!.title, "Worship");
  assert.match(now.current!.actualStart!, /^\d\d:\d\d$/);
  assert.deepEqual([now.next!.title, now.upNext!.title], ["Message", "Prayer"]);
  L.advanceRundown(hop(), cs.id, "next");
  now = L.liveNow(sheet(cs.id));
  assert.equal(now.current!.title, "Message");
  assert.equal(sheet(cs.id).runOfShow.find((r) => r.id === "RS-1")!.status, "Done");
  assert.match(sheet(cs.id).runOfShow.find((r) => r.id === "RS-1")!.actualEnd!, /^\d\d:\d\d$/);
  L.advanceRundown(hop(), cs.id, "back");
  assert.equal(L.liveNow(sheet(cs.id)).current!.title, "Worship");
  assert.equal(sheet(cs.id).runOfShow.find((r) => r.id === "RS-3")!.status, "Planned");
  for (let i = 0; i < 3; i++) L.advanceRundown(hop(), cs.id, "next");
  assert.equal(L.liveNow(sheet(cs.id)).done, 3);
  throwsRule(() => L.advanceRundown(hop(), cs.id, "next"), /Every segment is done/);
  assert.ok(!getDb().recordingSessions.find((s) => s.id === day.id)!.instance?.locked, "work on the night locks nothing");
  // Lights.
  L.setLiveLight(hop(), day.id, "stream", "down");
  L.setLiveLight(hop(), day.id, "audio", "ok");
  const lit = getDb().recordingSessions.find((s) => s.id === day.id)!;
  assert.deepEqual(lit.liveLights, { stream: "down", audio: "ok" });
  assert.equal(lit.liveLightsBy, hop().personId);
  throwsRule(() => L.setLiveLight(hop(), day.id, "smoke" as never, "ok"), /lights/);
  throwsRule(() => L.setLiveLight(hop(), day.id, "audio", "purple" as never));
  throwsRule(() => L.setLiveLight(login("volunteer1@dof.demo", "demo"), day.id, "audio", "ok"), /view-only/);
  // A series session has no Live Control.
  throwsRule(() => L.setLiveLight(hop(), "DOF-SER-001-S1-R02", "audio", "ok"), /live show/);
  ok();
});

await t("gear not brought back after a show is flagged on its call sheet, its day and in the urgency report", () => {
  const event = camp();
  const day = daysOfEvent(event.contentId)[0];
  const cs = sheetOf(day.id);
  const item = getDb().equipment.find((e) => e.baseStatus === "active" && e.trackingType === "serialized")!;
  const past = addDaysIso(todayIso(), -3);
  const m: Manifest = {
    id: "DOF-MF-900",
    contentId: event.parentId ?? event.contentId,
    callSheetId: cs.id,
    destination: "outside",
    status: "checked-out",
    date: past,
    expectedReturn: addDaysIso(past, 1),
    responsiblePersonId: "DOF-P-CRW-001",
    lines: [
      {
        equipmentId: item.id,
        quantity: 1,
        conditionOut: "Good",
        photosOut: [],
        conditionIn: null,
        photosIn: [],
        returnedGood: 0,
        damaged: 0,
        lost: 0,
      },
    ],
    notes: "",
    createdAt: new Date().toISOString(),
    createdBy: hop().personId,
    checkedOutAt: new Date().toISOString(),
    returnedAt: null,
  };
  getDb().manifests.push(m);
  commit();
  const flag = L.gearNotReturned(cs.id)!;
  assert.deepEqual([flag.items, flag.due, flag.manifestId], [1, addDaysIso(past, 1), "DOF-MF-900"]);
  assert.equal(L.projectGearNotReturned(event.contentId).length, 1);
  const row = urgencyReport(hop()).find((r) => r.id === event.contentId)!;
  assert.ok(
    row.reasons.some((x) => /Gear not returned: 1 item from 1 day/.test(x.text ?? String(x))),
    JSON.stringify(row.reasons),
  );
  const page = html(hop(), <CallSheetBody cs={sheet(cs.id)} root={record(event.parentId ?? event.contentId)} />);
  assert.match(page, /Gear not returned\./);
  assert.match(html(hop(), <SessionPage id={day.id} />), /Gear not returned\./);
  // Back in: no flag.
  m.status = "returned";
  commit();
  assert.equal(L.gearNotReturned(cs.id), null);
});

await t("the screens: Tech Check and Rehearsal Log on a live day's sheet and tiles, the Rundown, Live Control, and its button", () => {
  const event = camp();
  W.assignProducer(hop(), event.contentId, PRODUCER);
  const day = daysOfEvent(event.contentId)[0];
  const cs = sheetOf(day.id);
  const body = html(hop(), <CallSheetBody cs={cs} root={record(event.parentId ?? event.contentId)} />);
  for (const words of [
    'aria-label="Tech Check"',
    'aria-label="Rehearsal Log"',
    "Who checks it",
    "Test result",
    "Line check",
    "Time checked",
  ])
    assert.ok(body.includes(words), words);
  const tile = html(hop(), <TechCheckPane project={record(event.contentId) as Project} />);
  assert.ok(tile.includes("0 OK · 0 issues · 14 not checked"), "the counts");
  L.setRundown(hop(), event.contentId, [{ id: "RS-a1", time: "18:00", title: "Worship", durationMin: 20, ownerPersonId: null, notes: "" }]);
  const rundown = html(hop(), <RundownSection project={record(event.contentId) as Project} />);
  assert.ok(rundown.includes("Worship") && rundown.includes("Copy to days with no run of show"));
  L.copyRundownToDays(hop(), event.contentId);
  const control = html(hop(), <LiveControl sessionId={day.id} />);
  for (const words of [
    'aria-label="Time now"',
    "On air",
    "Up next",
    "Start the show ▶",
    'aria-label="Status lights"',
    "Cameras",
    "Internet",
  ])
    assert.ok(control.includes(words), words);
  assert.ok(html(hop(), <SessionPage id={day.id} />).includes(">Live Control</button>"));
});

await t("data version 24 gives existing live shows their new names, the Tech Check's states and the Rehearsal Log's steps, once", () => {
  const event = camp();
  const days = daysOfEvent(event.contentId);
  const db = getDb();
  // As saved before: the old names, a tick with no state, no rehearsal steps.
  db.projectDocuments.push(
    {
      id: "PD-old1",
      contentId: event.contentId,
      stage: "Development",
      docKey: "event_brief",
      ownerId: null,
      title: "Event Brief",
      createdAt: "",
      updatedAt: "",
    } as never,
    {
      id: "PD-old2",
      contentId: event.contentId,
      stage: "Production",
      docKey: "show_day_sheet",
      ownerId: days[0].id,
      title: "Show Day Sheet",
      createdAt: "",
      updatedAt: "",
    } as never,
    {
      id: "PD-old3",
      contentId: event.contentId,
      stage: "Marketing and distribution",
      docKey: "show_report",
      ownerId: null,
      title: "Our own report",
      createdAt: "",
      updatedAt: "",
    } as never,
  );
  const cs = sheetOf(days[0].id);
  cs.technicalCheck = [{ id: "TC-x", label: "Audio", done: true, note: "" }];
  delete cs.rehearsal.steps;
  const plan = toV24(db);
  assert.ok(
    plan.lines.some((l) => /2 live show documents take their new name/.test(l)),
    plan.lines.join(" | "),
  );
  assert.ok(plan.lines.some((l) => /1 live Tech Check line gets its state/.test(l)));
  assert.ok(plan.lines.some((l) => /1 live day or template gets the Rehearsal Log's steps/.test(l)));
  const title = (id: string) => db.projectDocuments.find((d) => d.id === id)!.title;
  assert.deepEqual([title("PD-old1"), title("PD-old2"), title("PD-old3")], ["Show Plan", "Live Day", "Our own report"]);
  assert.equal(cs.technicalCheck[0].state, "OK");
  assert.equal(cs.rehearsal.steps!.length, REHEARSAL_STEPS.length);
  assert.deepEqual(toV24(db).lines, [], "running it again changes nothing");
});

console.log(`\n${passed} passed`);
