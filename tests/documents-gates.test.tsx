// Run with: npm test -- documents-gates
// Phase 3 of the documents rework: the short gates out of Development, passing a gate by hand, the theological review
// of the brief or script with its comments, the greenlight and the handoff, and a devotion's Accept or Decline. With a
// project type's documents off, its gates are exactly as before.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import type { Actor } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { sectionOf } from "../src/config/devForms";
import { login } from "../src/services/auth";
import * as D from "../src/services/wrapped/documents";
import * as W from "../src/services/wrapped/workflow";
import { AppProvider } from "../src/ui/AppContext";
import { ProjectHome } from "../src/pages/documents/ProjectDocuments";
import { PageComments, ReviewBanner, ReviewPanes } from "../src/pages/documents/ReviewView";
import { PageEditor } from "../src/pages/documents/PageEditor";
import { PlanSectionView } from "../src/pages/documents/RecordingPlan";
import type { Project } from "../src/services/workflow";
import { allWorkItems } from "../src/services/workItems";
import { remindersFor } from "../src/services/reminders";

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void, through: "development" | "session1" = "development") => {
  setDb(buildWorkflowFixture({ through }));
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

/** Names a reviewer on the project's brief (or script) and has them approve it. */
function approveBrief(id: string, docKey: string) {
  const doc = D.ensureDocument(hop(), id, "Development", docKey);
  D.setDocumentReviewers(hop(), doc.id, ["DOF-P-CRW-002"]);
  D.decideDocumentReview(crew2(), doc.id, { status: "approved", note: "" });
  return doc;
}

// ── Series and documentaries ─────────────────────────────────

await t("a series leaves Development on three hard gates; everything else is a note that never blocks", () => {
  assert.ok(W.evaluateGate("Development", "project", WOW).warnings.includes("The Show Brief is not started yet"));
  D.ensureDocument(hop(), WOW, "Development", "show_brief");
  assert.deepEqual(
    D.hardGates(WOW).map((g) => [g.key, g.met]),
    [
      ["idea", true],
      ["review", false],
      ["greenlight", false],
    ],
    "the fixture's brief has its logline and core question",
  );
  let gate = W.evaluateGate("Development", "project", WOW);
  assert.equal(gate.missing.length, 2, gate.missing.join("; "));
  assert.ok(
    gate.warnings.some((w) => /Show Brief: Scripture and source basis not written yet/.test(w)),
    gate.warnings.join("; "),
  );
  assert.ok(
    gate.warnings.some((w) => /Handoff: Outline locked not ticked yet/.test(w)),
    "the handoff checklist is a note now",
  );
  // The logline cleared: the first gate opens again.
  W.saveFormSection(hop(), WOW, "brief", { logline: "" });
  assert.equal(D.hardGates(WOW)[0].met, false);
  assert.match(D.hardGates(WOW)[0].detail, /logline/);
  W.saveFormSection(hop(), WOW, "brief", { logline: "Thirty quiet conversations." });
  // No greenlight before the review.
  throwsRule(() => W.decideGreenlight(hop(), WOW, { outcome: "Greenlight", notes: "" }), /Theological review of the brief approved/);
  approveBrief(WOW, "show_brief");
  assert.deepEqual(W.greenlightBlockers(project(WOW), 1), [], "logline, core question and review: enough for the decision");
  W.decideGreenlight(hop(), WOW, { outcome: "Greenlight", notes: "Strong pitch" });
  gate = W.evaluateGate("Development", "project", WOW);
  assert.deepEqual(
    gate.missing.map((m) => m.split(" (")[0]),
    ["Greenlight decision recorded as Greenlight, and a show producer named"],
  );
  W.assignProducer(hop(), WOW, PRODUCER);
  gate = W.evaluateGate("Development", "project", WOW);
  assert.equal(gate.passed, true, gate.missing.join("; "));
  assert.ok(gate.warnings.length > 0, "the notes are still there, and do not block");
  W.advanceProject(producer(), WOW);
  assert.equal(project(WOW).workflow.stage, "Pre-production");
  ok();
});

await t("a hard gate can be passed by hand, with a note, by the Head of Production; never the decision itself", () => {
  throwsRule(() => D.setGateOverride(producer(), WOW, "review", "Pastor approved by phone"), /pass a gate by hand/);
  throwsRule(() => D.setGateOverride(hop(), WOW, "review", "  "), /short note/);
  throwsRule(() => D.setGateOverride(hop(), WOW, "greenlight", "Just go"), /recorded, not passed by hand/);
  throwsRule(() => D.setGateOverride(hop(), WOW, "idea", "Already there"), /already met/);
  D.setGateOverride(hop(), WOW, "review", "Pastor approved by phone; written review to follow");
  const review = D.hardGates(WOW).find((g) => g.key === "review")!;
  assert.equal(review.met, false);
  assert.equal(review.override?.note, "Pastor approved by phone; written review to follow");
  assert.deepEqual(W.greenlightBlockers(project(WOW), 1), []);
  assert.ok(getDb().audit.some((a) => a.action === "gate-override" && /Passed by hand/.test(a.detail)));
  D.setGateOverride(hop(), WOW, "review", null);
  assert.equal(D.hardGates(WOW).find((g) => g.key === "review")!.override, null, "taken back");
  assert.equal(W.greenlightBlockers(project(WOW), 1).length, 1);
  ok();
});

await t("a project reviewed on the earlier checkpoints keeps that review, until reviewers are named on its brief", () => {
  for (const k of ["pitch", "outline_script"] as const) {
    W.setCheckpointReviewers(hop(), `${WOW}|${k}`, ["DOF-P-CRW-002"]);
    W.decideCheckpoint(crew2(), `${WOW}|${k}`, { status: "Approved", note: "" });
  }
  const review = D.hardGates(WOW).find((g) => g.key === "review")!;
  assert.deepEqual([review.met, review.detail], [true, "Approved on the earlier review checkpoints"]);
  const brief = D.ensureDocument(hop(), WOW, "Development", "show_brief");
  D.setDocumentReviewers(hop(), brief.id, ["DOF-P-CRW-002"]);
  assert.equal(
    D.hardGates(WOW).find((g) => g.key === "review")!.met,
    false,
    "once reviewers are named on the document, theirs is the review",
  );
  ok();
});

await t("the review: changes requested go back to the writers, who ask again; comments sit beside a page and can be resolved", () => {
  const brief = D.ensureDocument(hop(), WOW, "Development", "show_brief");
  throwsRule(() => D.askForReviewAgain(hop(), brief.id), /No reviewer has asked for changes/);
  W.assignProducer(hop(), WOW, PRODUCER);
  D.setDocumentReviewers(producer(), brief.id, ["DOF-P-CRW-002", PRODUCER]);
  D.decideDocumentReview(crew2(), brief.id, { status: "changes_requested", note: "The core question needs sharpening." });
  D.decideDocumentReview(producer(), brief.id, { status: "approved", note: "" });
  assert.equal(D.reviewStateOf(brief.id), "changes_requested");
  assert.match(D.hardGates(WOW)[1].detail, /Changes requested/);
  const idea = D.pagesOf(brief.id)[0];
  const c = D.addReviewComment(crew2(), idea.id, "Which verse anchors this?");
  D.askForReviewAgain(producer(), brief.id);
  assert.deepEqual(
    D.reviewsOf(brief.id).map((r) => [r.reviewerId, r.status]),
    [
      ["DOF-P-CRW-002", "pending"],
      [PRODUCER, "approved"],
    ],
    "the request goes back to pending; the approval stands",
  );
  D.resolveReviewComment(producer(), c.id, true);
  D.decideDocumentReview(crew2(), brief.id, { status: "approved", note: "" });
  assert.equal(D.hardGates(WOW)[1].met, true);
  // On screen.
  setDb(structuredClone(getDb()));
  const panes = html(
    "crew2@dof.demo",
    <ReviewPanes project={project(WOW)} doc={brief} title="Show Brief" write pageId={null} onSelectPage={() => {}} />,
  );
  assert.match(panes, /Theological review of the Show Brief/);
  assert.match(panes, /Approve the whole document/);
  assert.match(panes, /Resolved \(1\)/);
  assert.match(panes, /Which verse anchors this\?/);
  ok();
});

await t("the review on screen: who may decide, the reason sent back on the document, and a comment box per page", () => {
  const brief = D.ensureDocument(hop(), WOW, "Development", "show_brief");
  W.assignProducer(hop(), WOW, PRODUCER);
  D.setDocumentReviewers(hop(), brief.id, ["DOF-P-CRW-002"]);
  D.decideDocumentReview(crew2(), brief.id, { status: "changes_requested", note: "Tighten the logline." });
  const banner = html("crew4@dof.demo", <ReviewBanner doc={brief} write />);
  assert.match(banner, /Changes requested\./);
  assert.match(banner, /Tighten the logline\./);
  assert.match(banner, /Ask for review again/);
  const asProducer = html(
    "crew4@dof.demo",
    <ReviewPanes project={project(WOW)} doc={brief} title="Show Brief" write pageId={null} onSelectPage={() => {}} />,
  );
  assert.ok(!asProducer.includes("Approve the whole document"), "the producer is not a named reviewer");
  assert.match(asProducer, /Add a reviewer/, "but chooses the reviewers");
  assert.match(
    html("hop@dof.demo", <ReviewPanes project={project(WOW)} doc={brief} title="Show Brief" write pageId={null} onSelectPage={() => {}} />),
    /Approve for every reviewer/,
  );
  const page = D.pagesOf(brief.id)[0];
  assert.match(html("crew2@dof.demo", <PageComments project={project(WOW)} doc={brief} page={page} />), /aria-label="Comment on The idea"/);
});

await t("Waiting on you follows the review: the reviewers still to decide, then the owner when changes are asked for", () => {
  const brief = D.ensureDocument(hop(), WOW, "Development", "show_brief");
  D.setDocumentReviewers(hop(), brief.id, ["DOF-P-CRW-002"]);
  let item = allWorkItems().find((i) => i.id === WOW)!;
  assert.equal(item.step, "Theological review");
  assert.ok(item.waitingOn.includes("DOF-P-CRW-002"), "the reviewer");
  assert.ok(
    remindersFor("DOF-P-CRW-002").some((r) => /Theological review waiting for you/.test(r.title)),
    "and the reviewer is reminded",
  );
  D.decideDocumentReview(crew2(), brief.id, { status: "changes_requested", note: "Sharpen the question." });
  item = allWorkItems().find((i) => i.id === WOW)!;
  assert.equal(item.step, "Changes requested on the Show Brief");
  const owner = item.ownerId!;
  assert.ok(owner && item.waitingOn.includes(owner) && !item.waitingOn.includes("DOF-P-CRW-002"), "back with its owner");
});

await t("Project Home shows the header strip and the short gate while in Development", () => {
  const home = html("hop@dof.demo", <ProjectHome project={project(WOW)} write onOpen={() => {}} />);
  assert.match(home, /Project details/);
  assert.match(home, /aria-label="Leave Development"/);
  assert.match(home, /1 of 3 ready/);
  assert.match(home, /The logline and the core question written in the brief/);
  assert.match(home, /Pass by hand/, "the Head of Production may pass a gate by hand");
  assert.ok(
    !html("crew4@dof.demo", <ProjectHome project={project(WOW)} write onOpen={() => {}} />).includes("Pass by hand"),
    "the producer may not",
  );
  assert.match(home, /Done: move to Pre-production/);
  assert.match(home, /Dismiss/);
});

await t("a testimonial is not greenlit without the person's consent and release, which is never passed by hand", () => {
  project(WOW).workflow.formType = "testimonial";
  getDb().developmentForms.find((f) => f.contentId === WOW)!.formType = "testimonial";
  commit(); // kept, so a refused change goes back to this and not before it
  const consent = () => D.hardGates(WOW).find((g) => g.key === "consent");
  assert.equal(consent()?.met, false);
  assert.match(consent()!.detail, /They agree to be recorded and published/);
  throwsRule(() => D.setGateOverride(hop(), WOW, "consent", "They said yes on the phone"), /given by the person, not passed by hand/);
  approveBrief(WOW, "show_brief");
  throwsRule(() => W.decideGreenlight(hop(), WOW, { outcome: "Greenlight", notes: "" }), /Consent and release complete/);
  const all = {
    agreement: "yes",
    whereShared: "YouTube",
    peopleNamed: "None",
    minors: "no",
    withdrawalTerms: "Any time before publication",
  };
  W.saveFormSection(hop(), WOW, "consent", { ...all, agreement: "no" });
  assert.match(consent()!.detail, /must agree to be recorded/);
  W.saveFormSection(hop(), WOW, "consent", all);
  assert.equal(consent()?.met, true);
  assert.ok(!W.evaluateGate("Development", "project", WOW).warnings.some((w) => /Consent/.test(w)), "not said twice as a note");
  W.decideGreenlight(hop(), WOW, { outcome: "Greenlight", notes: "" });
  ok();
});

await t("testimonials and sermons have the logline and core question too, optional on the earlier form", () => {
  for (const ft of ["testimonial", "sermon"] as const) {
    const brief = sectionOf(ft, "brief")!;
    for (const key of ["logline", "coreQuestion"]) {
      const f = brief.fields.find((x) => x.key === key);
      assert.ok(f && !f.required, `${ft}: ${key}`);
    }
  }
});

// ── Devotions ────────────────────────────────────────────────

/** Writes the devotion's five pages, each with a title, its scripture and the script. */
function writeFive() {
  const script = D.ensureDocument(hop(), DEV, "Development", "devotional_script");
  D.pagesOf(script.id).forEach((p, i) =>
    D.savePage(hop(), p.id, { title: `Day ${i + 1}`, subtitle: `Psalm ${120 + i}`, bodyHtml: `<p>Script ${i + 1}</p>` }, p.version),
  );
  return script;
}

await t("a devotion: guest name and contact, five full pages and the review; then Accept lists its devotions in Pre-production", () => {
  assert.deepEqual(
    D.hardGates(DEV).map((g) => [g.key, g.met, g.detail]),
    [
      ["guest", false, "The guest's contact is missing"],
      ["pages", false, "0 of 5 ready"],
      ["review", false, "No reviewer named yet"],
    ],
  );
  throwsRule(() => D.acceptDevotion(hop(), DEV, ""), /Before a greenlight/);
  W.saveFormSection(hop(), DEV, "guest", { contact: "+254 700 000 000" });
  const script = writeFive();
  approveBrief(DEV, "devotional_script");
  assert.ok(D.hardGatesPass(DEV));
  W.assignProducer(hop(), DEV, PRODUCER);
  throwsRule(() => D.acceptDevotion(producer(), DEV, ""), /greenlight decision/);
  const list = D.acceptDevotion(hop(), DEV, "A fine week of devotions");
  assert.equal(project(DEV).workflow.stage, "Pre-production");
  assert.deepEqual(
    list.episodes.map((e) => [e.title, e.contentId]),
    [1, 2, 3, 4, 5].map((n) => [`Day ${n}`, `${DEV}-E0${n}`]),
    "five devotions, each with its Content ID",
  );
  const planned = getDb().plannedEpisodes.filter((p) => p.contentId === DEV && !p.archivedAt);
  assert.equal(planned.length, 5, "the five days from the earlier form, taken over, not doubled");
  assert.deepEqual(
    planned.map((p) => p.sourcePageId),
    D.pagesOf(script.id).map((p) => p.id),
    "each with its script page attached",
  );
  assert.equal(getDb().developmentForms.find((f) => f.contentId === DEV)!.outcome, "Greenlight");
  assert.ok(getDb().audit.some((a) => a.action === "devotion-accepted"));
  throwsRule(() => D.acceptDevotion(hop(), DEV, ""), /already left Development|decided during Development/);
  ok();
});

await t("a devotion's gates can be passed by hand, and Accept still works with fewer pages", () => {
  W.saveFormSection(hop(), DEV, "guest", { contact: "mary@example.org" });
  const script = D.ensureDocument(hop(), DEV, "Development", "devotional_script");
  const first = D.pagesOf(script.id)[0];
  D.savePage(hop(), first.id, { subtitle: "John 1:5", bodyHtml: "<p>Light</p>" }, first.version);
  D.setGateOverride(hop(), DEV, "pages", "A three-day special this time");
  D.setGateOverride(hop(), DEV, "review", "Reviewed in the team meeting");
  const list = D.acceptDevotion(hop(), DEV, "");
  assert.equal(list.episodes.length, 1, "only the page written in becomes a devotion");
  ok();
});

await t("Decline needs a reason, and closes and archives the devotion, never deleting it", () => {
  throwsRule(() => W.decideGreenlight(hop(), DEV, { outcome: "Decline", notes: " " }), /reason/);
  W.decideGreenlight(hop(), DEV, { outcome: "Decline", notes: "The guest withdrew" });
  const p = project(DEV);
  assert.deepEqual([p.archived, p.workflow.status, p.closedReason], [true, "Closed", "The guest withdrew"]);
  assert.ok(
    getDb().records.some((r) => r.contentId === DEV),
    "kept",
  );
});

await t("a devotion's Project Home offers Accept and Decline, enabled for the Head of Production once its gates are met", () => {
  const home = () => html("hop@dof.demo", <ProjectHome project={project(DEV)} write onOpen={() => {}} />);
  assert.match(home(), /aria-label="Accept or decline"/);
  assert.match(home(), /<button class="btn primary" disabled="">Accept<\/button>/);
  W.saveFormSection(hop(), DEV, "guest", { contact: "mary@example.org" });
  writeFive();
  approveBrief(DEV, "devotional_script");
  commit();
  assert.match(home(), /<button class="btn primary">Accept<\/button>/);
  assert.match(home(), /3 of 3 ready/);
});

await t("a devotion's pages are its topics, under one theme every devotion shares; the Devotions list shows both", () => {
  W.saveFormSection(hop(), DEV, "guest", { contact: "mary@example.org" });
  const script = writeFive();
  approveBrief(DEV, "devotional_script");
  D.acceptDevotion(hop(), DEV, "");
  const page = D.pagesOf(script.id)[0];
  assert.match(
    html("hop@dof.demo", <PageEditor doc={script} page={page} write subtitleLabel="Scripture" titleLabel="Topic" />),
    /aria-label="Topic"/,
  );
  const list = html("hop@dof.demo", <PlanSectionView project={project(DEV)} section="devotions" write onOpenTool={() => {}} />);
  assert.match(list, /<th>Topic<\/th>/);
  assert.match(list, /Theme, shared by every devotion: <b>Grace in the ordinary<\/b>/);
  const rows = getDb().plannedEpisodes.filter((p) => p.contentId === DEV && p.sourcePageId);
  assert.deepEqual([...new Set(rows.map((p) => p.question))], ["Grace in the ordinary"], "every devotion carries the one theme");
  assert.equal(new Set(rows.map((p) => p.workingTitle)).size, rows.length, "each with its own topic");
  W.saveFormSection(hop(), DEV, "entry", { theme: "Light for the way" });
  D.makeDevotionEpisodes(hop(), DEV);
  assert.deepEqual(
    [
      ...new Set(
        getDb()
          .plannedEpisodes.filter((p) => p.contentId === DEV && p.sourcePageId)
          .map((p) => p.question),
      ),
    ],
    ["Light for the way"],
    "a new theme reaches every devotion when the list is brought up to date",
  );
});

console.log(`\n${passed} passed`);
