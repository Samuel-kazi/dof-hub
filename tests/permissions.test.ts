// Run with: npx tsx tests/permissions.test.ts
// What people can see and do, and how the Head of Production changes it.
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { RuleError } from "../src/types";
import { login } from "../src/services/auth";
import * as P from "../src/services/permissions";
import * as C from "../src/services/content";
import * as E from "../src/services/equipment";
import * as S from "../src/services/storage";
import * as Pe from "../src/services/people";
import * as W from "../src/services/workload";
import { updateSettings } from "../src/services/settings";
import { canView, canWrite, getRecord, redactPerson, visibleRecords } from "../src/services/access";
import { getPerson } from "../src/services/people";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof RuleError && (!match || match.test(e.message)));
const hop = () => login("hop@dof.demo", "demo");
const crew2 = () => login("crew2@dof.demo", "demo"); // Series, Documentary
const crew1 = () => login("crew1@dof.demo", "demo");
const vol = () => login("volunteer1@dof.demo", "demo");
const ptr = () => login("partner1@dof.demo", "demo");
const rec = (id: string) => getRecord(id)!;

t("the Head of Production can do everything, always", () => {
  for (const cap of ["pipeline.viewAll", "people.manage", "backend.audit", "reports.export"] as const) assert.equal(P.can(hop(), cap), true);
  assert.equal(P.grantFor("HOP", null, "backend.audit").source, "always");
});
t("crew start able to see everything and jump in, but not edit everywhere", () => {
  assert.equal(P.can(crew2(), "pipeline.viewAll"), true); assert.equal(P.can(crew2(), "pipeline.join"), true);
  assert.equal(P.can(crew2(), "pipeline.editAll"), false);
  assert.equal(P.can(vol(), "pipeline.viewAll"), false); assert.equal(P.can(ptr(), "reports.export"), false);
});
t("crew can see, but not edit, a project they are not attached to", () => {
  const live = rec("DOF-LIVE-001-D1");
  assert.equal(canView(crew2(), live), true); assert.equal(canWrite(crew2(), live), false);
  throwsRule(() => C.updateTask(crew2(), live.contentId, "T-0001", { done: true }), /view-only|not found/);
});
t("crew can see completed projects too", () => {
  const done = rec("DOF-DEV-001");
  Object.assign(done, { pipelineStage: "Delivered", stageOutputs: { ...done.stageOutputs, Delivered: true } });
  assert.ok(visibleRecords(crew2()).some((r) => r.contentId === "DOF-DEV-001"));
});
t("crew can jump in: adding themselves to a project they are not on makes them part of it", () => {
  assert.equal(getDb().members.some((m) => m.personId === "DOF-P-CRW-002" && m.projectContentId === "DOF-LIVE-001"), false);
  C.addStageOwner(crew2(), "DOF-LIVE-001-D1", "Show", "DOF-P-CRW-002", ["Camera operator"]);
  assert.ok(getDb().members.some((m) => m.personId === "DOF-P-CRW-002" && m.projectContentId === "DOF-LIVE-001"));
  assert.equal(canWrite(crew2(), rec("DOF-LIVE-001-D1")), true);
  C.addTask(crew2(), "DOF-LIVE-001-D1", { label: "Extra camera check" });
});
t("crew can jump in on a whole project, and on a completed one", () => {
  C.addStageOwner(crew2(), "DOF-LIVE-002", C.PROJECT_STAGE, "DOF-P-CRW-002", ["Runner"]);
  assert.equal(canWrite(crew2(), rec("DOF-LIVE-002")), true);
});
t("crew still cannot put other people on a project they are not attached to", () => {
  throwsRule(() => C.addStageOwner(crew2(), "DOF-LIVE-001-D1", "Show", "DOF-P-CRW-001", []), /view-only|change other people's work/);
});
t("taking away 'see every project' sends crew back to their own projects", () => {
  P.setRoleGrant(hop(), "CRW", "pipeline.viewAll", false);
  const ids = visibleRecords(crew2()).map((r) => r.contentId);
  assert.ok(ids.includes("DOF-SER-001-S1-E02")); assert.ok(!ids.includes("DOF-LIVE-001"));
  assert.equal(P.grantFor("CRW", "DOF-P-CRW-002", "pipeline.viewAll").source, "role");
});
t("one person can be given more than their role, or less", () => {
  P.setPersonGrant(hop(), "DOF-P-VOL-001", "pipeline.viewAll", true);
  assert.ok(visibleRecords(vol()).some((r) => r.contentId === "DOF-LIVE-001"));
  assert.equal(P.grantFor("VOL", "DOF-P-VOL-001", "pipeline.viewAll").source, "person");
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "pipeline.viewAll", false);
  assert.ok(!visibleRecords(crew2()).some((r) => r.contentId === "DOF-LIVE-001"));
  assert.ok(visibleRecords(crew1()).some((r) => r.contentId === "DOF-LIVE-001"), "other crew are unaffected");
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "pipeline.viewAll", null);
  assert.ok(visibleRecords(crew2()).some((r) => r.contentId === "DOF-LIVE-001"));
});
t("'edit any project' lets someone change a project without being attached", () => {
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "pipeline.editAll", true);
  assert.equal(canWrite(crew2(), rec("DOF-LIVE-001-D1")), true);
  C.updateRecord(crew2(), "DOF-LIVE-001-D1", { notes: "helped out" });
});
t("assigning other people's work and creating projects can be handed out", () => {
  throwsRule(() => C.createRecord(crew2(), { category: "devotional", title: "x" }), /Head of Production/);
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "pipeline.manage", true);
  assert.ok(C.createRecord(crew2(), { category: "devotional", title: "Made by crew" }));
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "pipeline.assign", true);
  C.addStageOwner(crew2(), "DOF-SER-001-S1-E04", "Recording", "DOF-P-CRW-003", ["Audio engineer"]);
});
t("crew do not see whether their colleagues have a login", () => {
  const colleague = getPerson("DOF-P-CRW-001")!;
  assert.equal(colleague.hasLogin, true);
  assert.equal(redactPerson(crew2(), colleague).hasLogin, false);
  assert.equal(redactPerson(hop(), colleague).hasLogin, true);
  assert.equal(redactPerson(crew1(), getPerson("DOF-P-CRW-001")!).hasLogin, true, "their own");
});
t("login status can be given to a person or a role", () => {
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "people.loginStatus", true);
  assert.equal(redactPerson(crew2(), getPerson("DOF-P-CRW-001")!).hasLogin, true);
  assert.equal(redactPerson(crew1(), getPerson("DOF-P-CRW-002")!).hasLogin, false);
});
t("volunteer contact details stay private until they are granted", () => {
  const v = getPerson("DOF-P-VOL-001")!;
  assert.equal(redactPerson(crew2(), v).email, "Hidden");
  P.setRoleGrant(hop(), "CRW", "people.contacts", true);
  assert.notEqual(redactPerson(crew2(), v).email, "Hidden");
});
t("taking away equipment access closes the module and the services", () => {
  assert.ok(P.modulesFor(crew2()).includes("equipment"));
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "equipment.use", false);
  assert.ok(!P.modulesFor(crew2()).includes("equipment"));
  throwsRule(() => E.listManifests(crew2()), /Equipment is managed/);
  assert.ok(P.modulesFor(crew1()).includes("equipment"));
});
t("retiring equipment and managing drives are separate permissions", () => {
  throwsRule(() => E.retireItem(crew2(), "DOF-EQ-AUD-002", "retired", ""), /Head of Production/);
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "equipment.admin", true);
  E.retireItem(crew2(), "DOF-EQ-AUD-002", "retired", "old");
  throwsRule(() => S.createDrive(crew2(), { name: "New", capacityGB: 1000 }), /Head of Production/);
  P.setRoleGrant(hop(), "CRW", "storage.admin", true);
  assert.ok(S.createDrive(crew2(), { name: "New", capacityGB: 1000 }));
});
t("people management, workload and back end access follow their permissions", () => {
  throwsRule(() => Pe.createPerson(crew2(), { category: "VOL", name: "X", email: "", phone: "" }), /Head of Production/);
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "people.manage", true);
  assert.ok(Pe.createPerson(crew2(), { category: "VOL", name: "Made by crew", email: "", phone: "" }));
  assert.deepEqual(W.crewWorkload(crew1()).map((x) => x.person.personId), ["DOF-P-CRW-001"]);
  P.setRoleGrant(hop(), "CRW", "workload.viewAll", true);
  assert.ok(W.crewWorkload(crew1()).length >= 3);
  throwsRule(() => updateSettings(crew1(), { stageReminderHours: 12 }), /Head of Production/);
  P.setPersonGrant(hop(), "DOF-P-CRW-001", "backend.settings", true);
  updateSettings(crew1(), { stageReminderHours: 12 });
});
t("only the Head of Production changes permissions, and never their own", () => {
  throwsRule(() => P.setRoleGrant(crew2(), "CRW", "pipeline.viewAll", false), /Head of Production/);
  throwsRule(() => P.setPersonGrant(crew2(), "DOF-P-CRW-001", "pipeline.viewAll", false), /Head of Production/);
  throwsRule(() => P.resetPermissions(crew2()), /Head of Production/);
  throwsRule(() => P.setRoleGrant(hop(), "HOP", "backend.audit", false), /always/);
  throwsRule(() => P.setPersonGrant(hop(), "DOF-P-HOP-001", "backend.audit", false), /always/);
});
t("every change is in the activity log, and can be reset", () => {
  P.setRoleGrant(hop(), "CRW", "pipeline.viewAll", false);
  P.setPersonGrant(hop(), "DOF-P-VOL-001", "reports.export", true);
  assert.deepEqual(P.customisations(), { roles: 1, people: 1 });
  assert.ok(getDb().audit.some((a) => a.action === "permission-role"));
  assert.ok(getDb().audit.some((a) => a.action === "permission-person"));
  P.resetPermissions(hop());
  assert.deepEqual(P.customisations(), { roles: 0, people: 0 });
  assert.equal(P.can(crew2(), "pipeline.viewAll"), true);
});
t("the effective settings say where each answer comes from", () => {
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "reports.export", false);
  const g = P.effectiveGrants("CRW", "DOF-P-CRW-002");
  assert.deepEqual(g["reports.export"], { value: false, source: "person" });
  assert.deepEqual(g["pipeline.viewAll"], { value: true, source: "default" });
});

console.log(`\n${passed} passed`);
