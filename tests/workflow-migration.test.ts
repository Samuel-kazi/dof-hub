// Run with: npm test -- workflow-migration
// Phase 5 of the five-stage workflow: moving the series, devotionals and documentaries made before it. The mapping
// on the demo's sample data and on every case the rules cover; every record accounted for; Content IDs unchanged;
// running it twice; an old episode keeping its Content ID when it is finally recorded; and the three ways it runs
// (MongoDB and the server, the HTTP address for the Head of Production, and the desktop app and demo), each with a
// dry run that writes nothing and a copy of the data kept before applying.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// The desktop app's storage, for the local runner's copy of the data.
const saved = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
};
process.env.SETUP_TOKEN = "test-setup-code-1234";
process.env.DOF_SCRYPT_N = "1024";

type Database = import("../src/types").Database;
type ContentRecord = import("../src/types").ContentRecord;
const { buildSeed, rec } = await import("../src/data/seed");
const { migrateToWorkflow, describeMigration } = await import("../src/data/migrateWorkflow");
const { integrityProblems } = await import("../src/data/constraints");
const { commit, enableRollback, getDb, setDb } = await import("../src/data/store");
const { applyMoveLocally, previewMove } = await import("../src/data/workflowMove");
const { login } = await import("../src/services/auth");
const W = await import("../src/services/wrapped/workflow");
const C = await import("../src/services/wrapped/content");
const CS = await import("../src/services/wrapped/callsheets");
const EQ = await import("../src/services/wrapped/equipment");
const { workItems } = await import("../src/services/workItems");
const { usesPipeline } = await import("../src/services/content");
const { createHandler, memoryStore } = await import("../server/index");
const { initDatabase, loadDb } = await import("../server/state");
const { migrateWorkflowStore } = await import("../server/migrateWorkflow");
const { prepareSession, tickAll } = await import("./support/wow-walkthrough");

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     "));
    process.exitCode = 1;
  }
};

const TODAY = "2026-09-26";
const OPTS = { today: TODAY, at: "2026-09-26T06:00:00.000Z", byPersonId: "DOF-P-HOP-001" };
const SEASON = "DOF-SER-001-S1";
const find = (db: Database, id: string): ContentRecord => db.records.find((r) => r.contentId === id)!;
const json = (db: Database) => JSON.stringify(db);
const lineFor = (r: ReturnType<typeof migrateToWorkflow>, id: string) => r.lines.find((l) => l.contentId === id)!;
const scope = (db: Database) => db.records.filter((r) => ["series", "devotional", "documentary"].includes(r.category));

// ── The demo's sample data ───────────────────────────────────

await t("the sample data: every series, devotional and documentary record is accounted for, with its IDs unchanged", () => {
  const db = buildSeed();
  const ids = db.records.map((r) => r.contentId);
  const inScope = scope(db).length;
  const report = migrateToWorkflow(db, OPTS);
  assert.deepEqual(report.unexplained, [], "zero unexplained rows");
  assert.equal(report.lines.length, inScope, "one line per record in scope");
  assert.deepEqual(integrityProblems(db), [], "the data keeps its own rules");
  for (const id of ids)
    assert.ok(
      db.records.some((r) => r.contentId === id),
      `${id} still exists`,
    );
  assert.equal(report.lines.filter((l) => l.outcome === "moved").length, 8);
  const live = db.records.filter((r) => r.category === "live" || r.category === "music" || r.category === "general");
  assert.ok(
    live.every((r) => !r.workflow && !r.episode),
    "Live Shows, Music and General Use are not touched",
  );
  const records = report.counts.find((c) => c.part === "records")!;
  assert.deepEqual([records.before, records.after], [ids.length, ids.length + 1], "one new record: the documentary's film");
  assert.ok(
    db.audit.some((a) => a.action === "migrate-workflow"),
    "the move is in the activity log",
  );
});

await t("the sample data: the season, its episodes, the devotion and the documentary map as agreed in Phase 0", () => {
  const db = buildSeed();
  const report = migrateToWorkflow(db, OPTS);
  assert.equal(find(db, "DOF-SER-001").seriesType, "podcast");
  const season = find(db, SEASON);
  assert.deepEqual(
    [season.workflow?.formType, season.workflow?.stage, season.workflow?.status, season.workflow?.migrated],
    ["podcast", "Pre-production", "Active", true],
  );
  const form = db.developmentForms.find((f) => f.contentId === SEASON)!;
  assert.equal(form.outcome, "Greenlight", "past Development, its greenlight counts as met");
  assert.ok(db.reviewCheckpoints.filter((c) => c.contentId === SEASON && !c.episodeId).every((c) => c.status === "Approved"));
  // E01 was at Editorial: an episode in Post production, Editing, carrying what it had.
  const e01 = find(db, `${SEASON}-E01`);
  assert.equal(e01.episode?.stage, "Post production");
  assert.equal(e01.episode?.postStage, "Editing");
  assert.equal(e01.episode?.sourceSessionId, null);
  assert.match(e01.episode!.productionNotes, /^Migrated before session logging\./);
  assert.equal(e01.episode?.reviewLink, "https://drive.google.com/demo-review-e01");
  assert.equal(e01.episode?.editorId, "DOF-P-CRW-001", "the Editorial owner with the role Editor");
  assert.equal(e01.episode?.episodeNumber, 1);
  assert.equal(e01.pipelineStage, "Editorial", "old fields stay as they were");
  const storyLock = db.workflowChecklistItems.find((c) => c.id === `${SEASON}-E01|Post production|story_lock`);
  assert.equal(storyLock?.done, true, "Story lock was ticked in the earlier pipeline");
  // E02 and E03 were at Recording on 28 September: planned episodes on an open session, with the call sheet.
  const r01 = db.recordingSessions.find((s) => s.id === `${SEASON}-R01`)!;
  assert.deepEqual([r01.status, r01.scheduledDate, r01.callSheetId], ["Open", "2026-09-28", "DOF-CS-001"]);
  for (const [old, plan] of [
    ["E02", "P02"],
    ["E03", "P03"],
    ["E04", "P04"],
  ]) {
    const p = db.plannedEpisodes.find((x) => x.id === `${SEASON}-${plan}`)!;
    assert.equal(p.reservedId, `${SEASON}-${old}`, `${plan} keeps ${old}`);
    const r = find(db, `${SEASON}-${old}`);
    assert.ok(r.archived && !r.episode, `${old} waits, archived`);
    assert.match(r.closedReason ?? "", new RegExp(`Waiting to be recorded as planned episode ${SEASON}-${plan}`));
  }
  assert.deepEqual(
    db.sessionLogEntries.map((e) => e.id),
    [`${SEASON}-R01|${SEASON}-P02`, `${SEASON}-R01|${SEASON}-P03`],
  );
  assert.match(lineFor(report, `${SEASON}-E04`).after, /waiting to be recorded/, "E04 was at Scripting: not on a session");
  // The devotion at Prep/Scripting: Pre-production, five days, its theological review kept.
  const dev = find(db, "DOF-DEV-001");
  assert.deepEqual([dev.workflow?.formType, dev.workflow?.stage], ["devotion", "Pre-production"]);
  assert.equal(db.plannedEpisodes.filter((p) => p.contentId === "DOF-DEV-001").length, 5);
  const devForm = db.developmentForms.find((f) => f.contentId === "DOF-DEV-001")!;
  assert.equal(devForm.sections.guest.name, "Rev. Grace Achieng");
  assert.match(String(devForm.sections.messageReview.notes), /Pastor Daniel Otieno/);
  // The documentary at Ingest: its film is episode E01, in Post production.
  const film = find(db, "DOF-DOC-001-E01");
  assert.deepEqual([film.parentId, film.episode?.stage, film.episode?.postStage], ["DOF-DOC-001", "Post production", "Editing"]);
  assert.equal(db.developmentForms.find((f) => f.contentId === "DOF-DOC-001")!.decisions.length, 2, "both greenlights: it was shot");
  assert.equal(report.followUps.length, 3);
});

await t("a dry run on a copy changes nothing, and running it again changes nothing", () => {
  setDb(buildSeed());
  const before = json(getDb());
  const preview = previewMove(login("hop@dof.demo", "demo"), {});
  assert.ok(preview.changed);
  assert.equal(json(getDb()), before, "the dry run wrote nothing");
  const db = buildSeed();
  migrateToWorkflow(db, OPTS);
  const once = json(db);
  const again = migrateToWorkflow(db, OPTS);
  assert.equal(again.changed, false);
  assert.equal(json(db), once, "the second run changed nothing at all");
  assert.equal(again.lines.filter((l) => l.outcome === "moved").length, 0);
  assert.deepEqual(again.unexplained, []);
  assert.match(describeMigration(again, false), /^Nothing to move/);
});

await t("choices before moving: a series' type and a documentary pitched by others", () => {
  const db = buildSeed();
  migrateToWorkflow(db, { ...OPTS, seriesTypes: { "DOF-SER-001": "sermon" }, documentaryForms: { "DOF-DOC-001": "documentary_pitched" } });
  assert.equal(find(db, "DOF-SER-001").seriesType, "sermon");
  assert.equal(find(db, SEASON).workflow?.formType, "sermon");
  const doc = db.developmentForms.find((f) => f.contentId === "DOF-DOC-001")!;
  assert.deepEqual([doc.formType, doc.greenlightStage, doc.decisions.length], ["documentary_pitched", null, 1]);
});

// ── Every case the rules cover ───────────────────────────────

/** A season under a series, with one episode per stage given. */
function series(db: Database, n: number, stages: (string | null)[], extra: (e: ContentRecord, i: number) => void = () => {}) {
  const id = `DOF-SER-0${n}`;
  db.records.push(rec({ contentId: id, title: `Series ${n}`, category: "series", parentId: null, level: 0, stage: null }));
  db.records.push(rec({ contentId: `${id}-S1`, title: "Season 1", category: "series", parentId: id, level: 1, stage: null }));
  stages.forEach((stage, i) => {
    const e = rec({
      contentId: `${id}-S1-E0${i + 1}`,
      title: `Episode ${i + 1}`,
      category: "series",
      parentId: `${id}-S1`,
      level: 2,
      stage,
    });
    extra(e, i);
    db.records.push(e);
  });
  return `${id}-S1`;
}
const devotional = (db: Database, n: number, stage: string, extra: Partial<ContentRecord> = {}) => {
  const r = rec({ contentId: `DOF-DEV-0${n}`, title: `Devotional ${n}`, category: "devotional", parentId: null, level: 0, stage });
  Object.assign(r, extra);
  db.records.push(r);
  return r.contentId;
};
const documentary = (db: Database, n: number, stage: string, extra: Partial<ContentRecord> = {}) => {
  const r = rec({ contentId: `DOF-DOC-0${n}`, title: `Documentary ${n}`, category: "documentary", parentId: null, level: 0, stage });
  Object.assign(r, extra);
  db.records.push(r);
  return r.contentId;
};

await t("series: Development, review, delivery, an archived episode and an unknown stage", () => {
  const db = buildSeed();
  const early = series(db, 10, ["Idea", "Scripting"]);
  const done = series(db, 11, ["Delivered", "Delivered"], (e) => (e.stageOutputs.Delivered = true));
  const review = series(db, 12, ["Review", "Review", "Delivered", "Ingest", null], (e, i) => {
    if (i === 1)
      e.links.push({
        id: "L-x",
        stage: "Review",
        kind: "review",
        url: "https://vimeo.com/x",
        note: "",
        byPersonId: "DOF-P-HOP-001",
        at: OPTS.at,
      });
    if (i === 3) e.archived = true;
    if (i === 4) e.pipelineStage = "Colour suite";
  });
  const report = migrateToWorkflow(db, OPTS);
  assert.deepEqual(report.unexplained, []);
  assert.deepEqual(integrityProblems(db), []);
  // Only Idea and Scripting: the season is still in Development, and nothing counts as met.
  const s10 = find(db, early);
  assert.deepEqual([s10.workflow?.stage, s10.workflow?.status], ["Development", "Development"]);
  assert.equal(db.developmentForms.find((f) => f.contentId === early)!.outcome, null);
  assert.equal(db.plannedEpisodes.filter((p) => p.contentId === early && p.reservedId).length, 2);
  // Every episode delivered and confirmed: published, its reviews approved, and the season complete.
  const s11e = find(db, `${done}-E01`);
  assert.deepEqual(
    [s11e.episode?.stage, s11e.episode?.mdStage, s11e.episode?.postStage],
    ["Marketing and distribution", "Published", "Approved"],
  );
  assert.ok(db.reviewCheckpoints.filter((c) => c.episodeId === s11e.contentId).every((c) => c.status === "Approved"));
  assert.equal(find(db, done).workflow?.status, "Completed");
  // At Review: Rough cut review when there is a link to review, Editing marked ready when there is not.
  assert.equal(find(db, `${review}-E02`).episode?.postStage, "Rough cut review");
  const noLink = find(db, `${review}-E01`);
  assert.deepEqual([noLink.episode?.postStage, noLink.episode?.readyForReview], ["Editing", true]);
  assert.match(lineFor(report, `${review}-E01`).note, /no web review link/);
  assert.equal(find(db, `${review}-E03`).episode?.mdStage, "Release plan", "delivered but not confirmed");
  assert.equal(lineFor(report, `${review}-E04`).outcome, "unchanged", "archived before: left as it is");
  assert.equal(find(db, `${review}-E04`).episode, null);
  assert.equal(lineFor(report, `${review}-E05`).outcome, "flagged", "an unknown stage is listed, not guessed");
  assert.ok(usesPipeline(find(db, `${review}-E05`)), "and keeps working in the earlier pipeline");
});

await t("devotionals and documentaries: each stage, closed, recorded and archived", () => {
  const db = buildSeed();
  const guest = devotional(db, 10, "Guest", { reviewApprovedAt: "2026-09-01", reviewerName: "Pastor Daniel" });
  const recorded = devotional(db, 11, "Editing");
  const closed = devotional(db, 12, "Closed", { closedReason: "The guest did not comply" });
  const gone = devotional(db, 13, "Creation", { archived: true });
  const idea = documentary(db, 10, "Research");
  const pre = documentary(db, 11, "Pre-production");
  const shooting = documentary(db, 12, "Shooting", { scheduledDate: "2026-10-01" });
  const delivered = documentary(db, 13, "Delivered");
  find(db, delivered).stageOutputs.Delivered = true;
  const before = JSON.stringify(find(db, recorded));
  const report = migrateToWorkflow(db, OPTS);
  assert.deepEqual(report.unexplained, []);
  assert.deepEqual(integrityProblems(db), []);
  // A devotional at Guest whose review was approved: Development, with its pitch and outline approved from it.
  assert.equal(find(db, guest).workflow?.stage, "Development");
  assert.ok(
    db.reviewCheckpoints.filter((c) => c.contentId === guest).every((c) => c.status === "Approved" && /Pastor Daniel/.test(c.note)),
  );
  // Recorded as one item: listed for a decision by hand, untouched.
  assert.equal(lineFor(report, recorded).outcome, "flagged");
  assert.match(lineFor(report, recorded).note, /no per-day data/);
  assert.equal(JSON.stringify(find(db, recorded)), before, "untouched");
  assert.equal(find(db, recorded).workflow, null);
  // Closed: archived, with its reason, never deleted.
  const c = find(db, closed);
  assert.deepEqual([c.archived, c.workflow?.status, c.closedReason], [true, "Closed", "The guest did not comply"]);
  assert.equal(lineFor(report, gone).outcome, "unchanged");
  // Documentaries.
  assert.equal(find(db, idea).workflow?.stage, "Development");
  const preForm = db.developmentForms.find((f) => f.contentId === pre)!;
  assert.deepEqual([preForm.greenlightStage, preForm.decisions.map((d) => d.stage)], [2, [1]], "its second greenlight is still to decide");
  assert.match(lineFor(report, pre).note, /second greenlight/);
  const session = db.recordingSessions.find((s) => s.contentId === shooting)!;
  assert.deepEqual([session.id, session.status, session.scheduledDate], [`${shooting}-R01`, "Open", "2026-10-01"]);
  assert.equal(find(db, `${delivered}-E01`).episode?.mdStage, "Published");
  assert.equal(find(db, delivered).workflow?.status, "Completed");
});

// ── After the move, the workflow carries on ──────────────────

const hop = () => login("hop@dof.demo", "demo");
const modules: Record<string, Record<string, unknown>> = { workflow: W, callsheets: CS, equipment: EQ };
const call = async (name: string, ...args: unknown[]) => {
  const [m, n] = name.split(".");
  return (modules[m][n] as (...a: unknown[]) => unknown)(hop(), ...args);
};

await t("an episode made before the workflow keeps its Content ID when its session closes; new ones number on", async () => {
  setDb(buildSeed());
  enableRollback();
  migrateToWorkflow(getDb(), OPTS);
  commit();
  const r01 = `${SEASON}-R01`;
  assert.throws(
    () => C.updateRecord(hop(), `${SEASON}-E02`, { notes: "changed in the earlier pipeline" }),
    /archived and cannot be changed: Waiting to be recorded/,
    "a waiting episode is kept as it was until it is recorded",
  );
  await call("workflow.updateLogRow", `${r01}|${SEASON}-P02`, { status: "Recorded", notesForPost: "Good take." });
  await call("workflow.updateLogRow", `${r01}|${SEASON}-P03`, { status: "Not recorded", notesForPost: "Guest ill." });
  await tickAll(call, "wrap", r01);
  const closed = (await call("workflow.closeSession", r01)) as { made: string[] };
  assert.deepEqual(closed.made, [`${SEASON}-E02`], "E02 became the episode, under its own Content ID");
  const e02 = find(getDb(), `${SEASON}-E02`);
  assert.deepEqual(
    [e02.archived, e02.closedReason, e02.episode?.episodeNumber, e02.episode?.sourceSessionId, e02.episode?.productionNotes],
    [false, null, 2, r01, "Good take."],
  );
  assert.ok(find(getDb(), `${SEASON}-E03`).archived, "E03 was not recorded: still waiting");
  // A second session records E03 and E04 under their own IDs, and a new planned episode takes the next free number.
  await call("workflow.assignProducer", SEASON, "DOF-P-CRW-004");
  for (const [role, who] of [
    ["director", "DOF-P-CRW-001"],
    ["dop", "DOF-P-CRW-002"],
    ["audio_engineer", "DOF-P-CRW-003"],
    ["editor", "DOF-P-CRW-001"],
  ])
    await call("workflow.assignRole", SEASON, role, { crewId: who });
  await call("workflow.assignRole", SEASON, "host_guest", { guestName: "Pastor Mary Wanjiku" });
  await tickAll(call, "preProject", SEASON);
  const plan5 = (await call("workflow.addPlannedEpisode", SEASON, { workingTitle: "Why stay?" })) as { id: string };
  const r02 = await prepareSession(call, SEASON, "2026-10-12", [`${SEASON}-P03`, `${SEASON}-P04`, plan5.id], ["DOF-EQ-CAM-003"]);
  assert.equal(r02, `${SEASON}-R02`);
  for (const p of [`${SEASON}-P03`, `${SEASON}-P04`, plan5.id])
    await call("workflow.updateLogRow", `${r02}|${p}`, { status: "Recorded", notesForPost: "" });
  await tickAll(call, "wrap", r02);
  const second = (await call("workflow.closeSession", r02)) as { made: string[] };
  assert.deepEqual(second.made, [`${SEASON}-E03`, `${SEASON}-E04`, `${SEASON}-E05`]);
  assert.deepEqual(integrityProblems(getDb()), []);
  assert.ok(!getDb().records.some((r) => r.category === "series" && usesPipeline(r) && !r.archived), "nothing left on the earlier board");
});

await t("after the move the board shows each record at its level, and the documentary's stage comes from its film", () => {
  setDb(buildSeed());
  migrateToWorkflow(getDb(), OPTS);
  const items = workItems(hop(), false);
  const keys = items.map((i) => i.key);
  assert.ok(keys.includes(`session:${SEASON}-R01`), "the Recording episodes' open session");
  assert.ok(keys.includes(`episode:${SEASON}-E01`) && keys.includes("episode:DOF-DOC-001-E01"));
  assert.ok(keys.includes(`project:${SEASON}`), "E04 still needs a session, so the season is in Pre-production too");
  assert.ok(keys.includes("project:DOF-DEV-001"));
  assert.equal(W.projectSummary(find(getDb(), "DOF-DOC-001") as Parameters<typeof W.projectSummary>[0]).stage, "Post production");
});

// ── The three ways it runs ───────────────────────────────────

await t("on the server: a dry run writes nothing; applying keeps a copy first, then moves everything at once", async () => {
  const store = memoryStore();
  await initDatabase(store, buildSeed());
  const before = await store.state.head();
  const dry = (await migrateWorkflowStore(store, false, "system"))!;
  assert.deepEqual([dry.applied, dry.backup, dry.changed], [false, null, true]);
  assert.deepEqual(await store.state.head(), before, "nothing was written");
  const records = dry.counts.find((c) => c.part === "records")!;
  assert.equal(records.after, records.before + 1);
  const done = (await migrateWorkflowStore(store, true, "system", { seriesTypes: { "DOF-SER-001": "testimonial" } }))!;
  assert.equal(done.applied, true);
  assert.match(done.backup ?? "", /before_workflow/, "where the copy is");
  const backups = (store.state as unknown as { backups: Map<string, unknown> }).backups;
  assert.ok(backups.has("before_workflow"), "the copy is kept");
  assert.equal((await store.state.head())!.revision, before!.revision + 1, "one change");
  const db = (await loadDb(store))!.db;
  assert.equal(find(db, SEASON).workflow?.formType, "testimonial");
  assert.deepEqual(integrityProblems(db), []);
  const again = (await migrateWorkflowStore(store, true, "system"))!;
  assert.deepEqual([again.changed, again.applied], [false, false], "running it again changes nothing");
  assert.equal((await store.state.head())!.revision, before!.revision + 1);
});

await t("over HTTP: only the Head of Production, choices checked, a dry run unless asked", async () => {
  const store = memoryStore();
  const server: Server = createServer(createHandler(async () => store));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, cookie = "") => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
    return { status: res.status, json: (await res.json()) as Record<string, any>, cookie: set ? set.split(";")[0] : cookie };
  };
  try {
    const setup = await post("/api/setup", {
      token: process.env.SETUP_TOKEN,
      name: "Kevin Mwangi",
      username: "kev",
      password: "correct horse battery",
      samples: true,
    });
    const kev = setup.cookie;
    assert.equal((await post("/api/migrate-workflow", {})).status, 401, "signed out");
    const made = await post("/api/accounts/create", { personId: "DOF-P-CRW-002", username: "brian" }, kev);
    const brianLogin = await post("/api/login", { username: "brian", password: made.json.temporaryPassword });
    const brian = (
      await post("/api/account/password", { current: made.json.temporaryPassword, next: "a fresh password here" }, brianLogin.cookie)
    ).cookie;
    assert.equal((await post("/api/migrate-workflow", { apply: true }, brian)).status, 403, "crew may not");
    assert.equal((await post("/api/migrate-workflow", { seriesTypes: { "DOF-SER-001": "vlog" } }, kev)).status, 400);
    assert.equal((await post("/api/migrate-workflow", { apply: "yes" }, kev)).status, 400);
    assert.equal((await post("/api/migrate-workflow", { other: 1 }, kev)).status, 400);
    const dry = await post("/api/migrate-workflow", {}, kev);
    assert.equal(dry.status, 200);
    assert.deepEqual([dry.json.report.applied, dry.json.report.changed, dry.json.report.unexplained], [false, true, []]);
    const done = await post("/api/migrate-workflow", { apply: true }, kev);
    assert.equal(done.json.report.applied, true);
    assert.match(done.json.report.backup, /before_workflow/);
    const again = await post("/api/migrate-workflow", { apply: true }, kev);
    assert.equal(again.json.report.changed, false);
  } finally {
    server.close();
  }
});

await t("over HTTP: a session closed on a screen keeps the waiting episode's Content ID on the server too", async () => {
  const { setRpcSink } = await import("../src/data/rpc");
  const store = memoryStore();
  const server: Server = createServer(createHandler(async () => store));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
    if (set) cookie = set.split(";")[0];
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const act = async (name: string, ...args: unknown[]) => {
    const r = await req("POST", "/api/action", { name, args: [{ personId: "ignored", role: "HOP" }, ...args] });
    assert.equal(r.status, 200, `${name}: ${r.json.error}`);
    return r.json.result;
  };
  try {
    await req("POST", "/api/setup", {
      token: process.env.SETUP_TOKEN,
      name: "Kevin Mwangi",
      username: "kev",
      password: "correct horse battery",
      samples: true,
    });
    const live = await act("content.createRecord", { category: "general", title: "Old placeholder" });
    await act("content.deleteRecord", live.contentId);
    assert.equal((await req("POST", "/api/migrate-workflow", { apply: true })).json.report.applied, true);
    const r01 = `${SEASON}-R01`;
    await act("workflow.updateLogRow", `${r01}|${SEASON}-P02`, { status: "Recorded", notesForPost: "" });
    await act("workflow.updateLogRow", `${r01}|${SEASON}-P03`, { status: "Recorded", notesForPost: "" });
    for (const k of [
      "media_offloaded",
      "files_checked",
      "cards_labeled",
      "nothing_wiped",
      "gear_counted",
      "batteries_faults",
      "gear_returned",
      "set_struck",
      "props_returned",
      "daily_log",
      "continuity_notes",
      "guests_thanked",
      "crew_wrap_note",
    ])
      await act("workflow.setChecklistItem", `${r01}|Production|${k}`, { done: true, note: "" });
    const snapshot = (await req("GET", "/api/state")).json.db as Database;
    assert.ok(
      snapshot.records.some((r) => r.contentId === `${SEASON}-E02` && r.archived),
      "the waiting episode is sent",
    );
    assert.ok(!snapshot.records.some((r) => r.contentId === live.contentId), "a deleted earlier-pipeline record still is not");
    await act("workflow.closeProject", "DOF-DOC-001", "Withdrawn by the team");
    const later = (await req("GET", "/api/state")).json.db as Database;
    assert.ok(
      later.records.some((r) => r.contentId === "DOF-DOC-001" && r.archived),
      "a closed project is sent too, for the board's Closed column and its page",
    );
    // What a signed-in page does: work on the snapshot, and record the call it sends.
    const me = (await req("GET", "/api/session")).json.user;
    setDb(structuredClone(snapshot));
    const calls: unknown[] = [];
    setRpcSink((c) => calls.push(c));
    let onScreen: { made: string[] };
    try {
      onScreen = W.closeSession({ personId: me.personId, role: me.role }, r01) as { made: string[] };
    } finally {
      setRpcSink(null);
    }
    assert.deepEqual(onScreen.made, [`${SEASON}-E02`, `${SEASON}-E03`], "on screen: the episodes keep their IDs");
    const saved = await req("POST", "/api/action", calls[0]);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.result.made, onScreen.made, "and the server agrees");
  } finally {
    server.close();
  }
});

await t("in the desktop app and the demo: the Head of Production only, with a copy kept on this computer first", () => {
  setDb(buildSeed());
  enableRollback();
  assert.throws(() => applyMoveLocally(login("crew2@dof.demo", "demo"), {}), /Only the Head of Production/);
  assert.ok(!getDb().records.some((r) => r.workflow), "nothing moved");
  const before = json(getDb());
  const r = applyMoveLocally(hop(), {});
  assert.deepEqual([r.applied, r.backup], [true, "dof-hub-db-before-workflow"]);
  assert.equal(saved.get("dof-hub-db-before-workflow"), before, "the copy is the data as it was");
  assert.ok(find(getDb(), SEASON).workflow);
  assert.equal(applyMoveLocally(hop(), {}).applied, false, "running it again changes nothing");
});

console.log(`\n${passed} passed`);
