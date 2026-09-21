import type { Actor, Database, Person } from "../src/types";
import { CURRENT_SCHEMA, getDb, setDb, setPersist, upgradeDb } from "../src/data/store";
import { buildSeed } from "../src/data/seed";
import { canViewDoc } from "../src/services/docs";
import { can } from "../src/services/permissions";
import { redactPerson, visibleCallSheets, visibleRecords } from "../src/services/access";
import type { Loaded, Store } from "./stores";

setPersist(false); // the server never writes to a browser's storage

/** Every part of the database that lives in MongoDB. Logins are kept apart, and never appear here. */
export const KEYS = ["people", "members", "records", "callSheets", "comments", "audit", "equipment", "manifests", "incidents", "equipmentHistory", "drives", "allocations", "snapshots", "docs", "docRevisions", "outbox", "settings", "counters"] as const;

const assemble = (l: Loaded): Database => ({ ...(l.data as unknown as Database), users: [], schemaVersion: l.schemaVersion });
const pick = (db: Database, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, (db as unknown as Record<string, unknown>)[k]]));

/** The database for a brand-new installation: nobody but the Head of Production, and no sample data. */
export function newDatabase(hop: { name: string; username: string }, withSamples: boolean): { db: Database; hop: Person } {
  const seed = buildSeed();
  const hopSeed = seed.people.find((p) => p.category === "HOP")!;
  const person: Person = { ...hopSeed, name: hop.name, email: "", phone: "", hasLogin: true, username: hop.username, createdAt: new Date().toISOString() };
  if (withSamples) {
    const db: Database = { ...seed, users: [], people: seed.people.map((p) => (p.personId === person.personId ? person : { ...p, hasLogin: false })) };
    return { db, hop: person };
  }
  const db: Database = { ...seed, users: [], people: [person], members: [], records: [], callSheets: [], comments: [], audit: [], equipment: [], manifests: [], incidents: [], equipmentHistory: [], drives: [], allocations: [], snapshots: [], docs: [], docRevisions: [], outbox: [], counters: {}, settings: { ...seed.settings, permissions: { roles: {}, people: {} } } };
  return { db, hop: person };
}

export async function initDatabase(store: Store, db: Database): Promise<boolean> {
  return store.state.init(pick(db, KEYS), CURRENT_SCHEMA);
}

/** Loads the data, bringing it up to the current version first if it was saved by an older one. */
export async function loadDb(store: Store, keys?: readonly string[]): Promise<{ db: Database; versions: Record<string, number>; revision: number } | null> {
  const l = await store.state.load(keys ? [...keys] : undefined);
  if (!l) return null;
  if (l.schemaVersion !== CURRENT_SCHEMA && !keys) {
    const up = upgradeDb(assemble(l));
    if (!up) throw new Error("The saved data is from a version this app does not know.");
    await store.state.save(pick(up, KEYS), l.versions, CURRENT_SCHEMA);
    return loadDb(store, keys);
  }
  return { db: assemble(l), versions: l.versions, revision: l.revision };
}

/** Runs `fn` with `db` as the data the services see. Everything inside must be synchronous. */
export function withDb<T>(db: Database, fn: () => T): T {
  const prev = getDb();
  setDb(db);
  try { return fn(); } finally { setDb(prev); }
}

/** Changes the data. If two people save at once, the second run starts again from the newest data. */
export async function mutateState<T>(store: Store, fn: (db: Database) => T): Promise<{ result: T; changed: string[] }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const loaded = await loadDb(store);
    if (!loaded) throw new Error("The app has not been set up yet.");
    const { db, versions } = loaded;
    const before = Object.fromEntries(KEYS.map((k) => [k, JSON.stringify((db as unknown as Record<string, unknown>)[k])]));
    const result = withDb(db, () => fn(db));
    const changed = KEYS.filter((k) => JSON.stringify((db as unknown as Record<string, unknown>)[k]) !== before[k]);
    if (changed.length === 0) return { result, changed };
    if (await store.state.save(pick(db, changed), versions, CURRENT_SCHEMA)) return { result, changed };
  }
  throw new Error("The data is being changed by too many people at once. Try again.");
}

/** What one person is allowed to be sent. Everything else stays on the server. */
export function snapshotFor(db: Database, actor: Actor): Database {
  return withDb(db, () => {
    const recs = visibleRecords(actor);
    const ids = new Set(recs.map((r) => r.contentId));
    const hop = actor.role === "HOP";
    const docs = db.docs.filter((d) => canViewDoc(actor, d));
    const docIds = new Set(docs.map((d) => d.id));
    const settings = { ...db.settings };
    if (!hop) settings.permissions = { roles: { [actor.role]: db.settings.permissions?.roles?.[actor.role] ?? {} }, people: db.settings.permissions?.people?.[actor.personId] ? { [actor.personId]: db.settings.permissions.people[actor.personId] } : {} };
    return {
      schemaVersion: db.schemaVersion,
      users: [],
      people: db.people.map((p) => redactPerson(actor, p)),
      members: hop ? db.members : db.members.filter((m) => ids.has(m.projectContentId) || m.personId === actor.personId),
      records: recs,
      callSheets: visibleCallSheets(actor),
      comments: db.comments.filter((c) => ids.has(c.contentId)),
      audit: can(actor, "backend.audit") ? db.audit : [],
      equipment: can(actor, "equipment.use") ? db.equipment : [],
      manifests: can(actor, "equipment.use") ? db.manifests : [],
      incidents: can(actor, "equipment.use") ? db.incidents : [],
      equipmentHistory: can(actor, "equipment.use") ? db.equipmentHistory : [],
      drives: can(actor, "storage.use") ? db.drives : [],
      allocations: can(actor, "storage.use") ? db.allocations : [],
      snapshots: can(actor, "storage.use") ? db.snapshots : [],
      docs,
      docRevisions: db.docRevisions.filter((r) => docIds.has(r.docId)),
      outbox: can(actor, "reminders.sendOthers") ? db.outbox : db.outbox.filter((o) => o.personId === actor.personId),
      settings,
      counters: db.counters,
    };
  });
}
