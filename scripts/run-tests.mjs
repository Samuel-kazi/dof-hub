// Runs every test file in tests/, each in its own process, and reports them all, even when one fails.
//   npm test                       every file
//   npm test -- server workflow    only files whose name contains "server" or "workflow"
// The clock and time zone are fixed (tests/setup/clock.mjs) so results do not depend on the day.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const filters = process.argv.slice(2);
const files = readdirSync(resolve(root, "tests"))
  .filter((f) => /\.test\.tsx?$/.test(f))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();
if (files.length === 0) {
  console.error(`No test files match ${filters.join(", ")}.`);
  process.exit(1);
}

const env = { ...process.env, TZ: process.env.TZ || "Africa/Nairobi" };
const run = (file) =>
  new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./tests/setup/clock.mjs", `tests/${file}`], { cwd: root, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ file, ok: code === 0, out, ms: Date.now() - started }));
  });

const results = [];
const queue = [...files];
const workers = Array.from({ length: Math.max(1, Math.min(4, cpus().length)) }, async () => {
  while (queue.length) {
    const r = await run(queue.shift());
    results.push(r);
    process.stdout.write(`${r.ok ? "pass" : "FAIL"}  ${r.file}  (${(r.ms / 1000).toFixed(1)} s)\n`);
  }
});
await Promise.all(workers);

const failed = results.filter((r) => !r.ok);
for (const r of failed) {
  console.log(`\n──── ${r.file} ────`);
  const lines = r.out.split("\n");
  const shown = lines.filter((l) => /FAIL|Error|assert|^\s{4}/.test(l));
  console.log((shown.length ? shown : lines.slice(-40)).join("\n"));
}
console.log(`\n${results.length - failed.length} of ${results.length} test files passed.`);
process.exit(failed.length ? 1 : 0);
