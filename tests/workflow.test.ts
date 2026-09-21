// Run with: npx tsx tests/workflow.test.ts
// Stage owners, stage checklists, links, documents, run of show, drives from a project, own profile.
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { ConflictError, RuleError } from "../src/types";
import { login } from "../src/services/auth";
import { isoDay } from "../src/data/seed";
import * as C from "../src/services/content";
import * as D from "../src/services/docs";
import * as CS from "../src/services/callsheets";
import * as S from "../src/services/storage";
import * as P from "../src/services/people";
import { getRecord } from "../src/services/access";
import { categoryOf } from "../src/config/categories";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof RuleError && (!match || match.test(e.message)));
const hop = () => login("hop@dof.demo", "demo");
const crew1 = () => login("crew1@dof.demo", "demo"); // Series, Devotional, Music
const crew2 = () => login("crew2@dof.demo", "demo"); // Series, Documentary
const crew3 = () => login("crew3@dof.demo", "demo"); // Series, Live, Music
const vol = () => login("volunteer1@dof.demo", "demo"); // Series
const rec = (id: string) => getRecord(id)!;

// ── Stage owners ──
const owners = (id: string, stage: string) => rec(id).stageAssignees[stage] ?? [];
t("a stage can have several owners, each with roles, and the first is responsible", () => {
  C.addStageOwner(hop(), "DOF-SER-001-S1-E04", "Scripting", "DOF-P-CRW-003", ["Script writer"]);
  C.addStageOwner(hop(), "DOF-SER-001-S1-E04", "Scripting", "DOF-P-CRW-002", ["Researcher", "Reviewer"]);
  assert.deepEqual(owners("DOF-SER-001-S1-E04", "Scripting").map((o) => o.personId), ["DOF-P-CRW-001", "DOF-P-CRW-003", "DOF-P-CRW-002"]);
  assert.deepEqual(owners("DOF-SER-001-S1-E04", "Scripting")[2].roles, ["Researcher", "Reviewer"]);
  assert.equal(rec("DOF-SER-001-S1-E04").assigneePersonId, "DOF-P-CRW-001");
});
t("a later stage can have owners without changing who is responsible now", () => {
  C.addStageOwner(hop(), "DOF-SER-001-S1-E04", "Recording", "DOF-P-CRW-002", ["Camera operator"]);
  assert.equal(rec("DOF-SER-001-S1-E04").assigneePersonId, "DOF-P-CRW-001");
});
t("roles are cleaned, and nobody is added twice", () => {
  C.addStageOwner(hop(), "DOF-SER-001-S1-E04", "Recording", "DOF-P-CRW-003", ["  Audio engineer ", "audio engineer", ""]);
  assert.deepEqual(owners("DOF-SER-001-S1-E04", "Recording")[0].roles, ["Audio engineer"]);
  throwsRule(() => C.addStageOwner(hop(), "DOF-SER-001-S1-E04", "Recording", "DOF-P-CRW-003", ["x"]), /already on Recording/);
  throwsRule(() => C.addStageOwner(hop(), "DOF-SER-001-S1-E04", "Recording", "DOF-P-CRW-002", ["a, b"]), /commas/);
});
t("roles can be changed and a person can be taken off", () => {
  C.setOwnerRoles(hop(), "DOF-SER-001-S1-E01", "Editorial", "DOF-P-CRW-003", ["Sound designer", "Mixer"]);
  assert.deepEqual(owners("DOF-SER-001-S1-E01", "Editorial")[1].roles, ["Sound designer", "Mixer"]);
  C.removeStageOwner(hop(), "DOF-SER-001-S1-E01", "Editorial", "DOF-P-CRW-003");
  assert.equal(owners("DOF-SER-001-S1-E01", "Editorial").length, 1);
});
t("removing the lead hands responsibility to the next owner", () => {
  C.removeStageOwner(hop(), "DOF-SER-001-S1-E01", "Editorial", "DOF-P-CRW-001");
  assert.equal(rec("DOF-SER-001-S1-E01").assigneePersonId, "DOF-P-CRW-003");
});
t("crew can add themselves to a stage even when others are on it, change their roles, and step off", () => {
  C.addStageOwner(crew2(), "DOF-SER-001-S1-E04", "Scripting", "DOF-P-CRW-002", ["Researcher"]);
  C.setOwnerRoles(crew2(), "DOF-SER-001-S1-E04", "Scripting", "DOF-P-CRW-002", ["Researcher", "Fact checker"]);
  assert.deepEqual(owners("DOF-SER-001-S1-E04", "Scripting").find((o) => o.personId === "DOF-P-CRW-002")!.roles, ["Researcher", "Fact checker"]);
  C.removeStageOwner(crew2(), "DOF-SER-001-S1-E04", "Scripting", "DOF-P-CRW-002");
  assert.ok(!owners("DOF-SER-001-S1-E04", "Scripting").some((o) => o.personId === "DOF-P-CRW-002"));
});
t("crew cannot change other people's work", () => {
  throwsRule(() => C.addStageOwner(crew2(), "DOF-SER-001-S1-E04", "Recording", "DOF-P-CRW-003", ["Audio"]), /change other people's work/);
  throwsRule(() => C.setOwnerRoles(crew2(), "DOF-SER-001-S1-E01", "Editorial", "DOF-P-CRW-001", ["x"]), /change other people's work/);
  throwsRule(() => C.removeStageOwner(crew2(), "DOF-SER-001-S1-E01", "Editorial", "DOF-P-CRW-001"), /change other people's work/);
});
t("volunteers cannot change owners, and crew outside a project can only add themselves", () => {
  throwsRule(() => C.addStageOwner(vol(), "DOF-SER-001-S1-E04", "Recording", "DOF-P-VOL-001", []), /view-only|only active crew|Head of Production/);
  throwsRule(() => C.addStageOwner(crew2(), "DOF-DEV-001", "Recording", "DOF-P-CRW-003", []), /view-only|change other people's work/);
});
t("only active crew can own a stage", () => throwsRule(() => C.addStageOwner(hop(), "DOF-SER-001-S1-E04", "Recording", "DOF-P-VOL-001", []), /active crew/));
t("moving to a stage hands responsibility to that stage's first owner", () => {
  const id = "DOF-SER-001-S1-E04";
  C.addStageOwner(hop(), id, "Pre-production", "DOF-P-CRW-002", ["Producer"]);
  C.setStageOutput(hop(), id, true);
  C.advanceStage(hop(), id);
  assert.equal(rec(id).assigneePersonId, "DOF-P-CRW-002");
});
t("with no owner set for the next stage, responsibility stays put", () => {
  const id = "DOF-SER-001-S1-E04";
  C.setStageOutput(hop(), id, true);
  C.advanceStage(hop(), id);
  assert.equal(rec(id).assigneePersonId, "DOF-P-CRW-001");
});
t("the whole project has a row for people who work across it, and adding them gives access", () => {
  C.addStageOwner(hop(), "DOF-DEV-001", C.PROJECT_STAGE, "DOF-P-CRW-003", ["Executive producer"]);
  assert.deepEqual(owners("DOF-DEV-001", C.PROJECT_STAGE)[0].roles, ["Executive producer"]);
  assert.ok(getDb().members.some((m) => m.personId === "DOF-P-CRW-003" && m.projectContentId === "DOF-DEV-001"));
  throwsRule(() => C.addStageOwner(hop(), "DOF-DEV-001", "Not a stage", "DOF-P-CRW-002", []), /does not exist/);
});
t("a stage owner is waiting on when their stage is current, and gets its reminders", () => {
  C.addStageOwner(hop(), "DOF-SER-001-S1-E04", "Scripting", "DOF-P-CRW-003", ["Script writer"]);
  assert.ok(C.getBlockedOnUser(crew3()).some((r) => r.contentId === "DOF-SER-001-S1-E04"));
});

// ── Checklists ──
t("editing has story lock, picture lock, sound check and color, each with a person and a date", () => {
  const tasks = C.tasksOf(rec("DOF-SER-001-S1-E01"));
  assert.deepEqual(tasks.map((x) => x.label), ["Story lock", "Picture lock", "Sound check", "Color"]);
  assert.ok(tasks.every((x) => x.dueDate));
  assert.equal(new Set(tasks.map((x) => x.assigneePersonId)).size, 3, "different crew members");
});
t("a stage cannot finish while its checklist is open", () => {
  const id = "DOF-SER-001-S1-E01";
  C.setStageOutput(hop(), id, true);
  throwsRule(() => C.advanceStage(hop(), id), /Finish Picture lock, Sound check, Color/);
  for (const tk of C.openTasks(rec(id))) C.updateTask(crew1(), id, tk.id, { done: true });
  C.advanceStage(hop(), id);
  assert.equal(rec(id).pipelineStage, "Review");
});
t("people can add their own checklist items, and remove them", () => {
  const id = "DOF-SER-001-S1-E01";
  const extra = C.addTask(crew1(), id, { label: "Subtitles", dueDate: isoDay(5), assigneePersonId: "DOF-P-CRW-003" });
  assert.equal(extra.stage, "Editorial"); assert.equal(extra.assigneePersonId, "DOF-P-CRW-003");
  throwsRule(() => C.addTask(crew1(), id, { label: "subtitles" }), /already has/);
  throwsRule(() => C.addTask(crew1(), id, { label: "  " }), /name/);
  C.removeTask(crew1(), id, extra.id);
  assert.ok(!rec(id).tasks.some((x) => x.label === "Subtitles"));
});
t("ticking records who and when; people outside the project cannot", () => {
  const id = "DOF-SER-001-S1-E01";
  const tk = C.openTasks(rec(id))[0];
  const done = C.updateTask(crew1(), id, tk.id, { done: true });
  assert.equal(done.doneBy, "DOF-P-CRW-001"); assert.ok(done.doneAt);
  throwsRule(() => C.updateTask(vol(), id, tk.id, { done: false }), /view-only/);
});
t("music recording is tracked as audio and video, each with its own owner and date", () => {
  const tasks = C.tasksOf(rec("DOF-MUS-001-A1-T01"));
  assert.deepEqual(tasks.map((x) => x.label), ["Audio recording", "Video recording"]);
  assert.notEqual(tasks[0].assigneePersonId, tasks[1].assigneePersonId);
});
t("music follows idea, pre-production, recording, audio post, video editing, review, publish", () => {
  assert.deepEqual(categoryOf("music").stages.map((s) => s.name), ["Idea", "Pre-production", "Recording", "Audio post-production", "Video editing", "Review", "Publish"]);
  assert.deepEqual(C.tasksOf(rec("DOF-MUS-001-A1-T01"), "Recording").length, 2);
});
t("a new project starts with the checklist and documents for its first stage", () => {
  const p = C.createRecord(hop(), { category: "series", title: "New show" });
  const ep = C.createChildRecord(hop(), C.createChildRecord(hop(), p.contentId, { title: "S1" }).contentId, { title: "Ep 1" });
  assert.equal(ep.pipelineStage, "Idea");
  assert.ok(getDb().docs.some((d) => d.contentId === ep.contentId && d.templateKey === "concept"));
});

// ── Links ──
t("review links can be posted at any stage", () => {
  const l = C.addLink(crew1(), "DOF-SER-001-S1-E04", { kind: "review", url: "https://example.com/cut" });
  assert.equal(l.stage, "Scripting");
  C.addLink(crew1(), "DOF-SER-001-S1-E04", { kind: "reference", stage: "Idea", url: "http://example.com/ref" });
  assert.equal(rec("DOF-SER-001-S1-E04").links.length, 2);
});
t("links need a real address", () => {
  throwsRule(() => C.addLink(crew1(), "DOF-SER-001-S1-E04", { kind: "review", url: "not a link" }), /http/);
  throwsRule(() => C.addLink(crew1(), "DOF-SER-001-S1-E04", { kind: "review", url: "" }), /Paste/);
});
t("the final link is only posted once the item reaches its publishing stage", () => {
  const id = "DOF-DEV-001";
  throwsRule(() => C.addLink(crew1(), id, { kind: "final", url: "https://youtu.be/x" }), /once this reaches Delivered/);
  for (let i = 0; i < 4; i++) { for (const tk of C.openTasks(rec(id))) C.updateTask(crew1(), id, tk.id, { done: true }); C.setStageOutput(crew1(), id, true); C.advanceStage(crew1(), id); }
  assert.equal(rec(id).pipelineStage, "Delivered");
  const l = C.addLink(crew1(), id, { kind: "final", url: "https://youtu.be/x" });
  assert.equal(l.stage, "Delivered");
  assert.ok(getDb().docs.some((d) => d.contentId === id && d.templateKey === "analysis"), "the publishing analysis document is attached");
});
t("an analysis note needs a link or some words", () => {
  throwsRule(() => C.addLink(crew1(), "DOF-DEV-001", { kind: "analysis" }), /link or write/);
  assert.ok(C.addLink(crew1(), "DOF-DEV-001", { kind: "analysis", note: "Retention drops at 2:10" }));
});
t("only the person who posted a link, or the Head of Production, removes it", () => {
  const l = C.addLink(crew1(), "DOF-SER-001-S1-E04", { kind: "review", url: "https://example.com/a" });
  throwsRule(() => C.removeLink(crew3(), "DOF-SER-001-S1-E04", l.id), /posted/);
  C.removeLink(hop(), "DOF-SER-001-S1-E04", l.id);
  assert.equal(rec("DOF-SER-001-S1-E04").links.length, 0);
});

// ── Documents ──
t("documents are attached once per stage, and never duplicated by going back and forth", () => {
  const id = "DOF-SER-001-S1-E04"; // in Scripting
  const before = getDb().docs.filter((d) => d.contentId === id).length;
  C.setStageOutput(hop(), id, true); C.advanceStage(hop(), id);
  assert.equal(getDb().docs.filter((d) => d.contentId === id).length, before + 1);
  C.sendBackStage(hop(), id); C.setStageOutput(hop(), id, true); C.advanceStage(hop(), id);
  assert.equal(getDb().docs.filter((d) => d.contentId === id).length, before + 1);
});
t("everyone on a project reads its documents; only crew on it edit", () => {
  const script = getDb().docs.find((d) => d.contentId === "DOF-SER-001-S1-E01" && d.templateKey === "script")!;
  assert.ok(D.canViewDoc(vol(), script)); assert.ok(!D.canEditDoc(vol(), script));
  assert.ok(D.canEditDoc(crew3(), script)); assert.ok(D.canEditDoc(hop(), script));
  const outside = getDb().docs.find((d) => d.contentId === "DOF-DEV-001")!;
  assert.ok(D.canViewDoc(crew2(), outside), "crew can read documents on every project");
  assert.ok(!D.canEditDoc(crew2(), outside), "but edit only where they are attached");
  assert.ok(!D.canViewDoc(vol(), outside), "volunteers only see documents on their projects");
  assert.ok(D.listDocs(vol()).every((d) => D.canViewDoc(vol(), d)));
  throwsRule(() => D.saveDoc(vol(), script.id, { body: "x" }, script.version), /read/);
});
t("every save is a revision, quick saves by one person merge, other people's saves do not", () => {
  const d = D.createDoc(crew1(), { contentId: "DOF-SER-001-S1-E04", title: "Notes", body: "one" });
  assert.equal(D.revisionsOf(d.id).length, 1);
  const a = D.saveDoc(crew1(), d.id, { body: "two" }, d.version);
  D.saveDoc(crew1(), d.id, { body: "three" }, a.version);
  assert.equal(D.revisionsOf(d.id).length, 2, "same person within ten minutes: one revision");
  const b = D.saveDoc(crew3(), d.id, { body: "four" }, D.getDoc(d.id)!.version);
  assert.equal(D.revisionsOf(d.id).length, 3);
  assert.equal(D.revisionsOf(d.id)[0].byPersonId, "DOF-P-CRW-003");
  assert.equal(b.body, "four");
});
t("two people editing at once cannot silently overwrite each other", () => {
  const d = D.createDoc(crew1(), { contentId: "DOF-SER-001-S1-E04", title: "Notes", body: "one" });
  const started = d.version; // what both editors opened
  D.saveDoc(crew3(), d.id, { body: "theirs" }, started);
  assert.throws(() => D.saveDoc(crew1(), d.id, { body: "mine" }, started), (e) => e instanceof ConflictError);
  assert.equal(D.getDoc(d.id)!.body, "theirs");
});
t("an earlier version can be restored, and the history keeps everything", () => {
  const script = getDb().docs.find((d) => d.contentId === "DOF-SER-001-S1-E01" && d.templateKey === "script")!;
  const revs = D.revisionsOf(script.id);
  assert.ok(revs.length >= 4);
  const first = revs.find((v) => v.body.includes("Cold open") && !v.body.includes("Thomas"))!;
  const before = revs.length;
  D.restoreRevision(crew1(), script.id, first.id);
  assert.equal(D.getDoc(script.id)!.body, first.body);
  assert.equal(D.revisionsOf(script.id).length, before + 1);
  assert.match(D.revisionsOf(script.id)[0].note, /Restored/);
});
t("the difference between two versions lists what was added and removed", () => {
  const diff = D.diffLines("a\nb\nc", "a\nc\nd");
  assert.deepEqual(diff.filter((l) => l.type !== "same").map((l) => `${l.type}:${l.text}`), ["del:b", "add:d"]);
});
t("archived documents leave the list but keep their history", () => {
  const d = D.createDoc(crew1(), { contentId: "DOF-SER-001-S1-E04", title: "Scrap" });
  D.archiveDoc(crew1(), d.id);
  assert.ok(!D.listDocs(hop()).some((x) => x.id === d.id));
  assert.equal(D.revisionsOf(d.id).length, 1);
});
t("documents can be started from a template, or blank, and need a project the person can edit", () => {
  const d = D.createDoc(crew1(), { contentId: "DOF-SER-001-S1-E04", templateKey: "analysis" });
  assert.match(d.title, /Publishing analysis/); assert.match(d.body, /Audience retention/);
  throwsRule(() => D.createDoc(crew2(), { contentId: "DOF-DEV-001", title: "x" }), /view-only/);
  throwsRule(() => D.createDoc(crew1(), { contentId: "DOF-SER-001-S1-E04" }), /title/);
});

// ── Level of production and run of show ──
t("only the days of a live show have a level of production", () => {
  C.updateRecord(hop(), "DOF-LIVE-001-D1", { productionLevel: "medium" });
  assert.equal(rec("DOF-LIVE-001-D1").productionLevel, "medium");
  throwsRule(() => C.updateRecord(hop(), "DOF-LIVE-001", { productionLevel: "large" }), /each day/);
  throwsRule(() => C.updateRecord(hop(), "DOF-DEV-001", { productionLevel: "large" }), /each day/);
});
t("a large production must have a run of show before its call sheet is final", () => {
  const day = C.createChildRecord(hop(), "DOF-LIVE-001", { title: "Day 2", scheduledDate: isoDay(20) });
  C.updateRecord(hop(), day.contentId, { productionLevel: "large" });
  const empty = CS.createCallSheet(crew3(), { contentId: "DOF-LIVE-001", date: isoDay(20) });
  assert.deepEqual(empty.linkedEpisodeIds, [day.contentId]);
  throwsRule(() => CS.finalizeCallSheet(crew3(), empty.id), /run of show/);
  CS.addRunItem(crew3(), empty.id, { time: "09:00", title: "Welcome", durationMin: 5 });
  assert.equal(CS.finalizeCallSheet(crew3(), empty.id).status, "final");
});
t("the seeded large production already has its run of show", () => {
  const cs = CS.getCallSheet("DOF-CS-002")!;
  assert.equal(CS.runOfShowRequired(cs), true);
  assert.equal(CS.sortedRunOfShow(cs)[0].title, "Stream opens: countdown and welcome loop");
  const totals = CS.runOfShowTotals(cs);
  assert.equal(totals.ends, "10:20"); assert.equal(totals.minutes, 110);
});
t("run of show segments are checked and can be edited or removed while the sheet is a draft", () => {
  const id = "DOF-CS-002";
  throwsRule(() => CS.addRunItem(crew3(), id, { time: "9:5", title: "x", durationMin: 5 }), /hours and minutes/);
  throwsRule(() => CS.addRunItem(crew3(), id, { time: "10:30", title: " ", durationMin: 5 }), /name/);
  throwsRule(() => CS.addRunItem(crew3(), id, { time: "10:30", title: "x", durationMin: -1 }), /minutes/);
  const it = CS.addRunItem(crew3(), id, { time: "10:20", title: "Sign off", durationMin: 5, ownerPersonId: "DOF-P-CRW-003" });
  CS.updateRunItem(crew3(), id, it.id, { durationMin: 10 });
  assert.equal(CS.getCallSheet(id)!.runOfShow.find((x) => x.id === it.id)!.durationMin, 10);
  CS.removeRunItem(crew3(), id, it.id);
  CS.finalizeCallSheet(crew3(), id);
  throwsRule(() => CS.addRunItem(crew3(), id, { time: "11:00", title: "Late", durationMin: 1 }), /final/);
});
t("small productions do not get a run of show until the day is set to large", () => {
  const day = C.createChildRecord(hop(), "DOF-LIVE-001", { title: "Day 3", scheduledDate: isoDay(25) });
  C.updateRecord(hop(), day.contentId, { productionLevel: "small" });
  const sheet = CS.createCallSheet(crew3(), { contentId: "DOF-LIVE-001", date: isoDay(25) });
  throwsRule(() => CS.addRunItem(crew3(), sheet.id, { time: "09:00", title: "x", durationMin: 5 }), /large productions/);
  C.updateRecord(hop(), day.contentId, { productionLevel: "large" });
  assert.ok(CS.addRunItem(crew3(), sheet.id, { time: "09:00", title: "x", durationMin: 5 }));
});
t("duplicating a call sheet copies the run of show", () => {
  const res = CS.duplicateCallSheet(crew3(), "DOF-CS-002", isoDay(9));
  assert.equal(res.sheet.runOfShow.length, 5);
  assert.notEqual(res.sheet.runOfShow[0].id, CS.getCallSheet("DOF-CS-002")!.runOfShow[0].id);
});

// ── Drives from the project ──
t("crew assign an episode to a drive and change the space any time", () => {
  const a = S.addAllocation(crew2(), { driveId: "DRV-003", contentId: "DOF-SER-001-S1-E02", sizeGB: 120, kind: "raw" });
  S.updateAllocation(crew2(), a.id, { sizeGB: 260 });
  assert.equal(getDb().allocations.find((x) => x.id === a.id)!.sizeGB, 260);
  assert.ok(S.allocationsForRecord(rec("DOF-SER-001-S1-E02")).some((x) => x.id === a.id));
});
t("an entry can move to another drive if it fits there", () => {
  const a = S.addAllocation(crew2(), { driveId: "DRV-003", contentId: "DOF-SER-001-S1-E02", sizeGB: 900, kind: "raw" });
  throwsRule(() => S.updateAllocation(crew2(), a.id, { driveId: "DRV-006" }), /only/); // that drive is nearly full
  S.updateAllocation(crew2(), a.id, { driveId: "DRV-005" });
  assert.equal(getDb().allocations.find((x) => x.id === a.id)!.driveId, "DRV-005");
});
t("raw footage is still protected when removed from a project page", () => {
  const a = S.addAllocation(crew2(), { driveId: "DRV-003", contentId: "DOF-SER-001-S1-E02", sizeGB: 50, kind: "raw" });
  throwsRule(() => S.removeAllocation(crew2(), a.id), /Delivered/);
});

// ── Own profile ──
t("anyone can correct their own name, but not their access level", () => {
  P.updateOwnProfile(hop(), { name: "Kevin Mwangi" });
  assert.equal(P.getPerson("DOF-P-HOP-001")!.name, "Kevin Mwangi");
  P.updateOwnProfile(vol(), { name: "Joseph K." });
  assert.equal(P.getPerson("DOF-P-VOL-001")!.category, "VOL");
  throwsRule(() => P.updateOwnProfile(hop(), { name: "  " }), /name/);
});

console.log(`\n${passed} passed`);
