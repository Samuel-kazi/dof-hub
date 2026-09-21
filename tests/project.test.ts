// Run with: npx tsx tests/project.test.ts
// Hosts and guests, show dates, live days, project teams and roles, several links, checkout list IDs, printable equipment list.
import assert from "node:assert/strict";
import { getDb, resetDemoData } from "../src/data/store";
import { RuleError } from "../src/types";
import { login } from "../src/services/auth";
import { isoDay } from "../src/data/seed";
import * as C from "../src/services/content";
import * as CS from "../src/services/callsheets";
import * as T from "../src/services/team";
import * as P from "../src/services/people";
import * as E from "../src/services/equipment";
import { getRecord } from "../src/services/access";
import { shootDateLabel } from "../src/config/categories";

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
  assert.ok(days.every((d) => d.pipelineStage === "Idea" && d.productionLevel === "medium" && d.title.startsWith("Day ")));
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

console.log(`\n${passed} passed`);
