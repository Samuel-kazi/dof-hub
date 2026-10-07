// Run with: npm test -- shell-keyboard
// The rework's shell (build prompt v2, Phase 2): the switch for it, the side menu without Settings and the profile
// menu, Ctrl+K's search and commands, a call sheet open to edit until Post production and locked after, and the
// confirmations that need a click or Ctrl+Enter. The keys themselves are walked through in a browser (e2e).
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { login } from "../src/services/auth";
import * as CS from "../src/services/wrapped/callsheets";
import * as P from "../src/services/wrapped/production";
import * as W from "../src/services/wrapped/workflow";
import { createLoan } from "../src/services/wrapped/lending";
import { featureOn, pipelineCategories, setFeature } from "../src/services/wrapped/settings";
import { daysOfEvent as daysOfShow, sheetOfDay } from "../src/services/production";
import { searchAll, KIND_LABEL } from "../src/services/search";
import { sheetLock } from "../src/services/sheetLock";
import { AppProvider } from "../src/ui/AppContext";
import { Shell } from "../src/ui/Shell";
import { CommandPalette } from "../src/ui/CommandPalette";
import { Modal } from "../src/ui/Modal";
import { CallSheetPage } from "../src/pages/CallSheets";

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  setDb(buildWorkflowFixture());
  enableRollback();
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     "));
    process.exitCode = 1;
  }
};
const hop = (): Actor => login("hop@dof.demo", "demo");
const crew = (n: number): Actor => login(`crew${n}@dof.demo`, "demo");
const vol = (): Actor => login("volunteer1@dof.demo", "demo");
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof RuleError && (!match || match.test(e.message)));
const html = (who: Actor, el: JSX.Element): string =>
  renderToString(
    <AppProvider actor={who} onLogout={() => {}}>
      {el}
    </AppProvider>,
  )
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

// ── The switch ───────────────────────────────────────────────

await t("the new shell ships on; only the Head of Production switches it, and switching changes no data", () => {
  assert.equal(featureOn("shell"), true);
  const before = JSON.stringify({ ...getDb(), settings: undefined, audit: undefined });
  throwsRule(() => setFeature(crew(2), "shell", false), /Only the Head of Production/);
  setFeature(hop(), "shell", false);
  assert.equal(featureOn("shell"), false);
  assert.equal(JSON.stringify({ ...getDb(), settings: undefined, audit: undefined }), before, "nothing but the switch changed");
  setFeature(hop(), "shell", true);
  assert.equal(featureOn("shell"), true);
});

await t("General Use leaves the pipeline with lending on, and comes back with it off", () => {
  assert.ok(!pipelineCategories().some((c) => c.key === "general"), "lending replaces General Use");
  setFeature(hop(), "lending", false);
  assert.ok(
    pipelineCategories().some((c) => c.key === "general"),
    "with lending off, gear can go out on General Use again",
  );
});

await t("with the shell on: no Settings in the side menu, a profile menu and a search button; off, as before", () => {
  const on = html(hop(), <Shell />);
  assert.ok(on.includes("profile menu"), "the name opens the profile menu");
  assert.ok(on.includes("Search and commands (Ctrl+K)"), "the search button names its keys");
  assert.ok(!on.includes('aria-label="Sign out"'), "sign out is in the profile menu");
  assert.ok(!/<button[^>]*>(?:(?!<\/button>).)*>Settings</.test(on), "Settings is not in the side menu");
  setFeature(hop(), "shell", false);
  const off = html(hop(), <Shell />);
  assert.ok(off.includes('aria-label="Sign out"'));
  assert.ok(!off.includes("Search and commands"));
  assert.ok(off.includes(">Settings<"), "Settings is back in the side menu");
});

// ── Ctrl+K ───────────────────────────────────────────────────

await t("search finds projects and episodes apart, each opening where it lives", () => {
  const hits = searchAll(hop(), "why", 10);
  const ep = hits.find((h) => h.id === "DOF-SER-001-S1-E01")!;
  assert.equal(ep.kind, "episode");
  assert.deepEqual(ep.open, { n: "record", id: "DOF-SER-001-S1-E01" });
  assert.equal(KIND_LABEL[ep.kind], "Episode");
  const project = searchAll(hop(), "DOF-SER-001-S1", 10).find((h) => h.id === "DOF-SER-001-S1")!;
  assert.equal(project.kind, "project");
});

await t("search finds a project's documents, by their title or their project's", () => {
  const at = new Date().toISOString();
  getDb().projectDocuments.push({
    id: "DOC-TEST-1",
    contentId: "DOF-SER-001-S1",
    stage: "Development",
    docKey: "brief",
    ownerId: null,
    title: "Show Brief",
    migrated: false,
    createdAt: at,
    updatedAt: at,
  });
  commit();
  const hit = searchAll(hop(), "show brief").find((h) => h.kind === "document")!;
  assert.equal(hit.id, "DOC-TEST-1");
  assert.deepEqual(hit.open, { n: "record", id: "DOF-SER-001-S1" });
  assert.equal(searchAll(vol(), "show brief").filter((h) => h.kind === "document").length, 0, "only on projects they may see");
});

await t("crew are found by those who may see the People page, by name, without contact details", () => {
  const hit = searchAll(hop(), "brian").find((h) => h.kind === "person")!;
  assert.equal(hit.id, "DOF-P-CRW-002");
  assert.deepEqual(hit.open, { n: "person", id: "DOF-P-CRW-002" });
  assert.ok(!hit.sub.includes("@"), "no email in the result");
  assert.ok(searchAll(crew(3), "brian").some((h) => h.kind === "person"));
  assert.equal(searchAll(vol(), "brian").filter((h) => h.kind === "person").length, 0);
});

await t("loans are found by the borrower, their organisation or the loan's number, by those who use the gear", () => {
  const loan = createLoan(hop(), {
    borrowerName: "Pastor Otieno",
    organisation: "Kibera SDA",
    dateOut: "2026-09-26",
    expectedReturn: "2026-09-28",
    lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }],
  });
  for (const q of ["otieno", "kibera", loan.id])
    assert.ok(
      searchAll(crew(2), q).some((h) => h.kind === "loan" && h.id === loan.id),
      q,
    );
  const hit = searchAll(crew(2), "kibera").find((h) => h.kind === "loan")!;
  assert.match(hit.sub, /due back/);
  assert.equal(searchAll(vol(), "kibera").filter((h) => h.kind === "loan").length, 0, "volunteers never see loans");
});

await t("the palette lists its commands and a search box; a volunteer gets no Equipment command", () => {
  const box = html(hop(), <CommandPalette onClose={() => {}} />);
  for (const text of [
    "Search and commands",
    "Search everything",
    "Open the Calendar",
    "Open Call Sheets",
    "Open Equipment",
    "Open Settings",
    "Ctrl+,",
  ])
    assert.ok(box.includes(text), text);
  assert.ok(box.includes("New loan"), "lending is on");
  assert.ok(!html(vol(), <CommandPalette onClose={() => {}} />).includes("Open Equipment"));
});

await t("the palette offers to print today's run sheet for each sheet dated today", () => {
  const show = P.createProduction(hop(), { title: "Morning Rally", mode: "one_time", date: "2026-09-26" });
  const cs = sheetOfDay(daysOfShow(show.contentId)[0])!;
  const box = html(hop(), <CommandPalette onClose={() => {}} />);
  assert.ok(box.includes("Print today's run sheet"));
  assert.ok(box.includes(cs.title));
});

// ── Dialogs ──────────────────────────────────────────────────

await t("a dialog's buttons sit in its own actions row, where Enter looks for the main one (a dialog inside it keeps its own)", () => {
  const out = html(
    hop(),
    <Modal title="Rename" onClose={() => {}} actions={<button className="btn primary">Save</button>}>
      <input aria-label="Name" />
    </Modal>,
  );
  assert.match(
    out,
    /role="dialog"[^>]*><h2>Rename<\/h2><input aria-label="Name"\/><div class="actions"><button class="btn primary">Save<\/button><\/div><\/div>/,
  );
});

// ── A call sheet: open until Post production ─────────────────

await t("a published sheet stays open to edit and offers Back to draft; once locked, the page says why and offers nothing", () => {
  const s2 = getDb().recordingSessions.find((s) => s.contentId === "DOF-SER-001-S1" && s.sessionNumber === 2)!;
  const sheet = W.createSessionCallSheet(hop(), s2.id);
  CS.updateCallSheet(hop(), sheet.id, { location: "DOF Studio A", crewPersonIds: ["DOF-P-CRW-002"], crewLeadId: "DOF-P-CRW-002" });
  CS.finalizeCallSheet(hop(), sheet.id);
  CS.updateCallSheet(hop(), sheet.id, { notes: "Changed after publishing" });
  const open = html(hop(), <CallSheetPage id={sheet.id} />);
  assert.ok(open.includes("Back to draft"));
  assert.ok(!open.includes(">Locked<"));
  getDb().recordingSessions.find((s) => s.id === s2.id)!.status = "Closed";
  commit();
  const cs = getDb().callSheets.find((c) => c.id === sheet.id)!;
  assert.equal(sheetLock(cs).locked, true);
  const locked = html(hop(), <CallSheetPage id={sheet.id} />);
  assert.ok(locked.includes(">Locked<"));
  assert.ok(locked.includes("is closed: its episodes are in Post production."));
  assert.ok(!locked.includes("Back to draft") && !locked.includes(">Finalize<"), "nothing to publish or take back");
  assert.ok(!locked.includes("+ Segment"), "no rows to add");
});

await t("a show day's sheet locks once the day is closed, and a sheet linked to nothing never locks", () => {
  const show = P.createProduction(hop(), { title: "Rally", mode: "one_time", date: "2026-10-20" });
  const day = daysOfShow(show.contentId)[0];
  const cs = sheetOfDay(day)!;
  const s = () => getDb().recordingSessions.find((x) => x.id === day.id)!;
  s().status = "Open";
  commit();
  assert.equal(sheetLock(getDb().callSheets.find((c) => c.id === cs.id)!).locked, false, "open on the day itself");
  s().status = "Closed";
  commit();
  assert.match(sheetLock(getDb().callSheets.find((c) => c.id === cs.id)!).why, /is closed: what it recorded is in Post production/);
  const loose = CS.createCallSheet(hop(), { contentId: "DOF-SER-001", title: "Loose", date: "2026-10-01" });
  assert.deepEqual(loose.linkedEpisodeIds, []);
  assert.equal(sheetLock(loose).locked, false);
});

console.log(`\n${passed} passed`);
