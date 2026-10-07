// Run with: npm test -- actions
// The server's list of actions (server/schemas.ts), checked end to end over real HTTP with data in memory:
// every action accepts the arguments its screen sends, fields an action does not own are dropped, wrong
// types are refused before any rule runs, and nothing outside the list can be called.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.SETUP_TOKEN = "test-setup-code-1234";
process.env.DOF_SCRYPT_N = "1024";

const { createHandler, memoryStore } = await import("../server/index");
const { ACTIONS, NOT_ACTIONS } = await import("../server/schemas");
const { RPC_NAMES } = await import("../src/services/wrapped/names");
const { walkWhispersOfWhy } = await import("./support/wow-walkthrough");

let passed = 0;
let server: Server | undefined;
let base = "";

async function fresh() {
  const store = memoryStore();
  server?.close();
  server = createServer(createHandler(async () => store));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const t = async (name: string, fn: () => Promise<void> | void) => {
  await fresh();
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).message);
    process.exitCode = 1;
  }
};

type Json = Record<string, any>;
class Client {
  cookie = "";
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dof_session="));
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b: unknown = {}) => this.call("POST", p, b);
  act = (name: string, ...args: unknown[]) => this.post("/api/action", { name, args: [{ personId: "ignored", role: "HOP" }, ...args] });
}

async function setupHop() {
  const c = new Client();
  const r = await c.post("/api/setup", {
    token: process.env.SETUP_TOKEN,
    name: "Kevin Mwangi",
    username: "kev",
    password: "correct horse battery",
    samples: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return c;
}
async function loginFor(hop: Client, personId: string, username: string) {
  const made = await hop.post("/api/accounts/create", { personId, username });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const c = new Client();
  assert.equal((await c.post("/api/login", { username, password: made.json.temporaryPassword })).status, 200);
  assert.equal(
    (await c.post("/api/account/password", { current: made.json.temporaryPassword, next: "a fresh password here" })).status,
    200,
  );
  return c;
}

const allGenerated = Object.entries(RPC_NAMES).flatMap(([m, names]) => names.map((n) => `${m}.${n}`));

await t("every generated wrapper is either a server action or deliberately not one", () => {
  const unclassified = allGenerated.filter((n) => !(n in ACTIONS) && !(n in NOT_ACTIONS));
  assert.deepEqual(unclassified, [], `Add these to ACTIONS or NOT_ACTIONS in server/schemas.ts: ${unclassified.join(", ")}`);
  const both = Object.keys(ACTIONS).filter((n) => n in NOT_ACTIONS);
  assert.deepEqual(both, [], "listed as both an action and not an action");
  const stale = Object.keys(NOT_ACTIONS).filter((n) => !allGenerated.includes(n));
  assert.deepEqual(stale, [], "NOT_ACTIONS names something that is no longer generated");
});

await t("names that are not actions are refused, including names every object inherits", async () => {
  const hop = await setupHop();
  for (const name of [
    "constructor",
    "hasOwnProperty",
    "toString",
    "__proto__",
    "content.deletionImpact",
    "permissions.can",
    "team.addTeamMember",
    "people.createLoginForPerson",
    "settings.changePassword",
    "nope.nothing",
  ]) {
    const r = await hop.act(name);
    assert.equal(r.status, 400, `${name}: ${r.status}`);
    assert.match(r.json.error, /does not exist/, name);
  }
});

await t("every action accepts the arguments its screen sends", async () => {
  const hop = await setupHop();
  const covered = new Set<string>();
  const call = async (name: string, ...args: unknown[]): Promise<Json> => {
    assert.ok(name in ACTIONS, `${name} is not an action`);
    covered.add(name);
    const r = await hop.act(name, ...args);
    assert.ok(r.status !== 500, `${name} crashed the server`);
    assert.notEqual(r.json.code, "invalid", `${name} refused the arguments its screen sends: ${JSON.stringify(args).slice(0, 300)}`);
    if (process.env.DEBUG_ACTIONS && r.status !== 200) console.log(`  (${name}: ${r.json.error})`);
    return r.json;
  };
  const state = async (): Promise<Json> => (await hop.get("/api/state")).json.db;
  const rec = async (id: string): Promise<Json> => (await state()).records.find((r: Json) => r.contentId === id);
  const blankRecord = {
    scheduledDate: null,
    deadline: null,
    assigneePersonId: null,
    notes: "",
    productionLevel: null,
    showStart: null,
    showEnd: null,
  };
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  // Projects
  const show = (await call("content.createRecord", { title: "Contract series", ...blankRecord, category: "series" })).result.contentId;
  const season = (await call("content.createChildRecord", show, { title: "Season 1", ...blankRecord })).result.contentId;
  const ep = (await call("content.createChildRecord", season, { title: "Episode 1", ...blankRecord })).result.contentId;
  let r = await rec(ep);
  const stage = r.pipelineStage;
  await call(
    "content.updateRecord",
    ep,
    { title: "Episode 1", scheduledDate: "2026-10-05", deadline: "2026-10-20", assigneePersonId: "DOF-P-CRW-001", notes: "Notes" },
    r.version,
  );
  r = await rec(ep);
  await call("content.setStageDeadline", ep, stage, "2026-10-10", r.version);
  const task = (await call("content.addTask", ep, { label: "Check the B-roll", dueDate: null, assigneePersonId: null })).result.id;
  await call("content.updateTask", ep, task, { done: true });
  await call("content.updateTask", ep, task, { assigneePersonId: null });
  await call("content.updateTask", ep, task, { dueDate: null });
  await call("content.removeTask", ep, task);
  await call("content.addStageOwner", ep, stage, "DOF-P-CRW-002", ["Editor"]);
  await call("content.setOwnerRoles", ep, stage, "DOF-P-CRW-002", ["Colorist"]);
  await call("content.removeStageOwner", ep, stage, "DOF-P-CRW-002");
  const guest = (await call("content.addFeatured", ep, { kind: "guest", name: "Pastor Amani", note: "" })).result.id;
  await call("content.updateFeatured", ep, guest, { note: "Nairobi Chapel" });
  await call("content.removeFeatured", ep, guest);
  const links = (
    await call("content.addLinks", ep, {
      kind: "review",
      stage,
      links: [{ url: "https://example.com/cut-1", note: "First cut", key: "row-1" }],
    })
  ).result;
  await call("content.removeLink", ep, links[0].id);
  await call("content.addComment", ep, "Looks good.");
  r = await rec(ep);
  await call("content.setStageOutput", ep, true, r.version);
  r = await rec(ep);
  await call("content.advanceStage", ep, r.version);
  r = await rec(ep);
  await call("content.sendBackStage", ep, r.version);

  const live = (
    await call("content.createRecord", {
      title: "Contract live",
      ...blankRecord,
      showStart: "2026-10-10",
      showEnd: "2026-10-11",
      productionLevel: "small",
      category: "live",
    })
  ).result.contentId;
  r = await rec(live);
  await call("content.setStrikePlan", live, "daily", ["Lights", ""], ["Truss"], r.version);
  const day = `${live}-D1`;
  r = await rec(day);
  await call("content.setPostProductionNeeded", day, false, r.version);
  await call("content.splitRecording", day, { destCategory: "series", parentId: season, title: "Recorded live" });

  r = await rec("DOF-DEV-001");
  await call("content.approveGuestReview", "DOF-DEV-001", "Rev. Otieno", r.version);
  await call("content.setDevotionalReadyForReview", "DOF-DEV-001", true, r.version);
  await call("content.approveDevotionalReview", "DOF-DEV-001", r.version);
  await call("content.sendBackDevotionalToEditing", "DOF-DEV-001", "Audio drops out", r.version);
  await call("content.closeDevotional", "DOF-DEV-001", "The guest withdrew", r.version);
  const doomed = (await call("content.createRecord", { title: "Delete me", ...blankRecord, category: "documentary" })).result.contentId;
  await call("content.deleteRecord", doomed);

  // Call sheets
  const sheet = (await call("callsheets.createCallSheet", { contentId: show, date: "2026-10-05" })).result.id;
  let cs = (await state()).callSheets.find((x: Json) => x.id === sheet);
  // The form sends its whole draft, which includes fields the action does not change.
  await call(
    "callsheets.updateCallSheet",
    sheet,
    { ...cs, title: "Shoot day", location: "Studio A", callTime: "07:00", crewPersonIds: ["DOF-P-CRW-001"] },
    cs.version,
  );
  cs = (await state()).callSheets.find((x: Json) => x.id === sheet);
  await call("callsheets.updateCallSheet", sheet, { crewPersonIds: ["DOF-P-CRW-001", "DOF-P-CRW-002"] }, cs.version);
  // A run of show belongs to a large live production.
  r = await rec(day);
  await call("content.updateRecord", day, { productionLevel: "large" }, r.version);
  const liveSheet = (await call("callsheets.createCallSheet", { contentId: live, date: "2026-10-10" })).result.id;
  const seg = (await call("callsheets.addRunItem", liveSheet, { time: "09:00", title: "Opening", durationMin: 10, ownerPersonId: null }))
    .result.id;
  await call("callsheets.updateRunItem", liveSheet, seg, { title: "Opening prayer" });
  await call("callsheets.removeRunItem", liveSheet, seg);
  cs = (await state()).callSheets.find((x: Json) => x.id === sheet);
  await call("callsheets.resolveMismatches", sheet, cs.version);
  const copy = (await call("callsheets.duplicateCallSheet", sheet, "2026-10-06")).result.sheet.id;
  const copied = (await state()).callSheets.find((x: Json) => x.id === copy);
  await call("callsheets.attachCallSheet", copy, "DOF-SER-001", copied.version);
  cs = (await state()).callSheets.find((x: Json) => x.id === sheet);
  await call("callsheets.finalizeCallSheet", sheet, cs.version);
  await call("callsheets.reopenCallSheet", sheet);
  await call("callsheets.deleteCallSheet", copy);
  await call("callsheets.openOrCreateForRecord", ep);
  await call("content.addComment", show, "On the call sheet", sheet);

  // Equipment
  const kit = {
    make: "Sony",
    model: "FX9",
    category: "camera",
    unitCost: 1000,
    purchaseDate: null,
    vendor: "",
    condition: "Good",
    packaging: "",
    accessories: "",
    info: "",
  };
  const cam = (await call("equipment.createItem", { trackingType: "serialized", name: "Test camera", itemFamily: "", quantity: 1, ...kit }))
    .result.id;
  const units = (
    await call("equipment.createSerializedUnits", {
      name: "Test camera",
      ...kit,
      units: [{ serialNumber: "SN-1", label: "" }, { serialNumber: "SN-2" }],
    })
  ).result.map((u: Json) => u.id);
  const batch = (
    await call("equipment.createItem", {
      trackingType: "aggregate",
      name: "XLR 5 m",
      make: "",
      model: "",
      category: "cabling",
      itemFamily: "XLR-5M",
      quantity: 10,
      unitCost: 5,
      purchaseDate: null,
      vendor: "",
      condition: "Good",
      packaging: "",
      accessories: "",
      info: "",
    })
  ).result.id;
  await call("equipment.updateItem", cam, { name: "Test camera", ...kit, purchaseDate: null, serialNumber: "SN-0", unitLabel: "" });
  await call("equipment.updateItem", batch, {
    name: "XLR 5 m",
    make: "",
    model: "",
    category: "cabling",
    vendor: "",
    packaging: "",
    accessories: "",
    info: "",
    unitCost: 5,
    purchaseDate: null,
    condition: "Good",
    quantityTotal: 10,
  });
  await call("equipment.setConditionBreakdown", batch, { New: 0, Good: 8, Fair: 2, Poor: 0 });
  const att = (await call("equipment.addAttachment", cam, "photo", { url: pixel, caption: "" })).result.id;
  await call("equipment.addAttachment", cam, "receipt", { url: "https://example.com/receipt.pdf" });
  await call("equipment.removeAttachment", cam, att);
  await call("equipment.startRepair", units[0], "Lens mount loose");
  await call("equipment.finishRepair", units[0], "Good", "Tightened");
  await call("equipment.retireItem", units[1], "retired", "Replaced");
  await call("equipment.reinstateItem", units[1]);
  await call("equipment.deleteItem", units[1]);
  const mf = (
    await call("equipment.createManifest", {
      contentId: show,
      date: "2026-10-05",
      destination: "outside",
      status: "assigned",
      expectedReturn: "2026-10-07",
      responsiblePersonId: "DOF-P-CRW-001",
      lines: [{ equipmentId: cam, quantity: 1 }],
      notes: "",
    })
  ).result.id;
  await call("equipment.addLines", mf, [{ equipmentId: batch, quantity: 2 }]);
  await call("equipment.removeLine", mf, batch);
  await call("equipment.markGoneOut", mf, {
    expectedReturn: "2026-10-07",
    responsiblePersonId: "DOF-P-CRW-001",
    photos: { [cam]: [{ url: pixel, caption: "" }] },
  });
  await call("equipment.checkIn", mf, [
    { equipmentId: cam, returnedGood: 1, damaged: 0, lost: 0, conditionIn: "Good", description: "", sendToRepair: false, photos: [] },
  ]);
  await call("equipment.attachManifest", mf, "DOF-SER-001");
  const mf2 = (
    await call("equipment.createManifest", {
      contentId: show,
      date: "2026-10-12",
      destination: "studio",
      status: "assigned",
      expectedReturn: null,
      responsiblePersonId: "DOF-P-HOP-001",
      lines: [{ equipmentId: batch, quantity: 1 }],
      notes: "",
    })
  ).result.id;
  await call("equipment.releaseManifest", mf2);
  cs = (await state()).callSheets.find((x: Json) => x.id === sheet);
  await call("equipment.addGearToSheet", { id: cs.id, contentId: cs.contentId, date: cs.date }, [{ equipmentId: units[0], quantity: 1 }]);
  await call("equipment.removeGearFromSheet", sheet, units[0]);

  // Documents
  const doc = (await call("docs.createDoc", { contentId: ep, title: "Edit notes", templateKey: null })).result.id;
  await call("docs.saveDoc", doc, { title: "Edit notes", body: "# Notes\n\n- Tighten the opening" }, 1);
  const rev = (await state()).docRevisions.find((x: Json) => x.docId === doc).id;
  await call("docs.restoreRevision", doc, rev);
  await call("docs.attachDoc", doc, "DOF-SER-001-S1-E01");
  await call("docs.archiveDoc", doc);

  // People
  const pid = (
    await call("people.createPerson", {
      category: "VOL",
      name: "Wanjiku Mwangi",
      email: "",
      phone: "",
      skills: [],
      equipmentFamiliarity: [],
    })
  ).result.personId;
  await call("people.updatePerson", pid, {
    name: "Wanjiku Mwangi",
    email: "wanjiku@example.org",
    phone: "0700 000000",
    skills: ["Ushering"],
    equipmentFamiliarity: [],
  });
  await call("people.updateOwnProfile", { notifyEmail: true });
  await call("people.updateOwnProfile", { photoUrl: pixel });
  await call("people.updateOwnProfile", { photoUrl: null });
  await call("people.updatePersonCategory", pid, "CRW");
  await call("people.assignToProject", pid, show, "Helper", true);
  await call("people.removeFromProject", pid, show);
  await call("people.deactivatePerson", pid);
  await call("people.reactivatePerson", pid);

  // Access, reminders, settings
  await call("permissions.setRoleGrant", "CRW", "reports.export", null);
  await call("permissions.setPersonGrant", "DOF-P-CRW-001", "people.contacts", true);
  await call("permissions.resetPermissions");
  await call("reminders.logSent", "DOF-P-HOP-001", "calendar", "Calendar file", "3 events", ["k1", "k2"]);
  await call("settings.updateSettings", { workDays: [1, 2, 3, 4, 5], effortOverrides: { "series:Editorial": 2.5 } });
  await call("settings.updateSettings", { stageReminderHours: 24 });
  await call("settings.updateSettings", { newDocuments: ["devotion"] });
  await call("settings.updateSettings", { checkoutReturnDays: 3, storageWarningThreshold: 85 });
  await call("settings.updateWorkspaceAppearance", { accent: "ocean" });
  await call("settings.updateWorkspaceAppearance", { fontPairing: "classic" });

  // Storage
  const drive = (await call("storage.createDrive", { name: "Contract drive", capacityGB: 1000, otherUsedGB: 0, notes: "" })).result.id;
  await call("storage.updateDrive", drive, { name: "Contract drive 2", capacityGB: 2000, otherUsedGB: 10, notes: "" });
  const alloc = (await call("storage.addAllocation", { driveId: drive, contentId: ep, sizeGB: 10, kind: "project", note: "" })).result.id;
  const early = (
    await call("storage.addAllocation", { driveId: drive, contentId: null, label: "Youth camp raw", sizeGB: 5, kind: "raw", note: "" })
  ).result.id;
  await call("storage.updateAllocation", alloc, { sizeGB: 12, kind: "project", note: "", driveId: drive });
  await call("storage.moveAllocation", early, ep);
  await call("storage.removeAllocation", alloc);
  await call("storage.clearRecordFromDrives", ep);
  await call("storage.deleteDrive", drive);

  // The five-stage workflow: the brief's walkthrough (every step must succeed), then the actions it does not use.
  const must = async (name: string, ...args: unknown[]) => {
    const j = await call(name, ...args);
    assert.equal(j.ok, true, `${name} was refused: ${j.error}`);
    return j.result;
  };
  const wow = await walkWhispersOfWhy(must, state as never);
  const e01 = `${wow.project}-E01`;
  await must("workflow.setCheckpointReviewers", `${wow.project}-E02|rough_cut`, ["DOF-P-CRW-004", "DOF-P-CRW-001"]);
  await must("workflow.setWorkflowDeadline", wow.project, "Pre-production", "2026-12-01");
  await must("workflow.setWorkflowDeadline", `${wow.project}-E02`, "Post production", "2026-12-05");
  await must("workflow.updatePlannedEpisode", `${wow.project}-P30`, {
    workingTitle: "Why begin again?",
    question: "",
    guest: "",
    notes: "",
    details: { targetMinutes: "60" },
  });
  await must("workflow.archivePlannedEpisode", `${wow.project}-P30`, "Moved to season 2");
  await call("workflow.removeRole", `${wow.project}|dop`);
  const s3 = (await must("workflow.createSession", wow.project, { scheduledDate: "2026-12-10", venue: "Studio B" })).id;
  await must("workflow.updateSession", s3, { venue: "Studio C" });
  const item = (
    await must("workflow.addRunSheetItem", s3, { time: "16:50", title: "Team photo", durationMin: 10, ownerPersonId: null, notes: "" })
  ).id;
  await must("workflow.updateRunSheetItem", s3, item, { durationMin: 15 });
  await must("workflow.removeRunSheetItem", s3, item);
  await must("workflow.addLogRow", s3, { plannedEpisodeId: `${wow.project}-P10`, guest: "", notesForPost: "" });
  await must("workflow.removeLogRow", `${s3}|${wow.project}-P10`);
  await must("workflow.archiveSession", s3, "Studio unavailable");
  await must("workflow.reopenSession", wow.session2);
  await must("workflow.setEpisodeEditor", `${wow.project}-E02`, "DOF-P-CRW-001");
  const dist = await must("workflow.addDistribution", e01, { platform: "Facebook", status: "Planned" });
  await must("workflow.updateDistribution", e01, dist.id, {
    platform: "Facebook",
    status: "Published",
    link: "https://facebook.com/x",
    date: null,
  });
  await must("workflow.removeDistribution", e01, dist.id);
  await must("workflow.setLearningNotes", e01, "Listeners asked for a follow-up.");
  const wfShare = await must("workflow.copyShareLink", e01, "Sent to the guest");
  await must("workflow.revokeShareLink", wfShare.id);
  const wfDoc = (
    await must("workflow.createWorkflowProject", { category: "documentary", title: "Pitched film", formType: "documentary_pitched" })
  ).contentId;
  await call("workflow.sendToPostProduction", wfDoc); // refused (nothing recorded yet), but its arguments are accepted
  await must("workflow.closeProject", wfDoc, "Withdrawn by the proposer");

  // Project documents, storyboards and shot lists.
  const brief = (await must("documents.ensureDocument", wow.project, "Development", "show_brief", null)).id;
  await must("documents.syncReviewThread", wow.project);
  const firstPage = ((await state()).documentPages as Json[]).find((p) => p.documentId === brief)!.id;
  await must("documents.savePage", firstPage, { title: "The idea", subtitle: "John 1", bodyHtml: "<p><strong>Bold</strong> idea</p>" }, 1);
  const extra = (await must("documents.addPage", brief, { title: "Extra", afterPageId: firstPage })).id;
  await must("documents.movePage", extra, 0);
  await must("documents.archivePage", extra);
  await must("documents.restorePage", extra);
  const docLink = await must("documents.addDocumentLink", brief, "https://docs.google.com/document/d/x", "Draft in Google Docs");
  await must("documents.removeDocumentLink", docLink.id);
  await must("documents.setDocumentReviewers", brief, ["DOF-P-CRW-004"]);
  await must("documents.decideDocumentReview", brief, { status: "approved", note: "" });
  const comment = await must("documents.addReviewComment", firstPage, "Check the scripture reference.");
  await must("documents.resolveReviewComment", comment.id, true);
  const board = (await must("documents.createStoryboard", wow.project, { name: "Opening", episodeId: null })).id;
  const frame = (await must("documents.addFrame", board, { description: "Wide of the studio" })).id;
  await must("documents.updateFrame", frame, {
    scene: "Sc. 1",
    soundEffects: "Room tone",
    videoLink: "https://youtu.be/x",
    imagePath: null,
  });
  await must("documents.moveFrame", frame, 0);
  const twin = (await must("documents.duplicateFrame", frame)).id;
  const board2 = (await must("documents.createStoryboard", wow.project, { name: "Reused", copyFrom: board })).id;
  await must("documents.moveFramesTo", [twin], board2);
  await must("documents.renameStoryboard", board2, "Reused opening");
  await must("documents.deleteFrames", [twin]);
  const list = (await must("documents.createShotList", wow.project, { name: "Session 1" })).id;
  const shot = (await must("documents.addShotRow", list, "shot", { description: "Host, eye level", estMinutes: 2 })).id;
  await must("documents.updateShotRow", shot, { shotSize: "Medium", shotType: "Eye level", movement: "Static" });
  await must("documents.moveShotRow", shot, 0);
  const shot2 = (await must("documents.duplicateShotRow", shot)).id;
  await must("documents.renameShotList", list, "Session 1 shots");
  await must("documents.deleteShotRows", [shot2]);
  await call("documents.makeDevotionEpisodes", wfDoc); // refused (not a devotion), but its arguments are accepted
  await call("documents.acceptDevotion", wfDoc, "Ready"); // refused (not a devotion), but its arguments are accepted
  await call("documents.askForReviewAgain", brief); // refused (nobody asked for changes), but its arguments are accepted
  await call("documents.setGateOverride", wow.project, "idea", "Agreed in the planning meeting"); // its arguments are accepted
  await call("documents.noteUnreviewed", wow.project, {
    action: "schedule",
    targetId: "DOF-SER-001-S1-R02",
    note: "Review booked for Tuesday",
  });

  // The Recording Plan (a devotion's, built on any project's roles and sessions) and where its footage is kept.
  await call("workflow.startPlanRoles", wow.project); // refused (the season has left Pre-production), but its arguments are accepted
  await call("workflow.addPlanRole", wow.project, "Lighting");
  await call("workflow.renamePlanRole", `${wow.project}|director`, "Director");
  await call("workflow.setRolePerson", `${wow.project}|director`, "DOF-P-CRW-001");
  await call("workflow.assignDevotion", `${wow.project}-P10`, null);
  // A music release's song on more than one session (its arguments are accepted).
  await call("workflow.setSongOnSession", `${wow.project}-P10`, `${wow.project}-R01`, true);
  await must("workflow.setSessionBoards", wow.session2, { storyboardId: board, shotListId: list });
  const footageDrive = (await must("storage.createDrive", { name: "Footage", capacityGB: 4000, otherUsedGB: 0, notes: "" })).id;
  await must("workflow.setProjectDrive", wow.project, footageDrive);
  await must("workflow.setSessionDrive", wow.session2, null);
  await must("workflow.setSessionFootage", wow.session2, 120.5);
  await must("workflow.setEpisodeAssets", e01, { sizeGB: 40 });
  await must("workflow.setEpisodeAssets", e01, { driveId: footageDrive, sizeGB: 45 });
  // The Recording Log (build prompt v4, section 7A): who attended, issues, take lengths, the footage's main drive and
  // its backup, ticked, a drive marked offline, the folder pattern, and a project recorded before the system imported.
  const backupDrive = (await must("storage.createDrive", { name: "Backup", capacityGB: 4000, otherUsedGB: 0, notes: "" })).id;
  await must("storage.updateDrive", backupDrive, { offline: true });
  await must("settings.updateSettings", { storageFolderPattern: "{contentId}/{date}_{label}" });
  await call("workflow.updateSession", wow.session2, {
    attendees: ["DOF-P-CRW-001"],
    attendeesNote: "The choir",
    issues: "Hum on channel 2",
  });
  await call("workflow.updateLogRow", `${wow.session2}|${wow.project}-P06`, { duration: "58:10" });
  await call("workflow.assignSessionStorage", wow.session2, { driveId: footageDrive, role: "primary", addToDrive: true });
  await call("workflow.assignSessionStorage", wow.session2, {
    driveId: backupDrive,
    role: "backup",
    linkId: null,
    folderPath: "WOW/backup",
  });
  await call("workflow.markStorage", wow.session2, "primary", true); // its arguments are accepted
  await call("workflow.clearSessionStorage", wow.session2, "backup");
  const loose = (
    await must("storage.addAllocation", {
      driveId: footageDrive,
      contentId: null,
      label: "Sermons 2024",
      sizeGB: 50,
      kind: "raw",
      note: "",
    })
  ).id;
  const imported = await must("workflow.importProject", {
    allocationId: loose,
    category: "series",
    seriesType: "sermon",
    title: "Sermons 2024",
    start: "Post production",
    recordedOn: "2024-05-01",
    items: ["Grace", "Faith"],
    reviewedBeforeSystem: false,
  });
  await must("workflow.setReviewedBeforeSystem", imported.project.contentId, true);

  // Productions: a recurring show from its template and schedule, a one-time and a multi-day event, and the sections
  // every call sheet now has.
  const fridays = {
    freq: "weekly",
    interval: 1,
    weekdays: [5],
    monthDay: null,
    nth: null,
    startDate: "2026-10-02",
    until: null,
    count: null,
    skipDates: [],
    extraDates: [],
  };
  const vespers = await must("production.createProduction", {
    title: "Friday Vespers",
    mode: "recurring",
    rule: fridays,
    callTime: "16:00",
    location: "Studio A",
  });
  const tpl = ((await state()).showTemplates as Json[]).find((x) => x.contentId === vespers.contentId)!.id;
  await must("production.updateShowTemplate", tpl, {
    sheet: {
      location: "Studio B",
      talent: [{ id: "TL-aaaaaaaa", name: "Choir", role: "Performer", contact: "", callTime: "", notes: "" }],
      plannedGear: [],
    },
    horizonWeeks: 8,
    productionLevel: "medium",
  });
  await must("production.setShowSchedule", tpl, { ...fridays, weekdays: [5, 6], skipDates: ["2026-10-09"] });
  await must("production.topUpShow", vespers.contentId);
  // A live event's days are its sessions (data version 23).
  const firstDay = ((await state()).recordingSessions as Json[]).find((s) => s.contentId === vespers.contentId && s.instance)!.id;
  const daySheet = ((await state()).callSheets as Json[]).find((c) => c.instanceId === firstDay)!;
  await must(
    "callsheets.updateCallSheet",
    daySheet.id,
    {
      talentCall: "15:30",
      startTime: "17:00",
      wrapTime: "20:00",
      locationAddress: "Ngong Road",
      locationNotes: "Gate B",
      crewPersonIds: ["DOF-P-CRW-001"],
      crewRoles: { "DOF-P-CRW-001": "Camera" },
      crewLeadId: "DOF-P-CRW-001",
      logistics: { transport: "Van", parking: "", meals: "", accommodation: "", other: "" },
      contacts: [{ id: "CT-aaaaaaaa", name: "Venue", role: "Manager", phone: "+254", email: "" }],
      technicalCheck: [{ id: "TC-aaaaaaaa", label: "Audio", done: true, note: "" }],
      rehearsal: { time: "15:00", notes: "", done: false },
      runOfShow: [{ id: "RS-aaaaaaaa", time: "17:00", title: "Welcome", durationMin: 5, ownerPersonId: null, notes: "" }],
    },
    daySheet.version,
  );
  await must("production.resetToTemplate", firstDay);
  await must("production.setDayLabel", firstDay, "Evening");
  await call("production.applyDayToFuture", firstDay); // its arguments are accepted
  await must("production.updateShowTemplate", tpl, { horizonCount: 6 });
  await call("production.cancelDay", firstDay, "Venue closed for repairs"); // its arguments are accepted
  await must("callsheets.bookPlannedGear", daySheet.id);
  const camp = await must("production.createProduction", {
    title: "Camp",
    mode: "multi_day",
    startDate: "2026-12-01",
    endDate: "2026-12-02",
  });
  await must("production.updateEventPlan", camp.contentId, { overview: "Camp meeting", accommodation: "Dorms" });
  await must("production.addEventDay", camp.contentId, "2026-12-03");
  await must("production.createProduction", { title: "Rally", mode: "one_time", date: "2026-11-14", productionLevel: "large" });

  // Call sheet improvements: saved locations, confirmations, and a session copied to another date.
  const hall = await must("locations.createLocation", { name: "Church hall", address: "Ngong Road", notes: "Gate B" });
  await must("locations.updateLocation", hall.id, { notes: "Gate B, ask for the key" });
  await must("callsheets.updateCallSheet", daySheet.id, {
    locationId: hall.id,
    location: "Church hall",
    locationAddress: "Ngong Road",
    crewPersonIds: ["DOF-P-CRW-001"],
  });
  await must("callsheets.confirmOnSheet", daySheet.id, "DOF-P-CRW-001", true);
  await must("locations.archiveLocation", hall.id, true);
  await must("workflow.duplicateSession", wow.session2, "2026-12-17");

  // The rework's foundations (data version 21): templates kept in Documents, lending, role kits, reminders, the
  // bell, and the switches for each part.
  const tpl2 = (await must("documents.saveStoryboardAsTemplate", board, "Interview set")).id;
  await must("documents.createStoryboard", null, { name: "Practice", copyFrom: tpl2 });
  await must("documents.saveShotListAsTemplate", list, "Two-camera interview");
  await must("documents.createShotList", null, { name: "Practice list", template: true });
  const lent = await must("lending.createLoan", {
    borrowerName: "Grace Church",
    borrowerPhone: "+254 700 111 222",
    organisation: "Grace Church",
    dateOut: "2027-01-10",
    expectedReturn: "2027-01-12",
    lines: [{ equipmentId: "DOF-EQ-LGT-001", quantity: 1 }],
  });
  await must("lending.updateLoan", lent.id, { notes: "Collect from the gate" });
  await must("lending.returnLoanItems", lent.id, [{ equipmentId: "DOF-EQ-LGT-001", quantity: 1, condition: "Good" }]);
  const lent2 = await must("lending.createLoan", {
    borrowerName: "Youth group",
    dateOut: "2027-02-01",
    expectedReturn: "2027-02-02",
    lines: [{ equipmentId: "DOF-EQ-AUD-002", quantity: 1 }],
  });
  await must("lending.cancelLoan", lent2.id, "Not needed after all");
  const kitMade = await must("kits.createKit", {
    role: "Camera operator",
    keywords: ["camera"],
    items: [{ equipmentId: "DOF-EQ-CAM-001", quantity: 1 }],
  });
  await must("kits.updateKit", kitMade.id, { cameraModel: "FX3" });
  await must("kits.deleteKit", kitMade.id);
  const rem = await must("alerts.createReminder", {
    title: "Order batteries",
    date: "2026-12-01",
    time: "09:00",
    offsetMinutes: 0,
    channels: ["app"],
  });
  await must("alerts.updateReminder", rem.id, { offsetMinutes: 60 });
  await must("alerts.deleteReminder", rem.id);
  await must("alerts.markNotificationsRead", []);
  await must("settings.setFeature", "shell", true);

  const missed = Object.keys(ACTIONS).filter((n) => !covered.has(n));
  assert.deepEqual(missed, [], `Add a call for: ${missed.join(", ")}`);
});

await t("fields an action does not own are dropped, not applied", async () => {
  const hop = await setupHop();
  const crew = await loginFor(hop, "DOF-P-CRW-001", "wanjiru");
  const db = async () => (await hop.get("/api/state")).json.db;
  const before = (await db()).records.find((r: Json) => r.contentId === "DOF-SER-001-S1-E01");
  const r = await crew.act("content.updateRecord", "DOF-SER-001-S1-E01", {
    notes: "updated",
    pipelineStage: "Published",
    parentId: null,
    archived: true,
    contentId: "DOF-X",
    version: 99,
    stageOutputs: {},
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = (await db()).records.find((x: Json) => x.contentId === "DOF-SER-001-S1-E01");
  assert.equal(after.notes, "updated");
  assert.deepEqual(
    [after.pipelineStage, after.parentId, after.archived, after.version],
    [before.pipelineStage, before.parentId, false, before.version + 1],
  );

  await hop.act("callsheets.updateCallSheet", "DOF-CS-001", { notes: "n", status: "final", contentId: "DOF-DOC-001", equipmentIds: ["x"] });
  const sheet = (await db()).callSheets.find((c: Json) => c.id === "DOF-CS-001");
  assert.deepEqual([sheet.notes, sheet.status, sheet.contentId], ["n", "draft", "DOF-SER-001"]);

  await hop.act("people.updatePerson", "DOF-P-CRW-002", { phone: "0711", category: "HOP", status: "inactive", personId: "DOF-P-HOP-009" });
  const p = (await db()).people.find((x: Json) => x.personId === "DOF-P-CRW-002");
  assert.deepEqual([p.phone, p.category, p.status], ["0711", "CRW", "active"]);

  await hop.act("settings.updateSettings", {
    stageReminderHours: 12,
    permissions: { roles: { CRW: { "backend.audit": true } }, people: {} },
    appearance: { accent: "plum", fontPairing: "classic" },
  });
  const settings = (await db()).settings;
  assert.equal(settings.stageReminderHours, 12);
  assert.equal(settings.permissions?.roles?.CRW?.["backend.audit"], undefined);
  assert.notEqual(settings.appearance?.accent, "plum");

  await hop.act("equipment.updateItem", "DOF-EQ-CAM-001", { info: "checked", baseStatus: "lost", id: "DOF-EQ-CAM-999", photos: [] });
  const item = (await db()).equipment.find((e: Json) => e.id === "DOF-EQ-CAM-001");
  assert.deepEqual([item.info, item.baseStatus], ["checked", "active"]);
});

await t("wrong types are refused before any rule runs", async () => {
  const hop = await setupHop();
  const bad: [string, ...unknown[]][] = [
    ["content.updateRecord", "DOF-SER-001-S1-E01", { title: 5 }],
    ["content.updateRecord", "DOF-SER-001-S1-E01", "not an object"],
    ["content.addTask", "DOF-SER-001-S1-E01", { label: { $gt: "" } }],
    ["content.addStageOwner", "DOF-SER-001-S1-E01", "Editorial", "DOF-P-CRW-001", "Editor"],
    ["people.updatePersonCategory", "DOF-P-CRW-002", "HOP"],
    ["people.createPerson", { category: "HOP", name: "Second boss", email: "", phone: "", skills: [], equipmentFamiliarity: [] }],
    ["permissions.setRoleGrant", "CRW", "everything", true],
    ["permissions.setRoleGrant", "__proto__", "backend.audit", true],
    ["equipment.addLines", "DOF-MF-001", [{ equipmentId: "DOF-EQ-AUD-002", quantity: "2" }]],
    ["settings.updateSettings", { stageReminderHours: "24" }],
    ["content.advanceStage"],
    ["content.advanceStage", "DOF-SER-001-S1-E01", 1, "extra"],
    ["workflow.decideGreenlight", "DOF-SER-001-S1", { outcome: "Approved", notes: "" }],
    ["workflow.assignRole", "DOF-SER-001-S1", "producer", { crewId: "DOF-P-CRW-001" }],
    ["workflow.updateLogRow", "X|Y", { status: "Done" }],
    ["workflow.saveFormSection", "DOF-SER-001-S1", "brief", { logline: { $ne: "" } }],
    ["workflow.createWorkflowProject", { category: "general", title: "Not a workflow category" }],
    ["workflow.setEpisodeLinks", "DOF-SER-001-S1-E01", { reviewLink: 42 }],
  ];
  for (const [name, ...args] of bad) {
    const r = await hop.act(name, ...args);
    assert.equal(r.status, 400, `${name} ${JSON.stringify(args)}: ${r.status}`);
    assert.equal(r.json.code, "invalid", `${name} ${JSON.stringify(args)}: ${JSON.stringify(r.json)}`);
  }
});

server?.close();
console.log(`\n${passed} passed`);
