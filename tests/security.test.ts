// Run with: npm test -- security
// The attacks from the October 2026 code review, replayed against the real server over HTTP with data in
// memory. Each one worked before it was fixed; each test checks that it no longer does.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.SETUP_TOKEN = "test-setup-code-1234";
process.env.DOF_SCRYPT_N = "1024";

const { createHandler, memoryStore } = await import("../server/index");

let passed = 0;
let server: Server | undefined;
let base = "";
let store: ReturnType<typeof memoryStore>;

async function fresh() {
  store = memoryStore();
  server?.close();
  server = createServer(createHandler(async () => store));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const t = async (name: string, fn: () => Promise<void>) => {
  await fresh();
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).message);
    process.exitCode = 1;
  }
};

type Json = Record<string, any>;
class Client {
  cookie = "";
  /** The address the server sees, as Vercel reports it. */
  constructor(public address = "127.0.0.1") {}
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await fetch(base + path, {
      method,
      headers: {
        "x-forwarded-for": this.address,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b: unknown = {}) => this.call("POST", p, b);
  act = (name: string, ...args: unknown[]) =>
    this.post("/api/action", { name, args: [{ personId: "DOF-P-HOP-001", role: "HOP" }, ...args] });
}

const PW = "correct horse battery";
async function setupHop() {
  const c = new Client();
  const r = await c.post("/api/setup", {
    token: process.env.SETUP_TOKEN,
    name: "Kevin Mwangi",
    username: "kev",
    password: PW,
    samples: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return c;
}
async function loginFor(hop: Client, personId: string, username: string) {
  const made = await hop.post("/api/accounts/create", { personId, username });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const c = new Client();
  assert.equal((await c.post("/api/login", { username, password: made.json.temporaryPassword })).status, 200);
  assert.equal(
    (await c.post("/api/account/password", { current: made.json.temporaryPassword, next: "a fresh password here" })).status,
    200,
  );
  return c;
}
const db = async (c: Client): Promise<Json> => (await c.get("/api/state")).json.db;
const role = async (c: Client) => (await c.get("/api/session")).json.user.role;

// ── C1: request data written straight into records ──

await t("C1: crew cannot skip a stage gate by sending the stage as an edit", async () => {
  const hop = await setupHop();
  const crew = await loginFor(hop, "DOF-P-CRW-001", "wanjiru");
  const gate = await crew.act("content.advanceStage", "DOF-SER-001-S1-E01");
  assert.equal(gate.status, 400);
  await crew.act("content.updateRecord", "DOF-SER-001-S1-E01", { pipelineStage: "Published", parentId: null });
  const ep = (await db(hop)).records.find((r: Json) => r.contentId === "DOF-SER-001-S1-E01");
  assert.equal(ep.pipelineStage, "Editorial");
  assert.equal(ep.parentId, "DOF-SER-001-S1");
});

await t("C1: a call sheet cannot be marked final or moved by an edit", async () => {
  const hop = await setupHop();
  const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
  await crew.act("callsheets.updateCallSheet", "DOF-CS-001", { status: "final", contentId: "DOF-DOC-001" });
  const cs = (await db(hop)).callSheets.find((c: Json) => c.id === "DOF-CS-001");
  assert.deepEqual([cs.status, cs.contentId], ["draft", "DOF-SER-001"]);
});

await t("C1: crew without 'Assign other people's work' cannot hand a stage to someone else through an edit", async () => {
  const hop = await setupHop();
  const crew = await loginFor(hop, "DOF-P-CRW-001", "wanjiru");
  const r = await crew.act("content.updateRecord", "DOF-SER-001-S1-E01", { assigneePersonId: "DOF-P-CRW-003" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /other people's work/);
});

await t("C1: gear is booked against the call sheet's own project and date, whatever the request says", async () => {
  const hop = await setupHop();
  const cs = (await db(hop)).callSheets.find((c: Json) => c.id === "DOF-CS-001");
  const r = await hop.act("equipment.addGearToSheet", { id: "DOF-CS-001", contentId: "DOF-DOC-001", date: "2030-01-01" }, [
    { equipmentId: "DOF-EQ-AUD-003", quantity: 1 },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.result.contentId, r.json.result.date], [cs.contentId, cs.date]);
});

await t("C1: raw footage cannot be relabelled to get round the Delivered rule", async () => {
  const hop = await setupHop();
  const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
  const raw = (await db(hop)).allocations.find((a: Json) => a.kind === "raw" && a.contentId);
  assert.ok(raw, "sample data has raw footage on a drive");
  const r = await crew.act("storage.updateAllocation", raw.id, { kind: "other" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /stays marked as raw/);
});

// ── C2: delegable permissions that led to full admin ──

await t("C2: 'Add and change people' cannot make anyone Head of Production", async () => {
  const hop = await setupHop();
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-002", "people.manage", true);
  const brian = await loginFor(hop, "DOF-P-CRW-002", "brian");
  assert.equal((await brian.act("people.updatePersonCategory", "DOF-P-CRW-002", "HOP")).status, 400);
  assert.equal((await brian.act("people.updatePerson", "DOF-P-CRW-002", { category: "HOP" })).status, 200); // accepted, but the field is dropped
  assert.equal(
    (
      await brian.act("people.createPerson", {
        category: "HOP",
        name: "Second boss",
        email: "",
        phone: "",
        skills: [],
        equipmentFamiliarity: [],
      })
    ).status,
    400,
  );
  assert.equal(await role(brian), "CRW");
});

await t("C2: 'Add and change people' cannot reset, switch off or sign out the Head of Production's login", async () => {
  const hop = await setupHop();
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-002", "people.manage", true);
  const brian = await loginFor(hop, "DOF-P-CRW-002", "brian");
  const hopId = (await hop.get("/api/session")).json.user.personId;
  for (const [path, body] of [
    ["/api/accounts/reset", { personId: hopId }],
    ["/api/accounts/disable", { personId: hopId, disabled: true }],
    ["/api/accounts/signout", { personId: hopId }],
  ] as const) {
    const r = await brian.post(path, body);
    assert.equal(r.status, 403, `${path}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.temporaryPassword, undefined);
  }
  assert.equal(await role(hop), "HOP", "the Head of Production is still signed in");
  const edit = await brian.act("people.updatePerson", hopId, { email: "attacker@example.com" });
  assert.equal(edit.status, 400);
});

await t("C2: 'Add and change people' cannot take over someone with more access, but can manage people with less", async () => {
  const hop = await setupHop();
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-002", "people.manage", true);
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-001", "backend.audit", true);
  const brian = await loginFor(hop, "DOF-P-CRW-002", "brian");
  await loginFor(hop, "DOF-P-CRW-001", "wanjiru");
  await loginFor(hop, "DOF-P-VOL-001", "vol1");
  const up = await brian.post("/api/accounts/reset", { personId: "DOF-P-CRW-001" });
  assert.equal(up.status, 403);
  assert.match(up.json.error, /See the activity log/);
  const down = await brian.post("/api/accounts/reset", { personId: "DOF-P-VOL-001" });
  assert.equal(down.status, 200, JSON.stringify(down.json));
  assert.ok(down.json.temporaryPassword);
});

await t("C2: 'Change system settings' cannot grant permissions", async () => {
  const hop = await setupHop();
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-002", "backend.settings", true);
  const brian = await loginFor(hop, "DOF-P-CRW-002", "brian");
  const r = await brian.act("settings.updateSettings", {
    stageReminderHours: 12,
    permissions: { roles: {}, people: { "DOF-P-CRW-002": { "backend.audit": true, "people.manage": true } } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const seen = await db(brian);
  assert.equal(seen.settings.stageReminderHours, 12);
  assert.equal(seen.audit.length, 0, "still cannot read the activity log");
  const grant = await brian.act("permissions.setPersonGrant", "DOF-P-CRW-002", "backend.audit", true);
  assert.equal(grant.status, 400);
});

await t("M5: someone who cannot see a person's contact details cannot overwrite them either", async () => {
  const hop = await setupHop();
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-002", "people.manage", true);
  const brian = await loginFor(hop, "DOF-P-CRW-002", "brian");
  const before = (await db(hop)).people.find((p: Json) => p.personId === "DOF-P-VOL-001");
  const seen = (await db(brian)).people.find((p: Json) => p.personId === "DOF-P-VOL-001");
  assert.deepEqual([seen.email, seen.phone, seen.contactHidden], ["", "", true], "nothing that looks like data is sent in its place");
  // What the edit form used to send: the whole profile as shown, including the placeholders.
  const r = await brian.act("people.updatePerson", "DOF-P-VOL-001", {
    name: "Joseph K.",
    email: "Hidden",
    phone: "Hidden",
    skills: [],
    equipmentFamiliarity: [],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = (await db(hop)).people.find((p: Json) => p.personId === "DOF-P-VOL-001");
  assert.deepEqual([after.name, after.email, after.phone], ["Joseph K.", before.email, before.phone]);
});

// ── C3: the sign-in lockout ──

const guess = (c: Client, username = "kev") => c.post("/api/login", { username, password: `wrong guess ${Math.random()}` });

await t("C3: wrong passwords sent all at once are all counted, so at most five are ever checked", async () => {
  await setupHop();
  const results = await Promise.all(Array.from({ length: 40 }, () => guess(new Client("10.0.0.7"))));
  const checked = results.filter((r) => r.status === 401).length;
  const refused = results.filter((r) => r.status === 429).length;
  assert.equal(checked + refused, 40);
  assert.ok(checked <= 5, `${checked} guesses were checked against the password`);
  assert.equal(
    (await new Client("10.0.0.7").post("/api/login", { username: "kev", password: PW })).status,
    429,
    "even the right password waits",
  );
});

await t("C3: a stranger guessing at the Head of Production's username does not lock them out", async () => {
  await setupHop();
  for (let i = 0; i < 12; i++) await guess(new Client("203.0.113.9"));
  assert.equal((await guess(new Client("203.0.113.9"))).status, 429, "the guessing address is locked");
  assert.equal(
    (await new Client("198.51.100.4").post("/api/login", { username: "kev", password: PW })).status,
    200,
    "the real person, from their own address, still gets in",
  );
});

await t("C3: right passwords do not use up the limit for an office that shares one address", async () => {
  await setupHop();
  for (let i = 0; i < 40; i++)
    assert.equal((await new Client("192.0.2.1").post("/api/login", { username: "kev", password: PW })).status, 200, `sign-in ${i + 1}`);
});

await t("C3: guessing spread over many addresses is stopped at 100 for that username", async () => {
  await setupHop();
  for (let a = 0; a < 25; a++) for (let i = 0; i < 4; i++) await guess(new Client(`10.1.${a}.1`));
  assert.equal((await guess(new Client("10.2.0.1"))).status, 429);
});

await t("C3: a lock is written to the activity log once, not on every refused attempt", async () => {
  const hop = await setupHop();
  for (let i = 0; i < 9; i++) await guess(new Client("203.0.113.50"));
  const locks = (await db(hop)).audit.filter((e: Json) => e.action === "login-locked");
  assert.equal(locks.length, 1, JSON.stringify(locks));
});

await t("C3: setup codes and password changes are limited the same way", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      new Client("10.9.9.9").post("/api/setup", { token: `nope ${Math.random()}`, name: "X", username: "xx1", password: PW }),
    ),
  );
  assert.ok(results.filter((r) => r.status === 403).length <= 5);
  const hop = await setupHop();
  const changes = await Promise.all(
    Array.from({ length: 20 }, () =>
      hop.post("/api/account/password", { current: `wrong ${Math.random()}`, next: "another fresh password" }),
    ),
  );
  assert.ok(changes.filter((r) => r.status === 403).length <= 5);
  assert.ok(changes.some((r) => r.status === 429));
});

// ── H1: the browser and the server must agree on new IDs ──

const { setDb } = await import("../src/data/store");
const { setRpcSink } = await import("../src/data/rpc");
const W = await import("../src/services/wrapped/content");
type Call = { name: string; args: unknown[]; ids: string[] };
const actorOf = async (c: Client) => {
  const u = (await c.get("/api/session")).json.user;
  return { personId: u.personId, role: u.role };
};

/** Does what a signed-in page does: works on the snapshot it was sent, and records the calls it would send. */
async function asBrowser<T>(
  c: Client,
  fn: (actor: { personId: string; role: string }) => T,
  snapshot?: Json,
): Promise<{ out: T; calls: Call[] }> {
  setDb(structuredClone(snapshot ?? (await db(c))));
  const actor = await actorOf(c);
  const calls: Call[] = [];
  setRpcSink((call) => calls.push(call as Call));
  try {
    return { out: fn(actor), calls };
  } finally {
    setRpcSink(null);
  }
}
const send = (c: Client, call: Call) => c.post("/api/action", call);

await t("H1: after a project is archived, the next project gets the same number on screen and on the server", async () => {
  const hop = await setupHop();
  const first = await hop.act("content.createRecord", { category: "documentary", title: "Doc A" });
  await hop.act("content.deleteRecord", first.json.result.contentId); // archived projects are not sent to the browser
  const { out, calls } = await asBrowser(hop, (actor) => W.createRecord(actor as never, { category: "documentary", title: "Doc B" }));
  const saved = await send(hop, calls[0]);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.result.contentId, out.contentId);
  assert.notEqual(out.contentId, first.json.result.contentId, "an archived project's number is never reused");
  await hop.act("content.updateRecord", out.contentId, { notes: "edited from the screen" });
  const records = (await db(hop)).records as Json[];
  assert.equal(records.find((r) => r.contentId === out.contentId)?.notes, "edited from the screen");
});

await t(
  "H1: two people creating at the same moment: the second is refused, not saved under a number their screen never showed",
  async () => {
    const hop = await setupHop();
    const snapshot = await db(hop);
    const a = await asBrowser(hop, (actor) => W.createRecord(actor as never, { category: "series", title: "From screen A" }), snapshot);
    const b = await asBrowser(hop, (actor) => W.createRecord(actor as never, { category: "series", title: "From screen B" }), snapshot);
    assert.equal(a.out.contentId, b.out.contentId, "both screens showed the same next number");
    assert.equal((await send(hop, a.calls[0])).status, 200);
    const second = await send(hop, b.calls[0]);
    assert.equal(second.status, 409);
    assert.equal(second.json.code, "conflict");
    assert.match(second.json.error, /at the same moment/);
    const titles = ((await db(hop)).records as Json[]).filter((r) => r.contentId === a.out.contentId).map((r) => r.title);
    assert.deepEqual(titles, ["From screen A"]);
  },
);

await t("H1: checklist items made on screen keep their ID on the server, so the next edit finds them", async () => {
  const hop = await setupHop();
  const { out, calls } = await asBrowser(hop, (actor) => W.addTask(actor as never, "DOF-SER-001-S1-E01", { label: "Check the B-roll" }));
  assert.match(out.id, /^T-[a-z0-9]{8,24}$/);
  assert.equal((await send(hop, calls[0])).status, 200);
  const done = await hop.act("content.updateTask", "DOF-SER-001-S1-E01", out.id, { done: true });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.result.id, out.id);
});

await t("H1: a page cannot choose a malformed ID, or one already used", async () => {
  const hop = await setupHop();
  const existing = ((await db(hop)).records as Json[]).find((r) => r.contentId === "DOF-SER-001-S1-E01")!.tasks[0].id;
  for (const id of ["T-x", "DOF-SER-001", "T-<script>alert(1)</script>", existing]) {
    const r = await hop.post("/api/action", {
      name: "content.addTask",
      args: [{}, "DOF-SER-001-S1-E01", { label: `Task ${Math.random()}` }],
      ids: [id],
    });
    assert.equal(r.status, 409, `${id}: ${JSON.stringify(r.json)}`);
  }
  const wrongCount = await hop.post("/api/action", {
    name: "content.addTask",
    args: [{}, "DOF-SER-001-S1-E01", { label: "Two IDs" }],
    ids: ["T-aaaaaaaaaaaa", "T-bbbbbbbbbbbb"],
  });
  assert.equal(wrongCount.status, 409);
});

server?.close();
console.log(`\n${passed} passed`);
