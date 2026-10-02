// What every place the server keeps data must do, checked the same way for each: in memory
// (tests/storage.test.ts) and in a real MongoDB replica set (tests/storage-mongo.test.ts).
import assert from "node:assert/strict";
import type { Item, Store } from "../../server/stores";
import { versionedKeys } from "../../server/layout";

export interface Legacy {
  data: Record<string, unknown>;
  revision: number;
  schemaVersion: number;
}
export type MakeStore = (legacy?: Legacy) => Promise<Store>;
/** What a store's backup holds, for checking: each part's elements, and the schema version. */
export type BackedUp = (s: Store, label: string) => Promise<{ records: unknown[]; schemaVersion: number | null }>;
type Test = (name: string, fn: () => Promise<void>) => Promise<void>;

const item = (k: string, i: string, o: number, d: unknown): Item => ({ k, i, o, d });
const versions = () => Object.fromEntries(versionedKeys().map((k) => [k, 1]));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export async function storageContract(t: Test, make: MakeStore, backedUp: BackedUp): Promise<void> {
  await t("a new store has no data until it is set up, and is set up once", async () => {
    const s = await make();
    assert.equal(await s.state.head(), null);
    assert.equal(await s.state.init([item("records", "A", 0, { contentId: "A" })], 14), true);
    assert.equal(await s.state.init([item("records", "B", 0, { contentId: "B" })], 14), false);
    const head = await s.state.head();
    assert.deepEqual([head?.revision, head?.schemaVersion, head?.versions], [1, 14, versions()]);
    assert.deepEqual(
      (await s.state.items(["records"])).map((x) => x.i),
      ["A"],
    );
  });

  await t("elements come back in order, part by part", async () => {
    const s = await make();
    await s.state.init(
      [
        item("records", "B", 1, { n: 2 }),
        item("people", "P", 0, { n: 9 }),
        item("records", "A", 0, { n: 1 }),
        item("records", "C", 2, { n: 3 }),
      ],
      14,
    );
    const got = await s.state.items(["records"]);
    assert.deepEqual(
      got.map((x) => [x.i, x.d]),
      [
        ["A", { n: 1 }],
        ["B", { n: 2 }],
        ["C", { n: 3 }],
      ],
    );
    assert.deepEqual(
      (await s.state.items(["people", "records"])).filter((x) => x.k === "people").map((x) => x.i),
      ["P"],
    );
  });

  await t("a save puts and removes elements, and moves each part it expects on by one", async () => {
    const s = await make();
    await s.state.init([item("records", "A", 0, { v: 1 }), item("records", "B", 1, { v: 1 })], 14);
    const r = await s.state.commit({
      put: [item("records", "A", 0, { v: 2 }), item("records", "C", 2, { v: 1 })],
      remove: [{ k: "records", i: "B" }],
      expect: { records: 1 },
      schemaVersion: 14,
    });
    assert.equal(r, 2);
    const head = await s.state.head();
    assert.equal(head?.versions.records, 2);
    assert.equal(head?.versions.people, 1, "parts it did not expect keep their version");
    assert.deepEqual(
      (await s.state.items(["records"])).map((x) => [x.i, x.d]),
      [
        ["A", { v: 2 }],
        ["C", { v: 1 }],
      ],
    );
  });

  await t("a save made from an older version writes nothing at all", async () => {
    const s = await make();
    await s.state.init([item("records", "A", 0, { v: 1 }), item("people", "P", 0, { v: 1 })], 14);
    assert.equal(
      await s.state.commit({ put: [item("records", "A", 0, { v: 2 })], remove: [], expect: { records: 1 }, schemaVersion: 14 }),
      2,
    );
    const late = await s.state.commit({
      put: [item("records", "A", 0, { v: 99 }), item("people", "P", 0, { v: 99 })],
      remove: [],
      expect: { records: 1, people: 1 },
      schemaVersion: 14,
    });
    assert.equal(late, null);
    const now = Object.fromEntries((await s.state.items(["records", "people"])).map((x) => [x.k, x.d]));
    assert.deepEqual(now, { records: { v: 2 }, people: { v: 1 } }, "neither element was written");
    assert.equal((await s.state.head())?.revision, 2);
  });

  await t("logs need no version, so adding to them never conflicts", async () => {
    const s = await make();
    await s.state.init([], 14);
    await s.state.commit({ put: [item("records", "A", 0, {})], remove: [], expect: { records: 1 }, schemaVersion: 14 });
    const a = await s.state.commit({ put: [item("audit", "x", 10, { id: "x" })], remove: [], expect: {}, schemaVersion: 14 });
    const b = await s.state.commit({ put: [item("audit", "y", 11, { id: "y" })], remove: [], expect: {}, schemaVersion: 14 });
    assert.deepEqual([a, b], [3, 4]);
    assert.equal((await s.state.head())?.versions.audit, undefined, "logs have no version");
  });

  await t("saves sent at the same moment to the same part: exactly one goes through", async () => {
    const s = await make();
    await s.state.init([item("records", "A", 0, { v: 0 })], 14);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        s.state.commit({ put: [item("records", "A", 0, { v: n + 1 })], remove: [], expect: { records: 1 }, schemaVersion: 14 }),
      ),
    );
    assert.equal(results.filter((r) => r !== null).length, 1, JSON.stringify(results));
    assert.equal((await s.state.head())?.versions.records, 2);
  });

  await t("the newest log entries come first, and only as many as asked for", async () => {
    const s = await make();
    await s.state.init(
      Array.from({ length: 30 }, (_, n) => item("audit", `a${n}`, n, { n })),
      14,
    );
    const got = await s.state.newest("audit", 5);
    assert.deepEqual(
      got.map((x) => (x.d as { n: number }).n),
      [29, 28, 27, 26, 25],
    );
  });

  await t("a save can change the data's version number", async () => {
    const s = await make();
    await s.state.init([], 13);
    await s.state.commit({ put: [], remove: [], expect: { counters: 1 }, schemaVersion: 14 });
    assert.equal((await s.state.head())?.schemaVersion, 14);
  });

  await t("files are stored once and read back", async () => {
    const s = await make();
    const doc = { _id: "0123456789abcdef0123456789abcdef", type: "image/png", data: "iVBORw0KGgo=", size: 8, at: new Date().toISOString() };
    assert.equal(await s.files.insert(doc), true);
    assert.equal(await s.files.insert(doc), false);
    assert.deepEqual(await s.files.get(doc._id), doc);
  });

  await t("sign-in attempts sent at the same moment are all counted", async () => {
    const s = await make();
    const now = Date.now();
    await Promise.all(Array.from({ length: 50 }, () => s.attempts.charge("u:kev", now, 60_000)));
    assert.equal((await s.attempts.get("u:kev"))?.count, 50);
    await s.attempts.refund("u:kev");
    assert.equal((await s.attempts.get("u:kev"))?.count, 49);
    const later = await s.attempts.charge("u:kev", now + 120_000, 60_000);
    assert.equal(later.count, 1, "a count whose window has passed starts again");
    await s.attempts.lock("u:kev", now + 1000);
    assert.equal((await s.attempts.get("u:kev"))?.lockedUntil, now + 1000);
    await s.attempts.clear("u:kev");
    assert.equal(await s.attempts.get("u:kev"), null);
  });

  // ── The workflow's uniqueness rules, kept by the store itself (src/data/constraints.ts) ──

  const planned = (id: string, contentId: string, episodeNumber: number) =>
    item("plannedEpisodes", id, episodeNumber, { id, contentId, episodeNumber });
  const save = (s: Store, ...put: Item[]) => s.state.commit({ put, remove: [], expect: {}, schemaVersion: 15 });

  await t("a duplicate that breaks a uniqueness rule is refused by the store, and nothing in that save is written", async () => {
    const s = await make();
    await s.state.init([planned("P-A", "PRJ-1", 1)], 15);
    const before = await s.state.head();
    await assert.rejects(
      save(s, item("records", "X", 0, { contentId: "X" }), planned("P-B", "PRJ-1", 1)),
      /already planned/,
      "the same episode number twice in one project",
    );
    assert.equal((await s.state.head())?.revision, before?.revision, "the revision did not move");
    assert.deepEqual(
      (await s.state.items(["records", "plannedEpisodes"])).map((x) => x.i),
      ["P-A"],
      "the other element in the same save was not written either",
    );
    assert.equal(await save(s, planned("P-C", "PRJ-2", 1)), before!.revision + 1, "the same number in another project is fine");
  });

  await t("uniqueness rules that apply only to some elements", async () => {
    const s = await make();
    await s.state.init([], 15);
    const role = (id: string, roleKey: string) =>
      item("projectRoles", id, 0, { id, contentId: "PRJ-1", roleKey, exclusive: roleKey !== "host_guest" });
    await save(s, role("PRJ-1|director", "director"), role("PRJ-1|host_guest|a", "host_guest"), role("PRJ-1|host_guest|b", "host_guest"));
    await assert.rejects(save(s, role("PRJ-1|director|again", "director")), /already has that role/, "one director per project");
    const link = (id: string, token: string | null) => item("shareLinks", id, 0, { id, episodeId: "E", token });
    await save(s, link("L1", "tok-1"), link("L2", null), link("L3", null));
    await assert.rejects(save(s, link("L4", "tok-1")), /share link already exists/, "a share token is never used twice");
    const row = (id: string, plannedEpisodeId: string | null) =>
      item("sessionLogEntries", id, 0, { id, sessionId: "R01", plannedEpisodeId });
    await save(s, row("r1", "P01"), row("r2", null), row("r3", null));
    await assert.rejects(save(s, row("r4", "P01")), /already has a row/, "one log row per planned episode per session");
    const ep = (id: string, n: number | null) =>
      item("records", id, 0, { contentId: id, parentId: "PRJ-1", episode: n === null ? null : { episodeNumber: n } });
    await save(s, ep("PRJ-1-E01", 1), ep("OLD-1", null), ep("OLD-2", null));
    await assert.rejects(save(s, ep("PRJ-1-E09", 1)), /episode number is already used/, "one episode per number per project");
  });

  await t("a part's elements can be counted without reading them", async () => {
    const s = await make();
    await s.state.init([planned("P1", "A", 1), planned("P2", "A", 2), item("records", "R", 0, {})], 15);
    assert.equal(await s.state.count("plannedEpisodes"), 2);
    assert.equal(await s.state.count("shareLinks"), 0);
  });

  await t("a backup keeps the data as it was, and a second backup under the same name keeps the first", async () => {
    const s = await make();
    await s.state.init([item("records", "A", 0, { v: 1 })], 14);
    const where = await s.state.backup("before_test");
    assert.ok(where.includes("before_test"));
    await s.state.commit({ put: [item("records", "A", 0, { v: 2 })], remove: [], expect: { records: 1 }, schemaVersion: 15 });
    await s.state.backup("before_test");
    assert.deepEqual(await backedUp(s, "before_test"), { records: [{ v: 1 }], schemaVersion: 14 });
  });

  await t("data saved in the earlier layout is moved across, photos and all, and keeps its revision", async () => {
    const data = {
      people: [{ personId: "DOF-P-HOP-001", name: "Kevin", photoUrl: PNG }],
      records: [
        { contentId: "DOF-SER-001", title: "A" },
        { contentId: "DOF-SER-002", title: "B" },
      ],
      equipment: [
        {
          id: "DOF-EQ-CAM-001",
          photos: [{ id: "ATT-00001", url: PNG }],
          receipts: [{ id: "ATT-00002", url: "https://example.com/r.pdf" }],
        },
      ],
      audit: [{ id: "A-00001" }, { id: "A-00002" }],
      settings: { stageReminderHours: 24 },
      counters: { callsheet: 3 },
    };
    const s = await make({ data, revision: 41, schemaVersion: 13 });
    const head = await s.state.head();
    assert.deepEqual([head?.revision, head?.schemaVersion], [41, 13]);
    const items = await s.state.items(["people", "records", "equipment", "settings", "counters"]);
    assert.deepEqual(
      items.filter((x) => x.k === "records").map((x) => x.i),
      ["DOF-SER-001", "DOF-SER-002"],
    );
    const person = items.find((x) => x.k === "people")!.d as { photoUrl: string };
    assert.match(person.photoUrl, /^\/api\/file\?id=[a-f0-9]{32}$/);
    const eq = items.find((x) => x.k === "equipment")!.d as { photos: { url: string }[]; receipts: { url: string }[] };
    assert.equal(eq.photos[0].url, person.photoUrl, "the same photo is stored once");
    assert.equal(eq.receipts[0].url, "https://example.com/r.pdf", "links stay links");
    const file = await s.files.get(person.photoUrl.split("=")[1]);
    assert.equal(file?.type, "image/png");
    assert.deepEqual(items.find((x) => x.k === "settings")!.d, { stageReminderHours: 24 });
    assert.deepEqual(
      (await s.state.newest("audit", 10)).map((x) => x.i),
      ["A-00002", "A-00001"],
    );
  });
}
