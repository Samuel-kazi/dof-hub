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

export interface Loaded { data: Record<string, unknown>; versions: Record<string, number>; revision: number; schemaVersion: number }

export interface StateStore {
  load(keys?: string[]): Promise<Loaded | null>; // null until the app has been set up
  save(changes: Record<string, unknown>, expected: Record<string, number>, schemaVersion: number): Promise<boolean>; // false if someone else saved first
  init(data: Record<string, unknown>, schemaVersion: number): Promise<boolean>; // false if it already exists
}

export interface Store {
  diagnose?(): Promise<Record<string, unknown>>; // extra checks for the health address
  state: StateStore;
  users: Col<UserDoc>;
  sessions: Col<SessionDoc>;
  attempts: Col<AttemptDoc>;
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
  private docs = new Map<string, { v: number; data: unknown }>();
  private revision = 0;
  private schema = 0;
  private ready = false;
  async load(keys?: string[]) {
    if (!this.ready) return null;
    const data: Record<string, unknown> = {};
    const versions: Record<string, number> = {};
    for (const [k, d] of this.docs) if (!keys || keys.includes(k)) { data[k] = structuredClone(d.data); versions[k] = d.v; }
    return { data, versions, revision: this.revision, schemaVersion: this.schema };
  }
  async save(changes: Record<string, unknown>, expected: Record<string, number>, schemaVersion: number) {
    for (const k of Object.keys(changes)) if ((this.docs.get(k)?.v ?? 0) !== (expected[k] ?? 0)) return false;
    for (const [k, data] of Object.entries(changes)) this.docs.set(k, { v: (this.docs.get(k)?.v ?? 0) + 1, data: structuredClone(data) });
    this.revision++;
    this.schema = schemaVersion;
    return true;
  }
  async init(data: Record<string, unknown>, schemaVersion: number) {
    if (this.ready) return false;
    for (const [k, v] of Object.entries(data)) this.docs.set(k, { v: 1, data: structuredClone(v) });
    this.ready = true;
    this.revision = 1;
    this.schema = schemaVersion;
    return true;
  }
}

export function memoryStore(): Store {
  return { state: new MemState(), users: new MemCol(), sessions: new MemCol(), attempts: new MemCol(), google: new MemCol(), oauth: new MemCol() };
}
