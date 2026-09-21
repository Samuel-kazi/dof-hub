// Run with: npx tsx tests/search.test.ts
import assert from "node:assert/strict";
import { resetDemoData } from "../src/data/store";
import { login } from "../src/services/auth";
import { searchAll } from "../src/services/search";
import { resolveTheme } from "../src/ui/theme";

resetDemoData();
const hop = login("hop@dof.demo", "demo");
const crew = login("crew2@dof.demo", "demo");
const vol = login("volunteer1@dof.demo", "demo");
let n = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; } };

t("short queries return nothing", () => assert.deepEqual(searchAll(hop, "a"), []));
t("projects match by title and by Content ID", () => {
  assert.ok(searchAll(hop, "whispers").some((h) => h.kind === "project" && h.id === "DOF-SER-001"));
  assert.ok(searchAll(hop, "DOF-LIVE-001").some((h) => h.kind === "project" && h.id === "DOF-LIVE-001"));
});
t("every word must match", () => assert.equal(searchAll(hop, "whispers zzzz").length, 0));
t("crew find gear and drives", () => {
  assert.ok(searchAll(crew, "fx3").some((h) => h.kind === "gear"));
  assert.ok(searchAll(crew, "extreme").some((h) => h.kind === "drive"));
});
t("volunteers never see gear or drives", () => {
  assert.equal(searchAll(vol, "fx3").filter((h) => h.kind === "gear").length, 0);
  assert.equal(searchAll(vol, "extreme").filter((h) => h.kind === "drive").length, 0);
});
t("volunteers only find projects they are attached to", () => {
  const ids = searchAll(vol, "DOF-").filter((h) => h.kind === "project").map((h) => h.id);
  assert.ok(!ids.includes("DOF-LIVE-001") || ids.length < searchAll(hop, "DOF-", 50).filter((h) => h.kind === "project").length);
});
t("results are capped per kind", () => assert.ok(searchAll(hop, "dof", 2).filter((h) => h.kind === "gear").length <= 2));
t("documents are found by title, and only where they may be read", () => {
  assert.ok(searchAll(hop, "script").some((h) => h.kind === "doc"));
  const volDocs = searchAll(vol, "script", 20).filter((h) => h.kind === "doc");
  assert.ok(volDocs.every((h) => !h.sub.includes("DOF-DEV-001")), "the volunteer is not on the devotional");
});
t("an explicit theme choice wins over the system", () => { assert.equal(resolveTheme("light"), "light"); assert.equal(resolveTheme("dark"), "dark"); });
console.log(`\n${n} passed`);
