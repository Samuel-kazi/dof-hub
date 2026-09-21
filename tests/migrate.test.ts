// Run with: npx tsx tests/migrate.test.ts
// Saved data from earlier phases must open in the current version with nothing lost.
// The store loads when it is first imported, so each starting version runs in its own process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildSeed } from "../src/data/seed";

const from = process.env.MIGRATE_FROM;

if (!from) {
  for (const v of ["1", "2", "4", "5"]) {
    const r = spawnSync("npx", ["tsx", "tests/migrate.test.ts"], { env: { ...process.env, MIGRATE_FROM: v }, encoding: "utf8" });
    process.stdout.write(r.stdout);
    if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  }
  process.exit(0);
}

// Build a saved database the way an older phase would have written it.
const old: Record<string, unknown> = { ...(buildSeed() as unknown as Record<string, unknown>) };
type Rec = Record<string, unknown>;
let records = old.records as Rec[];
(records[0] as { title: string }).title = "Edited before the upgrade";
// A project deleted before version 4 left its drive entry behind.
if (from === "1" || from === "2") (records.find((r) => r.contentId === "DOF-DEV-001") as { archived: boolean }).archived = true;

if (from !== "5") {
  // Before version 5 a live show was one flat item that carried its own pipeline, and records had no show dates or hosts.
  const day = records.find((r) => r.contentId === "DOF-LIVE-001-D1")!;
  const show = records.find((r) => r.contentId === "DOF-LIVE-001")!;
  Object.assign(show, { ...day, contentId: "DOF-LIVE-001", title: "Sunday Live Service", parentId: null, hierarchyLevel: 0 });
  records = records.filter((r) => !String(r.contentId).startsWith("DOF-LIVE-001-") && !String(r.contentId).startsWith("DOF-LIVE-002"));
  old.records = records;
  for (const r of records) { delete r.featured; delete r.showStart; delete r.showEnd; }
  for (const d of old.docs as { contentId: string }[]) if (d.contentId === "DOF-LIVE-001-D1") d.contentId = "DOF-LIVE-001";
  old.docs = (old.docs as { contentId: string }[]).filter((d) => !d.contentId.startsWith("DOF-LIVE-002"));
  for (const c of old.callSheets as { linkedEpisodeIds: string[] }[]) c.linkedEpisodeIds = c.linkedEpisodeIds.map((x) => (x === "DOF-LIVE-001-D1" ? "DOF-LIVE-001" : x));
}
// Before version 6 a stage had one owner, kept as a single ID, and there were no working-day settings.
for (const r of records) {
  const owners = (r.stageAssignees ?? {}) as Record<string, { personId: string }[]>;
  r.stageAssignees = Object.fromEntries(Object.entries(owners).filter(([k]) => k !== "Project").map(([k, list]) => [k, list[0]?.personId]).filter(([, v]) => v));
}
old.settings = { stageReminderHours: 24, storageWarningThreshold: 85, checkoutReturnDays: 3 };
old.schemaVersion = from === "5" ? 5 : 4;

if (from === "1" || from === "2") {
  for (const r of records) { delete r.stageAssignees; delete r.tasks; delete r.links; delete r.productionLevel; }
  for (const c of old.callSheets as Record<string, unknown>[]) delete c.runOfShow;
  delete old.docs; delete old.docRevisions;
  // Music used to have Writing, Mixing, Mastering and Delivered.
  const mus = records.find((r) => r.contentId === "DOF-MUS-001-A1-T02")!;
  mus.pipelineStage = "Writing";
  mus.stageOutputs = { Idea: true, Writing: false, "Pre-production": false, Recording: false, Mixing: false, Mastering: false, Delivered: false };
  mus.stageDeadlines = { Idea: "2030-01-01", Writing: "2030-01-05", "Pre-production": "2030-01-09", Recording: "2030-01-13", Mixing: "2030-01-17", Mastering: "2030-01-21", Delivered: "2030-01-25" };
  old.schemaVersion = 2;
  old.settings = { stageReminderHours: 12, storageWarningThreshold: 85, checkoutReturnDays: 3 };
  if (from === "1") {
    for (const k of ["equipment", "manifests", "incidents", "equipmentHistory", "drives", "allocations", "snapshots"]) delete old[k];
    old.schemaVersion = 1;
    old.settings = { stageReminderHours: 12 };
    (old.callSheets as { id: string }[]).splice(0, 1); // the user deleted the sample call sheet
  }
}

const store: Record<string, string> = { "dof-hub-db": JSON.stringify(old) };
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
};
const { getDb } = await import("../src/data/store");
const { categoryOf } = await import("../src/config/categories");

const db = getDb();
assert.equal(db.schemaVersion, 7);
assert.deepEqual(db.outbox, [], "the record of sent reminders exists");
assert.equal(db.records[0].title, "Edited before the upgrade", "earlier edits survive");
assert.ok(db.equipment.length > 10 && db.drives.length === 9, "gear and drives exist");
if (from === "1" || from === "2") {
  assert.equal(db.settings.stageReminderHours, 12, "existing settings kept");
  assert.equal(db.settings.checkoutReturnDays, 3, "new settings get defaults");
}
assert.ok(db.records.every((r) => Array.isArray(r.tasks) && Array.isArray(r.links) && typeof r.stageAssignees === "object"), "every record has the new fields");
assert.ok(db.callSheets.every((c) => Array.isArray(c.runOfShow)));
assert.ok(db.manifests.every((m) => !m.callSheetId || db.callSheets.some((c) => c.id === m.callSheetId)), "no checkout list points at a deleted call sheet");
// Music items land on a stage that exists, with outputs for every stage.
if (from === "1" || from === "2") {
  const stages = categoryOf("music").stages.map((s) => s.name);
  const t02 = db.records.find((r) => r.contentId === "DOF-MUS-001-A1-T02")!;
  assert.ok(stages.includes(t02.pipelineStage!), "old music stage is mapped");
  assert.equal(t02.pipelineStage, "Idea");
  assert.deepEqual(Object.keys(t02.stageOutputs), stages);
  assert.equal(t02.stageDeadlines.Idea, "2030-01-05", "the item keeps its own due date");
}
// The current stage gets its documents and checklist.
assert.ok(db.docs.length > 0 && db.docs.every((d) => db.docRevisions.some((v) => v.docId === d.id)), "documents have history");
const e01 = db.records.find((r) => r.contentId === "DOF-SER-001-S1-E01")!;
assert.equal(e01.tasks.filter((t) => t.stage === "Editorial").length, 4, "Editorial checklist created");
// A flat live show becomes a show with one day that carries the pipeline.
const liveShow = db.records.find((r) => r.contentId === "DOF-LIVE-001")!;
const liveDay = db.records.find((r) => r.contentId === "DOF-LIVE-001-D1")!;
assert.equal(liveShow.pipelineStage, null, "the show itself has no pipeline");
assert.equal(liveDay.hierarchyLevel, 1); assert.equal(liveDay.parentId, "DOF-LIVE-001");
assert.equal(liveDay.pipelineStage, "Streaming"); if (from === "4" || from === "5") assert.equal(liveDay.productionLevel, "large", "the level moves to the day");
assert.equal(liveDay.assigneePersonId, "DOF-P-CRW-003");
assert.ok(liveShow.showStart && liveShow.showStart === liveShow.showEnd, "show dates come from the single day");
assert.ok(db.callSheets.some((c) => c.linkedEpisodeIds.includes("DOF-LIVE-001-D1")), "call sheet follows the day");
assert.ok(db.docs.filter((d) => d.stage && d.contentId.startsWith("DOF-LIVE-001")).every((d) => d.contentId === "DOF-LIVE-001-D1"), "stage documents move to the day");
assert.ok(db.records.every((r) => Array.isArray(r.featured)), "every record can list hosts and guests");

// Leftovers from the project that was already deleted are cleared.
if (from === "1" || from === "2") {
  assert.ok(!db.allocations.some((a) => a.contentId === "DOF-DEV-001"), "its drive entries are gone");
  assert.ok(db.docs.filter((d) => d.contentId === "DOF-DEV-001").every((d) => d.archived), "its documents are archived");
}
const used = db.drives.reduce((n, d) => n + d.otherUsedGB, 0) + db.allocations.reduce((n, a) => n + a.sizeGB, 0);
if (from === "1" || from === "2") assert.equal(db.snapshots[db.snapshots.length - 1].usedGB, used, "the storage figure matches what is left");
// Version 6: stages have lists of owners with roles, and there are working-day settings.
assert.ok(db.records.every((r) => Object.values(r.stageAssignees).every((list) => Array.isArray(list) && list.every((o) => typeof o.personId === "string" && Array.isArray(o.roles)))), "owners are lists");
assert.deepEqual(db.settings.workDays, [1, 2, 3, 4, 5]); assert.deepEqual(db.settings.effortOverrides, {});
const e01Owners = db.records.find((r) => r.contentId === "DOF-SER-001-S1-E01")!.stageAssignees.Editorial;
assert.equal(e01Owners[0].personId, "DOF-P-CRW-001", "the single owner is now the first owner");
assert.ok(e01Owners[0].roles.includes("Director"), "and keeps the role they had on the project");
console.log(`migration from version ${from} ok`);
