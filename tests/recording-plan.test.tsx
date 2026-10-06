// Run with: npm test -- recording-plan
// Section 7A of the documents brief: a devotion's Recording Plan. Its roles, each with someone from the crew; its
// devotions, read from the script, each on exactly one recording session; the sessions, with their name, label, date
// and hours; one call sheet per session, made as soon as it has a date, with its run sheet and the storyboard and shot
// list it uses; printing; and where the footage and the edit's assets are kept.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import type { Actor } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { REQUIRED_ROLES, roleLabel, roleName } from "../src/config/workflow";
import { login } from "../src/services/auth";
import * as D from "../src/services/wrapped/documents";
import * as P from "../src/services/wrapped/permissions";
import * as S from "../src/services/wrapped/storage";
import * as W from "../src/services/wrapped/workflow";
import { allWorkItems } from "../src/services/workItems";
import { AppProvider } from "../src/ui/AppContext";
import { PlanSectionView, planCards } from "../src/pages/documents/RecordingPlan";
import { PrintedCallSheet } from "../src/pages/documents/printCallSheet";
import { SessionStorage } from "../src/pages/workflow/StorageFields";
import type { Project } from "../src/services/workflow";

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
const producer = (): Actor => login("crew4@dof.demo", "demo");
const crew2 = (): Actor => login("crew2@dof.demo", "demo");
const PRODUCER = "DOF-P-CRW-004";
const WOW = "DOF-SER-001-S1";
const DEV = "DOF-DEV-001";
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e) => (e instanceof RuleError && (!match || match.test(e.message))) || assert.fail((e as Error).message));
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");
const project = (id: string) => getDb().records.find((r) => r.contentId === id) as Project;
const session = (id: string) => getDb().recordingSessions.find((s) => s.id === id)!;
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

/** The devotion through Development: its guest, five pages, the review, a producer, and Accept. */
function accepted(): void {
  W.saveFormSection(hop(), DEV, "guest", { contact: "+254 711 111 111" });
  const script = D.ensureDocument(hop(), DEV, "Development", "devotional_script");
  D.pagesOf(script.id).forEach((p, i) =>
    D.savePage(hop(), p.id, { title: `Day ${i + 1}`, subtitle: `Psalm ${120 + i}`, bodyHtml: `<p>Script ${i + 1}</p>` }, p.version),
  );
  D.setDocumentReviewers(hop(), script.id, ["DOF-P-CRW-002"]);
  D.decideDocumentReview(crew2(), script.id, { status: "approved", note: "" });
  W.assignProducer(hop(), DEV, PRODUCER);
  D.acceptDevotion(hop(), DEV, "");
  commit();
}

/** Two sessions, the first with three devotions and the second with two. */
function splitThreeTwo() {
  const one = W.createSession(producer(), DEV, {
    name: "Day 1",
    label: "Morning",
    scheduledDate: "2026-11-02",
    startTime: "07:00",
    endTime: "13:00",
    venue: "Studio A",
  });
  const two = W.createSession(producer(), DEV, { name: "Day 2", label: "Afternoon", scheduledDate: "2026-11-03" });
  const placed = W.devotionPlacements(DEV);
  placed.slice(0, 3).forEach((x) => W.assignDevotion(producer(), x.planned.id, one.id));
  placed.slice(3).forEach((x) => W.assignDevotion(producer(), x.planned.id, two.id));
  return { one, two, ids: placed.map((x) => x.planned.id), titles: placed.map((x) => x.title) };
}
const onSession = (sessionId: string) =>
  W.devotionPlacements(DEV)
    .filter((x) => x.sessionId === sessionId)
    .map((x) => x.title);

// ── 1. Roles ─────────────────────────────────────────────────

await t("accepting a devotion lists the usual roles; each is renamed, added or removed, and needs someone from the crew", () => {
  accepted();
  const roles = W.planRolesOf(DEV);
  assert.deepEqual(roles.map(roleName), ["Director", "Camera", "Audio", "Lighting", "Floor manager", "Editor"]);
  const gate = () => W.evaluateGate("Pre-production", "project", DEV);
  for (const r of roles) assert.ok(gate().missing.includes(`Role: ${roleName(r)} needs a person`), roleName(r));
  const makeup = W.addPlanRole(producer(), DEV, "Makeup");
  throwsRule(() => W.addPlanRole(producer(), DEV, " makeup "), /already a role called Makeup/);
  throwsRule(() => W.addPlanRole(producer(), DEV, "  "), /Give the role a name/);
  W.renamePlanRole(producer(), makeup.id, "Hair and makeup");
  throwsRule(() => W.renamePlanRole(producer(), makeup.id, "Director"), /already a role called Director/);
  assert.equal(W.planRolesOf(DEV).at(-1)!.label, "Hair and makeup", "added at the end");
  W.removeRole(producer(), makeup.id);
  throwsRule(() => W.addPlanRole(crew2(), DEV, "Grip"), /Only the show producer/);
  // A role can be held by anyone on the crew, the same person in more than one.
  const crew = ["DOF-P-CRW-001", "DOF-P-CRW-002", "DOF-P-CRW-003", "DOF-P-CRW-004"];
  W.planRolesOf(DEV).forEach((r, i) => W.setRolePerson(producer(), r.id, crew[i % crew.length]));
  assert.ok(!gate().missing.some((m) => m.startsWith("Role")), gate().missing.join("; "));
  // The devotion's guest is its host: no host role is asked for.
  assert.ok(!gate().missing.some((m) => /^Role.*host/i.test(m)));
  throwsRule(() => W.setRolePerson(producer(), roles[0].id, "DOF-P-VOL-001"), /crew/i);
  W.setRolePerson(producer(), roles[0].id, null);
  assert.ok(gate().missing.includes("Role: Director needs a person"));
  // A series keeps its required roles.
  const wowRole = getDb().projectRoles.find((r) => r.contentId === WOW && r.roleKey === REQUIRED_ROLES[0])!;
  assert.ok(wowRole, "the fixture's season has the role");
  getDb().projectRoles = getDb().projectRoles.filter((r) => r !== wowRole);
  assert.ok(W.evaluateGate("Pre-production", "project", WOW).missing.includes(`Role: ${roleLabel(REQUIRED_ROLES[0])}`));
  getDb().projectRoles.push(wowRole);
  ok();
});

await t("roles listed by hand when none were, and the plan's cards say where each section stands", () => {
  accepted();
  for (const r of W.planRolesOf(DEV)) W.removeRole(producer(), r.id);
  assert.ok(W.evaluateGate("Pre-production", "project", DEV).missing.includes("Roles: list the project's roles in the Recording Plan"));
  assert.match(
    html("crew4@dof.demo", <PlanSectionView project={project(DEV)} section="roles" write onOpenTool={() => {}} />),
    /List the usual roles/,
  );
  assert.equal(W.startPlanRoles(producer(), DEV).length, 6);
  assert.equal(W.startPlanRoles(producer(), DEV).length, 6, "listing them again adds none");
  splitThreeTwo();
  W.assignDevotion(producer(), W.devotionPlacements(DEV)[0].planned.id, null);
  assert.deepEqual(
    planCards(DEV).map((c) => [c.id, c.note]),
    [
      ["plan:roles", "0 of 6 have a person"],
      ["plan:devotions", "4 of 5 assigned · 1 needs a session"],
      ["plan:sessions", "2 sessions"],
      ["plan:callSheets", "2 of 2 made"],
    ],
  );
  const roles = html("crew4@dof.demo", <PlanSectionView project={project(DEV)} section="roles" write onOpenTool={() => {}} />);
  for (const text of ["+ Add role", 'aria-label="Name of the role Floor manager"', "Needs a person", "Rev. Mary Wanjiku, is its host"])
    assert.ok(roles.includes(text), text);
  const readOnly = html("crew2@dof.demo", <PlanSectionView project={project(DEV)} section="roles" write onOpenTool={() => {}} />);
  assert.ok(
    !readOnly.includes("+ Add role") && !readOnly.includes("Name of the role"),
    "someone who may not assign work sees the roles only",
  );
});

// ── 2 and 3. Devotions on sessions ───────────────────────────

await t("five devotions split three and two across two sessions; ticking one on the other moves it; unticked, it needs a session", () => {
  accepted();
  const { one, two, ids, titles } = splitThreeTwo();
  assert.deepEqual(onSession(one.id), titles.slice(0, 3));
  assert.deepEqual(onSession(two.id), titles.slice(3));
  assert.deepEqual(W.unassignedDevotions(DEV), []);
  assert.deepEqual(titles, ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5"], "each devotion by its topic, read from the script");
  W.assignDevotion(producer(), ids[0], two.id);
  assert.deepEqual(onSession(one.id), titles.slice(1, 3));
  assert.deepEqual(onSession(two.id), [titles[0], ...titles.slice(3)], "moved, never on two sessions");
  assert.equal(getDb().sessionLogEntries.filter((e) => e.plannedEpisodeId === ids[0]).length, 1);
  W.assignDevotion(producer(), ids[0], null);
  assert.deepEqual(
    W.unassignedDevotions(DEV).map((x) => x.title),
    ["Day 1"],
  );
  const gate = W.evaluateGate("Pre-production", "project", DEV);
  assert.ok(gate.warnings.includes("1 devotion is not assigned to a session yet"), "a note");
  assert.ok(!gate.missing.some((m) => /devotion|session/i.test(m)), "never a block of its own");
  const devotions = html("crew4@dof.demo", <PlanSectionView project={project(DEV)} section="devotions" write onOpenTool={() => {}} />);
  assert.match(devotions, /4 of 5 assigned/);
  assert.match(devotions, /Needs a session/);
  assert.match(devotions, /Psalm 120/);
  const sessions = html("crew4@dof.demo", <PlanSectionView project={project(DEV)} section="sessions" write onOpenTool={() => {}} />);
  assert.match(sessions, /Devotions on this session \(2 of 5\)/);
  assert.match(sessions, /Day 4<span class="muted"> · on Day 2<\/span>/, "a devotion on another session says which");
  assert.match(sessions, /\+ Add session/);
  ok();
});

await t("a devotion recorded, or on a session that has started, stays; removing a planned session frees its devotions", () => {
  accepted();
  const { one, two, ids } = splitThreeTwo();
  throwsRule(() => W.archiveSession(producer(), two.id, " "), /Write why/);
  W.archiveSession(producer(), two.id, "The studio is booked");
  assert.deepEqual(
    W.unassignedDevotions(DEV).map((x) => x.planned.id),
    ids.slice(3),
    "its devotions need a session again",
  );
  const three = W.createSession(producer(), DEV, { name: "Day 3", scheduledDate: "2026-11-04" });
  W.assignDevotion(producer(), ids[3], three.id);
  session(one.id).status = "Open";
  commit();
  throwsRule(() => W.assignDevotion(producer(), ids[0], three.id), /has started recording, so it stays there/);
  throwsRule(() => W.assignDevotion(producer(), ids[4], one.id), /has started recording/);
  throwsRule(() => W.archiveSession(producer(), one.id, "No"), /not started/);
  assert.ok(
    W.devotionPlacements(DEV)
      .filter((x) => x.sessionId === one.id)
      .every((x) => x.locked),
  );
  ok();
});

// ── 4. Call sheets and the run sheet ─────────────────────────

await t("a devotion session's call sheet is made once it has a date, and keeps to the session's date while it is a draft", () => {
  accepted();
  const s = W.createSession(producer(), DEV, { name: "Day 1" });
  assert.equal(session(s.id).callSheetId, null, "no date, no sheet yet");
  W.updateSession(producer(), s.id, { scheduledDate: "2026-11-02" });
  const sheet = () => getDb().callSheets.find((c) => c.id === session(s.id).callSheetId)!;
  assert.deepEqual([sheet().date, sheet().status, sheet().contentId], ["2026-11-02", "draft", DEV]);
  assert.ok(!sheet().notes.includes("Day"), "its devotions are read from the plan, not copied into it");
  W.updateSession(producer(), s.id, { scheduledDate: "2026-11-05" });
  assert.equal(sheet().date, "2026-11-05");
  sheet().status = "final";
  commit();
  W.updateSession(producer(), s.id, { scheduledDate: "2026-11-06" });
  assert.equal(sheet().date, "2026-11-05", "an issued sheet is left as it was");
  assert.equal(getDb().callSheets.filter((c) => c.contentId === DEV).length, 1, "one sheet per session");
  const dated = W.createSession(producer(), DEV, { scheduledDate: "2026-11-09" });
  assert.ok(session(dated.id).callSheetId, "a session made with a date has its sheet at once");
  // A series' session is as before: its call sheet is made from the session.
  const series = W.updateSession(hop(), `${WOW}-R02`, { name: "Day two" });
  assert.equal(series.callSheetId, null);
  ok();
});

await t("the run sheet gains a recording row for each devotion ticked, until it is changed by hand; rebuilt on request", () => {
  accepted();
  const s = W.createSession(producer(), DEV, { name: "Day 1", scheduledDate: "2026-11-02" });
  const titles = () => session(s.id).runSheet.map((i) => i.title);
  assert.ok(!titles().some((x) => x.startsWith("Record:")), "no devotions yet, no recording rows");
  assert.deepEqual(titles(), ["Crew call, load-in", "Setup", "Technical check", "Talent arrival, mic-up, start routine", "Wrap"]);
  const ids = W.devotionPlacements(DEV).map((x) => x.planned.id);
  W.assignDevotion(producer(), ids[0], s.id);
  W.assignDevotion(producer(), ids[1], s.id);
  assert.deepEqual(
    titles().filter((x) => x.startsWith("Record:")),
    ["Record: Day 1", "Record: Day 2"],
  );
  assert.deepEqual(W.sheetTimes(session(s.id).runSheet), {
    crewCall: "07:00",
    talentArrival: "09:00",
    startRecording: "09:10",
    wrap: session(s.id).runSheet.find((i) => i.title === "Wrap")!.time,
  });
  W.updateRunSheetItem(producer(), s.id, session(s.id).runSheet[0].id, { notes: "Bring the slate" });
  W.assignDevotion(producer(), ids[2], s.id);
  assert.equal(titles().filter((x) => x.startsWith("Record:")).length, 2, "changed by hand: left as it is");
  W.resetRunSheet(producer(), s.id);
  assert.deepEqual(
    titles().filter((x) => x.startsWith("Record:")),
    ["Record: Day 1", "Record: Day 2", "Record: Day 3"],
  );
  W.addRunSheetItem(producer(), s.id, { time: "17:30", title: "Team photo", durationMin: 10, ownerPersonId: "DOF-P-CRW-003", notes: "" });
  assert.equal(session(s.id).runSheet.at(-1)!.ownerPersonId, "DOF-P-CRW-003", "each row says who");
  assert.deepEqual(W.sheetTimes([]), { crewCall: null, talentArrival: null, startRecording: null, wrap: null });
  ok();
});

await t("each session's call sheet chooses one of the project's storyboards and shot lists, shown read only", () => {
  accepted();
  const { one } = splitThreeTwo();
  const board = D.createStoryboard(producer(), DEV, { name: "The set", episodeId: null });
  D.addFrame(producer(), board.id, { description: "Wide of the set" });
  const list = D.createShotList(producer(), DEV, { name: "Day 1 shots" });
  const shot = D.addShotRow(producer(), list.id, "shot", { description: "Guest, eye level" });
  D.updateShotRow(producer(), shot.id, { shotSize: "Medium", movement: "Static" });
  const other = D.createStoryboard(hop(), WOW, { name: "Not this one", episodeId: null });
  W.setSessionBoards(producer(), one.id, { storyboardId: board.id, shotListId: list.id });
  assert.deepEqual([session(one.id).storyboardId, session(one.id).shotListId], [board.id, list.id]);
  throwsRule(() => W.setSessionBoards(producer(), one.id, { storyboardId: other.id }), /this project's storyboards/);
  ok();
  session(one.id).storyboardId = other.id;
  assert.match(integrityProblems(getDb()).join(" "), /storyboard/i);
  session(one.id).storyboardId = board.id;
  const sheets = html("crew4@dof.demo", <PlanSectionView project={project(DEV)} section="callSheets" write onOpenTool={() => {}} />);
  for (const text of [
    'role="tab"',
    "Day 1 · Morning",
    "Print call sheet",
    "Print run sheet only",
    "Crew call",
    "Talent call",
    "From the run sheet: 09:00",
    "From the run sheet: 09:10",
    'aria-label="Sections of the call sheet"',
    "Technical Check",
    "Rehearsal",
    "Logistics",
    "Devotions, in order",
    "Run sheet",
    "Rebuild from episodes",
    "+ Row",
    "Wide of the set",
    "Guest, eye level",
    "Open the Shot List",
  ])
    assert.ok(sheets.includes(text), text);
  assert.ok(!sheets.includes("Episodes on this sheet"), "the plan lists the session's devotions itself");
});

// ── Contacts, privacy and printing ───────────────────────────

await t("anyone who can see the project can print; phones show only where the privacy rules allow", () => {
  accepted();
  const { one } = splitThreeTwo();
  W.planRolesOf(DEV).forEach((r) => W.setRolePerson(producer(), r.id, "DOF-P-CRW-001"));
  const crewView = html("crew4@dof.demo", <PlanSectionView project={project(DEV)} section="callSheets" write onOpenTool={() => {}} />);
  assert.match(crewView, /\+254 700 000 000/, "crew see crew phones");
  assert.match(crewView, /\+254 711 111 111/, "and the guest's contact");
  getDb().members.push({ personId: "DOF-P-PTR-001", projectContentId: DEV, roleOnProject: "Partner reviewer", canComment: true });
  const partner = html(
    "partner1@dof.demo",
    <PlanSectionView project={project(DEV)} section="callSheets" write={false} onOpenTool={() => {}} />,
  );
  assert.ok(!partner.includes("+254"), "a partner sees no one's phone");
  assert.match(partner, /Private/);
  assert.match(partner, /Print call sheet/, "but may print");
  assert.ok(!partner.includes("Rebuild from episodes") && !partner.includes("+ Row"));
  // The printed call sheet: one page headed with the project, the session's name, label and date.
  const printed = html("crew4@dof.demo", <PrintedCallSheet job={{ sessionId: one.id, only: "all" }} />);
  for (const text of [
    project(DEV).title,
    "Day 1",
    "Morning",
    "Nov 2, 2026",
    "07:00–13:00",
    "Call sheet",
    "Studio A",
    "Crew call",
    "<h2>Crew</h2>",
    "Floor manager",
    "Devotions, in order",
    "Record: Day 1",
  ])
    assert.ok(printed.includes(text), text);
  const runOnly = html("crew4@dof.demo", <PrintedCallSheet job={{ sessionId: one.id, only: "run" }} />);
  assert.match(runOnly, /Run sheet/);
  assert.match(runOnly, /Record: Day 3/);
  assert.ok(!runOnly.includes("<h2>Crew</h2>") && !runOnly.includes("Studio A"), "the run sheet alone");
});

// ── Storage ──────────────────────────────────────────────────

await t("the footage drive is planned, each session's footage entered once recording starts, and each episode's edit assets", () => {
  accepted();
  const a = S.createDrive(hop(), { name: "Footage A", capacityGB: 1000, otherUsedGB: 0, notes: "" });
  const b = S.createDrive(hop(), { name: "Footage B", capacityGB: 1000, otherUsedGB: 0, notes: "" });
  P.setPersonGrant(hop(), PRODUCER, "storage.use", false);
  throwsRule(() => W.setProjectDrive(producer(), DEV, a.id), /may use storage/);
  P.setPersonGrant(hop(), PRODUCER, "storage.use", null);
  W.setProjectDrive(producer(), DEV, a.id);
  assert.equal(project(DEV).workflow.storageDriveId, a.id);
  const { one } = splitThreeTwo();
  throwsRule(() => W.setSessionFootage(producer(), one.id, 100), /once recording has started/);
  session(one.id).status = "Open";
  commit();
  const footage = W.setSessionFootage(producer(), one.id, 100);
  assert.deepEqual([footage.driveId, footage.kind, footage.sessionId, footage.contentId, footage.sizeGB], [a.id, "raw", one.id, DEV, 100]);
  W.setSessionFootage(producer(), one.id, 150);
  assert.equal(getDb().allocations.filter((x) => x.sessionId === one.id).length, 1, "the same entry, changed");
  assert.equal(W.footageOf(one.id)!.sizeGB, 150);
  throwsRule(() => W.setSessionFootage(producer(), one.id, 5000), /only .* free/);
  throwsRule(() => W.setSessionFootage(producer(), one.id, 0), /more than zero/);
  W.setSessionDrive(producer(), one.id, b.id);
  assert.equal(W.footageOf(one.id)!.driveId, b.id, "the footage moves with the session's drive");
  const tile = html("crew4@dof.demo", <SessionStorage project={project(DEV)} write />);
  assert.match(tile, /Footage size for Day 1, in GB/);
  assert.match(tile, /After recording/, "a planned session's size waits for recording");
  // The edit's assets, on an episode in post production.
  const ep = `${WOW}-E01`;
  throwsRule(() => W.setEpisodeAssets(hop(), ep, { sizeGB: 40 }), /Choose the drive/);
  W.setProjectDrive(hop(), WOW, a.id);
  const assets = W.setEpisodeAssets(hop(), ep, { sizeGB: 40 });
  assert.deepEqual([assets.driveId, assets.kind, assets.label, assets.contentId], [a.id, "project", "Edit assets", ep]);
  W.setEpisodeAssets(hop(), ep, { sizeGB: 55 });
  W.setEpisodeAssets(hop(), ep, { driveId: b.id });
  assert.deepEqual([W.assetsOf(ep)!.sizeGB, W.assetsOf(ep)!.driveId], [55, b.id]);
  // A drive with nothing on it can go; plans that chose it are left with none.
  const c = S.createDrive(hop(), { name: "Spare", capacityGB: 500, otherUsedGB: 0, notes: "" });
  W.setProjectDrive(hop(), DEV, c.id);
  S.deleteDrive(hop(), c.id);
  assert.equal(project(DEV).workflow.storageDriveId, null);
  ok();
});

// ── The calendar ─────────────────────────────────────────────

await t("the calendar shows sessions as before: a session's name, label and hours change nothing there", () => {
  const items = () => JSON.stringify(allWorkItems().map(({ project: _p, ...rest }) => rest));
  const before = items();
  W.updateSession(hop(), `${WOW}-R02`, { name: "Day two", label: "Evening", startTime: "18:00", endTime: "22:00" });
  assert.equal(items(), before);
});

console.log(`\n${passed} passed`);
