// Run with: npx tsx tests/rules.test.ts
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { RuleError } from "../src/types";
import { login } from "../src/services/auth";
import * as C from "../src/services/content";
import * as CS from "../src/services/callsheets";
import * as P from "../src/services/people";
import { canView, canWrite, visibleRecords, redactPerson } from "../src/services/access";
import { getRecord } from "../src/services/access";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof RuleError && (!match || match.test(e.message)));

const hop = () => login("hop@dof.demo", "demo");
const crew2 = () => login("crew2@dof.demo", "demo"); // Brian: SER-001, DOC-001
const crew3 = () => login("crew3@dof.demo", "demo"); // Faith: SER-001, LIVE-001, MUS-001
const vol = () => login("volunteer1@dof.demo", "demo");
const ptr = () => login("partner1@dof.demo", "demo");

t("login rejects bad password", () => throwsRule(() => login("hop@dof.demo", "nope")));

// Access control
t("crew can see every project, so they know what is going on", () => {
  const ids = visibleRecords(crew2()).map((r) => r.contentId);
  assert.ok(ids.includes("DOF-SER-001-S1-E02"));
  assert.ok(ids.includes("DOF-LIVE-001"), "a project they are not attached to");
  assert.ok(ids.includes("DOF-MUS-001-A1-T01"));
  assert.equal(ids.length, getDb().records.filter((r) => !r.archived).length);
});
t("volunteers still only see the projects they are attached to", () => {
  const ids = visibleRecords(login("volunteer1@dof.demo", "demo")).map((r) => r.contentId);
  assert.ok(ids.includes("DOF-SER-001-S1-E02")); assert.ok(!ids.includes("DOF-LIVE-001"));
});
t("head of production sees everything", () => assert.equal(visibleRecords(hop()).length, getDb().records.filter((r) => !r.archived).length));
t("volunteer is view-only", () => {
  const r = getRecord("DOF-SER-001-S1-E02")!;
  assert.ok(canView(vol(), r)); assert.ok(!canWrite(vol(), r));
  throwsRule(() => C.updateRecord(vol(), r.contentId, { title: "x" }), /view-only/);
});
t("partner can comment only where flagged, cannot edit", () => {
  const doc = getRecord("DOF-DOC-001")!;
  assert.ok(!canWrite(ptr(), doc));
  C.addComment(ptr(), "DOF-DOC-001", "Thanks");
  throwsRule(() => C.updateRecord(ptr(), "DOF-DOC-001", { title: "x" }));
  throwsRule(() => C.addComment(ptr(), "DOF-SER-001", "hi"), /not found/); // not attached
});
t("volunteer cannot comment", () => throwsRule(() => C.addComment(vol(), "DOF-SER-001", "hi"), /not comment/));
t("volunteer contact details are redacted for crew and volunteers", () => {
  const v = P.getPerson("DOF-P-VOL-001")!;
  assert.equal(redactPerson(crew2(), v).email, "Hidden");
  assert.notEqual(redactPerson(hop(), v).email, "Hidden");
});

// Hierarchy
t("child IDs nest and only leaves get stages", () => {
  const s = C.createChildRecord(hop(), "DOF-SER-001", { title: "Season 2" });
  assert.equal(s.contentId, "DOF-SER-001-S2"); assert.equal(s.hierarchyLevel, 1); assert.equal(s.pipelineStage, null);
  const e = C.createChildRecord(hop(), s.contentId, { title: "Pilot" });
  assert.equal(e.contentId, "DOF-SER-001-S2-E01"); assert.equal(e.hierarchyLevel, 2); assert.equal(e.pipelineStage, "Idea");
});
t("flat categories reject children", () => throwsRule(() => C.createChildRecord(hop(), "DOF-DEV-001", { title: "x" }), /cannot have children/));
t("new top-level IDs increment per category", () => {
  const r = C.createRecord(hop(), { category: "devotional", title: "Evening Light" });
  assert.equal(r.contentId, "DOF-DEV-002"); assert.equal(r.pipelineStage, "Creation");
});
t("crew cannot create a top-level project", () => throwsRule(() => C.createRecord(crew2(), { category: "live", title: "x" }), /Head of Production/));
t("live sessions have a different pipeline (no Ingest or Editorial)", () => {
  const show = C.createRecord(hop(), { category: "live", title: "L" });
  const r = getRecord(`${show.contentId}-D1`)!; // a live show is made of days, and each day carries the pipeline
  assert.equal(Object.keys(r.stageOutputs).includes("Ingest"), false);
  assert.equal(Object.keys(r.stageOutputs).includes("Show"), true);
});
t("rollup counts leaves", () => {
  const roll = C.getRollupStatus("DOF-SER-001");
  assert.equal(roll.total, 4); assert.equal(roll.complete, 0);
});
t("cannot delete a record with active children; can after archiving them", () => {
  throwsRule(() => C.deleteRecord(hop(), "DOF-SER-001-S1"), /active/);
  for (const c of C.getChildren("DOF-SER-001-S1")) C.deleteRecord(hop(), c.contentId);
  C.deleteRecord(hop(), "DOF-SER-001-S1");
  assert.equal(getRecord("DOF-SER-001-S1")!.archived, true);
});

// Stage gate
t("stage gate blocks advance until output is confirmed", () => {
  const id = "DOF-SER-001-S1-E02"; // at Recording
  throwsRule(() => C.advanceStage(crew2(), id), /Confirm/);
  C.setStageOutput(crew2(), id, true);
  const r = C.advanceStage(crew2(), id);
  assert.equal(r.pipelineStage, "Ingest");
});
t("cannot skip ahead: new stage starts unconfirmed", () => {
  const id = "DOF-SER-001-S1-E02";
  C.setStageOutput(crew2(), id, true); C.advanceStage(crew2(), id);
  throwsRule(() => C.advanceStage(crew2(), id), /Verified footage/);
});
t("final stage completes the item", () => {
  const id = "DOF-DOC-001"; // starts at Ingest; devotional now has its own publishing rules, tested separately
  const crew2 = login("crew2@dof.demo", "demo");
  for (let i = 0; i < 3; i++) {
    for (const tk of C.openTasks(getRecord(id)!)) C.updateTask(crew2, id, tk.id, { done: true }); // Editorial has a checklist
    C.setStageOutput(crew2, id, true);
    C.advanceStage(crew2, id);
  }
  C.setStageOutput(crew2, id, true);
  assert.ok(C.isComplete(getRecord(id)!));
});
t("optimistic concurrency rejects stale edits", () => {
  const r = getRecord("DOF-SER-001-S1-E02")!; const v = r.version;
  C.updateRecord(crew2(), r.contentId, { notes: "a" }, v);
  assert.throws(() => C.updateRecord(crew3(), r.contentId, { notes: "b" }, v), /Someone else changed/);
});
t("crew cannot edit a project they are not attached to", () => throwsRule(() => C.updateRecord(crew2(), "DOF-LIVE-001", { title: "x" })));
t("assigning a person to a record attaches them to the project", () => {
  C.updateRecord(hop(), "DOF-LIVE-001-D1", { assigneePersonId: "DOF-P-CRW-001" });
  assert.ok(getDb().members.some((m) => m.personId === "DOF-P-CRW-001" && m.projectContentId === "DOF-LIVE-001"));
});

// Reminders
t("reminders include overdue and due-soon stages for the assignee only", () => {
  const b = crew2().personId; // Brian owns the overdue documentary
  const rems = C.getReminders(crew2());
  assert.ok(rems.some((x) => x.record.contentId === "DOF-DOC-001"), "overdue doc");
  assert.ok(rems.every((x) => x.record.assigneePersonId === b));
});
t("overdue risk surfaces", () => assert.equal(C.riskOf(getRecord("DOF-DOC-001")!), "overdue"));

// Call sheets
t("call sheet button: existing sheet is returned, never a second one", () => {
  const before = getDb().callSheets.length;
  const res = CS.openOrCreateForRecord(crew2(), "DOF-SER-001-S1-E02");
  assert.equal(res.created, false); assert.equal(getDb().callSheets.length, before);
});
t("auto-link is scoped to the same project and date", () => {
  // Another project shoots on the same date; it must not leak in.
  const date = getRecord("DOF-SER-001-S1-E02")!.scheduledDate!;
  C.updateRecord(hop(), "DOF-LIVE-001-D1", { scheduledDate: date });
  const cs = CS.createCallSheet(hop(), { contentId: "DOF-SER-001", date });
  assert.deepEqual(cs.linkedEpisodeIds.sort(), ["DOF-SER-001-S1-E02", "DOF-SER-001-S1-E03"]);
});
t("changing an episode date flags a mismatch, does not silently relink", () => {
  const cs = getDb().callSheets[0];
  C.updateRecord(crew2(), "DOF-SER-001-S1-E03", { scheduledDate: "2099-01-01" });
  const mm = CS.getMismatches(cs);
  assert.equal(mm.moved.length, 1); assert.equal(cs.linkedEpisodeIds.length, 2);
  throwsRule(() => CS.finalizeCallSheet(crew2(), cs.id), /no longer match/);
  CS.resolveMismatches(crew2(), cs.id);
  assert.equal(CS.getCallSheet(cs.id)!.linkedEpisodeIds.length, 1);
});
t("duplicate carries crew but re-resolves episodes for the new date", () => {
  const src = getDb().callSheets[0];
  C.updateRecord(hop(), "DOF-SER-001-S1-E04", { scheduledDate: "2099-03-03" });
  const copy = CS.duplicateCallSheet(hop(), src.id, "2099-03-03").sheet;
  assert.deepEqual(copy.crewPersonIds, src.crewPersonIds);
  assert.deepEqual(copy.linkedEpisodeIds, ["DOF-SER-001-S1-E04"]);
});
t("finalize blocks crew double-booking", () => {
  const src = getDb().callSheets[0];
  const other = CS.duplicateCallSheet(hop(), src.id, src.date).sheet; // same date, same crew
  throwsRule(() => CS.finalizeCallSheet(hop(), other.id), /double-booked/);
});
t("final call sheets are locked", () => {
  const cs = getDb().callSheets[0];
  CS.finalizeCallSheet(crew2(), cs.id);
  throwsRule(() => CS.updateCallSheet(crew2(), cs.id, { notes: "x" }), /final/);
});
t("volunteer cannot create or edit call sheets", () => {
  throwsRule(() => CS.createCallSheet(vol(), { contentId: "DOF-SER-001", date: "2099-01-01" }));
});

// People
t("person IDs increment per prefix and never change on promotion", () => {
  const p = P.createPerson(hop(), { category: "VOL", name: "New Vol", email: "", phone: "", skills: [], equipmentFamiliarity: [] });
  assert.equal(p.personId, "DOF-P-VOL-003");
  P.updatePersonCategory(hop(), p.personId, "CRW");
  assert.equal(P.getPerson("DOF-P-VOL-003")!.category, "CRW");
  const c = P.createPerson(hop(), { category: "CRW", name: "New Crew", email: "", phone: "", skills: [], equipmentFamiliarity: [] });
  assert.equal(c.personId, "DOF-P-CRW-005");
});
t("promotion updates the login role too", () => {
  P.updatePersonCategory(hop(), "DOF-P-VOL-001", "CRW");
  assert.equal(getDb().users.find((u) => u.personId === "DOF-P-VOL-001")!.role, "CRW");
});
t("creating a person with a bad login creates nobody", () => {
  const n = getDb().people.length;
  throwsRule(() => P.createPerson(hop(), { category: "CRW", name: "X", email: "", phone: "", skills: [], equipmentFamiliarity: [] }, { email: "hop@dof.demo", password: "abcd" }), /already used/);
  assert.equal(getDb().people.length, n);
});
t("deactivated people cannot sign in but keep history", () => {
  P.deactivatePerson(hop(), "DOF-P-CRW-002");
  throwsRule(() => login("crew2@dof.demo", "demo"), /deactivated/);
  assert.equal(P.projectHistory("DOF-P-CRW-002").length, 2);
});
t("only the Head of Production manages people", () => throwsRule(() => P.createPerson(crew2(), { category: "VOL", name: "x", email: "", phone: "", skills: [], equipmentFamiliarity: [] })));

console.log(`\n${passed} passed`);
