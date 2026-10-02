import type {
  CallSheet,
  ChecklistOwner,
  ContentRecord,
  CriterionKey,
  Database,
  DevelopmentForm,
  EpisodeInfo,
  LogStatus,
  PlannedEpisode,
  ProjectRole,
  RecordingSession,
  ReviewCheckpoint,
  RoleKey,
  SessionLogEntry,
  WorkflowChecklistItem,
} from "../types";
import { CHECKLISTS, CRITERIA, type ChecklistKey } from "../config/workflow";
import { buildSeed, isoDay, rec } from "./seed";
import { episodeCode, plannedEpisodeId, sessionCode, syncRecordCounters, syncWorkflowCounters } from "./ids";

// Sample data for the five-stage workflow, built as plain data: the people, gear and settings of the demo,
// and three projects that use the workflow. It is what the tests start from, and how the demo will look once
// it uses the workflow.
//
// "Whispers of Why", Season 1 (DOF-SER-001-S1, the brief's WOW-S1): a podcast of 30 planned episodes, about
// 58 minutes each, in six recording sessions of five. With `through: "development"` it is a fresh pitch with its
// planned episodes and nothing else. With `through: "session1"` (the default) it has been greenlit, has a
// producer and a crew, and its first session has closed: of five rows, three were Recorded, one needs a pickup
// and one was Not recorded, so four episodes exist, numbered E01 to E04 in the order they were made.

const HOP = "DOF-P-HOP-001";
const PRODUCER = "DOF-P-CRW-004"; // Ruth Jepkorir
const at = new Date().toISOString();

const QUESTIONS = [
  "Why do we doubt?",
  "Why is faith quiet?",
  "Why wait?",
  "Why forgive?",
  "Why pray if God knows?",
  "Why do good people suffer?",
  "Why rest?",
  "Why give?",
  "Why gather?",
  "Why confess?",
  "Why hope?",
  "Why serve?",
  "Why fast?",
  "Why lament?",
  "Why sing?",
  "Why read slowly?",
  "Why stay?",
  "Why tell the truth?",
  "Why welcome strangers?",
  "Why grieve?",
  "Why work?",
  "Why marry?",
  "Why stay single?",
  "Why trust leaders?",
  "Why question?",
  "Why baptise?",
  "Why break bread?",
  "Why bless?",
  "Why go?",
  "Why begin again?",
];

const criteria = (met: boolean | null): DevelopmentForm["criteria"] =>
  Object.fromEntries(CRITERIA.map((c) => [c.key, { met, note: "" }])) as Record<CriterionKey, { met: boolean | null; note: string }>;

function form(contentId: string, formType: DevelopmentForm["formType"], sections: DevelopmentForm["sections"]): DevelopmentForm {
  return {
    id: contentId,
    contentId,
    formType,
    sections,
    greenlightStage: formType === "documentary_dof" ? 1 : null,
    criteria: criteria(null),
    outcome: null,
    reviewNotes: "",
    decisionDate: null,
    reviewWindowDate: isoDay(10),
    decisions: [],
    createdAt: at,
    updatedAt: at,
  };
}

const planned = (projectId: string, n: number, workingTitle: string, details: Record<string, string> = {}): PlannedEpisode => ({
  id: plannedEpisodeId(projectId, n),
  contentId: projectId,
  episodeNumber: n,
  workingTitle,
  question: workingTitle,
  guest: "",
  notes: "",
  details,
  reservedId: null,
  sourcePageId: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  archivedReason: null,
});

const checkpoint = (
  contentId: string,
  episodeId: string | null,
  key: ReviewCheckpoint["checkpoint"],
  approved: boolean,
): ReviewCheckpoint => ({
  id: `${episodeId ?? contentId}|${key}`,
  contentId,
  episodeId,
  checkpoint: key,
  reviewerIds: [PRODUCER],
  status: approved ? "Approved" : "Pending",
  note: "",
  decidedAt: approved ? at : null,
  decidedById: approved ? PRODUCER : null,
  createdAt: at,
  updatedAt: at,
});

/** Every manual item of one checklist, ticked or not. Automatic items are worked out from the data, never stored. */
function checklist(key: ChecklistKey, ownerType: ChecklistOwner, ownerId: string, done: boolean): WorkflowChecklistItem[] {
  const def = CHECKLISTS[key];
  return def.items
    .filter((i) => !i.auto)
    .map((i) => ({
      id: `${ownerId}|${def.stage}|${i.key}`,
      ownerType,
      ownerId,
      stage: def.stage,
      itemKey: i.key,
      label: i.label,
      required: i.required,
      done,
      note: "",
      doneAt: done ? at : null,
      doneById: done ? PRODUCER : null,
      createdAt: at,
      updatedAt: at,
    }));
}

const session = (projectId: string, n: number, date: string, status: RecordingSession["status"]): RecordingSession => ({
  id: sessionCode(projectId, n),
  contentId: projectId,
  sessionNumber: n,
  scheduledDate: date,
  venue: "DOF Studio A",
  status,
  closedAt: status === "Closed" ? at : null,
  callSheetId: null,
  runSheet: [],
  dailyLog: "",
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  archivedReason: null,
});

const role = (projectId: string, key: RoleKey, crewId: string | null, guestName = "", n = 0): ProjectRole => ({
  id: key === "host_guest" ? `${projectId}|host_guest|g${n}` : `${projectId}|${key}`,
  contentId: projectId,
  roleKey: key,
  exclusive: key !== "host_guest",
  crewId,
  guestName,
  assignedById: PRODUCER,
  assignedAt: at,
  createdAt: at,
  updatedAt: at,
});

function episodeInfo(n: number, plannedId: string, sessionId: string, notes: string): EpisodeInfo {
  return {
    episodeNumber: n,
    plannedEpisodeId: plannedId,
    sourceSessionId: sessionId,
    productionNotes: notes,
    stage: "Post production",
    postStage: "Not started",
    roughCutStatus: "Pending",
    finalReviewStatus: "Pending",
    editorId: null,
    readyForReview: false,
    reviewLink: "",
    finalFileLink: "",
    sendBackReason: null,
    mdStage: "Release plan",
    distribution: [],
    learningNotes: "",
  };
}

export interface WorkflowFixtureOptions {
  through?: "development" | "session1";
}

export function buildWorkflowFixture(options: WorkflowFixtureOptions = {}): Database {
  const through = options.through ?? "session1";
  const seed = buildSeed();
  // The demo's people, gear, drives and settings, and none of its projects or anything attached to them.
  const db: Database = {
    ...seed,
    members: [],
    records: [],
    callSheets: [],
    comments: [],
    audit: [],
    manifests: [],
    incidents: [],
    allocations: [],
    docs: [],
    docRevisions: [],
    outbox: [],
    equipmentHistory: seed.equipmentHistory.filter((h) => h.contentId === null),
    counters: Object.fromEntries(Object.entries(seed.counters).filter(([k]) => !k.startsWith("record:") && k !== "callsheet")),
  };

  // ── Whispers of Why, Season 1 ──
  const series = rec({ contentId: "DOF-SER-001", title: "Whispers of Why", category: "series", parentId: null, level: 0, stage: null });
  series.seriesType = "podcast";
  const wow = rec({
    contentId: "DOF-SER-001-S1",
    title: "Season 1",
    category: "series",
    parentId: series.contentId,
    level: 1,
    stage: null,
  });
  const greenlit = through === "session1";
  wow.workflow = {
    formType: "podcast",
    status: greenlit ? "Active" : "Development",
    stage: greenlit ? "Pre-production" : "Development",
    showProducerId: greenlit ? PRODUCER : null,
    producerAssignedById: greenlit ? HOP : null,
    producerAssignedAt: greenlit ? at : null,
    sermonFormat: null,
    migrated: false,
  };
  wow.stageDeadlines = { Development: isoDay(greenlit ? -14 : 14), "Pre-production": isoDay(greenlit ? 7 : 30) };
  db.records.push(series, wow);
  db.members.push({ personId: PRODUCER, projectContentId: series.contentId, roleOnProject: "Show producer", canComment: true });

  const wowForm = form(wow.contentId, "podcast", {
    entry: {
      category: "series",
      initiatedBy: "DOF",
      dateReceived: isoDay(-30),
      ownerId: PRODUCER,
      mandate: "A season of honest questions about faith, one guest at a time.",
    },
    brief: {
      workingTitle: "Whispers of Why",
      logline: "Thirty quiet conversations about the questions people of faith are afraid to ask out loud.",
      targetAudience: "Young adults in and around the church",
      formatDuration: "Audio and video podcast, about 58 minutes",
      coreQuestion: "Can honest doubt sit inside real faith?",
    },
  });
  if (greenlit) {
    wowForm.criteria = criteria(true);
    wowForm.outcome = "Greenlight";
    wowForm.reviewNotes = "The team reviewed the message together. Approved.";
    wowForm.decisionDate = isoDay(-20);
    wowForm.decisions = [{ stage: 1, outcome: "Greenlight", notes: wowForm.reviewNotes, date: isoDay(-20), byPersonId: HOP, at }];
  }
  db.developmentForms.push(wowForm);
  QUESTIONS.forEach((q, i) => db.plannedEpisodes.push(planned(wow.contentId, i + 1, q, { targetMinutes: "58" })));
  db.reviewCheckpoints.push(
    checkpoint(wow.contentId, null, "pitch", greenlit),
    checkpoint(wow.contentId, null, "outline_script", greenlit),
  );

  if (greenlit) {
    db.workflowChecklistItems.push(
      ...checklist("handoff", "project", wow.contentId, true),
      ...checklist("preProject", "project", wow.contentId, true),
    );
    db.projectRoles.push(
      role(wow.contentId, "director", "DOF-P-CRW-001"),
      role(wow.contentId, "dop", "DOF-P-CRW-002"),
      role(wow.contentId, "audio_engineer", "DOF-P-CRW-003"),
      role(wow.contentId, "editor", "DOF-P-CRW-001"),
      role(wow.contentId, "host_guest", PRODUCER, "", 1),
      role(wow.contentId, "host_guest", null, "Pastor James Mwangi", 2),
    );
    // Six sessions of five episodes, a week apart. The first has been recorded and closed.
    for (let n = 1; n <= 6; n++)
      db.recordingSessions.push(session(wow.contentId, n, isoDay(-7 + (n - 1) * 7), n === 1 ? "Closed" : "Planned"));
    const r01 = db.recordingSessions[0];
    const sheet: CallSheet = {
      id: "DOF-CS-001",
      contentId: series.contentId,
      title: `Whispers of Why: ${r01.id}`,
      date: r01.scheduledDate!,
      location: r01.venue,
      callTime: "07:00",
      linkedEpisodeIds: [],
      crewPersonIds: ["DOF-P-CRW-001", "DOF-P-CRW-002", "DOF-P-CRW-003", PRODUCER],
      equipmentIds: [],
      runOfShow: [],
      format: "Podcast, five episodes",
      notes: "",
      status: "final",
      version: 2,
      createdAt: at,
    };
    db.callSheets.push(sheet);
    db.counters.callsheet = 1;
    r01.callSheetId = sheet.id;
    r01.dailyLog = "Recorded episodes 1, 2, 3 and 5. Episode 4's guest was ill.";
    db.workflowChecklistItems.push(...checklist("preSession", "session", r01.id, true), ...checklist("wrap", "session", r01.id, true));

    const rows: [number, LogStatus, string][] = [
      [1, "Recorded", "Clean take. Good energy in the last ten minutes."],
      [2, "Recorded", "Camera B lost focus 12:10 to 12:40; use camera A there."],
      [3, "Pickup needed", `Pickup booked for ${isoDay(-3)}: re-record the closing minute. Audio dropout at 41:20.`],
      [4, "Not recorded", "Guest ill. Move to session 2."],
      [5, "Recorded", "Runs 66 minutes; trim in the edit."],
    ];
    let made = 0;
    for (const [n, status, notes] of rows) {
      const plannedId = plannedEpisodeId(wow.contentId, n);
      const row: SessionLogEntry = {
        id: `${r01.id}|${plannedId}`,
        sessionId: r01.id,
        plannedEpisodeId: plannedId,
        itemLabel: "",
        logDate: r01.scheduledDate!,
        guest: n % 2 ? "Pastor James Mwangi" : "",
        status,
        notesForPost: notes,
        createdAt: at,
        updatedAt: at,
      };
      db.sessionLogEntries.push(row);
      if (status === "Not recorded") continue;
      made++;
      const ep: ContentRecord = rec({
        contentId: episodeCode(wow.contentId, made),
        title: QUESTIONS[n - 1],
        category: "series",
        parentId: wow.contentId,
        level: 2,
        stage: null,
        scheduled: -7,
      });
      ep.episode = episodeInfo(made, plannedId, r01.id, notes);
      ep.stageDeadlines = { "Post production": isoDay(14), "Marketing and distribution": isoDay(28) };
      db.records.push(ep);
      db.reviewCheckpoints.push(
        checkpoint(wow.contentId, ep.contentId, "rough_cut", false),
        checkpoint(wow.contentId, ep.contentId, "final", false),
      );
    }
    db.shareLinks.push({
      id: "SL-fixture0001",
      episodeId: episodeCode(wow.contentId, 1),
      token: "V2hpc3BlcnNPZldoeUUwMQ",
      targetUrl: "https://www.youtube.com/watch?v=dofWOWe01",
      createdById: PRODUCER,
      createdAt: at,
      revokedAt: null,
      sharedWithNote: "",
    });
    const e01 = db.records.find((r) => r.contentId === episodeCode(wow.contentId, 1))!;
    e01.episode!.reviewLink = "https://www.youtube.com/watch?v=dofWOWe01";
  }

  // ── A devotion: one guest's five days ──
  const dev = rec({
    contentId: "DOF-DEV-001",
    title: "Morning Light: Grace in the Ordinary",
    category: "devotional",
    parentId: null,
    level: 0,
    stage: null,
  });
  dev.workflow = {
    formType: "devotion",
    status: "Development",
    stage: "Development",
    showProducerId: null,
    producerAssignedById: null,
    producerAssignedAt: null,
    sermonFormat: null,
    migrated: false,
  };
  db.records.push(dev);
  db.developmentForms.push(
    form(dev.contentId, "devotion", {
      entry: { category: "devotional", initiatedBy: "DOF", dateReceived: isoDay(-5), theme: "Grace in the ordinary" },
      guest: { name: "Rev. Mary Wanjiku", invitedBy: PRODUCER, availableAllFiveDays: "yes", where: "studio" },
    }),
  );
  const days = [
    ["Psalm 118:24", "Today is a gift", "Name one ordinary gift before noon."],
    ["Lamentations 3:22-23", "Mercy is new", "Begin again where yesterday ended badly."],
    ["Colossians 3:17", "Work as worship", "Offer one task to God by name."],
    ["Matthew 6:34", "One day at a time", "Leave tomorrow's worry for tomorrow."],
    ["Psalm 4:8", "Rest is trust", "End the day by handing it back."],
  ];
  days.forEach(([scripture, keyThought, application], i) =>
    db.plannedEpisodes.push(planned(dev.contentId, i + 1, `Day ${i + 1}: ${keyThought}`, { scripture, keyThought, application })),
  );
  db.reviewCheckpoints.push(checkpoint(dev.contentId, null, "pitch", false), checkpoint(dev.contentId, null, "outline_script", false));

  // ── A DOF-made documentary, at its first greenlight ──
  const doc = rec({ contentId: "DOF-DOC-001", title: "Samburu Stories", category: "documentary", parentId: null, level: 0, stage: null });
  doc.workflow = {
    formType: "documentary_dof",
    status: "Development",
    stage: "Development",
    showProducerId: null,
    producerAssignedById: null,
    producerAssignedAt: null,
    sermonFormat: null,
    migrated: false,
  };
  db.records.push(doc);
  db.developmentForms.push(
    form(doc.contentId, "documentary_dof", {
      entry: { category: "documentary", initiatedBy: "DOF", mandate: "Tell the story of faith among Samburu herders, in their words." },
      brief: {
        workingTitle: "Samburu Stories",
        thesis: "Faith travels with the herd: it is practised on the move, not only in buildings.",
      },
    }),
  );
  db.reviewCheckpoints.push(checkpoint(doc.contentId, null, "pitch", false), checkpoint(doc.contentId, null, "outline_script", false));

  syncRecordCounters(db);
  syncWorkflowCounters(db);
  return db;
}
