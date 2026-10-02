// Run with: npm test -- documents
// Phase 1 of the documents rework: the data, the services and the move of the old Development forms into documents.
// The cleaner that every page body passes through; pages, links, reviews and comments; storyboards and shot lists
// (and starting one from an existing one); a devotion's script becoming its list of episodes, each given its Content
// ID in Pre-production and recorded under it; and the move: every old field written or kept, none lost, safe to run
// twice, and undone exactly.
import assert from "node:assert/strict";
import type { Actor, Database, FormType } from "../src/types";
import { ConflictError, RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildSeed } from "../src/data/seed";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { migrateDocuments, undoDocumentMove } from "../src/data/migrateDocuments";
import { moveToNewSystem } from "../src/data/moveToNewSystem";
import { DEV_FORMS } from "../src/config/devForms";
import { catalogFor } from "../src/config/documentCatalog";
import { cleanHtml, textOf } from "../src/services/html";
import { ensureChecklist } from "../src/services/workflow/common";
import { initDatabase, snapshotFor } from "../server/state";
import { memoryStore } from "../server/stores";
import { login } from "../src/services/auth";
import * as W from "../src/services/wrapped/workflow";
import * as D from "../src/services/wrapped/documents";
import * as CS from "../src/services/wrapped/callsheets";
import * as EQ from "../src/services/wrapped/equipment";
import { completeForm, fillSection, prepareSession, tickAll, PRODUCER } from "./support/wow-walkthrough";

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
const vol = (): Actor => login("volunteer1@dof.demo", "demo");
const WOW = "DOF-SER-001-S1";
const AT = "2026-09-26T06:00:00.000Z";
const modules: Record<string, Record<string, unknown>> = { workflow: W, documents: D, callsheets: CS, equipment: EQ };
const call = async (name: string, ...args: unknown[]) => {
  const [m, n] = name.split(".");
  return (modules[m][n] as (...a: unknown[]) => unknown)(hop(), ...args) as Promise<never>;
};
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e) => (e instanceof RuleError && (!match || match.test(e.message))) || assert.fail((e as Error).message));
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");
const pages = (docId: string) => D.pagesOf(docId);

// ── The cleaner ──────────────────────────────────────────────

await t("every page body is cleaned to the editor's allow-list, in the server as in the browser", () => {
  const dirty =
    '<h1 class="x" onclick="bad()">Title</h1><p style="color: #c4572c; position: fixed; font-weight: 700">Hi <script>alert(1)</script>' +
    '<a href="javascript:alert(1)">no</a> <a href="https://drive.google.com/x" target="_blank">yes</a></p><img src=x onerror=alert(1)>' +
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>Done</p></div></li></ul>' +
    '<input type="text" value="x"><table><tr><td>cell</td></tr></table><h4>Small heading</h4><mark data-color="#ff0" style="background-color: #ffff00">hi</mark>';
  const clean = cleanHtml(dirty);
  for (const bad of ["onclick", "class=", "<script", "javascript:", "<img", "position", 'type="text"', "<table", "<h4", "target="])
    assert.ok(!clean.includes(bad), `removed: ${bad}`);
  for (const good of [
    "<h1>Title</h1>",
    "color: #c4572c",
    "font-weight: 700",
    'href="https://drive.google.com/x"',
    'data-type="taskItem"',
    'data-checked="true"',
    'type="checkbox"',
    "cell",
    "Small heading",
    "background-color: #ffff00",
  ])
    assert.ok(clean.includes(good), `kept: ${good}`);
  assert.equal(cleanHtml(clean), clean, "cleaning twice changes nothing");
  assert.equal(textOf("<p>Grace &amp; <strong>truth</strong></p><p>Line</p>"), "Grace & truth Line");
});

// ── Documents and pages ──────────────────────────────────────

await t("a document is made from the catalogue the first time it is opened, once, by someone who may write", () => {
  throwsRule(() => D.ensureDocument(vol(), WOW, "Development", "show_brief"), /Project not found|view-only/);
  const brief = D.ensureDocument(producer(), WOW, "Development", "show_brief");
  assert.equal(brief.id, `${WOW}|Development|show_brief`);
  assert.deepEqual(
    pages(brief.id).map((p) => p.title),
    ["The idea", "Scripture and source basis", "Shape", "Ask"],
  );
  assert.equal(D.ensureDocument(hop(), WOW, "Development", "show_brief").id, brief.id);
  assert.equal(getDb().projectDocuments.length, 1, "made once");
  throwsRule(() => D.ensureDocument(hop(), WOW, "Development", "devotional_script"), /no such document/);
  throwsRule(() => D.ensureDocument(hop(), WOW, "Production", "recording_day_sheet"), /recording sessions/);
  const sheet = D.ensureDocument(hop(), WOW, "Production", "recording_day_sheet", `${WOW}-R01`);
  assert.equal(sheet.id, `${WOW}|Production|recording_day_sheet|${WOW}-R01`, "one for each session");
  ok();
});

await t("a page saves as it is typed: cleaned, versioned, and a save from an older version is refused, not lost", () => {
  const brief = D.ensureDocument(hop(), WOW, "Development", "show_brief");
  const idea = pages(brief.id)[0];
  const saved = D.savePage(producer(), idea.id, { bodyHtml: "<p><strong>Bold</strong><script>x</script></p>", subtitle: "John 1:1" }, 1);
  assert.deepEqual(
    [saved.version, saved.bodyHtml, saved.subtitle, saved.updatedBy],
    [2, "<p><strong>Bold</strong></p>", "John 1:1", "DOF-P-CRW-004"],
  );
  assert.throws(() => D.savePage(hop(), idea.id, { bodyHtml: "<p>Mine</p>" }, 1), ConflictError);
  assert.equal(pages(brief.id)[0].bodyHtml, "<p><strong>Bold</strong></p>", "the other writer's words stay");
  throwsRule(() => D.savePage(hop(), idea.id, { bodyHtml: `<p>${"x".repeat(D.MAX_PAGE_HTML)}</p>` }, 2), /too long/);
  const extra = D.addPage(hop(), brief.id, { title: "Questions", afterPageId: idea.id });
  assert.deepEqual(
    pages(brief.id).map((p) => p.title),
    ["The idea", "Questions", "Scripture and source basis", "Shape", "Ask"],
  );
  D.movePage(hop(), extra.id, 4);
  assert.equal(pages(brief.id)[4].title, "Questions");
  D.archivePage(hop(), extra.id);
  assert.equal(pages(brief.id).length, 4, "deleted from view");
  assert.ok(
    getDb().documentPages.some((p) => p.id === extra.id && p.archivedAt),
    "but kept, archived",
  );
  D.restorePage(hop(), extra.id);
  assert.equal(pages(brief.id).length, 5);
  throwsRule(() => D.addDocumentLink(hop(), brief.id, "file:///C:/brief.docx", "On my laptop"), /http|web/i);
  const link = D.addDocumentLink(hop(), brief.id, "https://docs.google.com/document/d/abc", "Draft");
  assert.equal(D.linksOf(brief.id)[0].id, link.id);
  D.removeDocumentLink(hop(), link.id);
  assert.equal(D.linksOf(brief.id).length, 0);
  throwsRule(() => D.savePage(vol(), idea.id, { bodyHtml: "<p>x</p>" }, 2));
  ok();
});

await t("a theological review: named crew reviewers, one decision each on the whole document, and comments beside a page", () => {
  const brief = D.ensureDocument(hop(), WOW, "Development", "show_brief");
  const idea = pages(brief.id)[0];
  assert.equal(D.reviewStateOf(brief.id), "no reviewers");
  getDb().members.push({ personId: "DOF-P-CRW-003", projectContentId: "DOF-SER-001", roleOnProject: "Camera", canComment: true });
  commit(); // a refused call below rolls back to the last save
  const crew3 = login("crew3@dof.demo", "demo");
  throwsRule(() => D.setDocumentReviewers(crew3, brief.id, ["DOF-P-CRW-002"]), /chooses the reviewers/);
  throwsRule(() => D.setDocumentReviewers(hop(), brief.id, ["DOF-P-VOL-001"]), /crew list/);
  D.setDocumentReviewers(producer(), brief.id, ["DOF-P-CRW-002", PRODUCER]);
  assert.equal(D.reviewStateOf(brief.id), "pending");
  assert.ok(
    getDb().members.some((m) => m.personId === "DOF-P-CRW-002" && m.projectContentId === "DOF-SER-001"),
    "a reviewer joins the project, so they can read it and decide",
  );
  throwsRule(() => D.decideDocumentReview(crew3, brief.id, { status: "approved", note: "" }), /named on this document/);
  throwsRule(() => D.decideDocumentReview(producer(), brief.id, { status: "changes_requested", note: " " }), /what needs to change/);
  D.decideDocumentReview(producer(), brief.id, { status: "approved", note: "" });
  assert.equal(D.reviewStateOf(brief.id), "pending", "one of two");
  D.decideDocumentReview(login("crew2@dof.demo", "demo"), brief.id, { status: "changes_requested", note: "Tighten the core question." });
  assert.equal(D.reviewStateOf(brief.id), "changes_requested");
  D.decideDocumentReview(hop(), brief.id, { status: "approved", note: "" });
  assert.equal(D.reviewStateOf(brief.id), "approved", "the Head of Production decides for every reviewer");
  const c = D.addReviewComment(login("crew2@dof.demo", "demo"), idea.id, "Is this the right verse?");
  throwsRule(() => D.addReviewComment(vol(), idea.id, "x"));
  D.resolveReviewComment(producer(), c.id, true);
  assert.deepEqual(
    D.commentsOf(brief.id).map((x) => [x.resolved, x.resolvedBy]),
    [[true, PRODUCER]],
    "resolved, and kept",
  );
  ok();
});

// ── Storyboards and shot lists ───────────────────────────────

const PHOTO =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

await t("a storyboard: frames with a picture and three lines, reordered, duplicated, moved and deleted, and reused by copying", () => {
  const board = D.createStoryboard(hop(), WOW, { name: "Opening" });
  const a = D.addFrame(hop(), board.id, { description: "Wide of the studio", imagePath: PHOTO });
  const b = D.addFrame(hop(), board.id, { description: "Host close-up", soundEffects: "Room tone", videoLink: "https://youtu.be/x" });
  throwsRule(() => D.updateFrame(hop(), a.id, { imagePath: "https://example.org/picture.jpg" }), /could not be stored/);
  throwsRule(() => D.updateFrame(hop(), a.id, { videoLink: "javascript:alert(1)" }), /web link/);
  D.moveFrame(hop(), b.id, 0);
  assert.deepEqual(
    D.framesOf(board.id).map((f) => f.description),
    ["Host close-up", "Wide of the studio"],
  );
  const c = D.duplicateFrame(hop(), b.id);
  assert.equal(D.framesOf(board.id)[1].id, c.id, "the copy follows its frame");
  const other = D.createStoryboard(hop(), WOW, { name: "Closing" });
  D.moveFramesTo(hop(), [c.id], other.id);
  assert.equal(D.framesOf(other.id).length, 1);
  D.deleteFrames(hop(), [b.id, a.id]);
  assert.equal(D.framesOf(board.id).length, 0);
  // Reused: a new storyboard, even in another project, starts as a copy of one that exists.
  const dev = "DOF-DEV-001";
  const reused = D.createStoryboard(hop(), dev, { name: "", copyFrom: other.id });
  assert.equal(reused.name, "Closing (copy)");
  assert.equal(reused.copiedFrom, other.id);
  assert.deepEqual(
    D.framesOf(reused.id).map((f) => f.description),
    ["Host close-up"],
  );
  assert.notEqual(D.framesOf(reused.id)[0].id, c.id, "its own frames, so changing them leaves the original alone");
  throwsRule(() => D.moveFramesTo(hop(), [D.framesOf(reused.id)[0].id], board.id), /same project/);
  throwsRule(() => D.createStoryboard(hop(), WOW, { name: "x", episodeId: "DOF-DEV-001" }), /this project's episodes/);
  assert.equal(D.createStoryboard(hop(), WOW, { name: "E01", episodeId: `${WOW}-E01` }).episodeId, `${WOW}-E01`);
  ok();
});

await t("a shot list: shots are numbered, setups and banners are not; times add up; and it can start from another", () => {
  const list = D.createShotList(hop(), WOW, { name: "Session 2" });
  D.addShotRow(hop(), list.id, "banner", { description: "Episode 6" });
  const one = D.addShotRow(hop(), list.id, "shot", { description: "Wide", shotSize: "Wide", estMinutes: 2 });
  const setup = D.addShotRow(hop(), list.id, "setup", { description: "Key light 45 degrees, 35 mm lens" });
  const two = D.addShotRow(hop(), list.id, "shot", {
    description: "Guest close-up",
    shotType: "Eye level",
    movement: "Gimbal",
    estMinutes: 3.5,
  });
  const numbers = D.shotNumbers(list.id);
  assert.deepEqual([numbers.get(one.id), numbers.get(two.id), numbers.get(setup.id)], [1, 2, undefined]);
  assert.equal(D.estimatedMinutes(list.id), 5.5);
  D.moveShotRow(hop(), two.id, 1);
  assert.equal(D.shotNumbers(list.id).get(two.id), 1, "numbering follows the order");
  throwsRule(() => D.updateShotRow(hop(), one.id, { estMinutes: 900 }), /0 to 600/);
  throwsRule(() => D.addShotRow(hop(), list.id, "table" as never));
  const copy = D.createShotList(hop(), WOW, { name: "Session 3", copyFrom: list.id });
  assert.equal(D.rowsOfShotList(copy.id).length, 4);
  D.deleteShotRows(hop(), [one.id, setup.id]);
  assert.equal(D.rowsOfShotList(list.id).length, 2);
  assert.equal(D.rowsOfShotList(copy.id).length, 4, "the copy keeps its own rows");
  ok();
});

// ── A devotion's episodes ────────────────────────────────────

/** The fixture's devotion, its five days written as script pages, and moved into Pre-production. */
function devotionInPreProduction(): string {
  const id = "DOF-DEV-001";
  getDb().plannedEpisodes = getDb().plannedEpisodes.filter((p) => p.contentId !== id); // written as script pages instead
  const script = D.ensureDocument(hop(), id, "Development", "devotional_script");
  pages(script.id).forEach((pg, i) =>
    D.savePage(
      hop(),
      pg.id,
      { title: `Day ${i + 1}`, subtitle: `Psalm ${100 + i}`, bodyHtml: `<p>Script for day ${i + 1}</p>` },
      pg.version,
    ),
  );
  Object.assign(getDb().records.find((r) => r.contentId === id)!.workflow!, { stage: "Pre-production", status: "Active" });
  ensureChecklist("preProject", "project", id);
  return id;
}

await t("in Pre-production a devotion's script becomes its list of episodes, each given its Content ID there and then", () => {
  const id = "DOF-DEV-001";
  D.ensureDocument(hop(), id, "Development", "devotional_script");
  throwsRule(() => D.makeDevotionEpisodes(hop(), id), /Pre-production/);
  throwsRule(() => D.makeDevotionEpisodes(hop(), WOW), /Only a devotion/);
  devotionInPreProduction();
  const list = D.makeDevotionEpisodes(hop(), id);
  assert.deepEqual(
    list.episodes.map((e) => [e.title, e.contentId]),
    [1, 2, 3, 4, 5].map((n) => [`Day ${n}`, `${id}-E0${n}`]),
  );
  const planned = getDb().plannedEpisodes.filter((p) => p.contentId === id);
  assert.deepEqual(
    planned.map((p) => [p.details.scripture, p.question]),
    [0, 1, 2, 3, 4].map((i) => [`Psalm ${100 + i}`, "Grace in the ordinary"]),
    "the scripture from each page, and the devotion's theme",
  );
  assert.equal(D.makeDevotionEpisodes(hop(), id).made.length, 0, "running it again makes nothing new");
  const script = D.documentOf(id, "Development", "devotional_script")!;
  const six = D.addPage(hop(), script.id, { title: "Day 6" });
  D.savePage(hop(), six.id, { bodyHtml: "<p>A bonus day</p>" }, 1);
  D.savePage(hop(), pages(script.id)[0].id, { title: "Day 1: Today is a gift" }, pages(script.id)[0].version);
  const again = D.makeDevotionEpisodes(hop(), id);
  assert.deepEqual([again.made.length, again.updated.length], [1, 1]);
  assert.equal(again.episodes[5].contentId, `${id}-E06`, "numbering carries on, never twice");
  assert.equal(again.episodes[0].title, "Day 1: Today is a gift", "a renamed page renames its episode");
  ok();
});

await t("days already listed on the earlier form are taken over by the script's pages, in order, never listed twice", () => {
  const id = "DOF-DEV-001";
  const before = getDb()
    .plannedEpisodes.filter((p) => p.contentId === id)
    .map((p) => p.id);
  assert.equal(before.length, 5, "the fixture's five days, from the earlier form");
  const script = D.ensureDocument(hop(), id, "Development", "devotional_script");
  const first = pages(script.id)[0];
  D.savePage(hop(), first.id, { title: "A gift", subtitle: "Psalm 118:24", bodyHtml: "<p>Today</p>" }, first.version);
  const second = pages(script.id)[1];
  D.savePage(hop(), second.id, { bodyHtml: "<p>Mercy</p>" }, second.version);
  Object.assign(getDb().records.find((r) => r.contentId === id)!.workflow!, { stage: "Pre-production", status: "Active" });
  const list = D.makeDevotionEpisodes(hop(), id);
  assert.deepEqual(list.made, [], "nothing new: the earlier days are used");
  const planned = getDb().plannedEpisodes.filter((p) => p.contentId === id);
  assert.deepEqual(
    planned.map((p) => p.id),
    before,
    "still five days",
  );
  const [one, two] = planned;
  assert.deepEqual([one.sourcePageId, one.workingTitle, one.details.scripture], [first.id, "A gift", "Psalm 118:24"]);
  assert.match(one.notes, /Title on the earlier form: Day 1: Today is a gift/, "what the page replaced is kept");
  assert.equal(two.details.scripture, "Lamentations 3:22-23", "a page with no scripture keeps the day's own");
  assert.equal(two.details.keyThought, "Mercy is new", "and the day's other details stay");
  assert.deepEqual(
    list.episodes.map((e) => e.contentId),
    [`${id}-E01`, `${id}-E02`],
    "only the pages written in count",
  );
  assert.deepEqual(
    planned.slice(2).map((p) => [p.sourcePageId, p.workingTitle]),
    [
      [null, "Day 3: Work as worship"],
      [null, "Day 4: One day at a time"],
      [null, "Day 5: Rest is trust"],
    ],
    "the days not yet written as pages are left as they were",
  );
  assert.equal(D.makeDevotionEpisodes(hop(), id).made.length, 0, "and again, nothing twice");
  ok();
});

await t("recording a devotion makes each episode under the Content ID it was given", async () => {
  const id = devotionInPreProduction();
  D.makeDevotionEpisodes(hop(), id);
  await call("workflow.assignProducer", id, PRODUCER);
  for (const [role, who] of [
    ["director", "DOF-P-CRW-001"],
    ["dop", "DOF-P-CRW-002"],
    ["audio_engineer", "DOF-P-CRW-003"],
    ["editor", "DOF-P-CRW-001"],
  ])
    await call("workflow.assignRole", id, role, { crewId: who });
  await call("workflow.assignRole", id, "host_guest", { guestName: "Rev. Mary Wanjiku" });
  await tickAll(call, "preProject", id);
  const planned = getDb()
    .plannedEpisodes.filter((p) => p.contentId === id)
    .map((p) => p.id);
  const s = await prepareSession(call, id, "2026-11-02", planned, ["DOF-EQ-CAM-003"]);
  for (const [i, p] of planned.entries())
    await call("workflow.updateLogRow", `${s}|${p}`, { status: i === 4 ? "Not recorded" : "Recorded", notesForPost: "" });
  await tickAll(call, "wrap", s);
  const closed = (await call("workflow.closeSession", s)) as unknown as { made: string[] };
  assert.deepEqual(
    closed.made,
    [1, 2, 3, 4].map((n) => `${id}-E0${n}`),
  );
  assert.equal(getDb().records.find((r) => r.contentId === `${id}-E01`)?.title, "Day 1");
  assert.ok(!getDb().records.some((r) => r.contentId === `${id}-E05`), "Day 5 was not recorded: its ID waits for it");
  ok();
});

// ── Moving the old Development forms into documents ──────────

/** A project of each form type, every Development field filled, as the old form would have it. */
async function everyFormFilled(): Promise<Record<FormType, string>> {
  const out = {} as Record<FormType, string>;
  for (const formType of ["podcast", "testimonial", "sermon", "documentary_dof", "documentary_pitched", "devotion"] as FormType[]) {
    const p =
      formType === "devotion"
        ? await call("workflow.createWorkflowProject", { category: "devotional", title: "Five days of grace" })
        : formType.startsWith("documentary")
          ? await call("workflow.createWorkflowProject", { category: "documentary", title: `A ${formType} film`, formType })
          : await call("workflow.createWorkflowProject", { category: "series", title: `A ${formType} series`, seriesType: formType });
    const id = (p as { contentId: string }).contentId;
    const section = DEV_FORMS[formType].find((s) => s.planned);
    for (let n = 1; n <= (formType === "devotion" ? 5 : 2); n++)
      await call("workflow.addPlannedEpisode", id, { workingTitle: `Planned ${n}`, details: fillSection(section?.planned?.details ?? []) });
    await completeForm(call, id, formType);
    for (const cp of ["pitch", "outline_script"]) {
      await call("workflow.setCheckpointReviewers", `${id}|${cp}`, [PRODUCER]);
      await call("workflow.decideCheckpoint", `${id}|${cp}`, { status: "Approved", note: "Sound." });
    }
    out[formType] = id;
  }
  return out;
}

const textIn = (db: Database, projectId: string): string =>
  db.documentPages
    .filter((p) => p.documentId.startsWith(`${projectId}|`))
    .map((p) => `${p.title} ${p.subtitle} ${p.bodyHtml}`)
    .join(" ");

await t("the move: every filled field of every form type is written onto a page or kept on the form, and none is lost", async () => {
  const ids = await everyFormFilled();
  getDb().developmentForms.find((f) => f.contentId === ids.devotion)!.sections.messageReview = { notes: "The team liked day three best." };
  const db = structuredClone(getDb());
  const report = migrateDocuments(db, { at: AT });
  assert.deepEqual(report.unaccounted, [], "zero fields unaccounted for");
  assert.deepEqual(report.extras, [], "every field has its place in the mapping");
  assert.deepEqual(integrityProblems(db), []);
  for (const [formType, id] of Object.entries(ids)) {
    const text = textIn(db, id);
    // A devotion's message-review notes become a review comment, checked below, not a page.
    for (const section of DEV_FORMS[formType as FormType].filter((s) => s.key !== "messageReview"))
      for (const f of section.fields) {
        const kept = report.kept.some((k) => k.contentId === id && k.field === `${section.label}: ${f.label}`);
        if (kept || f.type !== "longtext") continue;
        assert.ok(text.includes(`${f.label} for Whispers of Why`), `${formType}: ${section.label}, ${f.label}`);
        assert.ok(text.includes(`<strong>${f.label.replace(/&/g, "&amp;")}</strong>`), `${formType}: labelled ${f.label}`);
      }
  }
  // Where things go.
  const page = (id: string, doc: string, title: string) =>
    db.documentPages.find((p) => p.documentId === `${id}|${doc.includes("|") ? doc : `Development|${doc}`}` && p.title === title)
      ?.bodyHtml ?? "";
  assert.match(page(ids.podcast, "show_brief", "The idea"), /<h3>Stress-test<\/h3>/);
  assert.match(page(ids.podcast, "show_brief", "Scripture and source basis"), /<h3>Research<\/h3>/);
  assert.match(page(ids.podcast, "show_brief", "Ask"), /<h3>Budget<\/h3>.*1,000/);
  assert.doesNotMatch(textIn(db, ids.podcast), /Logline for Whispers/, "the logline stays a field at the top of The idea");
  assert.ok(report.kept.some((k) => k.contentId === ids.podcast && k.field === "Brief: Logline"));
  assert.match(page(ids.testimonial, "show_brief", "Sensitivity"), /Private details about other people/);
  assert.ok(
    report.kept.some((k) => k.contentId === ids.testimonial && k.field.startsWith("Consent and release")),
    "consent stays its own form",
  );
  assert.match(page(ids.sermon, "show_brief", "Outline"), /Key points/);
  assert.match(page(ids.documentary_dof, "Pre-production|treatment", "Story structure"), /Act structure/);
  assert.match(page(ids.documentary_dof, "Pre-production|treatment", "Interview guide"), /Interview sets/);
  assert.match(page(ids.documentary_pitched, "documentary_brief", "Ownership terms"), /Who owns the final film/);
  assert.match(page(ids.documentary_pitched, "documentary_brief", "Support asked for"), /Gear/);
  assert.match(page(ids.devotion, "Pre-production|recording_plan", "Notes"), /Recording slot/);
  // A devotion's five days become its script, each page linked to its planned episode so none is listed twice.
  const script = db.documentPages
    .filter((p) => p.documentId === `${ids.devotion}|Development|devotional_script`)
    .sort((a, b) => a.position - b.position);
  assert.deepEqual(
    script.map((p) => p.title),
    ["Planned 1", "Planned 2", "Planned 3", "Planned 4", "Planned 5"],
  );
  assert.match(script[0].subtitle, /Scripture for Whispers of Why/);
  assert.match(script[0].bodyHtml, /Key thought/);
  assert.ok(db.plannedEpisodes.filter((p) => p.contentId === ids.devotion).every((p) => script.some((s) => s.id === p.sourcePageId)));
  assert.ok(
    db.reviewComments.some((c) => c.body.includes("The team liked day three best.")),
    "the message review notes, as a comment",
  );
  // The criteria, and the checkpoints as the brief's review.
  assert.ok(db.documentReviews.some((r) => r.id === `${ids.podcast}|Development|show_brief|${PRODUCER}` && r.status === "approved"));
});

await t("the move: the six criteria onto Greenlight, the camera plan into a shot list, and old fields left as they were", () => {
  const form = getDb().developmentForms.find((f) => f.contentId === WOW)!;
  form.criteria.missionFit = { met: true, note: "Central to the mandate." };
  form.criteria.resourceCost = { met: false, note: "Studio time is tight." };
  getDb().workflowChecklistItems.find((c) => c.id === `${WOW}|Pre-production|shot_list`)!.note =
    "A cam on host, B cam on guest\nC cam wide";
  getDb().docs.push({
    ...getDb().docs[0],
    id: "DOF-DCS-900",
    contentId: `${WOW}-E01`,
    templateKey: "shotlist",
    title: "Shot list: Why do we doubt?",
    body: "2. Shot list\n_Each shot, in order._\n| # | Shot | Notes |\n|---|---|---|\n| 1 | Wide | Establishing |\n- Insert of the Bible\n3. Equipment needed\nTwo cameras",
  });
  const before = JSON.stringify({
    forms: getDb().developmentForms,
    checkpoints: getDb().reviewCheckpoints,
    checklist: getDb().workflowChecklistItems,
    docs: getDb().docs,
  });
  const report = migrateDocuments(getDb(), { at: AT });
  assert.deepEqual(report.unaccounted, []);
  const greenlight = getDb().documentPages.find((p) => p.documentId === `${WOW}|Development|greenlight`)!.bodyHtml;
  assert.match(greenlight, /Mission fit:<\/strong> Met\. Central to the mandate\./);
  assert.match(greenlight, /Resource cost:<\/strong> Not met\. Studio time is tight\./);
  const list = getDb().shotLists.find((l) => l.contentId === WOW)!;
  const rows = D.rowsOfShotList(list.id).map((r) => `${r.rowType}:${r.description}`);
  assert.deepEqual(rows, [
    "banner:Shot list note from Pre-production",
    "setup:A cam on host, B cam on guest",
    "setup:C cam wide",
    "banner:Shot list: Why do we doubt?",
    "banner:Shot list",
    "shot:Wide, Establishing",
    "shot:Insert of the Bible",
    "banner:Equipment needed",
    "setup:Two cameras",
  ]);
  assert.equal(
    JSON.stringify({
      forms: getDb().developmentForms,
      checkpoints: getDb().reviewCheckpoints,
      checklist: getDb().workflowChecklistItems,
      docs: getDb().docs,
    }),
    before,
    "the old form, checkpoints, checklists and documents are left exactly as they were",
  );
  ok();
});

await t("the move runs twice without change, and undoing it removes exactly what it wrote, keeping what was written in since", () => {
  migrateDocuments(getDb(), { at: AT });
  const once = JSON.stringify(getDb());
  assert.equal(migrateDocuments(getDb(), { at: AT }).changed, false);
  assert.equal(JSON.stringify(getDb()), once, "the second run changed nothing");
  // A document started by hand before the move is left alone, and its project's form is not copied over it.
  const fresh = structuredClone(buildWorkflowFixture());
  setDb(fresh);
  D.ensureDocument(hop(), WOW, "Development", "show_brief");
  assert.match(migrateDocuments(getDb(), { at: AT }).lines.find((l) => l.contentId === WOW)!.note, /already has its documents/);
  // Undo.
  setDb(buildWorkflowFixture());
  getDb().workflowChecklistItems.find((c) => c.id === `${WOW}|Pre-production|shot_list`)!.note = "A cam on host";
  const original = JSON.stringify(getDb());
  migrateDocuments(getDb(), { at: AT });
  const idea = getDb().documentPages.find((p) => p.documentId === `${WOW}|Development|show_brief` && p.title === "The idea")!;
  D.savePage(hop(), idea.id, { bodyHtml: "<p>Written after the move</p>" }, idea.version);
  const camera = getDb().shotLists.find((l) => l.contentId === WOW && l.migrated)!;
  D.addShotRow(hop(), camera.id, "shot", { description: "Added after the move" });
  const undo = undoDocumentMove(getDb());
  assert.deepEqual(
    undo.keptEdited,
    [`${WOW}|Development|show_brief`, camera.id],
    "the brief and the camera plan were written in since, so they are kept",
  );
  assert.ok(getDb().projectDocuments.some((d) => d.id === `${WOW}|Development|show_brief`));
  assert.ok(getDb().shotListRows.some((r) => r.shotListId === camera.id && r.description === "Added after the move"));
  undoDocumentMove(getDb(), true);
  const after = JSON.parse(JSON.stringify(getDb())) as Database;
  const was = JSON.parse(original) as Database;
  for (const part of ["projectDocuments", "documentPages", "documentReviews", "reviewComments", "shotLists", "shotListRows"] as const)
    assert.deepEqual(after[part], was[part], `${part} as before the move`);
  assert.deepEqual(after.plannedEpisodes, was.plannedEpisodes, "planned episodes as before");
  ok();
});

await t("one run moves old projects into the workflow and every Development form into documents", () => {
  const db = buildSeed();
  const report = moveToNewSystem(db, { today: "2026-09-26", at: AT, byPersonId: "DOF-P-HOP-001" });
  assert.equal(report.changed, true);
  assert.deepEqual([report.unexplained, report.documents.unaccounted], [[], []]);
  const moved = report.documents.lines.filter((l) => l.documents.length).map((l) => l.contentId);
  assert.deepEqual(moved.sort(), ["DOF-DEV-001", "DOF-DOC-001", "DOF-SER-001-S1"]);
  const docs = report.counts.find((c) => c.part === "projectDocuments")!;
  assert.ok(docs.before === 0 && docs.after >= 3, "before and after counts include the new parts");
  assert.ok(db.audit.some((a) => a.action === "migrate-documents"));
  assert.deepEqual(integrityProblems(db), []);
  assert.equal(
    moveToNewSystem(db, { today: "2026-09-26", at: AT, byPersonId: "DOF-P-HOP-001" }).changed,
    false,
    "and again changes nothing",
  );
});

// ── What each person is sent ─────────────────────────────────

await t("the server sends documents, storyboards and shot lists only with the projects a person may see", async () => {
  D.ensureDocument(hop(), WOW, "Development", "show_brief");
  D.ensureDocument(hop(), "DOF-DOC-001", "Development", "documentary_brief");
  D.createStoryboard(hop(), "DOF-DOC-001", { name: "Herd at dawn" });
  D.createShotList(hop(), "DOF-DOC-001", { name: "Day 1" });
  const store = memoryStore();
  await initDatabase(store, structuredClone(getDb()));
  const partner = (await snapshotFor(store, login("partner1@dof.demo", "demo")))!.db;
  const full = (await snapshotFor(store, hop()))!.db;
  assert.equal(full.projectDocuments.length, 2);
  assert.ok(partner.projectDocuments.every((d) => partner.records.some((r) => r.contentId === d.contentId)));
  assert.ok(partner.storyboards.every((b) => partner.records.some((r) => r.contentId === b.contentId)));
  assert.ok(!partner.documentPages.some((p) => p.documentId.startsWith(`${WOW}|`)), "a partner not on the season gets none of its pages");
  ok();
});

// ── The catalogue ────────────────────────────────────────────

await t("the catalogue follows the five stages for every type, and a devotion has no Show Brief or Greenlight", () => {
  for (const formType of ["podcast", "testimonial", "sermon", "documentary_dof", "documentary_pitched", "devotion"] as FormType[]) {
    const dev = catalogFor(formType, "Development").map((e) => e.key);
    if (formType === "devotion") {
      assert.deepEqual(dev, ["devotional_script", "theological_review", "accept_decline"]);
      assert.equal(catalogFor(formType, "Development")[0].pages?.length, 5, "five devotion pages to start");
    } else assert.ok(dev.includes("greenlight") && dev.includes("theological_review"), formType);
    assert.ok(catalogFor(formType, "Marketing and distribution").length > 0);
  }
  assert.deepEqual(
    catalogFor("podcast", "Pre-production").map((e) => [e.key, e.kind]),
    [
      ["production_pack", "document"],
      ["storyboard", "tool"],
      ["shot_list", "tool"],
      ["roles", "form"],
      ["sessions", "form"],
      ["call_sheet", "form"],
      ["gear", "form"],
    ],
  );
});

console.log(`\n${passed} passed`);
