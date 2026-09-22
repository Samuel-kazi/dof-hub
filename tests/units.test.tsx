// Run with: npx tsx tests/units.test.tsx
// Adding several identical units at once (for example three Sony FX6 bodies), on screen: the form, the confirmation, grouping and the sibling panel.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "../src/ui/AppContext";
import { ItemFormModal } from "../src/pages/EquipmentForms";
import { EquipmentItemPage } from "../src/pages/EquipmentItem";
import { Equipment } from "../src/pages/Equipment";
import { login } from "../src/services/auth";
import { resetDemoData, getDb } from "../src/data/store";
import { createSerializedUnits, getItem } from "../src/services/equipment";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", e instanceof Error ? e.message : e); process.exitCode = 1; }
};
const hop = () => login("hop@dof.demo", "demo");
const html = (el: React.ReactElement) => renderToString(<AppProvider actor={hop()} onLogout={() => {}}>{el}</AppProvider>);

t("the add-equipment form offers a list of serial numbers, not just one, for a new serialized item", () => {
  const out = html(<ItemFormModal onClose={() => {}} onSaved={() => {}} />);
  assert.match(out, /Serial number/);
  assert.match(out, /Add another unit/);
  assert.match(out, /Paste a list instead/);
});

t("editing one unit shows its own serial number and an optional label, not the multi-unit list", () => {
  const out = html(<ItemFormModal item={getItem("DOF-EQ-CAM-001")} onClose={() => {}} onSaved={() => {}} />);
  assert.match(out, /Label \(optional/);
  assert.doesNotMatch(out, /Paste a list instead/);
});

t("adding another unit of an existing model hides the category and tracking choice, and titles itself after the model", () => {
  const out = html(<ItemFormModal likeItem={getItem("DOF-EQ-CAM-001")} onClose={() => {}} onSaved={() => {}} />);
  assert.match(out, /Add another Sony FX3/);
  assert.doesNotMatch(out, /Batch of identical items/);
});

t("the inventory groups two or more units of the same make and model under one heading", () => {
  const out = html(<Equipment tab="inventory" />);
  assert.match(out, /Sony FX3/); // the two demo FX3 bodies (DOF-EQ-CAM-001, -002) group together
  assert.match(out, /2.*units/);
});

t("a camera page lists its sibling units of the same model, but not unrelated gear", () => {
  const out = html(<EquipmentItemPage id="DOF-EQ-CAM-001" />);
  assert.match(out, /Other.*Sony FX3.*units/);
  assert.match(out, /DOF-EQ-CAM-002/);
  assert.doesNotMatch(out, /DOF-EQ-CAM-003/); // the 24-70mm lens: a different model, must not appear
});

t("a one-off item shows no sibling-units panel", () => {
  const out = html(<EquipmentItemPage id="DOF-EQ-CAM-003" />); // the lens: nothing else shares its model
  assert.doesNotMatch(out, /Other .* units/);
});

t("three FX6 bodies added at once render correctly end to end: created, grouped, and cross-linked", () => {
  const made = createSerializedUnits(hop(), {
    name: "Sony FX6 camera body", make: "Sony", model: "FX6", category: "camera",
    unitCost: 6000, vendor: "B&H", condition: "Good", packaging: "Pelican 1610", accessories: "2 batteries",
    info: "", units: [{ serialNumber: "FX6-9001", label: "A-cam" }, { serialNumber: "FX6-9002", label: "B-cam" }, { serialNumber: "FX6-9003", label: "C-cam" }],
  });
  assert.equal(made.length, 3);
  const list = html(<Equipment tab="inventory" />);
  assert.match(list, /Sony FX6/);
  assert.match(list, /3.*units/);
  const page = html(<EquipmentItemPage id={made[0].id} />);
  assert.match(page, /Other.*Sony FX6.*units/);
  assert.match(page, new RegExp(made[1].id));
  assert.match(page, new RegExp(made[2].id));
  assert.match(page, /B-cam/);
  assert.match(page, /FX6-9002/);
});

console.log(`\n${passed} passed`);
