// Run with: npx tsx tests/reports.test.ts
// Reports: what they hold, who may make them, and the PDF they become.
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { RuleError } from "../src/types";
import { login } from "../src/services/auth";
import * as P from "../src/services/permissions";
import { REPORT_KINDS, bodyToBlocks, buildReport, reportToText, reportsFor, type ReportDoc } from "../src/services/reports";
import { pdfSafe, reportToPdf } from "../src/services/pdf";
import { saveFile } from "../src/services/download";

let passed = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  resetDemoData();
  try { await fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof RuleError && (!match || match.test(e.message)));
const hop = () => login("hop@dof.demo", "demo");
const crew = () => login("crew2@dof.demo", "demo");
const vol = () => login("volunteer1@dof.demo", "demo");
const PARAMS: Record<string, Record<string, string>> = { "drive.detail": { driveId: "DRV-001" }, "manifest.list": { manifestId: "DOF-MF-002" }, "callsheet.pdf": { callSheetId: "DOF-CS-002" }, "project.summary": { contentId: "DOF-SER-001-S1-E01" }, "doc.pdf": { docId: "DOF-DCS-002" } };
const pageCount = (bytes: Uint8Array) => (new TextDecoder("latin1").decode(bytes).match(/\/Type \/Page[^s]/g) ?? []).length;

await t("every kind of report can be made, and has content", () => {
  for (const k of REPORT_KINDS) {
    const r = buildReport(hop(), k.key, PARAMS[k.key] ?? {});
    assert.ok(r.title && r.filename && r.blocks.length > 0, k.key);
    assert.ok(reportToText(r).includes(r.title), k.key);
  }
});
await t("each scope offers its own reports", () => {
  assert.deepEqual(reportsFor("storage").map((k) => k.key), ["storage.fleet", "storage.byProject", "storage.nearlyFull"]);
  assert.ok(reportsFor("equipment").length >= 4);
  assert.equal(reportsFor("document").length, 1);
});
await t("the equipment list can be limited to a category, and can include retired items", () => {
  const cam = buildReport(hop(), "equipment.inventory", { category: "camera" });
  assert.ok(cam.blocks.every((b) => b.type !== "heading" || b.text.startsWith("Camera")));
  const without = reportToText(buildReport(hop(), "equipment.inventory", { category: "audio" }));
  assert.ok(!without.includes("DOF-EQ-AUD-004"));
  assert.ok(reportToText(buildReport(hop(), "equipment.inventory", { category: "audio", includeOut: true })).includes("DOF-EQ-AUD-004"));
});
await t("a project report gathers the people, links, documents, gear list IDs and storage", () => {
  const text = reportToText(buildReport(hop(), "project.summary", { contentId: "DOF-SER-001-S1-E01" }));
  for (const expected of ["DOF-SER-001-S1-E01", "Who does what", "Wanjiru Kamau", "Dr. Samuel Mwangi", "drive.google.com", "Script:"]) assert.ok(text.toLowerCase().includes(expected.toLowerCase()), expected);
  assert.ok(reportToText(buildReport(hop(), "project.summary", { contentId: "DOF-SER-001" })).includes("DOF-MF-001"), "the checkout list ID");
});
await t("crew can make reports, volunteers and partners cannot until they are given the right", () => {
  assert.ok(buildReport(crew(), "storage.fleet"));
  throwsRule(() => buildReport(vol(), "storage.fleet"), /produce reports/);
  P.setPersonGrant(hop(), "DOF-P-VOL-001", "reports.export", true);
  assert.ok(buildReport(vol(), "doc.pdf", { docId: "DOF-DCS-002" }));
});
await t("taking the permission away stops a crew member", () => {
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "reports.export", false);
  throwsRule(() => buildReport(crew(), "storage.fleet"), /produce reports/);
});
await t("the activity log report needs its own permission", () => {
  throwsRule(() => buildReport(crew(), "audit.log"), /activity log/);
  P.setPersonGrant(hop(), "DOF-P-CRW-002", "backend.audit", true);
  assert.ok(buildReport(crew(), "audit.log"));
});
await t("a report only includes what the person may see", () => {
  const listed = reportToText(buildReport(crew(), "pipeline.status", { which: "all" }));
  assert.ok(listed.includes("DOF-LIVE-001-D1"), "crew see every project");
  const v = reportToText(buildReport((P.setPersonGrant(hop(), "DOF-P-VOL-001", "reports.export", true), vol()), "pipeline.status", { which: "all" }));
  assert.ok(!v.includes("DOF-LIVE-001-D1"), "volunteers see only theirs");
});
await t("a document report keeps the numbered sections, notes and checkboxes", () => {
  const blocks = bodyToBlocks("1. Working title\n_Say it in a few words._\nWhy do we doubt?\n\n2. Approval\n- [x] Read\n- [ ] Locked\n- One\n- Two");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "note", "para", "heading", "check", "check", "bullets"]);
  assert.deepEqual((blocks[6] as { items: string[] }).items, ["One", "Two"]);
});
await t("a PDF is made, on more than one page when the report is long", async () => {
  const short = await reportToPdf(buildReport(hop(), "storage.fleet"));
  assert.equal(new TextDecoder().decode(short.slice(0, 5)), "%PDF-");
  assert.ok(pageCount(short) >= 1);
  const long: ReportDoc = { title: "Long", subtitle: "", filename: "long", blocks: [{ type: "table", head: ["A", "B"], rows: Array.from({ length: 200 }, (_, i) => [`Row ${i}`, "x".repeat(60)]) }] };
  assert.ok(pageCount(await reportToPdf(long)) > 2);
});
await t("a PDF handles text the built-in fonts cannot draw", async () => {
  assert.equal(pdfSafe("Why? “Faith” → hope… — ok"), 'Why? "Faith" -> hope... - ok');
  assert.equal(pdfSafe("Mwangi\u4e2d"), "Mwangi");
  const r: ReportDoc = { title: "Arrows → and “quotes”", subtitle: "Nairobi, 21 Sep", filename: "x", blocks: [{ type: "para", text: "Café ☐ done" }] };
  assert.ok((await reportToPdf(r)).length > 500);
});
await t("saving uses the desktop save dialog when it is there, and does nothing if it is cancelled", async () => {
  const written: { path: string; n: number }[] = [];
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = { dialog: { save: async () => "/Users/kev/report.pdf" }, fs: { writeFile: async (path: string, d: Uint8Array) => { written.push({ path, n: d.length }); } } };
  const saved = await saveFile("report.pdf", new Uint8Array([1, 2, 3]));
  assert.deepEqual(saved, { how: "saved", where: "/Users/kev/report.pdf" }); assert.deepEqual(written, [{ path: "/Users/kev/report.pdf", n: 3 }]);
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = { dialog: { save: async () => null }, fs: { writeFile: async () => { throw new Error("should not write"); } } };
  assert.equal(await saveFile("report.pdf", new Uint8Array([1])), null);
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
});

console.log(`\n${passed} passed`);

await t("a call sheet's report has its own shoot details, crew, gear and run of show, not a document", () => {
  assert.equal(reportsFor("callsheet").length, 1, "call sheets have their own report scope, separate from documents");
  const withGear = reportToText(buildReport(hop(), "callsheet.pdf", { callSheetId: "DOF-CS-001" }));
  for (const expected of ["Whispers of Why", "Crew", "Gear"]) assert.ok(withGear.toLowerCase().includes(expected.toLowerCase()), expected);
  const withRunOfShow = reportToText(buildReport(hop(), "callsheet.pdf", { callSheetId: "DOF-CS-002" }));
  assert.ok(withRunOfShow.toLowerCase().includes("run of show"), "the run of show prints for a large production");
  assert.ok(withRunOfShow.toLowerCase().includes("days on this sheet"), "a live show calls its episodes days");
  throwsRule(() => buildReport(hop(), "callsheet.pdf", { callSheetId: "NOPE" }), /not found/);
});

await t("the equipment list's extra columns are opt-in, and only show what was asked for", () => {
  const plain = reportToText(buildReport(hop(), "equipment.inventory", { category: "camera" }));
  assert.ok(!plain.toLowerCase().includes("vendor") && !plain.toLowerCase().includes("packaging"), "no extra columns by default");
  const withVendorAndCost = reportToText(buildReport(hop(), "equipment.inventory", { category: "camera", colVendor: true, colCost: true }));
  assert.ok(withVendorAndCost.toLowerCase().includes("vendor") && withVendorAndCost.toLowerCase().includes("cost"), "the chosen columns appear");
  assert.ok(!withVendorAndCost.toLowerCase().includes("packaging"), "a column not chosen stays out");
  const full = reportToText(buildReport(hop(), "equipment.inventory", { category: "camera", colVendor: true, colPurchased: true, colCost: true, colPackaging: true }));
  for (const col of ["Vendor", "Purchased", "Cost", "Packaging"]) assert.ok(full.includes(col), col);
  assert.ok(full.includes("Pelican 1620"), "packaging values are pulled through");
});

await t("the checkout list report is grouped by category and shows make/model, accessories and notes per item", () => {
  const m = getDb().manifests.find((x) => x.id === "DOF-MF-001")!;
  const text = reportToText(buildReport(hop(), "manifest.list", { manifestId: m.id }));
  assert.ok(text.toLowerCase().includes("audio") && text.toLowerCase().includes("camera"), "category headings appear");
  for (const col of ["Asset code", "Make/model", "Qty", "Condition out", "Photos", "Accessories", "Info"]) assert.ok(text.includes(col), col);
  assert.ok(text.includes("Sony FX3"), "make/model values are pulled through");
  assert.ok(text.includes("batteries") || text.includes("cage"), "accessories are pulled through");
  const audioIdx = text.toLowerCase().indexOf("audio");
  const cameraIdx = text.toLowerCase().indexOf("camera");
  const cablingIdx = text.toLowerCase().indexOf("cabling");
  assert.ok(audioIdx < cablingIdx && cablingIdx < cameraIdx, "groups are sorted alphabetically by category, not by line order");
});
