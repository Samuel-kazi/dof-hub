// Run with: npm test -- workflow-views
// Phase 4 of the five-stage workflow: the board, calendar, reminders, dashboard, search, pipeline report and
// workload, on the Whispers of Why fixture (src/data/seedWorkflow.ts). The clock is fixed at 26 September 2026,
// 09:00 in Nairobi (tests/setup/clock.mjs): session 1 closed a week ago, session 2 is today, sessions 3 to 6 follow
// a week apart, and episodes E01 to E04 are in Post production.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import type { CallSheet, ContentRecord } from "../src/types";
import { AppProvider } from "../src/ui/AppContext";
import { Pipeline } from "../src/pages/Pipeline";
import { Dashboard } from "../src/pages/Dashboard";
import { CalendarPage } from "../src/pages/Calendar";
import { Reminders } from "../src/pages/Reminders";
import { RecordPage } from "../src/pages/RecordPage";
import { getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { migrateDocuments } from "../src/data/migrateDocuments";
import { rec } from "../src/data/seed";
import { categoryOf } from "../src/config/categories";
import { WORKFLOW_STAGE_NAMES } from "../src/config/workflow";
import { login } from "../src/services/auth";
import { workItems, workflowBoard, waitingOnPerson, type WorkItem } from "../src/services/workItems";
import { calendarEvents } from "../src/services/calendarView";
import { remindersFor, workflowDueSoon, dueSoon } from "../src/services/reminders";
import { searchAll } from "../src/services/search";
import { buildReport } from "../src/services/reports";
import { workloadFor } from "../src/services/workload";
import { addDaysIso, todayIso } from "../src/services/utils";

let passed = 0;
const t = (name: string, fn: () => void) => {
  setDb(buildWorkflowFixture());
  try {
    fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 3).join("\n     "));
    process.exitCode = 1;
  }
};

const HOP = "hop@dof.demo";
const PRODUCER_LOGIN = "crew4@dof.demo";
const PRODUCER = "DOF-P-CRW-004";
const WOW = "DOF-SER-001-S1";
const TODAY = "2026-09-26";
const hop = () => login(HOP, "demo");
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
const record = (id: string): ContentRecord => getDb().records.find((r) => r.contentId === id)!;
const session = (n: number) => getDb().recordingSessions.find((s) => s.id === `${WOW}-R0${n}`)!;
const column = (category: string, stage: string): WorkItem[] =>
  workflowBoard(workItems(hop()).filter((i) => i.category === category)).find((c) => c.stage === stage)!.cards;
const keys = (items: WorkItem[]) => items.map((i) => i.key);
const item = (key: string) => workItems(hop()).find((i) => i.key === key)!;
const yesterday = () => addDaysIso(todayIso(), -1);

t("the clock is fixed where the fixture expects it", () => {
  assert.equal(todayIso(), TODAY);
  assert.equal(session(2).scheduledDate, TODAY);
});

// ── The board ────────────────────────────────────────────────

t("the board has the five stages, with a project, session or episode card at each stage's level", () => {
  const board = workflowBoard(workItems(hop()).filter((i) => i.category === "series"));
  assert.deepEqual(
    board.map((c) => c.stage),
    WORKFLOW_STAGE_NAMES,
  );
  assert.deepEqual(keys(column("series", "Development")), []);
  assert.deepEqual(keys(column("series", "Pre-production")), [`project:${WOW}`]);
  assert.match(column("series", "Pre-production")[0].step, /^Next: session 2 on .*, and 4 more$/);
  assert.deepEqual(keys(column("series", "Production")), [], "no session is recording");
  assert.deepEqual(
    keys(column("series", "Post production")),
    [1, 2, 3, 4].map((n) => `episode:${WOW}-E0${n}`),
  );
  assert.deepEqual(keys(column("series", "Marketing and distribution")), []);
  assert.deepEqual(keys(column("devotional", "Development")), ["project:DOF-DEV-001"]);
  assert.deepEqual(keys(column("documentary", "Development")), ["project:DOF-DOC-001"]);
  assert.equal(column("series", "Pre-production")[0].title, "Whispers of Why: Season 1", "a season carries its series' name");
});

t("an open session is the Production card; its project stays in Pre-production while sessions or episodes are left to schedule", () => {
  session(2).status = "Open";
  assert.deepEqual(keys(column("series", "Production")), [`session:${WOW}-R02`]);
  assert.match(column("series", "Pre-production")[0].step, /^Next: session 3/);
  for (const n of [3, 4, 5, 6]) Object.assign(session(n), { archivedAt: `${TODAY}T08:00:00Z`, archivedReason: "Moved" });
  // 30 planned, four made from session 1, none on session 2's log yet: 26 still need a session.
  assert.equal(column("series", "Pre-production")[0].step, "26 planned episodes still to schedule");
  const made = new Set(
    getDb()
      .records.filter((r) => r.episode)
      .map((r) => r.episode!.plannedEpisodeId),
  );
  for (const p of getDb().plannedEpisodes)
    if (!made.has(p.id)) Object.assign(p, { archivedAt: `${TODAY}T08:00:00Z`, archivedReason: "Dropped" });
  assert.deepEqual(keys(column("series", "Pre-production")), [], "nothing left to plan or schedule");
});

t("a documentary whose sessions are all closed waits in Production to be sent to post production", () => {
  const doc = record("DOF-DOC-001");
  Object.assign(doc.workflow!, { stage: "Pre-production", status: "Active" });
  getDb().recordingSessions.push({ ...session(1), id: "DOF-DOC-001-R01", contentId: doc.contentId, callSheetId: null });
  const production = column("documentary", "Production");
  assert.deepEqual(keys(production), ["project:DOF-DOC-001"]);
  assert.match(production[0].step, /send to post production/);
  assert.deepEqual(keys(column("documentary", "Pre-production")), []);
});

t("published episodes and closed projects leave the board; Published and Closed show them on request", () => {
  Object.assign(record(`${WOW}-E04`).episode!, { stage: "Marketing and distribution", mdStage: "Published" });
  Object.assign(record(`${WOW}-E03`).episode!, { stage: "Marketing and distribution", mdStage: "Release plan" });
  Object.assign(record("DOF-DEV-001"), { archived: true, closedReason: "The guest withdrew" });
  record("DOF-DEV-001").workflow!.status = "Closed";
  assert.deepEqual(keys(column("series", "Marketing and distribution")), [`episode:${WOW}-E03`]);
  assert.ok(!keys(column("series", "Post production")).includes(`episode:${WOW}-E04`));
  assert.deepEqual(keys(column("devotional", "Development")), []);
  const series = html(HOP, <Pipeline category="series" />);
  assert.match(series, /Published \(1\)/, "the Published chip");
  const devotions = html(HOP, <Pipeline category="devotional" />);
  assert.match(devotions, /Closed \(1\)/, "the Closed chip counts a closed workflow project");
});

t("overdue is for episodes only: an episode past its stage deadline, never a session or a project", () => {
  record(WOW).stageDeadlines["Pre-production"] = yesterday();
  session(2).scheduledDate = yesterday();
  record(`${WOW}-E02`).stageDeadlines["Post production"] = yesterday();
  assert.equal(item(`project:${WOW}`).overdue, false, "a project is never overdue");
  assert.equal(item(`session:${WOW}-R02`).overdue, false, "a session is never overdue, even past its day");
  assert.equal(item(`episode:${WOW}-E02`).overdue, true);
  assert.equal(item(`episode:${WOW}-E01`).overdue, false);
  session(2).status = "Open";
  assert.equal(item(`session:${WOW}-R02`).overdue, false, "nor while it is recording");
  const page = html(HOP, <Pipeline category="series" />);
  const card = (id: string) => page.slice(page.indexOf(`>${id}<`), page.indexOf(`>${id}<`) + 700);
  assert.match(card(`${WOW}-E02`), /Overdue/);
  assert.doesNotMatch(card(WOW), /Overdue/);
});

t("each card says what its next Done button still needs, or who it is waiting on", () => {
  assert.equal(item(`project:${WOW}`).gate?.passed, true, "the fixture's project part of the session gate is complete");
  assert.equal(item(`episode:${WOW}-E01`).gate, null, "Not started has no gate yet");
  record(`${WOW}-E01`).episode!.postStage = "Editing";
  assert.deepEqual(item(`episode:${WOW}-E01`).gate?.missing, ["The editor marks it ready for review"]);
  record(`${WOW}-E02`).episode!.postStage = "Rough cut review";
  getDb().reviewCheckpoints.find((c) => c.id === `${WOW}-E02|rough_cut`)!.reviewerIds = ["DOF-P-CRW-002"];
  const e02 = item(`episode:${WOW}-E02`);
  assert.equal(e02.gate, null);
  assert.deepEqual(e02.waitingOn, ["DOF-P-CRW-002"], "in review it waits on its reviewers, not the editor");
  const page = html(HOP, <Pipeline category="series" />);
  assert.match(page, /Ready to move on/);
  assert.match(page, /1 thing to do/);
  assert.match(page, /Waiting for rough cut review/);
});

t("the Pipeline page shows the workflow board for its categories and the earlier board for everything else", () => {
  const series = html(HOP, <Pipeline category="series" />);
  for (const s of WORKFLOW_STAGE_NAMES) assert.ok(series.includes(`aria-label="${s}"`), s);
  assert.match(series, /Next: session 2/);
  assert.match(series, /Why do we doubt\?/);
  assert.match(series, /Podcast/, "a project card names its kind");
  assert.doesNotMatch(series, /Made before the new workflow/);
  assert.doesNotMatch(series, /aria-label="Editorial"/);
  // An item made before the workflow keeps its stages, on a board of its own, until the data is moved over.
  getDb().records.push(
    rec({ contentId: "DOF-SER-002", title: "Old Show", category: "series", parentId: null, level: 0, stage: null }),
    rec({ contentId: "DOF-SER-002-S1", title: "Season 1", category: "series", parentId: "DOF-SER-002", level: 1, stage: null }),
    rec({
      contentId: "DOF-SER-002-S1-E01",
      title: "Old Episode",
      category: "series",
      parentId: "DOF-SER-002-S1",
      level: 2,
      stage: "Editorial",
    }),
  );
  const both = html(HOP, <Pipeline category="series" />);
  assert.match(both, /Made before the new workflow/);
  assert.match(both, /aria-label="Editorial"/);
  assert.match(both, /Old Episode/);
  const live = html(HOP, <Pipeline category="live" />);
  assert.doesNotMatch(live, /No session is recording/, "Live Shows keep their own board, of days, now on the five stages");
  assert.match(live, /aria-label="Pre-production"/);
});

t("the tree shows where each workflow project and episode stands, and a series its seasons", () => {
  const tree = html(HOP, <Pipeline />);
  assert.match(tree, /1 season/);
  assert.match(
    tree,
    /Season 1<\/div><span class="cid">DOF-SER-001-S1<\/span><\/div><span class="muted" style="font-size:.82rem">Season<\/span><span class="badge accent">Pre-production/,
  );
  assert.doesNotMatch(tree, /0 of 0 complete/);
  const seriesPage = html(HOP, <RecordPage id="DOF-SER-001" />);
  assert.doesNotMatch(seriesPage, /No seasons yet/, "the series page lists its season, with no empty progress panel");
  assert.match(seriesPage, /Season 1/);
});

// ── The calendar ─────────────────────────────────────────────

t("the calendar shows sessions and stage deadlines, derived, in the category's colour", () => {
  const events = calendarEvents(hop(), "2026-09-01", "2026-10-31");
  const color = categoryOf("series").color;
  for (let n = 1; n <= 6; n++) {
    const e = events.find((x) => x.id === `session:${WOW}-R0${n}`);
    assert.ok(e, `session ${n}`);
    assert.equal(e.subtype, "session");
    assert.equal(e.color, color);
    assert.deepEqual(e.open, { n: "session", id: `${WOW}-R0${n}` });
  }
  assert.ok(!events.some((e) => e.id.startsWith(`shoot:${WOW}-E`)), "an episode's session day is the session's marker, not four more");
  const post = events.find((e) => e.id === `deadline:${WOW}-E01:Post production`);
  assert.ok(post && post.endDate === addDaysIso(TODAY, 14));
  assert.ok(events.some((e) => e.id === `deadline:${WOW}-E01:Marketing and distribution` && e.subtype === "deadline"));
  assert.ok(events.some((e) => e.id === `deadline:${WOW}:Pre-production` && e.date === addDaysIso(TODAY, 7)));
  assert.ok(
    events.some((e) => e.id === "callsheet:DOF-CS-001"),
    "call sheet dates stay",
  );
  // Archived sessions and published episodes drop off; nothing is stored, so changing the source changes the calendar.
  Object.assign(session(6), { archivedAt: `${TODAY}T08:00:00Z`, archivedReason: "Moved" });
  Object.assign(record(`${WOW}-E01`).episode!, { stage: "Marketing and distribution", mdStage: "Published" });
  session(3).scheduledDate = "2026-10-05";
  const after = calendarEvents(hop(), "2026-09-01", "2026-10-31");
  assert.ok(!after.some((e) => e.id === `session:${WOW}-R06`));
  assert.ok(!after.some((e) => e.id.startsWith(`deadline:${WOW}-E01:`)));
  assert.equal(after.find((e) => e.id === `session:${WOW}-R03`)?.date, "2026-10-05");
  assert.deepEqual(calendarEvents(login("volunteer1@dof.demo", "demo"), "2026-09-01", "2026-10-31"), [], "only what the person may see");
  assert.match(html(HOP, <CalendarPage />), /Recording session/);
});

// ── Reminders ────────────────────────────────────────────────

t("reminders: the producer gets the project's deadline and each session's day, and episodes go to whoever moves them on", () => {
  const rems = remindersFor(PRODUCER, TODAY);
  const k = rems.map((r) => r.key);
  for (const n of [2, 3, 4, 5]) assert.ok(k.includes(`session:${WOW}-R0${n}`), `session ${n}`);
  assert.ok(!k.includes(`session:${WOW}-R06`), "beyond the three weeks ahead");
  assert.ok(!k.includes(`session:${WOW}-R01`), "closed");
  assert.ok(k.includes(`stage:${WOW}:Pre-production`));
  for (const n of [1, 2, 3, 4]) assert.ok(k.includes(`stage:${WOW}-E0${n}:Post production`), "no editor yet, so the producer");
  assert.equal(rems.find((r) => r.key === `session:${WOW}-R02`)?.sessionId, `${WOW}-R02`, "a session's reminder opens the session");
  // An editor named on an episode takes its reminder over.
  record(`${WOW}-E02`).episode!.editorId = "DOF-P-CRW-001";
  assert.ok(!remindersFor(PRODUCER, TODAY).some((r) => r.key === `stage:${WOW}-E02:Post production`));
  assert.ok(remindersFor("DOF-P-CRW-001", TODAY).some((r) => r.key === `stage:${WOW}-E02:Post production`));
});

t("reminders: within 24 hours, late episodes, and never a late session or project", () => {
  const soon = workflowDueSoon(PRODUCER);
  assert.ok(
    soon.some((r) => r.key === `session:${WOW}-R02` && r.kind === "session"),
    "session 2 is today",
  );
  // The fixture names the producer as reviewer of the devotion's and the documentary's pitch and outline, both waiting.
  // Those earlier checkpoints are decided nowhere now, so they remind no one; moved into the documents (as the upgrade
  // does), they are the review of each project's script or brief, and that is what the producer is reminded of.
  assert.deepEqual(
    soon.filter((r) => r.kind === "review"),
    [],
  );
  migrateDocuments(getDb(), { at: new Date().toISOString() });
  const moved = workflowDueSoon(PRODUCER);
  assert.deepEqual(
    moved
      .filter((r) => r.kind === "review")
      .map((r) => r.key)
      .sort(),
    ["review:DOF-DEV-001|Development|devotional_script", "review:DOF-DOC-001|Development|documentary_brief"],
  );
  assert.equal(moved.length, 3, "nothing else is due within 24 hours");
  assert.ok(
    dueSoon(PRODUCER).some((r) => r.key === `session:${WOW}-R02`),
    "the emails and texts include it too",
  );
  record(WOW).stageDeadlines["Pre-production"] = yesterday();
  session(2).scheduledDate = yesterday();
  record(`${WOW}-E03`).stageDeadlines["Post production"] = yesterday();
  const rems = remindersFor(PRODUCER, TODAY);
  assert.ok(!rems.some((r) => r.key === `stage:${WOW}:Pre-production`), "a project's passed deadline is not a late reminder");
  assert.ok(!rems.some((r) => r.key === `session:${WOW}-R02`), "a session's passed day is not a late reminder");
  assert.equal(rems.find((r) => r.key === `stage:${WOW}-E03:Post production`)?.overdue, true);
  assert.ok(
    rems.filter((r) => r.overdue).every((r) => r.key.startsWith("stage:DOF-SER-001-S1-E")),
    "only episodes are ever late",
  );
});

t("reminders: a waiting review goes to each reviewer named on it, and a call sheet replaces the session's own reminder", () => {
  record(`${WOW}-E01`).episode!.postStage = "Rough cut review";
  getDb().reviewCheckpoints.find((c) => c.id === `${WOW}-E01|rough_cut`)!.reviewerIds = ["DOF-P-CRW-002"];
  const reviewer = remindersFor("DOF-P-CRW-002", TODAY).find((r) => r.key === `review:${WOW}-E01|rough_cut`);
  assert.ok(reviewer);
  assert.equal(reviewer.kind, "review");
  assert.ok(!remindersFor(PRODUCER, TODAY).some((r) => r.key === `stage:${WOW}-E01:Post production`), "it is not waiting on the editor");
  const sheet: CallSheet = { ...getDb().callSheets[0], id: "DOF-CS-002", date: session(3).scheduledDate!, status: "draft" };
  getDb().callSheets.push(sheet);
  session(3).callSheetId = sheet.id;
  const k = remindersFor(PRODUCER, TODAY).map((r) => r.key);
  assert.ok(k.includes("sheet:DOF-CS-002") && !k.includes(`session:${WOW}-R03`), "the shoot reminder from the call sheet, once");
  assert.match(html(PRODUCER_LOGIN, <Reminders />), /Session/);
});

// ── Dashboard ────────────────────────────────────────────────

t("the dashboard counts workflow projects, what waits on you, late episodes, and sessions with no call sheet", () => {
  const page = html(PRODUCER_LOGIN, <Dashboard />);
  assert.match(page, /Whispers of Why: Season 1, Session 2/);
  assert.match(page, /It has no call sheet yet/);
  assert.match(page, /Whispers of Why: Season 1, Why do we doubt\?/, "an episode waiting on its producer");
  session(2).scheduledDate = yesterday();
  assert.match(html(HOP, <Dashboard />), /100% on track/, "a session past its day is not overdue");
  record(`${WOW}-E02`).stageDeadlines["Post production"] = yesterday();
  const late = html(HOP, <Dashboard />);
  assert.match(late, /1 overdue/);
  assert.match(late, /days late|Overdue/);
  const waiting = waitingOnPerson(workItems(login(PRODUCER_LOGIN, "demo"), false), PRODUCER).map((i) => i.key);
  assert.ok(waiting.includes(`project:${WOW}`));
  assert.ok(!waiting.includes(`session:${WOW}-R03`), "a planned session is the project card's work, not a card of its own");
  for (const who of ["volunteer1@dof.demo", "partner1@dof.demo", "crew2@dof.demo"]) assert.ok(html(who, <Dashboard />).length, who);
});

// ── Search, report, workload ─────────────────────────────────

t("search finds a recording session by its code or its project's name, for those who may see it", () => {
  const hits = searchAll(hop(), "R03");
  assert.ok(hits.some((h) => h.kind === "session" && h.id === `${WOW}-R03`));
  assert.ok(searchAll(hop(), "whispers session").some((h) => h.kind === "session"));
  assert.deepEqual(
    searchAll(login("volunteer1@dof.demo", "demo"), "R03").filter((h) => h.kind === "session"),
    [],
  );
});

t("the pipeline status report lists the workflow's work at the board's levels", () => {
  const text = JSON.stringify(buildReport(hop(), "pipeline.status", { which: "open" }));
  assert.match(text, /Series, devotions and documentaries/);
  assert.match(text, new RegExp(`${WOW}-E01`));
  assert.match(text, /Pre-production: Next: session 2/);
  assert.ok(!text.includes(`${WOW}-R03`), "planned sessions are the project's row");
  Object.assign(record(`${WOW}-E04`).episode!, { stage: "Marketing and distribution", mdStage: "Published" });
  const done = JSON.stringify(buildReport(hop(), "pipeline.status", { which: "done" }));
  assert.match(done, new RegExp(`${WOW}-E04`));
  assert.match(done, /Published/);
});

t("workload: a session's day before its call sheet, and editing spread up to the Post production deadline", () => {
  const dop = workloadFor("DOF-P-CRW-002", TODAY);
  assert.ok(
    dop.items.some((i) => i.id === `${WOW}-R02#shoot` && i.days[0] === TODAY),
    "the DOP's day for session 2",
  );
  const producer = workloadFor(PRODUCER, TODAY);
  const edits = producer.items.filter((i) => i.label.endsWith(": Post production"));
  assert.equal(edits.length, 4, "no editor yet, so the producer");
  assert.ok(edits.every((i) => i.effort === 2 && i.to === addDaysIso(TODAY, 14)));
  // Once the session has a call sheet, being on the sheet is what counts.
  const sheet: CallSheet = { ...getDb().callSheets[0], id: "DOF-CS-002", date: TODAY, crewPersonIds: [PRODUCER], status: "draft" };
  getDb().callSheets.push(sheet);
  session(2).callSheetId = sheet.id;
  assert.ok(!workloadFor("DOF-P-CRW-002", TODAY).items.some((i) => i.id.startsWith(`${WOW}-R02`)));
  record(`${WOW}-E01`).episode!.postStage = "Rough cut review";
  assert.equal(workloadFor(PRODUCER, TODAY).items.filter((i) => i.label.endsWith(": Post production")).length, 3, "review is not editing");
});

console.log(`\n${passed} passed`);
