// Run with: npx tsx tests/live-workflow.test.tsx
// The rebuilt live-show workflow, on screen: the post-production fork and the split-recording modal.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "../src/ui/AppContext";
import { RecordPage } from "../src/pages/RecordPage";
import { login } from "../src/services/auth";
import { resetDemoData, getDb } from "../src/data/store";
import { getRecord } from "../src/services/access";
import * as C from "../src/services/content";
import { categoryOf } from "../src/config/categories";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", e instanceof Error ? e.message : e); process.exitCode = 1; }
};
const hop = () => login("hop@dof.demo", "demo");
const html = (id: string) => renderToString(<AppProvider actor={hop()} onLogout={() => {}}><RecordPage id={id} /></AppProvider>);

function pushToStage(id: string, target: string) {
  const actor = hop();
  let r = getRecord(id)!;
  while (r.pipelineStage !== target) {
    for (const task of r.tasks.filter((x) => x.stage === r.pipelineStage)) C.updateTask(actor, id, task.id, { done: true });
    C.setStageOutput(actor, id, true, r.version);
    r = getRecord(id)!;
    C.advanceStage(actor, id, r.version);
    r = getRecord(id)!;
  }
}

t("a live day's pipeline rail shows the new stages in order", () => {
  const out = html("DOF-LIVE-001-D1");
  for (const stage of ["Prep", "Build", "Rehearse", "Show", "Wrap", "Review", "Post Production"]) assert.match(out, new RegExp(stage));
  assert.doesNotMatch(out, /Streaming/);
});

t("the post-production fork only appears once a day reaches Post Production", () => {
  assert.doesNotMatch(html("DOF-LIVE-001-D1"), /something was recorded/);
  pushToStage("DOF-LIVE-001-D1", "Post Production");
  assert.match(html("DOF-LIVE-001-D1"), /something was recorded/);
});

t("answering yes shows the split button and any recordings already split off", () => {
  pushToStage("DOF-LIVE-001-D1", "Post Production");
  C.setPostProductionNeeded(hop(), "DOF-LIVE-001-D1", true);
  const before = html("DOF-LIVE-001-D1");
  assert.match(before, /Split off a recording/);
  assert.match(before, /Split at least one recording/);
  const made = C.splitRecording(hop(), "DOF-LIVE-001-D1", { destCategory: "series", parentId: "DOF-SER-001-S1", title: "Sunday message" });
  const after = html("DOF-LIVE-001-D1");
  assert.match(after, new RegExp(made.contentId));
  assert.match(after, /Editorial/);
});

t("answering no does not ask for a split", () => {
  pushToStage("DOF-LIVE-002-D2", "Post Production");
  C.setPostProductionNeeded(hop(), "DOF-LIVE-002-D2", false);
  assert.doesNotMatch(html("DOF-LIVE-002-D2"), /Split off a recording/);
});

t("every live day and its spin-off destinations render without error across the pipeline", () => {
  for (const stage of categoryOf("live").stages.map((s) => s.name)) {
    pushToStage("DOF-LIVE-002-D4", stage);
    html("DOF-LIVE-002-D4");
  }
});

console.log(`\n${passed} passed`);

t("the show's own page shows its strike plan, but a day's page does not", () => {
  const showHtml = html("DOF-LIVE-002");
  assert.match(showHtml, /Strike plan/);
  assert.match(showHtml, /Cover cameras and lenses/);
  assert.match(showHtml, /Full rig: trusses/);
  assert.doesNotMatch(html("DOF-LIVE-002-D1"), /Strike plan/);
});

t("a show with no strike plan yet says so, without breaking Wrap for its days", () => {
  const show = C.createRecord(hop(), { category: "live", title: "New show" });
  assert.match(html(show.contentId), /No strike plan yet/);
  pushToStage(`${show.contentId}-D1`, "Wrap");
  const day = getRecord(`${show.contentId}-D1`)!;
  assert.deepEqual(C.openTasks(day), []);
});

t("saving a strike plan is reflected straight away on the show's page", () => {
  const show = C.createRecord(hop(), { category: "live", title: "Fresh show" });
  C.setStrikePlan(hop(), show.contentId, "daily", ["Pack cameras", "Coil cables"], ["Return the van"]);
  const out = html(show.contentId);
  assert.match(out, /Struck down every day\./);
  assert.match(out, /Pack cameras/);
  assert.match(out, /Return the van/);
});
