// Run with: npm test -- workflow-model
// Phase 1 of the five-stage workflow: its configuration, its data and the rules the data keeps, its IDs, dates
// in Nairobi time, and changes that are all or nothing. Services, screens and moving old projects across come
// in later phases.
import assert from "node:assert/strict";
import type { Database } from "../src/types";
import { RuleError } from "../src/types";
import { CATEGORIES, categoryOf } from "../src/config/categories";
import { CHECKLISTS, FORM_TYPES, WORKFLOW_STAGES, isWorkflowCategory } from "../src/config/workflow";
import { DOCUMENT_PARTS, WORKFLOW_PARTS, integrityProblems, uniqueViolations } from "../src/data/constraints";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { buildSeed } from "../src/data/seed";
import { upgradeDb, CURRENT_SCHEMA, commit, enableRollback, getDb, setDb, transaction } from "../src/data/store";
import { upgradeToV15, upgradeToV16, upgradeToV17, upgradeToV18 } from "../src/data/migrate";
import { codeNumber, episodeCode, episodeCounter, plannedEpisodeId, plannedCounter, sessionCode, sessionCounter } from "../src/data/ids";
import { addDaysIso, dateInNairobi, hoursUntilEndOfDay, isIsoDate, todayIso } from "../src/services/utils";

let passed = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 3).join("\n     "));
    process.exitCode = 1;
  }
};
const fixture = (through?: "development" | "session1"): Database => buildWorkflowFixture({ through });
const WOW = "DOF-SER-001-S1";

// ── Configuration ────────────────────────────────────────────

t("five stages, in order, each tracked at the level the brief gives", () => {
  assert.deepEqual(
    WORKFLOW_STAGES.map((s) => [s.name, s.level]),
    [
      ["Development", "project"],
      ["Pre-production", "project"],
      ["Production", "session"],
      ["Post production", "episode"],
      ["Marketing and distribution", "episode"],
    ],
  );
});

t("series, devotions and documentaries use the workflow; Live Shows, Music and General Use do not, and their stages are unchanged", () => {
  assert.deepEqual(
    CATEGORIES.filter((c) => c.workflow).map((c) => c.key),
    ["series", "devotional", "documentary"],
  );
  for (const c of CATEGORIES) assert.equal(isWorkflowCategory(c.key), !!c.workflow);
  assert.deepEqual(
    categoryOf("live").stages.map((s) => s.name),
    ["Prep", "Build", "Rehearse", "Show", "Wrap", "Review", "Post Production"],
  );
  assert.deepEqual(
    categoryOf("music").stages.map((s) => s.name),
    ["Idea", "Pre-production", "Recording", "Audio post-production", "Video editing", "Review", "Publish"],
  );
  assert.deepEqual(
    categoryOf("general").stages.map((s) => s.name),
    ["In use"],
  );
  assert.deepEqual(
    CATEGORIES.map((c) => c.color),
    ["#e8703a", "#7fbf95", "#f3b943", "#8f9fdc", "#d58fb8", "#8a8a92"],
    "every category keeps its colour",
  );
});

t("each category's projects and episodes sit at the right level, and every form type belongs to one category", () => {
  assert.deepEqual(categoryOf("series").workflow, {
    projectLevel: 1,
    projectLabel: "Season",
    episodeLevel: 2,
    episodeLabel: "Episode",
    formTypes: ["podcast", "testimonial", "sermon"],
  });
  for (const key of ["devotional", "documentary"] as const) {
    const w = categoryOf(key).workflow!;
    assert.deepEqual([w.projectLevel, w.episodeLevel], [0, 1]);
  }
  for (const f of FORM_TYPES) assert.ok(categoryOf(f.category).workflow!.formTypes.includes(f.key), f.key);
  assert.equal(FORM_TYPES.find((f) => f.key === "documentary_dof")!.greenlights, 2, "a DOF-made documentary is greenlit twice");
  assert.ok(FORM_TYPES.find((f) => f.key === "documentary_pitched")!.outcomes.includes("Advice only"));
  assert.ok(!FORM_TYPES.find((f) => f.key === "podcast")!.outcomes.includes("Advice only"));
});

t("the wrap checklist has every item the brief lists, all required", () => {
  assert.equal(CHECKLISTS.wrap.items.length, 14);
  assert.ok(CHECKLISTS.wrap.items.every((i) => i.required));
  assert.ok(
    CHECKLISTS.post.items.every((i) => !i.required),
    "the post work items are tracked; the gate is the editor's ready and the reviews",
  );
  assert.deepEqual(
    CHECKLISTS.post.items.filter((i) => i.group).map((i) => i.key),
    ["story_lock", "picture_lock", "color", "sound_mix", "graphics"],
  );
});

// ── IDs ──────────────────────────────────────────────────────

t("sessions, planned episodes and episodes are numbered from the project's own Content ID, at least two digits", () => {
  assert.equal(sessionCode(WOW, 1), "DOF-SER-001-S1-R01");
  assert.equal(plannedEpisodeId(WOW, 7), "DOF-SER-001-S1-P07");
  assert.equal(episodeCode(WOW, 12), "DOF-SER-001-S1-E12");
  assert.equal(episodeCode("DOF-DEV-001", 100), "DOF-DEV-001-E100");
  assert.equal(codeNumber("DOF-SER-001-S1-E12", WOW, "E"), 12);
  assert.ok(Number.isNaN(codeNumber("DOF-SER-001-S2-E12", WOW, "E")), "an episode of another project");
  assert.equal(episodeCounter(WOW), "record:DOF-SER-001-S1", "episodes continue the numbering of episodes made before the workflow");
});

// ── The fixture ──────────────────────────────────────────────

t("the Whispers of Why fixture, fresh from Development: 30 planned episodes and nothing made yet", () => {
  const db = fixture("development");
  assert.deepEqual(integrityProblems(db), []);
  const season = db.records.find((r) => r.contentId === WOW)!;
  assert.equal(season.workflow?.stage, "Development");
  assert.equal(season.workflow?.showProducerId, null);
  assert.equal(db.plannedEpisodes.filter((p) => p.contentId === WOW).length, 30);
  assert.ok(db.plannedEpisodes.filter((p) => p.contentId === WOW).every((p) => p.details.targetMinutes === "58"));
  assert.equal(db.recordingSessions.length, 0);
  assert.equal(db.records.filter((r) => r.episode).length, 0, "no real episode exists until a session closes");
  assert.equal(db.counters[plannedCounter(WOW)], 30);
});

t("the fixture after session 1: four episodes from five rows, notes carried over, counters in step", () => {
  const db = fixture();
  assert.deepEqual(integrityProblems(db), []);
  assert.equal(db.recordingSessions.filter((s) => s.contentId === WOW).length, 6);
  const r01 = db.recordingSessions.find((s) => s.id === `${WOW}-R01`)!;
  assert.equal(r01.status, "Closed");
  const rows = db.sessionLogEntries.filter((e) => e.sessionId === r01.id);
  assert.deepEqual(
    rows.map((e) => e.status),
    ["Recorded", "Recorded", "Pickup needed", "Not recorded", "Recorded"],
  );
  const eps = db.records.filter((r) => r.episode && r.parentId === WOW);
  assert.deepEqual(
    eps.map((r) => r.contentId),
    ["DOF-SER-001-S1-E01", "DOF-SER-001-S1-E02", "DOF-SER-001-S1-E03", "DOF-SER-001-S1-E04"],
  );
  assert.deepEqual(
    eps.map((r) => r.episode!.plannedEpisodeId),
    ["DOF-SER-001-S1-P01", "DOF-SER-001-S1-P02", "DOF-SER-001-S1-P03", "DOF-SER-001-S1-P05"],
    "the Not recorded episode (P04) made nothing and stays planned",
  );
  assert.match(eps[2].episode!.productionNotes, /Pickup booked for \d{4}-\d{2}-\d{2}/, "the pickup's dated note is carried over");
  assert.ok(eps.every((r) => r.episode!.sourceSessionId === r01.id && r.hierarchyLevel === 2));
  assert.equal(db.reviewCheckpoints.filter((c) => c.episodeId).length, 8, "rough cut and final for each episode");
  assert.deepEqual([db.counters[sessionCounter(WOW)], db.counters[episodeCounter(WOW)]], [6, 4]);
});

// ── The data's rules ─────────────────────────────────────────

t("uniqueness: a planned episode number, an exclusive role, a log row per episode, an episode number, a share token", () => {
  const db = fixture();
  const again = <T>(list: T[], i: number, patch: Partial<T>): T[] => [...list, { ...list[i], ...patch }];
  assert.deepEqual(uniqueViolations("plannedEpisodes", again(db.plannedEpisodes, 0, { id: "x" })), [
    "That episode number is already planned for this project.",
  ]);
  const director = db.projectRoles.findIndex((r) => r.roleKey === "director");
  assert.equal(uniqueViolations("projectRoles", again(db.projectRoles, director, { id: "x", crewId: "DOF-P-CRW-002" })).length, 1);
  const host = db.projectRoles.findIndex((r) => r.roleKey === "host_guest");
  assert.deepEqual(
    uniqueViolations("projectRoles", again(db.projectRoles, host, { id: "x", guestName: "Another guest" })),
    [],
    "many hosts and guests",
  );
  assert.equal(uniqueViolations("sessionLogEntries", again(db.sessionLogEntries, 0, { id: "x" })).length, 1);
  assert.deepEqual(
    uniqueViolations("sessionLogEntries", [
      ...db.sessionLogEntries,
      { ...db.sessionLogEntries[0], id: "i1", plannedEpisodeId: null, itemLabel: "Interview set A" },
      { ...db.sessionLogEntries[0], id: "i2", plannedEpisodeId: null, itemLabel: "Interview set B" },
    ]),
    [],
    "a documentary's free-form rows have no planned episode, and there can be many",
  );
  const ep = db.records.findIndex((r) => r.episode);
  assert.equal(uniqueViolations("records", again(db.records, ep, { contentId: "DOF-SER-001-S1-E99" })).length, 1);
  assert.equal(uniqueViolations("shareLinks", again(db.shareLinks, 0, { id: "x" })).length, 1);
});

t("references: everything the workflow's data points at must exist, and a log row's episode must be of the session's project", () => {
  const broken = (change: (db: Database) => void): string[] => {
    const db = fixture();
    change(db);
    return integrityProblems(db);
  };
  assert.match(broken((db) => (db.sessionLogEntries[0].sessionId = "NOPE-R01"))[0], /session NOPE-R01/);
  assert.match(broken((db) => (db.recordingSessions[0].callSheetId = "DOF-CS-999"))[0], /call sheet DOF-CS-999/);
  assert.match(broken((db) => (db.reviewCheckpoints[0].reviewerIds = ["DOF-P-CRW-999"]))[0], /person DOF-P-CRW-999/);
  assert.match(broken((db) => (db.shareLinks[0].episodeId = "DOF-SER-001-S1-E77"))[0], /episode DOF-SER-001-S1-E77/);
  assert.match(
    broken((db) => (db.sessionLogEntries[0].plannedEpisodeId = "DOF-DEV-001-P01"))[0],
    /different project/,
    "a devotion's day cannot be logged in a podcast's session",
  );
  assert.match(
    broken((db) => {
      const r = db.projectRoles.find((x) => x.roleKey === "editor")!;
      r.exclusive = false;
    })[0],
    /only hosts, guests and roles added by hand/,
  );
  assert.match(
    broken((db) => (db.records.find((r) => r.contentId === WOW)!.workflow!.showProducerId = "DOF-P-CRW-999"))[0],
    /person DOF-P-CRW-999/,
  );
});

// ── Dates in Nairobi ─────────────────────────────────────────

t("the date is Nairobi's, around midnight, wherever the code runs", () => {
  assert.equal(dateInNairobi(new Date("2026-09-25T20:59:59Z")), "2026-09-25", "23:59:59 in Nairobi");
  assert.equal(dateInNairobi(new Date("2026-09-25T21:00:00Z")), "2026-09-26", "00:00 in Nairobi, still the 25th in UTC");
  assert.equal(dateInNairobi(new Date("2026-12-31T22:30:00Z")), "2027-01-01", "New Year in Nairobi first");
  const tz = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = zone; // Node applies this at once, as a server or a laptop abroad would see it
      assert.equal(todayIso(), "2026-09-26", `today is Nairobi's in ${zone}`);
      const h = hoursUntilEndOfDay("2026-09-26");
      assert.ok(h > 14.9 && h < 15.1, `a deadline today ends at midnight in Nairobi, in ${zone} (${h.toFixed(2)} h)`);
    }
  } finally {
    process.env.TZ = tz;
  }
});

t("date arithmetic is by the calendar: months, years and leap days", () => {
  assert.equal(addDaysIso("2026-01-31", 1), "2026-02-01");
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysIso("2028-02-28", 1), "2028-02-29");
  assert.equal(addDaysIso("2026-03-01", -1), "2026-02-28");
  assert.ok(isIsoDate("2028-02-29"));
  for (const bad of ["2026-02-30", "2026-13-01", "26-09-26", "2026-09-26T09:00", "", null]) assert.ok(!isIsoDate(bad), String(bad));
});

// ── Saved data from before the workflow ──────────────────────

t("upgrading to versions 15 to 18 adds the workflow's and the documents' lists and fields, changes nothing else, and can run twice", () => {
  const old = buildSeed() as unknown as Record<string, unknown>;
  for (const k of WORKFLOW_PARTS) delete old[k];
  for (const r of old.records as Record<string, unknown>[]) {
    delete r.seriesType;
    delete r.workflow;
    delete r.episode;
  }
  old.schemaVersion = 14;
  const before = JSON.stringify(old);
  const up = upgradeDb(JSON.parse(before) as Database)!;
  assert.equal(up.schemaVersion, CURRENT_SCHEMA);
  assert.equal(CURRENT_SCHEMA, 18);
  for (const k of [...WORKFLOW_PARTS, ...DOCUMENT_PARTS]) assert.deepEqual(up[k], []);
  const was = JSON.parse(before) as Database;
  assert.deepEqual(
    up.records.map(({ seriesType, workflow, episode, ...rest }) => [rest, seriesType, workflow, episode]),
    was.records.map((r) => [r, null, null, null]),
    "every record is exactly as it was, plus three empty fields",
  );
  const twice = JSON.stringify(upgradeToV18(upgradeToV17(upgradeToV16(upgradeToV15(structuredClone(up))))));
  assert.equal(twice, JSON.stringify(up), "running it again changes nothing");
  assert.equal(upgradeDb(up), up, "data already at the current version is left alone");
  assert.equal(upgradeDb({ ...up, schemaVersion: 99 }), null, "a version this app does not know is refused, not guessed at");
});

t("upgrading to version 17 moves every workflow project's Development form into its documents, once, and drops the old setting", () => {
  const old = fixture() as Database & { settings: { newDocuments?: string[] } };
  old.settings.newDocuments = ["series"];
  old.schemaVersion = 16;
  const formsBefore = JSON.stringify(old.developmentForms);
  const up = upgradeDb(structuredClone(old))!;
  assert.equal(up.schemaVersion, 18);
  assert.equal("newDocuments" in up.settings, false, "the setting is gone");
  for (const [id, key] of [
    ["DOF-SER-001-S1", "show_brief"],
    ["DOF-DEV-001", "devotional_script"],
    ["DOF-DOC-001", "documentary_brief"],
  ])
    assert.ok(
      up.projectDocuments.some((d) => d.id === `${id}|Development|${key}` && d.migrated),
      `${id}: its ${key}, made by the move`,
    );
  assert.equal(JSON.stringify(up.developmentForms), formsBefore, "the old forms are left exactly as they were");
  assert.equal(up.audit.filter((a) => a.action === "migrate-documents" && a.byPersonId === "system").length, 1);
  const again = JSON.stringify(upgradeToV18(upgradeToV17(structuredClone(up))));
  assert.equal(again, JSON.stringify(up), "running it again changes nothing");
  assert.deepEqual(integrityProblems(up), []);
});

t("upgrading to version 18 gives a devotion's call sheets their sessions in its Recording Plan, keeping each sheet as it was", () => {
  const old = fixture();
  const dev = old.records.find((r) => r.contentId === "DOF-DEV-001")!;
  Object.assign(dev.workflow!, { stage: "Pre-production", status: "Active" });
  const sheet = {
    ...structuredClone(old.callSheets[0]),
    id: "DOF-CS-900",
    contentId: "DOF-DEV-001",
    title: "Devotion day",
    date: "2026-11-02",
    location: "Studio B",
    runOfShow: [{ id: "RS-1", time: "08:00", title: "Crew call", durationMin: 0, ownerPersonId: null, notes: "" }],
  };
  old.callSheets.push(sheet);
  const sheetBefore = JSON.stringify(sheet);
  for (const s of old.recordingSessions) {
    for (const k of ["name", "label", "startTime", "endTime", "storyboardId", "shotListId", "storageDriveId"])
      delete (s as unknown as Record<string, unknown>)[k];
  }
  for (const r of old.projectRoles) {
    delete r.label;
    delete r.position;
  }
  old.schemaVersion = 17;
  const up = upgradeDb(structuredClone(old))!;
  assert.equal(up.schemaVersion, 18);
  const made = up.recordingSessions.filter((s) => s.contentId === "DOF-DEV-001");
  assert.equal(made.length, 1, "one session for the sheet");
  const [s] = made;
  assert.deepEqual(
    [s.id, s.scheduledDate, s.venue, s.callSheetId, s.name, s.status, s.fromCallSheet, s.runSheet.map((i) => i.title)],
    ["DOF-DEV-001-R01", "2026-11-02", "Studio B", "DOF-CS-900", "Devotion day", "Planned", true, ["Crew call"]],
  );
  assert.equal(JSON.stringify(up.callSheets.find((c) => c.id === "DOF-CS-900")), sheetBefore, "the sheet itself is unchanged");
  assert.ok(
    up.workflowChecklistItems.some((c) => c.ownerId === s.id && c.ownerType === "session"),
    "the session has its pre-session checklist",
  );
  assert.equal(up.sessionLogEntries.filter((e) => e.sessionId === s.id).length, 0, "no devotion is guessed onto it");
  assert.ok(up.audit.some((a) => a.action === "migrate-call-sheets" && a.detail.includes("DOF-DEV-001-R01 from DOF-CS-900")));
  // Every session has the new fields, empty; roles their order.
  for (const x of up.recordingSessions) assert.equal(x.storageDriveId, null);
  for (const r of up.projectRoles) assert.equal(typeof r.position, "number");
  const again = JSON.stringify(upgradeToV18(structuredClone(up)));
  assert.equal(again, JSON.stringify(up), "running it again changes nothing");
  assert.deepEqual(integrityProblems(up), []);
  // A devotion still in Development, or a series, keeps its sheets as they are.
  const series = fixture();
  series.schemaVersion = 17;
  const sessionsBefore = series.recordingSessions.length;
  assert.equal(upgradeDb(series)!.recordingSessions.length, sessionsBefore);
});

// ── All or nothing ───────────────────────────────────────────

t("a change that fails part way leaves the data exactly as it was, even after a save inside it", () => {
  setDb(fixture());
  enableRollback();
  const before = JSON.stringify(getDb());
  assert.throws(() =>
    transaction(() => {
      getDb().records[0].title = "Changed";
      commit();
      getDb().plannedEpisodes.splice(0, 5);
      throw new RuleError("Something was wrong.");
    }),
  );
  assert.equal(JSON.stringify(getDb()), before);
});

t("a change that would break the data's rules is refused whole on this device", () => {
  setDb(fixture());
  enableRollback();
  const before = JSON.stringify(getDb());
  assert.throws(
    () =>
      transaction(() => {
        getDb().records[0].title = "Changed";
        getDb().plannedEpisodes.push({ ...getDb().plannedEpisodes[0], id: "DOF-SER-001-S1-P99" }); // the number of P01, again
        commit();
      }),
    (e) => e instanceof RuleError && /already planned/.test(e.message),
  );
  assert.equal(JSON.stringify(getDb()), before);
});

t("a change that succeeds is saved once, at the end", () => {
  setDb(fixture());
  enableRollback();
  transaction(() => {
    getDb().records[0].title = "Whispers of Why (renamed)";
    commit();
    getDb().records[1].title = "Season One";
    commit();
  });
  assert.deepEqual(
    getDb()
      .records.slice(0, 2)
      .map((r) => [r.contentId, r.title]),
    [
      ["DOF-SER-001", "Whispers of Why (renamed)"],
      ["DOF-SER-001-S1", "Season One"],
    ],
    "renaming changes the title, never the Content ID",
  );
  assert.equal(getDb().plannedEpisodes[0].id, "DOF-SER-001-S1-P01");
});

console.log(`\n${passed} passed`);
