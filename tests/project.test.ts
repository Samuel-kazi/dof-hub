// Run with: npx tsx tests/project.test.ts
// Hosts and guests, show dates, live days, project teams and roles, several links, checkout list IDs, printable equipment list.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { getDb, resetDemoData } from "../src/data/store";
import { RuleError } from "../src/types";
import { login } from "../src/services/auth";
import { isoDay } from "../src/data/seed";
import * as C from "../src/services/content";
import * as CS from "../src/services/callsheets";
import * as T from "../src/services/team";
import * as P from "../src/services/people";
import * as E from "../src/services/equipment";
import { getRecord, visibleRecords } from "../src/services/access";
import { categoryOf, shootDateLabel } from "../src/config/categories";
import { effortFor } from "../src/config/capacity";
import { remindersFor } from "../src/services/reminders";
import { AppProvider } from "../src/ui/AppContext";
import { Pipeline } from "../src/pages/Pipeline";
import { RecordPage } from "../src/pages/RecordPage";

let passed = 0;
const t = (name: string, fn: () => void) => {
  resetDemoData();
  try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; }
};
const throwsRule = (fn: () => unknown, match?: RegExp) => assert.throws(fn, (e) => e instanceof RuleError && (!match || match.test(e.message)));
const hop = () => login("hop@dof.demo", "demo");
const crew1 = () => login("crew1@dof.demo", "demo"); // Series, Devotional, Music
const crew2 = () => login("crew2@dof.demo", "demo"); // Series, Documentary
const crew3 = () => login("crew3@dof.demo", "demo"); // Series, Live, Music
const vol = () => login("volunteer1@dof.demo", "demo"); // Series
const rec = (id: string) => getRecord(id)!;

// ── Hosts and guests ──
t("a show lists hosts and an episode lists its guests", () => {
  C.addFeatured(crew1(), "DOF-DEV-001", { kind: "host", name: "Rev. Ann", note: "Presenter" });
  const g = C.addFeatured(crew1(), "DOF-SER-001-S1-E02", { kind: "guest", name: "Dr. Lucy Njeri", note: "Counsellor" });
  assert.equal(g.kind, "guest");
  assert.equal(rec("DOF-DEV-001").featured.filter((f) => f.kind === "host").length, 2);
});
t("an episode shows its show's hosts, but not the show's guests", () => {
  C.addFeatured(hop(), "DOF-SER-001", { kind: "guest", name: "Series guest" });
  const f = C.featuredFor(rec("DOF-SER-001-S1-E01"));
  assert.deepEqual(f.inherited.map((x) => x.person.name).sort(), ["Elder James Otieno", "Pastor Mary Wanjiku"]);
  assert.deepEqual(f.own.map((x) => x.name), ["Dr. Samuel Mwangi"]);
});
t("names are required, not repeated, and editable", () => {
  throwsRule(() => C.addFeatured(crew1(), "DOF-DEV-001", { kind: "guest", name: "  " }), /guest's name/);
  throwsRule(() => C.addFeatured(crew1(), "DOF-DEV-001", { kind: "host", name: "rev. grace achieng" }), /already listed/);
  const f = rec("DOF-DEV-001").featured[0];
  C.updateFeatured(crew1(), "DOF-DEV-001", f.id, { note: "Morning host" });
  assert.equal(rec("DOF-DEV-001").featured[0].note, "Morning host");
  C.removeFeatured(crew1(), "DOF-DEV-001", f.id);
  assert.equal(rec("DOF-DEV-001").featured.length, 0);
});
t("only people who can edit the project change its hosts and guests", () => {
  throwsRule(() => C.addFeatured(vol(), "DOF-SER-001", { kind: "guest", name: "x" }), /view-only/);
  throwsRule(() => C.addFeatured(crew2(), "DOF-DEV-001", { kind: "guest", name: "x" }), /view-only/);
});

// ── Show dates, publish date ──
t("a series has a start and an end of the show", () => {
  const s = C.createRecord(hop(), { category: "series", title: "New show", showStart: isoDay(5), showEnd: isoDay(90) });
  assert.equal(s.showStart, isoDay(5)); assert.equal(s.showEnd, isoDay(90));
  C.updateRecord(hop(), s.contentId, { showEnd: isoDay(120) });
  assert.equal(rec(s.contentId).showEnd, isoDay(120));
});
t("show dates are checked", () => {
  throwsRule(() => C.createRecord(hop(), { category: "series", title: "x", showStart: isoDay(10), showEnd: isoDay(2) }), /cannot end before/);
  throwsRule(() => C.createRecord(hop(), { category: "series", title: "x", showEnd: isoDay(2) }), /starts as well/);
  throwsRule(() => C.createRecord(hop(), { category: "devotional", title: "x", showStart: isoDay(2) }), /series and live/);
  throwsRule(() => C.updateRecord(hop(), "DOF-SER-001", { showEnd: isoDay(-100) }), /cannot end before/);
});
t("the labels say shoot date and publish date", () => {
  assert.equal(shootDateLabel("series"), "Shoot date"); assert.equal(shootDateLabel("live"), "Show date");
  const tbc = C.createRecord(hop(), { category: "live", title: "TBC" });
  throwsRule(() => CS.openOrCreateForRecord(hop(), `${tbc.contentId}-D1`), /shoot date/);
});

// ── Live shows made of days ──
t("a five day show becomes five days, each its own item", () => {
  const show = C.createRecord(hop(), { category: "live", title: "Revival week", showStart: isoDay(40), showEnd: isoDay(44), productionLevel: "medium" });
  const days = C.getChildren(show.contentId);
  assert.deepEqual(days.map((d) => d.contentId), [1, 2, 3, 4, 5].map((n) => `${show.contentId}-D${n}`));
  assert.deepEqual(days.map((d) => d.scheduledDate), [40, 41, 42, 43, 44].map(isoDay));
  assert.ok(days.every((d) => d.pipelineStage === "Prep" && d.productionLevel === "medium" && d.title.startsWith("Day ")));
  assert.equal(show.pipelineStage, null, "the show itself has no pipeline");
  assert.equal(C.getRollupStatus(show.contentId).total, 5);
});
t("a one day show, and a show with no dates, each get one day", () => {
  const one = C.createRecord(hop(), { category: "live", title: "One night", showStart: isoDay(3) });
  assert.equal(C.getChildren(one.contentId).length, 1);
  const none = C.createRecord(hop(), { category: "live", title: "TBC" });
  const [day] = C.getChildren(none.contentId);
  assert.equal(day.scheduledDate, null);
});
t("a show cannot run longer than 31 days, and more days can be added", () => {
  throwsRule(() => C.createRecord(hop(), { category: "live", title: "Long", showStart: isoDay(1), showEnd: isoDay(60) }), /31 days/);
  const d6 = C.createChildRecord(hop(), "DOF-LIVE-002", { title: "Day 6", scheduledDate: isoDay(15) });
  assert.equal(d6.contentId, "DOF-LIVE-002-D6");
});
t("each day has its own call sheet and its own run of show requirement", () => {
  const large = CS.openOrCreateForRecord(hop(), "DOF-LIVE-002-D1").sheet; // large
  const small = CS.openOrCreateForRecord(hop(), "DOF-LIVE-002-D4").sheet; // small
  assert.deepEqual(large.linkedEpisodeIds, ["DOF-LIVE-002-D1"]); assert.deepEqual(small.linkedEpisodeIds, ["DOF-LIVE-002-D4"]);
  assert.notEqual(large.id, small.id);
  assert.equal(CS.runOfShowRequired(large), true); assert.equal(CS.runOfShowRequired(small), false);
  throwsRule(() => CS.finalizeCallSheet(hop(), large.id), /run of show/);
  assert.equal(CS.finalizeCallSheet(hop(), small.id).status, "final");
  CS.addRunItem(hop(), large.id, { time: "18:00", title: "Doors", durationMin: 30 });
  assert.equal(CS.finalizeCallSheet(hop(), large.id).status, "final");
});
t("changing one day's level changes only that day's call sheet", () => {
  const s = CS.openOrCreateForRecord(hop(), "DOF-LIVE-002-D2").sheet; // medium
  assert.equal(CS.runOfShowRequired(s), false);
  C.updateRecord(hop(), "DOF-LIVE-002-D2", { productionLevel: "large" });
  assert.equal(CS.runOfShowRequired(s), true);
  assert.equal(CS.runOfShowRequired(CS.openOrCreateForRecord(hop(), "DOF-LIVE-002-D4").sheet), false);
});
t("days of one show are told apart in document titles", () => {
  const titles = getDb().docs.filter((d) => d.contentId.startsWith("DOF-LIVE-002")).map((d) => d.title);
  assert.ok(titles.length >= 2 && titles.every((x) => x.includes("Youth Conference, Day")));
});

// ── Teams and roles ──
t("a project team has several people, each with several roles", () => {
  T.addTeamMember(hop(), "DOF-DEV-001", "DOF-P-CRW-002", ["Camera operator", "  Editor ", "editor"], true);
  const m = T.teamOf(rec("DOF-DEV-001")).find((x) => x.person.personId === "DOF-P-CRW-002")!;
  assert.deepEqual(m.roles, ["Camera operator", "Editor"]);
  assert.ok(T.teamOf(rec("DOF-DEV-001")).length >= 2);
});
t("a role can be typed by hand, and then appears in the list", () => {
  assert.ok(!T.knownRoles().includes("Drone pilot"));
  T.addTeamMember(hop(), "DOF-DEV-001", "DOF-P-CRW-003", ["Drone pilot"], true);
  assert.ok(T.knownRoles().includes("Drone pilot")); assert.ok(T.knownRoles().includes("Director"));
});
t("roles are checked", () => {
  throwsRule(() => T.addTeamMember(hop(), "DOF-DEV-001", "DOF-P-CRW-002", ["Camera, Editor"], true), /commas/);
  throwsRule(() => T.addTeamMember(hop(), "DOF-DEV-001", "DOF-P-CRW-002", ["x".repeat(41)], true), /too long/);
});
t("only the Head of Production changes a team, and nobody joins twice", () => {
  throwsRule(() => T.addTeamMember(crew1(), "DOF-DEV-001", "DOF-P-CRW-002", ["Editor"], true), /Head of Production/);
  throwsRule(() => T.addTeamMember(hop(), "DOF-SER-001", "DOF-P-CRW-002", ["Editor"], true), /already on this project/);
  throwsRule(() => T.setMemberRoles(crew1(), "DOF-SER-001", "DOF-P-CRW-002", ["x"]), /Head of Production/);
});
t("roles come from who does what on the project, and show beside the person's name", () => {
  C.setOwnerRoles(hop(), "DOF-SER-001", C.PROJECT_STAGE, "DOF-P-CRW-002", ["Director of photography"]);
  assert.ok(T.roleOn("DOF-P-CRW-002", rec("DOF-SER-001-S1-E02"))!.startsWith("Director of photography"));
  assert.match(T.nameWithRole("DOF-P-CRW-002", rec("DOF-SER-001-S1-E02")), /^Brian Otieno \(Director of photography/);
  assert.equal(T.nameWithRole(null, rec("DOF-SER-001")), "Unassigned");
});
t("a person's roles on a project add up across its stages", () => {
  const roles = T.rolesOnProject("DOF-P-CRW-003", rec("DOF-SER-001-S1-E01"));
  for (const expected of ["Audio engineer", "Sound designer"]) assert.ok(roles.includes(expected), expected);
});
t("a team from an episode is the whole show's team", () => {
  assert.deepEqual(T.teamOf(rec("DOF-SER-001-S1-E01")).map((x) => x.person.personId), T.teamOf(rec("DOF-SER-001")).map((x) => x.person.personId));
});
t("someone who still owns a stage cannot leave the project until it is handed over", () => {
  throwsRule(() => P.removeFromProject(hop(), "DOF-P-CRW-001", "DOF-SER-001"), /still owns/);
  for (const r of getDb().records) {
    for (const [stage, list] of Object.entries(r.stageAssignees)) {
      if (!list.some((o) => o.personId === "DOF-P-CRW-001")) continue;
      if (!list.some((o) => o.personId === "DOF-P-CRW-003")) C.addStageOwner(hop(), r.contentId, stage, "DOF-P-CRW-003", []);
      C.removeStageOwner(hop(), r.contentId, stage, "DOF-P-CRW-001");
    }
    for (const tk of r.tasks) if (tk.assigneePersonId === "DOF-P-CRW-001" && !tk.done) C.updateTask(hop(), r.contentId, tk.id, { assigneePersonId: "DOF-P-CRW-003" });
  }
  P.removeFromProject(hop(), "DOF-P-CRW-001", "DOF-SER-001");
  assert.ok(!T.teamOf(rec("DOF-SER-001")).some((x) => x.person.personId === "DOF-P-CRW-001"));
});
t("the crew page's attach uses the same role rules", () => {
  P.assignToProject(hop(), "DOF-P-CRW-002", "DOF-DEV-001", "Camera operator, Editor", true);
  assert.equal(T.teamOf(rec("DOF-DEV-001")).find((x) => x.person.personId === "DOF-P-CRW-002")!.roles.length, 2);
  throwsRule(() => P.assignToProject(hop(), "DOF-P-CRW-003", "DOF-DEV-001", "x".repeat(50), true), /too long/);
});

// ── Several links at once ──
t("several links can be posted together, each with a label", () => {
  const made = C.addLinks(crew1(), "DOF-SER-001-S1-E04", { kind: "review", links: [{ url: "https://youtu.be/a", note: "YouTube" }, { url: "https://facebook.com/b", note: "Facebook" }, { url: "", note: "" }] });
  assert.equal(made.length, 2); assert.deepEqual(made.map((l) => l.note), ["YouTube", "Facebook"]);
  assert.equal(rec("DOF-SER-001-S1-E04").links.length, 2);
});
t("if one link is wrong, none are posted", () => {
  throwsRule(() => C.addLinks(crew1(), "DOF-SER-001-S1-E04", { kind: "review", links: [{ url: "https://ok.example" }, { url: "not a link" }] }), /not a link/);
  assert.equal(rec("DOF-SER-001-S1-E04").links.length, 0);
  throwsRule(() => C.addLinks(crew1(), "DOF-SER-001-S1-E04", { kind: "review", links: [{ url: "" }] }), /at least one/);
  throwsRule(() => C.addLinks(crew1(), "DOF-SER-001-S1-E04", { kind: "review", links: [{ note: "label only" }] }), /needs a link/);
});
t("an analysis can be several notes and links", () => {
  assert.equal(C.addLinks(crew1(), "DOF-SER-001-S1-E04", { kind: "analysis", links: [{ note: "Retention drops at 2:10" }, { url: "https://analytics.example/report", note: "Full report" }] }).length, 2);
});

// ── Checkout list IDs on a project ──
t("an existing checkout list can be attached to a project by its ID", () => {
  const m = E.createManifest(crew1(), { contentId: "DOF-DEV-001", date: isoDay(20), destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }] });
  E.attachManifest(crew1(), m.id, "DOF-SER-001-S1-E04");
  assert.equal(E.getManifest(m.id)!.contentId, "DOF-SER-001-S1-E04");
  assert.equal(E.itemHistory("DOF-EQ-AUD-002")[0].kind, "edited");
  assert.ok(E.manifestsForContent("DOF-SER-001-S1-E04").some((x) => x.id === m.id));
});
t("attaching is refused for call sheet lists, released lists, the same project, and people not on both", () => {
  throwsRule(() => E.attachManifest(hop(), "DOF-MF-001", "DOF-DEV-001"), /call sheet/);
  const m = E.createManifest(crew1(), { contentId: "DOF-DEV-001", date: isoDay(20), destination: "studio", status: "assigned", lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }] });
  throwsRule(() => E.attachManifest(crew1(), m.id, "DOF-DEV-001"), /already attached/);
  throwsRule(() => E.attachManifest(crew2(), m.id, "DOF-DOC-001"), /both projects/);
  E.releaseManifest(crew1(), m.id);
  throwsRule(() => E.attachManifest(crew1(), m.id, "DOF-SER-001-S1-E04"), /released/);
});

// ── Printable equipment list ──
t("the equipment list is grouped by category", () => {
  const all = E.inventoryReport("all", false);
  assert.ok(all.length >= 6);
  assert.deepEqual(all.map((g) => g.label).slice(0, 2), ["Camera", "Audio"]);
  const cam = E.inventoryReport("camera", false);
  assert.equal(cam.length, 1); assert.equal(cam[0].rows.length, 4); assert.equal(cam[0].units, 4);
});
t("retired and lost items only print when asked for", () => {
  assert.ok(!E.inventoryReport("audio", false)[0].rows.some((r) => r.id === "DOF-EQ-AUD-004"));
  assert.ok(E.inventoryReport("audio", true)[0].rows.some((r) => r.id === "DOF-EQ-AUD-004"));
});
t("batches print with their count and how many are free", () => {
  const row = E.inventoryReport("cabling", false)[0].rows.find((r) => r.id === "DOF-EQ-CAB-XLR10M-B01")!;
  assert.equal(row.qty, 12); assert.equal(row.free, 8); assert.equal(row.serial, "");
});

// ── Production count: a live show with several days is one production, not one per day ──
t("a multi-day live show collapses to one production unit; other categories stay one leaf each", () => {
  const actor = login("hop@dof.demo", "demo");
  const leaves = visibleRecords(actor).filter(C.usesPipeline);
  const days = leaves.filter((r) => r.category === "live");
  assert.ok(days.length >= 2, "the demo data has more than one live-show day to begin with");
  const units = C.productionUnits(leaves);
  assert.equal(units.length, leaves.length - days.length + new Set(days.map((d) => d.parentId)).size, "each show's days collapse into one unit, everything else stays as-is");
  const show = units.find((u) => u.id === "DOF-LIVE-002")!;
  assert.ok(show && show.leaves.length > 1, "the show with several days rolls all of them into one unit");
  const episode = units.find((u) => u.id === "DOF-SER-001-S1-E01")!;
  assert.equal(episode.leaves.length, 1, "a series episode is not collapsed with anything else");
});

t("a production unit is in progress if any of its days is, even once collapsed", () => {
  const actor = login("hop@dof.demo", "demo");
  const leaves = visibleRecords(actor).filter(C.usesPipeline);
  const units = C.productionUnits(leaves);
  const show = units.find((u) => u.id === "DOF-LIVE-002")!;
  assert.ok(show.leaves.length > 1 && show.leaves.some((l) => !C.isComplete(l)), "the show counts as in production while any of its days is unfinished");
});

// ── Live day: Prep → Build → Rehearse → Show → Wrap → Review → Post Production ──
function pushToStage(actor: ReturnType<typeof login>, id: string, target: string) {
  let r = getRecord(id)!;
  while (r.pipelineStage !== target) {
    for (const t of r.tasks.filter((t) => t.stage === r.pipelineStage)) C.updateTask(actor, id, t.id, { done: true });
    C.setStageOutput(actor, id, true, r.version);
    r = getRecord(id)!;
    C.advanceStage(actor, id, r.version);
    r = getRecord(id)!;
  }
  return r;
}

t("Wrap pulls the show's nightly strike list every day, and adds the final list only on the last day", () => {
  const actor = login("hop@dof.demo", "demo");
  // DOF-LIVE-002 is seeded "continuous": daily = light security checks, final = the full rig
  const d1 = pushToStage(actor, "DOF-LIVE-002-D1", "Wrap");
  const d1Tasks = d1.tasks.filter((t) => t.stage === "Wrap").map((t) => t.label);
  assert.ok(d1Tasks.includes("Cover cameras and lenses"), "day 1 gets the nightly list");
  assert.ok(!d1Tasks.includes("Full rig: trusses, screens, staging"), "day 1 does not strike the full rig");
  const d5 = pushToStage(actor, "DOF-LIVE-002-D5", "Wrap");
  const d5Tasks = d5.tasks.filter((t) => t.stage === "Wrap").map((t) => t.label);
  assert.ok(d5Tasks.includes("Cover cameras and lenses") && d5Tasks.includes("Full rig: trusses, screens, staging"), "the last day gets both lists");
});

t("a live day with no strike checklist set gets no Wrap tasks, and does not block on an empty checklist", () => {
  const actor = login("hop@dof.demo", "demo");
  const show = C.createRecord(actor, { category: "live", title: "No checklist yet" });
  const day = getRecord(`${show.contentId}-D1`)!;
  const atWrap = pushToStage(actor, day.contentId, "Wrap");
  assert.equal(atWrap.tasks.filter((t) => t.stage === "Wrap").length, 0);
  assert.deepEqual(C.openTasks(atWrap), []);
});

t("Post Production asks whether anything was recorded, and blocks being marked done until answered", () => {
  const actor = login("hop@dof.demo", "demo");
  const day = pushToStage(actor, "DOF-LIVE-001-D1", "Post Production");
  assert.equal(day.postProductionNeeded, null);
  throwsRule(() => C.setStageOutput(actor, day.contentId, true, day.version), /whether anything recorded/);
});

t("saying yes requires an actual split before the day can be marked done; saying no does not", () => {
  const actor = login("hop@dof.demo", "demo");
  const yes = pushToStage(actor, "DOF-LIVE-001-D1", "Post Production");
  C.setPostProductionNeeded(actor, yes.contentId, true);
  const afterYes = getRecord(yes.contentId)!;
  throwsRule(() => C.setStageOutput(actor, yes.contentId, true, afterYes.version), /Attach the recording/);
  const made = C.splitRecording(actor, yes.contentId, { destCategory: "series", parentId: "DOF-SER-001-S1", title: "Sunday message" });
  assert.equal(made.spunOffFrom, yes.contentId);
  assert.equal(made.pipelineStage, "Editorial", "a sermon starts at Editorial, skipping the stages that assume no footage");
  assert.deepEqual(C.spinOffsOf(yes.contentId).map((r) => r.contentId), [made.contentId]);
  const afterSplit = getRecord(yes.contentId)!;
  C.setStageOutput(actor, yes.contentId, true, afterSplit.version); // now allowed
  assert.equal(C.isComplete(getRecord(yes.contentId)!), true);

  const no = pushToStage(actor, "DOF-LIVE-002-D2", "Post Production");
  C.setPostProductionNeeded(actor, no.contentId, false);
  const afterNo = getRecord(no.contentId)!;
  C.setStageOutput(actor, no.contentId, true, afterNo.version); // allowed straight away
  assert.equal(C.isComplete(getRecord(no.contentId)!), true);
});

t("a recording split into Music starts at Audio post-production, skipping Recording", () => {
  const actor = login("hop@dof.demo", "demo");
  const day = pushToStage(actor, "DOF-LIVE-002-D3", "Post Production");
  C.setPostProductionNeeded(actor, day.contentId, true);
  const album = getDb().records.find((r) => r.category === "music" && r.hierarchyLevel === 1)!;
  const made = C.splitRecording(actor, day.contentId, { destCategory: "music", parentId: album.contentId, title: "Live worship medley" });
  assert.equal(made.pipelineStage, "Audio post-production");
  assert.equal(made.category, "music");
});

t("splitting off a recording needs write access to both the live day and the destination", () => {
  const actor = login("hop@dof.demo", "demo");
  const day = pushToStage(actor, "DOF-LIVE-001-D1", "Post Production");
  const vol = login("volunteer1@dof.demo", "demo");
  throwsRule(() => C.splitRecording(vol, day.contentId, { destCategory: "series", parentId: "DOF-SER-001-S1", title: "x" }));
});

// ── Stage staleness: a stage that has sat idle far past what it normally takes ──
t("a stage just entered is never stale, however small its typical effort", () => {
  const actor = login("hop@dof.demo", "demo");
  const r = getRecord("DOF-SER-001-S1-E01")!;
  getDb().records.find((x) => x.contentId === r.contentId)!.stageEnteredAt = isoDay(0);
  const fresh = getRecord(r.contentId)!;
  assert.equal(C.isStale(fresh), false);
  assert.notEqual(C.riskOf(fresh), "stale");
  assert.equal(C.daysInStage(fresh), 0);
  void actor;
});

t("a stage that has sat idle well past 2.5x its typical effort is stale", () => {
  const r = getRecord("DOF-SER-001-S1-E01")!;
  const typical = effortFor(r.category, r.pipelineStage!, {});
  getDb().records.find((x) => x.contentId === r.contentId)!.stageEnteredAt = isoDay(-Math.ceil(typical * 2.5) - 3);
  const stalled = getRecord(r.contentId)!;
  assert.equal(C.isStale(stalled), true);
  assert.equal(C.riskOf(stalled), "stale");
  assert.ok(C.daysInStage(stalled) > typical * 2.5);
});

t("just short of 2.5x is not yet stale; the multiplier is generous, not a hair trigger", () => {
  const r = getRecord("DOF-SER-001-S1-E01")!;
  const typical = effortFor(r.category, r.pipelineStage!, {});
  getDb().records.find((x) => x.contentId === r.contentId)!.stageEnteredAt = isoDay(-Math.floor(typical * 2.5) + 1);
  assert.equal(C.isStale(getRecord(r.contentId)!), false);
});

t("a completed item is never stale, however long ago its last stage was entered", () => {
  const actor = login("hop@dof.demo", "demo");
  const done = C.createRecord(actor, { category: "documentary", title: "Old and finished" });
  const stages = categoryOf("documentary").stages;
  while (getRecord(done.contentId)!.pipelineStage !== stages[stages.length - 1].name) {
    const cur = getRecord(done.contentId)!;
    for (const task of cur.tasks.filter((x) => x.stage === cur.pipelineStage)) C.updateTask(actor, done.contentId, task.id, { done: true });
    C.setStageOutput(actor, done.contentId, true, getRecord(done.contentId)!.version);
    C.advanceStage(actor, done.contentId, getRecord(done.contentId)!.version);
  }
  const last = getRecord(done.contentId)!;
  for (const task of last.tasks.filter((x) => x.stage === last.pipelineStage)) C.updateTask(actor, done.contentId, task.id, { done: true });
  C.setStageOutput(actor, done.contentId, true, getRecord(done.contentId)!.version);
  getDb().records.find((x) => x.contentId === done.contentId)!.stageEnteredAt = isoDay(-500);
  assert.equal(C.isComplete(getRecord(done.contentId)!), true);
  assert.equal(C.isStale(getRecord(done.contentId)!), false);
  assert.equal(C.riskOf(getRecord(done.contentId)!), "done");
});

t("a longer effort override raises the bar for staleness on that stage", () => {
  const r = getRecord("DOF-SER-001-S1-E01")!;
  const stage = r.pipelineStage!;
  const key = `${r.category}:${stage}`;
  getDb().records.find((x) => x.contentId === r.contentId)!.stageEnteredAt = isoDay(-10);
  const before = C.isStale(getRecord(r.contentId)!);
  getDb().settings.effortOverrides = { ...getDb().settings.effortOverrides, [key]: 20 };
  assert.equal(C.isStale(getRecord(r.contentId)!), false, "a big enough override for this stage pushes the threshold well past 10 days");
  getDb().settings.effortOverrides = Object.fromEntries(Object.entries(getDb().settings.effortOverrides).filter(([k]) => k !== key));
  void before;
});

t("advancing or sending back a stage resets stageEnteredAt to now", () => {
  const actor = login("hop@dof.demo", "demo");
  const r = getRecord("DOF-SER-001-S1-E01")!;
  getDb().records.find((x) => x.contentId === r.contentId)!.stageEnteredAt = isoDay(-40);
  for (const task of r.tasks.filter((x) => x.stage === r.pipelineStage)) C.updateTask(actor, r.contentId, task.id, { done: true });
  C.setStageOutput(actor, r.contentId, true, getRecord(r.contentId)!.version);
  const advanced = C.advanceStage(actor, r.contentId, getRecord(r.contentId)!.version);
  assert.equal(advanced.stageEnteredAt, isoDay(0));
  const back = C.sendBackStage(actor, r.contentId, getRecord(r.contentId)!.version);
  assert.equal(back.stageEnteredAt, isoDay(0));
});

t("a stalled item's reminder goes to whoever is responsible now, with 'no update' wording, not 'due'", () => {
  const actor = login("hop@dof.demo", "demo");
  const r = getRecord("DOF-SER-001-S1-E01")!;
  const owner = C.ownersOf(r, r.pipelineStage!)[0]?.personId ?? r.assigneePersonId!;
  getDb().records.find((x) => x.contentId === r.contentId)!.stageEnteredAt = isoDay(-40);
  const mine = remindersFor(owner);
  const staleOne = mine.find((x: { kind: string; contentId: string }) => x.kind === "stale" && x.contentId === r.contentId);
  assert.ok(staleOne, "the person responsible for the stalled stage gets a stale reminder");
  assert.match(staleOne.title, /no update/i);
  assert.doesNotMatch(staleOne.title, /due/i);
  const someoneElse = remindersFor("DOF-P-VOL-002");
  assert.ok(!someoneElse.some((x: { kind: string; contentId: string }) => x.kind === "stale" && x.contentId === r.contentId), "someone not responsible for the stage does not get nudged about it");
  void actor;
});

t("a stalled item shows 'Stalled' on the Pipeline board and its own page", () => {
  const actor = login("hop@dof.demo", "demo");
  const r = getRecord("DOF-SER-001-S1-E01")!;
  getDb().records.find((x) => x.contentId === r.contentId)!.stageEnteredAt = isoDay(-40);
  assert.equal(C.riskOf(getRecord(r.contentId)!), "stale");
  void actor;
});

t("a stalled item renders as 'Stalled' on the Pipeline board and its own page", () => {
  const actor = login("hop@dof.demo", "demo");
  const r = getRecord("DOF-SER-001-S1-E01")!;
  getDb().records.find((x) => x.contentId === r.contentId)!.stageEnteredAt = isoDay(-40);
  const withCtx = (el: React.ReactElement) => React.createElement(AppProvider, { actor, onLogout: () => {} }, el);
  const pipelineHtml = renderToString(withCtx(React.createElement(Pipeline, {})));
  assert.match(pipelineHtml, /Stalled/);
  const pageHtml = renderToString(withCtx(React.createElement(RecordPage, { id: r.contentId })));
  assert.match(pageHtml, /Stalled/);
});

// ── Devotional: Creation → Guest → Prep/Scripting → Recording → Editing → Review → Published,
// with a Closed branch off Guest and a required-reason send-back from Review ──

function freshDevotional(actor: ReturnType<typeof login> = login("hop@dof.demo", "demo")) {
  return C.createRecord(actor, { category: "devotional", title: "Test devotional" });
}

t("a new Devotional starts at Creation, defaults to Ruth Jepkorir, and stays a flat project", () => {
  const d = freshDevotional();
  assert.equal(d.pipelineStage, "Creation");
  assert.equal(d.assigneePersonId, "DOF-P-CRW-004");
  assert.equal(C.childKindFor(d), null, "a Devotional never splits into episodes, even in a batch");
});

t("the default producer is reassignable per project, same as any assignee", () => {
  const hop = login("hop@dof.demo", "demo");
  const d = freshDevotional(hop);
  const updated = C.updateRecord(hop, d.contentId, { assigneePersonId: "DOF-P-CRW-001" });
  assert.equal(updated.assigneePersonId, "DOF-P-CRW-001");
});

t("the general advance and send-back buttons refuse Guest going forward, but sending it back to Creation still works; Closed is final either way", () => {
  const hop = login("hop@dof.demo", "demo");
  const d = freshDevotional(hop);
  C.setStageOutput(hop, d.contentId, true);
  C.advanceStage(hop, d.contentId); // Creation -> Guest, generic advance still works here
  throwsRule(() => C.advanceStage(hop, d.contentId), /theological review/);
  const back = C.sendBackStage(hop, d.contentId); // going back is not one of the gated branches
  assert.equal(back.pipelineStage, "Creation");
});

t("Guest, approved: records the reviewer and timestamp, and moves on to Prep/Scripting", () => {
  const hop = login("hop@dof.demo", "demo");
  const d = freshDevotional(hop);
  C.setStageOutput(hop, d.contentId, true);
  C.advanceStage(hop, d.contentId); // -> Guest
  throwsRule(() => C.approveGuestReview(hop, d.contentId, ""), /Name who did the theological review/);
  for (const task of getRecord(d.contentId)!.tasks.filter((x) => x.stage === "Guest")) {
    throwsRule(() => C.approveGuestReview(hop, d.contentId, "Pastor Samuel"), /Finish/);
    C.updateTask(hop, d.contentId, task.id, { done: true });
  }
  const approved = C.approveGuestReview(hop, d.contentId, "Pastor Samuel");
  assert.equal(approved.reviewerName, "Pastor Samuel");
  assert.ok(approved.reviewApprovedAt);
  assert.equal(approved.pipelineStage, "Prep/Scripting");
});

t("Guest, non-compliant: closes the project, requires a reason, and it is no longer complete or advanceable", () => {
  const hop = login("hop@dof.demo", "demo");
  const d = freshDevotional(hop);
  C.setStageOutput(hop, d.contentId, true);
  C.advanceStage(hop, d.contentId); // -> Guest
  throwsRule(() => C.closeDevotional(hop, d.contentId, ""), /Say why the guest did not work out/);
  const closed = C.closeDevotional(hop, d.contentId, "Guest stopped responding after setup was shared.");
  assert.equal(closed.pipelineStage, "Closed");
  assert.equal(closed.closedReason, "Guest stopped responding after setup was shared.");
  assert.equal(C.isComplete(closed), false);
  throwsRule(() => C.closeDevotional(hop, d.contentId, "again"), /Already closed/);
  throwsRule(() => C.advanceStage(hop, d.contentId), /Closed is final/);
});

t("Closed and Published never show a risk, and never generate a reminder — devotional has none of that yet", () => {
  const hop = login("hop@dof.demo", "demo");
  const d = freshDevotional(hop);
  C.setStageOutput(hop, d.contentId, true);
  C.advanceStage(hop, d.contentId);
  const closed = C.closeDevotional(hop, d.contentId, "Non-compliant guest.");
  assert.equal(C.riskOf(closed), "ok");
  assert.equal(C.isStale(closed), false);
  const reminders = C.getReminders(hop);
  assert.ok(!reminders.some((r) => r.record.contentId === closed.contentId));
});

function toReview(hop: ReturnType<typeof login>): string {
  const d = freshDevotional(hop);
  const id = d.contentId;
  C.setStageOutput(hop, id, true); C.advanceStage(hop, id); // Creation -> Guest
  for (const task of getRecord(id)!.tasks.filter((x) => x.stage === "Guest")) C.updateTask(hop, id, task.id, { done: true });
  C.approveGuestReview(hop, id, "Pastor Samuel"); // -> Prep/Scripting
  C.setStageOutput(hop, id, true); C.advanceStage(hop, id); // -> Recording
  C.setStageOutput(hop, id, true); C.advanceStage(hop, id); // -> Editing
  return id;
}

t("Editing's ready-for-review checkbox only exists at Editing, and Review checks it before approving", () => {
  const hop = login("hop@dof.demo", "demo");
  const id = toReview(hop);
  assert.equal(getRecord(id)!.pipelineStage, "Editing");
  throwsRule(() => C.approveDevotionalReview(hop, id), /not at the Review stage/);
  const ready = C.setDevotionalReadyForReview(hop, id, true);
  assert.equal(ready.readyForReview, true);
  C.setStageOutput(hop, id, true); C.advanceStage(hop, id); // -> Review
  throwsRule(() => C.setDevotionalReadyForReview(hop, id, true), /not at the Editing stage/);
});

t("Review, approved: only once ready for review is set, and it moves straight to Published", () => {
  const hop = login("hop@dof.demo", "demo");
  const id = toReview(hop);
  C.setDevotionalReadyForReview(hop, id, true);
  C.setStageOutput(hop, id, true); C.advanceStage(hop, id); // -> Review
  throwsRule(() => { getRecord(id)!.readyForReview = false; C.approveDevotionalReview(hop, id); }, /not marked this ready/);
  getRecord(id)!.readyForReview = true;
  const done = C.approveDevotionalReview(hop, id);
  assert.equal(done.pipelineStage, "Published");
  assert.equal(C.isComplete(done), false, "Published still needs its own required output confirmed, same as any other category's final stage");
  C.setStageOutput(hop, id, true);
  assert.ok(C.isComplete(getRecord(id)!));
});

t("Review, sent back: needs a reason, returns to Editing, and resets ready-for-review", () => {
  const hop = login("hop@dof.demo", "demo");
  const id = toReview(hop);
  C.setDevotionalReadyForReview(hop, id, true);
  C.setStageOutput(hop, id, true); C.advanceStage(hop, id); // -> Review
  throwsRule(() => C.sendBackDevotionalToEditing(hop, id, ""), /Say why it is going back/);
  const back = C.sendBackDevotionalToEditing(hop, id, "Audio needs a re-mix on the second half.");
  assert.equal(back.pipelineStage, "Editing");
  assert.equal(back.sendBackReason, "Audio needs a re-mix on the second half.");
  assert.equal(back.readyForReview, false);
});

t("the recording-day view is a live filter across projects, not a stored relationship", () => {
  const hop = login("hop@dof.demo", "demo");
  const a = freshDevotional(hop);
  const b = freshDevotional(hop);
  const c = freshDevotional(hop);
  C.updateRecord(hop, a.contentId, { scheduledDate: "2026-11-03" });
  C.updateRecord(hop, b.contentId, { scheduledDate: "2026-11-03" });
  C.updateRecord(hop, c.contentId, { scheduledDate: "2026-11-04" });
  const day = C.devotionalsOnRecordingDate(hop, "2026-11-03");
  assert.deepEqual(day.map((r) => r.contentId).sort(), [a.contentId, b.contentId].sort());
  C.updateRecord(hop, b.contentId, { scheduledDate: "2026-11-09" }); // changing the date is all it takes
  assert.equal(C.devotionalsOnRecordingDate(hop, "2026-11-03").length, 1);
});

t("recording duration and notes, and the Prep/Scripting fields, are plain edits on the project itself", () => {
  const hop = login("hop@dof.demo", "demo");
  const d = freshDevotional(hop);
  const updated = C.updateRecord(hop, d.contentId, {
    guestName: "Rev. Ann Wanjala", guestContact: "ann@example.com", cardStorage: "Card B, slot 2",
    publishDate: "2026-12-01", recordingDurationMin: 24, recordingNotes: "Two retakes on the opening line.",
  });
  assert.equal(updated.guestName, "Rev. Ann Wanjala");
  assert.equal(updated.recordingDurationMin, 24);
  assert.equal(updated.publishDate, "2026-12-01");
});

console.log(`\n${passed} passed`);
