import type { ContentRecord, Database, DocRecord, DocRevision, DriveAllocation, EquipCondition, EquipmentItem } from "../types";
import { MUSIC_STAGE_MAP, categoryOf } from "../config/categories";
import { templateOf } from "../config/docTemplates";
import { CHECKLISTS } from "../config/workflow";
import { SHEET_CONTENT_KEYS, blankEventPlan, blankSheetContent, blankSheetTracking } from "../config/callSheet";
import { DOCUMENT_PARTS, WORKFLOW_PARTS } from "./constraints";
import { todayIso } from "../services/utils";
import { migrateDocuments } from "./migrateDocuments";
import { logId, sessionCode, sessionCounter, syncRecordCounters } from "./ids";

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
  const oldDue = r.stageDeadlines[oldCurrent] ?? r.deadline ?? todayIso();
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
    r.stageAssignees ??= (r.pipelineStage && r.assigneePersonId
      ? { [r.pipelineStage]: r.assigneePersonId }
      : {}) as unknown as ContentRecord["stageAssignees"]; // the old one-owner shape, converted in version 6
    r.tasks ??= [];
    r.links ??= [];
    r.productionLevel ??= null;
    // Give the stage an item is in its default checklist, so nothing is left without one.
    const def = r.pipelineStage ? categoryOf(r.category).stages.find((s) => s.name === r.pipelineStage) : undefined;
    if (def?.tasks && !r.tasks.some((t) => t.stage === def.name)) {
      for (const label of def.tasks) {
        db.counters.task = (db.counters.task ?? 0) + 1;
        r.tasks.push({
          id: `T-${String(db.counters.task).padStart(4, "0")}`,
          stage: def.name,
          label,
          done: false,
          dueDate: r.stageDeadlines[def.name] ?? null,
          assigneePersonId: null,
          doneAt: null,
          doneBy: null,
        });
      }
    }
    // Attach the documents the current stage calls for, once.
    for (const key of def?.docs ?? []) {
      const tpl = templateOf(key);
      if (!tpl || db.docs.some((d) => d.contentId === r.contentId && d.templateKey === key)) continue;
      db.counters.doc = (db.counters.doc ?? 0) + 1;
      db.counters.docrev = (db.counters.docrev ?? 0) + 1;
      const now = new Date().toISOString();
      const doc: DocRecord = {
        id: `DOF-DCS-${String(db.counters.doc).padStart(3, "0")}`,
        contentId: r.contentId,
        title: `${tpl.title}: ${r.title}`,
        body: tpl.body,
        templateKey: key,
        stage: def!.name,
        version: 1,
        createdBy: "DOF-P-HOP-001",
        createdAt: now,
        updatedAt: now,
        updatedBy: "DOF-P-HOP-001",
        archived: false,
      };
      const rev: DocRevision = {
        id: `REV-${String(db.counters.docrev).padStart(5, "0")}`,
        docId: doc.id,
        version: 1,
        at: now,
        byPersonId: "DOF-P-HOP-001",
        title: doc.title,
        body: doc.body,
        note: "Created from template",
      };
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
    db.allocations = db.allocations.filter((a) => a.contentId === null || !gone.has(a.contentId));
    for (const d of db.docs) if (gone.has(d.contentId)) d.archived = true;
    for (const m of db.manifests) {
      if (!gone.has(m.contentId) || m.status !== "assigned") continue;
      m.status = "released";
      db.counters.history = db.counters.history ?? 0;
      for (const l of m.lines) {
        db.counters.history += 1;
        db.equipmentHistory.push({
          id: `H-${String(db.counters.history).padStart(5, "0")}`,
          equipmentId: l.equipmentId,
          at: new Date().toISOString(),
          kind: "released",
          detail: `Released: ${m.contentId} was deleted`,
          byPersonId: "DOF-P-HOP-001",
          contentId: m.contentId,
          manifestId: m.id,
        });
      }
    }
    const droppedSheets = new Set(db.callSheets.filter((c) => gone.has(c.contentId)).map((c) => c.id));
    db.callSheets = db.callSheets.filter((c) => !droppedSheets.has(c.id));
    for (const m of db.manifests) if (m.callSheetId && droppedSheets.has(m.callSheetId)) m.callSheetId = null;
    // Today's storage figure follows, so the forecast does not count files that were cleared.
    const used = db.drives.reduce((n, d) => n + d.otherUsedGB, 0) + db.allocations.reduce((n, a) => n + a.sizeGB, 0);
    const capacity = db.drives.reduce((n, d) => n + d.capacityGB, 0);
    const today = todayIso();
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
  const flat = db.records.filter(
    (r) =>
      r.category === "live" && r.hierarchyLevel === 0 && r.pipelineStage !== null && !db.records.some((c) => c.parentId === r.contentId),
  );
  for (const r of flat) {
    const id = `${r.contentId}-D1`;
    const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
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
    Object.assign(r, {
      pipelineStage: null,
      stageOutputs: {},
      stageDeadlines: {},
      tasks: [],
      links: [],
      stageAssignees: {},
      assigneePersonId: null,
      productionLevel: null,
      scheduledDate: null,
      version: r.version + 1,
    });
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
      if (Array.isArray(v)) {
        next[stage] = v as { personId: string; roles: string[] }[];
        continue;
      }
      if (typeof v !== "string") continue;
      const m = db.members.find((x) => x.personId === v && x.projectContentId === rootId);
      const roles = (m?.roleOnProject ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x && !generic.includes(x.toLowerCase()));
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
      for (const [from, to] of Object.entries(RENAME))
        if (from in dict) {
          dict[to] = dict[from];
          delete dict[from];
        }
      for (const s of NEW_STAGES) if (!(s in dict)) dict[s] = dict === r.stageOutputs ? false : null;
    }
    for (const t of r.tasks) if (t.stage in RENAME) t.stage = RENAME[t.stage];
    for (const [from, to] of Object.entries(RENAME))
      if (from in r.stageAssignees) {
        r.stageAssignees[to] = r.stageAssignees[from];
        delete r.stageAssignees[from];
      }
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
      for (const [from, to] of Object.entries(RENAME))
        if (from in dict) {
          dict[to] = dict[from];
          delete dict[from];
        }
    }
    for (const t of r.tasks) if (t.stage in RENAME) t.stage = RENAME[t.stage];
    for (const [from, to] of Object.entries(RENAME))
      if (from in r.stageAssignees) {
        r.stageAssignees[to] = r.stageAssignees[from];
        delete r.stageAssignees[from];
      }
  }
  db.schemaVersion = 12;
  return db;
}

/**
 * Version 13:
 *  - A batch of equipment (aggregate tracking) can have some units in one condition and some in
 *    another, for example 8 Good cables and 2 Fair, instead of one condition for the whole batch.
 *    Older batches get every active unit filed under the condition they already had.
 *  - A drive allocation can be recorded with no Content ID yet (work that started before this
 *    system, or before the project itself exists here), identified by its own id and a label
 *    instead. Older allocations, which always had a real Content ID, get an empty label.
 */
export function upgradeToV13(db: Database): Database {
  for (const item of db.equipment) {
    const it = item as EquipmentItem & { conditionBreakdown?: Partial<Record<EquipCondition, number>> | null };
    if (it.trackingType === "aggregate") it.conditionBreakdown ??= { [it.condition]: it.quantityTotal };
    else it.conditionBreakdown ??= null;
  }
  for (const a of db.allocations) (a as DriveAllocation & { label?: string }).label ??= "";
  db.schemaVersion = 13;
  return db;
}

/**
 * Version 14: project numbers come from counters, so the browser and the server always agree on the number
 * a new project gets (src/data/ids.ts). Each counter starts at the highest number already used, archived
 * projects included, so no Content ID is ever given out twice.
 */
export function upgradeToV14(db: Database): Database {
  db.counters ??= {};
  syncRecordCounters(db);
  db.schemaVersion = 14;
  return db;
}

/**
 * Version 15: the five-stage workflow for series, devotions and documentaries gets its own lists, all empty,
 * and every record gains three workflow fields, all empty. Nothing that exists is changed, moved or removed:
 * projects made before this keep their earlier pipeline until they are moved across, which is a separate step
 * with a dry run of its own.
 */
export function upgradeToV15(db: Database): Database {
  const parts = db as unknown as Record<string, unknown[] | undefined>;
  for (const k of WORKFLOW_PARTS) parts[k] ??= [];
  for (const r of db.records) {
    r.seriesType ??= null;
    r.workflow ??= null;
    r.episode ??= null;
  }
  db.schemaVersion = 15;
  return db;
}

/** Version 16 adds the lists for project documents, storyboards and shot lists, empty. Nothing else changes. */
export function upgradeToV16(db: Database): Database {
  const parts = db as unknown as Record<string, unknown[] | undefined>;
  for (const k of DOCUMENT_PARTS) parts[k] ??= [];
  for (const p of db.plannedEpisodes ?? []) p.sourcePageId ??= null;
  db.schemaVersion = 16;
  return db;
}

/**
 * Version 17: the old Development screens are gone, so every project of the workflow has its Development form in its
 * documents. The move into the documents (src/data/migrateDocuments.ts) runs for any that has not had it; a brief
 * someone had already started is left as it is, with the old form kept beside it on an "Earlier Development form".
 * Nothing on the old form is changed, and the move can be undone (undoDocumentMove). The setting that turned the
 * documents on for each kind of project is no longer read, and goes.
 */
export function upgradeToV17(db: Database): Database {
  const at = new Date().toISOString();
  const report = migrateDocuments(db, { at });
  if (report.changed) {
    const projects = report.lines.filter((l) => l.documents.length).length;
    db.audit.push({
      id: logId("A"),
      at,
      byPersonId: "system",
      action: "migrate-documents",
      entity: "system",
      entityId: "documents",
      detail: `With the old Development screens gone, the Development forms of ${projects} project${projects === 1 ? "" : "s"} moved into their documents.`,
    });
  }
  delete (db.settings as { newDocuments?: unknown }).newDocuments;
  db.schemaVersion = 17;
  return db;
}

/**
 * Version 18: a devotion's Recording Plan. Sessions gain a name, a part of the day, hours, the storyboard and shot list
 * chosen for them and the drive their footage goes on; roles gain the name and order the plan gives them; a project the
 * drive its footage is planned for; a storage entry the session whose footage it is. All empty to start.
 *
 * A devotion's call sheet that has no session (made before the workflow, or by hand in the Call Sheet module) gets one:
 * a session planned on the sheet's date, with its location as the venue, its run of show as the run sheet, and the
 * sheet itself, unchanged, as the session's call sheet. Which days it covered was never recorded, so no devotion is put
 * on it: each shows "Needs a session" until someone ticks it. Running it again changes nothing.
 */
export function upgradeToV18(db: Database): Database {
  const order = ["director", "dop", "audio_engineer", "camera_operator", "continuity", "editor", "host_guest"];
  for (const r of db.projectRoles ?? []) {
    r.label ??= "";
    r.position ??= order.indexOf(r.roleKey) < 0 ? order.length : order.indexOf(r.roleKey);
  }
  for (const r of db.records) if (r.workflow) r.workflow.storageDriveId ??= null;
  for (const a of db.allocations ?? []) a.sessionId ??= null;
  for (const ses of db.recordingSessions ?? []) {
    ses.name ??= "";
    ses.label ??= null;
    ses.startTime ??= null;
    ses.endTime ??= null;
    ses.storyboardId ??= null;
    ses.shotListId ??= null;
    ses.storageDriveId ??= null;
  }
  const at = new Date().toISOString();
  const linked = new Set((db.recordingSessions ?? []).map((x) => x.callSheetId).filter(Boolean));
  const made: string[] = [];
  for (const p of db.records) {
    if (p.workflow?.formType !== "devotion" || p.archived || p.workflow.stage !== "Pre-production") continue;
    const sheets = db.callSheets
      .filter((c) => c.contentId === p.contentId && !linked.has(c.id))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (const sheet of sheets) {
      const key = sessionCounter(p.contentId);
      const used = db.recordingSessions.filter((x) => x.contentId === p.contentId).map((x) => x.sessionNumber);
      const n = Math.max(db.counters[key] ?? 0, ...used) + 1;
      db.counters[key] = n;
      db.recordingSessions.push({
        id: sessionCode(p.contentId, n),
        contentId: p.contentId,
        sessionNumber: n,
        scheduledDate: sheet.date || null,
        venue: sheet.location,
        status: "Planned",
        closedAt: null,
        callSheetId: sheet.id,
        runSheet: sheet.runOfShow.map((item) => ({ ...item })),
        dailyLog: "",
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        archivedReason: null,
        name: sheet.title,
        label: null,
        startTime: null,
        endTime: null,
        storyboardId: null,
        shotListId: null,
        storageDriveId: null,
        fromCallSheet: true,
      });
      // The session's pre-session checklist, as a session scheduled by hand starts with.
      const list = CHECKLISTS.preSession;
      for (const item of list.items) {
        const rowId = `${sessionCode(p.contentId, n)}|${list.stage}|${item.key}`;
        if (item.auto || db.workflowChecklistItems.some((c) => c.id === rowId)) continue;
        db.workflowChecklistItems.push({
          id: rowId,
          ownerType: "session",
          ownerId: sessionCode(p.contentId, n),
          stage: list.stage,
          itemKey: item.key,
          label: item.label,
          required: item.required,
          done: false,
          note: "",
          doneAt: null,
          doneById: null,
          createdAt: at,
          updatedAt: at,
        });
      }
      linked.add(sheet.id);
      made.push(`${sessionCode(p.contentId, n)} from ${sheet.id}`);
    }
  }
  if (made.length)
    db.audit.push({
      id: logId("A"),
      at,
      byPersonId: "system",
      action: "migrate-call-sheets",
      entity: "system",
      entityId: "recording-plan",
      detail: `Devotion call sheets moved into Recording Plan sessions: ${made.join(", ")}.`,
    });
  db.schemaVersion = 18;
  return db;
}

/**
 * Version 19: one production system. Every call sheet gains the sections every sheet now has (talent, logistics,
 * contacts, technical check, rehearsal and the rest of its schedule), empty, and the day of a show it is for. A live
 * show becomes a production: one day makes it a one-time event, any other number a multi-day event, with an empty
 * Event Plan. Each day is linked to the call sheet already made for its date; a day still to come that has none gets
 * a draft sheet, so every day has its call sheet. Nothing is moved or deleted. Running it again changes nothing.
 */
export function upgradeToV19(db: Database): Database {
  db.showTemplates ??= [];
  const blank = blankSheetContent();
  for (const cs of db.callSheets) {
    const sheet = cs as unknown as Record<string, unknown>;
    for (const k of SHEET_CONTENT_KEYS) if (sheet[k] === undefined) sheet[k] = structuredClone(blank[k]);
    cs.instanceId ??= null;
  }
  for (const r of db.records) {
    r.production ??= null;
    r.instance ??= null;
  }
  const today = todayIso();
  const at = new Date().toISOString();
  const made: string[] = [];
  const csNumbers = db.callSheets.map((c) => Number(/^DOF-CS-(\d+)$/.exec(c.id)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n));
  let csNext = Math.max(db.counters.callsheet ?? 0, ...csNumbers);
  for (const show of db.records.filter((r) => r.category === "live" && r.hierarchyLevel === 0)) {
    const days = db.records.filter((r) => r.parentId === show.contentId && r.hierarchyLevel === 1);
    if (!show.production) {
      const oneDay = days.filter((d) => !d.archived).length === 1;
      show.production = { mode: oneDay ? "one_time" : "multi_day", templateId: null, eventPlan: oneDay ? null : blankEventPlan() };
    }
    for (const day of days) {
      const sheets = db.callSheets.filter((c) => c.contentId === show.contentId);
      if (sheets.some((c) => c.instanceId === day.contentId)) continue;
      const found = sheets
        .filter(
          (c) =>
            c.instanceId === null && (c.linkedEpisodeIds.includes(day.contentId) || (!!day.scheduledDate && c.date === day.scheduledDate)),
        )
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (found) {
        found.instanceId = day.contentId;
        continue;
      }
      if (day.archived || !day.scheduledDate || day.scheduledDate < today) continue;
      csNext += 1;
      const id = `DOF-CS-${String(csNext).padStart(3, "0")}`;
      db.callSheets.push({
        ...blankSheetContent(),
        ...blankSheetTracking(),
        id,
        contentId: show.contentId,
        title: `${show.title}: ${day.scheduledDate}`,
        date: day.scheduledDate,
        callTime: "08:00",
        linkedEpisodeIds: [day.contentId],
        equipmentIds: [],
        instanceId: day.contentId,
        status: "draft",
        version: 1,
        createdAt: at,
      });
      made.push(`${id} for ${day.contentId}`);
    }
  }
  if (made.length) {
    db.counters.callsheet = csNext;
    db.audit.push({
      id: logId("A"),
      at,
      byPersonId: "system",
      action: "migrate-productions",
      entity: "system",
      entityId: "productions",
      detail: `Every day of a live show has its call sheet: made ${made.join(", ")}.`,
    });
  }
  db.schemaVersion = 19;
  return db;
}

/**
 * Version 20: call sheet improvements. Every sheet and show template gains a saved location (none), and every sheet
 * the record of who confirmed and of what changed once it was shared, both empty. A sheet already final has been
 * issued to the team, so its changes are logged from now on. The list of saved locations starts empty. Nothing is
 * moved or deleted. Running it again changes nothing.
 */
export function upgradeToV20(db: Database): Database {
  db.locations ??= [];
  const at = new Date().toISOString();
  for (const cs of db.callSheets) {
    cs.locationId ??= null;
    cs.confirmations ??= {};
    cs.changeLog ??= [];
    if (cs.sharedAt === undefined) cs.sharedAt = cs.status === "final" ? at : null;
  }
  for (const t of db.showTemplates ?? []) t.sheet.locationId ??= null;
  db.schemaVersion = 20;
  return db;
}
