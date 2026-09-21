import type { Actor, Person } from "../src/types";
import { RuleError } from "../src/types";
import { logAudit } from "../src/services/audit";
import { can } from "../src/services/permissions";
import { dummyHash, hashPassword, randomToken, safeEqual, sha256, temporaryPassword, verifyPassword } from "./crypto";
import { HttpError } from "./errors";
import { checkPassword, checkUsername, normalizeUsername } from "./rules";
import { initDatabase, loadDb, mutateState, newDatabase, withDb } from "./state";
import type { SessionDoc, Store, UserDoc } from "./stores";

// Who is signed in, and how someone gets to be. Passwords are hashed, sessions are random tokens that
// are stored only as hashes, and repeated wrong guesses lock the account for a while.

export const IDLE_MS = 12 * 60 * 60 * 1000; // signed out after 12 hours of nothing
export const MAX_MS = 7 * 24 * 60 * 60 * 1000; // and after 7 days regardless
const LOCK_AFTER = 5;
const LOCK_IP_AFTER = 30;
const LOCK_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 10;

export interface Authed { user: UserDoc; session: SessionDoc; person: Person; actor: Actor }

export interface PublicUser { personId: string; role: string; name: string; username: string; mustChange: boolean }
export const publicUser = (a: Authed): PublicUser => ({ personId: a.person.personId, role: a.actor.role, name: a.person.name, username: a.user._id, mustChange: a.user.mustChange });

// ── Wrong guesses ────────────────────────────────────────────

async function assertNotLocked(store: Store, keys: string[]): Promise<void> {
  for (const k of keys) {
    const a = await store.attempts.get(k);
    if (a && a.lockedUntil > Date.now()) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((a.lockedUntil - Date.now()) / 60000)} minutes.`, "locked");
  }
}

async function recordFailure(store: Store, key: string, limit: number): Promise<boolean> {
  const now = Date.now();
  const a = await store.attempts.get(key);
  const fresh = !a || now - a.first > WINDOW_MS;
  const count = fresh ? 1 : a.count + 1;
  const lockedUntil = count >= limit ? now + LOCK_MS : 0;
  await store.attempts.put({ _id: key, count, first: fresh ? now : a.first, lockedUntil });
  return lockedUntil > 0;
}

// ── Recording what happened ──────────────────────────────────

/** Adds a line to the activity log the Head of Production can read. */
async function record(store: Store, personId: string, action: string, detail: string): Promise<void> {
  await mutateState(store, (db) => logAudit({ personId, role: "HOP" }, action, "account", personId, detail));
}

// ── Sessions ─────────────────────────────────────────────────

async function startSession(store: Store, username: string, ip: string, agent: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await store.sessions.put({ _id: sha256(token), username, createdAt: now, lastSeen: now, expiresAt: now + MAX_MS, ip, agent: agent.slice(0, 200) });
  // Keep the newest few, so old sign-ins on forgotten devices do not pile up.
  const mine = (await store.sessions.find({ username })).sort((a, b) => b.createdAt - a.createdAt);
  for (const old of mine.slice(MAX_SESSIONS)) await store.sessions.remove(old._id);
  return token;
}

export async function revokeSessions(store: Store, username: string, except?: string): Promise<void> {
  for (const s of await store.sessions.find({ username })) if (s._id !== except) await store.sessions.remove(s._id);
}

export async function authenticate(store: Store, token: string | undefined): Promise<Authed | null> {
  if (!token) return null;
  const session = await store.sessions.get(sha256(token));
  if (!session) return null;
  const now = Date.now();
  if (now > session.expiresAt || now - session.lastSeen > IDLE_MS) { await store.sessions.remove(session._id); return null; }
  const user = await store.users.get(session.username);
  if (!user || user.disabled) return null;
  const loaded = await loadDb(store, ["people"]);
  const person = loaded?.db.people.find((p) => p.personId === user.personId);
  if (!person || person.status !== "active") return null;
  if (now - session.lastSeen > 5 * 60 * 1000) await store.sessions.put({ ...session, lastSeen: now });
  return { user, session, person, actor: { personId: person.personId, role: person.category } };
}

export async function logout(store: Store, token: string | undefined): Promise<void> {
  if (token) await store.sessions.remove(sha256(token));
}

// ── Setting up, and signing in ───────────────────────────────

export async function needsSetup(store: Store): Promise<boolean> {
  return (await store.users.all()).length === 0 && !(await store.state.load(["settings"]));
}

export async function setup(store: Store, input: { token: string; name: string; username: string; password: string; samples: boolean }, ip: string, agent: string): Promise<{ token: string; user: PublicUser }> {
  const expected = process.env.SETUP_TOKEN;
  if (!expected) throw new HttpError(503, "Setup is not switched on. Add a SETUP_TOKEN in Vercel first.");
  await assertNotLocked(store, [`setup:${ip}`]);
  if (!(await needsSetup(store))) throw new HttpError(409, "This app has already been set up.");
  if (!safeEqual(String(input.token ?? ""), expected)) {
    await recordFailure(store, `setup:${ip}`, 5);
    throw new HttpError(403, "The setup code is not right.");
  }
  const name = String(input.name ?? "").trim();
  const username = normalizeUsername(String(input.username ?? ""));
  if (!name) throw new HttpError(400, "Enter your name.");
  const badName = checkUsername(username);
  if (badName) throw new HttpError(400, badName);
  const badPw = checkPassword(String(input.password ?? ""), { username, name });
  if (badPw) throw new HttpError(400, badPw);

  const { db, hop } = newDatabase({ name, username }, !!input.samples);
  if (!(await initDatabase(store, db))) throw new HttpError(409, "This app has already been set up.");
  const now = new Date().toISOString();
  await store.users.insert({ _id: username, personId: hop.personId, passwordHash: await hashPassword(input.password), disabled: false, mustChange: false, createdAt: now, passwordChangedAt: now, lastLoginAt: now });
  const token = await startSession(store, username, ip, agent);
  await record(store, hop.personId, "setup", "The app was set up");
  const a = await authenticate(store, token);
  return { token, user: publicUser(a!) };
}

export async function login(store: Store, input: { username: string; password: string }, ip: string, agent: string): Promise<{ token: string; user: PublicUser }> {
  const username = normalizeUsername(String(input.username ?? ""));
  const password = String(input.password ?? "");
  if (!username || !password || password.length > 128) throw new HttpError(400, "Enter your username and password.");
  await assertNotLocked(store, [`u:${username}`, `ip:${ip}`]);
  const user = await store.users.get(username);
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash())); // takes the same time whether or not the username exists
  if (!user || !ok) {
    const lockedUser = await recordFailure(store, `u:${username}`, LOCK_AFTER);
    await recordFailure(store, `ip:${ip}`, LOCK_IP_AFTER);
    if (lockedUser && user) await record(store, user.personId, "login-locked", `Too many wrong passwords for ${username}`);
    throw new HttpError(401, "Wrong username or password.");
  }
  const loaded = await loadDb(store, ["people"]);
  const person = loaded?.db.people.find((p) => p.personId === user.personId);
  if (user.disabled || !person || person.status !== "active") throw new HttpError(403, "This login has been switched off. Ask the Head of Production.");
  await store.attempts.remove(`u:${username}`);
  await store.users.put({ ...user, lastLoginAt: new Date().toISOString() });
  const token = await startSession(store, username, ip, agent);
  await record(store, person.personId, "login", `Signed in from ${ip || "an unknown address"}`);
  const a = await authenticate(store, token);
  return { token, user: publicUser(a!) };
}

// ── Passwords ────────────────────────────────────────────────

export async function changePassword(store: Store, who: Authed, current: string, next: string): Promise<void> {
  if (!(await verifyPassword(String(current ?? ""), who.user.passwordHash))) {
    const locked = await recordFailure(store, `u:${who.user._id}`, LOCK_AFTER);
    throw new HttpError(locked ? 429 : 403, "Your current password is not right.");
  }
  const bad = checkPassword(String(next ?? ""), { username: who.user._id, name: who.person.name });
  if (bad) throw new HttpError(400, bad);
  if (next === current) throw new HttpError(400, "Choose a password you have not used just now.");
  const now = new Date().toISOString();
  await store.users.put({ ...who.user, passwordHash: await hashPassword(next), mustChange: false, passwordChangedAt: now });
  await revokeSessions(store, who.user._id, who.session._id); // every other device has to sign in again
  await record(store, who.person.personId, "change-password", "Password changed");
}

// ── Logins for other people (the Head of Production, or anyone given the right) ──

function allowed(store: Store, actor: Actor): Promise<void> {
  return loadDb(store, ["settings", "people"]).then((l) => {
    if (!l || !withDb(l.db, () => can(actor, "people.manage"))) throw new HttpError(403, "Only the Head of Production, or someone given \"Add and change people\", can manage logins.");
  });
}

export async function createAccount(store: Store, who: Authed, input: { personId: string; username: string; password?: string }): Promise<{ username: string; temporaryPassword: string }> {
  await allowed(store, who.actor);
  const username = normalizeUsername(String(input.username ?? ""));
  const badName = checkUsername(username);
  if (badName) throw new HttpError(400, badName);
  const loaded = await loadDb(store, ["people"]);
  const person = loaded?.db.people.find((p) => p.personId === input.personId);
  if (!person || person.status !== "active") throw new HttpError(404, "Choose an active person.");
  if ((await store.users.find({ personId: person.personId })).length) throw new HttpError(409, `${person.name} already has a login.`);
  const password = input.password ? String(input.password) : temporaryPassword();
  const bad = checkPassword(password, { username, name: person.name });
  if (bad) throw new HttpError(400, bad);
  const now = new Date().toISOString();
  if (!(await store.users.insert({ _id: username, personId: person.personId, passwordHash: await hashPassword(password), disabled: false, mustChange: true, createdAt: now, passwordChangedAt: now, lastLoginAt: null }))) throw new HttpError(409, "That username is taken. Choose another.");
  try {
    await mutateState(store, (db) => {
      const p = db.people.find((x) => x.personId === person.personId)!;
      p.hasLogin = true;
      p.username = username;
      logAudit(who.actor, "create-login", "person", person.personId, username);
    });
  } catch (e) {
    await store.users.remove(username);
    throw e;
  }
  return { username, temporaryPassword: password };
}

async function userOf(store: Store, personId: string): Promise<UserDoc> {
  const [u] = await store.users.find({ personId });
  if (!u) throw new HttpError(404, "That person has no login yet.");
  return u;
}

export async function resetPassword(store: Store, who: Authed, personId: string): Promise<{ username: string; temporaryPassword: string }> {
  await allowed(store, who.actor);
  const u = await userOf(store, personId);
  if (u._id === who.user._id) throw new HttpError(400, "Change your own password from Settings.");
  const temp = temporaryPassword();
  await store.users.put({ ...u, passwordHash: await hashPassword(temp), mustChange: true, passwordChangedAt: new Date().toISOString() });
  await revokeSessions(store, u._id);
  await mutateState(store, () => logAudit(who.actor, "reset-password", "person", personId, u._id));
  return { username: u._id, temporaryPassword: temp };
}

export async function setDisabled(store: Store, who: Authed, personId: string, disabled: boolean): Promise<void> {
  await allowed(store, who.actor);
  const u = await userOf(store, personId);
  if (u._id === who.user._id) throw new HttpError(400, "You cannot switch off your own login.");
  await store.users.put({ ...u, disabled });
  if (disabled) await revokeSessions(store, u._id);
  await mutateState(store, (db) => {
    const p = db.people.find((x) => x.personId === personId);
    if (p) p.loginOff = disabled;
    logAudit(who.actor, disabled ? "disable-login" : "enable-login", "person", personId, u._id);
  });
}

export async function signOutEverywhere(store: Store, who: Authed, personId: string): Promise<void> {
  if (personId !== who.person.personId) await allowed(store, who.actor);
  const u = await userOf(store, personId);
  await revokeSessions(store, u._id);
  await mutateState(store, () => logAudit(who.actor, "sign-out-everywhere", "person", personId, u._id));
}

/** After a person is made inactive, their sign-ins stop working straight away. */
export async function afterPeopleChange(store: Store, personId: string): Promise<void> {
  for (const u of await store.users.find({ personId })) await revokeSessions(store, u._id);
}
