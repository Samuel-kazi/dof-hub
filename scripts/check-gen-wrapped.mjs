// Regenerates src/services/wrapped/*.ts into a throwaway directory and diffs it against what is
// committed. If a service function was added, renamed, or had its actor-first status change without
// `npm run gen` being run and committed, this fails the build instead of letting the server and the
// app quietly drift out of sync.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const committedDir = resolve(root, "src/services/wrapped");
const tmpDir = mkdtempSync(join(tmpdir(), "dof-hub-gen-check-"));

try {
  execFileSync("node", ["scripts/gen-wrapped.mjs", "--out", tmpDir], { cwd: root, stdio: "pipe" });

  const committedFiles = new Set(readdirSync(committedDir).filter((f) => f.endsWith(".ts")));
  const freshFiles = new Set(readdirSync(tmpDir).filter((f) => f.endsWith(".ts")));
  const allFiles = new Set([...committedFiles, ...freshFiles]);

  const stale = [];
  for (const file of allFiles) {
    const committed = committedFiles.has(file) ? readFileSync(join(committedDir, file), "utf8") : null;
    const fresh = freshFiles.has(file) ? readFileSync(join(tmpDir, file), "utf8") : null;
    if (committed !== fresh) stale.push(file);
  }

  if (stale.length) {
    console.error(`Wrapped services are stale — run \`npm run gen\` and commit the result.`);
    console.error(`Out of date: ${stale.sort().join(", ")}`);
    process.exit(1);
  }
  console.log("Wrapped services are up to date.");
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
