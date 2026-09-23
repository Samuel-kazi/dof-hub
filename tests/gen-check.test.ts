// Run with: npx tsx tests/gen-check.test.ts
// scripts/check-gen-wrapped.mjs is what CI relies on to catch a service function added or renamed
// without `npm run gen` being run and committed. Test the checker itself, not just the generator.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log("ok  ", name); };

const run = (): { code: number; out: string } => {
  try {
    const out = execFileSync("node", ["scripts/check-gen-wrapped.mjs"], { cwd: root, encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
};

t("passes when the committed wrapped services already match the generator", () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /up to date/);
});

t("fails, with the exact message, when a wrapped file is hand-edited out of sync", () => {
  const target = resolve(root, "src/services/wrapped/equipment.ts");
  const original = readFileSync(target, "utf8");
  try {
    writeFileSync(target, original + "\n// tampered\n");
    const r = run();
    assert.equal(r.code, 1);
    assert.match(r.out, /Wrapped services are stale — run `npm run gen` and commit the result\./);
    assert.match(r.out, /equipment\.ts/);
  } finally {
    writeFileSync(target, original);
  }
});

t("fails when a service file gains a new actor-first export that was never regenerated", () => {
  // This is the scenario CI exists to catch: someone adds a function and forgets `npm run gen`.
  const target = resolve(root, "src/services/equipment-items.ts");
  const original = readFileSync(target, "utf8");
  try {
    writeFileSync(target, `${original}\nexport function _testOnlyDrift(actor: import("../types").Actor): void { void actor; }\n`);
    const r = run();
    assert.equal(r.code, 1, "a new actor-first export not yet generated must fail the check");
    assert.match(r.out, /Wrapped services are stale/);
  } finally {
    writeFileSync(target, original);
  }
});

t("passes again once the committed state matches after that same change", () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
});

console.log(`\n${passed} passed`);
