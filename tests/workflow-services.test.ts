// Run with: npm test -- workflow-services
// Phase 2 of the five-stage workflow: its services and rules, in-process (the way the desktop app and the demo
// run them, through the same wrappers the screens use). The same walk runs against the server over HTTP in
// tests/workflow-http.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Actor, Database, FormType } from "../src/types";
import { RuleError } from "../src/types";
import { enableRollback, getDb, resetDemoData, transaction } from "../src/data/store";
import { expectIds } from "../src/data/ids";
import { integrityProblems } from "../src/data/constraints";
import { login } from "../src/services/auth";
import { addDaysIso, todayIso } from "../src/services/utils";
import { asWebUrl } from "../src/services/urls";
import * as W from "../src/services/wrapped/workflow";
import * as C from "../src/services/wrapped/content";
import * as CS from "../src/services/wrapped/callsheets";
import * as EQ from "../src/services/wrapped/equipment";
import * as D from "../src/services/wrapped/documents";
import { CHECKLISTS } from "../src/config/workflow";
import { DEV_FORMS } from "../src/config/devForms";
import {
  approveBrief,
  completeForm,
  fillSection,
  prepareSession,
  tickAll,
  walkWhispersOfWhy,
  PRODUCER,
  type Call,
} from "./support/wow-walkthrough";

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  resetDemoData();
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
const modules: Record<string, Record<string, unknown>> = { workflow: W, content: C, callsheets: CS, equipment: EQ, documents: D };

/** Calls a service as someone, through the wrappers the screens use, as the walkthrough expects. */
const as =
  (who: () => Actor): Call =>
  async (name, ...args) => {
    const [m, n] = name.split(".");
    return (modules[m][n] as (...a: unknown[]) => unknown)(who(), ...args);
  };
const call = as(hop);
const read = async (): Promise<Database> => getDb();
const throwsRule = async (fn: () => unknown, match?: RegExp) =>
  assert.rejects(
    async () => fn(),
    (e) => (e instanceof RuleError && (!match || match.test(e.message))) || assert.fail(`${(e as Error).message}`),
  );
const plannedId = (project: string, n: number) => `${project}-P${String(n).padStart(2, "0")}`;
const ok = () => assert.deepEqual(integrityProblems(getDb()), [], "the data keeps its own rules");

/** A greenlit, handed-off project with `planned` planned episodes and its roles, ready for sessions. */
async function readyProject(formType: FormType = "podcast", planned = 3): Promise<string> {
  const p =
    formType === "devotion"
      ? await call("workflow.createWorkflowProject", { category: "devotional", title: "Five days of grace" })
      : formType.startsWith("documentary")
        ? await call("workflow.createWorkflowProject", { category: "documentary", title: "A film", formType })
        : await call("workflow.createWorkflowProject", { category: "series", title: "A series", seriesType: formType });
  const id = p.contentId as string;
  const section = DEV_FORMS[formType].find((s) => s.planned);
  for (let n = 1; n <= planned; n++)
    await call("workflow.addPlannedEpisode", id, { workingTitle: `Episode ${n}`, details: fillSection(section?.planned?.details ?? []) });
  await completeForm(call, id, formType);
  await approveBrief(call, read, id, formType);
  await call("workflow.decideGreenlight", id, { outcome: "Greenlight", notes: "" });
  await call("workflow.assignProducer", id, PRODUCER);
  await tickAll(call, "handoff", id);
  await call("workflow.advanceProject", id);
  for (const [role, who] of [
    ["director", "DOF-P-CRW-001"],
    ["dop", "DOF-P-CRW-002"],
    ["audio_engineer", "DOF-P-CRW-003"],
    ["editor", "DOF-P-CRW-001"],
  ] as const)
    await call("workflow.assignRole", id, role, { crewId: who });
  await call("workflow.assignRole", id, "host_guest", { guestName: "A guest" });
  await tickAll(call, "preProject", id);
  return id;
}

const SOON = addDaysIso(todayIso(), 40);

/** A session of a ready project, recorded and ready to close, with the given statuses for planned episodes 1, 2, 3… */
async function recordedSession(project: string, statuses: string[], date = SOON, gear = ["DOF-EQ-CAM-001"]): Promise<string> {
  const s = await prepareSession(
    call,
    project,
    date,
    statuses.map((_, i) => plannedId(project, i + 1)),
    gear,
  );
  for (const [i, status] of statuses.entries())
    await call("workflow.updateLogRow", `${s}|${plannedId(project, i + 1)}`, { status, notesForPost: `Notes ${i + 1}` });
  await tickAll(call, "wrap", s);
  return s;
}

// ── The fixture ──────────────────────────────────────────────

await t("Whispers of Why, Season 1, end to end: greenlight, roles, two sessions, review, publish, numbering", async () => {
  const r = await walkWhispersOfWhy(call, read);
  assert.equal(r.episodes.length, 9);
  ok();
});

// ── IDs ──────────────────────────────────────────────────────

await t("codes come from the project's Content ID, and renaming changes no code", async () => {
  const project = await readyProject("podcast", 2);
  const s = await recordedSession(project, ["Recorded", "Recorded"]);
  await call("workflow.closeSession", s);
  const before = getDb()
    .records.filter((r) => r.contentId.startsWith(project))
    .map((r) => r.contentId);
  await call("content.updateRecord", project, { title: "A new name for the season" });
  await call("content.updateRecord", `${project}-E01`, { title: "A new name for the episode" });
  assert.deepEqual(
    getDb()
      .records.filter((r) => r.contentId.startsWith(project))
      .map((r) => r.contentId),
    before,
  );
  assert.equal(s, `${project}-R01`);
  assert.deepEqual(before.slice(-2), [`${project}-E01`, `${project}-E02`]);
});

await t("a devotion's days and a documentary's film are numbered under their own project", async () => {
  const dev = await readyProject("devotion", 5);
  assert.match(dev, /^DOF-DEV-\d{3}$/);
  const s = await recordedSession(dev, ["Recorded", "Recorded", "Recorded", "Recorded", "Recorded"]);
  const closed = await call("workflow.closeSession", s);
  assert.deepEqual(
    closed.made,
    [1, 2, 3, 4, 5].map((n) => `${dev}-E0${n}`),
  );
  assert.ok(
    getDb()
      .records.filter((r) => r.parentId === dev)
      .every((r) => r.hierarchyLevel === 1 && r.category === "devotional"),
  );
  await throwsRule(() => call("workflow.addPlannedEpisode", dev, { workingTitle: "Day 6" }), /has 5 already/);
});

// ── Gates ────────────────────────────────────────────────────

await t(
  "Development gate: the short list of hard gates (the theological review not among them), the rest as notes, and it passes once they are met",
  async () => {
    const p = (await call("workflow.createWorkflowProject", { category: "series", title: "Gate test", seriesType: "podcast" })).contentId;
    const g = W.evaluateGate("Development", "project", p);
    assert.equal(g.passed, false);
    assert.deepEqual(
      g.missing.map((m) => m.split(" (")[0]),
      ["The logline and the core question written in the brief", "Greenlight decision recorded as Greenlight, and a show producer named"],
    );
    for (const note of [/No planned episodes listed yet/, /Handoff: Outline locked/])
      assert.ok(
        g.warnings.some((w) => note.test(w)),
        `the notes should mention ${note}: ${g.warnings.join(" | ")}`,
      );
    await throwsRule(() => call("workflow.advanceProject", p), /Not ready to leave Development/);
    await throwsRule(
      () => call("workflow.decideGreenlight", p, { outcome: "Greenlight", notes: "" }),
      /The logline and the core question written in the brief/,
    );
    const ready = await readyProject();
    assert.equal(getDb().records.find((r) => r.contentId === ready)!.workflow!.stage, "Pre-production");
  },
);

await t("a testimonial cannot be greenlit until consent and release is complete, with the person's agreement", async () => {
  const p = (await call("workflow.createWorkflowProject", { category: "series", title: "Stories", seriesType: "testimonial" })).contentId;
  await call("workflow.addPlannedEpisode", p, { workingTitle: "Amina's story" });
  await completeForm(call, p, "testimonial");
  await call("workflow.saveFormSection", p, "consent", { agreement: "no" });
  await approveBrief(call, read, p, "testimonial");
  await throwsRule(() => call("workflow.decideGreenlight", p, { outcome: "Greenlight", notes: "" }), /must agree to be recorded/);
  await call("workflow.saveFormSection", p, "consent", { agreement: "yes" });
  await call("workflow.decideGreenlight", p, { outcome: "Greenlight", notes: "" });
});

await t("Decline and Advice only need a reason and close the project, which is archived with its ID kept", async () => {
  const p = (
    await call("workflow.createWorkflowProject", { category: "documentary", title: "Pitched film", formType: "documentary_pitched" })
  ).contentId;
  await throwsRule(() => call("workflow.decideGreenlight", p, { outcome: "Advice only", notes: " " }), /Write the reason/);
  await call("workflow.decideGreenlight", p, { outcome: "Advice only", notes: "We advised on structure; they make it themselves." });
  const r = getDb().records.find((x) => x.contentId === p)!;
  assert.deepEqual(
    [r.archived, r.workflow!.status, r.closedReason],
    [true, "Advice only", "We advised on structure; they make it themselves."],
  );
  const podcast = (await call("workflow.createWorkflowProject", { category: "series", title: "Another", seriesType: "podcast" })).contentId;
  await throwsRule(() => call("workflow.decideGreenlight", podcast, { outcome: "Advice only", notes: "x" }), /not a possible decision/);
  await throwsRule(() => call("workflow.saveFormSection", p, "brief", { logline: "x" }), /closed/);
});

await t("Pre-production gate for a session: project roles and checklist, gear, rehearsal, the call sheet issued", async () => {
  const p = (await call("workflow.createWorkflowProject", { category: "series", title: "Roles", seriesType: "podcast" })).contentId;
  await throwsRule(() => call("workflow.createSession", p, {}), /Sessions are scheduled at Pre-production/);
  const project = await readyProject("podcast", 2);
  const s = (await call("workflow.createSession", project, { scheduledDate: SOON })).id;
  const g = W.evaluateGate("Pre-production", "session", s);
  assert.deepEqual(g.missing, [
    "A call sheet for this session",
    "Session: Technical rehearsal: audio levels, camera sync, colour match, storage and batteries, short mock recording",
  ]);
  assert.ok(g.warnings.includes("No episodes are planned for this session yet"), "a warning, not a blocker");
  const sheet = await call("workflow.createSessionCallSheet", s);
  assert.ok(W.evaluateGate("Pre-production", "session", s).missing.includes("Gear selected from the Equipment picker"));
  assert.ok(W.evaluateGate("Pre-production", "session", s).missing.includes(`Call sheet ${sheet.id} issued (final)`));
  // The roles are the Recording Plan's: each one listed needs a person.
  await call("workflow.setRolePerson", `${project}|dop`, null);
  assert.ok(W.evaluateGate("Pre-production", "session", s).missing.includes("Role: DOP needs a person"));
  await throwsRule(() => call("workflow.openSession", s), /Not ready to leave Pre-production/);
});

await t("a DOF-made documentary records nothing until its second greenlight, which needs the shot list", async () => {
  const doc = await readyProject("documentary_dof", 0);
  const s = (await call("workflow.createSession", doc, { scheduledDate: SOON })).id;
  assert.ok(W.evaluateGate("Pre-production", "session", s).missing.some((m) => /Second greenlight/.test(m)));
  await call("workflow.setChecklistItem", `${doc}|Pre-production|shot_list`, { done: false });
  await throwsRule(() => call("workflow.decideGreenlight", doc, { outcome: "Greenlight", notes: "" }), /Shot list/);
  await call("workflow.setChecklistItem", `${doc}|Pre-production|shot_list`, { done: true });
  await call("workflow.decideGreenlight", doc, { outcome: "Greenlight", notes: "Shoot budget approved." });
  assert.ok(!W.evaluateGate("Pre-production", "session", s).missing.some((m) => /Second greenlight/.test(m)));
});

await t(
  "Production gate: at least one item recorded; the wrap checklist and unmarked rows are suggestions (build prompt v4, 7A)",
  async () => {
    const project = await readyProject("podcast", 2);
    const s = await prepareSession(call, project, SOON, [plannedId(project, 1), plannedId(project, 2)], ["DOF-EQ-CAM-001"]);
    // Nothing recorded yet: the one hard requirement is missing, and a refused close changes nothing.
    let g = W.evaluateGate("Production", "session", s);
    assert.deepEqual(g.missing, ["At least one item recorded in the Recording Log (Good or Pickup needed)"]);
    await throwsRule(() => call("workflow.closeSession", s), /Not ready to leave Production/);
    assert.equal(getDb().records.filter((r) => r.parentId === project).length, 0, "a refused close changes nothing");
    await call("workflow.updateLogRow", `${s}|${plannedId(project, 1)}`, { status: "Recorded" });
    g = W.evaluateGate("Production", "session", s);
    assert.deepEqual(g.missing, [], "one item recorded is enough to move on");
    assert.equal(g.warnings.filter((m) => m.startsWith("Wrap:")).length, CHECKLISTS.wrap.items.filter((i) => !i.auto).length);
    assert.ok(g.warnings.includes(`No take mark for "${plannedId(project, 2)}": it counts as not recorded`));
    assert.ok(g.warnings.includes("No drive chosen for the footage") && g.warnings.includes("No backup drive"), "storage is a suggestion");
    const closed = await call("workflow.closeSession", s);
    assert.deepEqual(closed.made, [`${project}-E01`], "the unmarked row stays planned for a later session");
  },
);

await t("Editing, Post production and Marketing gates", async () => {
  const project = await readyProject("podcast", 1);
  await call("workflow.closeSession", await recordedSession(project, ["Recorded"]));
  const ep = `${project}-E01`;
  await call("workflow.startEditing", ep);
  assert.deepEqual(W.evaluateGate("Editing", "episode", ep).missing, [
    "The editor marks it ready for review",
    "A review link (http or https)",
  ]);
  await throwsRule(() => call("workflow.sendForReview", ep), /Not ready to leave Editing/);
  await call("workflow.setReadyForReview", ep, true);
  await call("workflow.setEpisodeLinks", ep, { reviewLink: "https://vimeo.com/123" });
  await call("workflow.sendForReview", ep);
  assert.deepEqual(W.evaluateGate("Post production", "episode", ep).missing, [
    "Rough cut review checkpoint Approved",
    "Final review checkpoint Approved",
  ]);
  await throwsRule(() => call("workflow.moveToMarketing", ep), /Not ready to leave Post production/);
  await call("workflow.decideCheckpoint", `${ep}|rough_cut`, { status: "Approved", note: "" });
  await call("workflow.decideCheckpoint", `${ep}|final`, { status: "Approved", note: "" });
  await call("workflow.moveToMarketing", ep);
  const g = W.evaluateGate("Marketing and distribution", "episode", ep);
  assert.ok(g.missing.includes("At least one distribution link logged") && g.missing.some((m) => m.startsWith("Release plan:")));
  await throwsRule(() => call("workflow.publishEpisode", ep), /Not ready to leave Marketing/);
  await tickAll(call, "release", ep);
  await call("workflow.addDistribution", ep, { platform: "Spotify", status: "Scheduled" });
  assert.deepEqual(W.evaluateGate("Marketing and distribution", "episode", ep).missing, ["At least one distribution link logged"]);
  await call("workflow.addDistribution", ep, { platform: "YouTube", status: "Published", link: "https://youtu.be/x" });
  await call("workflow.publishEpisode", ep);
  assert.equal(getDb().records.find((r) => r.contentId === project)!.workflow!.status, "Completed", "every planned episode published");
});

await t("dates after the publish date are warnings, never blockers", async () => {
  const project = await readyProject("podcast", 1);
  await call("content.updateRecord", project, { deadline: addDaysIso(todayIso(), 10) });
  const s = (await call("workflow.createSession", project, { scheduledDate: SOON })).id;
  const g = W.evaluateGate("Pre-production", "session", s);
  assert.ok(g.warnings.some((w) => w.includes(`Session ${s} (${SOON}) is after the publish date`)));
  assert.ok(!g.missing.some((m) => m.includes("publish date")));
});

await t("sending a review back needs a reason, returns the cut to Editing, and the next send skips an approved rough cut", async () => {
  const project = await readyProject("podcast", 1);
  await call("workflow.closeSession", await recordedSession(project, ["Recorded"]));
  const ep = `${project}-E01`;
  await call("workflow.startEditing", ep);
  await call("workflow.setEpisodeLinks", ep, { reviewLink: "https://vimeo.com/1" });
  await call("workflow.setReadyForReview", ep, true);
  await call("workflow.sendForReview", ep);
  await throwsRule(
    () => call("workflow.decideCheckpoint", `${ep}|rough_cut`, { status: "Changes requested", note: "" }),
    /Write what needs to change/,
  );
  await call("workflow.decideCheckpoint", `${ep}|rough_cut`, { status: "Approved", note: "" });
  await call("workflow.decideCheckpoint", `${ep}|final`, { status: "Changes requested", note: "Trim the intro by 40 seconds." });
  let info = getDb().records.find((r) => r.contentId === ep)!.episode!;
  assert.deepEqual([info.postStage, info.readyForReview, info.sendBackReason], ["Editing", false, "Trim the intro by 40 seconds."]);
  await call("workflow.setReadyForReview", ep, true);
  await call("workflow.sendForReview", ep);
  info = getDb().records.find((r) => r.contentId === ep)!.episode!;
  assert.equal(info.postStage, "Final review", "the approved rough cut is not reviewed again");
});

// ── The split ────────────────────────────────────────────────

await t("closing a session: Recorded and Pickup needed make episodes, Not recorded makes none and stays free", async () => {
  const project = await readyProject("podcast", 4);
  const s = await recordedSession(project, ["Recorded", "Not recorded", "Pickup needed", "Recorded"]);
  const closed = await call("workflow.closeSession", s);
  assert.deepEqual(closed.made, [`${project}-E01`, `${project}-E02`, `${project}-E03`]);
  const eps = getDb().records.filter((r) => r.parentId === project);
  assert.deepEqual(
    eps.map((e) => e.episode!.plannedEpisodeId),
    [1, 3, 4].map((n) => plannedId(project, n)),
  );
  assert.deepEqual(
    eps.map((e) => e.episode!.productionNotes),
    ["Notes 1", "Notes 3", "Notes 4"],
  );
  assert.ok(
    W.availableForLog((await call("workflow.createSession", project, {})).id).includes(plannedId(project, 2)),
    "P02 can go into a later session",
  );
  ok();
});

await t("closing twice never makes an episode twice", async () => {
  const project = await readyProject("podcast", 2);
  const s = await recordedSession(project, ["Recorded", "Recorded"]);
  await call("workflow.closeSession", s);
  await call("workflow.reopenSession", s);
  const again = await call("workflow.closeSession", s);
  assert.deepEqual([again.made, again.kept], [[], [`${project}-E01`, `${project}-E02`]]);
  assert.equal(getDb().records.filter((r) => r.parentId === project).length, 2);
});

await t("a close that fails part way changes nothing at all", async () => {
  const project = await readyProject("podcast", 3);
  const s = await recordedSession(project, ["Recorded", "Recorded", "Recorded"]);
  const before = JSON.stringify(getDb());
  // The server expects different IDs from the ones the browser made: the third episode fails, after two were made.
  assert.throws(() => transaction(() => expectIds([`${project}-E01`, `${project}-E02`, "SOMETHING-ELSE"], () => W.closeSession(hop(), s))));
  assert.equal(JSON.stringify(getDb()), before, "no episode, checkpoint, checklist or session change was kept");
});

await t("reopening is allowed only while every episode from the session is untouched", async () => {
  const project = await readyProject("podcast", 2);
  const s = await recordedSession(project, ["Recorded", "Recorded"]);
  await call("workflow.closeSession", s);
  await call("workflow.reopenSession", s);
  // Reopened, one row changes to Not recorded: on the next close its untouched episode is archived, not deleted.
  await call("workflow.updateLogRow", `${s}|${plannedId(project, 2)}`, { status: "Not recorded" });
  const closed = await call("workflow.closeSession", s);
  assert.deepEqual(closed.archived, [`${project}-E02`]);
  const e02 = getDb().records.find((r) => r.contentId === `${project}-E02`)!;
  assert.equal(e02.archived, true);
  await call("workflow.startEditing", `${project}-E01`);
  await throwsRule(() => call("workflow.reopenSession", s), new RegExp(`work has started on ${project}-E01 \\(Editing\\)`));
});

await t("deleting a session's call sheet unlinks it, so the session needs a new one before it is recorded", async () => {
  const project = await readyProject("podcast", 1);
  const s = (await call("workflow.createSession", project, { scheduledDate: SOON })).id;
  const sheet = await call("workflow.createSessionCallSheet", s);
  await throwsRule(() => call("workflow.createSessionCallSheet", s), /already has call sheet/);
  await call("callsheets.deleteCallSheet", sheet.id);
  assert.equal(W.getSession(s)!.callSheetId, null);
  assert.ok(W.evaluateGate("Pre-production", "session", s).missing.includes("A call sheet for this session"));
  ok();
});

// ── Uniqueness through the services ──────────────────────────

await t("one person per role (assigning again replaces), many hosts and guests, no duplicate guest", async () => {
  const project = await readyProject("podcast", 1);
  await call("workflow.assignRole", project, "director", { crewId: "DOF-P-CRW-002" });
  const directors = getDb().projectRoles.filter((r) => r.contentId === project && r.roleKey === "director");
  assert.deepEqual(
    directors.map((r) => r.crewId),
    ["DOF-P-CRW-002"],
  );
  await call("workflow.assignRole", project, "host_guest", { guestName: "Second guest" });
  await throwsRule(() => call("workflow.assignRole", project, "host_guest", { guestName: "second GUEST" }), /already a host or guest/);
  await throwsRule(() => call("workflow.assignRole", project, "director", { guestName: "Someone outside" }), /from the crew list/);
  await throwsRule(() => call("workflow.assignRole", project, "editor", { crewId: "DOF-P-VOL-001" }), /crew list/);
});

await t("a planned episode goes in one session's log once, and not again once recorded elsewhere", async () => {
  const project = await readyProject("podcast", 2);
  const s1 = await recordedSession(project, ["Recorded", "Not recorded"]);
  await throwsRule(() => call("workflow.addLogRow", s1, { plannedEpisodeId: plannedId(project, 1) }), /already in this log/);
  const s2 = (await call("workflow.createSession", project, {})).id;
  await throwsRule(() => call("workflow.addLogRow", s2, { plannedEpisodeId: plannedId(project, 1) }), /recorded in another session/);
  await call("workflow.addLogRow", s2, { plannedEpisodeId: plannedId(project, 2) });
  await throwsRule(
    () => call("workflow.addLogRow", s2, { plannedEpisodeId: "DOF-DEV-001-P01" }),
    /not one of this project's planned episodes/,
  );
  await throwsRule(() => call("workflow.updateLogRow", `${s2}|${plannedId(project, 2)}`, { status: "Recorded" }), /during the session/);
});

// ── Links ────────────────────────────────────────────────────

await t("links: only http and https web links, everything else refused", () => {
  for (const good of ["https://www.youtube.com/watch?v=abc", "http://example.com/a?b=c#d", "HTTPS://Drive.Google.com/file/d/1/view"])
    assert.ok(asWebUrl(good), good);
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "file:///C:/Users/me/final.mp4",
    "C:\\Users\\me\\final.mp4",
    "/home/me/final.mp4",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "ftp://example.com/file",
    "mailto:a@b.c",
    "//example.com/x",
    "https://user:pass@example.com/",
    "https://",
    "not a link",
    "",
  ])
    assert.equal(asWebUrl(bad), null, JSON.stringify(bad));
});

await t("an episode's links are checked when saved", async () => {
  const project = await readyProject("podcast", 1);
  await call("workflow.closeSession", await recordedSession(project, ["Recorded"]));
  const ep = `${project}-E01`;
  await throwsRule(() => call("workflow.setEpisodeLinks", ep, { reviewLink: "javascript:alert(1)" }), /must be a web link/);
  await throwsRule(() => call("workflow.setEpisodeLinks", ep, { finalFileLink: "file:///C:/final.mp4" }), /must be a web link/);
  await call("workflow.startEditing", ep);
  await throwsRule(() => call("workflow.copyShareLink", ep, ""), /Attach a hosted file link first/);
});

// ── Share links ──────────────────────────────────────────────

await t("a share token resolves to its own episode only; revoked or unknown tokens resolve to nothing", async () => {
  const project = await readyProject("podcast", 2);
  await call("workflow.closeSession", await recordedSession(project, ["Recorded", "Recorded"]));
  const [e1, e2] = [`${project}-E01`, `${project}-E02`];
  await call("workflow.setEpisodeLinks", e1, { reviewLink: "https://vimeo.com/one" });
  await call("workflow.setEpisodeLinks", e2, { reviewLink: "https://vimeo.com/two", finalFileLink: "https://drive.google.com/two-final" });
  const tok1 = "AAAAAAAAAAAAAAAAAAAAAA";
  const tok2 = "BBBBBBBBBBBBBBBBBBBBBB";
  const l1 = W.recordShareLink(hop(), e1, tok1);
  W.recordShareLink(hop(), e2, tok2);
  assert.equal(W.resolveShareToken(tok1), "https://vimeo.com/one");
  assert.equal(W.resolveShareToken(tok2), "https://drive.google.com/two-final", "the final file, when there is one");
  assert.equal(W.resolveShareToken("CCCCCCCCCCCCCCCCCCCCCC"), null);
  assert.equal(W.resolveShareToken("../../etc/passwd"), null);
  await call("workflow.revokeShareLink", l1.id);
  assert.equal(W.resolveShareToken(tok1), null);
  assert.equal(W.resolveShareToken(tok2), "https://drive.google.com/two-final", "revoking one leaves the other");
  assert.throws(() => W.recordShareLink(hop(), e1, "short"), /22 URL-safe characters/);
  ok();
});

await t("share tokens are never made in the browser", async () => {
  assert.throws(
    () => (W.recordShareLink as unknown as (...a: unknown[]) => unknown)(hop(), "x", "AAAAAAAAAAAAAAAAAAAAAA"),
    () => true,
  );
  const { setRpcSink } = await import("../src/data/rpc");
  setRpcSink(() => {});
  try {
    assert.throws(() => W.recordShareLink(hop(), "x", "AAAAAAAAAAAAAAAAAAAAAA"), /handled by the server/);
  } finally {
    setRpcSink(null);
  }
});

// ── The review window ────────────────────────────────────────

await t("a review window that passes with no decision moves the project to Hold, once, logged as the system", async () => {
  const p = (await call("workflow.createWorkflowProject", { category: "series", title: "Waiting", seriesType: "podcast" })).contentId;
  const decided = (await call("workflow.createWorkflowProject", { category: "series", title: "Decided", seriesType: "podcast" })).contentId;
  await throwsRule(() => call("workflow.setReviewWindow", p, addDaysIso(todayIso(), -1)), /today or later/);
  const window = addDaysIso(todayIso(), 2);
  await call("workflow.setReviewWindow", p, window);
  await call("workflow.setReviewWindow", decided, window);
  await call("workflow.decideGreenlight", decided, { outcome: "Revise and resubmit", notes: "Sharpen the core question." });
  assert.deepEqual(W.applyReviewWindows(window), [], "not on the last day of the window");
  assert.deepEqual(W.applyReviewWindows(addDaysIso(window, 1)), [p], "the day after: only the undecided one");
  const form = getDb().developmentForms.find((f) => f.contentId === p)!;
  assert.equal(form.outcome, "Hold");
  assert.equal(form.decisions.at(-1)!.byPersonId, "system");
  assert.ok(getDb().audit.some((a) => a.byPersonId === "system" && a.entityId === p && /Hold \(automatic\)/.test(a.detail)));
  assert.deepEqual(W.applyReviewWindows(addDaysIso(window, 5)), [], "a second run changes nothing");
  await call("workflow.setReviewWindow", p, addDaysIso(todayIso(), 7));
  assert.equal(getDb().developmentForms.find((f) => f.contentId === p)!.outcome, null, "a new window starts a new wait for a decision");
});

await t("around midnight in Nairobi, on a computer on UTC, today and the review window follow Nairobi", () => {
  // 00:30 on 26 September in Nairobi is still 25 September in UTC.
  const code = `
    const { todayIso } = await import("./src/services/utils.ts");
    const W = await import("./src/services/workflow.ts");
    const S = await import("./src/data/store.ts");
    const db = S.getDb();
    const p = db.records[0];
    p.workflow = { formType: "podcast", status: "Development", stage: "Development", showProducerId: null, producerAssignedById: null, producerAssignedAt: null, sermonFormat: null, migrated: false };
    db.developmentForms.push({ id: p.contentId, contentId: p.contentId, formType: "podcast", sections: {}, greenlightStage: null, criteria: {}, outcome: null, reviewNotes: "", decisionDate: null, reviewWindowDate: "2026-09-25", decisions: [], createdAt: "", updatedAt: "" });
    console.log(JSON.stringify({ today: todayIso(), utc: new Date().toISOString().slice(0, 10), moved: W.applyReviewWindows() }));
  `;
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "--import", "./tests/setup/clock.mjs", "--input-type=module", "-e", code],
    {
      env: { ...process.env, TZ: "UTC", DOF_TEST_NOW: "2026-09-26T00:30:00+03:00" },
      encoding: "utf8",
    },
  );
  const r = JSON.parse(out.trim().split("\n").at(-1)!);
  assert.equal(r.utc, "2026-09-25", "the computer's clock says the 25th");
  assert.equal(r.today, "2026-09-26", "the app says the 26th, as Nairobi does");
  assert.equal(r.moved.length, 1, "a window that ended on the 25th has passed");
});

// ── Permissions ──────────────────────────────────────────────

await t("who may do what: greenlight, the producer, roles, reviews, view-only", async () => {
  const p = (await call("workflow.createWorkflowProject", { category: "series", title: "Perms", seriesType: "podcast" })).contentId;
  await throwsRule(
    () => as(() => crew(2))("workflow.decideGreenlight", p, { outcome: "Hold", notes: "" }),
    /Only the Head of Production, or someone given "Create projects"/,
  );
  await throwsRule(() => as(() => crew(2))("workflow.assignProducer", p, "DOF-P-CRW-002"), /name the show producer/);
  // Not on the project: refused as view-only before anything else.
  await throwsRule(() => as(() => crew(2))("workflow.saveFormSection", p, "brief", { logline: "x" }), /view-only/);
  // On the project (as its producer), but not a reviewer named on the brief.
  await call("workflow.assignProducer", p, PRODUCER);
  const brief = (await call("documents.ensureDocument", p, "Development", "show_brief", null)).id;
  await call("documents.setDocumentReviewers", brief, ["DOF-P-CRW-001"]);
  await throwsRule(
    () => as(() => crew(4))("documents.decideDocumentReview", brief, { status: "approved", note: "" }),
    /Only a reviewer named on this document/,
  );
  await throwsRule(() => as(vol)("workflow.saveFormSection", p, "brief", { logline: "x" }), /view-only/);
  const project = await readyProject("podcast", 1);
  // The producer (crew 4) assigns roles on their own project; another crew member who is not the producer cannot.
  await as(() => crew(4))("workflow.assignRole", project, "continuity", { crewId: "DOF-P-CRW-003" });
  await throwsRule(
    () => as(() => crew(2))("workflow.assignRole", project, "continuity", { crewId: "DOF-P-CRW-002" }),
    /Only the show producer/,
  );
});

// ── Documentary ──────────────────────────────────────────────

await t("a documentary's sessions log free-form items, and Send to post production makes the film with every note", async () => {
  const doc = await readyProject("documentary_pitched", 0);
  const s = (await call("workflow.createSession", doc, { scheduledDate: SOON })).id;
  await throwsRule(() => call("workflow.addLogRow", s, {}), /Name what was recorded/);
  await call("workflow.addLogRow", s, { itemLabel: "Interview set A", guest: "Elder Lekisaat" });
  await call("workflow.addLogRow", s, { itemLabel: "Wells at dawn" });
  await throwsRule(() => call("workflow.sendToPostProduction", doc), /Close at least one recording session/);
  const sheet = await call("workflow.createSessionCallSheet", s);
  await call("equipment.addGearToSheet", { id: sheet.id, contentId: sheet.contentId, date: sheet.date }, [
    { equipmentId: "DOF-EQ-CAM-001", quantity: 1 },
  ]);
  await call("callsheets.finalizeCallSheet", sheet.id);
  await tickAll(call, "preSession", s);
  await call("workflow.openSession", s);
  for (const row of getDb().sessionLogEntries.filter((e) => e.sessionId === s))
    await call("workflow.updateLogRow", row.id, { status: "Recorded", notesForPost: `${row.itemLabel} notes` });
  await tickAll(call, "wrap", s);
  const closed = await call("workflow.closeSession", s);
  assert.deepEqual(closed.made, [], "a documentary's rows are not episodes");
  const [film] = await call("workflow.sendToPostProduction", doc);
  assert.equal(film.contentId, `${doc}-E01`);
  assert.match(film.episode.productionNotes, /Interview set A \(Elder Lekisaat\): Interview set A notes/);
  assert.match(film.episode.productionNotes, /Wells at dawn: Wells at dawn notes/);
  await throwsRule(() => call("workflow.sendToPostProduction", doc), /already in post production/);
});

// ── The earlier pipeline, around the workflow ────────────────

await t(
  "the earlier pipeline's actions refuse workflow records; a live recording split into a workflow season becomes its next episode",
  async () => {
    const project = await readyProject("podcast", 1);
    await throwsRule(
      () => call("content.createChildRecord", project, { title: "Episode by hand" }),
      /made when a recording session closes/,
    );
    await throwsRule(() => call("content.deleteRecord", project), /closed with a reason/);
    await throwsRule(() => call("content.advanceStage", project), /new workflow/);
    await throwsRule(() => call("content.updateRecord", project, { assigneePersonId: "DOF-P-CRW-002" }), /Name the show producer instead/);
    const split = await call("content.splitRecording", "DOF-LIVE-001-D1", {
      destCategory: "series",
      parentId: project,
      title: "Live testimony",
    });
    assert.equal(split.contentId, `${project}-E01`);
    assert.deepEqual([split.episode.postStage, split.spunOffFrom], ["Not started", "DOF-LIVE-001-D1"]);
    assert.equal(getDb().reviewCheckpoints.filter((c) => c.episodeId === split.contentId).length, 2);
    ok();
  },
);

await t("the run sheet template is the brief's day for five episodes, and repeats the pattern for others", () => {
  const five = W.runSheetTemplate(5, 58).map((i) => `${i.time} ${i.title} ${i.durationMin}`);
  assert.deepEqual(five, [
    "07:00 Crew call, load-in 0",
    "07:00 Setup 90",
    "08:30 Technical check 30",
    "09:00 Talent arrival, mic-up, start routine 10",
    "09:10 Episode 1 58",
    "10:08 Spot check and changeover 22",
    "10:30 Episode 2 58",
    "11:28 Changeover 20",
    "11:48 Episode 3 58",
    "12:46 Lunch 44",
    "13:30 Episode 4 58",
    "14:28 Changeover 20",
    "14:48 Episode 5 58",
    "15:46 Wrap 59",
  ]);
  assert.ok(!W.runSheetTemplate(3, 58).some((i) => i.title === "Lunch"), "lunch only with four or more");
  assert.ok(W.runSheetTemplate(4, 58).some((i) => i.title === "Lunch"));
  assert.throws(() => W.runSheetTemplate(12, 120), /do not fit in one day/);
});

await t("session codes, planned and episode numbers stay unique when the same project is used hard", async () => {
  const project = await readyProject("podcast", 6);
  const a = await recordedSession(project, ["Recorded", "Recorded", "Recorded"], SOON, ["DOF-EQ-CAM-001"]);
  await call("workflow.closeSession", a);
  const b = (await call("workflow.createSession", project, {})).id;
  await call("workflow.archiveSession", b, "Studio unavailable");
  const c = (await call("workflow.createSession", project, {})).id;
  assert.deepEqual(
    [a, b, c],
    [1, 2, 3].map((n) => `${project}-R0${n}`),
    "an archived session's number is not reused",
  );
  await call("workflow.archivePlannedEpisode", plannedId(project, 6), "Guest withdrew");
  const next = await call("workflow.addPlannedEpisode", project, { workingTitle: "A new one" });
  assert.equal(next.id, plannedId(project, 7), "an archived planned episode's number is not reused");
  await throwsRule(() => call("workflow.archivePlannedEpisode", plannedId(project, 1), "x"), /has been recorded/);
  ok();
});

console.log(`\n${passed} passed`);
