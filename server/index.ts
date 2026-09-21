import { HttpError } from "./errors";
import { mongoStore } from "./mongo";
import { createHandler } from "./router";
import { memoryStore, type Store } from "./stores";

let memory: Store | undefined;

async function getStore(): Promise<Store> {
  if (process.env.DOF_STORE === "memory") return (memory ??= memoryStore()); // for trying it on a laptop
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new HttpError(503, "MONGODB_URI is not set on the server.");
  try {
    return await mongoStore(uri, process.env.MONGODB_DB || "dof");
  } catch (e) {
    console.error("MongoDB connection failed", e);
    throw new HttpError(503, "The database could not be reached. Try again in a minute.");
  }
}

export const handler = createHandler(getStore);
export { createHandler } from "./router";
export { memoryStore } from "./stores";
