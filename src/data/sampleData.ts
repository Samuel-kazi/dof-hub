import type { Database } from "../types";
import { todayIso } from "../services/utils";
import { buildSeed } from "./seed";
import { moveToNewSystem } from "./moveToNewSystem";
import { liveMusicToWorkflow } from "./migrateLiveMusic";

// The sample data the demo, the desktop app and a new site set up "with samples" start from: the built-in examples
// (./seed.ts), moved into the five-stage workflow and its documents by the same move a live site runs from Settings
// (./moveToNewSystem.ts), as approved. The move itself is left out of the sample's activity log: nothing was moved by
// anyone. The examples as they were before the workflow stay in buildSeed, for the tests of the earlier pipeline.

export function buildSampleData(): Database {
  const db = buildSeed();
  const logged = db.audit.length;
  // The sample live shows and music move onto the workflow as saved data does (data version 23), before the move into
  // the documents, so their Development forms are moved with the rest.
  liveMusicToWorkflow(db);
  moveToNewSystem(db, { today: todayIso(), at: new Date().toISOString(), byPersonId: "DOF-P-HOP-001" });
  db.audit = db.audit.slice(0, logged);
  return db;
}
