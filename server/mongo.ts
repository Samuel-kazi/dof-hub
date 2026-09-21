import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import type { AttemptDoc, Col, GoogleDoc, Loaded, OAuthDoc, SessionDoc, StateStore, Store, UserDoc } from "./stores";

// The MongoDB version of the stores. Each part of the app's data is one document in `state`, with a
// version number. A save only goes through if nobody else saved that part in the meantime, and all the
// parts of one save go through together or not at all.

type Doc = { _id: string };

class MongoCol<T extends Doc> implements Col<T> {
  constructor(private col: Collection<Document>, private expiry?: (d: T) => number) {}
  private out(d: Document | null): T | null {
    if (!d) return null;
    const { _exp, ...rest } = d as Document & { _exp?: Date };
    void _exp;
    return rest as unknown as T;
  }
  private inn(d: T): Document { return this.expiry ? { ...d, _exp: new Date(this.expiry(d)) } : { ...d }; }
  async get(id: string) { return this.out(await this.col.findOne({ _id: id } as never)); }
  async all() { return (await this.col.find({}).toArray()).map((d) => this.out(d)!); }
  async find(where: Partial<T>) { return (await this.col.find(where as never).toArray()).map((d) => this.out(d)!); }
  async insert(doc: T) {
    try { await this.col.insertOne(this.inn(doc) as never); return true; } catch (e) { if ((e as { code?: number }).code === 11000) return false; throw e; }
  }
  async put(doc: T) { await this.col.replaceOne({ _id: doc._id } as never, this.inn(doc), { upsert: true }); }
  async remove(id: string) { await this.col.deleteOne({ _id: id } as never); }
}

class MongoState implements StateStore {
  constructor(private client: MongoClient, private db: Db) {}
  private get col() { return this.db.collection<Document>("state"); }

  async load(keys?: string[]): Promise<Loaded | null> {
    const meta = await this.col.findOne({ _id: "meta" } as never);
    if (!meta) return null;
    const docs = await this.col.find(keys ? ({ _id: { $in: keys } } as never) : ({ _id: { $ne: "meta" } } as never)).toArray();
    const data: Record<string, unknown> = {};
    const versions: Record<string, number> = {};
    for (const d of docs) { data[String(d._id)] = d.data; versions[String(d._id)] = d.v as number; }
    return { data, versions, revision: meta.revision as number, schemaVersion: meta.schemaVersion as number };
  }

  async save(changes: Record<string, unknown>, expected: Record<string, number>, schemaVersion: number): Promise<boolean> {
    const session = this.client.startSession();
    let ok = true;
    try {
      await session.withTransaction(async () => {
        ok = true;
        for (const [key, data] of Object.entries(changes)) {
          if (expected[key] === undefined) {
            try { await this.col.insertOne({ _id: key, v: 1, data } as never, { session }); } catch (e) { if ((e as { code?: number }).code === 11000) { ok = false; await session.abortTransaction(); return; } throw e; }
          } else {
            const r = await this.col.updateOne({ _id: key, v: expected[key] } as never, { $set: { data }, $inc: { v: 1 } }, { session });
            if (r.matchedCount === 0) { ok = false; await session.abortTransaction(); return; }
          }
        }
        await this.col.updateOne({ _id: "meta" } as never, { $inc: { revision: 1 }, $set: { schemaVersion } }, { session, upsert: true });
      });
    } finally {
      await session.endSession();
    }
    return ok;
  }

  async init(data: Record<string, unknown>, schemaVersion: number): Promise<boolean> {
    const session = this.client.startSession();
    let created = true;
    try {
      await session.withTransaction(async () => {
        created = true;
        try { await this.col.insertOne({ _id: "meta", revision: 1, schemaVersion } as never, { session }); } catch (e) { if ((e as { code?: number }).code === 11000) { created = false; await session.abortTransaction(); return; } throw e; }
        await this.col.insertMany(Object.entries(data).map(([k, v]) => ({ _id: k, v: 1, data: v })) as never, { session });
      });
    } finally {
      await session.endSession();
    }
    return created;
  }
}

let cached: { uri: string; store: Promise<Store> } | undefined;

export function mongoStore(uri: string, dbName: string): Promise<Store> {
  if (cached?.uri === uri) return cached.store;
  const store = (async (): Promise<Store> => {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
    await client.connect();
    const db = client.db(dbName);
    const ttl = (name: string) => db.collection(name).createIndex({ _exp: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
    await Promise.all([ttl("sessions"), ttl("attempts"), ttl("oauth"), db.collection("users").createIndex({ personId: 1 }).catch(() => undefined)]);
    return {
      /** Checks that saves can be made all-or-nothing, which the app relies on. */
      diagnose: async () => {
        const s = client.startSession();
        try {
          await s.withTransaction(async () => {
            await db.collection("diagnostics").insertOne({ _id: "probe", at: new Date() } as never, { session: s });
            await db.collection("diagnostics").deleteOne({ _id: "probe" } as never, { session: s });
          });
          return { transactions: true };
        } catch (e) {
          console.error("Transaction check failed", e);
          return { transactions: false, hint: e instanceof Error ? e.name : "unknown" };
        } finally {
          await s.endSession();
        }
      },
      state: new MongoState(client, db),
      users: new MongoCol<UserDoc>(db.collection("users")),
      sessions: new MongoCol<SessionDoc>(db.collection("sessions"), (d) => d.expiresAt),
      attempts: new MongoCol<AttemptDoc>(db.collection("attempts"), (d) => Math.max(d.lockedUntil, d.first + 15 * 60 * 1000)),
      google: new MongoCol<GoogleDoc>(db.collection("google")),
      oauth: new MongoCol<OAuthDoc>(db.collection("oauth"), (d) => d.expiresAt),
    };
  })();
  cached = { uri, store };
  store.catch(() => { cached = undefined; }); // try again next time if the connection failed
  return store;
}
