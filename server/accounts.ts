import type { Actor, Person } from "../src/types";
import { RuleError } from "../src/types";
import { logAudit } from "../src/services/audit";
import { can, requireNotBeyond } from "../src/services/permissions";
import { dummyHash, hashPassword, randomToken, safeEqual, sha256, temporaryPassword, verifyPassword } from "./crypto";
import { HttpError } from "./errors";
import { checkPassword, checkUsername, normalizeUsername } from "./rules";
import { initDatabase, loadDb, mutateState, newDatabase, withDb } from "./state";
import type { SessionDoc, Store, UserDoc } from "./stores";

// Who is signed in, and how someone gets to be. Passwords are hashed, sessions are random tokens that
// are stored only as hashes, and repeated wrong guesses are locked out for a while.

export const IDLE_MS = 12 * 60 * 60 * 1000; // signed out after 12 hours of nothing
export const MAX_MS = 7 * 24 * 60 * 60 * 1000; // and after 7 days regardless
const LOCK_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 10;

// Wrong passwords are limited three ways, each over 15 minutes:
// - one username from one address: 5. This is the lock people normally meet, and it only blocks that
//   address, so a stranger guessing at the Head of Production's username cannot lock them out.
// - one address, whatever the username: 30, so one address cannot work through many usernames.
// - one username, from every address together: 100, so many addresses cannot share the guessing.
//   Reaching it takes at least 20 addresses, each stopped by its own limit first.
const LIMIT_USER_AT_ADDRESS = 5;
const LIMIT_ADDRESS = 30;
const LIMIT_USER = 100;
const LIMIT_SETUP = 5;
const LIMIT_PASSWORD_CHANGE = 5;

export interface Authed { user: UserDoc; session: SessionDoc; person: Person; actor: Actor }

export interface PublicUser { personId: string; role: string; name: string; username: string; mustChange: boolean }
export const publicUser = (a: Authed): PublicUser => ({ personId: a.person.personId, role: a.actor.role, name: a.person.name, username: a.user._id, mustChange: a.user.mustChange });

// ── Wrong guesses ────────────────────────────────────────────

interface Limit { key: string; max: number }

class Locked extends HttpError {
  /** The limit this attempt pushed over, when it was this attempt that locked it (not one already locked). */
  constructor(ms: number, public newlyLocked: string | null) {
    super(429, `Too many attempts. Try again in ${Math.max(1, Math.ceil(ms / 60000))} minutes.`, "locked");
  }
}

/**
 * Counts this attempt against each limit before the password is checked, and refuses it once a limit is
 * passed. Counting first, in one atomic step per limit, means attempts sent at the same moment are all
 * counted: at most `max` of them are ever checked against the password.
 */
async function chargeAttempt(store: Store, limits: Limit[]): Promise<void> {
  const now = Date.now();
  for (const l of limits) {
    const a = await store.attempts.get(l.key);
    if (a && a.lockedUntil > now) throw new Locked(a.lockedUntil - now, null);
  }
  for (const l of limits) {
    const a = await store.attempts.charge(l.key, now, WINDOW_MS);
    if (a.count > l.max) {
      await store.attempts.lock(l.key, now + LOCK_MS);
      throw new Locked(LOCK_MS, a.count === l.max + 1 ? l.key : null);
    }
  }
}

/** The password was right: the attempt does not count against the shared limits, and this one starts again. */
async function attemptSucceeded(store: Store, reset: string, refund: string[]): Promise<void> {
  await store.attempts.clear(reset);
  for (const key of refund) await store.attempts.refund(key);
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
  return (await store.users.all()).length === 0 && !(await store.state.head());
}

export async function setup(store: Store, input: { token: string; name: string; username: string; password: string; samples: boolean }, ip: string, agent: string): Promise<{ token: string; user: PublicUser }> {
  const expected = process.env.SETUP_TOKEN;
  if (!expected) throw new HttpError(503, "Setup is not switched on. Add a SETUP_TOKEN in Vercel first.");
  if (!(await needsSetup(store))) throw new HttpError(409, "This app has already been set up.");
  await chargeAttempt(store, [{ key: `setup:${ip}`, max: LIMIT_SETUP }]);
  if (!safeEqual(String(input.token ?? ""), expected)) throw new HttpError(403, "The setup code is not right.");
  await store.attempts.refund(`setup:${ip}`); // only wrong codes count
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
  const here = `ui:${username}|${ip}`;
  const limits = [{ key: here, max: LIMIT_USER_AT_ADDRESS }, { key: `ip:${ip}`, max: LIMIT_ADDRESS }, { key: `u:${username}`, max: LIMIT_USER }];
  try {
    await chargeAttempt(store, limits);
  } catch (e) {
    const user = e instanceof Locked && e.newlyLocked && e.newlyLocked !== `ip:${ip}` ? await store.users.get(username) : null;
    if (user) await record(store, user.personId, "login-locked", `Too many wrong passwords for ${username}${e instanceof Locked && e.newlyLocked === here ? ` from ${ip || "an unknown address"}` : " from many addresses"}`);
    throw e;
  }
  const user = await store.users.get(username);
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash())); // takes the same time whether or not the username exists
  if (!user || !ok) throw new HttpError(401, "Wrong username or password.");
  const loaded = await loadDb(store, ["people"]);
  const person = loaded?.db.people.find((p) => p.personId === user.personId);
  if (user.disabled || !person || person.status !== "active") throw new HttpError(403, "This login has been switched off. Ask the Head of Production.");
  await attemptSucceeded(store, here, [`ip:${ip}`, `u:${username}`]);
  await store.users.put({ ...user, lastLoginAt: new Date().toISOString() });
  const token = await startSession(store, username, ip, agent);
  await record(store, person.personId, "login", `Signed in from ${ip || "an unknown address"}`);
  const a = await authenticate(store, token);
  return { token, user: publicUser(a!) };
}

// ── Passwords ────────────────────────────────────────────────

export async function changePassword(store: Store, who: Authed, current: string, next: string): Promise<void> {
  const key = `pw:${who.user._id}`;
  await chargeAttempt(store, [{ key, max: LIMIT_PASSWORD_CHANGE }]);
  if (!(await verifyPassword(String(current ?? ""), who.user.passwordHash))) throw new HttpError(403, "Your current password is not right.");
  await store.attempts.clear(key);
  const bad = checkPassword(String(next ?? ""), { username: who.user._id, name: who.person.name });
  if (bad) throw new HttpError(400, bad);
  if (next === current) throw new HttpError(400, "Choose a password you have not used just now.");
  const now = new Date().toISOString();
  await store.users.put({ ...who.user, passwordHash: await hashPassword(next), mustChange: false, passwordChangedAt: now });
  await revokeSessions(store, who.user._id, who.session._id); // every other device has to sign in again
  await record(store, who.person.personId, "change-password", "Password changed");
}

// ── Logins for other people (the Head of Production, or anyone given the right) ──

/**
 * Managing a login needs "Add and change people", and only ever for someone with no more access than the
 * person doing it. A reset password is handed to the caller, so without that second rule anyone given
 * "Add and change people" could take over the Head of Production's login, or anyone else's.
 */
async function allowed(store: Store, actor: Actor, personId: string, what: string): Promise<Person> {
  const l = await loadDb(store, ["settings", "people"]);
  if (!l) throw new HttpError(503, "The app has not been set up yet.");
  return withDb(l.db, () => {
    if (!can(actor, "people.manage")) throw new HttpError(403, "Only the Head of Production, or someone given \"Add and change people\", can manage logins.");
    const person = l.db.people.find((p) => p.personId === personId);
    if (!person) throw new HttpError(404, "Choose a person.");
    try {
      requireNotBeyond(actor, person.category, person.personId, what);
    } catch (e) {
      if (e instanceof RuleError) throw new HttpError(403, e.message);
      throw e;
    }
    return person;
  });
}

export async function createAccount(store: Store, who: Authed, input: { personId: string; username: string; password?: string }): Promise<{ username: string; temporaryPassword: string }> {
  await allowed(store, who.actor, String(input.personId ?? ""), "create a login");
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
  if (personId === who.person.personId) throw new HttpError(400, "Change your own password from Settings.");
  await allowed(store, who.actor, personId, "reset the password");
  const u = await userOf(store, personId);
  const temp = temporaryPassword();
  await store.users.put({ ...u, passwordHash: await hashPassword(temp), mustChange: true, passwordChangedAt: new Date().toISOString() });
  await revokeSessions(store, u._id);
  await mutateState(store, () => logAudit(who.actor, "reset-password", "person", personId, u._id));
  return { username: u._id, temporaryPassword: temp };
}

export async function setDisabled(store: Store, who: Authed, personId: string, disabled: boolean): Promise<void> {
  if (personId === who.person.personId) throw new HttpError(400, "You cannot switch off your own login.");
  await allowed(store, who.actor, personId, "switch a login on or off");
  const u = await userOf(store, personId);
  await store.users.put({ ...u, disabled });
  if (disabled) await revokeSessions(store, u._id);
  await mutateState(store, (db) => {
    const p = db.people.find((x) => x.personId === personId);
    if (p) p.loginOff = disabled;
    logAudit(who.actor, disabled ? "disable-login" : "enable-login", "person", personId, u._id);
  });
}

export async function signOutEverywhere(store: Store, who: Authed, personId: string): Promise<void> {
  if (personId !== who.person.personId) await allowed(store, who.actor, personId, "sign out a login");
  const u = await userOf(store, personId);
  await revokeSessions(store, u._id);
  await mutateState(store, () => logAudit(who.actor, "sign-out-everywhere", "person", personId, u._id));
}

/** After a person is made inactive, their sign-ins stop working straight away. */
export async function afterPeopleChange(store: Store, personId: string): Promise<void> {
  for (const u of await store.users.find({ personId })) await revokeSessions(store, u._id);
}
