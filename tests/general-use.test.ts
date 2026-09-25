// Run with: npx tsx tests/general-use.test.ts
// The "General Use" category: a placeholder project ID for storage, a call sheet, a document, or a
// gear checkout that has nowhere real to attach yet, and the "move it to a real project" actions.
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { login } from "../src/services/auth";
import { getRecord, visibleRecords } from "../src/services/access";
import * as C from "../src/services/content";
import * as CS from "../src/services/callsheets";
import * as D from "../src/services/docs";
import * as S from "../src/services/storage";
import * as E from "../src/services/equipment";
import { calendarEvents } from "../src/services/calendarView";
import { workloadFor } from "../src/services/workload";

let passed = 0;
const t = (name: string, fn: () => void) => { resetDemoData(); try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", e instanceof Error ? e.message : e); process.exitCode = 1; } };
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof Error && (!match || match.test(e.message)));
const hop = () => login("hop@dof.demo", "demo");

t("a General Use project gets a real Content ID, one trivial stage, and no risk or deadline tracking", () => {
  const p = C.createRecord(hop(), { category: "general", title: "Loaned to Kibera outreach" });
  assert.match(p.contentId, /^DOF-GEN-\d+$/);
  assert.equal(p.pipelineStage, "In use");
  assert.equal(C.riskOf(p), "ok");
  assert.equal(C.isStale(p), false);
});

t("it never shows up on the Calendar", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Standalone loan" });
  C.updateRecord(actor, p.contentId, { scheduledDate: "2026-10-01", deadline: "2026-10-10" });
  const events = calendarEvents(actor, "2026-09-01", "2026-11-01");
  assert.ok(!events.some((e) => e.open.n === "record" && "id" in e.open && e.open.id === p.contentId));
});

t("it never generates a reminder or shows up in anyone's workload", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Standalone loan", assigneePersonId: "DOF-P-CRW-001" });
  const reminders = C.getReminders(login("crew1@dof.demo", "demo"));
  assert.ok(!reminders.some((r) => r.record.contentId === p.contentId));
  const load = workloadFor("DOF-P-CRW-001", "2026-01-01", 30);
  assert.ok(!load.items.some((i) => i.contentId === p.contentId));
});

t("gear can be checked out against it, exactly like a real project", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Loaned to a partner church" });
  const m = E.createManifest(actor, { contentId: p.contentId, date: "2026-10-01", destination: "outside", status: "assigned", lines: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }] });
  assert.equal(m.contentId, p.contentId);
});

t("equipment's existing attach action moves a checkout from General Use onto a real project", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Temporary loan" });
  const m = E.createManifest(actor, { contentId: p.contentId, date: "2026-10-01", destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }] });
  const moved = E.attachManifest(actor, m.id, "DOF-SER-001");
  assert.equal(moved.contentId, "DOF-SER-001");
});

t("a storage entry moves from General Use onto a real project, keeping its space usage", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Unsorted footage" });
  const a = S.addAllocation(actor, { driveId: "DRV-001", contentId: p.contentId, sizeGB: 5, kind: "raw" });
  const moved = S.moveAllocation(actor, a.id, "DOF-SER-001");
  assert.equal(moved.contentId, "DOF-SER-001");
  assert.equal(moved.sizeGB, 5);
  throwsRule(() => S.moveAllocation(actor, a.id, "DOF-SER-001"), /already attached here/);
});

t("a call sheet moves from General Use onto a real project, and its gear moves with it", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Community day loan" });
  const cs = CS.createCallSheet(actor, { contentId: p.contentId, title: "Loan sheet", date: "2026-10-05" });
  const m = E.addGearToSheet(actor, { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }]);
  const moved = CS.attachCallSheet(actor, cs.id, "DOF-SER-001", cs.version);
  assert.equal(moved.contentId, "DOF-SER-001");
  const gear = E.manifestForSheet(cs.id)!;
  assert.equal(gear.id, m.id);
  assert.equal(gear.contentId, "DOF-SER-001", "the gear checkout follows the call sheet to its new project");
});

t("a document moves from General Use onto a real project", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Loose notes" });
  const doc = D.createDoc(actor, { contentId: p.contentId, title: "Notes" });
  const moved = D.attachDoc(actor, doc.id, "DOF-SER-001");
  assert.equal(moved.contentId, "DOF-SER-001");
  throwsRule(() => D.attachDoc(actor, doc.id, "DOF-SER-001"), /already attached here/);
});

t("moving something onto a General Use project works the same direction too", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Catch-all" });
  const doc = D.createDoc(actor, { contentId: "DOF-SER-001", title: "Misc" });
  const moved = D.attachDoc(actor, doc.id, p.contentId);
  assert.equal(moved.contentId, p.contentId);
});

t("moving to or from a project you cannot write to is refused", () => {
  const hopActor = hop();
  const outsider = login("volunteer1@dof.demo", "demo");
  const p = C.createRecord(hopActor, { category: "general", title: "HOP-only loan" });
  const doc = D.createDoc(hopActor, { contentId: p.contentId, title: "Notes" });
  throwsRule(() => D.attachDoc(outsider, doc.id, "DOF-SER-001"));
});

t("General Use projects are ordinary projects everywhere else: visible, creatable, and part of the normal category list", () => {
  const actor = hop();
  const p = C.createRecord(actor, { category: "general", title: "Findable loan" });
  assert.ok(visibleRecords(actor).some((r) => r.contentId === p.contentId));
  assert.ok(getRecord(p.contentId));
});

console.log(`\n${passed} passed`);
