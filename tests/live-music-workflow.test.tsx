// Run with: npm test -- live-music-workflow
// Live Shows and DOF Music on the five-stage workflow (data version 23), as series, devotions and documentaries are:
// a music project holds its releases (a single or an album) and a live show its events, each the project, with its
// Project Home, documents, gates, Recording Plan, sessions and episodes. A live event's days are its sessions, each with
// its own call sheet and run of show, and what a day records goes on as recordings. The move of existing data (version
// 23); the dashboard and urgency rules for live events (one production, urgent only within a month).
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor, Database } from "../src/types";
import { RuleError } from "../src/types";
import { enableRollback, getDb, setDb, upgradeDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { buildSeed } from "../src/data/seed";
import { integrityProblems } from "../src/data/constraints";
import { liveMusicToWorkflow } from "../src/data/migrateLiveMusic";
import { catalogFor } from "../src/config/documentCatalog";
import { CHECKLISTS } from "../src/config/workflow";
import { login } from "../src/services/auth";
import * as CS from "../src/services/wrapped/callsheets";
import * as D from "../src/services/wrapped/documents";
import * as P from "../src/services/wrapped/production";
import * as W from "../src/services/wrapped/workflow";
import { daysOfEvent, sheetOfDay } from "../src/services/production";
import { ensureChecklist } from "../src/services/workflow/common";
import { calendarEvents } from "../src/services/calendarView";
import { urgencyReport } from "../src/services/urgency";
import { workItems } from "../src/services/workItems";
import { weeklyFrom } from "../src/services/recurrence";
import { addDaysIso, todayIso } from "../src/services/utils";
import { AppProvider } from "../src/ui/AppContext";
import { WorkflowProjectPage } from "../src/pages/workflow/ProjectPage";
import { SessionPage } from "../src/pages/workflow/SessionPage";
import { Dashboard } from "../src/pages/Dashboard";
import { RecordPage } from "../src/pages/RecordPage";
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
const tick = (key: keyof typeof CHECKLISTS, owner: string) => {
  const def = CHECKLISTS[key];
  for (const i of def.items) if (!i.auto) W.setChecklistItem(hop(), `${owner}|${def.stage}|${i.key}`, { done: true, note: "" });
};
/** Development's gates the way the documents pass them: the idea, the greenlight, a producer; then on to Pre-production. */
const toPreProduction = (id: string) => {
  W.saveFormSection(hop(), id, "brief", { logline: "Morning, again.", coreQuestion: "Mercy is new." });
  W.decideGreenlight(hop(), id, { outcome: "Greenlight", notes: "" });
  W.assignProducer(hop(), id, PRODUCER);
  tick("handoff", id);
  W.advanceProject(hop(), id);
  W.startPlanRoles(hop(), id);
  for (const r of W.planRolesOf(id)) W.setRolePerson(hop(), r.id, PRODUCER);
  tick("preProject", id);
};

// ── Music: a single and an album, on the series' workflow ─────

await t("a single is a music project with one release: the song listed already, the series' tiles in a song's words", () => {
  const release = W.createWorkflowProject(hop(), { category: "music", title: "Morning Mercies", formType: "music_single" });
  assert.match(release.contentId, /^DOF-MUS-\d{3}-A1$/, "the release is the project, under a new music project");
  const parent = record(release.parentId!);
  assert.equal(parent.hierarchyLevel, 0);
  assert.equal(parent.title, "Morning Mercies");
  assert.equal(release.workflow.formType, "music_single");
  assert.equal(release.workflow.stage, "Development");
  assert.deepEqual(
    W.plannedOf(release.contentId).map((p) => p.workingTitle),
    ["Morning Mercies"],
    "a single is one song, listed under the release's title",
  );
  throwsRule(() => W.addPlannedEpisode(hop(), release.contentId, { workingTitle: "Another" }), /has 1 already/);
  assert.deepEqual(
    catalogFor("music_single", "Development").map((e) => e.title),
    ["Music Brief", "Theological Review", "Greenlight", "The Song"],
  );
  assert.deepEqual(
    catalogFor("music_album", "Pre-production").map((e) => e.title),
    ["Production Pack", "Recording Plan", "Storyboard", "Shot List", "Gear"],
  );
  assert.deepEqual(
    D.hardGates(release.contentId).map((g) => g.key),
    ["idea", "greenlight"],
    "the same gates as a series: the idea and the greenlight with a producer; the review is a reminder",
  );
  assert.equal(D.hardGates(release.contentId)[0].label, "The logline and the core message written in the brief", "in a song's words");
  const page = html(hop(), <WorkflowProjectPage project={release} />);
  for (const words of ["Music: Single", "Music Brief", "Theological Review", "The Song", "Recording Plan", "Song Tracker", "Release Plan"])
    assert.ok(page.includes(words), words);
  ok();
});

await t(
  "an album: songs planned; a song on its audio session and its video session; closing them makes the song once, with both notes",
  () => {
    const album = W.createWorkflowProject(hop(), { category: "music", title: "Dawn Songs II", formType: "music_album" });
    const id = album.contentId;
    W.addPlannedEpisode(hop(), id, { workingTitle: "First Light" });
    W.addPlannedEpisode(hop(), id, { workingTitle: "Evening Psalm" });
    toPreProduction(id);
    const [song1, song2] = W.plannedOf(id).map((p) => p.id);
    const audio = W.createSession(hop(), id, { name: "Audio recording", scheduledDate: addDaysIso(todayIso(), 3) });
    const video = W.createSession(hop(), id, { name: "Video shoot", scheduledDate: addDaysIso(todayIso(), 5) });
    assert.match(audio.id, /^DOF-MUS-\d{3}-A1-R01$/);
    // A song can be on both sessions; ticking it on one does not take it off the other.
    W.setSongOnSession(hop(), song1, audio.id, true);
    W.setSongOnSession(hop(), song2, audio.id, true);
    W.setSongOnSession(hop(), song1, video.id, true);
    const placed = W.devotionPlacements(id).find((x) => x.planned.id === song1)!;
    assert.deepEqual(placed.sessionIds.sort(), [audio.id, video.id].sort());
    W.setSongOnSession(hop(), song2, audio.id, false);
    W.setSongOnSession(hop(), song2, audio.id, true);
    // Each song can have its own storyboard, or share the release's.
    const own = D.createStoryboard(hop(), id, { name: "First Light video", episodeId: song1 });
    const shared = D.createShotList(hop(), id, { name: "The album's cameras" });
    assert.equal(own.episodeId, song1, "a board for one planned song");
    assert.equal(shared.episodeId, null, "a list shared by the whole release");
    // Recorded: the audio session, then the video session. The song is made once, by the first.
    for (const s of [audio.id, video.id]) {
      const row = getDb().recordingSessions.find((x) => x.id === s)!;
      row.status = "Open"; // the gear and rehearsal of Pre-production are tested with the series; here the logs matter
      ensureChecklist("wrap", "session", s);
      W.updateLogRow(hop(), `${s}|${song1}`, { status: "Recorded", notesForPost: s === audio.id ? "Vocal take 3" : "Wide at 01:20" });
      if (s === audio.id) W.updateLogRow(hop(), `${s}|${song2}`, { status: "Recorded", notesForPost: "" });
      tick("wrap", s);
    }
    const first = W.closeSession(hop(), audio.id);
    assert.equal(first.made.length, 2, "two songs from the audio session");
    assert.ok(
      first.made.every((x) => /-T0\d$/.test(x)),
      "songs are numbered with T, as tracks were",
    );
    const second = W.closeSession(hop(), video.id);
    assert.deepEqual(second.made, [], "the video session makes no song twice");
    assert.equal(second.kept.length, 1);
    const song = record(first.made[0]);
    assert.match(song.episode!.productionNotes, /Vocal take 3/);
    assert.match(song.episode!.productionNotes, /Video shoot: Wide at 01:20/, "the video session's notes are added to the song's");
    ok();
  },
);

// ── Live: an event of a live show, its days its sessions ──────

await t("a multi-day event: a live show with its first event, a day and call sheet for each date, all in Development", () => {
  const start = addDaysIso(todayIso(), 40);
  const event = W.createWorkflowProject(hop(), {
    category: "live",
    title: "Youth Camp 2026",
    event: { mode: "multi_day", startDate: start, endDate: addDaysIso(start, 2), callTime: "07:30", location: "Kasarani" },
  });
  assert.match(event.contentId, /^DOF-LIVE-\d{3}-E1$/, "the event is the project, E1 under its show");
  assert.equal(record(event.parentId!).title, "Youth Camp 2026");
  assert.equal(event.workflow.formType, "live_event");
  assert.equal(event.workflow.stage, "Development");
  const days = daysOfEvent(event.contentId);
  assert.deepEqual(
    days.map((d) => d.name),
    ["Day 1", "Day 2", "Day 3"],
  );
  assert.ok(
    days.every((d) => /-E1-D0\d$/.test(d.id)),
    "days are numbered with D",
  );
  for (const d of days) {
    const cs = sheetOfDay(d)!;
    assert.ok(cs, "each day has its own call sheet");
    assert.equal(cs.instanceId, d.id);
    assert.equal(cs.date, d.scheduledDate);
    assert.equal(cs.callTime, "07:30");
    assert.equal(cs.contentId, event.parentId, "filed under the show, as a season's sheets are under the series");
  }
  assert.equal(new Set(days.map((d) => sheetOfDay(d)!.id)).size, 3, "three sheets, one each");
  // A day's own run of show is its call sheet's, changed on that day alone.
  CS.updateCallSheet(hop(), sheetOfDay(days[1])!.id, {
    runOfShow: [{ id: "r1", time: "09:00", title: "Worship", durationMin: 30, ownerPersonId: null, notes: "" }],
  });
  assert.equal(sheetOfDay(daysOfEvent(event.contentId)[1])!.runOfShow.length, 1);
  assert.equal(sheetOfDay(daysOfEvent(event.contentId)[0])!.runOfShow.length, 0);
  // A day added later copies the day before it; the days are numbered again in date order.
  const added = P.addEventDay(hop(), event.contentId, addDaysIso(start, -1));
  assert.deepEqual(
    daysOfEvent(event.contentId).map((d) => d.name),
    ["Day 1", "Day 2", "Day 3", "Day 4"],
  );
  assert.equal(daysOfEvent(event.contentId)[0].id, added.id);
  assert.deepEqual(
    catalogFor("live_event", "Development").map((e) => e.title),
    ["Event Brief", "Theological Review", "Greenlight", "Show Days"],
  );
  assert.deepEqual(
    catalogFor("live_event", "Production").map((e) => e.title),
    ["Show Day Sheet", "Show Log", "Storage"],
  );
  assert.equal(D.hardGates(event.contentId)[0].label, "The logline and the purpose of the event written in the brief");
  throwsRule(() => W.createSession(hop(), event.contentId, { scheduledDate: start }), /Show Days/);
  ok();
});

await t(
  "a day is run like a session: opened, its show log, closed; what it recorded goes on as recordings, nothing logged makes none",
  () => {
    const start = addDaysIso(todayIso(), 2);
    const event = W.createWorkflowProject(hop(), {
      category: "live",
      title: "Easter Live",
      event: { mode: "multi_day", startDate: start, endDate: addDaysIso(start, 1), location: "DOF Studio A" },
    });
    toPreProduction(event.contentId);
    const [d1, d2] = daysOfEvent(event.contentId);
    for (const d of [d1, d2]) {
      getDb().recordingSessions.find((x) => x.id === d.id)!.status = "Open";
      ensureChecklist("wrap", "session", d.id);
      tick("wrap", d.id);
    }
    // Day 1 records the service and the message; day 2 records nothing for post production.
    W.addLogRow(hop(), d1.id, { itemLabel: "Full service", status: "Recorded" });
    W.addLogRow(hop(), d1.id, { itemLabel: "The message", status: "Pickup needed", notesForPost: "Mic drop at 12:04" });
    throwsRule(() => W.addLogRow(hop(), d1.id, { itemLabel: "" }), /Name what was recorded/);
    const one = W.closeSession(hop(), d1.id);
    assert.equal(one.made.length, 2);
    assert.ok(
      one.made.every((x) => /-E1-R0\d$/.test(x)),
      "recordings are numbered with R",
    );
    assert.deepEqual(
      one.made.map((x) => record(x).title),
      ["Day 1: Full service", "Day 1: The message"],
    );
    assert.equal(record(one.made[1]).episode!.productionNotes, "Mic drop at 12:04");
    const two = W.closeSession(hop(), d2.id);
    assert.deepEqual(two.made, [], "an empty show log closes the day with nothing for post production");
    // Closing again never makes them twice; reopening and marking one Not recorded archives it, never deleting it.
    W.reopenSession(hop(), d1.id);
    W.updateLogRow(hop(), getDb().sessionLogEntries.find((e) => e.sessionId === d1.id && e.itemLabel === "The message")!.id, {
      status: "Not recorded",
    });
    const again = W.closeSession(hop(), d1.id);
    assert.deepEqual(again.made, []);
    assert.deepEqual(again.archived, [one.made[1]]);
    assert.equal(record(one.made[1]).archived, true);
    // The day's call sheet is the record of the day once it is closed.
    throwsRule(() => CS.updateCallSheet(hop(), sheetOfDay(d1)!.id, { notes: "late change" }), /locked/);
    ok();
  },
);

await t("a recurring show: its next 8 dates as days of the event, a date cancelled or labelled, this and future", () => {
  const event = W.createWorkflowProject(hop(), {
    category: "live",
    title: "Friday Vespers",
    event: { mode: "recurring", rule: weeklyFrom(addDaysIso(todayIso(), 1)), callTime: "17:00", location: "Chapel" },
  });
  const days = daysOfEvent(event.contentId);
  assert.equal(days.length, 8, "the next 8 dates");
  assert.ok(days.every((d) => d.instance?.templateId === event.production!.templateId));
  P.setDayLabel(hop(), days[0].id, "Evening");
  assert.equal(daysOfEvent(event.contentId)[0].instance!.label, "Evening");
  P.cancelDay(hop(), days[1].id, "Public holiday");
  assert.equal(daysOfEvent(event.contentId).length, 7);
  // Changing a day's call sheet by hand takes it off the template; "this and future" makes it the template again.
  CS.updateCallSheet(hop(), sheetOfDay(days[2])!.id, { location: "Main hall" });
  assert.equal(getDb().recordingSessions.find((d) => d.id === days[2].id)!.instance!.locked, true);
  const r = P.applyDayToFuture(hop(), days[2].id);
  assert.ok(r.updated.length >= 4);
  assert.equal(sheetOfDay(daysOfEvent(event.contentId).at(-1)!)!.location, "Main hall");
  assert.equal(sheetOfDay(days[0])!.location, "Chapel", "a day before it keeps what it has");
  ok();
});

// ── One production on the dashboard, urgent only within a month ──

await t("an event is one production: its days do not crowd the work list or dashboard, and it is urgent only within a month", () => {
  const far = W.createWorkflowProject(hop(), {
    category: "live",
    title: "Far Conference",
    event: { mode: "multi_day", startDate: addDaysIso(todayIso(), 60), endDate: addDaysIso(todayIso(), 64) },
  });
  const near = W.createWorkflowProject(hop(), {
    category: "live",
    title: "Near Rally",
    event: { mode: "one_time", date: addDaysIso(todayIso(), 0) },
  });
  const report = urgencyReport(hop());
  const farRow = report.find((r) => r.id === far.contentId)!;
  const nearRow = report.find((r) => r.id === near.contentId)!;
  assert.equal(farRow.level, "On track", "two months off: not urgent or at risk yet, whatever is still to prepare");
  assert.deepEqual(farRow.reasons, []);
  assert.equal(nearRow.level, "Critical", "today, with no published call sheet");
  const page = html(hop(), <Dashboard />);
  assert.ok(page.includes("Near Rally"), "the near event is at risk on the dashboard");
  assert.ok(!page.includes("Far Conference"), "the far one is not there");
  // In Development an event is one card, whatever its days.
  const items = workItems(hop(), false).filter((i) => i.project.contentId === far.contentId);
  assert.deepEqual(
    items.map((i) => i.level),
    ["project"],
  );
  // On the calendar a multi-day event is one bar, its days inside it.
  const bars = calendarEvents(hop(), addDaysIso(todayIso(), 59), addDaysIso(todayIso(), 66)).filter((e) =>
    e.title.includes("Far Conference"),
  );
  assert.equal(bars.length, 1);
  assert.equal(bars[0].days?.length, 5);
  ok();
});

await t("the day's page: its show day, its run of show from its call sheet, the show log, and Start the show", () => {
  const event = W.createWorkflowProject(hop(), {
    category: "live",
    title: "Night of Praise",
    event: { mode: "one_time", date: addDaysIso(todayIso(), 6), location: "DOF Studio A" },
  });
  const day = daysOfEvent(event.contentId)[0];
  const page = html(hop(), <SessionPage id={day.id} />);
  for (const words of [
    "Show day: Night of Praise",
    "Show day",
    "Run of Show",
    "Show log",
    "Ready for the show",
    "Start the show: move to Production",
  ])
    assert.ok(page.includes(words), words);
  assert.ok(!page.includes("Recording session log"));
  const home = html(hop(), <WorkflowProjectPage project={event as Project} />);
  for (const words of ["Live Show: Event", "Event Brief", "Show Days", "Show Day Sheet", "Show Log", "Recording Tracker", "Show Report"])
    assert.ok(home.includes(words), words);
  ok();
});

// ── The move of existing data (data version 23) ──────────────

await t("version 23 moves the sample live shows and music: events and their days as sessions, the album as a release, IDs kept", () => {
  const db = buildSeed();
  const before = new Set(db.records.map((r) => r.contentId));
  const days = db.records.filter((r) => r.category === "live" && r.hierarchyLevel === 1).map((r) => r.contentId);
  const sheets = db.callSheets.filter((c) => c.instanceId).map((c) => [c.id, c.instanceId] as const);
  const res = liveMusicToWorkflow(db);
  assert.ok(res.changed);
  for (const id of before)
    assert.ok(
      db.records.some((r) => r.contentId === id),
      `${id} is kept`,
    );
  for (const show of db.records.filter((r) => r.category === "live" && r.hierarchyLevel === 0)) {
    const event = db.records.find((r) => r.parentId === show.contentId && r.workflow)!;
    assert.equal(event.contentId, `${show.contentId}-E1`);
    assert.equal(event.workflow!.formType, "live_event");
  }
  for (const id of days) {
    const day = db.records.find((r) => r.contentId === id)!;
    assert.equal(day.archived, true, `${id} is kept, archived`);
    const s = db.recordingSessions.find((x) => x.movedFrom === id)!;
    assert.ok(s, `${id} became a session`);
    assert.match(day.closedReason!, new RegExp(s.id), "and says which");
  }
  for (const [cs, day] of sheets) {
    const s = db.recordingSessions.find((x) => x.movedFrom === day)!;
    assert.equal(db.callSheets.find((c) => c.id === cs)!.instanceId, s.id, "the day's call sheet is its session's");
  }
  const album = db.records.find((r) => r.category === "music" && r.hierarchyLevel === 1)!;
  assert.equal(album.workflow!.formType, "music_album");
  assert.ok(db.plannedEpisodes.filter((p) => p.contentId === album.contentId).every((p) => p.reservedId?.startsWith(album.contentId)));
  setDb(db);
  ok();
  // Running it again changes nothing.
  const copy = structuredClone(db);
  assert.equal(liveMusicToWorkflow(db).changed, false);
  assert.deepEqual(db, copy);
  // An old day's link says where the day went: on the hosted site, which does not send archived records, and in the
  // demo, which has them.
  const oldId = days[0];
  const s = db.recordingSessions.find((x) => x.movedFrom === oldId)!;
  const archived = html(hop(), <RecordPage id={oldId} />);
  assert.ok(archived.includes("Moved to the workflow (data version 23)") && archived.includes("Open the day"), "the archived record");
  setDb({ ...db, records: db.records.filter((r) => r.contentId !== oldId) });
  const gone = html(hop(), <RecordPage id={oldId} />);
  assert.ok(
    gone.includes(`${oldId} moved to the workflow (data version 23)`) && gone.includes(s.id) && gone.includes("Open the day"),
    gone.slice(0, 300),
  );
});

await t("data saved at version 22 is upgraded to 23 on load, and a recording made of a day already in post production", () => {
  const db = buildSeed();
  const day = db.records.find((r) => r.category === "live" && r.hierarchyLevel === 1 && !r.archived)!;
  day.pipelineStage = "Post production";
  day.postProductionNeeded = true;
  db.schemaVersion = 22;
  const up = upgradeDb(db)!;
  assert.equal(up.schemaVersion, 23);
  const s = up.recordingSessions.find((x) => x.movedFrom === day.contentId)!;
  assert.equal(s.status, "Closed");
  const rec = up.records.find((r) => r.episode?.sourceSessionId === s.id)!;
  assert.equal(rec.episode!.stage, "Post production");
  assert.match(rec.contentId, /-E1-R01$/);
  setDb(up);
  ok();
});

console.log(`\n${passed} passed`);
