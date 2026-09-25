import type { ContentRecord, Database, DocRecord, DocRevision } from "../types";
import { MUSIC_STAGE_MAP, categoryOf } from "../config/categories";
import { templateOf } from "../config/docTemplates";

// Upgrades saved data from version 2 to 3. It only touches plain data, so it can run while the
// store is loading. It is safe to run twice: anything already present is left alone.

const isoPlus = (base: string, days: number): string => {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

/** Music moved to a new set of stages. Maps where each saved item now sits. */
function remapMusic(r: ContentRecord): void {
  if (r.category !== "music" || !r.pipelineStage) return;
  const stages = categoryOf("music").stages.map((s) => s.name);
  if (stages.includes(r.pipelineStage) && Object.keys(r.stageOutputs).every((k) => stages.includes(k))) return;
  const oldCurrent = r.pipelineStage;
  const newCurrent = MUSIC_STAGE_MAP[oldCurrent] ?? "Idea";
  const idx = stages.indexOf(newCurrent);
  const oldOutput = !!r.stageOutputs[oldCurrent];
  const oldDue = r.stageDeadlines[oldCurrent] ?? r.deadline ?? new Date().toISOString().slice(0, 10);
  r.pipelineStage = newCurrent;
  r.stageOutputs = Object.fromEntries(stages.map((s, i) => [s, i < idx ? true : i === idx ? oldOutput : false]));
  r.stageDeadlines = Object.fromEntries(stages.map((s, i) => [s, i === idx ? oldDue : isoPlus(oldDue, (i - idx) * 4)]));
}

export function upgradeToV3(db: Database): Database {
  db.docs ??= [];
  db.docRevisions ??= [];
  db.counters ??= {};
  for (const r of db.records) {
    remapMusic(r);
    r.stageAssignees ??= (r.pipelineStage && r.assigneePersonId ? { [r.pipelineStage]: r.assigneePersonId } : {}) as unknown as ContentRecord["stageAssignees"]; // the old one-owner shape, converted in version 6
    r.tasks ??= [];
    r.links ??= [];
    r.productionLevel ??= null;
    // Give the stage an item is in its default checklist, so nothing is left without one.
    const def = r.pipelineStage ? categoryOf(r.category).stages.find((s) => s.name === r.pipelineStage) : undefined;
    if (def?.tasks && !r.tasks.some((t) => t.stage === def.name)) {
      for (const label of def.tasks) {
        db.counters.task = (db.counters.task ?? 0) + 1;
        r.tasks.push({ id: `T-${String(db.counters.task).padStart(4, "0")}`, stage: def.name, label, done: false, dueDate: r.stageDeadlines[def.name] ?? null, assigneePersonId: null, doneAt: null, doneBy: null });
      }
    }
    // Attach the documents the current stage calls for, once.
    for (const key of def?.docs ?? []) {
      const tpl = templateOf(key);
      if (!tpl || db.docs.some((d) => d.contentId === r.contentId && d.templateKey === key)) continue;
      db.counters.doc = (db.counters.doc ?? 0) + 1;
      db.counters.docrev = (db.counters.docrev ?? 0) + 1;
      const now = new Date().toISOString();
      const doc: DocRecord = { id: `DOF-DCS-${String(db.counters.doc).padStart(3, "0")}`, contentId: r.contentId, title: `${tpl.title}: ${r.title}`, body: tpl.body, templateKey: key, stage: def!.name, version: 1, createdBy: "DOF-P-HOP-001", createdAt: now, updatedAt: now, updatedBy: "DOF-P-HOP-001", archived: false };
      const rev: DocRevision = { id: `REV-${String(db.counters.docrev).padStart(5, "0")}`, docId: doc.id, version: 1, at: now, byPersonId: "DOF-P-HOP-001", title: doc.title, body: doc.body, note: "Created from template" };
      db.docs.push(doc);
      db.docRevisions.push(rev);
    }
  }
  for (const c of db.callSheets) c.runOfShow ??= [];
  db.schemaVersion = 3;
  return db;
}

/**
 * Version 4: a deleted project used to leave its drive entries, documents, reserved gear and call
 * sheets behind. This clears what was left over from projects that were already deleted.
 */
export function upgradeToV4(db: Database): Database {
  const gone = new Set(db.records.filter((r) => r.archived).map((r) => r.contentId));
  if (gone.size) {
    db.allocations = db.allocations.filter((a) => !gone.has(a.contentId));
    for (const d of db.docs) if (gone.has(d.contentId)) d.archived = true;
    for (const m of db.manifests) {
      if (!gone.has(m.contentId) || m.status !== "assigned") continue;
      m.status = "released";
      db.counters.history = db.counters.history ?? 0;
      for (const l of m.lines) {
        db.counters.history += 1;
        db.equipmentHistory.push({ id: `H-${String(db.counters.history).padStart(5, "0")}`, equipmentId: l.equipmentId, at: new Date().toISOString(), kind: "released", detail: `Released: ${m.contentId} was deleted`, byPersonId: "DOF-P-HOP-001", contentId: m.contentId, manifestId: m.id });
      }
    }
    const droppedSheets = new Set(db.callSheets.filter((c) => gone.has(c.contentId)).map((c) => c.id));
    db.callSheets = db.callSheets.filter((c) => !droppedSheets.has(c.id));
    for (const m of db.manifests) if (m.callSheetId && droppedSheets.has(m.callSheetId)) m.callSheetId = null;
    // Today's storage figure follows, so the forecast does not count files that were cleared.
    const used = db.drives.reduce((n, d) => n + d.otherUsedGB, 0) + db.allocations.reduce((n, a) => n + a.sizeGB, 0);
    const capacity = db.drives.reduce((n, d) => n + d.capacityGB, 0);
    const today = new Date().toISOString().slice(0, 10);
    const snap = db.snapshots.find((s) => s.date === today);
    if (snap) Object.assign(snap, { usedGB: used, capacityGB: capacity });
    else db.snapshots.push({ date: today, usedGB: used, capacityGB: capacity });
  }
  db.schemaVersion = 4;
  return db;
}

/**
 * Version 5: a live show is made of days. A live show saved as a single flat item becomes a show with
 * one day, and everything that belonged to its pipeline moves to that day. New fields get defaults.
 */
export function upgradeToV5(db: Database): Database {
  for (const r of db.records) {
    r.featured ??= [];
    r.showStart ??= null;
    r.showEnd ??= null;
  }
  const flat = db.records.filter((r) => r.category === "live" && r.hierarchyLevel === 0 && r.pipelineStage !== null && !db.records.some((c) => c.parentId === r.contentId));
  for (const r of flat) {
    const id = `${r.contentId}-D1`;
    const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    const day: ContentRecord = {
      ...copy(r),
      contentId: id,
      title: "Day 1",
      parentId: r.contentId,
      hierarchyLevel: 1,
      featured: [],
      showStart: null,
      showEnd: null,
    };
    db.records.push(day);
    r.showStart = r.showStart ?? r.scheduledDate;
    r.showEnd = r.showEnd ?? r.scheduledDate;
    Object.assign(r, { pipelineStage: null, stageOutputs: {}, stageDeadlines: {}, tasks: [], links: [], stageAssignees: {}, assigneePersonId: null, productionLevel: null, scheduledDate: null, version: r.version + 1 });
    for (const d of db.docs) if (d.contentId === r.contentId && d.stage) d.contentId = id;
    for (const c of db.callSheets) c.linkedEpisodeIds = c.linkedEpisodeIds.map((x) => (x === r.contentId ? id : x));
  }
  db.schemaVersion = 5;
  return db;
}

/**
 * Version 6: a stage can have several owners, each with roles. The single owner each stage had becomes
 * the first owner, and takes the roles they were given on the project.
 */
export function upgradeToV6(db: Database): Database {
  db.settings.workDays ??= [1, 2, 3, 4, 5];
  db.settings.effortOverrides ??= {};
  const generic = ["assigned", "team member"];
  for (const r of db.records) {
    const raw = (r.stageAssignees ?? {}) as unknown as Record<string, unknown>;
    const rootId = r.contentId.split("-").slice(0, 3).join("-");
    const next: Record<string, { personId: string; roles: string[] }[]> = {};
    for (const [stage, v] of Object.entries(raw)) {
      if (Array.isArray(v)) { next[stage] = v as { personId: string; roles: string[] }[]; continue; }
      if (typeof v !== "string") continue;
      const m = db.members.find((x) => x.personId === v && x.projectContentId === rootId);
      const roles = (m?.roleOnProject ?? "").split(",").map((x) => x.trim()).filter((x) => x && !generic.includes(x.toLowerCase()));
      next[stage] = [{ personId: v, roles }];
    }
    r.stageAssignees = next;
  }
  db.schemaVersion = 6;
  return db;
}

/** Version 7: reminders by email and text keep a record of what was sent. */
export function upgradeToV7(db: Database): Database {
  db.outbox ??= [];
  db.schemaVersion = 7;
  return db;
}

/** Version 8: a single unit (for example one of several identical cameras) can carry its own label, such as "A-cam". */
export function upgradeToV8(db: Database): Database {
  for (const item of db.equipment) (item as { unitLabel?: string | null }).unitLabel ??= null;
  db.schemaVersion = 8;
  return db;
}

/** Version 9: the live-show pipeline gets more stages (Prep, Build, Rehearse, Show, Wrap, Review, Post Production),
 *  a per-show strike checklist, a yes/no on whether a day needs post-production, and a link from a Music track
 *  or Series episode back to the live day it was recorded on. */
/**
 * Version 9: personalisation. A workspace-wide accent colour and font pairing, set by the Head of
 * Production, plus per-person font size, density and profile photo.
 */
export function upgradeToV9(db: Database): Database {
  db.settings.appearance ??= { accent: "terracotta", fontPairing: "modern" };
  for (const p of db.people) {
    (p as { photoUrl?: string | null }).photoUrl ??= null;
    (p as { fontSize?: string }).fontSize ??= "default";
    (p as { density?: string }).density ??= "comfortable";
  }
  db.schemaVersion = 9;
  return db;
}

/** Version 10: the live-show pipeline gets more stages (Prep, Build, Rehearse, Show, Wrap, Review, Post Production),
 *  a per-show strike checklist, a yes/no on whether a day needs post-production, and a link from a Music track
 *  or Series episode back to the live day it was recorded on. */
export function upgradeToV10(db: Database): Database {
  const RENAME: Record<string, string> = { Idea: "Prep", Scripting: "Build", Streaming: "Show" };
  const NEW_STAGES = ["Prep", "Build", "Rehearse", "Show", "Wrap", "Review", "Post Production"];
  for (const r of db.records) {
    (r as { spunOffFrom?: string | null }).spunOffFrom ??= null;
    (r as { postProductionNeeded?: boolean | null }).postProductionNeeded ??= null;
    (r as { strikePattern?: string | null }).strikePattern ??= null;
    (r as { strikeChecklist?: unknown }).strikeChecklist ??= null;
    if (r.category !== "live" || !r.pipelineStage) continue;
    if (r.pipelineStage in RENAME) r.pipelineStage = RENAME[r.pipelineStage];
    for (const dict of [r.stageOutputs, r.stageDeadlines] as Record<string, unknown>[]) {
      for (const [from, to] of Object.entries(RENAME)) if (from in dict) { dict[to] = dict[from]; delete dict[from]; }
      for (const s of NEW_STAGES) if (!(s in dict)) dict[s] = dict === r.stageOutputs ? false : null;
    }
    for (const t of r.tasks) if (t.stage in RENAME) t.stage = RENAME[t.stage];
    for (const [from, to] of Object.entries(RENAME)) if (from in r.stageAssignees) { r.stageAssignees[to] = r.stageAssignees[from]; delete r.stageAssignees[from]; }
  }
  db.schemaVersion = 10;
  return db;
}

/** Version 11: how long an item has sat in its current stage, for stalled-work detection, on top of the
 *  deadline-based checks that already existed. Older records get their creation date, the earliest true
 *  answer available for them. */
export function upgradeToV11(db: Database): Database {
  for (const r of db.records) (r as { stageEnteredAt?: string }).stageEnteredAt ??= r.createdAt;
  db.schemaVersion = 11;
  return db;
}

/** Version 12: Devotional got its own stage flow (Idea/Scripting/Recording/Editorial/Review/Delivered
 *  → Creation/Guest/Prep-Scripting/Recording/Editing/Review/Published), plus its Guest/Review/Closed
 *  fields. Any Devotional saved under the old names is remapped here rather than left stranded — a
 *  stage name that matches nothing in the category's current list crashes any code that indexes into
 *  it, which is exactly what slipped through the first time this shipped. */
export function upgradeToV12(db: Database): Database {
  const RENAME: Record<string, string> = { Idea: "Creation", Scripting: "Prep/Scripting", Editorial: "Editing", Delivered: "Published" };
  for (const r of db.records) {
    (r as { guestName?: string }).guestName ??= "";
    (r as { guestContact?: string }).guestContact ??= "";
    (r as { reviewerName?: string | null }).reviewerName ??= null;
    (r as { reviewApprovedAt?: string | null }).reviewApprovedAt ??= null;
    (r as { closedReason?: string | null }).closedReason ??= null;
    (r as { cardStorage?: string }).cardStorage ??= "";
    (r as { publishDate?: string | null }).publishDate ??= null;
    (r as { recordingDurationMin?: number | null }).recordingDurationMin ??= null;
    (r as { recordingNotes?: string }).recordingNotes ??= "";
    (r as { readyForReview?: boolean }).readyForReview ??= false;
    (r as { editorNotes?: string }).editorNotes ??= "";
    (r as { sendBackReason?: string | null }).sendBackReason ??= null;
    if (r.category !== "devotional" || !r.pipelineStage) continue;
    if (r.pipelineStage in RENAME) r.pipelineStage = RENAME[r.pipelineStage];
    for (const dict of [r.stageOutputs, r.stageDeadlines] as Record<string, unknown>[]) {
      for (const [from, to] of Object.entries(RENAME)) if (from in dict) { dict[to] = dict[from]; delete dict[from]; }
    }
    for (const t of r.tasks) if (t.stage in RENAME) t.stage = RENAME[t.stage];
    for (const [from, to] of Object.entries(RENAME)) if (from in r.stageAssignees) { r.stageAssignees[to] = r.stageAssignees[from]; delete r.stageAssignees[from]; }
  }
  db.schemaVersion = 12;
  return db;
}
