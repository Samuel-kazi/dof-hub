import { layout1ToItems, versionedKeys } from "./layout";

// Where the server keeps things. The same interface is implemented twice: in memory, for tests and
// for trying the app on a laptop, and in MongoDB, for the real thing (see mongo.ts).

export interface UserDoc {
  _id: string; // the username, so two people can never share one
  personId: string;
  passwordHash: string;
  disabled: boolean; // switched off by the Head of Production, apart from the person being active
  mustChange: boolean; // has a one-time password and must choose their own
  createdAt: string;
  passwordChangedAt: string;
  lastLoginAt: string | null;
}

export interface SessionDoc {
  _id: string; // the SHA-256 of the token in the person's cookie. The token itself is never stored.
  username: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  ip: string;
  agent: string;
}

export interface AttemptDoc { _id: string; count: number; first: number; lockedUntil: number }

/**
 * Counts of sign-in attempts. Every change is a single atomic step in the database, so attempts sent at the
 * same moment are all counted: a count read first and written back later would let them slip past the limit.
 */
export interface AttemptStore {
  get(key: string): Promise<AttemptDoc | null>;
  /** Adds one to the count and returns the result. A count whose window has passed starts again from one. */
  charge(key: string, now: number, windowMs: number): Promise<AttemptDoc>;
  /** Takes one back off the count, for an attempt that turned out to be the right password. */
  refund(key: string): Promise<void>;
  lock(key: string, until: number): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface GoogleDoc {
  _id: string; // username
  email: string;
  sub: string;
  scopes: string[]; // "calendar" and "gmail" are the choices a person makes
  refresh: string; // encrypted
  linkedAt: string;
}

export interface OAuthDoc { _id: string; username: string; verifier: string; scopes: string[]; expiresAt: number }

export interface Col<T extends { _id: string }> {
  get(id: string): Promise<T | null>;
  all(): Promise<T[]>;
  find(where: Partial<T>): Promise<T[]>;
  insert(doc: T): Promise<boolean>; // false if the ID is already used
  put(doc: T): Promise<void>;
  remove(id: string): Promise<void>;
}

// ── The app's data ───────────────────────────────────────────
// Each element of each part of the data is its own document: one record, one person, one log entry. Settings
// and counters, which are single objects, are one document each. See server/layout.ts for how parts map to
// elements, and server/state.ts for how changes are found and saved.

/** One element of one part of the data. `o` keeps the order the app keeps it in. */
export interface Item { k: string; i: string; o: number; d: unknown }

/** Where the data stands: a revision that goes up with every save, the data's schema version, and each part's own version. */
export interface Head { revision: number; schemaVersion: number; versions: Record<string, number> }

export interface Commit {
  put: Item[]; // new or changed elements
  remove: { k: string; i: string }[]; // elements that are gone
  expect: Record<string, number>; // parts that must still be at these versions, or nothing is written. Each goes up by one.
  schemaVersion: number;
}

export interface StateStore {
  /** Cheap: one small read. Null until the app has been set up. */
  head(): Promise<Head | null>;
  /** Every element of these parts, in order. */
  items(keys: string[]): Promise<Item[]>;
  /** The newest elements of one part, newest first. */
  newest(key: string, limit: number): Promise<Item[]>;
  /** Writes all of it or none of it. Returns the new revision, or null if someone else changed a part in `expect` first. */
  commit(c: Commit): Promise<number | null>;
  /** The first time only. False if the data already exists. */
  init(items: Item[], schemaVersion: number): Promise<boolean>;
}

/** A photo, kept apart from the data so the data stays small. Served at /api/file?id=… to signed-in people. */
export interface FileDoc { _id: string; type: string; data: string; size: number; at: string }

export interface Store {
  diagnose?(): Promise<Record<string, unknown>>; // extra checks for the health address
  state: StateStore;
  files: Col<FileDoc>;
  users: Col<UserDoc>;
  sessions: Col<SessionDoc>;
  attempts: AttemptStore;
  google: Col<GoogleDoc>;
  oauth: Col<OAuthDoc>;
}

class MemCol<T extends { _id: string }> implements Col<T> {
  private m = new Map<string, T>();
  async get(id: string) { const d = this.m.get(id); return d ? structuredClone(d) : null; }
  async all() { return [...this.m.values()].map((d) => structuredClone(d)); }
  async find(where: Partial<T>) { return (await this.all()).filter((d) => Object.entries(where).every(([k, v]) => (d as Record<string, unknown>)[k] === v)); }
  async insert(doc: T) { if (this.m.has(doc._id)) return false; this.m.set(doc._id, structuredClone(doc)); return true; }
  async put(doc: T) { this.m.set(doc._id, structuredClone(doc)); }
  async remove(id: string) { this.m.delete(id); }
}

class MemState implements StateStore {
  private items_ = new Map<string, Item>(); // by `${k}/${i}`
  private head_: Head | null = null;
  constructor(seed?: { items: Item[]; head: Head }) {
    if (!seed) return;
    for (const it of seed.items) this.items_.set(`${it.k}/${it.i}`, structuredClone(it));
    this.head_ = structuredClone(seed.head);
  }
  async head() { return this.head_ ? structuredClone(this.head_) : null; }
  async items(keys: string[]) {
    return [...this.items_.values()].filter((it) => keys.includes(it.k)).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.o - b.o)).map((it) => structuredClone(it));
  }
  async newest(key: string, limit: number) {
    return [...this.items_.values()].filter((it) => it.k === key).sort((a, b) => b.o - a.o).slice(0, limit).map((it) => structuredClone(it));
  }
  async commit(c: Commit) {
    if (!this.head_) return null;
    for (const [k, v] of Object.entries(c.expect)) if ((this.head_.versions[k] ?? 0) !== v) return null;
    for (const r of c.remove) this.items_.delete(`${r.k}/${r.i}`);
    for (const it of c.put) this.items_.set(`${it.k}/${it.i}`, structuredClone(it));
    for (const k of Object.keys(c.expect)) this.head_.versions[k] = (this.head_.versions[k] ?? 0) + 1;
    this.head_.revision++;
    this.head_.schemaVersion = c.schemaVersion;
    return this.head_.revision;
  }
  async init(items: Item[], schemaVersion: number) {
    if (this.head_) return false;
    for (const it of items) this.items_.set(`${it.k}/${it.i}`, structuredClone(it));
    this.head_ = { revision: 1, schemaVersion, versions: Object.fromEntries(versionedKeys().map((k) => [k, 1])) };
    return true;
  }
}

/** Atomic because nothing here awaits between reading a count and writing it back. */
class MemAttempts implements AttemptStore {
  private m = new Map<string, AttemptDoc>();
  async get(key: string) { const d = this.m.get(key); return d ? { ...d } : null; }
  async charge(key: string, now: number, windowMs: number) {
    const a = this.m.get(key);
    const fresh = !a || now - a.first > windowMs;
    const next: AttemptDoc = { _id: key, count: fresh ? 1 : a.count + 1, first: fresh ? now : a.first, lockedUntil: a?.lockedUntil ?? 0 };
    this.m.set(key, next);
    return { ...next };
  }
  async refund(key: string) { const a = this.m.get(key); if (a && a.count > 0) a.count--; }
  async lock(key: string, until: number) { const a = this.m.get(key); this.m.set(key, { _id: key, count: a?.count ?? 0, first: a?.first ?? Date.now(), lockedUntil: until }); }
  async clear(key: string) { this.m.delete(key); }
}

/**
 * Everything in memory, for tests and for trying the app on a laptop. `legacy` starts it with data saved in the
 * earlier layout, upgraded the same way the MongoDB store upgrades it.
 */
export function memoryStore(legacy?: { data: Record<string, unknown>; revision: number; schemaVersion: number }): Store {
  const files = new MemCol<FileDoc>();
  let state = new MemState();
  if (legacy) {
    const up = layout1ToItems(legacy.data);
    for (const f of up.files) void files.put(f);
    state = new MemState({ items: up.items, head: { revision: legacy.revision, schemaVersion: legacy.schemaVersion, versions: Object.fromEntries(versionedKeys().map((k) => [k, 1])) } });
  }
  return { state, files, users: new MemCol(), sessions: new MemCol(), attempts: new MemAttempts(), google: new MemCol(), oauth: new MemCol() };
}
