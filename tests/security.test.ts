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
  try { await fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
class Client {
  cookie = "";
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await fetch(base + path, { method, headers: { ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b: unknown = {}) => this.call("POST", p, b);
  act = (name: string, ...args: unknown[]) => this.post("/api/action", { name, args: [{ personId: "DOF-P-HOP-001", role: "HOP" }, ...args] });
}

const PW = "correct horse battery";
async function setupHop() {
  const c = new Client();
  const r = await c.post("/api/setup", { token: process.env.SETUP_TOKEN, name: "Kevin Mwangi", username: "kev", password: PW, samples: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return c;
}
async function loginFor(hop: Client, personId: string, username: string) {
  const made = await hop.post("/api/accounts/create", { personId, username });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const c = new Client();
  assert.equal((await c.post("/api/login", { username, password: made.json.temporaryPassword })).status, 200);
  assert.equal((await c.post("/api/account/password", { current: made.json.temporaryPassword, next: "a fresh password here" })).status, 200);
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
  const r = await hop.act("equipment.addGearToSheet", { id: "DOF-CS-001", contentId: "DOF-DOC-001", date: "2030-01-01" }, [{ equipmentId: "DOF-EQ-AUD-003", quantity: 1 }]);
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
  assert.equal((await brian.act("people.createPerson", { category: "HOP", name: "Second boss", email: "", phone: "", skills: [], equipmentFamiliarity: [] })).status, 400);
  assert.equal(await role(brian), "CRW");
});

await t("C2: 'Add and change people' cannot reset, switch off or sign out the Head of Production's login", async () => {
  const hop = await setupHop();
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-002", "people.manage", true);
  const brian = await loginFor(hop, "DOF-P-CRW-002", "brian");
  const hopId = (await hop.get("/api/session")).json.user.personId;
  for (const [path, body] of [["/api/accounts/reset", { personId: hopId }], ["/api/accounts/disable", { personId: hopId, disabled: true }], ["/api/accounts/signout", { personId: hopId }]] as const) {
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
  const r = await brian.act("settings.updateSettings", { stageReminderHours: 12, permissions: { roles: {}, people: { "DOF-P-CRW-002": { "backend.audit": true, "people.manage": true } } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const seen = await db(brian);
  assert.equal(seen.settings.stageReminderHours, 12);
  assert.equal(seen.audit.length, 0, "still cannot read the activity log");
  const grant = await brian.act("permissions.setPersonGrant", "DOF-P-CRW-002", "backend.audit", true);
  assert.equal(grant.status, 400);
});

server?.close();
console.log(`\n${passed} passed`);
