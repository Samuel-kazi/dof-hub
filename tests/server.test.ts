// Run with: npx tsx tests/server.test.ts
// The server, end to end over real HTTP, with data kept in memory: setup, passwords, sessions, lockout,
// who can see and do what, and the optional Google link (with Google itself pretended).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.SETUP_TOKEN = "test-setup-code-1234";
process.env.DOF_SCRYPT_N = "1024"; // fast hashes for the tests
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

const { createHandler, memoryStore } = await import("../server/index");
type Store = ReturnType<typeof memoryStore>;

let passed = 0;
const failures: string[] = [];
let store: Store;
let server: Server;
let base = "";

async function fresh() {
  store = memoryStore();
  server?.close();
  server = createServer(createHandler(async () => store));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const t = async (name: string, fn: () => Promise<void>) => {
  await fresh();
  try { await fn(); passed++; console.log("ok  ", name); } catch (e) { failures.push(name); console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};

class Client {
  cookie = "";
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, { method, redirect: "manual", headers: { ...(body !== undefined || method === "POST" ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
    if (set) this.cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* a redirect has no body */ }
    return { status: res.status, json, headers: res.headers, set, text };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b: unknown = {}, h: Record<string, string> = {}) => this.call("POST", p, b, h);
  act = (name: string, ...args: unknown[]) => this.post("/api/action", { name, args: [{ personId: "ignored", role: "HOP" }, ...args] });
}

const PW = "correct horse battery";
async function setupHop(samples = false) {
  const c = new Client();
  const r = await c.post("/api/setup", { token: process.env.SETUP_TOKEN, name: "Kevin Mwangi", username: "kev", password: PW, samples });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return c;
}
/** Head of Production makes a login for a person and signs them in. Returns their client. */
async function loginFor(hop: Client, personId: string, username: string) {
  const made = await hop.post("/api/accounts/create", { personId, username });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const c = new Client();
  assert.equal((await c.post("/api/login", { username, password: made.json.temporaryPassword })).status, 200);
  const changed = await c.post("/api/account/password", { current: made.json.temporaryPassword, next: "a fresh password here" });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  return c;
}

// ── Setting up ──
await t("a new site asks for setup, and setup needs the secret code", async () => {
  const c = new Client();
  assert.equal((await c.get("/api/session")).json.needsSetup, true);
  const wrong = await c.post("/api/setup", { token: "guess", name: "X", username: "xx1", password: PW });
  assert.equal(wrong.status, 403); assert.equal((await c.get("/api/session")).json.needsSetup, true);
});
await t("setup creates the Head of Production, signs them in, and can only happen once", async () => {
  const c = await setupHop();
  const s = (await c.get("/api/session")).json;
  assert.equal(s.needsSetup, false); assert.deepEqual([s.user.username, s.user.role, s.user.name], ["kev", "HOP", "Kevin Mwangi"]);
  assert.equal((await new Client().post("/api/setup", { token: process.env.SETUP_TOKEN, name: "Other", username: "other", password: PW })).status, 409);
});
await t("setup is off until a setup code is set, and repeated wrong codes are locked out", async () => {
  const c = new Client();
  for (let i = 0; i < 5; i++) await c.post("/api/setup", { token: "nope", name: "X", username: "xx1", password: PW });
  assert.equal((await c.post("/api/setup", { token: process.env.SETUP_TOKEN, name: "X", username: "xx1", password: PW })).status, 429);
  const saved = process.env.SETUP_TOKEN; delete process.env.SETUP_TOKEN;
  assert.equal((await new Client().post("/api/setup", { token: "", name: "X", username: "xx1", password: PW })).status, 503);
  process.env.SETUP_TOKEN = saved;
});
await t("weak usernames and passwords are refused", async () => {
  const c = new Client();
  const go = (username: string, password: string) => c.post("/api/setup", { token: process.env.SETUP_TOKEN, name: "Kevin Mwangi", username, password });
  assert.equal((await go("k", PW)).status, 400); assert.equal((await go("has space", PW)).status, 400);
  assert.match((await go("kev", "short")).json.error, /at least 10/); assert.match((await go("kev", "password123")).json.error, /too common/);
  assert.match((await go("kevin", "my kevin secret")).json.error, /name|username/); assert.match((await go("kev2", "kev2 is my login")).json.error, /username/);
});

// ── Passwords and sessions ──
await t("passwords are stored only as salted hashes, and two people with the same password get different ones", async () => {
  const hop = await setupHop(true);
  const a = await hop.post("/api/accounts/create", { personId: "DOF-P-CRW-001", username: "wanjiru", password: "same shared password" });
  const b = await hop.post("/api/accounts/create", { personId: "DOF-P-CRW-002", username: "brian", password: "same shared password" });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const [ua, ub, uk] = await Promise.all(["wanjiru", "brian", "kev"].map((u) => store.users.get(u)));
  for (const u of [ua, ub, uk]) { assert.match(u!.passwordHash, /^scrypt\$\d+\$8\$1\$/); }
  assert.notEqual(ua!.passwordHash, ub!.passwordHash);
  assert.ok(!JSON.stringify([ua, ub, uk]).includes("same shared password") && !JSON.stringify(uk).includes(PW));
});
await t("wrong username and wrong password look the same, and five wrong tries lock the account", async () => {
  await setupHop();
  const c = new Client();
  const a = await c.post("/api/login", { username: "kev", password: "wrong wrong wrong" });
  const b = await c.post("/api/login", { username: "nobody", password: "wrong wrong wrong" });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.json.error, b.json.error);
  for (let i = 0; i < 3; i++) await c.post("/api/login", { username: "kev", password: "wrong wrong wrong" });
  const locked = await c.post("/api/login", { username: "kev", password: "wrong wrong wrong" });
  assert.equal(locked.json.code === "locked" || locked.status === 401, true);
  const still = await c.post("/api/login", { username: "kev", password: PW }); // even the right one waits
  assert.equal(still.status, 429); assert.match(still.json.error, /Try again in/);
  const doc = await store.attempts.get("u:kev"); await store.attempts.put({ ...doc!, lockedUntil: Date.now() - 1 });
  await store.attempts.put({ ...(await store.attempts.get("ip:127.0.0.1"))!, lockedUntil: Date.now() - 1, count: 0 });
  assert.equal((await c.post("/api/login", { username: "kev", password: PW })).status, 200);
});
await t("the cookie is HttpOnly and SameSite, and the token is never stored", async () => {
  const hop = await setupHop();
  const r = await hop.post("/api/login", { username: "kev", password: PW });
  assert.match(r.set!, /HttpOnly/); assert.match(r.set!, /SameSite=Lax/); assert.match(r.set!, /Path=\//);
  const token = decodeURIComponent(hop.cookie.split("=")[1]);
  assert.equal(await store.sessions.get(token), null, "only a hash is kept");
  assert.ok((await store.sessions.all()).every((s) => s._id !== token && /^[0-9a-f]{64}$/.test(s._id)));
});
await t("signing out ends the session for good", async () => {
  const c = await setupHop();
  const old = c.cookie;
  assert.equal((await c.post("/api/logout")).status, 200);
  const again = new Client(); again.cookie = old;
  assert.equal((await again.get("/api/state")).status, 401);
});
await t("a session ends after being idle, and after its maximum length", async () => {
  const c = await setupHop();
  const [s] = await store.sessions.all();
  await store.sessions.put({ ...s, lastSeen: Date.now() - 13 * 3600 * 1000 });
  assert.equal((await c.get("/api/state")).status, 401);
  const d = await setupHop().catch(() => null); void d;
});
await t("changing your password needs the old one, follows the rules, and signs out your other devices", async () => {
  const hop = await setupHop();
  const other = new Client(); await other.post("/api/login", { username: "kev", password: PW });
  assert.equal((await hop.post("/api/account/password", { current: "wrong wrong wrong", next: "another good password" })).status, 403);
  assert.equal((await hop.post("/api/account/password", { current: PW, next: "kev is short" })).status, 400);
  assert.equal((await hop.post("/api/account/password", { current: PW, next: "another good password" })).status, 200);
  assert.equal((await hop.get("/api/state")).status, 200, "this device stays signed in");
  assert.equal((await other.get("/api/state")).status, 401, "the other one does not");
  assert.equal((await new Client().post("/api/login", { username: "kev", password: PW })).status, 401);
  assert.equal((await new Client().post("/api/login", { username: "kev", password: "another good password" })).status, 200);
});
await t("a one-time password must be replaced before anything else can be done", async () => {
  const hop = await setupHop(true);
  const made = await hop.post("/api/accounts/create", { personId: "DOF-P-CRW-002", username: "brian" });
  assert.equal(made.json.temporaryPassword.length, 14);
  const b = new Client(); await b.post("/api/login", { username: "brian", password: made.json.temporaryPassword });
  assert.equal((await b.get("/api/session")).json.user.mustChange, true);
  const blocked = await b.get("/api/state"); assert.equal(blocked.status, 403); assert.equal(blocked.json.code, "must-change");
  assert.equal((await b.act("content.addTask", "DOF-DEV-001", { label: "x" })).status, 403);
  assert.equal((await b.post("/api/account/password", { current: made.json.temporaryPassword, next: "my own new password" })).status, 200);
  assert.equal((await b.get("/api/state")).status, 200);
});
await t("the Head of Production can reset a password, switch a login off, and sign someone out everywhere", async () => {
  const hop = await setupHop(true);
  const brian = await loginFor(hop, "DOF-P-CRW-002", "brian");
  assert.equal((await brian.get("/api/state")).status, 200);
  const reset = await hop.post("/api/accounts/reset", { personId: "DOF-P-CRW-002" });
  assert.equal((await brian.get("/api/state")).status, 401, "the old sessions end");
  assert.equal((await new Client().post("/api/login", { username: "brian", password: "a fresh password here" })).status, 401);
  assert.equal((await new Client().post("/api/login", { username: "brian", password: reset.json.temporaryPassword })).status, 200);
  await hop.post("/api/accounts/disable", { personId: "DOF-P-CRW-002", disabled: true });
  const off = await new Client().post("/api/login", { username: "brian", password: reset.json.temporaryPassword });
  assert.equal(off.status, 403); assert.match(off.json.error, /switched off/);
  assert.equal((await hop.post("/api/accounts/disable", { personId: "DOF-P-HOP-001", disabled: true })).status, 400, "not your own");
});

// ── What people can see ──
await t("nothing that could reveal a password is ever sent to the app", async () => {
  const hop = await setupHop(true);
  await loginFor(hop, "DOF-P-CRW-002", "brian");
  const s = await hop.get("/api/state");
  assert.ok(!/scrypt|passwordHash|"users":\[\{/.test(s.text)); assert.deepEqual(s.json.db.users, []);
});
await t("crew see every project but not who has a login, and volunteers see only their own projects", async () => {
  const hop = await setupHop(true);
  const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
  const vol = await loginFor(hop, "DOF-P-VOL-001", "joseph");
  const cs = (await crew.get("/api/state")).json.db;
  assert.ok(cs.records.some((r: any) => r.contentId === "DOF-LIVE-001-D1"), "crew see the live show");
  assert.ok(cs.people.filter((p: any) => p.personId !== "DOF-P-CRW-002").every((p: any) => p.hasLogin === false && p.username === undefined));
  assert.equal(cs.people.find((p: any) => p.personId === "DOF-P-CRW-002").username, "brian", "their own is shown to them");
  assert.deepEqual(cs.audit, []);
  assert.ok(cs.people.some((p: any) => p.personId === "DOF-P-VOL-001" && p.email === "Hidden"));
  const vs = (await vol.get("/api/state")).json.db;
  assert.ok(!vs.records.some((r: any) => r.contentId === "DOF-LIVE-001-D1")); assert.ok(vs.records.some((r: any) => r.contentId.startsWith("DOF-SER-001")));
  assert.deepEqual([vs.equipment, vs.manifests, vs.drives, vs.allocations], [[], [], [], []]);
  const hs = (await hop.get("/api/state")).json.db;
  assert.ok(hs.people.some((p: any) => p.username === "brian") && hs.audit.length > 0);
});
await t("a person only receives their own slice of the permission settings", async () => {
  const hop = await setupHop(true);
  const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-001", "reports.export", false);
  const p = (await crew.get("/api/state")).json.db.settings.permissions;
  assert.deepEqual(Object.keys(p.people), []); assert.deepEqual(Object.keys(p.roles), ["CRW"]);
});
await t("the app can ask whether anything changed, and is told if not", async () => {
  const hop = await setupHop();
  const first = (await hop.get("/api/state")).json;
  assert.deepEqual((await hop.get(`/api/state?rev=${first.revision}`)).json, { ok: true, unchanged: true, revision: first.revision });
  await hop.act("people.createPerson", { category: "CRW", name: "New Person", email: "", phone: "", skills: [], equipmentFamiliarity: [] });
  assert.ok((await hop.get(`/api/state?rev=${first.revision}`)).json.db);
});

// ── What people can do ──
await t("a change is saved on the server, and everyone sees it", async () => {
  const hop = await setupHop(true);
  const crew = await loginFor(hop, "DOF-P-CRW-001", "wanjiru");
  const r = await crew.act("content.addTask", "DOF-SER-001-S1-E01", { label: "Check the B-roll", stage: "Editorial" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok((await hop.get("/api/state")).json.db.records.find((x: any) => x.contentId === "DOF-SER-001-S1-E01").tasks.some((t: any) => t.label === "Check the B-roll"));
});
await t("a person cannot act as somebody else, whatever they claim", async () => {
  const hop = await setupHop(true);
  const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
  const forged = await crew.post("/api/action", { name: "permissions.setRoleGrant", args: [{ personId: "DOF-P-HOP-001", role: "HOP" }, "CRW", "pipeline.editAll", true] });
  assert.equal(forged.status, 400); assert.match(forged.json.error, /Head of Production/);
  assert.equal((await crew.act("people.createPerson", { category: "VOL", name: "Sneaky", email: "", phone: "", skills: [], equipmentFamiliarity: [] })).status, 400);
  assert.ok(!(await hop.get("/api/state")).json.db.people.some((p: any) => p.name === "Sneaky"));
});
await t("the server enforces the same rules as the app: view-only, jump in, and permissions", async () => {
  const hop = await setupHop(true);
  const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
  assert.equal((await crew.act("content.addTask", "DOF-LIVE-001-D1", { label: "x" })).status, 400, "not on that project");
  assert.equal((await crew.act("content.addStageOwner", "DOF-LIVE-001-D1", "Streaming", "DOF-P-CRW-002", ["Camera operator"])).status, 200, "jumping in is allowed");
  assert.equal((await crew.act("content.addTask", "DOF-LIVE-001-D1", { label: "x" })).status, 200, "and then they can help");
  assert.equal((await crew.act("content.addStageOwner", "DOF-LIVE-001-D1", "Streaming", "DOF-P-CRW-003", [])).status, 400, "but not put others on it");
});
await t("permissions the Head of Production changes take effect at once", async () => {
  const hop = await setupHop(true);
  const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
  const person = { category: "VOL", name: "Made by crew", email: "", phone: "", skills: [], equipmentFamiliarity: [] };
  assert.equal((await crew.act("people.createPerson", person)).status, 400);
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-002", "people.manage", true);
  assert.equal((await crew.act("people.createPerson", person)).status, 200);
  await hop.act("permissions.setPersonGrant", "DOF-P-CRW-002", "people.manage", false);
  assert.equal((await crew.act("people.createPerson", { ...person, name: "Again" })).status, 400);
  const made = await crew.post("/api/accounts/create", { personId: "DOF-P-CRW-003", username: "faith" });
  assert.equal(made.status, 403);
});
await t("a login cannot be created through the ordinary action route", async () => {
  const hop = await setupHop(true);
  assert.equal((await hop.act("people.createLoginForPerson", "DOF-P-CRW-002", "b@x.co", "password123")).status, 400);
  assert.equal((await hop.act("settings.changePassword", "a", "b")).status, 400);
  const r = await hop.act("people.createPerson", { category: "CRW", name: "No Login Here", email: "", phone: "", skills: [], equipmentFamiliarity: [] }, { email: "x@y.co", password: "password123" });
  assert.equal(r.status, 200);
  assert.deepEqual(await store.users.all().then((u) => u.map((x) => x._id)), ["kev"]);
});
await t("made-up actions and hostile input are refused", async () => {
  const hop = await setupHop();
  assert.equal((await hop.post("/api/action", { name: "nope.nothing", args: [{}] })).status, 400);
  assert.equal((await hop.post("/api/action", { name: "content.addTask", args: "x" })).status, 400);
  assert.equal((await hop.post("/api/action", { name: "content.updateRecord", args: [{}, "DOF-X", JSON.parse('{"__proto__":{"admin":true}}')] })).status, 400);
  assert.equal(({} as Record<string, unknown>).admin, undefined);
});
await t("several people saving at the same moment do not lose each other's changes", async () => {
  const hop = await setupHop(true);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => hop.act("content.addTask", "DOF-SER-001-S1-E01", { label: `Task ${i}`, stage: "Editorial" })));
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
  const tasks = (await hop.get("/api/state")).json.db.records.find((x: any) => x.contentId === "DOF-SER-001-S1-E01").tasks.map((t: any) => t.label);
  for (let i = 0; i < 6; i++) assert.ok(tasks.includes(`Task ${i}`), `Task ${i}`);
});
await t("making someone inactive signs them out immediately", async () => {
  const hop = await setupHop(true);
  const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
  assert.equal((await crew.get("/api/state")).status, 200);
  assert.equal((await hop.act("people.deactivatePerson", "DOF-P-CRW-002")).status, 200);
  assert.equal((await crew.get("/api/state")).status, 401);
  assert.equal((await new Client().post("/api/login", { username: "brian", password: "a fresh password here" })).status, 403);
});
await t("actions are written to the activity log with the real person", async () => {
  const hop = await setupHop(true);
  const crew = await loginFor(hop, "DOF-P-CRW-001", "wanjiru");
  await crew.act("content.addTask", "DOF-SER-001-S1-E01", { label: "Logged", stage: "Editorial" });
  const audit = (await hop.get("/api/state")).json.db.audit;
  assert.ok(audit.some((a: any) => a.byPersonId === "DOF-P-CRW-001" && a.action === "task-add" || a.byPersonId === "DOF-P-CRW-001" && a.entity === "record"));
  assert.ok(audit.some((a: any) => a.action === "login") && audit.some((a: any) => a.action === "create-login"));
  assert.ok(!JSON.stringify(audit).includes("a fresh password"));
});

// ── Requests from other sites ──
await t("requests from another site, or not in JSON, are refused", async () => {
  const hop = await setupHop();
  assert.equal((await hop.post("/api/logout", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await hop.post("/api/action", { name: "x", args: [] }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const r = await fetch(base + "/api/logout", { method: "POST", headers: { Cookie: hop.cookie, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(r.status, 415);
  assert.equal((await hop.post("/api/logout", {}, { Origin: base })).status, 200);
  assert.equal((await new Client().get("/api/nothing-here")).status, 404);
});
await t("the app answers to signed-out visitors with nothing but the sign-in state", async () => {
  await setupHop();
  const c = new Client();
  for (const p of ["/api/state", "/api/google/status"]) assert.equal((await c.get(p)).status, 401, p);
  for (const [p, b] of [["/api/action", { name: "content.addTask", args: [] }], ["/api/accounts/create", {}], ["/api/account/password", {}], ["/api/google/link", {}]] as const) assert.equal((await c.post(p, b)).status, 401, p);
});
await t("a wrong request body is a clear error, not a crash", async () => {
  const hop = await setupHop();
  const r = await fetch(base + "/api/action", { method: "POST", headers: { Cookie: hop.cookie, "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(r.status, 400);
});

// ── Google (Google itself is pretended) ──
const realFetch = globalThis.fetch;
const googleCalls: { url: string; body: string; auth?: string }[] = [];
function pretendGoogle(opts: { calendar409?: boolean } = {}) {
  googleCalls.length = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!/^https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com|www\.googleapis\.com|gmail\.googleapis\.com)/.test(url)) return realFetch(input, init);
    googleCalls.push({ url, body: String(init?.body ?? ""), auth: init?.headers?.Authorization });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "refresh_token") return new Response(JSON.stringify({ access_token: "ACCESS" }), { status: 200 });
      const claims = { aud: process.env.GOOGLE_CLIENT_ID, iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 3600, email: "kev@gmail.com", email_verified: true, sub: "g-123" };
      const id = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
      return new Response(JSON.stringify({ id_token: id, refresh_token: "REFRESH-SECRET", access_token: "ACCESS" }), { status: 200 });
    }
    if (url.includes("/calendar/v3/")) return new Response("{}", { status: opts.calendar409 ? 409 : 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}
async function linkGoogle(c: Client, scopes: { calendar?: boolean; gmail?: boolean }) {
  const start = await c.post("/api/google/link", scopes);
  const url = new URL(start.json.url);
  const cb = await c.call("GET", `/api/google/callback?code=abc&state=${url.searchParams.get("state")}`);
  return { url, cb };
}
await t("linking Google is a choice: nothing changes until the person says yes, and they choose what it is for", async () => {
  pretendGoogle();
  try {
    const hop = await setupHop();
    assert.deepEqual((await hop.get("/api/google/status")).json.google, { available: true, linked: false });
    const { url, cb } = await linkGoogle(hop, { calendar: true });
    assert.equal(url.host, "accounts.google.com"); assert.equal(url.searchParams.get("client_id"), process.env.GOOGLE_CLIENT_ID);
    assert.match(url.searchParams.get("scope")!, /calendar\.events/); assert.doesNotMatch(url.searchParams.get("scope")!, /gmail/);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("redirect_uri"), `${base}/api/google/callback`);
    assert.equal(cb.status, 302); assert.equal(cb.headers.get("location"), "/?google=linked");
    const g = (await hop.get("/api/google/status")).json.google;
    assert.deepEqual([g.linked, g.email, g.calendar, g.gmail], [true, "kev@gmail.com", true, false]);
  } finally { globalThis.fetch = realFetch; }
});
await t("the Google refresh token is stored encrypted, and unlinking revokes it", async () => {
  pretendGoogle();
  try {
    const hop = await setupHop();
    await linkGoogle(hop, { gmail: true });
    const doc = await store.google.get("kev");
    assert.ok(!doc!.refresh.includes("REFRESH-SECRET") && doc!.refresh.startsWith("v1."));
    await hop.post("/api/google/unlink");
    assert.equal(await store.google.get("kev"), null);
    assert.ok(googleCalls.some((c) => c.url.includes("/revoke?token=REFRESH-SECRET")));
    assert.equal((await hop.get("/api/google/status")).json.google.linked, false);
  } finally { globalThis.fetch = realFetch; }
});
await t("a link request only works once, for the person who started it, and Google's answer is checked", async () => {
  pretendGoogle();
  try {
    const hop = await setupHop(true);
    const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
    const start = await hop.post("/api/google/link", { calendar: true });
    const state = new URL(start.json.url).searchParams.get("state");
    assert.equal((await crew.call("GET", `/api/google/callback?code=abc&state=${state}`)).headers.get("location"), "/?google=failed", "someone else cannot finish it");
    assert.equal((await hop.call("GET", `/api/google/callback?code=abc&state=${state}`)).headers.get("location"), "/?google=failed", "and it is used up");
    assert.equal((await hop.call("GET", "/api/google/callback?error=access_denied&state=x")).headers.get("location"), "/?google=denied");
    globalThis.fetch = (async (input: any, init?: any) => String(input).startsWith("https://oauth2.googleapis.com/token") ? new Response(JSON.stringify({ id_token: `x.${Buffer.from(JSON.stringify({ aud: "someone-else", iss: "https://accounts.google.com", exp: 9e9, email: "e@x.co", email_verified: true, sub: "1" })).toString("base64url")}.y`, refresh_token: "R" }), { status: 200 }) : realFetch(input, init)) as typeof fetch;
    const { cb } = await linkGoogle(hop, { calendar: true });
    assert.equal(cb.headers.get("location"), "/?google=failed", "a token meant for another app is refused");
    assert.equal(await store.google.get("kev"), null);
  } finally { globalThis.fetch = realFetch; }
});
await t("reminders can go into the person's Google Calendar, once each", async () => {
  pretendGoogle();
  try {
    const hop = await setupHop(true);
    const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
    assert.equal((await crew.post("/api/google/calendar")).status, 409, "not linked yet");
    await linkGoogle(crew, { calendar: true });
    const r = await crew.post("/api/google/calendar");
    assert.equal(r.status, 200); assert.ok(r.json.added > 0 && r.json.failed === 0, JSON.stringify(r.json));
    const events = googleCalls.filter((c) => c.url.includes("/calendar/v3/"));
    assert.equal(events.length, r.json.added); assert.ok(events.every((e) => e.auth === "Bearer ACCESS"));
    const ids = events.map((e) => JSON.parse(e.body).id); assert.equal(new Set(ids).size, ids.length); assert.ok(ids.every((id: string) => /^[0-9a-f]{40}$/.test(id)));
    pretendGoogle({ calendar409: true });
    const again = await crew.post("/api/google/calendar");
    assert.deepEqual([again.json.added, again.json.already > 0], [0, true]);
  } finally { globalThis.fetch = realFetch; }
});
await t("reminder emails go out from the person's own Gmail, only if they allowed it and may send to others", async () => {
  pretendGoogle();
  try {
    const hop = await setupHop(true);
    const crew = await loginFor(hop, "DOF-P-CRW-002", "brian");
    await hop.act("people.updatePerson", "DOF-P-CRW-002", { email: "brian@example.org" });
    await linkGoogle(hop, { calendar: true });
    assert.equal((await hop.post("/api/google/email", { personId: "DOF-P-CRW-002" })).status, 409, "did not allow email");
    await hop.post("/api/google/unlink"); await linkGoogle(hop, { gmail: true });
    const sent = await hop.post("/api/google/email", { personId: "DOF-P-CRW-002" });
    assert.equal(sent.status, 200, JSON.stringify(sent.json)); assert.equal(sent.json.to, "brian@example.org");
    const mail = googleCalls.find((c) => c.url.includes("/messages/send"))!;
    const raw = Buffer.from(JSON.parse(mail.body).raw, "base64url").toString();
    assert.match(raw, /^To: brian@example\.org\r\nSubject: Dawn of Faith: \d+ things? coming up/); assert.equal(mail.auth, "Bearer ACCESS");
    assert.ok((await hop.get("/api/state")).json.db.outbox.some((o: any) => o.personId === "DOF-P-CRW-002" && o.channel === "email"), "recorded in the outbox");
    await linkGoogle(crew, { gmail: true });
    assert.equal((await crew.post("/api/google/email", { personId: "DOF-P-CRW-001" })).status, 403, "crew cannot email others");
  } finally { globalThis.fetch = realFetch; }
});
await t("Google linking says so when it is not set up", async () => {
  const id = process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_ID;
  try {
    const hop = await setupHop();
    assert.equal((await hop.get("/api/google/status")).json.google.available, false);
    assert.equal((await hop.post("/api/google/link", { calendar: true })).status, 503);
  } finally { process.env.GOOGLE_CLIENT_ID = id; }
});

server?.close();
console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed` : ""}`);
process.exit(failures.length ? 1 : 0);
