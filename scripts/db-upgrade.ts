// Brings the data in MongoDB up to this version of the app, or shows what that would change.
//
//   MONGODB_URI=… npm run db:upgrade               a dry run: reads the data, reports, writes nothing
//   MONGODB_URI=… npm run db:upgrade -- --apply    keeps a copy of all the data, then upgrades it
//
// MONGODB_DB names the database (default "dof", as on the server). The server does the same upgrade by itself the
// first time it reads older data, with the same copy kept first; this is for seeing it, or doing it, beforehand.
// The report gives, for each part of the data, how many elements it had before and after.
import { MongoClient } from "mongodb";
import { storeOn } from "../server/mongo";
import { describeUpgrade, upgradeStore } from "../server/state";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Set MONGODB_URI to the database's connection string.");
  process.exit(2);
}
const apply = process.argv.includes("--apply");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const store = await storeOn(client, process.env.MONGODB_DB || "dof");
  const report = await upgradeStore(store, apply);
  if (!report) console.log("This database has not been set up yet. There is nothing to upgrade.");
  else {
    console.log(describeUpgrade(report));
    if (apply && !report.applied && report.from !== report.to) {
      console.error("Someone saved a change while the upgrade was being worked out, so nothing was written. Run it again.");
      process.exitCode = 1;
    }
    if (!apply && report.from !== report.to) console.log("\nThis was a dry run. Nothing was written. Add --apply to upgrade.");
  }
} finally {
  await client.close();
}
