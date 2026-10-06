// Run with: npm test -- storage
// How the server keeps data: the storage contract against the in-memory store, then the server end to end over
// HTTP for what the October 2026 review found (H2): every request loading everything, saves colliding, and
// photos, the activity log and document history making the download ever larger.
import { putBackEarlierExamples } from "./support/earlier-examples";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

process.env.SETUP_TOKEN = "test-setup-code-1234";
process.env.DOF_SCRYPT_N = "1024";

const { createHandler, memoryStore } = await import("../server/index");
const { storageContract } = await import("./support/storage-contract");
const { AUDIT_SENT, REVISIONS_WITH_TEXT } = await import("../server/state");
const { buildSeed } = await import("../src/data/seed");
type Store = ReturnType<typeof memoryStore>;

let passed = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 3).join("\n     "));
    process.exitCode = 1;
  }
};

await storageContract(
  t,
  async (legacy) => memoryStore(legacy),
  async (s, label) => {
    const copy = (
      s.state as unknown as { backups: Map<string, { items: { k: string; d: unknown }[]; head: { schemaVersion: number } | null }> }
    ).backups.get(label);
    return {
      records: (copy?.items ?? []).filter((it) => it.k === "records").map((it) => it.d),
      schemaVersion: copy?.head?.schemaVersion ?? null,
    };
  },
);

// ── The server, end to end ──

let server: Server | undefined;
let base = "";
let served: Store;
async function serve(store: Store) {
  served = store;
  server?.close();
  server = createServer(createHandler(async () => store));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A database round trip of a few milliseconds, like Atlas from a Vercel function, so requests really overlap. */
function slow(store: Store, ms = 15): Store {
  const s = store.state as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const k of ["head", "items", "commit"]) {
    const f = s[k].bind(store.state);
    s[k] = async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, ms));
      return f(...a);
    };
  }
  return store;
}

type Json = Record<string, any>;
class Client {
  cookie = "";
  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return fetch(base + path, {
      method,
      headers: {
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await this.raw(method, path, body);
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b: unknown = {}) => this.call("POST", p, b);
  act = (name: string, ...args: unknown[]) => this.post("/api/action", { name, args: [{}, ...args] });
}
async function setupHop(samples = true) {
  const c = new Client();
  const r = await c.post("/api/setup", {
    token: process.env.SETUP_TOKEN,
    name: "Kevin Mwangi",
    username: "kev",
    password: "correct horse battery",
    samples,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  if (samples) await putBackEarlierExamples(served);
  return c;
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

await t("H2: people saving at the same moment, to different projects, all get saved", async () => {
  await serve(slow(memoryStore()));
  const hop = await setupHop();
  const ids = [
    "DOF-SER-001",
    "DOF-LIVE-001",
    "DOF-LIVE-002",
    "DOF-DEV-001",
    "DOF-MUS-001",
    "DOF-DOC-001",
    "DOF-SER-001-S1",
    "DOF-SER-001-S1-E01",
    "DOF-SER-001-S1-E02",
    "DOF-SER-001-S1-E03",
    "DOF-SER-001-S1-E04",
    "DOF-LIVE-001-D1",
  ];
  const comments = await Promise.all(ids.map((id) => hop.act("content.addComment", id, "hello")));
  assert.deepEqual(
    comments.map((r) => r.status),
    ids.map(() => 200),
    "comments are a log: they never collide",
  );
  const edits = await Promise.all(ids.map((id) => hop.act("content.updateRecord", id, { notes: `note for ${id}` })));
  assert.deepEqual(
    edits.map((r) => r.status),
    ids.map(() => 200),
    "edits to the same part wait their turn and go through",
  );
  const records = (await hop.get("/api/state")).json.db.records as Json[];
  for (const id of ids) assert.equal(records.find((r) => r.contentId === id)?.notes, `note for ${id}`);
});

await t("H2: asking whether anything changed does not load the data", async () => {
  const store = memoryStore();
  await serve(store);
  const hop = await setupHop();
  const first = await hop.get("/api/state");
  let loads = 0;
  const items = store.state.items.bind(store.state);
  store.state.items = async (keys) => {
    loads++;
    return items(keys);
  };
  for (let i = 0; i < 5; i++) assert.equal((await hop.get(`/api/state?rev=${first.json.revision}`)).json.unchanged, true);
  assert.equal(loads, 0, "five polls, no loads");
  await hop.act("content.addComment", "DOF-SER-001", "something new");
  const changed = await hop.get(`/api/state?rev=${first.json.revision}`);
  assert.equal(changed.json.unchanged, undefined);
  assert.ok(changed.json.db.comments.some((c: Json) => c.text === "something new"));
});

await t("H2: the data is sent compressed", async () => {
  await serve(memoryStore());
  const hop = await setupHop();
  const res = await hop.raw("GET", "/api/state", undefined, { "Accept-Encoding": "gzip" });
  assert.equal(res.headers.get("content-encoding"), "gzip");
  const plain = await hop.get("/api/state");
  assert.ok(plain.json.db.records.length > 0);
  void gunzipSync;
});

await t("H2: photos are stored as files, sent as links, and only to people who are signed in", async () => {
  const store = memoryStore();
  await serve(store);
  const hop = await setupHop();
  const r = await hop.act("equipment.addAttachment", "DOF-EQ-CAM-001", "photo", { url: PNG, caption: "Front" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const me = await hop.act("people.updateOwnProfile", { photoUrl: PNG });
  assert.equal(me.status, 200, JSON.stringify(me.json));
  const state = await hop.get("/api/state");
  assert.ok(!JSON.stringify(state.json).includes("data:image"), "no photo is inside the data");
  const url = state.json.db.equipment.find((e: Json) => e.id === "DOF-EQ-CAM-001").photos.at(-1).url;
  assert.match(url, /^\/api\/file\?id=[a-f0-9]{32}$/);
  assert.equal(state.json.db.people.find((p: Json) => p.personId === "DOF-P-HOP-001").photoUrl, url, "the same photo is stored once");
  const img = await hop.raw("GET", url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.match(img.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from(PNG.split(",")[1], "base64"));
  assert.equal((await new Client().raw("GET", url)).status, 401, "not without signing in");
  assert.equal((await hop.raw("GET", "/api/file?id=../../etc/passwd")).status, 404);
});

await t("H2: only the newest activity log entries are sent, and the log is never loaded to make a change", async () => {
  const store = memoryStore();
  await serve(store);
  const hop = await setupHop();
  const many = Array.from({ length: AUDIT_SENT + 150 }, (_, n) => ({
    k: "audit",
    i: `A-old-${n}`,
    o: n,
    d: {
      id: `A-old-${n}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
      byPersonId: "DOF-P-HOP-001",
      action: "test",
      entity: "test",
      entityId: String(n),
      detail: "",
    },
  }));
  await store.state.commit({ put: many, remove: [], expect: {}, schemaVersion: 14 });
  let auditLoaded = false;
  const items = store.state.items.bind(store.state);
  store.state.items = async (keys) => {
    if (keys.includes("audit")) auditLoaded = true;
    return items(keys);
  };
  await hop.act("content.addComment", "DOF-SER-001", "after the old entries");
  const audit = (await hop.get("/api/state")).json.db.audit as Json[];
  assert.equal(audit.length, AUDIT_SENT);
  assert.equal(audit.at(-1).action, "comment", "the newest entry is last, as before");
  assert.equal(auditLoaded, false);
});

await t("H2: older document revisions are sent without their text, and the history fetches it", async () => {
  const store = memoryStore();
  await serve(store);
  const hop = await setupHop();
  const db0 = (await hop.get("/api/state")).json.db;
  const doc = db0.docs[0];
  const revs = Array.from({ length: REVISIONS_WITH_TEXT + 3 }, (_, n) => ({
    k: "docRevisions",
    i: `REV-t${n}`,
    o: 1e6 + n,
    d: {
      id: `REV-t${n}`,
      docId: doc.id,
      version: 100 + n,
      at: new Date(Date.now() + (n + 1) * 60_000).toISOString(),
      byPersonId: "DOF-P-HOP-001",
      title: doc.title,
      body: `body ${n}`,
      note: "Edited",
    },
  }));
  await store.state.commit({ put: revs, remove: [], expect: {}, schemaVersion: 14 });
  const sent = ((await hop.get("/api/state")).json.db.docRevisions as Json[]).filter((r) => r.docId === doc.id && r.id.startsWith("REV-t"));
  assert.equal(sent.filter((r) => !r.trimmed).length, REVISIONS_WITH_TEXT);
  assert.ok(sent.filter((r) => r.trimmed).every((r) => r.body === ""));
  const full = await hop.get(`/api/doc-history?docId=${encodeURIComponent(doc.id)}`);
  assert.equal(full.status, 200);
  assert.ok((full.json.revisions as Json[]).filter((r) => r.id.startsWith("REV-t")).every((r) => !r.trimmed && r.body.startsWith("body ")));
  assert.equal((await hop.get("/api/doc-history?docId=nope")).status, 404);
});

await t("H2: data saved by the earlier layout is upgraded on first use, and works", async () => {
  const seed = buildSeed() as unknown as Record<string, unknown>;
  const people = (seed.people as Json[]).map((p) => (p.category === "HOP" ? { ...p, photoUrl: PNG, hasLogin: true, username: "kev" } : p));
  const equipment = (seed.equipment as Json[]).map((e, n) =>
    n === 0 ? { ...e, photos: [{ id: "ATT-00001", url: PNG, caption: "", at: new Date().toISOString(), byPersonId: "DOF-P-HOP-001" }] } : e,
  );
  const counters = { ...(seed.counters as Record<string, number>) };
  for (const k of Object.keys(counters)) if (k.startsWith("record:")) delete counters[k]; // saved before project counters existed
  const store = memoryStore({ data: { ...seed, people, equipment, counters }, revision: 77, schemaVersion: 13 });
  // The Head of Production's login, which lives outside the data.
  const { hashPassword } = await import("../server/crypto");
  const now = new Date().toISOString();
  await store.users.insert({
    _id: "kev",
    personId: "DOF-P-HOP-001",
    passwordHash: await hashPassword("correct horse battery"),
    disabled: false,
    mustChange: false,
    createdAt: now,
    passwordChangedAt: now,
    lastLoginAt: null,
  });
  await serve(store);
  const hop = new Client();
  assert.equal((await hop.post("/api/login", { username: "kev", password: "correct horse battery" })).status, 200);
  const state = await hop.get("/api/state");
  assert.equal(state.status, 200, JSON.stringify(state.json).slice(0, 300));
  assert.ok(!JSON.stringify(state.json).includes("data:image"));
  assert.equal(state.json.db.schemaVersion, 19, "brought up to the current version");
  assert.ok(state.json.db.counters["record:SER"] >= 1, "project counters were set from the data");
  const photo = state.json.db.people.find((p: Json) => p.personId === "DOF-P-HOP-001").photoUrl;
  assert.equal((await hop.raw("GET", photo)).status, 200);
  const made = await hop.act("content.createRecord", { category: "series", title: "After the upgrade" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.result.contentId, "DOF-SER-002");
});

server?.close();
console.log(`\n${passed} passed`);
