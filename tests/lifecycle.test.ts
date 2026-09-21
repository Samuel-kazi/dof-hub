// Run with: npx tsx tests/lifecycle.test.ts
// Deleting a project clears everything attached to its Content ID.
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { RuleError } from "../src/types";
import { login } from "../src/services/auth";
import { isoDay } from "../src/data/seed";
import * as C from "../src/services/content";
import * as S from "../src/services/storage";
import * as E from "../src/services/equipment";
import * as D from "../src/services/docs";
import * as CS from "../src/services/callsheets";
import { searchAll } from "../src/services/search";
import { getRecord } from "../src/services/access";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof RuleError && (!match || match.test(e.message)));
const hop = () => login("hop@dof.demo", "demo");
const crew1 = () => login("crew1@dof.demo", "demo");
const crew2 = () => login("crew2@dof.demo", "demo");
const E01 = "DOF-SER-001-S1-E01"; // 780 GB of project files on Taji, four documents

t("deleting an episode clears its drive entries and frees the space", () => {
  const before = S.fleetTotals().used;
  const taji = S.driveUsage(S.getDrive("DRV-002")!).usedGB;
  C.deleteRecord(crew1(), E01);
  assert.ok(!getDb().allocations.some((a) => a.contentId === E01));
  assert.equal(S.fleetTotals().used, before - 780);
  assert.equal(S.driveUsage(S.getDrive("DRV-002")!).usedGB, taji - 780);
  assert.ok(!S.driveUsage(S.getDrive("DRV-002")!).projects.some((p) => p.contentId === E01));
});
t("the storage forecast follows straight away", () => {
  C.deleteRecord(crew1(), E01);
  const last = getDb().snapshots[getDb().snapshots.length - 1];
  assert.equal(last.date, isoDay(0));
  assert.equal(last.usedGB, S.fleetTotals().used);
});
t("its documents are archived, and their history is kept", () => {
  const mine = getDb().docs.filter((d) => d.contentId === E01);
  assert.equal(mine.length, 4);
  const revisions = getDb().docRevisions.filter((v) => mine.some((d) => d.id === v.docId)).length;
  C.deleteRecord(crew1(), E01);
  assert.ok(mine.every((d) => d.archived));
  assert.ok(!D.listDocs(hop()).some((d) => d.contentId === E01));
  assert.equal(getDb().docRevisions.filter((v) => mine.some((d) => d.id === v.docId)).length, revisions);
});
t("the confirmation lists what will go", () => {
  const impact = C.deletionImpact(crew1(), E01);
  assert.equal(impact.totalGB, 780); assert.equal(impact.docs, 4); assert.deepEqual(impact.drives, [{ driveName: "Taji", sizeGB: 780 }]);
  assert.match(C.deletionSummary(impact), /release 780 GB on Taji/);
  assert.match(C.deletionSummary(impact), /files on the drives are not touched/);
});
t("raw footage that is not delivered keeps crew from deleting the project, but not the Head of Production", () => {
  // Samburu Stories has raw footage on Added and is still at Ingest. Its gear must be back first.
  const lists = E.checkedOutFor("DOF-DOC-001");
  E.checkIn(crew2(), lists[0].id, lists[0].lines.map((l) => ({ equipmentId: l.equipmentId, returnedGood: 1, damaged: 0, lost: 0, conditionIn: l.conditionOut })));
  throwsRule(() => C.deleteRecord(crew2(), "DOF-DOC-001"), /Raw footage/);
  assert.ok(getDb().allocations.some((a) => a.contentId === "DOF-DOC-001"), "nothing changed");
  C.deleteRecord(hop(), "DOF-DOC-001");
  assert.ok(!getDb().allocations.some((a) => a.contentId === "DOF-DOC-001"));
  assert.equal(getRecord("DOF-DOC-001")!.archived, true);
});
t("gear that is out stops the deletion until it is back", () => {
  throwsRule(() => C.deleteRecord(hop(), "DOF-DOC-001"), /checked out/);
  assert.equal(getRecord("DOF-DOC-001")!.archived, false);
});
t("reserved gear and call sheets go with the project", () => {
  const p = C.createRecord(hop(), { category: "devotional", title: "Short-lived" });
  const sheet = CS.createCallSheet(hop(), { contentId: p.contentId, date: isoDay(30) });
  E.addGearToSheet(hop(), { id: sheet.id, contentId: p.contentId, date: sheet.date }, [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }]);
  assert.equal(E.displayStatus(E.getItem("DOF-EQ-AUD-002")!).label, "Assigned");
  const impact = C.deletionImpact(hop(), p.contentId);
  assert.equal(impact.sheets, 1); assert.equal(impact.gearLists, 1);
  C.deleteRecord(hop(), p.contentId);
  assert.equal(E.displayStatus(E.getItem("DOF-EQ-AUD-002")!).label, "Available");
  assert.ok(!CS.getCallSheet(sheet.id));
  assert.equal(E.itemHistory("DOF-EQ-AUD-002")[0].kind, "released");
});
t("a deletion that is blocked changes nothing", () => {
  const before = JSON.stringify([getDb().allocations, getDb().docs, getDb().manifests]);
  throwsRule(() => C.deleteRecord(hop(), "DOF-DOC-001"));
  assert.equal(JSON.stringify([getDb().allocations, getDb().docs, getDb().manifests]), before);
});
t("a project with active episodes still cannot be deleted", () => throwsRule(() => C.deleteRecord(hop(), "DOF-SER-001"), /active/));
t("a record can be cleared from the drives without being deleted", () => {
  const res = S.clearRecordFromDrives(crew1(), E01);
  assert.equal(res.gb, 780); assert.equal(getRecord(E01)!.archived, false);
  assert.ok(!getDb().allocations.some((a) => a.contentId === E01));
  throwsRule(() => S.clearRecordFromDrives(crew1(), E01), /Nothing is recorded/);
});
t("clearing keeps the raw footage rule", () => throwsRule(() => S.clearRecordFromDrives(crew2(), "DOF-DOC-001"), /Delivered/));
t("the Content ID finds the documents that belong to it", () => {
  const hits = searchAll(hop(), E01).filter((h) => h.kind === "doc");
  assert.equal(hits.length, 4);
});

console.log(`\n${passed} passed`);
