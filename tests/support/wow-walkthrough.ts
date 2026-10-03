// The brief's end-to-end fixture, "Whispers of Why", Season 1: 30 planned episodes of about 58 minutes, in six
// sessions of five. Written once against a `call` function, so the same walk runs in-process
// (tests/workflow-services.test.ts) and against the real server over HTTP (tests/actions.test.ts and
// tests/workflow-http.test.ts).
//
// The walk: create the project and greenlight it; Operations names a producer; the producer assigns roles;
// pre-production for session 1; fill session 1's log (one Pickup needed with a dated note, one Not recorded);
// close it; four episodes, notes carried over; a review link on one; review; publish; then session 2, whose
// episodes continue the numbering with no gap and no repeat.
import assert from "node:assert/strict";
import type { Database, FormType } from "../../src/types";
import { DEV_FORMS, type FieldDef } from "../../src/config/devForms";
import { CHECKLISTS, CRITERIA } from "../../src/config/workflow";
import { addDaysIso, todayIso } from "../../src/services/utils";

export type Call = (name: string, ...args: unknown[]) => Promise<any>;
export type Read = () => Promise<Database>;

export const PRODUCER = "DOF-P-CRW-004";
export const REVIEW_LINK = "https://www.youtube.com/watch?v=wow-e01-review";
export const FINAL_LINK = "https://drive.google.com/file/d/wow-e01-final/view";

/**
 * Passes Development's hard gates the way the documents do: the brief's theological review named and approved, and for
 * a devotion, five script pages each with its topic, scripture and script. The rest (the greenlight, the producer) is
 * the caller's.
 */
export async function approveBrief(call: Call, read: Read, project: string, formType: FormType, reviewer = PRODUCER): Promise<string> {
  const key = formType === "devotion" ? "devotional_script" : formType.startsWith("documentary") ? "documentary_brief" : "show_brief";
  const brief = (await call("documents.ensureDocument", project, "Development", key, null)).id as string;
  if (formType === "devotion") {
    const pages = (await read()).documentPages
      .filter((pg) => pg.documentId === brief && !pg.archivedAt)
      .sort((a, b) => a.position - b.position)
      .slice(0, 5);
    for (const [i, pg] of pages.entries())
      await call(
        "documents.savePage",
        pg.id,
        { title: `Day ${i + 1}`, subtitle: "Lamentations 3:22-23", bodyHtml: "<p>The script.</p>" },
        pg.version,
      );
  }
  await call("documents.setDocumentReviewers", brief, [reviewer]);
  await call("documents.decideDocumentReview", brief, { status: "approved", note: "" });
  return brief;
}

/** A value for every field of a section, of the right type, so a form can be completed in one go. */
export function fillSection(fields: FieldDef[], crewId = PRODUCER): Record<string, unknown> {
  const value = (f: FieldDef): unknown => {
    switch (f.type) {
      case "date":
        return todayIso();
      case "crew":
        return crewId;
      case "select":
        return f.options![0];
      case "multiselect":
        return [f.options![0]];
      case "yesno":
        return "yes";
      case "amount":
        return 1000;
      default:
        return `${f.label} for Whispers of Why`;
    }
  };
  return Object.fromEntries(fields.map((f) => [f.key, value(f)]));
}

/** Completes a project's development form, section by section. */
export async function completeForm(call: Call, projectId: string, formType: FormType): Promise<void> {
  for (const section of DEV_FORMS[formType])
    if (section.fields.length) await call("workflow.saveFormSection", projectId, section.key, fillSection(section.fields));
}

const item = (ownerId: string, stage: string, key: string) => `${ownerId}|${stage}|${key}`;

/** Ticks every stored item of a checklist. */
export async function tickAll(call: Call, key: keyof typeof CHECKLISTS, ownerId: string): Promise<void> {
  const def = CHECKLISTS[key];
  for (const i of def.items)
    if (!i.auto) await call("workflow.setChecklistItem", item(ownerId, def.stage, i.key), { done: true, note: "" });
}

/** A session through Pre-production into Production: rows, call sheet, gear, rehearsal. */
export async function prepareSession(call: Call, projectId: string, date: string, planned: string[], gear: string[]): Promise<string> {
  const session = (await call("workflow.createSession", projectId, { scheduledDate: date, venue: "DOF Studio A" })).id as string;
  for (const p of planned) await call("workflow.addLogRow", session, { plannedEpisodeId: p });
  await call("workflow.resetRunSheet", session);
  const sheet = await call("workflow.createSessionCallSheet", session);
  await call(
    "equipment.addGearToSheet",
    { id: sheet.id, contentId: sheet.contentId, date: sheet.date },
    gear.map((equipmentId) => ({ equipmentId, quantity: 1 })),
  );
  await call("callsheets.finalizeCallSheet", sheet.id);
  await tickAll(call, "preSession", session);
  await call("workflow.openSession", session);
  return session;
}

export interface WalkResult {
  project: string;
  session1: string;
  session2: string;
  episodes: string[];
}

export async function walkWhispersOfWhy(call: Call, read: Read): Promise<WalkResult> {
  // ── Development ──
  const season = await call("workflow.createWorkflowProject", { category: "series", title: "Whispers of Why", seriesType: "podcast" });
  const project = season.contentId as string;
  assert.match(project, /^DOF-SER-\d{3}-S1$/, "the season is the project, with the app's own Content ID");
  for (let n = 1; n <= 30; n++)
    await call("workflow.addPlannedEpisode", project, { workingTitle: `Why, number ${n}?`, details: { targetMinutes: "58" } });
  await completeForm(call, project, "podcast");
  for (const key of CRITERIA.map((c) => c.key)) await call("workflow.setCriterion", project, key, { met: true, note: "" });
  await call("workflow.setReviewWindow", project, addDaysIso(todayIso(), 7));
  // The theological review is of the Show Brief, as a document: its reviewer named, then one approval for the whole.
  const brief = (await call("documents.ensureDocument", project, "Development", "show_brief", null)).id as string;
  await call("documents.setDocumentReviewers", brief, [PRODUCER]);
  await call("documents.decideDocumentReview", brief, { status: "approved", note: "" });
  await call("workflow.decideGreenlight", project, { outcome: "Greenlight", notes: "The team reviewed the message together." });
  await call("workflow.assignProducer", project, PRODUCER); // Operations names the producer
  await tickAll(call, "handoff", project);
  await call("workflow.advanceProject", project);

  // ── Pre-production: roles and the project's own checklist ──
  for (const [role, who] of [
    ["director", "DOF-P-CRW-001"],
    ["dop", "DOF-P-CRW-002"],
    ["audio_engineer", "DOF-P-CRW-003"],
    ["editor", "DOF-P-CRW-001"],
  ] as const)
    await call("workflow.assignRole", project, role, { crewId: who });
  await call("workflow.assignRole", project, "host_guest", { crewId: PRODUCER });
  await call("workflow.assignRole", project, "host_guest", { guestName: "Pastor James Mwangi" });
  await tickAll(call, "preProject", project);

  // ── Session 1 ──
  const plannedId = (n: number) => `${project}-P${String(n).padStart(2, "0")}`;
  const day1 = addDaysIso(todayIso(), 30);
  const session1 = await prepareSession(call, project, day1, [1, 2, 3, 4, 5].map(plannedId), ["DOF-EQ-CAM-001", "DOF-EQ-AUD-001"]);
  const pickupNote = `Pickup booked for ${addDaysIso(day1, 3)}: re-record the closing minute. Audio dropout at 41:20.`;
  const statuses: [number, string, string][] = [
    [1, "Recorded", "Clean take."],
    [2, "Recorded", "Camera B soft focus 12:10 to 12:40."],
    [3, "Pickup needed", pickupNote],
    [4, "Not recorded", "Guest ill. Move to session 2."],
    [5, "Recorded", "Runs 66 minutes."],
  ];
  for (const [n, status, notes] of statuses)
    await call("workflow.updateLogRow", `${session1}|${plannedId(n)}`, { status, notesForPost: notes });
  await call("workflow.updateSession", session1, { dailyLog: "Recorded 1, 2, 3 and 5. Episode 4's guest was ill." });
  await tickAll(call, "wrap", session1);
  const closed = await call("workflow.closeSession", session1);
  assert.deepEqual(
    closed.made,
    [1, 2, 3, 4].map((n) => `${project}-E0${n}`),
    "four episodes from five rows",
  );

  let db = await read();
  const eps = () => db.records.filter((r) => r.episode && r.parentId === project && !r.archived);
  assert.deepEqual(
    eps().map((e) => [e.contentId, e.episode!.plannedEpisodeId]),
    [
      [`${project}-E01`, plannedId(1)],
      [`${project}-E02`, plannedId(2)],
      [`${project}-E03`, plannedId(3)],
      [`${project}-E04`, plannedId(5)],
    ],
  );
  assert.equal(eps()[2].episode!.productionNotes, pickupNote, "the pickup's dated note is carried over");
  assert.equal(db.recordingSessions.find((s) => s.id === session1)!.status, "Closed");
  assert.equal(
    db.reviewCheckpoints.filter((c) => c.episodeId?.startsWith(`${project}-E`) && c.status === "Pending").length,
    8,
    "rough cut and final checkpoints for each, Pending",
  );

  // ── E01 through review, marketing and publishing ──
  const e01 = `${project}-E01`;
  await call("workflow.startEditing", e01);
  await call("workflow.setEpisodeLinks", e01, { reviewLink: REVIEW_LINK });
  await call("workflow.setReadyForReview", e01, true);
  await call("workflow.sendForReview", e01);
  await call("workflow.decideCheckpoint", `${e01}|rough_cut`, { status: "Approved", note: "" });
  await call("workflow.setEpisodeLinks", e01, { finalFileLink: FINAL_LINK });
  await call("workflow.decideCheckpoint", `${e01}|final`, { status: "Approved", note: "" });
  await call("workflow.moveToMarketing", e01);
  await tickAll(call, "release", e01);
  await call("workflow.approveReleasePlan", e01);
  await call("workflow.addDistribution", e01, {
    platform: "YouTube",
    status: "Published",
    link: "https://youtu.be/wow-e01",
    date: todayIso(),
  });
  await call("workflow.publishEpisode", e01);
  db = await read();
  assert.equal(db.records.find((r) => r.contentId === e01)!.episode!.mdStage, "Published");

  // ── Session 2: P04, held over, and the next four. Numbering carries on. ──
  const session2 = await prepareSession(call, project, addDaysIso(day1, 7), [4, 6, 7, 8, 9].map(plannedId), [
    "DOF-EQ-CAM-002",
    "DOF-EQ-AUD-002",
  ]);
  for (const n of [4, 6, 7, 8, 9])
    await call("workflow.updateLogRow", `${session2}|${plannedId(n)}`, { status: "Recorded", notesForPost: "" });
  await tickAll(call, "wrap", session2);
  const closed2 = await call("workflow.closeSession", session2);
  assert.deepEqual(
    closed2.made,
    [5, 6, 7, 8, 9].map((n) => `${project}-E0${n}`),
    "session 2 continues at E05, in plan order",
  );
  db = await read();
  const numbers = eps().map((e) => e.episode!.episodeNumber);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9], "no gaps, no repeats");
  assert.equal(eps().find((e) => e.contentId === `${project}-E05`)!.episode!.plannedEpisodeId, plannedId(4), "the held-over episode");
  return { project, session1, session2, episodes: eps().map((e) => e.contentId) };
}
