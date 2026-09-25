// Run with: npx tsx tests/checkout-list.test.tsx
// The checkout list's Items table: equipment ID, quantity, condition, photos, make/model, accessories
// and additional info, grouped under a heading per equipment category.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "../src/ui/AppContext";
import { ManifestPage } from "../src/pages/Manifest";
import { login } from "../src/services/auth";
import { resetDemoData, getDb } from "../src/data/store";
import { createManifest, markGoneOut } from "../src/services/equipment";

let passed = 0;
const t = (name: string, fn: () => void) => { resetDemoData(); try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", e instanceof Error ? e.message : e); process.exitCode = 1; } };
const hop = () => login("hop@dof.demo", "demo");
const page = (id: string) => renderToString(<AppProvider actor={hop()} onLogout={() => {}}>{React.createElement(ManifestPage, { id })}</AppProvider>);

t("every field asked for appears as its own column: equipment ID, make/model, qty, condition, photos, accessories, info", () => {
  const m = getDb().manifests.find((x) => x.lines.length > 0)!;
  const html = page(m.id);
  for (const col of ["Item", "Make/Model", "Qty", "Condition out", "Photos out", "Accessories", "Info"]) {
    assert.match(html, new RegExp(`>${col}<`), `column header "${col}"`);
  }
  const item = getDb().equipment.find((e) => e.id === m.lines[0].equipmentId)!;
  assert.match(html, new RegExp(item.id), "the equipment ID itself is shown, not just the item name");
});

t("items from more than one category are grouped under a heading per category, sorted alphabetically", () => {
  const actor = hop();
  const m = createManifest(actor, { contentId: "DOF-SER-001", date: "2026-10-05", destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-AUD-001", quantity: 1 }, { equipmentId: "DOF-EQ-CAM-001", quantity: 1 }] });
  const html = page(m.id);
  assert.equal((html.match(/table-group/g) ?? []).length, 2, "one heading per category, even though there are two lines each");
  const audioAt = html.indexOf(">Audio<");
  const cameraAt = html.indexOf(">Camera<");
  assert.ok(audioAt > -1 && cameraAt > -1 && audioAt < cameraAt, "Audio sorts before Camera");
});

t("a single category still gets its own heading, not a bare list", () => {
  const actor = hop();
  const m = createManifest(actor, { contentId: "DOF-SER-001", date: "2026-10-05", destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }, { equipmentId: "DOF-EQ-CAM-002", quantity: 1 }] });
  const html = page(m.id);
  assert.equal((html.match(/table-group/g) ?? []).length, 1);
  assert.match(html, />Camera</);
});

t("a photo taken out is shown as an actual thumbnail, not just a link, once uploaded", () => {
  const actor = hop();
  const m = createManifest(actor, { contentId: "DOF-SER-001", date: "2026-10-05", destination: "outside", status: "assigned", lines: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }] });
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  markGoneOut(actor, m.id, { photos: { "DOF-EQ-CAM-001": [{ url: dataUrl }] } });
  assert.match(page(m.id), /<img/);
});

t("an item with no accessories or notes listed says so plainly, rather than showing an empty cell", () => {
  const m = getDb().manifests.find((x) => x.lines.some((l) => !getDb().equipment.find((e) => e.id === l.equipmentId)?.accessories))!;
  assert.match(page(m.id), /None listed|None/);
});

console.log(`\n${passed} passed`);
