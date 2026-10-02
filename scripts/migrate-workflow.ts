// Moves the existing series, devotionals and documentaries into the five-stage workflow, or shows what that would do.
//
//   MONGODB_URI=… npm run migrate:workflow                     a dry run: reads the data, reports, writes nothing
//   MONGODB_URI=… npm run migrate:workflow -- --apply          keeps a copy of all the data, then moves them
//
// Choices, before moving (repeat as needed):
//   --series DOF-SER-002=sermon          a series' type: podcast (the default), testimonial or sermon
//   --documentary DOF-DOC-002=pitched    a documentary pitched by others (the default is DOF-made)
//
// MONGODB_DB names the database (default "dof", as on the server). The Head of Production can do the same from
// Settings on the hosted site. The report gives every record's before and after, what is left for a decision by
// hand and why, and each part's row count before and after. Running it again changes nothing.
import { MongoClient } from "mongodb";
import type { SeriesType } from "../src/types";
import { storeOn } from "../server/mongo";
import { migrateWorkflowStore, type MigrationChoices } from "../server/migrateWorkflow";
import { describeMigration } from "../src/data/migrateWorkflow";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Set MONGODB_URI to the database's connection string.");
  process.exit(2);
}
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const picked: Required<MigrationChoices> = { seriesTypes: {}, documentaryForms: {} };
for (let i = 0; i < args.length; i++) {
  const [flag, value] = [args[i], args[i + 1] ?? ""];
  const [id, choice] = value.split("=");
  if (flag === "--series") {
    if (!id || !["podcast", "testimonial", "sermon"].includes(choice))
      throw new Error(`--series needs ID=podcast, testimonial or sermon, not "${value}".`);
    picked.seriesTypes[id] = choice as SeriesType;
    i++;
  } else if (flag === "--documentary") {
    if (!id || !["dof", "pitched"].includes(choice)) throw new Error(`--documentary needs ID=dof or pitched, not "${value}".`);
    picked.documentaryForms[id] = choice === "pitched" ? "documentary_pitched" : "documentary_dof";
    i++;
  } else if (flag !== "--apply") throw new Error(`Unknown option ${flag}.`);
}
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const store = await storeOn(client, process.env.MONGODB_DB || "dof");
  const report = await migrateWorkflowStore(store, apply, "system", picked);
  if (!report) console.log("This database has not been set up yet. There is nothing to move.");
  else {
    console.log(describeMigration(report, report.applied));
    if (report.backup) console.log(`\nA copy of the data before the move is in ${report.backup}.`);
    if (apply && report.changed && !report.applied) {
      console.error("Someone saved a change while the move was being worked out, so nothing was written. Run it again.");
      process.exitCode = 1;
    }
    if (!apply && report.changed) console.log("\nThis was a dry run. Nothing was written. Add --apply to move them.");
  }
} finally {
  await client.close();
}
