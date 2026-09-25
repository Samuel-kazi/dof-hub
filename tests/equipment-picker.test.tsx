// Run with: npx tsx tests/equipment-picker.test.tsx
// The checkout picker: grouped by category, condition shown, details expand for accessories/photos,
// and a serial number is optional everywhere it's entered.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "../src/ui/AppContext";
import { GearPicker } from "../src/ui/GearPicker";
import { ItemFormModal } from "../src/pages/EquipmentForms";
import { login } from "../src/services/auth";
import { resetDemoData, getDb } from "../src/data/store";
import { addAttachment } from "../src/services/equipment";

let passed = 0;
const t = (name: string, fn: () => void) => { resetDemoData(); try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", e instanceof Error ? e.message : e); process.exitCode = 1; } };
const hop = () => login("hop@dof.demo", "demo");
const withCtx = (el: React.ReactElement) => <AppProvider actor={hop()} onLogout={() => {}}>{el}</AppProvider>;

t("the picker groups items under a category heading, not one flat list", () => {
  const html = renderToString(withCtx(<GearPicker from="2026-10-01" to="2026-10-01" onConfirm={() => {}} onClose={() => {}} />));
  assert.match(html, /picker-group/);
  assert.match(html, /Camera/);
  assert.match(html, /Cabling|Audio|Lighting/);
});

t("every serialized item shows its condition, and a Details toggle when it has more to show", () => {
  const actor = hop();
  const item = getDb().equipment.find((e) => e.trackingType === "serialized")!;
  addAttachment(actor, item.id, "photo", { url: "https://example.com/photo.jpg", caption: "front" });
  const html = renderToString(withCtx(<GearPicker from="2026-10-01" to="2026-10-01" onConfirm={() => {}} onClose={() => {}} />));
  assert.match(html, /Good|Fair|Poor/);
  assert.match(html, /Details/);
});

t("the add-item form no longer marks the serial number as required", () => {
  const html = renderToString(withCtx(<ItemFormModal onClose={() => {}} onSaved={() => {}} />));
  assert.match(html, /Serial number \(optional\)/);
});

console.log(`\n${passed} passed`);
