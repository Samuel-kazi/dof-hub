// Run with: npm test -- workflow-http
// Phase 2 of the five-stage workflow, against the real server over HTTP: share links (made by the server, opened by
// anyone with the link, reaching their own episode only, revoked and made again), the daily review-window check,
// and the cron address.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.SETUP_TOKEN = "test-setup-code-1234";
process.env.DOF_SCRYPT_N = "1024";
process.env.CRON_SECRET = "cron-secret-for-tests";

const { createHandler, memoryStore } = await import("../server/index");
const { mutateState } = await import("../server/state");
const W = await import("../src/services/workflow");
const { walkWhispersOfWhy, FINAL_LINK } = await import("./support/wow-walkthrough");
type Store = ReturnType<typeof memoryStore>;

let passed = 0;
let server: Server | undefined;
let base = "";
let store: Store;

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
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     "));
    process.exitCode = 1;
  }
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
class Client {
  cookie = "";
  async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: Json; headers: Headers; text: string }> {
    const res = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON: a share link's page */
    }
    return { status: res.status, json, headers: res.headers, text };
  }
  get = (p: string, h?: Record<string, string>) => this.call("GET", p, undefined, h);
  post = (p: string, b: unknown = {}) => this.call("POST", p, b);
  act = (name: string, ...args: unknown[]) => this.post("/api/action", { name, args: [{ personId: "ignored", role: "HOP" }, ...args] });
  must = async (name: string, ...args: unknown[]) => {
    const r = await this.act(name, ...args);
    assert.equal(r.status, 200, `${name}: ${r.json.error}`);
    return r.json.result;
  };
}

async function setupHop(samples = true): Promise<Client> {
  const c = new Client();
  const r = await c.post("/api/setup", {
    token: process.env.SETUP_TOKEN,
    name: "Kevin Mwangi",
    username: "kev",
    password: "correct horse battery",
    samples,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return c;
}

async function loginFor(hop: Client, personId: string, username: string): Promise<Client> {
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

/** The walkthrough over HTTP, so there are episodes with hosted links to share. */
async function walked(hop: Client) {
  return walkWhispersOfWhy(hop.must, async () => (await hop.get("/api/state")).json.db);
}

await t("a share link is made by the server, opened by anyone, and reaches its own episode's file only", async () => {
  const hop = await setupHop();
  const wow = await walked(hop);
  const [e01, e02] = [`${wow.project}-E01`, `${wow.project}-E02`];
  await hop.must("workflow.setEpisodeLinks", e02, { reviewLink: "https://vimeo.com/e02-review" });

  const one = await hop.post("/api/share-links", { episodeId: e01, note: "Sent to Pastor James" });
  assert.equal(one.status, 200, JSON.stringify(one.json));
  const token1 = one.json.link.token as string;
  assert.match(token1, /^[A-Za-z0-9_-]{22}$/, "128 bits, URL-safe");
  assert.equal(one.json.url, `${base}/share/${token1}`);
  assert.ok(!token1.includes(e01) && !token1.includes("E01"), "not derived from the episode");
  const two = await hop.post("/api/share-links", { episodeId: e02 });
  const token2 = two.json.link.token as string;
  const again = await hop.post("/api/share-links", { episodeId: e01 });
  assert.notEqual(again.json.link.token, token1, "a new token every time, even for the same episode");

  const stranger = new Client(); // not signed in
  const open1 = await stranger.get(`/share/${token1}`);
  assert.equal(open1.status, 302);
  assert.equal(open1.headers.get("location"), FINAL_LINK, "E01's final file");
  assert.equal(open1.headers.get("cache-control"), "no-store");
  assert.equal(open1.headers.get("referrer-policy"), "no-referrer");
  assert.equal(open1.text, "", "nothing from the app goes with it");
  assert.equal(
    (await stranger.get(`/api/share/${token1}`)).headers.get("location"),
    FINAL_LINK,
    "the address vercel.json rewrites to works too",
  );
  assert.equal((await stranger.get(`/share/${token2}`)).headers.get("location"), "https://vimeo.com/e02-review", "E02's own link");

  for (const bad of ["AAAAAAAAAAAAAAAAAAAAAA", "short", `${token1}x`, "%2e%2e%2fapi%2fstate"]) {
    const r = await stranger.get(`/share/${bad}`);
    assert.equal(r.status, 404, bad);
    assert.ok(!r.text.includes(wow.project) && !r.text.includes("Whispers"), "the page says nothing about the app");
  }
});

await t("revoking stops a link; making it again replaces it", async () => {
  const hop = await setupHop();
  const wow = await walked(hop);
  const e01 = `${wow.project}-E01`;
  const first = (await hop.post("/api/share-links", { episodeId: e01 })).json;
  await hop.must("workflow.revokeShareLink", first.link.id);
  const stranger = new Client();
  assert.equal((await stranger.get(`/share/${first.link.token}`)).status, 404, "revoked");
  const second = (await hop.post("/api/share-links", { episodeId: e01 })).json;
  const third = (await hop.post("/api/share-links", { episodeId: e01, replaces: second.link.id })).json;
  assert.equal((await stranger.get(`/share/${second.link.token}`)).status, 404, "the one it replaced stops working");
  assert.equal((await stranger.get(`/share/${third.link.token}`)).status, 302);
  const links = (await hop.get("/api/state")).json.db.shareLinks.filter((l: Json) => l.episodeId === e01);
  assert.equal(links.length, 3, "revoked links are kept, with when they were revoked");
  assert.equal(links.filter((l: Json) => l.revokedAt).length, 2);
});

await t("share links: no hosted file, no link; view-only people cannot make one; no browser can choose a token", async () => {
  const hop = await setupHop();
  const wow = await walked(hop);
  const noFile = await hop.post("/api/share-links", { episodeId: `${wow.project}-E03` });
  assert.equal(noFile.status, 400);
  assert.match(noFile.json.error, /Attach a hosted file link first/);
  const vol = await loginFor(hop, "DOF-P-VOL-001", "joseph");
  const refused = await vol.post("/api/share-links", { episodeId: `${wow.project}-E01` });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /view-only|not found/);
  const direct = await hop.act("workflow.recordShareLink", `${wow.project}-E01`, "AAAAAAAAAAAAAAAAAAAAAA", "");
  assert.equal(direct.status, 400);
  assert.match(direct.json.error, /does not exist/);
  assert.equal((await new Client().post("/api/share-links", { episodeId: `${wow.project}-E01` })).status, 401, "signed in only");
});

await t("PUBLIC_BASE_URL sets the address share links start with", async () => {
  process.env.PUBLIC_BASE_URL = "https://hub.dawnoffaith.tv/";
  try {
    const hop = await setupHop();
    const wow = await walked(hop);
    const r = await hop.post("/api/share-links", { episodeId: `${wow.project}-E01` });
    assert.equal(r.json.url, `https://hub.dawnoffaith.tv/share/${r.json.link.token}`);
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

await t("the server moves a project whose review window has passed to Hold, on the first request of the day", async () => {
  const hop = await setupHop(false);
  const actor = { personId: (await hop.get("/api/session")).json.user.personId, role: "HOP" as const };
  let project = "";
  await mutateState(store, (db) => {
    project = W.createWorkflowProject(actor, { category: "devotional", title: "Late decision" }).contentId;
    db.developmentForms.find((f) => f.contentId === project)!.reviewWindowDate = "2026-09-20"; // passed; the services would not allow it
  });
  const db = (await hop.get("/api/state")).json.db;
  const form = db.developmentForms.find((f: Json) => f.contentId === project);
  assert.equal(form.outcome, "Hold");
  assert.equal(form.decisions.at(-1).byPersonId, "system");
  assert.ok(db.audit.some((a: Json) => a.byPersonId === "system" && a.entityId === project));
});

await t("the daily cron address needs its secret, and runs the same check", async () => {
  const hop = await setupHop(false);
  const actor = { personId: (await hop.get("/api/session")).json.user.personId, role: "HOP" as const };
  assert.equal((await new Client().get("/api/cron/daily")).status, 401);
  assert.equal((await new Client().get("/api/cron/daily", { Authorization: "Bearer wrong" })).status, 401);
  await hop.get("/api/state"); // today's check has run, with nothing to do
  let project = "";
  await mutateState(store, (db) => {
    project = W.createWorkflowProject(actor, { category: "devotional", title: "Late decision" }).contentId;
    db.developmentForms.find((f) => f.contentId === project)!.reviewWindowDate = "2026-09-20";
  });
  const r = await new Client().get("/api/cron/daily", { Authorization: "Bearer cron-secret-for-tests" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.movedToHold, [project]);
  const again = await new Client().get("/api/cron/daily", { Authorization: "Bearer cron-secret-for-tests" });
  assert.deepEqual(again.json.movedToHold, [], "running it again changes nothing");
});

server?.close();
console.log(`\n${passed} passed`);
