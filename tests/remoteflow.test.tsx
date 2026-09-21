// Run with: npx tsx tests/remoteflow.test.tsx
// The real site's screen and server together: add a person, then make their login, the way the Add a person form does.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.SETUP_TOKEN = "flow-setup-code-1234";
process.env.DOF_SCRYPT_N = "1024";
process.env.DOF_STORE = "memory";

const { createHandler, memoryStore } = await import("../server/index");
const { AppProvider } = await import("../src/ui/AppContext");
const { AddPersonModal } = await import("../src/pages/Crew");
const { login } = await import("../src/services/auth");
const { resetDemoData, getDb } = await import("../src/data/store");
const remote = await import("../src/data/remote");
const { createPerson } = await import("../src/services/wrapped/people");

let passed = 0;
const ok = (name: string) => { passed++; console.log("ok  ", name); };

// ── The form, in the demo and on the real site ──
resetDemoData();
const demoActor = login("hop@dof.demo", "demo");
const form = () => renderToString(<AppProvider actor={demoActor} onLogout={() => {}}><AddPersonModal defaultCategory="CRW" onClose={() => {}} onCreated={() => {}} /></AppProvider>);
const demoHtml = form();
assert.match(demoHtml, /Create login access for this person/);
assert.doesNotMatch(demoHtml, /Make a login for this person now/);
ok("the demo form keeps its own login option");

const server = createServer(createHandler(async () => store));
const store = memoryStore();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let cookie = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  const res = await realFetch(base + path, { ...init, headers: { ...(init.headers as Record<string, string>), ...(cookie ? { Cookie: cookie } : {}) } });
  const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
  if (set) cookie = set.split(";")[0];
  return res;
}) as typeof fetch;

const info = await remote.probe();
assert.ok(info && info.needsSetup);
const { user } = await remote.api.post<{ user: import("../src/data/remote").SessionUser }>("/api/setup", { token: process.env.SETUP_TOKEN, name: "Kevin Mwangi", username: "kev", password: "correct horse battery", samples: false });
await remote.hydrate();
// the screen syncs with page-visibility events, which Node does not have
const g = globalThis as unknown as { document?: unknown };
const fakeDocument = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
g.document = fakeDocument;
remote.startSync();
delete g.document; // server-side rendering must not see a fake page
const actor = remote.actorOf(user);

const realHtml = renderToString(<AppProvider actor={actor} onLogout={() => {}}><AddPersonModal defaultCategory="CRW" onClose={() => {}} onCreated={() => {}} /></AppProvider>);
assert.match(realHtml, /Make a login for this person now/);
assert.match(realHtml, /not an email/);
assert.doesNotMatch(realHtml, /Starting password|Login email/);
g.document = fakeDocument;
ok("on the real site the form offers to make the login, with a username, straight away");

// ── Add a person, wait for the server to know them, make the login ──
const person = createPerson(actor, { category: "CRW", name: "Wanjiru Kamau", email: "", phone: "", skills: [], equipmentFamiliarity: [] });
await remote.whenSynced();
assert.ok(getDb().people.some((p) => p.personId === person.personId));
const made = await remote.api.post<{ username: string; temporaryPassword: string }>("/api/accounts-create", { personId: person.personId, username: "wanjiru.kamau" });
assert.equal(made.username, "wanjiru.kamau");
assert.ok(made.temporaryPassword.length >= 10);
ok("a person added on the real site can be given a login as soon as they are saved");

cookie = ""; // a different device: the new crew member signs in with the one-time password
const signIn = await remote.api.post<{ user: { mustChange: boolean; role: string } }>("/api/login", { username: "wanjiru.kamau", password: made.temporaryPassword });
assert.equal(signIn.user.mustChange, true);
assert.equal(signIn.user.role, "CRW");
ok("the new crew member signs in with the one-time password and must choose their own");

remote.stopSync();
globalThis.fetch = realFetch;
server.close();
console.log(`\n${passed} passed`);
process.exit(0);
