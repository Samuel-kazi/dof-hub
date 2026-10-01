import type { Actor, AuditEntry, Database, DocRevision, Person } from "../src/types";
import { CURRENT_SCHEMA, getDb, setDb, setPersist, upgradeDb } from "../src/data/store";
import { buildSeed } from "../src/data/seed";
import { canViewDoc } from "../src/services/docs";
import { can } from "../src/services/permissions";
import { redactPerson, visibleCallSheets, visibleRecords } from "../src/services/access";
import { APPEND_ONLY, KEYS, LOG_KEYS, assemble, elementsOf, extractFiles, loadedKeys, toItems, versionedKeys } from "./layout";
import type { Commit, FileDoc, Head, Item, Store } from "./stores";

setPersist(false); // the server never writes to a browser's storage

export { KEYS };

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
  const files: FileDoc[] = [];
  const data = extractFiles(Object.fromEntries(KEYS.map((k) => [k, (db as unknown as Record<string, unknown>)[k]])), files);
  for (const f of files) await store.files.insert(f);
  return store.state.init(toItems(data), CURRENT_SCHEMA);
}

// ── The data as last loaded, kept between requests ───────────
// A warm server keeps what it last loaded. Each request first reads the revision, one small document, and
// loads everything again only when someone has saved since. The kept copy is shared, so nothing may change it:
// changes are made to a copy (mutateState), and everything else only reads.

interface Base {
  head: Head;
  db: Database; // never changed in place
  order: Map<string, string[]>; // element IDs of each part, in order
  json: Map<string, string>; // `${k}/${i}` to the element as JSON, to tell what a change touched
  o: Map<string, number>; // `${k}/${i}` to its place in the order
  maxO: Map<string, number>;
  audit?: AuditEntry[]; // the newest activity log entries, read when first needed
}

const kept = new WeakMap<Store, Base>();

function build(head: Head, items: Item[]): Base {
  const db = { ...(assemble(items) as unknown as Database), audit: [], users: [], schemaVersion: head.schemaVersion };
  const base: Base = { head, db, order: new Map(), json: new Map(), o: new Map(), maxO: new Map() };
  for (const it of items) {
    const key = `${it.k}/${it.i}`;
    if (!base.order.has(it.k)) base.order.set(it.k, []);
    base.order.get(it.k)!.push(it.i);
    base.json.set(key, JSON.stringify(it.d));
    base.o.set(key, it.o);
    base.maxO.set(it.k, Math.max(base.maxO.get(it.k) ?? -Infinity, it.o));
  }
  return base;
}

/** The current data, brought up to the current version first if it was saved by an older one. Null before setup. */
async function current(store: Store): Promise<Base | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const head = await store.state.head();
    if (!head) return null;
    const hit = kept.get(store);
    if (hit && hit.head.revision === head.revision) return hit;
    const base = build(head, await store.state.items(loadedKeys()));
    if (head.schemaVersion === CURRENT_SCHEMA) {
      kept.set(store, base);
      return base;
    }
    // Saved by an older version of the app: upgrade it once, for everyone. Expecting every part's version
    // means only one server can do it; any other starts again and finds it done.
    const up = upgradeDb(structuredClone(base.db));
    if (!up) throw new Error("The saved data is from a version this app does not know.");
    const change = diff(base, up);
    change.expect = Object.fromEntries(versionedKeys().map((k) => [k, base.head.versions[k] ?? 0]));
    await store.state.commit(change);
    kept.delete(store);
  }
  throw new Error("The data could not be brought up to date. Try again.");
}

/** Loads the data. What is returned is shared with other requests: read it, never change it. */
export async function loadDb(store: Store, _keys?: readonly string[]): Promise<{ db: Database; revision: number } | null> {
  const base = await current(store);
  return base ? { db: base.db, revision: base.head.revision } : null;
}

/** The revision, without loading anything else. Null before setup. */
export async function headOf(store: Store): Promise<Head | null> {
  return store.state.head();
}

/** Runs `fn` with `db` as the data the services see. Everything inside must be synchronous. */
export function withDb<T>(db: Database, fn: () => T): T {
  const prev = getDb();
  setDb(db);
  try {
    const out = fn();
    if (out && typeof (out as { then?: unknown }).then === "function") throw new Error("Service functions must be synchronous: the data they see is only theirs until they return.");
    return out;
  } finally {
    setDb(prev);
  }
}

// ── Saving ───────────────────────────────────────────────────

/** Which elements a change touched, ready to save. Parts that are not logs must still be at the versions they were loaded at. */
function diff(base: Base, db: Database): Commit & { keys: string[] } {
  const put: Item[] = [];
  const remove: { k: string; i: string }[] = [];
  const expect: Record<string, number> = {};
  const keys: string[] = [];
  const now = Date.now() * 1000; // new elements go after everything already there, in the order they were added
  for (const k of KEYS) {
    const els = elementsOf(k, (db as unknown as Record<string, unknown>)[k]);
    let changed = false;
    if (APPEND_ONLY.has(k)) {
      els.forEach((e, j) => put.push({ k, i: e.i, o: now + j, d: e.d }));
      changed = els.length > 0;
    } else {
      const before = base.order.get(k) ?? [];
      const was = new Set(before);
      const is = new Set(els.map((e) => e.i));
      for (const i of before) if (!is.has(i)) { remove.push({ k, i }); changed = true; }
      // New elements at the end, and the rest still in the same order: only what changed is written.
      const keptNow = els.filter((e) => was.has(e.i)).map((e) => e.i);
      const keptBefore = before.filter((i) => is.has(i));
      const lastKept = els.reduce((at, e, j) => (was.has(e.i) ? j : at), -1);
      const appendOnly = keptNow.every((i, j) => i === keptBefore[j]) && els.every((e, j) => was.has(e.i) || j > lastKept);
      if (appendOnly) {
        let next = Math.max((base.maxO.get(k) ?? -1) + 1, now);
        for (const e of els) {
          const key = `${k}/${e.i}`;
          if (!was.has(e.i)) { put.push({ k, i: e.i, o: next++, d: e.d }); changed = true; }
          else if (base.json.get(key) !== JSON.stringify(e.d)) { put.push({ k, i: e.i, o: base.o.get(key)!, d: e.d }); changed = true; }
        }
      } else {
        els.forEach((e, j) => put.push({ k, i: e.i, o: now + j, d: e.d })); // the order changed: write it all again
        changed = true;
      }
    }
    if (changed) {
      keys.push(k);
      if (!LOG_KEYS.has(k)) expect[k] = base.head.versions[k] ?? 0;
    }
  }
  return { put, remove, expect, schemaVersion: CURRENT_SCHEMA, keys };
}

const ATTEMPTS = 10;
/** A short, random wait, longer each time, so people saving at the same moment do not keep colliding. */
const pause = (attempt: number) => new Promise((r) => setTimeout(r, Math.random() * Math.min(400, 15 * 2 ** attempt)));

/** Changes the data. If someone else saved the same part first, it starts again from the newest data. */
export async function mutateState<T>(store: Store, fn: (db: Database) => T): Promise<{ result: T; changed: string[] }> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const base = await current(store);
    if (!base) throw new Error("The app has not been set up yet.");
    const db = structuredClone(base.db);
    const result = withDb(db, () => fn(db));
    const change = diff(base, db);
    if (!change.put.length && !change.remove.length) return { result, changed: [] };
    const revision = await store.state.commit(change);
    kept.delete(store); // the next read loads what was just saved
    if (revision !== null) return { result, changed: change.keys };
    await pause(attempt);
  }
  throw new Error("The data is being changed by too many people at once. Try again.");
}

// ── What each person is sent ─────────────────────────────────

/** How many activity log entries people are sent. Settings shows 40 and the activity report 300. */
export const AUDIT_SENT = 500;
/** How many of each document's newest revisions are sent with their text. Older ones are fetched when the history is opened. */
export const REVISIONS_WITH_TEXT = 5;

async function newestAudit(store: Store, base: Base): Promise<AuditEntry[]> {
  base.audit ??= (await store.state.newest("audit", AUDIT_SENT)).map((it) => it.d as AuditEntry).reverse();
  return base.audit;
}

/** Revisions of the documents a person may see. The newest few keep their text; older ones are marked as trimmed. */
function revisionsSent(all: DocRevision[], docIds: Set<string>): DocRevision[] {
  const byDoc = new Map<string, DocRevision[]>();
  for (const r of all) if (docIds.has(r.docId)) byDoc.set(r.docId, [...(byDoc.get(r.docId) ?? []), r]);
  const full = new Set<string>();
  for (const revs of byDoc.values()) {
    const newest = [...revs].sort((a, b) => b.at.localeCompare(a.at) || b.version - a.version).slice(0, REVISIONS_WITH_TEXT);
    for (const r of newest) full.add(r.id);
  }
  return all.filter((r) => docIds.has(r.docId)).map((r) => (full.has(r.id) ? r : { ...r, body: "", trimmed: true }));
}

/** What one person is allowed to be sent. Everything else stays on the server. */
export async function snapshotFor(store: Store, actor: Actor): Promise<{ revision: number; db: Database } | null> {
  const base = await current(store);
  if (!base) return null;
  const db = base.db;
  const audit = withDb(db, () => can(actor, "backend.audit")) ? await newestAudit(store, base) : [];
  const out = withDb(db, () => {
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
      audit,
      equipment: can(actor, "equipment.use") ? db.equipment : [],
      manifests: can(actor, "equipment.use") ? db.manifests : [],
      incidents: can(actor, "equipment.use") ? db.incidents : [],
      equipmentHistory: can(actor, "equipment.use") ? db.equipmentHistory : [],
      drives: can(actor, "storage.use") ? db.drives : [],
      allocations: can(actor, "storage.use") ? db.allocations : [],
      snapshots: can(actor, "storage.use") ? db.snapshots : [],
      docs,
      docRevisions: revisionsSent(db.docRevisions, docIds),
      outbox: can(actor, "reminders.sendOthers") ? db.outbox : db.outbox.filter((o) => o.personId === actor.personId),
      settings,
      counters: db.counters,
    } satisfies Database;
  });
  return { revision: base.head.revision, db: out };
}

/** Every revision of one document, with its text, if the person may see the document. */
export async function docHistory(store: Store, actor: Actor, docId: string): Promise<DocRevision[] | null> {
  const base = await current(store);
  if (!base) return null;
  const doc = base.db.docs.find((d) => d.id === docId);
  if (!doc || !withDb(base.db, () => canViewDoc(actor, doc))) return null;
  return base.db.docRevisions.filter((r) => r.docId === docId);
}
