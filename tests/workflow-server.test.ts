// Run with: npm test -- workflow-server
// Phase 1 of the five-stage workflow, on the server: upgrading saved data to version 15 and on (a dry run first, a copy
// kept before anything changes, safe to run twice), the data's rules checked on every save, and each person sent
// only the workflow data of projects they may see.
import assert from "node:assert/strict";
import type { Actor, Database } from "../src/types";
import { RuleError } from "../src/types";

const { memoryStore } = await import("../server/stores");
const { initDatabase, mutateState, snapshotFor, upgradeStore, describeUpgrade } = await import("../server/state");
const { toItems, KEYS } = await import("../server/layout");
const { buildWorkflowFixture } = await import("../src/data/seedWorkflow");
const { buildSeed } = await import("../src/data/seed");
const { DOCUMENT_PARTS, WORKFLOW_PARTS } = await import("../src/data/constraints");

let passed = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     "));
    process.exitCode = 1;
  }
};

type Mem = ReturnType<typeof memoryStore>;
const backups = (s: Mem) =>
  (s.state as unknown as { backups: Map<string, { items: { k: string }[]; head: { schemaVersion: number } }> }).backups;

/** A store holding the demo data as version 14 saved it: no workflow lists, no workflow fields. */
async function version14Store(): Promise<Mem> {
  const old = buildSeed() as unknown as Record<string, unknown>;
  for (const k of [...WORKFLOW_PARTS, ...DOCUMENT_PARTS]) delete old[k];
  for (const r of old.records as Record<string, unknown>[]) {
    delete r.seriesType;
    delete r.workflow;
    delete r.episode;
  }
  const s = memoryStore();
  await s.state.init(toItems(old), 14);
  return s;
}

async function fixtureStore(): Promise<Mem> {
  const s = memoryStore();
  await initDatabase(s, buildWorkflowFixture());
  return s;
}

await t("a dry run reports, part by part, what the upgrade from version 14 would do, and writes nothing", async () => {
  const s = await version14Store();
  const before = await s.state.head();
  const report = (await upgradeStore(s, false))!;
  assert.deepEqual([report.from, report.to, report.applied, report.backup], [14, 16, false, null]);
  assert.deepEqual(await s.state.head(), before, "nothing was written");
  assert.equal(backups(s).size, 0, "and no copy was needed");
  const records = report.parts.find((p) => p.part === "records")!;
  assert.equal(records.before, buildSeed().records.length);
  assert.deepEqual(
    [records.after, records.written, records.removed],
    [records.before, records.before, 0],
    "every record gains its fields; none is added or removed",
  );
  for (const part of [...WORKFLOW_PARTS, ...DOCUMENT_PARTS])
    assert.deepEqual(
      report.parts.find((p) => p.part === part),
      { part, before: 0, after: 0, written: 0, removed: 0 },
    );
  assert.deepEqual(
    report.parts.map((p) => p.part),
    [...KEYS],
    "every part is counted",
  );
  assert.match(describeUpgrade(report), /Would upgrade the data from version 14 to 16/);
});

await t("the upgrade keeps a copy of the data first, saves it all at once, and running it again does nothing", async () => {
  const s = await version14Store();
  const report = (await upgradeStore(s, true))!;
  assert.equal(report.applied, true);
  assert.match(report.backup ?? "", /before_v16/);
  const copy = backups(s).get("before_v16")!;
  assert.equal(copy.head.schemaVersion, 14, "the copy is of the data as it was");
  assert.equal(copy.items.filter((it) => it.k === "records").length, buildSeed().records.length);
  const head = (await s.state.head())!;
  assert.equal(head.schemaVersion, 16);
  assert.ok(
    report.parts.every((p) => p.before === p.after),
    "no part gained or lost an element",
  );
  const again = (await upgradeStore(s, true))!;
  assert.deepEqual([again.from, again.applied, again.backup], [16, false, null]);
  assert.deepEqual(await s.state.head(), head, "nothing was written the second time");
});

await t("a save that would break a uniqueness rule is refused, and nothing in it is saved", async () => {
  const s = await fixtureStore();
  const before = await s.state.head();
  await assert.rejects(
    mutateState(s, (db: Database) => {
      db.records[0].title = "Renamed";
      db.plannedEpisodes.push({ ...db.plannedEpisodes[0], id: "DOF-SER-001-S1-P99" });
    }),
    (e) => e instanceof RuleError && /already planned/.test(e.message),
  );
  assert.deepEqual(await s.state.head(), before);
});

await t("a save that would leave something pointing at nothing is refused", async () => {
  const s = await fixtureStore();
  const before = await s.state.head();
  await assert.rejects(
    mutateState(s, (db: Database) => {
      db.recordingSessions = db.recordingSessions.filter((x) => x.id !== "DOF-SER-001-S1-R01"); // its log rows and episodes still point at it
    }),
    (e) => e instanceof RuleError && /DOF-SER-001-S1-R01/.test(e.message),
  );
  assert.deepEqual(await s.state.head(), before);
});

await t("each person is sent the workflow data of the projects they may see, and only that", async () => {
  const s = await fixtureStore();
  await mutateState(s, (db: Database) => {
    db.members.push({ personId: "DOF-P-VOL-001", projectContentId: "DOF-DEV-001", roleOnProject: "Runner", canComment: false });
  });
  const sent = async (actor: Actor) => (await snapshotFor(s, actor))!.db;
  const hop = await sent({ personId: "DOF-P-HOP-001", role: "HOP" });
  const full = buildWorkflowFixture();
  for (const part of WORKFLOW_PARTS) assert.equal(hop[part].length, full[part].length, `the Head of Production gets every ${part}`);

  const vol = await sent({ personId: "DOF-P-VOL-001", role: "VOL" });
  assert.deepEqual(
    [...new Set(vol.plannedEpisodes.map((p) => p.contentId))],
    ["DOF-DEV-001"],
    "a volunteer on the devotion gets its five days",
  );
  assert.equal(vol.plannedEpisodes.length, 5);
  for (const part of ["recordingSessions", "sessionLogEntries", "projectRoles", "shareLinks"] as const)
    assert.equal(vol[part].length, 0, `and none of the podcast's ${part}`);
  assert.ok(vol.developmentForms.every((f) => f.contentId === "DOF-DEV-001"));
  assert.ok(vol.reviewCheckpoints.every((c) => c.contentId === "DOF-DEV-001"));

  const partner = await sent({ personId: "DOF-P-PTR-001", role: "PTR" });
  for (const part of WORKFLOW_PARTS) assert.equal(partner[part].length, 0, `a partner on no project gets no ${part}`);
});

console.log(`\n${passed} passed`);
