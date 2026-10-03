import type { Database } from "../../src/types";
import { buildSeed } from "../../src/data/seed";

// A site set up "with samples" starts with the examples already moved into the five-stage workflow
// (src/data/sampleData.ts). The tests of the earlier pipeline, and of the server's general behaviour on it, put the
// examples back as they were before the workflow, keeping the accounts that setup made.

type AnyStore = Parameters<typeof import("../../server/state").changeAllData>[0];

export async function putBackEarlierExamples(store: AnyStore): Promise<void> {
  const { changeAllData } = await import("../../server/state");
  await changeAllData(store, true, "before_test", (db: Database) => {
    const seed = buildSeed() as unknown as Record<string, unknown>;
    for (const key of Object.keys(seed))
      if (key !== "users" && key !== "people") (db as unknown as Record<string, unknown>)[key] = seed[key];
  });
}
