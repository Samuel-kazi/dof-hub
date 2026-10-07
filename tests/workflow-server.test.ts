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
  assert.deepEqual([report.from, report.to, report.applied, report.backup], [14, 24, false, null]);
  assert.deepEqual(await s.state.head(), before, "nothing was written");
  assert.equal(backups(s).size, 0, "and no copy was needed");
  const records = report.parts.find((p) => p.part === "records")!;
  assert.equal(records.before, buildSeed().records.length);
  // Every record gains its fields; version 23 adds each live show's event (two in the sample), and removes nothing.
  assert.deepEqual(
    [records.after, records.written, records.removed],
    [records.before + 2, records.before + 2, 0],
    "every record gains its fields; the two live shows each gain an event; none is removed",
  );
  // The workflow's and the documents' lists start empty, and gain only what version 23 makes for the live shows and music.
  for (const part of [...WORKFLOW_PARTS, ...DOCUMENT_PARTS]) {
    const p = report.parts.find((x) => x.part === part)!;
    assert.deepEqual([p.before, p.removed], [0, 0], part);
  }
  assert.ok(report.parts.find((p) => p.part === "recordingSessions")!.after >= 6, "the live days, as sessions");
  assert.deepEqual(
    report.parts.map((p) => p.part),
    [...KEYS],
    "every part is counted",
  );
  assert.match(describeUpgrade(report), /Would upgrade the data from version 14 to 24/);
});

await t("the upgrade keeps a copy of the data first, saves it all at once, and running it again does nothing", async () => {
  const s = await version14Store();
  const report = (await upgradeStore(s, true))!;
  assert.equal(report.applied, true);
  assert.match(report.backup ?? "", /before_v24/);
  const copy = backups(s).get("before_v24")!;
  assert.equal(copy.head.schemaVersion, 14, "the copy is of the data as it was");
  assert.equal(copy.items.filter((it) => it.k === "records").length, buildSeed().records.length);
  const head = (await s.state.head())!;
  assert.equal(head.schemaVersion, 24);
  // Nothing is lost. Version 19 gives each coming day of a live show its call sheet, and says so in the activity log;
  // version 23 moves the live shows and music onto the workflow (their events, sessions, forms and checklists).
  const grew = report.parts.filter((p) => p.before !== p.after);
  for (const part of ["callSheets", "audit", "records", "recordingSessions", "developmentForms"])
    assert.ok(
      grew.some((p) => p.part === part),
      part,
    );
  assert.ok(
    grew.every((p) => p.after > p.before),
    "no part lost an element",
  );
  const again = (await upgradeStore(s, true))!;
  assert.deepEqual([again.from, again.applied, again.backup], [24, false, null]);
  assert.deepEqual(await s.state.head(), head, "nothing was written the second time");
});

await t("data saved at version 16 is upgraded on first read: a copy first, then every project's old form into its documents", async () => {
  const s = memoryStore();
  const old = buildWorkflowFixture({ through: "development" }) as Database & { settings: { newDocuments?: string[] } };
  old.settings.newDocuments = ["series"];
  await s.state.init(toItems(old), 16);
  const snap = (await snapshotFor(s, { personId: "DOF-P-HOP-001", role: "HOP" }))!.db;
  assert.equal(snap.schemaVersion, 24);
  assert.ok(backups(s).has("before_v24"), "a copy was kept first");
  assert.equal(backups(s).get("before_v24")!.head.schemaVersion, 16);
  for (const id of [
    "DOF-SER-001-S1|Development|show_brief",
    "DOF-DEV-001|Development|devotional_script",
    "DOF-DOC-001|Development|documentary_brief",
  ])
    assert.ok(
      snap.projectDocuments.some((d) => d.id === id),
      id,
    );
  assert.equal("newDocuments" in snap.settings, false);
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
  // Saved locations are the team's: a partner gets only those on the call sheets they can see.
  assert.equal(hop.locations.length, full.locations.length);
  assert.equal(vol.locations.length, full.locations.length);
  assert.deepEqual(partner.locations, []);
});

await t("the morning run emails each reminder once, through the queue, which never leaves the server", async () => {
  const { alertChecks } = await import("../server/email");
  const s = memoryStore();
  const db = buildWorkflowFixture();
  const at = "2026-09-20T00:00:00.000Z";
  db.calendarReminders.push({
    id: "RM-aaaaaaaa",
    targetType: null,
    targetId: null,
    title: "Charge the batteries",
    date: "2026-09-27",
    time: "07:00",
    offsetMinutes: 1440,
    channels: ["app", "email"],
    recipientIds: ["DOF-P-CRW-001"],
    repeat: "none",
    fireAt: "2026-09-26T04:00:00.000Z", // 26 September, 07:00 in Nairobi
    firedAt: null,
    emailedAt: null,
    createdBy: "DOF-P-HOP-001",
    createdAt: at,
    updatedAt: at,
  });
  await initDatabase(s, db);
  const sent: { to: string; subject: string }[] = [];
  const send = async (m: { to: string; subject: string }) => {
    sent.push(m);
  };
  // 06:45 in Nairobi, the morning run: queued and sent, though the bell waits for 07:00.
  await alertChecks(s, { morning: true, send, now: "2026-09-26T03:45:00.000Z" });
  assert.deepEqual(
    sent.map((m) => m.subject),
    ["Reminder: Charge the batteries"],
  );
  await alertChecks(s, { morning: true, send, now: "2026-09-26T03:50:00.000Z" });
  assert.equal(sent.length, 1, "never twice");
  const snap = async (a: Actor) => (await snapshotFor(s, a))!.db;
  const crew1 = await snap({ personId: "DOF-P-CRW-001", role: "CRW" });
  assert.deepEqual(crew1.notifications, [], "not in the bell before its time");
  await alertChecks(s, { send, now: "2026-09-26T04:01:00.000Z" });
  assert.equal((await snap({ personId: "DOF-P-CRW-001", role: "CRW" })).notifications.length, 1);
  assert.equal((await snap({ personId: "DOF-P-CRW-002", role: "CRW" })).notifications.length, 0, "one's own bell only");
  assert.deepEqual((await snap({ personId: "DOF-P-HOP-001", role: "HOP" })).emailQueue, [], "the queue is never sent to a browser");
});

await t("templates and boards kept in Documents go to the team, not to partners", async () => {
  const s = memoryStore();
  const db = buildWorkflowFixture();
  const at = "2026-09-20T00:00:00.000Z";
  db.storyboards.push({
    id: "SB-tpl00001",
    contentId: null,
    isTemplate: true,
    episodeId: null,
    name: "Two-chair interview",
    position: 0,
    copiedFrom: null,
    migrated: false,
    createdAt: at,
    updatedAt: at,
  });
  await initDatabase(s, db);
  const sent = async (a: Actor) => (await snapshotFor(s, a))!.db;
  assert.ok((await sent({ personId: "DOF-P-VOL-001", role: "VOL" })).storyboards.some((b) => b.id === "SB-tpl00001"));
  assert.ok(!(await sent({ personId: "DOF-P-PTR-001", role: "PTR" })).storyboards.some((b) => b.id === "SB-tpl00001"));
});

console.log(`\n${passed} passed`);
