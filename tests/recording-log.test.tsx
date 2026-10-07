// Build prompt v4, section 7A: the Recording Log (one per session, in Production), storage assigned in Production with
// a backup, pickups and issues carried into Edit Notes, the one hard rule for moving to Post production, importing a
// project recorded before the system, and data version 24.
import assert from "node:assert/strict";
import React from "react";
import type { JSX } from "react";
import { renderToString } from "react-dom/server";
import type { Actor, Database } from "../src/types";
import { RuleError } from "../src/types";
import { commit, enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { toV24, v24Plan } from "../src/data/migrateV24";
import { catalogFor } from "../src/config/documentCatalog";
import { login } from "../src/services/auth";
import * as S from "../src/services/wrapped/storage";
import * as W from "../src/services/wrapped/workflow";
import { ensureChecklist } from "../src/services/workflow/common";
import { pagesOf } from "../src/services/documents/common";
import { documentOf } from "../src/services/documents/pages";
import { theologyStatus } from "../src/services/documents/theology";
import { urgencyReport } from "../src/services/urgency";
import { workflowDueSoon } from "../src/services/reminders";
import { AppProvider } from "../src/ui/AppContext";
import { SessionPage } from "../src/pages/workflow/SessionPage";
import { DrivePage } from "../src/pages/Storage";
import { ImportProjectModal } from "../src/pages/workflow/ImportProject";
import type { Project } from "../src/services/workflow";

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void, db: () => Database = () => buildWorkflowFixture()) => {
  setDb(db());
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
const throwsRule = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof RuleError && (!match || match.test(e.message)));
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");
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
const WOW = "DOF-SER-001-S1";
const R2 = `${WOW}-R02`;
const session = (id: string) => getDb().recordingSessions.find((s) => s.id === id)!;
/** Two of the season's planned episodes on a session's log, as its Recording Plan's ticks put them. */
const plan = (id: string) => {
  for (const pid of W.availableForLog(id).slice(0, 3)) W.addLogRow(hop(), id, { plannedEpisodeId: pid });
};
/** A planned session put into Production, as the gates of Pre-production are tested elsewhere. */
const open = (id: string) => {
  session(id).status = "Open";
  ensureChecklist("wrap", "session", id);
  commit();
};

await t("Production has one Recording Log tile instead of Session Log and Storage, for every kind; Pre-production has no storage", () => {
  for (const kind of ["podcast", "documentary_dof", "devotion", "music_album", "live_event"] as const) {
    const titles = catalogFor(kind, "Production").map((e) => e.title);
    assert.ok(titles.includes(kind === "live_event" ? "Show Log" : "Recording Log"), `${kind}: ${titles.join(", ")}`);
    assert.ok(!titles.includes("Session Log") && !titles.includes("Storage"), kind);
    const pre = catalogFor(kind, "Pre-production");
    assert.ok(
      !pre.some((e) => e.title === "Storage" || e.pages?.some((p) => /storage/i.test(p.title))),
      `${kind}: no storage step in Pre-production`,
    );
  }
});

await t("the log records who attended (the call sheet's crew until changed), issues, and each take's mark and length", () => {
  const s = session(R2);
  plan(R2);
  assert.deepEqual(W.attendeesOf(s), [], "no call sheet yet, no one listed");
  W.updateSession(hop(), R2, {
    attendees: ["DOF-P-CRW-001", "DOF-P-CRW-002", "DOF-P-CRW-001"],
    attendeesNote: "The choir",
    issues: "Hum on channel 2",
  });
  assert.deepEqual(W.attendeesOf(session(R2)), ["DOF-P-CRW-001", "DOF-P-CRW-002"], "each person once");
  throwsRule(() => W.updateSession(hop(), R2, { attendees: ["NOBODY"] }), /from Crew/);
  const row = W.rowsOf(R2)[0];
  W.updateLogRow(hop(), row.id, { duration: "58:10" });
  assert.equal(W.rowsOf(R2)[0].duration, "58:10");
  throwsRule(() => W.updateLogRow(hop(), row.id, { duration: "x".repeat(41) }), /short/);
  throwsRule(() => W.updateLogRow(hop(), row.id, { status: "Recorded" }), /once it is in Production/);
  ok();
});

await t(
  "storage in Production: a drive, its folders with the project's own preselected, add to a drive, a backup elsewhere, ticks, no duplicates",
  () => {
    const p = getDb().records.find((r) => r.contentId === WOW) as Project;
    // A folder for the series is on DRV-002 already; another project's too.
    const series = S.addAllocation(hop(), { driveId: "DRV-002", contentId: "DOF-SER-001", sizeGB: 100, kind: "raw", label: "Whispers" });
    series.folderPath = "Whispers of Why";
    S.addAllocation(hop(), { driveId: "DRV-002", contentId: null, sizeGB: 10, kind: "raw", label: "Old camp footage" });
    assert.deepEqual(
      W.driveFolders("DRV-002").map((f) => f.folderPath),
      ["Old camp footage", "Whispers of Why"],
    );
    assert.equal(W.bestFolder("DRV-002", p)?.allocationId, series.id, "the series' own folder is the best match");
    assert.equal(W.suggestedStorage(R2).link?.id, series.id, "exactly one place for the project: chosen for it");
    const before = getDb().allocations.length;
    const main = W.assignSessionStorage(hop(), R2, { driveId: "DRV-002", role: "primary", linkId: series.id });
    assert.equal(main.folderPath, `Whispers of Why/2026-09-26_${W.sessionName(session(R2)).replace(/\s+/g, "-")}`);
    assert.equal(session(R2).storageDriveId, "DRV-002");
    throwsRule(() => W.assignSessionStorage(hop(), R2, { driveId: "DRV-002", role: "backup", addToDrive: true }), /another drive/);
    const backup = W.assignSessionStorage(hop(), R2, { driveId: "DRV-003", role: "backup", addToDrive: true });
    assert.equal(backup.role, "backup");
    assert.equal(getDb().allocations.length, before + 3, "the session's two entries and the project's place on DRV-003");
    // Choosing again moves it, never adding a second entry.
    W.assignSessionStorage(hop(), R2, { driveId: "DRV-004", role: "backup", addToDrive: true });
    assert.equal(getDb().allocations.filter((a) => a.sessionId === R2).length, 2, "one main, one backup");
    assert.ok(W.storageWarnings(R2).every((w) => !/No drive|No backup/.test(w)));
    throwsRule(() => W.markStorage(hop(), R2, "primary", true), /once recording has started/);
    open(R2);
    W.markStorage(hop(), R2, "primary", true);
    const marked = W.sessionStorage(R2).primary!;
    assert.equal(marked.offloadedBy, "DOF-P-HOP-001");
    assert.ok(marked.offloadedAt);
    assert.ok(W.storageWarnings(R2).includes("The backup is not marked made yet"));
    S.updateDrive(hop(), "DRV-004", { offline: true });
    assert.ok(W.storageWarnings(R2).includes("Transcend 1 is marked offline"));
    // The settings' pattern names the folder.
    setDb({ ...getDb(), settings: { ...getDb().settings, storageFolderPattern: "{contentId}/{session}" } });
    assert.equal(W.folderFor(session(R2), p), `${WOW}/${R2}`);
    ok();
  },
);

await t("closing needs one item recorded; pickups and issues go to Edit Notes, once per session; the editor sees the footage", () => {
  plan(R2);
  open(R2);
  const rows = W.rowsOf(R2);
  throwsRule(() => W.closeSession(hop(), R2), /At least one item recorded/);
  W.updateLogRow(hop(), rows[0].id, { status: "Recorded" });
  W.updateLogRow(hop(), rows[1].id, { status: "Pickup needed", notesForPost: "Mic drop at 12:04" });
  W.updateSession(hop(), R2, { issues: "Camera B overheated" });
  W.assignSessionStorage(hop(), R2, { driveId: "DRV-002", role: "primary", addToDrive: true });
  const res = W.closeSession(hop(), R2);
  assert.equal(res.made.length, 2, "the rows with no take mark stay planned");
  const notes = documentOf(WOW, "Post production", "edit_notes")!;
  const page = pagesOf(notes.id).find((x) => x.title === "Pickups and issues: Session 2")!;
  assert.match(page.bodyHtml, /Mic drop at 12:04/);
  assert.match(page.bodyHtml, /Camera B overheated/);
  // Reopened, changed and closed again: the same page is rewritten, never a second one.
  W.reopenSession(hop(), R2);
  W.updateSession(hop(), R2, { issues: "Camera B overheated twice" });
  W.closeSession(hop(), R2);
  const again = pagesOf(notes.id).filter((x) => x.title === "Pickups and issues: Session 2");
  assert.equal(again.length, 1);
  assert.match(again[0].bodyHtml, /overheated twice/);
  assert.deepEqual(
    W.footageWhere(WOW).map((f) => [f.sessionId, f.role]),
    [[R2, "primary"]],
  );
  ok();
});

await t("import to Production: the folder is linked and the session's main drive, its log blank, items named there become planned", () => {
  const folder = S.addAllocation(hop(), { driveId: "DRV-005", contentId: null, sizeGB: 80, kind: "raw", label: "Revival 2024" });
  assert.deepEqual(
    W.importableFolders(hop(), "DRV-005").map((f) => f.allocationId),
    [folder.id],
  );
  const r = W.importProject(hop(), {
    allocationId: folder.id,
    category: "series",
    seriesType: "sermon",
    title: "",
    start: "Production",
    recordedOn: "2024-06-01",
  });
  const p = r.project;
  assert.equal(getDb().records.find((x) => x.contentId === p.parentId)!.title, "Revival 2024", "the series is named for the folder");
  assert.deepEqual([p.workflow.stage, p.workflow.imported, p.workflow.reviewedBeforeSystem], ["Pre-production", true, false]);
  const s = session(r.sessionId!);
  assert.deepEqual([s.status, s.scheduledDate, W.rowsOf(s.id).length], ["Open", "2024-06-01", 0]);
  const linked = getDb().allocations.find((a) => a.id === folder.id)!;
  assert.deepEqual([linked.contentId, linked.sessionId, linked.role, linked.folderPath], [p.contentId, s.id, "primary", "Revival 2024"]);
  assert.equal(getDb().allocations.filter((a) => a.driveId === "DRV-005").length, 1, "no second entry for the same folder");
  throwsRule(
    () =>
      W.importProject(hop(), { allocationId: folder.id, category: "series", seriesType: "sermon", title: "Again", start: "Production" }),
    /already belongs/,
  );
  // With no plan, what was recorded is named in the log and becomes the project's planned item.
  W.addLogRow(hop(), s.id, { itemLabel: "Night 1" });
  W.addLogRow(hop(), s.id, { itemLabel: "Night 2" });
  assert.deepEqual(
    W.plannedOf(p.contentId).map((x) => x.workingTitle),
    ["Night 1", "Night 2"],
  );
  for (const row of W.rowsOf(s.id)) W.updateLogRow(hop(), row.id, { status: "Recorded" });
  const closed = W.closeSession(hop(), s.id);
  assert.equal(closed.made.length, 2);
  ok();
});

await t(
  "import to Post production: one episode per item, no plan or greenlight asked for, its past dates history; reviewed before clears the banner",
  () => {
    const folder = S.addAllocation(hop(), { driveId: "DRV-005", contentId: null, sizeGB: 80, kind: "raw", label: "Devotions 2023" });
    const r = W.importProject(hop(), {
      allocationId: folder.id,
      category: "devotional",
      title: "Hope in Lamentations",
      start: "Post production",
      recordedOn: "2023-03-01",
      items: ["Day 1", "Day 2", "Day 3"],
    });
    assert.equal(r.sessionId, null);
    assert.equal(r.episodes.length, 3);
    const eps = r.episodes.map((id) => getDb().records.find((x) => x.contentId === id)!);
    assert.ok(
      eps.every((e) => e.parentId === r.project.contentId && e.episode?.stage === "Post production"),
      "flat, under the devotion",
    );
    // A past deadline on an imported episode is history: never overdue, never in the urgency report or reminders.
    eps[0].stageDeadlines["Post production"] = "2023-04-01";
    eps[0].assigneePersonId = "DOF-P-HOP-001";
    assert.equal(W.episodeOverdue(eps[0]), false);
    const row = urgencyReport(hop()).find((x) => x.id === r.project.contentId)!;
    assert.ok(!row.reasons.some((x) => /overdue|producer|not assigned|no recording date/i.test(x)), row.reasons.join(" | "));
    assert.ok(!workflowDueSoon("DOF-P-HOP-001").some((x) => x.contentId === eps[0].contentId));
    assert.equal(theologyStatus(r.project.contentId).done, false);
    W.setReviewedBeforeSystem(hop(), r.project.contentId, true);
    assert.deepEqual(
      [theologyStatus(r.project.contentId).done, theologyStatus(r.project.contentId).detail],
      [true, "Reviewed before the system"],
    );
    throwsRule(() => W.setReviewedBeforeSystem(hop(), WOW, true), /imported/);
    ok();
  },
);

await t(
  "data version 24: footage entries become main drives, the plan's storage page is renamed, and running it again changes nothing",
  () => {
    const db = getDb();
    db.allocations.push({
      id: "ALC-9001",
      driveId: "DRV-002",
      contentId: WOW,
      label: "Session 1 footage",
      sizeGB: 120,
      kind: "raw",
      note: "",
      updatedAt: "2026-09-19",
      sessionId: `${WOW}-R01`,
    });
    const docId = db.projectDocuments.find((d) => d.docKey === "recording_plan")?.id;
    if (docId)
      db.documentPages.push({ ...db.documentPages.find((p) => p.documentId === docId)!, id: "PG-9001", title: "Cards and storage" });
    const lines = v24Plan(db);
    assert.ok(
      lines.some((l) => /1 session footage entry/.test(l)),
      lines.join(" | "),
    );
    assert.equal(db.allocations.find((a) => a.id === "ALC-9001")!.role, undefined, "the dry run changes nothing");
    const first = toV24(db);
    assert.ok(first.changed);
    assert.equal(db.allocations.find((a) => a.id === "ALC-9001")!.role, "primary");
    if (docId) assert.equal(db.documentPages.find((p) => p.id === "PG-9001")!.title, "Cards");
    const copy = structuredClone(db);
    assert.equal(toV24(db).changed, false);
    assert.deepEqual(db, copy);
  },
);

await t("screens: the session's Recording Log, the Storage page's Import as project, the import dialog", () => {
  plan(R2);
  open(R2);
  const page = html(hop(), <SessionPage id={R2} />);
  for (const text of [
    "Recording Log",
    "Session details",
    "Who attended",
    "What was recorded",
    "Take mark",
    "Length",
    "Issues and pickups",
    "Storage and backup",
    "Footage drive",
    "Backup drive",
  ])
    assert.ok(page.includes(text), text);
  assert.ok(page.includes(">Good<") && page.includes(">Re-record<"), "the take marks");
  S.addAllocation(hop(), { driveId: "DRV-005", contentId: null, sizeGB: 80, kind: "raw", label: "Revival 2024" });
  const drive = html(hop(), <DrivePage id="DRV-005" />);
  assert.ok(drive.includes("Import as project") && drive.includes("Mark offline"));
  const dialog = html(hop(), <ImportProjectModal onClose={() => {}} />);
  for (const text of ["Import existing project", "Where does it start?", "Post production", "Reviewed before the system"])
    assert.ok(dialog.includes(text), text);
});

console.log(`\n${passed} passed`);
