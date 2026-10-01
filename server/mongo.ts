import { MongoClient, type AnyBulkWriteOperation, type Collection, type Db, type Document } from "mongodb";
import { HttpError } from "./errors";
import { layout1ToItems, versionedKeys } from "./layout";
import type {
  AttemptDoc,
  AttemptStore,
  Col,
  Commit,
  FileDoc,
  GoogleDoc,
  Head,
  Item,
  OAuthDoc,
  SessionDoc,
  StateStore,
  Store,
  UserDoc,
} from "./stores";

// The MongoDB version of the stores. Each element of the app's data is one document in `hub_items`, and
// `hub_meta` holds the revision and each part's version. A save only goes through if nobody else saved the
// same part in the meantime, and everything in one save goes through together or not at all.

type Doc = { _id: string };

class MongoCol<T extends Doc> implements Col<T> {
  constructor(
    private col: Collection<Document>,
    private expiry?: (d: T) => number,
  ) {}
  private out(d: Document | null): T | null {
    if (!d) return null;
    const { _exp, ...rest } = d as Document & { _exp?: Date };
    void _exp;
    return rest as unknown as T;
  }
  private inn(d: T): Document {
    return this.expiry ? { ...d, _exp: new Date(this.expiry(d)) } : { ...d };
  }
  async get(id: string) {
    return this.out(await this.col.findOne({ _id: id } as never));
  }
  async all() {
    return (await this.col.find({}).toArray()).map((d) => this.out(d)!);
  }
  async find(where: Partial<T>) {
    return (await this.col.find(where as never).toArray()).map((d) => this.out(d)!);
  }
  async insert(doc: T) {
    try {
      await this.col.insertOne(this.inn(doc) as never);
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
  }
  async put(doc: T) {
    await this.col.replaceOne({ _id: doc._id } as never, this.inn(doc), { upsert: true });
  }
  async remove(id: string) {
    await this.col.deleteOne({ _id: id } as never);
  }
}

/**
 * Sign-in attempt counts. Each change is one update in the database, so two attempts arriving together are
 * both counted. The window reset is part of the same update: if the window has passed, the count starts at one.
 */
class MongoAttempts implements AttemptStore {
  constructor(private col: Collection<Document>) {}
  private out(d: Document | null): AttemptDoc | null {
    return d
      ? { _id: String(d._id), count: Number(d.count ?? 0), first: Number(d.first ?? 0), lockedUntil: Number(d.lockedUntil ?? 0) }
      : null;
  }
  async get(key: string) {
    return this.out(await this.col.findOne({ _id: key } as never));
  }
  async charge(key: string, now: number, windowMs: number) {
    const fresh = { $or: [{ $eq: [{ $ifNull: ["$first", null] }, null] }, { $gt: [{ $subtract: [now, "$first"] }, windowMs] }] };
    const d = await this.col.findOneAndUpdate(
      { _id: key } as never,
      [
        {
          $set: {
            count: { $cond: [fresh, 1, { $add: [{ $ifNull: ["$count", 0] }, 1] }] },
            first: { $cond: [fresh, now, "$first"] },
            lockedUntil: { $ifNull: ["$lockedUntil", 0] },
            _exp: { $max: [{ $ifNull: ["$_exp", new Date(0)] }, new Date(now + windowMs)] },
          },
        },
      ],
      { upsert: true, returnDocument: "after" },
    );
    return this.out(d) ?? { _id: key, count: 1, first: now, lockedUntil: 0 };
  }
  async refund(key: string) {
    await this.col.updateOne({ _id: key, count: { $gt: 0 } } as never, { $inc: { count: -1 } });
  }
  async lock(key: string, until: number) {
    await this.col.updateOne(
      { _id: key } as never,
      { $set: { lockedUntil: until, _exp: new Date(until) }, $setOnInsert: { count: 0, first: Date.now() } },
      { upsert: true },
    );
  }
  async clear(key: string) {
    await this.col.deleteOne({ _id: key } as never);
  }
}

const META = "meta";
const LOCK = "upgrading";
const LOCK_STALE_MS = 5 * 60 * 1000;
const BATCH = 500;

class MongoState implements StateStore {
  constructor(
    private client: MongoClient,
    private db: Db,
  ) {}
  private get meta() {
    return this.db.collection<Document>("hub_meta");
  }
  private get col() {
    return this.db.collection<Document>("hub_items");
  }

  private toItem(d: Document): Item {
    return { k: String(d.k), i: String(d.i), o: Number(d.o), d: d.d };
  }
  private toDoc(it: Item): Document {
    return { _id: `${it.k}/${it.i}`, k: it.k, i: it.i, o: it.o, d: it.d };
  }

  async head(): Promise<Head | null> {
    let m = await this.meta.findOne({ _id: META } as never);
    if (!m && (await this.upgradeLayout())) m = await this.meta.findOne({ _id: META } as never);
    return m
      ? { revision: Number(m.revision), schemaVersion: Number(m.schemaVersion), versions: { ...(m.versions as Record<string, number>) } }
      : null;
  }

  async items(keys: string[]): Promise<Item[]> {
    return (
      await this.col
        .find({ k: { $in: keys } } as never)
        .sort({ k: 1, o: 1 })
        .toArray()
    ).map((d) => this.toItem(d));
  }

  async newest(key: string, limit: number): Promise<Item[]> {
    return (
      await this.col
        .find({ k: key } as never)
        .sort({ o: -1 })
        .limit(limit)
        .toArray()
    ).map((d) => this.toItem(d));
  }

  async commit(c: Commit): Promise<number | null> {
    const session = this.client.startSession();
    let revision: number | null = null;
    try {
      await session.withTransaction(async () => {
        revision = null;
        // Only if every part this change needs is still at the version it was loaded at.
        const filter: Document = { _id: META };
        for (const [k, v] of Object.entries(c.expect)) filter[`versions.${k}`] = v === 0 ? { $in: [0, null] } : v;
        const inc: Document = { revision: 1 };
        for (const k of Object.keys(c.expect)) inc[`versions.${k}`] = 1;
        const m = await this.meta.findOneAndUpdate(
          filter as never,
          { $inc: inc, $set: { schemaVersion: c.schemaVersion } },
          { session, returnDocument: "after" },
        );
        if (!m) {
          await session.abortTransaction();
          return;
        }
        const ops: AnyBulkWriteOperation<Document>[] = [
          ...c.remove.map((r) => ({ deleteOne: { filter: { _id: `${r.k}/${r.i}` } as never } })),
          ...c.put.map((it) => ({
            replaceOne: { filter: { _id: `${it.k}/${it.i}` } as never, replacement: this.toDoc(it), upsert: true },
          })),
        ];
        for (let i = 0; i < ops.length; i += BATCH) await this.col.bulkWrite(ops.slice(i, i + BATCH), { session, ordered: true });
        revision = Number(m.revision);
      });
    } finally {
      await session.endSession();
    }
    return revision;
  }

  async init(items: Item[], schemaVersion: number): Promise<boolean> {
    if (await this.head()) return false;
    const session = this.client.startSession();
    let created = true;
    try {
      await session.withTransaction(async () => {
        created = true;
        try {
          await this.meta.insertOne(
            { _id: META, revision: 1, schemaVersion, versions: Object.fromEntries(versionedKeys().map((k) => [k, 1])) } as never,
            { session },
          );
        } catch (e) {
          if ((e as { code?: number }).code === 11000) {
            created = false;
            await session.abortTransaction();
            return;
          }
          throw e;
        }
        for (let i = 0; i < items.length; i += BATCH)
          await this.col.insertMany(items.slice(i, i + BATCH).map((it) => this.toDoc(it)) as never, { session });
      });
    } finally {
      await session.endSession();
    }
    return created;
  }

  /**
   * Data saved by the earlier version of the app lives in the `state` collection, one document per part, with
   * photos inside. The first server to start copies it into the new layout and moves the photos into `files`.
   * The `state` collection is left exactly as it was, as a backup. Returns true once the new layout exists.
   */
  private async upgradeLayout(): Promise<boolean> {
    const old = this.db.collection<Document>("state");
    const oldMeta = await old.findOne({ _id: META } as never);
    if (!oldMeta) return false; // a brand-new installation: nothing to upgrade
    try {
      await this.meta.insertOne({ _id: LOCK, at: new Date() } as never);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      const lock = await this.meta.findOne({ _id: LOCK } as never);
      if (lock && Date.now() - new Date(lock.at as Date).getTime() < LOCK_STALE_MS)
        throw new HttpError(503, "The data is being moved to its new layout. This takes a minute, once. Try again shortly.", "upgrading");
      await this.meta.deleteOne({ _id: LOCK, at: lock?.at } as never); // left behind by a server that stopped part way: start again
      return this.upgradeLayout();
    }
    try {
      if (await this.meta.findOne({ _id: META } as never)) return true; // another server finished while this one waited
      const parts = await old.find({ _id: { $ne: META } } as never).toArray();
      const { items, files } = layout1ToItems(Object.fromEntries(parts.map((d) => [String(d._id), d.data])));
      // A file's _id comes from the filter; setting it again in the update is refused by MongoDB.
      const fileOps = files.map(({ _id, ...f }) => ({
        updateOne: { filter: { _id } as never, update: { $setOnInsert: f }, upsert: true },
      }));
      for (let i = 0; i < fileOps.length; i += BATCH)
        await this.db.collection<Document>("files").bulkWrite(fileOps.slice(i, i + BATCH), { ordered: false });
      const itemOps = items.map((it) => ({
        replaceOne: { filter: { _id: `${it.k}/${it.i}` } as never, replacement: this.toDoc(it), upsert: true },
      }));
      for (let i = 0; i < itemOps.length; i += BATCH) await this.col.bulkWrite(itemOps.slice(i, i + BATCH), { ordered: false });
      // Written last: until this exists, nobody reads or writes the new layout.
      await this.meta.updateOne(
        { _id: META } as never,
        {
          $setOnInsert: {
            revision: Number(oldMeta.revision ?? 1),
            schemaVersion: Number(oldMeta.schemaVersion ?? 0),
            versions: Object.fromEntries(versionedKeys().map((k) => [k, 1])),
            upgradedFrom: "state",
            upgradedAt: new Date(),
          },
        },
        { upsert: true },
      );
      return true;
    } finally {
      await this.meta.deleteOne({ _id: LOCK } as never);
    }
  }
}

/** The stores for one database, on a client that is already connected. */
export async function storeOn(client: MongoClient, dbName: string): Promise<Store> {
  const db = client.db(dbName);
  const ttl = (name: string) =>
    db
      .collection(name)
      .createIndex({ _exp: 1 }, { expireAfterSeconds: 0 })
      .catch(() => undefined);
  await Promise.all([
    ttl("sessions"),
    ttl("attempts"),
    ttl("oauth"),
    db
      .collection("users")
      .createIndex({ personId: 1 })
      .catch(() => undefined),
    db
      .collection("hub_items")
      .createIndex({ k: 1, o: 1 })
      .catch(() => undefined),
  ]);
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
    files: new MongoCol<FileDoc>(db.collection("files")),
    users: new MongoCol<UserDoc>(db.collection("users")),
    sessions: new MongoCol<SessionDoc>(db.collection("sessions"), (d) => d.expiresAt),
    attempts: new MongoAttempts(db.collection("attempts")),
    google: new MongoCol<GoogleDoc>(db.collection("google")),
    oauth: new MongoCol<OAuthDoc>(db.collection("oauth"), (d) => d.expiresAt),
  };
}

let cached: { key: string; store: Promise<Store> } | undefined;

export function mongoStore(uri: string, dbName: string): Promise<Store> {
  const key = `${uri}\n${dbName}`;
  if (cached?.key === key) return cached.store;
  const store = (async (): Promise<Store> => {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
    await client.connect();
    return storeOn(client, dbName);
  })();
  cached = { key, store };
  store.catch(() => {
    cached = undefined;
  }); // try again next time if the connection failed
  return store;
}
