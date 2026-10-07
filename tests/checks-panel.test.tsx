// Build prompt v4, section 14A: the collapsible Checks panel. One evaluator for every stage and kind (the same gates
// as the Done buttons), Required and Suggestions, Go to targets from configuration, dismissing with a note (kept on the
// project, shared with the Recording Log's chip), manual items ticked in the panel, Development gates passed by hand,
// and the slim bar and chips on the pages.
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor, Database } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { goForText } from "../src/config/checks";
import { login } from "../src/services/auth";
import * as C from "../src/services/wrapped/checks";
import * as D from "../src/services/wrapped/documents";
import * as W from "../src/services/wrapped/workflow";
import { ensureChecklist } from "../src/services/workflow/common";
import { AppProvider } from "../src/ui/AppContext";
import { ChecksPanel } from "../src/ui/ChecksPanel";
import { SessionPage } from "../src/pages/workflow/SessionPage";
import { WorkflowProjectPage } from "../src/pages/workflow/ProjectPage";
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
const WOW = "DOF-SER-001-S1";
const DEV = "DOF-DEV-001"; // a devotion in Development
const DOC = "DOF-DOC-001"; // a documentary in Development
const R1 = `${WOW}-R01`; // closed
const R2 = `${WOW}-R02`; // planned
const project = (id: string) => getDb().records.find((r) => r.contentId === id) as Project;
const keys = (items: C.CheckItem[]) => items.map((i) => i.key);

await t("Development: the hard gates are required, the handoff and nudges are suggestions, each says where it is fixed", () => {
  const c = C.projectChecks(DOC);
  assert.equal(c.ownerId, DOC);
  const gates = [...c.required, ...c.completed].filter((i) => i.gate);
  assert.deepEqual(
    gates.map((g) => g.gate!.key).sort(),
    D.hardGates(DOC)
      .map((g) => g.key)
      .sort(),
    "the same gates as the Done button",
  );
  assert.equal(c.required.filter((i) => i.gate).length, D.hardGates(DOC).filter((g) => !g.met && !g.override).length);
  const greenlight = gates.find((g) => g.gate!.key === "greenlight")!;
  assert.deepEqual(greenlight.go, { doc: { stage: "Development", key: "greenlight" } });
  const idea = gates.find((g) => g.gate!.key === "idea");
  if (idea) assert.equal(idea.go?.doc?.stage, "Development", "the idea gate goes to the kind's own brief");
  // The handoff's manual items are ticked in the panel; the derived ones are read-only.
  const handoff = [...c.suggestions, ...c.completed].filter((i) => i.manual?.list === "handoff");
  assert.deepEqual(handoff.map((i) => i.manual!.itemKey).sort(), [
    "outline_locked",
    "owner_resources",
    "producer_named",
    "project_created",
  ]);
  assert.ok(handoff.find((i) => i.manual!.itemKey === "project_created")!.done, "made with its Content ID");
  assert.ok(handoff.find((i) => i.manual!.itemKey === "producer_named")!.manual!.auto);
  assert.ok(!c.suggestions.some((i) => i.label.startsWith("Handoff:")), "the nudge that repeats the handoff is left out");
  assert.match(C.checksSummary(c), /^\d+ required(, \d+ suggestions?)?$/);
});

await t("passing a gate by hand moves it to Completed with its note; taking it back returns it", () => {
  const before = C.projectChecks(DOC);
  const gate = before.required.find((i) => i.gate?.overridable);
  assert.ok(gate, "an overridable gate is open");
  D.setGateOverride(hop(), DOC, gate.gate!.key as never, "Agreed at the planning meeting");
  const after = C.projectChecks(DOC);
  const done = after.completed.find((i) => i.key === gate.key)!;
  assert.ok(done.done && done.gate!.override);
  assert.match(done.reason, /Passed by hand: Agreed at the planning meeting/);
  assert.equal(after.required.length, before.required.length - 1);
  D.setGateOverride(hop(), DOC, gate.gate!.key as never, null);
  assert.ok(C.projectChecks(DOC).required.some((i) => i.key === gate.key));
  ok();
});

await t("a suggestion is dismissed with a note for everyone on the project, logged, and can be brought back", () => {
  const c = C.projectChecks(DOC);
  const s = c.suggestions.find((i) => !i.manual);
  assert.ok(s, `a nudge to dismiss: ${keys(c.suggestions).join(" | ")}`);
  C.dismissCheck(hop(), DOC, s.key, "  Not for this film  ");
  const after = C.projectChecks(DOC);
  assert.ok(!after.suggestions.some((i) => i.key === s.key));
  const gone = after.completed.find((i) => i.key === s.key)!;
  assert.equal(gone.dismissed!.note, "Not for this film");
  assert.equal(gone.dismissed!.byPersonId, hop().personId);
  assert.ok(getDb().audit.some((a) => a.action === "check-dismiss" && a.entityId === DOC && /Not for this film/.test(a.detail)));
  throwsRule(() => C.dismissCheck(hop(), DOC, s.key, "x".repeat(301)), /300/);
  C.restoreCheck(hop(), DOC, s.key);
  assert.ok(C.projectChecks(DOC).suggestions.some((i) => i.key === s.key));
  // Someone not on the project cannot.
  const outsider = login("volunteer1@dof.demo", "demo");
  throwsRule(() => C.dismissCheck(outsider, DOC, s.key, ""));
  ok();
});

await t("manual items are ticked in the panel with a note; derived ones refuse", () => {
  const p = project(WOW);
  assert.equal(p.workflow.stage, "Pre-production");
  // The sample season has its Pre-production list ticked: one is taken off again.
  C.setCheck(hop(), "preProject", WOW, "visual_plan", { done: false });
  const row = C.projectChecks(WOW).required.find((i) => i.manual?.itemKey === "visual_plan");
  assert.ok(row, "the visual plan is required in Pre-production");
  C.setCheck(hop(), "preProject", WOW, "visual_plan", { done: true, note: "Signed off" });
  const done = C.projectChecks(WOW).completed.find((i) => i.manual?.itemKey === "visual_plan")!;
  assert.ok(done.done);
  assert.equal(done.manual!.note, "Signed off");
  throwsRule(() => C.setCheck(hop(), "preProject", WOW, "roles_assigned", { done: true }), /worked out by the app/);
  throwsRule(() => C.setCheck(hop(), "preProject", WOW, "nope", { done: true }));
  ok();
});

await t("a planned session: its gate's needs go to their fields, its own and the project's manual items are ticked in place", () => {
  C.setCheck(hop(), "preProject", WOW, "visual_plan", { done: false });
  const c = C.sessionChecks(R2);
  const sheet = c.required.find((i) => /call sheet/i.test(i.label));
  assert.ok(sheet, keys(c.required).join(" | "));
  assert.deepEqual(sheet.go, { anchor: "session-call-sheet" });
  const rehearsal = c.required.find((i) => i.manual?.itemKey === "technical_rehearsal");
  assert.ok(rehearsal, "the technical rehearsal is a manual row");
  assert.equal(rehearsal.manual!.ownerId, R2);
  const visual = c.required.find((i) => i.manual?.itemKey === "visual_plan");
  assert.equal(visual?.manual!.ownerId, WOW, "the project's own Pre-production items, ticked from the session too");
  ensureChecklist("preSession", "session", R2);
  C.setCheck(hop(), "preSession", R2, "technical_rehearsal", { done: true });
  assert.ok(!C.sessionChecks(R2).required.some((i) => i.manual?.itemKey === "technical_rehearsal"));
  // A closed session has nothing left to move on.
  assert.equal(C.sessionChecks(R1).required.length, 0);
  ok();
});

await t("an open session: the Recording Log's chip shows the log's own checks, and a dismissal there is shared", () => {
  const s = getDb().recordingSessions.find((x) => x.id === R2)!;
  for (const pid of W.availableForLog(R2).slice(0, 2)) W.addLogRow(hop(), R2, { plannedEpisodeId: pid });
  s.status = "Open";
  ensureChecklist("wrap", "session", R2);
  commit();
  const log = C.recordingLogChecks(R2);
  assert.ok(log.required.some((i) => /At least one item recorded/.test(i.label)));
  const unmarked = log.suggestions.filter((i) => /^No take mark for/.test(i.label));
  assert.equal(unmarked.length, 2);
  assert.equal(unmarked[0].reason, "it counts as not recorded");
  assert.deepEqual(log.required[0].go, { anchor: "rl-recorded" });
  assert.ok(!log.suggestions.some((i) => i.manual), "the wrap is not the log's");
  const session = C.sessionChecks(R2);
  assert.ok(
    session.suggestions.some((i) => i.manual?.list === "wrap"),
    "the wrap is ticked in the session's panel",
  );
  C.dismissCheck(hop(), R2, unmarked[0].key, "Skipped on the day");
  assert.ok(!C.recordingLogChecks(R2).suggestions.some((i) => i.key === unmarked[0].key));
  assert.ok(!C.sessionChecks(R2).suggestions.some((i) => i.key === unmarked[0].key), "the same check, dismissed once");
  ok();
});

await t("an episode: what Editing needs goes to its links; Post production to its reviews", () => {
  const ep = getDb().records.find((r) => r.parentId === WOW && r.episode)!;
  ep.episode!.stage = "Post production";
  ep.episode!.postStage = "Editing";
  ep.episode!.readyForReview = false;
  ep.episode!.reviewLink = "";
  commit();
  const c = C.episodeChecks(ep.contentId);
  assert.ok(
    c.required.some((i) => /review link/.test(i.label) && i.go?.anchor === "episode-links"),
    keys(c.required).join(" | "),
  );
  assert.deepEqual(goForText("Rough cut review checkpoint Approved"), { anchor: "episode-reviews" });
  assert.deepEqual(goForText("At least one distribution link logged"), { anchor: "episode-release" });
  assert.deepEqual(goForText("Release plan: Cover art"), { anchor: "episode-release" });
});

await t("a call sheet's warnings are suggestions that go to their section", () => {
  const sheetId = W.createSessionCallSheet(hop(), R2).id;
  const sheet = getDb().callSheets.find((c) => c.id === sheetId)!;
  sheet.callTime = "";
  commit();
  const c = C.callSheetChecks(sheetId);
  assert.equal(c.required.length, 0, "a call sheet's checks never block");
  assert.ok(c.suggestions.length > 0);
  for (const i of c.suggestions) assert.match(i.go!.anchor!, /^sec-/);
  assert.equal(c.projectId, WOW);
});

await t("the bar: one line collapsed, the groups inside, announced counts; Done buttons point at it", () => {
  const out = html(hop(), <ChecksPanel kind="project" id={DOC} write />);
  const c = C.projectChecks(DOC);
  assert.ok(out.includes(`Checks: ${C.checksSummary(c)}`), "the summary on the bar");
  assert.match(out, /aria-expanded="false"/);
  assert.match(out, /aria-live="polite"/);
  assert.match(out, /<div[^>]*class="ck-pop"[^>]*hidden=""/, "collapsed by default");
  assert.ok(out.includes("Required to move on") && out.includes("Suggestions"));
  assert.ok(out.includes("Pass by hand…"), "the Head of Production may pass a gate by hand");
  assert.ok(out.includes('aria-label="Done: Outline locked"'), "a handoff item is a checkbox");
  // The chip in a call sheet's header.
  const sheetId = getDb().recordingSessions.find((x) => x.id === R1)!.callSheetId!;
  const chip = html(hop(), <ChecksPanel kind="sheet" id={sheetId} write chip label="Call sheet checks" />);
  assert.match(chip, /class="ck ck-chip"/);
  // The project page shows the bar under the stage tracker; Leave Development keeps only its button.
  const page = html(hop(), <WorkflowProjectPage project={project(DOC)} />);
  assert.ok(page.indexOf("Checks: ") > page.indexOf('aria-label="Where it stands"'));
  assert.ok(!page.includes('aria-label="What must be in place"'), "the old list is gone");
  assert.ok(page.includes("Done: move to Pre-production"));
  const sessionPage = html(hop(), <SessionPage id={R2} />);
  assert.match(sessionPage, /still needed: see Checks, at the top of the page/);
  assert.ok(!sessionPage.includes("Still needed:"));
  // Everything in place: green.
  const clear = html(hop(), <ChecksPanel kind="session" id={R1} write />);
  assert.match(clear, /ck-toggle clear/);
});

await t("a devotion in Development: Accept stays pressable and the panel says what is missing", () => {
  const c = C.projectChecks(DEV);
  assert.ok(C.acceptsAtDevelopment(project(DEV)));
  assert.ok([...c.required, ...c.completed].some((i) => i.gate));
});

console.log(`\n${passed} passed`);
