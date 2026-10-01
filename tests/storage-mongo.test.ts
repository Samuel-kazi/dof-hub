// Run with: npm test -- storage-mongo
// The storage contract (tests/support/storage-contract.ts) against a real MongoDB replica set, the kind Atlas
// runs, started for the test by mongodb-memory-server. It downloads MongoDB the first time it runs.
//
// In CI this must run. On a computer that cannot download MongoDB (no network, or a blocked host), it says
// so and stops without failing. Set DOF_MONGO_URI to test against a database of your own instead: every test
// uses a database of its own, named dof_test_<random>, and drops it afterwards.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { MongoClient as Client } from "mongodb";

const { MongoClient } = await import("mongodb");
const { storeOn } = await import("../server/mongo");
const { storageContract } = await import("./support/storage-contract");

let uri = process.env.DOF_MONGO_URI ?? "";
let stopServer = async () => {};
if (!uri) {
  try {
    const { MongoMemoryReplSet } = await import("mongodb-memory-server-core");
    const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    uri = rs.getUri();
    stopServer = async () => { await rs.stop(); };
  } catch (e) {
    const why = (e as Error).message.split("\n")[0];
    if (process.env.CI) {
      console.error(`FAIL could not start MongoDB for the storage tests: ${why}`);
      process.exit(1);
    }
    console.log(`skipped: MongoDB could not be started here (${why}). These tests run in CI.`);
    process.exit(0);
  }
}

const client: Client = new MongoClient(uri);
await client.connect();
const used: string[] = [];

let passed = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     ")); process.exitCode = 1; }
};

/** A store on a fresh database. With `legacy`, the database first holds data in the earlier layout. */
async function make(legacy?: { data: Record<string, unknown>; revision: number; schemaVersion: number }) {
  const name = `dof_test_${randomBytes(6).toString("hex")}`;
  used.push(name);
  if (legacy) {
    const state = client.db(name).collection<Record<string, unknown>>("state");
    await state.insertOne({ _id: "meta", revision: legacy.revision, schemaVersion: legacy.schemaVersion } as never);
    for (const [k, data] of Object.entries(legacy.data)) await state.insertOne({ _id: k, v: 1, data } as never);
  }
  return storeOn(client, name);
}

try {
  await storageContract(t, make);

  await t("mongo: the earlier layout is left exactly as it was, as a backup", async () => {
    const s = await make({ data: { records: [{ contentId: "DOF-SER-001", title: "A" }] }, revision: 5, schemaVersion: 13 });
    await s.state.head();
    const name = used.at(-1)!;
    const old = await client.db(name).collection("state").find({}).toArray();
    assert.deepEqual(old.map((d) => d._id).sort(), ["meta", "records"]);
    assert.deepEqual((old.find((d) => d._id === "records") as unknown as { data: unknown }).data, [{ contentId: "DOF-SER-001", title: "A" }]);
  });

  await t("mongo: several servers starting at once upgrade the data once", async () => {
    const data = { records: Array.from({ length: 40 }, (_, n) => ({ contentId: `DOF-SER-${String(n + 1).padStart(3, "0")}` })) };
    const first = await make({ data, revision: 9, schemaVersion: 13 });
    const name = used.at(-1)!;
    const others = await Promise.all([1, 2, 3].map(() => storeOn(client, name)));
    const results = await Promise.allSettled([first, ...others].map((s) => s.state.head()));
    const ok = results.filter((r) => r.status === "fulfilled" && r.value);
    assert.ok(ok.length >= 1, "at least one server finished the upgrade");
    for (const r of results) if (r.status === "rejected") assert.match((r.reason as Error).message, /new layout/, "the others are asked to try again shortly");
    const again = await Promise.all([first, ...others].map((s) => s.state.head()));
    assert.ok(again.every((h) => h?.revision === 9));
    assert.equal(await client.db(name).collection("hub_items").countDocuments({ k: "records" }), 40, "no element twice");
  });

  await t("mongo: an upgrade left half done by a server that stopped is started again after a while", async () => {
    const s = await make({ data: { records: [{ contentId: "DOF-SER-001" }] }, revision: 3, schemaVersion: 13 });
    const name = used.at(-1)!;
    await client.db(name).collection("hub_meta").insertOne({ _id: "upgrading", at: new Date(Date.now() - 10 * 60 * 1000) } as never);
    const head = await s.state.head();
    assert.equal(head?.revision, 3);
    assert.equal(await client.db(name).collection("hub_meta").countDocuments({ _id: "upgrading" } as never), 0);
  });
} finally {
  for (const name of used) await client.db(name).dropDatabase().catch(() => undefined);
  await client.close();
  await stopServer();
}
console.log(`\n${passed} passed`);
