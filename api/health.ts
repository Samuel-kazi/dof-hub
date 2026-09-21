import type { VercelRequest, VercelResponse } from "@vercel/node";
import { MongoClient } from "mongodb";

// The connection is kept between calls, so each request does not open a new one.
let client: MongoClient | undefined;

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const uri = process.env.MONGODB_URI;
  if (!uri) return res.status(500).json({ ok: false, problem: "MONGODB_URI is not set on Vercel." });
  try {
    client ??= new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    await client.db(process.env.MONGODB_DB || "dof").command({ ping: 1 });
    return res.status(200).json({ ok: true, message: "Connected to MongoDB." });
  } catch (e) {
    client = undefined;
    console.error("MongoDB connection failed", e); // the full detail is in Vercel > Logs
    return res.status(500).json({ ok: false, problem: "Could not connect to MongoDB.", hint: e instanceof Error ? e.name : "unknown" });
  }
}
