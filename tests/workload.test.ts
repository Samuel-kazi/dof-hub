// Run with: npx tsx tests/workload.test.ts
// Capacity: how much each person has on, day by day. All dates are fixed, so the results never depend on today.
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { login } from "../src/services/auth";
import * as C from "../src/services/content";
import * as CS from "../src/services/callsheets";
import * as E from "../src/services/equipment";
import * as W from "../src/services/workload";
import { updateSettings } from "../src/services/settings";
import { getRecord } from "../src/services/access";
import { effortFor } from "../src/config/capacity";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};
const hop = () => login("hop@dof.demo", "demo");
const crew1 = () => login("crew1@dof.demo", "demo");
const crew2 = () => login("crew2@dof.demo", "demo");
const B = "DOF-P-CRW-002"; // Brian
const F = "DOF-P-CRW-003"; // Faith
const MON = "2030-01-07"; // a Monday

/** A clean slate: nothing else is happening, so only what a test creates counts. */
function clean() {
  const db = getDb();
  db.records.forEach((r) => (r.archived = true));
  db.callSheets = [];
  db.manifests = [];
}

/** An episode sitting in Editorial, with the given deadline and owners. */
function editorial(deadline: string, ownersList: string[] = [B], fresh = true) {
  if (fresh) clean();
  const show = C.createRecord(hop(), { category: "series", title: "Test show" });
  const season = C.createChildRecord(hop(), show.contentId, { title: "S1" });
  const ep = C.createChildRecord(hop(), season.contentId, { title: "Ep 1" });
  Object.assign(ep, { pipelineStage: "Editorial", stageOutputs: { Idea: true, Scripting: true, "Pre-production": true, Recording: true, Ingest: true }, stageDeadlines: { Editorial: deadline, Review: deadline, Delivered: deadline }, scheduledDate: null });
  ep.tasks = [];
  for (const p of ownersList) C.addStageOwner(hop(), ep.contentId, "Editorial", p, ["Editor"]);
  return ep;
}
const day = (who: string, date: string, asOf = MON) => W.workloadFor(who, asOf, 14).days.find((d) => d.date === date)!;

t("finishing a series cut takes two days when the person has nothing else on", () => {
  assert.equal(effortFor("series", "Editorial"), 2);
  editorial("2030-01-08"); // Monday and Tuesday
  assert.equal(day(B, "2030-01-07").load, 1); assert.equal(day(B, "2030-01-08").load, 1);
  assert.equal(day(B, "2030-01-07").status, "busy"); // full, but not over
  assert.equal(day(B, "2030-01-09").load, 0);
});
t("with only one day to do it, the cut is more than one person can do", () => {
  editorial("2030-01-07");
  assert.equal(day(B, "2030-01-07").load, 2);
  assert.equal(day(B, "2030-01-07").status, "over");
  assert.deepEqual(W.workloadFor(B, MON, 14).overDays, ["2030-01-07"]);
});
t("more time spreads the same work thinner", () => {
  editorial("2030-01-11"); // five working days
  assert.equal(day(B, "2030-01-07").load, 0.4); assert.equal(day(B, "2030-01-07").status, "free");
});
t("a second owner splits the work between them", () => {
  editorial("2030-01-07", [B, F]);
  assert.equal(day(B, "2030-01-07").load, 1); assert.equal(day(F, "2030-01-07").load, 1);
});
t("weekends do not count as time to work", () => {
  editorial("2030-01-13", [B]); // due Sunday
  const w = W.workloadFor(B, "2030-01-11", 5); // asked from Friday
  assert.equal(w.days[0].load, 2); assert.equal(w.days[1].load, 0); assert.equal(w.days[1].status, "off");
});
t("a shoot day on a call sheet takes the whole day, and stacks with editing", () => {
  const ep = editorial("2030-01-08");
  const sheet = CS.createCallSheet(hop(), { contentId: getRecord(ep.contentId)!.contentId.split("-").slice(0, 3).join("-"), date: "2030-01-08", crewPersonIds: [B] });
  assert.ok(sheet.id);
  const d = day(B, "2030-01-08");
  assert.equal(d.load, 2); assert.equal(d.status, "over");
  assert.equal(d.parts.filter((p) => p.item.kind === "shoot").length, 1);
});
t("a booked shoot with no call sheet still takes the crew's day", () => {
  clean();
  const show = C.createRecord(hop(), { category: "devotional", title: "Morning" });
  Object.assign(show, { pipelineStage: "Scripting", scheduledDate: "2030-01-09" });
  C.addStageOwner(hop(), show.contentId, "Recording", B, ["Camera operator"]);
  assert.equal(day(B, "2030-01-09").load, 1);
  assert.equal(day(B, "2030-01-09").parts[0].item.kind, "shoot");
});
t("being away with gear takes the whole day, weekends included", () => {
  clean();
  const show = C.createRecord(hop(), { category: "documentary", title: "Field" });
  E.createManifest(hop(), { contentId: show.contentId, date: "2030-01-12", expectedReturn: "2030-01-14", destination: "outside", status: "assigned", responsiblePersonId: B, lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }] });
  assert.equal(day(B, "2030-01-12").load, 1); assert.equal(day(B, "2030-01-12").workDay, false);
  assert.equal(day(B, "2030-01-14").load, 1);
  assert.equal(day(B, "2030-01-15").load, 0);
});
t("a stage that is already late becomes catch-up work from today", () => {
  editorial("2030-01-01");
  const w = W.workloadFor(B, MON, 14);
  assert.ok(w.items[0].late);
  assert.equal(day(B, "2030-01-07").load, 1); assert.equal(day(B, "2030-01-08").load, 1); assert.equal(day(B, "2030-01-09").load, 0);
});
t("checklist items go to the person they are given to, and done items are not counted", () => {
  const ep = editorial("2030-01-08", [B]);
  ep.tasks = [];
  for (const [label, who] of [["Story lock", B], ["Picture lock", B], ["Sound check", F], ["Color", F]] as const) C.addTask(hop(), ep.contentId, { label, assigneePersonId: who, dueDate: "2030-01-08" });
  assert.equal(W.workloadFor(B, MON, 14).items.reduce((n, i) => n + i.effort, 0), 1); // two of four tasks, half a day each
  C.updateTask(hop(), ep.contentId, ep.tasks[0].id, { done: true });
  assert.equal(W.workloadFor(B, MON, 14).items.reduce((n, i) => n + i.effort, 0), 0.5);
});
t("a stage whose output is confirmed has nothing left to do", () => {
  const ep = editorial("2030-01-08");
  ep.stageOutputs.Editorial = true;
  assert.equal(day(B, "2030-01-07").load, 0);
});
t("later stages are planned in the time between the earlier deadlines", () => {
  const ep = editorial("2030-01-08");
  ep.stageDeadlines = { Editorial: "2030-01-08", Review: "2030-01-10", Delivered: "2030-01-11" };
  C.addStageOwner(hop(), ep.contentId, "Review", B, ["Reviewer"]);
  // Review is half a day, between Wednesday and Thursday
  assert.equal(day(B, "2030-01-08").load, 1);
  assert.equal(day(B, "2030-01-09").load, 0.25); assert.equal(day(B, "2030-01-10").load, 0.25);
});
t("filming, recording and streaming stages are not counted as desk work", () => {
  clean();
  const show = C.createRecord(hop(), { category: "devotional", title: "Rec" });
  Object.assign(show, { pipelineStage: "Recording", stageDeadlines: { Recording: "2030-01-08", Editorial: "2030-01-12" }, scheduledDate: null });
  C.addStageOwner(hop(), show.contentId, "Recording", B, ["Camera operator"]);
  assert.equal(day(B, "2030-01-07").load, 0);
});
t("work with no date cannot be scheduled and is listed", () => {
  const ep = editorial("2030-01-08");
  ep.stageDeadlines = {};
  assert.equal(W.workloadFor(B, MON, 14).undated.length, 1);
});
t("work that cannot fit is reported with what it needs and what is free", () => {
  editorial("2030-01-08");
  editorial("2030-01-08", [B], false); // a second edit, same person, same days
  const risks = W.assignmentRisks(B, MON);
  assert.ok(risks.length >= 1);
  assert.match(risks[0].reason, /needs 2 days but only/);
  assert.ok(risks[0].shortfall > 0.9);
});
t("work that fits is not reported", () => {
  editorial("2030-01-11");
  assert.deepEqual(W.assignmentRisks(B, MON), []);
});
t("free days before a date count what is left after everything else", () => {
  editorial("2030-01-11");
  assert.equal(W.freeDaysBefore(F, "2030-01-11", MON), 5);
  assert.equal(Math.round(W.freeDaysBefore(B, "2030-01-11", MON) * 10) / 10, 3); // five days, two taken by the cut
});
t("giving someone too much comes with a warning naming the days", () => {
  editorial("2030-01-07");
  const msg = W.overloadWarning(B, MON)!;
  assert.match(msg, /Brian Otieno is over capacity on/);
  assert.equal(W.overloadWarning(F, MON), null);
});
t("the working days and the estimates can be changed in settings", () => {
  editorial("2030-01-14");
  updateSettings(hop(), { effortOverrides: { "series:Editorial": 3 } });
  assert.equal(Math.round(day(B, "2030-01-07").load * 100) / 100, 0.5); // three days over six working days
  updateSettings(hop(), { workDays: [1, 2, 3, 4, 5, 6] });
  assert.equal(day(B, "2030-01-12").workDay, true);
});
t("settings are checked", () => {
  assert.throws(() => updateSettings(hop(), { workDays: [] }), /at least one/);
  assert.throws(() => updateSettings(hop(), { effortOverrides: { "series:Editorial": 2.3 } }), /quarter day/);
  assert.throws(() => updateSettings(hop(), { effortOverrides: { "series:Editorial": -1 } }), /0 to 30/);
  assert.throws(() => updateSettings(crew1(), { workDays: [1] }), /Head of Production/);
});
t("the Head of Production sees every crew member's load; crew see only their own", () => {
  editorial("2030-01-08");
  assert.ok(W.crewWorkload(hop(), MON).length >= 3);
  assert.deepEqual(W.crewWorkload(crew2(), MON).map((x) => x.person.personId), [B]);
  assert.equal(W.canSeeWorkload(crew1(), B), false); assert.equal(W.canSeeWorkload(crew2(), B), true); assert.equal(W.canSeeWorkload(hop(), B), true);
});
t("the crew list puts the most stretched first", () => {
  editorial("2030-01-07");
  assert.equal(W.crewWorkload(hop(), MON)[0].person.personId, B);
});

console.log(`\n${passed} passed`);
