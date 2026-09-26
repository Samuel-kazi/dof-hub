// Run with: npx tsx tests/routing.test.ts
import assert from "node:assert/strict";
import type { Route } from "../src/ui/AppContext";
import { decodeRoute, encodeRoute } from "../src/ui/routeLink";

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};

// Round-trips: every route encodes to a path and decodes back to the same route.
const ROUTES: Route[] = [
  { n: "dashboard" },
  { n: "pipeline" },
  { n: "pipeline", category: "music" },
  { n: "record", id: "DOF-SER-001" },
  { n: "callsheets" },
  { n: "callsheet", id: "DOF-CS-001" },
  { n: "crew" },
  { n: "crew", tab: "volunteers" },
  { n: "person", id: "DOF-P-CRW-001" },
  { n: "equipment" },
  { n: "equipment", tab: "checkouts" },
  { n: "item", id: "DOF-EQ-CAM-001" },
  { n: "manifest", id: "DOF-MF-001" },
  { n: "documents" },
  { n: "doc", id: "DOF-DCS-001" },
  { n: "storage" },
  { n: "drive", id: "DRV-001" },
  { n: "access" },
  { n: "reminders" },
  { n: "calendar" },
  { n: "settings" },
];
for (const r of ROUTES) {
  t(`round-trips ${JSON.stringify(r)}`, () => assert.deepEqual(decodeRoute(encodeRoute(r)), r));
}

t("a Content ID with special characters survives the round trip", () => {
  const r: Route = { n: "record", id: "DOF-SER-001/weird id?" };
  assert.deepEqual(decodeRoute(encodeRoute(r)), r);
});
t("an empty path is the dashboard", () => assert.deepEqual(decodeRoute(""), { n: "dashboard" }));
t("a completely unknown path falls back to the dashboard, rather than crashing", () => {
  assert.deepEqual(decodeRoute("/nonsense/does-not-exist"), { n: "dashboard" });
});
t("a bad pipeline category is dropped, not trusted, so the board just opens unfiltered", () => {
  assert.deepEqual(decodeRoute("/pipeline/not-a-real-category"), { n: "pipeline" });
});
t("a bad crew or equipment tab is dropped the same way", () => {
  assert.deepEqual(decodeRoute("/crew/nonsense"), { n: "crew" });
  assert.deepEqual(decodeRoute("/equipment/nonsense"), { n: "equipment" });
});
t("a route missing its required id falls back to the nearest list page", () => {
  assert.deepEqual(decodeRoute("/record"), { n: "dashboard" });
  assert.deepEqual(decodeRoute("/item"), { n: "equipment" });
  assert.deepEqual(decodeRoute("/doc"), { n: "documents" });
  assert.deepEqual(decodeRoute("/drive"), { n: "storage" });
});

console.log(`\n${passed} passed`);
