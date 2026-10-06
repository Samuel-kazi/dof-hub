// Run with: npm test -- review-reminder
// The rework's Phase 3 (build prompt v2, section 14): the theological review is a reminder, not a gate. The greenlight
// and a devotion's acceptance go ahead without it; while it is not approved the project says "Theological review not
// done" (on the project, its home and its board card, and in the urgency report); scheduling a session, publishing a
// call sheet or an episode asks "Theological review not completed. Continue?" and keeps the note, never blocking; a
// page changed after the approval says so. With the switch off, the review is a gate again (documents-gates).
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { login } from "../src/services/auth";
import * as CS from "../src/services/wrapped/callsheets";
import * as D from "../src/services/wrapped/documents";
import * as W from "../src/services/wrapped/workflow";
import { setFeature } from "../src/services/wrapped/settings";
import { urgencyReport } from "../src/services/urgency";
import { allWorkItems } from "../src/services/workItems";
import type { Project } from "../src/services/workflow";
import { AppProvider } from "../src/ui/AppContext";
import { WorkCard } from "../src/pages/workflow/Board";
import { WorkflowProjectPage } from "../src/pages/workflow/ProjectPage";
import { ReviewPanes } from "../src/pages/documents/ReviewView";
import { PageList } from "../src/pages/documents/PageList";

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
const WOW = "DOF-SER-001-S1"; // a podcast season in Pre-production, reviewed on the earlier checkpoints
const DOC = "DOF-DOC-001"; // a documentary in Development, not reviewed
const DEV = "DOF-DEV-001"; // a devotion in Development, not reviewed
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof RuleError && (!match || match.test(e.message)));
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");
const project = (id: string) => getDb().records.find((r) => r.contentId === id) as Project;
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

/** Names a reviewer on the season's brief, so its earlier review no longer counts: the review is waiting. */
function reviewWaiting(): string {
  const doc = D.ensureDocument(hop(), WOW, "Development", "show_brief");
  D.setDocumentReviewers(hop(), doc.id, ["DOF-P-CRW-002"]);
  return doc.id;
}

// ── Not a gate ───────────────────────────────────────────────

await t("the review is not a gate: a documentary's gates are its idea and the greenlight, which is recorded before the review", () => {
  assert.deepEqual(
    D.hardGates(DOC).map((g) => g.key),
    ["idea", "greenlight"],
  );
  W.saveFormSection(hop(), DOC, "brief", { logline: "Where the river ends.", coreQuestion: "Who keeps the water?" });
  W.decideGreenlight(hop(), DOC, { outcome: "Greenlight", notes: "" });
  assert.equal(D.theologyStatus(DOC).done, false, "greenlit, and the review still not done");
  assert.ok(D.reviewOutstanding(DOC));
  // Switched off, the review is a gate again; nothing in the data changed.
  setFeature(hop(), "reviewNotGate", false);
  assert.deepEqual(
    D.hardGates(DOC).map((g) => g.key),
    ["idea", "review", "greenlight"],
  );
  assert.equal(D.reviewOutstanding(DOC), null, "with the review a gate, there is no reminder");
  ok();
});

await t("a devotion is accepted without the review, and is reminded of it in Pre-production", () => {
  assert.deepEqual(
    D.hardGates(DEV).map((g) => g.key),
    ["guest", "pages"],
  );
  D.setGateOverride(hop(), DEV, "guest", "Confirmed by phone");
  D.setGateOverride(hop(), DEV, "pages", "Five more come on Monday");
  D.acceptDevotion(hop(), DEV, "");
  assert.equal(project(DEV).workflow.stage, "Pre-production");
  assert.equal(D.reviewOutstanding(DEV)?.contentId, DEV);
  ok();
});

// ── Where it stands ──────────────────────────────────────────

await t("a project and each of its episodes show the review not done, until it is approved", () => {
  assert.equal(D.reviewOutstanding(WOW), null, "reviewed on the earlier checkpoints");
  const doc = reviewWaiting();
  assert.equal(D.reviewOutstanding(WOW)?.contentId, WOW);
  assert.equal(D.reviewOutstanding(`${WOW}-E01`)?.contentId, WOW, "an episode answers for its project");
  assert.match(D.theologyStatus(WOW).detail, /0 of 1 reviewers have approved/);
  D.decideDocumentReview(crew(2), doc, { status: "approved", note: "" });
  assert.equal(D.reviewOutstanding(WOW), null);
  assert.equal(D.reviewOutstanding("DOF-LIVE-001"), null, "a live show has no theological review yet");
  assert.equal(D.reviewOutstanding(null), null);
});

await t("the urgency report watches the review until it is approved", () => {
  const doc = reviewWaiting();
  const row = () => urgencyReport(hop()).find((r) => r.id === WOW)!;
  assert.ok(row().reasons.includes("Theological review not done."));
  D.decideDocumentReview(crew(2), doc, { status: "approved", note: "" });
  assert.ok(!row().reasons.includes("Theological review not done."));
});

// ── Asked, never blocked ─────────────────────────────────────

await t("scheduling a session and publishing its call sheet go ahead without the review", () => {
  reviewWaiting();
  const s = W.createSession(hop(), WOW, { scheduledDate: "2026-10-20", venue: "DOF Studio A" });
  assert.equal(s.scheduledDate, "2026-10-20");
  const sheet = W.createSessionCallSheet(hop(), s.id);
  // Filed under the series, the sheet answers to its session's season, whose review is waiting: publishing it asks.
  assert.equal(sheet.contentId, "DOF-SER-001");
  assert.equal(D.sheetOwnerId(sheet), WOW);
  assert.equal(D.reviewOutstanding(D.sheetOwnerId(sheet))?.contentId, WOW);
  CS.updateCallSheet(hop(), sheet.id, { location: "DOF Studio A", crewPersonIds: ["DOF-P-CRW-002"], crewLeadId: "DOF-P-CRW-002" });
  CS.finalizeCallSheet(hop(), sheet.id);
  assert.equal(getDb().callSheets.find((c) => c.id === sheet.id)!.status, "final");
  ok();
});

await t("going ahead keeps who, what, when and the note with the project, and in the activity log", () => {
  reviewWaiting();
  const note = D.noteUnreviewed(crew(4), WOW, { action: "schedule", targetId: `${WOW}-R03`, note: "  The reviewer is back Tuesday  " });
  assert.ok(note);
  assert.deepEqual(
    { by: note!.byPersonId, action: note!.action, target: note!.targetId, note: note!.note },
    { by: "DOF-P-CRW-004", action: "schedule", target: `${WOW}-R03`, note: "The reviewer is back Tuesday" },
  );
  D.noteUnreviewed(hop(), `${WOW}-E01`, { action: "publish-episode", targetId: `${WOW}-E01`, note: "" });
  const kept = D.reviewNotesOf(project(WOW));
  assert.deepEqual(
    kept.map((n) => n.action),
    ["publish-episode", "schedule"],
    "newest first, an episode's note on its project",
  );
  assert.ok(
    getDb().audit.some((a) => a.action === "review-not-done" && /before the theological review was done: The reviewer/.test(a.detail)),
  );
  assert.equal(D.noteUnreviewed(hop(), WOW, { action: "schedule", targetId: "x", note: "a".repeat(400) })!.note.length, 300);
  throwsRule(() => D.noteUnreviewed(vol(), WOW, { action: "schedule", targetId: "x", note: "" }), /view-only|not found/i);
  ok();
});

await t("once the review is approved there is nothing to note", () => {
  assert.equal(D.noteUnreviewed(hop(), WOW, { action: "schedule", targetId: "x", note: "Ahead" }), null);
  assert.equal(project(WOW).workflow.aheadOfReview, undefined);
});

// ── After the approval ───────────────────────────────────────

await t("a page changed after the review approved it says so; the rest do not", () => {
  const doc = reviewWaiting();
  const pages = D.pagesOf(doc);
  assert.ok(pages.length >= 2);
  assert.equal(D.editedAfterApproval(doc).size, 0, "nothing approved yet");
  D.decideDocumentReview(crew(2), doc, { status: "approved", note: "" });
  // The test clock stands still: the pages were written at 04:00, approved at 05:00, and the change comes at 06:00.
  for (const pg of getDb().documentPages.filter((x) => x.documentId === doc)) pg.updatedAt = "2026-09-26T04:00:00.000Z";
  getDb().documentReviews.find((r) => r.documentId === doc)!.decidedAt = "2026-09-26T05:00:00.000Z";
  commit();
  D.savePage(hop(), pages[0].id, { bodyHtml: "<p>Changed after approval.</p>" }, pages[0].version);
  assert.deepEqual([...D.editedAfterApproval(doc)], [pages[0].id]);
  const list = html(hop(), <PageList doc={D.getDocument(doc)!} pages={D.pagesOf(doc)} selected={null} write onSelect={() => {}} />);
  assert.equal(list.split("Edited after approval").length - 1, 1, "on the changed page only");
});

// ── On screen ────────────────────────────────────────────────

await t("the project says the review is not done, above its home and every document, with a way to it", () => {
  reviewWaiting();
  D.noteUnreviewed(crew(4), WOW, { action: "publish-sheet", targetId: "DOF-CS-001", note: "Crew needed it today" });
  const page = html(hop(), <WorkflowProjectPage project={project(WOW)} />);
  for (const text of [
    "Theological review not done.",
    "0 of 1 reviewers have approved",
    "Open the review",
    "Gone ahead without it 1 time",
    "Published a call sheet (DOF-CS-001)",
    "Crew needed it today",
  ])
    assert.ok(page.includes(text), text);
  D.decideDocumentReview(hop(), D.documentOf(WOW, "Development", "show_brief")!.id, { status: "approved", note: "" });
  assert.ok(!html(hop(), <WorkflowProjectPage project={project(WOW)} />).includes("Theological review not done"));
});

await t("the board card says so too, on the project's card", () => {
  const card = () => html(hop(), <WorkCard item={allWorkItems().find((i) => i.level === "project" && i.id === DOC)!} />);
  assert.ok(card().includes("Theological review not done"));
  setFeature(hop(), "reviewNotGate", false);
  assert.ok(!card().includes("Theological review not done"), "as a gate, the card shows the gate instead");
});

await t("after Development the review can still be decided while it is not done; once approved it is kept as it was", () => {
  const doc = reviewWaiting();
  const panes = () =>
    html(
      hop(),
      <ReviewPanes project={project(WOW)} doc={D.getDocument(doc)} title="Show Brief" write pageId={null} onSelectPage={() => {}} />,
    );
  assert.ok(panes().includes("It can still be decided here"));
  assert.ok(panes().includes("Approve for every reviewer"));
  D.decideDocumentReview(crew(2), doc, { status: "approved", note: "" });
  assert.ok(panes().includes("The review was decided in Development, and is kept as it was."));
  assert.ok(!panes().includes("Approve for every reviewer"));
});

console.log(`\n${passed} passed`);
