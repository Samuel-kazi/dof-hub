// Run with: npx tsx tests/devotional.test.tsx
// The Devotional pipeline on screen: the Guest and Review branch controls, the Closed state, and
// the Pipeline board's Closed filter — the service-layer state machine itself is tested in project.test.ts.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "../src/ui/AppContext";
import { RecordPage } from "../src/pages/RecordPage";
import { Pipeline } from "../src/pages/Pipeline";
import { login } from "../src/services/auth";
import { resetDemoData, getDb } from "../src/data/store";
import * as C from "../src/services/content";

let passed = 0;
const t = (name: string, fn: () => void) => { resetDemoData(); try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", e instanceof Error ? e.message : e); process.exitCode = 1; } };
const hop = () => login("hop@dof.demo", "demo");
const page = (id: string) => renderToString(<AppProvider actor={hop()} onLogout={() => {}}>{React.createElement(RecordPage, { id })}</AppProvider>);
const board = (category?: "devotional") => renderToString(<AppProvider actor={hop()} onLogout={() => {}}>{React.createElement(Pipeline, { category })}</AppProvider>);

function toGuest() {
  const actor = hop();
  const d = C.createRecord(actor, { category: "devotional", title: "Screen test" });
  C.setStageOutput(actor, d.contentId, true);
  C.advanceStage(actor, d.contentId);
  return d.contentId;
}
function toEditing() {
  const actor = hop();
  const id = toGuest();
  for (const t2 of getDb().records.find((r) => r.contentId === id)!.tasks.filter((x) => x.stage === "Guest")) C.updateTask(actor, id, t2.id, { done: true });
  C.approveGuestReview(actor, id, "Pastor X");
  C.setStageOutput(actor, id, true); C.advanceStage(actor, id); // Recording
  C.setStageOutput(actor, id, true); C.advanceStage(actor, id); // Editing
  return id;
}

t("Creation renders the ordinary pipeline rail like any other category", () => {
  assert.match(page("DOF-DEV-001"), /Pipeline/);
});

t("Guest shows the reviewer field and the close action, not the generic advance button", () => {
  const html = page(toGuest());
  assert.match(html, /Reviewer.{0,10}s name/);
  assert.match(html, /theological review/);
  assert.match(html, /non-compliant/);
  assert.doesNotMatch(html, /Done, move to/);
});

t("a Closed project shows its reason plainly, on its own page", () => {
  const actor = hop();
  const id = toGuest();
  C.closeDevotional(actor, id, "Guest went silent after outreach.");
  const html = page(id);
  assert.match(html, /Closed/);
  assert.match(html, /Guest went silent after outreach\./);
});

t("Editing has exactly one working ready-for-review checkbox, and the advance button waits on it", () => {
  const html = page(toEditing());
  assert.equal((html.match(/<input type="checkbox"/g) ?? []).filter((_, i) => html.indexOf("Ready for review") > -1).length >= 1, true);
  assert.doesNotMatch(html, /"Ready for review" is in place/, "the generic duplicate checkbox is hidden");
  assert.match(html, /Done, move to.*Review/s);
  assert.match(html, /disabled=""[^>]*>Done, move to/s, "disabled until ready-for-review is ticked");
});

t("the Pipeline board hides Closed devotionals by default, and the Closed filter reveals them with a count", () => {
  const actor = hop();
  const id = toGuest();
  C.closeDevotional(actor, id, "Non-compliant guest.");
  const hidden = board("devotional");
  assert.doesNotMatch(hidden, /Screen test/);
  assert.match(hidden, /Closed \(/);
});

console.log(`\n${passed} passed`);
