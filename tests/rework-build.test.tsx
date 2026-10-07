// Run with: npm test -- rework-build
// The rework's remaining parts, built together (build prompt v2): the Recording Plan for series and documentaries; Live
// Shows and DOF Music on the five stages (data version 22) with the live gate; the recurring-show additions (daily
// repeat, the next 8 dates, this and future, cancelling a date, a day's label, the live run-of-show columns); lending
// and role kits on screen, General Use moved to Lending; storyboard and shot list templates in Documents; the Calendar
// (a recurring show on its dates, a multi-day event as one bar with each day's details, loans and reminders), with the
// urgency report, the bell and Reminders inside it; and the review fixes (legacy approvals, the card that opens).
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor, Database } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { buildSeed } from "../src/data/seed";
import { integrityProblems } from "../src/data/constraints";
import { FIVE_STAGE_MAP, generalUseToLoans, upgradeToV22 } from "../src/data/migrate";
import { categoryOf } from "../src/config/categories";
import { catalogFor, planLabels } from "../src/config/documentCatalog";
import { login } from "../src/services/auth";
import * as C from "../src/services/wrapped/content";
import * as CS from "../src/services/wrapped/callsheets";
import * as D from "../src/services/wrapped/documents";
import * as K from "../src/services/wrapped/kits";
import * as L from "../src/services/wrapped/lending";
import * as P from "../src/services/wrapped/production";
import * as W from "../src/services/wrapped/workflow";
import * as A from "../src/services/wrapped/alerts";
import { setFeature } from "../src/services/wrapped/settings";
import { canAdvance } from "../src/services/content";
import { daysOfEvent as daysOfShow, horizonEnd, sheetOfDay } from "../src/services/production";
import { describeRule, occurrences, weeklyFrom } from "../src/services/recurrence";
import { calendarEvents } from "../src/services/calendarView";
import { kitSuggestions } from "../src/services/kits";
import { instancesOf } from "../src/services/productionInstances";
import { AppProvider } from "../src/ui/AppContext";
import { CalendarPage } from "../src/pages/Calendar";
import { Equipment } from "../src/pages/Equipment";
import { Documents } from "../src/pages/Documents";
import { LoanReceipt } from "../src/pages/Lending";
import { PlanSectionView } from "../src/pages/documents/RecordingPlan";
import { ReviewDueTag } from "../src/ui/ReviewCheck";
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
const crew = (n: number): Actor => login(`crew${n}@dof.demo`, "demo");
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
const project = (id: string) => getDb().records.find((r) => r.contentId === id) as Project;
const FIVE = ["Development", "Pre-production", "Production", "Post production", "Marketing and distribution"];

// ── The Recording Plan for every kind ─────────────────────────

await t("series and documentaries plan in the Recording Plan: roles, their items, sessions and call sheets, in their own words", () => {
  for (const ft of ["podcast", "documentary_dof"] as const)
    assert.ok(catalogFor(ft, "Pre-production").some((e) => e.key === "recording_plan" && e.plan));
  assert.deepEqual(
    [planLabels("podcast").title, planLabels("documentary_dof").title, planLabels("devotion").title],
    ["Episodes", "Parts", "Devotions"],
  );
  const items = html(hop(), <PlanSectionView project={project(WOW)} section="devotions" write onOpenTool={() => {}} />);
  assert.ok(items.includes("Episodes") && items.includes("Read from the Planned Episodes in Development"));
  assert.ok(!items.includes("Devotional Script"));
  const sessions = html(hop(), <PlanSectionView project={project(WOW)} section="sessions" write onOpenTool={() => {}} />);
  assert.ok(sessions.includes("Tick the episodes each session records"));
});

// ── Live Shows and DOF Music on the five stages ───────────────

await t("Live Shows and DOF Music run on the five stages, with their checklists in configuration", () => {
  for (const k of ["live", "music"] as const)
    assert.deepEqual(
      categoryOf(k).stages.map((s) => s.name),
      FIVE,
    );
  assert.equal(categoryOf("live").footageStage, "Production");
  assert.ok(categoryOf("live").stages[1].tasks!.includes("Camera, audio and stream checks passed"), "technical prep and rehearsal");
  assert.ok(categoryOf("music").stages[3].tasks!.includes("Mastering"), "audio post, video edit and review in Post production");
});

await t(
  "version 22 moves each live and music record's stage, checks, deadlines, owners, checklists and documents, and runs twice the same",
  () => {
    const db = buildSeed() as Database;
    // As saved before: the earlier stage names.
    const day = db.records.find((r) => r.contentId === "DOF-LIVE-002-D1")!;
    Object.assign(day, {
      pipelineStage: "Build",
      stageOutputs: { Prep: true, Build: false, Rehearse: false },
      stageDeadlines: { Prep: "2026-10-01", Build: "2026-10-03", Rehearse: "2026-10-04", Show: "2026-10-05" },
      stageAssignees: { Prep: [{ personId: "DOF-P-CRW-001", roles: ["Lead"] }], Build: [{ personId: "DOF-P-CRW-001", roles: ["Rigger"] }] },
    });
    day.tasks = [
      { id: "T-1", stage: "Wrap", label: "Coil cables", done: false, dueDate: null, assigneePersonId: null, doneAt: null, doneBy: null },
    ];
    db.docs.push({
      ...db.docs.find((d) => d.contentId === "DOF-LIVE-001-D1")!,
      id: "DOC-X",
      contentId: "DOF-LIVE-002-D1",
      stage: "Rehearse",
    });
    db.settings.effortOverrides = { "live:Build": 3, "live:Prep": 1, "series:Editorial": 4 };
    db.schemaVersion = 21;
    const up = upgradeToV22(structuredClone(db));
    const d = up.records.find((r) => r.contentId === "DOF-LIVE-002-D1")!;
    assert.equal(d.pipelineStage, "Pre-production");
    assert.deepEqual(d.stageOutputs, { "Pre-production": false }, "merged: confirmed only if every earlier stage in it was");
    assert.deepEqual(
      d.stageDeadlines,
      { "Pre-production": "2026-10-04", Production: "2026-10-05" },
      "the latest deadline of the merged stages",
    );
    assert.deepEqual(d.stageAssignees, { "Pre-production": [{ personId: "DOF-P-CRW-001", roles: ["Lead", "Rigger"] }] });
    assert.equal(d.tasks[0].stage, "Production");
    assert.equal(up.docs.find((x) => x.id === "DOC-X")!.stage, "Pre-production");
    assert.deepEqual(up.settings.effortOverrides, { "live:Pre-production": 3, "series:Editorial": 4 });
    assert.equal(up.schemaVersion, 22);
    assert.ok(up.records.filter((r) => r.category === "music" && r.pipelineStage).every((r) => FIVE.includes(r.pipelineStage!)));
    assert.equal(JSON.stringify(upgradeToV22(structuredClone(up))), JSON.stringify(up), "running it again changes nothing");
    assert.equal(FIVE_STAGE_MAP.live.Show, "Production");
  },
);

await t("a live show leaves Development once its date is set and its producer named", () => {
  const show = C.createRecord(hop(), { category: "live", title: "Rally" });
  const id = `${show.contentId}-D1`;
  const day = () => getDb().records.find((r) => r.contentId === id)!;
  C.setStageOutput(hop(), id, true, day().version);
  day().scheduledDate = null;
  day().assigneePersonId = null;
  commit();
  assert.match(canAdvance(day()).reason, /set the show date and name the producer/);
  day().scheduledDate = "2026-10-10";
  commit();
  assert.match(canAdvance(day()).reason, /name the producer/);
  C.addStageOwner(hop(), id, "Development", "DOF-P-CRW-004", ["Producer"]);
  assert.equal(canAdvance(day()).ok, true);
  C.advanceStage(hop(), id, day().version);
  assert.equal(day().pipelineStage, "Pre-production");
});

// ── Recurring shows ──────────────────────────────────────────

await t("a show can repeat daily, or every few days", () => {
  const rule = { ...weeklyFrom("2026-10-01"), freq: "daily" as const, weekdays: [], interval: 2, count: 4 };
  assert.deepEqual(occurrences(rule, "2026-12-31"), ["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-07"]);
  assert.equal(describeRule({ ...rule, interval: 1, count: null }), "Every day, from 2026-10-01");
});

await t("a recurring show makes its next 8 dates; the number can change", () => {
  const show = P.createProduction(hop(), { title: "Vespers", mode: "recurring", rule: weeklyFrom("2026-10-02"), callTime: "16:00" });
  const tpl = getDb().showTemplates.find((x) => x.contentId === show.contentId)!;
  assert.equal(tpl.horizonCount, 8);
  assert.equal(daysOfShow(show.contentId).length, 8);
  assert.equal(horizonEnd(tpl, "2026-09-26"), "2026-11-20");
  P.updateShowTemplate(hop(), tpl.id, { horizonCount: 10 });
  assert.equal(daysOfShow(show.contentId).length, 10);
  throwsRule(() => P.updateShowTemplate(hop(), tpl.id, { horizonCount: 0 }), /next 1 to 52/);
});

await t("this and future: a day's call sheet becomes the template from that day on; earlier days keep theirs", () => {
  const show = P.createProduction(hop(), { title: "Vespers", mode: "recurring", rule: weeklyFrom("2026-10-02"), callTime: "16:00" });
  const days = daysOfShow(show.contentId);
  const third = days[2];
  const dayOf = (id: string) => getDb().recordingSessions.find((s) => s.id === id)!;
  CS.updateCallSheet(hop(), sheetOfDay(third)!.id, { location: "Central Church" });
  assert.equal(dayOf(third.id).instance!.locked, true);
  P.applyDayToFuture(hop(), third.id);
  const loc = (i: number) => sheetOfDay(daysOfShow(show.contentId)[i])!.location;
  assert.deepEqual([loc(0), loc(1), loc(2), loc(3), loc(7)], ["", "", "Central Church", "Central Church", "Central Church"]);
  assert.equal(dayOf(third.id).instance!.locked, false, "it follows the template again");
  assert.equal(getDb().showTemplates.find((x) => x.contentId === show.contentId)!.sheet.location, "Central Church");
});

await t("one date is cancelled (kept, archived, left out of the schedule) and a day has a label", () => {
  const show = P.createProduction(hop(), { title: "Vespers", mode: "recurring", rule: weeklyFrom("2026-10-02") });
  const second = daysOfShow(show.contentId)[1];
  P.setDayLabel(hop(), second.id, "Evening");
  assert.match(instancesOf(show.contentId).find((i) => i.id === second.id)!.label, /Evening/);
  throwsRule(() => P.cancelDay(hop(), second.id, " "), /Say why/);
  P.cancelDay(hop(), second.id, "Venue closed");
  const rec = getDb().recordingSessions.find((s) => s.id === second.id)!;
  assert.deepEqual([!!rec.archivedAt, rec.archivedReason], [true, "Cancelled: Venue closed"]);
  assert.ok(
    getDb()
      .showTemplates.find((x) => x.contentId === show.contentId)!
      .rule.skipDates.includes(rec.instance!.occurrence),
  );
  assert.equal(instancesOf(show.contentId).find((i) => i.id === second.id)?.status, "cancelled");
  throwsRule(() => P.cancelDay(crew(3), daysOfShow(show.contentId)[2].id, "No"), /./);
});

await t("a live run of show has camera, audio, graphics, status and actual times; bad values are refused", () => {
  const show = P.createProduction(hop(), { title: "Rally", mode: "one_time", date: "2026-10-20" });
  const cs = sheetOfDay(daysOfShow(show.contentId)[0])!;
  const row = { id: "RS-aaaaaaaa", time: "18:00", title: "Worship", durationMin: 20, ownerPersonId: null, notes: "" };
  CS.updateCallSheet(hop(), cs.id, {
    runOfShow: [
      { ...row, camera: "Cam 2 wide", audio: "Band mix", graphics: "Lyrics", status: "Live", actualStart: "18:03", actualEnd: "" },
    ],
  });
  const saved = getDb().callSheets.find((c) => c.id === cs.id)!.runOfShow[0];
  assert.deepEqual([saved.camera, saved.status, saved.actualStart], ["Cam 2 wide", "Live", "18:03"]);
  throwsRule(() => CS.updateCallSheet(hop(), cs.id, { runOfShow: [{ ...row, actualStart: "6pm" }] }), /hours and minutes/);
  throwsRule(() => CS.updateCallSheet(hop(), cs.id, { runOfShow: [{ ...row, status: "Maybe" as never }] }), /planned, live, done or cut/);
});

// ── Lending, role kits, General Use ──────────────────────────

await t("General Use moves to Lending: one with gear lists becomes a loan holding the same items, the rest are archived", () => {
  const db = buildWorkflowFixture() as Database;
  const at = "2026-09-20T08:00:00.000Z";
  const base = db.records.find((r) => r.contentId === WOW)!;
  db.records.push(
    {
      ...structuredClone(base),
      contentId: "DOF-GEN-001",
      title: "Church picnic",
      category: "general",
      workflow: undefined,
      episode: undefined,
      parentId: null,
      hierarchyLevel: 0,
      archived: false,
      closedReason: null,
    } as never,
    {
      ...structuredClone(base),
      contentId: "DOF-GEN-002",
      title: "Spare",
      category: "general",
      workflow: undefined,
      episode: undefined,
      parentId: null,
      hierarchyLevel: 0,
      archived: false,
      closedReason: null,
    } as never,
  );
  db.manifests.push({
    id: "DOF-MF-900",
    contentId: "DOF-GEN-001",
    callSheetId: null,
    destination: "outside",
    status: "checked-out",
    date: "2026-09-25",
    expectedReturn: "2026-09-30",
    responsiblePersonId: "DOF-P-CRW-002",
    lines: [
      {
        equipmentId: "DOF-EQ-AUD-002",
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
    createdAt: at,
    createdBy: "DOF-P-CRW-002",
    checkedOutAt: at,
    returnedAt: null,
  });
  generalUseToLoans(db);
  const loan = db.loans.find((l) => l.fromContentId === "DOF-GEN-001")!;
  assert.deepEqual(
    [loan.status, loan.borrowerName, loan.dateOut, loan.expectedReturn, loan.lines[0].equipmentId],
    ["out", "Church picnic", "2026-09-25", "2026-09-30", "DOF-EQ-AUD-002"],
  );
  assert.match(db.records.find((r) => r.contentId === "DOF-GEN-001")!.closedReason!, new RegExp(`Moved to Lending as ${loan.id}`));
  assert.equal(db.manifests.find((m) => m.id === "DOF-MF-900")!.status, "released", "the list stays, released: the loan holds its items");
  assert.match(db.records.find((r) => r.contentId === "DOF-GEN-002")!.closedReason!, /nothing was lent/);
  const once = JSON.stringify(db.loans);
  generalUseToLoans(db);
  assert.equal(JSON.stringify(db.loans), once, "running it again changes nothing");
});

await t("Equipment shows Lending and Role kits; a loan prints a receipt with signature lines", () => {
  const loan = L.createLoan(hop(), {
    borrowerName: "Pastor Otieno",
    organisation: "Kibera SDA",
    dateOut: "2026-09-26",
    expectedReturn: "2026-09-28",
    lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }],
  });
  const page = html(hop(), <Equipment tab="lending" />);
  for (const text of ["Lending", "Role kits", "New loan", loan.id, "Pastor Otieno", "Check in…", "Print receipt"])
    assert.ok(page.includes(text), text);
  const receipt = html(hop(), <LoanReceipt loan={loan} />);
  assert.ok(receipt.includes("Borrower's signature") && receipt.includes("Kibera SDA") && receipt.includes("DOF-EQ-AUD-002"));
  setFeature(hop(), "lending", false);
  assert.ok(!html(hop(), <Equipment />).includes(">Lending<"), "switched off, the tabs go");
});

await t("a role kit is offered on a call sheet for the matching role, item by item, with what is not free marked", () => {
  K.createKit(hop(), { role: "Camera operator", keywords: ["camera"], items: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }] });
  const show = P.createProduction(hop(), { title: "Rally", mode: "one_time", date: "2026-10-20" });
  const cs = sheetOfDay(daysOfShow(show.contentId)[0])!;
  CS.updateCallSheet(hop(), cs.id, { crewPersonIds: ["DOF-P-CRW-002"], crewRoles: { "DOF-P-CRW-002": "Camera 1" } });
  const s = kitSuggestions(getDb().callSheets.find((c) => c.id === cs.id)!);
  assert.equal(s[0].kit.role, "Camera operator");
  assert.equal(s[0].items[0].item.id, "DOF-EQ-CAM-001");
  assert.ok(html(hop(), <Equipment tab="kits" />).includes("Camera operator"));
});

// ── Templates ────────────────────────────────────────────────

await t("Documents has Templates: boards with no Content ID, saved from a project and used by one", () => {
  const b = D.createStoryboard(hop(), WOW, { name: "Opening" });
  D.addFrame(hop(), b.id, { description: "Wide" });
  const tpl = D.saveStoryboardAsTemplate(hop(), b.id, "Standard opening");
  assert.deepEqual([tpl.contentId, tpl.isTemplate], [null, true]);
  const page = html(hop(), <Documents />);
  assert.ok(page.includes("Templates"));
  const copy = D.createStoryboard(hop(), WOW, { name: "From the template", copyFrom: tpl.id });
  D.updateFrame(hop(), D.framesOf(copy.id)[0].id, { description: "Changed in the copy" });
  assert.equal(D.framesOf(tpl.id)[0].description, "Wide", "editing the copy never changes the template");
});

// ── The Calendar ─────────────────────────────────────────────

await t("a recurring show sits on each of its dates, never a bar; a multi-day event is one bar with its days", () => {
  const vespers = P.createProduction(hop(), {
    title: "Vespers",
    mode: "recurring",
    rule: { ...weeklyFrom("2026-10-02"), until: "2027-03-26" },
  });
  const camp = P.createProduction(hop(), { title: "Camp", mode: "multi_day", startDate: "2026-10-12", endDate: "2026-10-16" });
  const ev = calendarEvents(hop(), "2026-10-01", "2026-10-31");
  const mine = (id: string) => ev.filter((e) => e.id.includes(id));
  const v = mine(vespers.contentId).filter((e) => e.subtype === "session");
  assert.ok(v.length >= 4 && v.every((e) => e.date === e.endDate), "a mark on each Friday, nothing stacked");
  assert.ok(
    v.every((e) => new Date(`${e.date}T12:00:00Z`).getUTCDay() === 5),
    "Fridays only",
  );
  const bars = mine(camp.contentId).filter((e) => e.subtype === "window");
  assert.equal(bars.length, 1);
  assert.deepEqual([bars[0].date, bars[0].endDate, bars[0].days!.length], ["2026-10-12", "2026-10-16", 5]);
  assert.equal(mine(camp.contentId).filter((e) => e.subtype !== "window").length, 0, "its days add nothing of their own");
});

await t("the calendar shows loans due back and one's own reminders; the page has its views", () => {
  L.createLoan(hop(), {
    borrowerName: "Youth group",
    dateOut: "2026-09-26",
    expectedReturn: "2026-09-29",
    lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }],
  });
  A.createReminder(hop(), { title: "Book the venue", date: "2026-09-30", offsetMinutes: 0, channels: ["app"] });
  const ev = calendarEvents(hop(), "2026-09-26", "2026-10-03");
  assert.ok(ev.some((e) => e.subtype === "loan" && e.title === "Back: Youth group" && e.date === "2026-09-29"));
  assert.ok(ev.some((e) => e.subtype === "reminder" && e.title === "Book the venue"));
  assert.ok(
    !calendarEvents(crew(3), "2026-09-26", "2026-10-03").some((e) => e.subtype === "reminder"),
    "someone else's reminder is theirs",
  );
  const page = html(hop(), <CalendarPage />);
  for (const text of ["Month", "Agenda", "Reminders", "Urgency"]) assert.ok(page.includes(text), text);
});

// ── The review ───────────────────────────────────────────────

await t("an approval from before the review documents counts; naming reviewers after it asks for a new review, said so", () => {
  // Passed by hand while the review was a gate: recognised.
  const form = getDb().developmentForms.find((f) => f.contentId === "DOF-DOC-001")!;
  form.overrides = [{ key: "review", note: "Pastor approved by phone", byPersonId: "DOF-P-HOP-001", at: "2026-09-01T08:00:00.000Z" }];
  commit();
  const t1 = D.theologyStatus("DOF-DOC-001");
  assert.equal(t1.done, true);
  assert.match(t1.detail, /Passed by hand on .*Pastor approved by phone/);
  // A new review asked for: flagged as new.
  const doc = D.ensureDocument(hop(), "DOF-DOC-001", "Development", "documentary_brief");
  D.setDocumentReviewers(hop(), doc.id, ["DOF-P-CRW-002"]);
  const t2 = D.theologyStatus("DOF-DOC-001");
  assert.deepEqual([t2.done, t2.newRequest], [false, true]);
  assert.match(t2.detail, /New review asked for \(earlier: passed by hand/);
  assert.ok(html(hop(), <ReviewDueTag contentId="DOF-DOC-001" />).includes("New theological review requested"));
  ok();
});

await t("the project card's review tag is a button that opens what needs attention", () => {
  const doc = D.ensureDocument(hop(), WOW, "Development", "show_brief");
  D.setDocumentReviewers(hop(), doc.id, ["DOF-P-CRW-002"]);
  const tag = html(hop(), <ReviewDueTag contentId={WOW} />);
  assert.match(tag, /<button[^>]*aria-label="New theological review requested: see what needs attention"/);
});

void W;
console.log(`\n${passed} passed`);
