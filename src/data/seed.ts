import type { CategoryKey, ContentRecord, Database, DocRecord, DocRevision, Featured, Person, ProductionLevel, RoleCode, StageTask } from "../types";
import { categoryOf } from "../config/categories";
import { buildGearSeed } from "./seedGear";
import { fillTemplate, templateOf } from "../config/docTemplates";

// Demo data. Dates are relative to "today" at the moment the demo data is created,
// so the dashboard always has something upcoming, due, and overdue to show.

export const isoDay = (offset = 0): string => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

const person = (personId: string, category: RoleCode, name: string, skills: string[], hasLogin: boolean): Person => ({
  personId,
  category,
  name,
  email: `${name.split(" ")[0].toLowerCase()}@dof.demo`,
  phone: "+254 700 000 000",
  skills,
  equipmentFamiliarity: [],
  hasLogin,
  status: "active",
  createdAt: isoDay(-90),
  notifyEmail: category === "CRW" || category === "HOP",
  notifySms: personId === "DOF-P-CRW-001",
});

// Build per-stage deadlines around the current stage.
const deadlinesFor = (cat: CategoryKey, current: string, currentOffset: number, stepDays = 4) => {
  const stages = categoryOf(cat).stages;
  const idx = stages.findIndex((s) => s.name === current);
  const out: Record<string, string> = {};
  stages.forEach((s, i) => (out[s.name] = isoDay(currentOffset + (i - idx) * stepDays)));
  return out;
};

// Mark every stage before `current` as having its required output.
const outputsBefore = (cat: CategoryKey, current: string) => {
  const stages = categoryOf(cat).stages;
  const idx = stages.findIndex((s) => s.name === current);
  const out: Record<string, boolean> = {};
  stages.forEach((s, i) => (out[s.name] = i < idx));
  return out;
};

interface LeafInput {
  contentId: string;
  title: string;
  category: CategoryKey;
  parentId: string | null;
  level: number;
  stage: string | null;
  stageOffset?: number;
  scheduled?: number | null;
  deadline?: number | null;
  assignee?: string | null;
  prod?: ProductionLevel;
  show?: [number, number];
  notes?: string;
  strikePattern?: "daily" | "continuous";
  strikeChecklist?: { daily: string[]; final: string[] };
}

const rec = (i: LeafInput): ContentRecord => ({
  contentId: i.contentId,
  title: i.title,
  category: i.category,
  parentId: i.parentId,
  hierarchyLevel: i.level,
  pipelineStage: i.stage,
  stageOutputs: i.stage ? outputsBefore(i.category, i.stage) : {},
  stageDeadlines: i.stage ? deadlinesFor(i.category, i.stage, i.stageOffset ?? 3) : {},
  scheduledDate: i.scheduled != null ? isoDay(i.scheduled) : null,
  startDate: isoDay(-30),
  deadline: i.deadline != null ? isoDay(i.deadline) : null,
  assigneePersonId: i.assignee ?? null,
  stageAssignees: i.stage && i.assignee ? { [i.stage]: [{ personId: i.assignee, roles: [] }] } : {},
  tasks: [],
  links: [],
  productionLevel: i.prod ?? null,
  featured: [],
  showStart: i.show ? isoDay(i.show[0]) : null,
  showEnd: i.show ? isoDay(i.show[1]) : null,
  spunOffFrom: null,
  postProductionNeeded: null,
  strikePattern: i.strikePattern ?? null,
  strikeChecklist: i.strikeChecklist ?? null,
  archived: false,
  version: 1,
  createdAt: isoDay(-30),
  notes: i.notes ?? "",
});

const loginEmail = (p: Person): string => {
  const n = parseInt(p.personId.slice(-3), 10);
  if (p.category === "HOP") return "hop@dof.demo";
  const word = { CRW: "crew", VOL: "volunteer", PTR: "partner" }[p.category];
  return `${word}${n}@dof.demo`;
};

export function buildSeed(): Database {
  const people: Person[] = [
    person("DOF-P-HOP-001", "HOP", "Head of Production", ["Producing", "Directing"], true),
    person("DOF-P-CRW-001", "CRW", "Wanjiru Kamau", ["Directing", "Editing"], true),
    person("DOF-P-CRW-002", "CRW", "Brian Otieno", ["Camera", "Lighting"], true),
    person("DOF-P-CRW-003", "CRW", "Faith Mwangi", ["Audio", "Live switching"], true),
    person("DOF-P-VOL-001", "VOL", "Joseph Kiptoo", ["Floor crew"], true),
    person("DOF-P-VOL-002", "VOL", "Grace Achieng", ["Logging", "Runner"], false),
    person("DOF-P-PTR-001", "PTR", "Partner Representative", [], true),
  ];

  const users = people
    .filter((p) => p.hasLogin)
    .map((p, i) => ({
      userId: `U-${String(i + 1).padStart(3, "0")}`,
      personId: p.personId,
      email: loginEmail(p),
      password: "demo",
      role: p.category,
      active: true,
    }));

  const gear = buildGearSeed();

  const records: ContentRecord[] = [
    // Series → Season → Episodes
    rec({ contentId: "DOF-SER-001", title: "Whispers of Why", category: "series", parentId: null, level: 0, stage: null, deadline: 60, show: [-30, 60] }),
    rec({ contentId: "DOF-SER-001-S1", title: "Season 1", category: "series", parentId: "DOF-SER-001", level: 1, stage: null, deadline: 45 }),
    rec({ contentId: "DOF-SER-001-S1-E01", title: "Why do we doubt?", category: "series", parentId: "DOF-SER-001-S1", level: 2, stage: "Editorial", stageOffset: 2, scheduled: -12, deadline: 12, assignee: "DOF-P-CRW-001" }),
    rec({ contentId: "DOF-SER-001-S1-E02", title: "Why is faith quiet?", category: "series", parentId: "DOF-SER-001-S1", level: 2, stage: "Recording", stageOffset: 2, scheduled: 2, deadline: 20, assignee: "DOF-P-CRW-002" }),
    rec({ contentId: "DOF-SER-001-S1-E03", title: "Why wait?", category: "series", parentId: "DOF-SER-001-S1", level: 2, stage: "Recording", stageOffset: 2, scheduled: 2, deadline: 26, assignee: "DOF-P-CRW-003" }),
    rec({ contentId: "DOF-SER-001-S1-E04", title: "Why forgive?", category: "series", parentId: "DOF-SER-001-S1", level: 2, stage: "Scripting", stageOffset: 5, scheduled: 9, deadline: 32, assignee: "DOF-P-CRW-001" }),
    // Flat categories
    rec({
      contentId: "DOF-LIVE-001", title: "Sunday Live Service", category: "live", parentId: null, level: 0, stage: null, show: [1, 1],
      strikePattern: "daily",
      strikeChecklist: { daily: ["Cameras and tripods", "Wireless mics and IEMs", "Stage monitors", "Switcher and stream laptop"], final: ["FOH snake and cable runs", "LED screen and truss", "House lighting rig"] },
    }),
    rec({ contentId: "DOF-LIVE-001-D1", title: "Day 1", category: "live", parentId: "DOF-LIVE-001", level: 1, stage: "Show", stageOffset: 1, scheduled: 1, deadline: 3, assignee: "DOF-P-CRW-003", prod: "large" }),
    // A five-day conference: every day is its own item with its own level, call sheet and run of show.
    rec({
      contentId: "DOF-LIVE-002", title: "Youth Conference", category: "live", parentId: null, level: 0, stage: null, show: [10, 14],
      strikePattern: "continuous",
      strikeChecklist: { daily: ["Cover cameras and lenses", "Lock instrument and mic cases", "Secure loose cabling"], final: ["Full rig: trusses, screens, staging", "FOH desk and snake", "All flight cases packed for return"] },
    }),
    rec({ contentId: "DOF-LIVE-002-D1", title: "Day 1", category: "live", parentId: "DOF-LIVE-002", level: 1, stage: "Build", stageOffset: 4, scheduled: 10, deadline: 10, prod: "large" }),
    rec({ contentId: "DOF-LIVE-002-D2", title: "Day 2", category: "live", parentId: "DOF-LIVE-002", level: 1, stage: "Build", stageOffset: 5, scheduled: 11, deadline: 11, prod: "medium" }),
    rec({ contentId: "DOF-LIVE-002-D3", title: "Day 3", category: "live", parentId: "DOF-LIVE-002", level: 1, stage: "Prep", stageOffset: 6, scheduled: 12, deadline: 12, prod: "medium" }),
    rec({ contentId: "DOF-LIVE-002-D4", title: "Day 4", category: "live", parentId: "DOF-LIVE-002", level: 1, stage: "Prep", stageOffset: 7, scheduled: 13, deadline: 13, prod: "small" }),
    rec({ contentId: "DOF-LIVE-002-D5", title: "Day 5", category: "live", parentId: "DOF-LIVE-002", level: 1, stage: "Prep", stageOffset: 8, scheduled: 14, deadline: 14, prod: "large" }),
    rec({ contentId: "DOF-DOC-001", title: "Samburu Stories", category: "documentary", parentId: null, level: 0, stage: "Ingest", stageOffset: -3, scheduled: -8, deadline: 20, assignee: "DOF-P-CRW-002", notes: "Footage from the field trip still needs checksum verification." }),
    rec({ contentId: "DOF-DEV-001", title: "Morning Light", category: "devotional", parentId: null, level: 0, stage: "Scripting", stageOffset: 0, scheduled: 4, deadline: 10, assignee: "DOF-P-CRW-001" }),
    // Music → Album → Tracks
    rec({ contentId: "DOF-MUS-001", title: "Dawn Songs", category: "music", parentId: null, level: 0, stage: null, deadline: 70 }),
    rec({ contentId: "DOF-MUS-001-A1", title: "Album 1", category: "music", parentId: "DOF-MUS-001", level: 1, stage: null, deadline: 60 }),
    rec({ contentId: "DOF-MUS-001-A1-T01", title: "First Light", category: "music", parentId: "DOF-MUS-001-A1", level: 2, stage: "Recording", stageOffset: 6, scheduled: 6, deadline: 40, assignee: "DOF-P-CRW-003" }),
    rec({ contentId: "DOF-MUS-001-A1-T02", title: "Morning Mercies", category: "music", parentId: "DOF-MUS-001-A1", level: 2, stage: "Idea", stageOffset: 4, deadline: 44, assignee: "DOF-P-CRW-001" }),
  ];

  const byId = (id: string) => records.find((r) => r.contentId === id)!;
  const task = (n: number, stage: string, label: string, done: boolean, dueOffset: number, who: string | null, doneBy: string | null = null): StageTask => ({
    id: `T-${String(n).padStart(4, "0")}`, stage, label, done, dueDate: isoDay(dueOffset), assigneePersonId: who, doneAt: done ? new Date().toISOString() : null, doneBy: done ? doneBy : null,
  });
  // Episode 1 is being edited: story is locked, the rest have owners and dates.
  const feat = (id: string, kind: Featured["kind"], name: string, note: string): Featured => ({ id, kind, name, note });
  byId("DOF-SER-001").featured = [feat("F-0001", "host", "Pastor Mary Wanjiku", "Lead pastor, hosts every episode"), feat("F-0002", "host", "Elder James Otieno", "Co-host")];
  byId("DOF-SER-001-S1-E01").featured = [feat("F-0003", "guest", "Dr. Samuel Mwangi", "Psychologist, Nairobi Counselling Centre")];
  byId("DOF-DEV-001").featured = [feat("F-0004", "host", "Rev. Grace Achieng", "")];
  byId("DOF-LIVE-001").featured = [feat("F-0005", "host", "Pastor Mary Wanjiku", "Preaching")];
  const e01 = byId("DOF-SER-001-S1-E01");
  e01.tasks = [
    task(1, "Editorial", "Story lock", true, -1, "DOF-P-CRW-001", "DOF-P-CRW-001"),
    task(2, "Editorial", "Picture lock", false, 2, "DOF-P-CRW-001"),
    task(3, "Editorial", "Sound check", false, 4, "DOF-P-CRW-003"),
    task(4, "Editorial", "Color", false, 6, "DOF-P-CRW-002"),
  ];
  // Several people can own one stage, each with the roles they do.
  e01.stageAssignees = {
    Recording: [{ personId: "DOF-P-CRW-002", roles: ["Camera operator"] }, { personId: "DOF-P-CRW-003", roles: ["Audio engineer"] }],
    Editorial: [{ personId: "DOF-P-CRW-001", roles: ["Editor"] }, { personId: "DOF-P-CRW-003", roles: ["Sound designer"] }],
    Review: [{ personId: "DOF-P-HOP-001", roles: ["Reviewer"] }],
  };
  byId("DOF-SER-001").stageAssignees = { Project: [{ personId: "DOF-P-CRW-001", roles: ["Director"] }, { personId: "DOF-P-CRW-002", roles: ["Camera operator", "Colorist"] }, { personId: "DOF-P-CRW-003", roles: ["Audio engineer"] }] };
  byId("DOF-LIVE-001").stageAssignees = { Project: [{ personId: "DOF-P-CRW-003", roles: ["Switcher / vision mixer", "Technical director"] }] };
  byId("DOF-LIVE-002").stageAssignees = { Project: [{ personId: "DOF-P-CRW-003", roles: ["Stage manager"] }] };
  e01.links = [{ id: "L-0001", stage: "Editorial", kind: "review", url: "https://drive.google.com/demo-review-e01", note: "Rough cut v2 for feedback", byPersonId: "DOF-P-CRW-001", at: new Date().toISOString() }];
  const t01 = byId("DOF-MUS-001-A1-T01");
  t01.tasks = [
    task(5, "Recording", "Audio recording", false, 6, "DOF-P-CRW-003"),
    task(6, "Recording", "Video recording", false, 7, "DOF-P-CRW-001"),
  ];

  // Documents attached at the stages items have reached, with a few saved versions of the script.
  const docs: DocRecord[] = [];
  const docRevisions: DocRevision[] = [];
  let docN = 0, revN = 0;
  const subject = (id: string) => { const r = byId(id); const p = r.parentId ? byId(r.parentId) : null; return r.category === "live" && p ? `${p.title}, ${r.title}` : r.title; };
  const mkDoc = (contentId: string, key: string, stage: string, edits: { daysAgo: number; by: string; body?: string; note?: string }[]) => {
    const tpl = templateOf(key)!;
    const at = (d: number) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(10, 0, 0, 0); return x.toISOString(); };
    const doc: DocRecord = { id: `DOF-DCS-${String(++docN).padStart(3, "0")}`, contentId, title: `${tpl.title}: ${subject(contentId)}`, body: tpl.body, templateKey: key, stage, version: 1, createdBy: "DOF-P-HOP-001", createdAt: at(30), updatedAt: at(30), updatedBy: "DOF-P-HOP-001", archived: false };
    docs.push(doc);
    docRevisions.push({ id: `REV-${String(++revN).padStart(5, "0")}`, docId: doc.id, version: 1, at: at(30), byPersonId: "DOF-P-HOP-001", title: doc.title, body: doc.body, note: "Created from template" });
    for (const e of edits) {
      doc.version += 1;
      if (e.body !== undefined) doc.body = e.body;
      doc.updatedAt = at(e.daysAgo);
      doc.updatedBy = e.by;
      docRevisions.push({ id: `REV-${String(++revN).padStart(5, "0")}`, docId: doc.id, version: doc.version, at: at(e.daysAgo), byPersonId: e.by, title: doc.title, body: doc.body, note: e.note ?? "Edited" });
    }
  };
  const scriptV1 = fillTemplate("script", { "Cold open": "A question on screen: why do we doubt?", "Scripture references": "- Mark 9:24" });
  const scriptV2 = fillTemplate("script", { "Cold open": "A question on screen: why do we doubt?", "Segment 1": "Thomas asks for proof. Three minutes, one story.", "Segment 2": "Doubt as part of faith, not the opposite of it.", "Scripture references": "- Mark 9:24" });
  const scriptV3 = fillTemplate("script", { "Cold open": "A question on screen: why do we doubt?", "Segment 1": "Thomas asks for proof. Three minutes, one story.", "Segment 2": "Doubt as part of faith, not the opposite of it.", "Scripture references": "- Mark 9:24", Approval: "- [x] Script read through\n- [x] Theology checked\n- [x] Script locked" });
  mkDoc("DOF-SER-001-S1-E01", "concept", "Idea", [{ daysAgo: 26, by: "DOF-P-CRW-001", body: fillTemplate("concept", { "Working title": "Why do we doubt?", Audience: "Young adults who grew up in church and are quietly unsure.", "Mission purpose": "Show that doubt can be an honest part of faith." }) }]);
  mkDoc("DOF-SER-001-S1-E01", "script", "Scripting", [{ daysAgo: 22, by: "DOF-P-CRW-001", body: scriptV1 }, { daysAgo: 20, by: "DOF-P-CRW-003", body: scriptV2 }, { daysAgo: 18, by: "DOF-P-CRW-001", body: scriptV3 }]);
  mkDoc("DOF-SER-001-S1-E01", "shotlist", "Pre-production", []);
  mkDoc("DOF-SER-001-S1-E01", "edit-notes", "Editorial", [{ daysAgo: 1, by: "DOF-P-CRW-001", body: fillTemplate("edit-notes", { Story: "- [x] Story locked" }) }]);
  mkDoc("DOF-SER-001-S1-E02", "concept", "Idea", []);
  mkDoc("DOF-SER-001-S1-E02", "script", "Scripting", [{ daysAgo: 6, by: "DOF-P-CRW-002" }]);
  mkDoc("DOF-LIVE-001-D1", "run-of-show", "Prep", [{ daysAgo: 4, by: "DOF-P-CRW-003" }]);
  mkDoc("DOF-LIVE-002-D1", "run-of-show", "Prep", []);
  mkDoc("DOF-LIVE-002-D2", "run-of-show", "Prep", []);
  mkDoc("DOF-DEV-001", "concept", "Idea", []);
  mkDoc("DOF-DEV-001", "script", "Scripting", []);
  mkDoc("DOF-DOC-001", "research", "Research", [{ daysAgo: 12, by: "DOF-P-CRW-002" }]);

  return {
    schemaVersion: 10,
    people,
    users,
    members: [
      { personId: "DOF-P-CRW-001", projectContentId: "DOF-SER-001", roleOnProject: "Director, Editor", canComment: true },
      { personId: "DOF-P-CRW-001", projectContentId: "DOF-DEV-001", roleOnProject: "Producer", canComment: true },
      { personId: "DOF-P-CRW-001", projectContentId: "DOF-MUS-001", roleOnProject: "Producer", canComment: true },
      { personId: "DOF-P-CRW-002", projectContentId: "DOF-SER-001", roleOnProject: "Camera operator, Colorist", canComment: true },
      { personId: "DOF-P-CRW-002", projectContentId: "DOF-DOC-001", roleOnProject: "Camera / DIT", canComment: true },
      { personId: "DOF-P-CRW-003", projectContentId: "DOF-SER-001", roleOnProject: "Audio engineer", canComment: true },
      { personId: "DOF-P-CRW-003", projectContentId: "DOF-LIVE-001", roleOnProject: "Switcher / vision mixer, Technical director", canComment: true },
      { personId: "DOF-P-CRW-003", projectContentId: "DOF-LIVE-002", roleOnProject: "Stage manager", canComment: true },
      { personId: "DOF-P-CRW-003", projectContentId: "DOF-MUS-001", roleOnProject: "Recording engineer", canComment: true },
      { personId: "DOF-P-VOL-001", projectContentId: "DOF-SER-001", roleOnProject: "Floor crew", canComment: false },
      { personId: "DOF-P-PTR-001", projectContentId: "DOF-DOC-001", roleOnProject: "Partner reviewer", canComment: true },
    ],
    records,
    callSheets: [
      {
        id: "DOF-CS-001",
        contentId: "DOF-SER-001",
        title: "Whispers of Why: Season 1 recording day",
        date: isoDay(2),
        location: "DOF Studio A",
        callTime: "08:00",
        linkedEpisodeIds: ["DOF-SER-001-S1-E02", "DOF-SER-001-S1-E03"],
        crewPersonIds: ["DOF-P-CRW-002", "DOF-P-CRW-003"],
        equipmentIds: ["DOF-EQ-CAM-001", "DOF-EQ-CAM-003", "DOF-EQ-AUD-001", "DOF-EQ-CAB-XLR10M-B01"],
        runOfShow: [],
        format: "Two-camera studio, lavalier audio",
        notes: "Wardrobe: solid colours, no stripes.",
        status: "draft",
        version: 1,
        createdAt: isoDay(-1),
      },
      {
        id: "DOF-CS-002",
        contentId: "DOF-LIVE-001",
        title: "Sunday Live Service: Day 1, full broadcast",
        date: isoDay(1),
        location: "Main auditorium",
        callTime: "07:00",
        linkedEpisodeIds: ["DOF-LIVE-001-D1"],
        crewPersonIds: ["DOF-P-CRW-003"],
        equipmentIds: [],
        runOfShow: [
          { id: "RS-0001", time: "08:30", title: "Stream opens: countdown and welcome loop", durationMin: 15, ownerPersonId: "DOF-P-CRW-003", notes: "Backup stream key ready" },
          { id: "RS-0002", time: "08:45", title: "Worship", durationMin: 30, ownerPersonId: "DOF-P-CRW-003", notes: "Lyrics on screen" },
          { id: "RS-0003", time: "09:15", title: "Announcements", durationMin: 8, ownerPersonId: null, notes: "" },
          { id: "RS-0004", time: "09:23", title: "Message", durationMin: 45, ownerPersonId: null, notes: "Cut to slides at the first scripture" },
          { id: "RS-0005", time: "10:08", title: "Response and close", durationMin: 12, ownerPersonId: "DOF-P-CRW-003", notes: "" },
        ],
        format: "Multi-camera broadcast with graphics",
        notes: "Sound check at 07:30.",
        status: "draft",
        version: 1,
        createdAt: isoDay(-2),
      },
    ],
    comments: [
      {
        id: "C-001",
        contentId: "DOF-DOC-001",
        callSheetId: null,
        byPersonId: "DOF-P-PTR-001",
        text: "Looking forward to seeing the rough cut. Please flag when the Samburu interviews are ready to review.",
        at: new Date().toISOString(),
      },
    ],
    audit: [],
    docs,
    docRevisions,
    outbox: [],
    ...gear,
    settings: { stageReminderHours: 24, storageWarningThreshold: 85, checkoutReturnDays: 3, workDays: [1, 2, 3, 4, 5], effortOverrides: {}, appearance: { accent: "terracotta", fontPairing: "modern" } },
    counters: { audit: 0, comment: 1, callsheet: 2, task: 6, link: 1, featured: 5, runitem: 5, doc: docN, docrev: revN, ...gear.counters },
  };
}
