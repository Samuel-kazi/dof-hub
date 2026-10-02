import type {
  CategoryKey,
  ChecklistOwner,
  CheckpointKey,
  ContentRecord,
  Database,
  DevelopmentForm,
  EpisodeInfo,
  FormType,
  PlannedEpisode,
  Person,
  RecordingSession,
  ReviewCheckpoint,
  SeriesType,
  SessionLogEntry,
  StageOwner,
  WorkflowChecklistItem,
} from "../types";
import { CHECKLISTS, CRITERIA, EPISODE_TOKEN, SERIES_TYPES, formTypeOf, type ChecklistKey } from "../config/workflow";
import { blankRecord } from "../services/content";
import { asWebUrl } from "../services/urls";
import { fmtShort } from "../services/utils";
import { codeNumber, episodeCode, logId, plannedEpisodeId, sessionCode, syncRecordCounters, syncWorkflowCounters } from "./ids";

// Moves series, devotionals and documentaries made before the five-stage workflow into it (Phase 5 of the brief).
// One function, run three ways: `npm run migrate:workflow` against MongoDB, the server's /api/migrate-workflow for
// the Head of Production on the hosted site, and the same button in the desktop app and the demo. Each runs it on
// a copy of the data first and shows the report (a dry run); applying keeps a copy of the data, then saves the
// result as one all-or-nothing change.
//
// Rules, as agreed in Phase 0 (see the phase report):
//  - Content IDs never change. A series' season becomes the project; an episode keeps its record and its ID.
//  - Series episodes at Idea or Scripting leave the season in Development; at Pre-production or later the season
//    is past Development, and the gates it passed in the earlier pipeline count as met ("migrated").
//  - An episode not recorded yet (Idea, Scripting, Pre-production, Recording) becomes a planned episode that keeps
//    the old episode's Content ID: its record waits, archived with that reason, and becomes the episode when a
//    session that recorded it closes. Recording ones go on an open session on their shoot date, with the call sheet
//    that listed them.
//  - Ingest and Editorial become Post production, Editing; Review becomes Rough cut review (when it has a review
//    link to review); Delivered becomes Marketing and distribution, Published if its delivery was confirmed.
//    Each carries "Migrated before session logging." and no source session.
//  - A devotional at Creation or Guest is in Development; at Prep/Scripting, Pre-production. Recorded ones are left
//    in the earlier pipeline and listed for a decision by hand: there is no per-day data to make five episodes from.
//    A closed one is archived with its reason.
//  - A documentary at Idea or Research is in Development, at Pre-production in Pre-production, at Shooting in
//    Production on one open session, and from Ingest on its film is episode -E01.
//  - Old fields are left as they were, read-only: the earlier pipeline's actions refuse records in the workflow.
//  - Running it again changes nothing: what is already in the workflow is left alone.

export interface WorkflowMigrationOptions {
  today: string; // YYYY-MM-DD in Nairobi, so a dry run and the real run agree
  at: string; // the time, for created and decided stamps
  byPersonId: string; // who ran it, for the activity log
  seriesTypes?: Record<string, SeriesType>; // per series Content ID; podcast unless chosen
  documentaryForms?: Record<string, "documentary_dof" | "documentary_pitched">; // per documentary; DOF-made unless chosen
}

/** What a person chooses before moving: a series' type, or that a documentary was pitched by others. */
export type MigrationChoices = Pick<WorkflowMigrationOptions, "seriesTypes" | "documentaryForms">;

export type MigrationOutcome = "moved" | "flagged" | "unchanged";

/** One line of the reconciliation report: every series, devotional and documentary record gets exactly one. */
export interface MigrationLine {
  contentId: string;
  title: string;
  category: CategoryKey;
  outcome: MigrationOutcome;
  before: string;
  after: string;
  note: string;
}

export interface WorkflowMigrationReport {
  lines: MigrationLine[];
  followUps: string[]; // to do in the app afterwards
  unexplained: string[]; // records in scope with no line; always empty, and the tests check it
  counts: { part: string; before: number; after: number }[];
  changed: boolean;
  series: { contentId: string; title: string; type: SeriesType; chosen: boolean }[]; // what a series becomes, to choose
  documentaries: { contentId: string; title: string; form: FormType; chosen: boolean }[];
}

const SCOPE: CategoryKey[] = ["series", "devotional", "documentary"];
const NOT_RECORDED = ["Idea", "Scripting", "Pre-production", "Recording"];
const POST = ["Ingest", "Editorial", "Review"];
const MIGRATED_NOTE = "Migrated before session logging.";
const MOVED_NOTE = "Moved across from the earlier pipeline.";
// The earlier pipeline's edit checklist, as the workflow's optional finer post steps (assumption A8).
const EDIT_TASK_TO_POST: Record<string, string> = {
  "Story lock": "story_lock",
  "Picture lock": "picture_lock",
  "Sound check": "sound_mix",
  Color: "color",
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const byNumber = (a: ContentRecord, b: ContentRecord): number => a.contentId.localeCompare(b.contentId, undefined, { numeric: true });

function countParts(db: Database): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(db)) if (Array.isArray(v)) out.set(k, v.length);
  return out;
}

/** Moves what can be moved, in place, and reports on every record in scope. Call it on a copy for a dry run. */
export function migrateToWorkflow(db: Database, options: WorkflowMigrationOptions): WorkflowMigrationReport {
  const { today, at } = options;
  const before = countParts(db);
  const scope = db.records.filter((r) => SCOPE.includes(r.category));
  const byId = new Map(db.records.map((r) => [r.contentId, r]));
  const people = new Map(db.people.map((p) => [p.personId, p]));
  const lines: MigrationLine[] = [];
  const followUps: string[] = [];
  const listed = new Set<string>();
  let changed = false;
  const report: WorkflowMigrationReport = { lines, followUps, unexplained: [], counts: [], changed: false, series: [], documentaries: [] };

  const line = (r: ContentRecord, outcome: MigrationOutcome, beforeText: string, after: string, note = "") => {
    if (listed.has(r.contentId)) return;
    listed.add(r.contentId);
    lines.push({ contentId: r.contentId, title: r.title, category: r.category, outcome, before: beforeText, after, note });
  };
  const childrenOf = (id: string) => db.records.filter((r) => r.parentId === id).sort(byNumber);
  const reserved = new Map(db.plannedEpisodes.filter((p) => p.reservedId).map((p) => [p.reservedId as string, p]));
  const isCrew = (id: string | null | undefined): id is string => {
    const p: Person | undefined = id ? people.get(id) : undefined;
    return !!p && p.status === "active" && (p.category === "CRW" || p.category === "HOP");
  };
  /** The first crew-list owner of a stage, preferring one with the given role. */
  const ownerOf = (r: ContentRecord, stage: string, role?: string): string | null => {
    const owners: StageOwner[] = r.stageAssignees[stage] ?? [];
    const pick =
      (role && owners.find((o) => o.roles.some((x) => x.toLowerCase() === role.toLowerCase()) && isCrew(o.personId))) ||
      owners.find((o) => isCrew(o.personId));
    return pick ? pick.personId : null;
  };
  const latestLink = (r: ContentRecord, kind: "review" | "final"): string =>
    r.links
      .filter((l) => l.kind === kind)
      .map((l) => asWebUrl(l.url))
      .filter((u): u is string => !!u)
      .pop() ?? "";

  // ── Builders, shaped as the services make them ──
  const checklist = (key: ChecklistKey, ownerType: ChecklistOwner, ownerId: string, done: (itemKey: string) => boolean): void => {
    const def = CHECKLISTS[key];
    for (const item of def.items) {
      if (item.auto) continue;
      const id = `${ownerId}|${def.stage}|${item.key}`;
      if (db.workflowChecklistItems.some((c) => c.id === id)) continue;
      const isDone = done(item.key);
      const row: WorkflowChecklistItem = {
        id,
        ownerType,
        ownerId,
        stage: def.stage,
        itemKey: item.key,
        label: item.label,
        required: item.required,
        done: isDone,
        note: isDone ? MOVED_NOTE : "",
        doneAt: isDone ? at : null,
        doneById: isDone ? "system" : null,
        createdAt: at,
        updatedAt: at,
      };
      db.workflowChecklistItems.push(row);
    }
  };
  const checkpoint = (
    contentId: string,
    episodeId: string | null,
    key: CheckpointKey,
    approved: boolean,
    reviewerIds: string[],
    note = "",
  ) => {
    const c: ReviewCheckpoint = {
      id: `${episodeId ?? contentId}|${key}`,
      contentId,
      episodeId,
      checkpoint: key,
      reviewerIds,
      status: approved ? "Approved" : "Pending",
      note: approved ? note || "Approved before the new workflow." : "",
      decidedAt: approved ? at : null,
      decidedById: approved ? "system" : null,
      createdAt: at,
      updatedAt: at,
    };
    db.reviewCheckpoints.push(c);
  };
  const form = (p: ContentRecord, formType: FormType, greenlit: 0 | 1 | 2, sections: DevelopmentForm["sections"] = {}): void => {
    const dof = formType === "documentary_dof";
    const notes = `Greenlit before the new workflow (moved across on ${fmtShort(today)}).`;
    const f: DevelopmentForm = {
      id: p.contentId,
      contentId: p.contentId,
      formType,
      sections,
      greenlightStage: dof ? (greenlit >= 1 ? 2 : 1) : null,
      criteria: Object.fromEntries(CRITERIA.map((c) => [c.key, { met: null, note: "" }])) as DevelopmentForm["criteria"],
      outcome: greenlit && (!dof || greenlit === 2) ? "Greenlight" : null,
      reviewNotes: greenlit ? notes : "",
      decisionDate: greenlit ? today : null,
      reviewWindowDate: null,
      decisions: ([1, 2] as const)
        .filter((stage) => stage <= greenlit && (dof || stage === 1))
        .map((stage) => ({ stage, outcome: "Greenlight" as const, notes, date: today, byPersonId: "system", at })),
      createdAt: at,
      updatedAt: at,
    };
    db.developmentForms.push(f);
  };
  const planned = (p: ContentRecord, n: number, title: string, reservedId: string | null, notes: string, guest = ""): PlannedEpisode => {
    const x: PlannedEpisode = {
      id: plannedEpisodeId(p.contentId, n),
      contentId: p.contentId,
      episodeNumber: n,
      workingTitle: title,
      question: "",
      guest,
      notes,
      details: {},
      reservedId,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      archivedReason: null,
    };
    db.plannedEpisodes.push(x);
    return x;
  };
  const project = (p: ContentRecord, formType: FormType, stage: "Development" | "Pre-production", producer: string | null) => {
    p.workflow = {
      formType,
      status: stage === "Development" ? "Development" : "Active",
      stage,
      showProducerId: producer,
      producerAssignedById: producer ? "system" : null,
      producerAssignedAt: producer ? at : null,
      sermonFormat: null,
      migrated: true,
    };
    p.version += 1;
    changed = true;
  };
  /** The workflow's episode block on a record that already went past recording, carrying what it had. */
  const episode = (
    r: ContentRecord,
    projectId: string,
    n: number,
    plannedId: string | null,
    oldStage: string,
    src: ContentRecord,
  ): { info: EpisodeInfo; after: string; note: string } => {
    const review = latestLink(src, "review");
    const delivered = oldStage === "Delivered";
    const inReview = oldStage === "Review" && !!review;
    const info: EpisodeInfo = {
      episodeNumber: n,
      plannedEpisodeId: plannedId,
      sourceSessionId: null,
      productionNotes: [MIGRATED_NOTE, src.recordingNotes, src.notes].filter(Boolean).join("\n"),
      stage: delivered ? "Marketing and distribution" : "Post production",
      postStage: delivered ? "Approved" : inReview ? "Rough cut review" : "Editing",
      roughCutStatus: delivered ? "Done" : "Pending",
      finalReviewStatus: delivered ? "Done" : "Pending",
      editorId: ownerOf(src, "Editorial", "Editor"),
      readyForReview: oldStage === "Review",
      reviewLink: review,
      finalFileLink: latestLink(src, "final"),
      sendBackReason: null,
      mdStage: delivered && src.stageOutputs.Delivered ? "Published" : "Release plan",
      distribution: [],
      learningNotes: "",
    };
    r.episode = info;
    const postDue = src.stageDeadlines.Review ?? src.stageDeadlines.Editorial ?? src.stageDeadlines.Ingest;
    const mdDue = src.stageDeadlines.Delivered ?? src.deadline;
    r.stageDeadlines = {
      ...r.stageDeadlines,
      ...(postDue ? { "Post production": postDue } : {}),
      ...(mdDue ? { "Marketing and distribution": mdDue } : {}),
    };
    r.version += 1;
    const reviewers = delivered ? [] : (src.stageAssignees.Review ?? []).map((o) => o.personId).filter(isCrew);
    checkpoint(projectId, r.contentId, "rough_cut", delivered, reviewers);
    checkpoint(projectId, r.contentId, "final", delivered, reviewers);
    const tasks = new Set(
      src.tasks
        .filter((t) => t.done)
        .map((t) => EDIT_TASK_TO_POST[t.label])
        .filter(Boolean),
    );
    if (src.stageOutputs.Ingest) tasks.add("offload_check");
    checklist("post", "episode", r.contentId, (k) => tasks.has(k));
    if (delivered) checklist("release", "episode", r.contentId, () => info.mdStage === "Published");
    changed = true;
    const after = delivered ? `Episode in Marketing and distribution: ${info.mdStage}` : `Episode in Post production: ${info.postStage}`;
    const note = [
      oldStage === "Review" && !review
        ? "It had no web review link, so it waits in Editing, marked ready: attach the link and send it for review."
        : "",
      delivered && info.mdStage === "Release plan" ? "Its delivery was not confirmed, so it is at its release plan." : "",
    ]
      .filter(Boolean)
      .join(" ");
    return { info, after, note };
  };

  // ── Series: the series takes a type, each season becomes a project ──
  for (const series of scope.filter((r) => r.category === "series" && r.hierarchyLevel === 0).sort(byNumber)) {
    const chosen = options.seriesTypes?.[series.contentId];
    const type: SeriesType = series.seriesType ?? chosen ?? "podcast";
    report.series.push({ contentId: series.contentId, title: series.title, type, chosen: !!chosen || !!series.seriesType });
    const label = SERIES_TYPES.find((t) => t.key === type)!.label;
    const all = [series, ...childrenOf(series.contentId).flatMap((s) => [s, ...childrenOf(s.contentId)])];
    if (series.archived) {
      for (const r of all) line(r, "unchanged", "Archived before the move", "Left as it is", "Archived records are not moved.");
      continue;
    }
    if (series.seriesType) line(series, "unchanged", `Series: ${label}`, "Already in the new workflow");
    else {
      series.seriesType = type;
      series.version += 1;
      changed = true;
      line(series, "moved", "Series", `Series: ${label}`, chosen ? "" : "Podcast, unless another type is chosen before moving.");
    }
    for (const season of childrenOf(series.contentId)) migrateSeason(season, type);
  }

  function migrateSeason(season: ContentRecord, type: SeriesType): void {
    const kids = childrenOf(season.contentId);
    if (season.archived) {
      for (const r of [season, ...kids])
        line(r, "unchanged", "Archived before the move", "Left as it is", "Archived records are not moved.");
      return;
    }
    if (season.workflow) {
      line(season, "unchanged", `Season: ${season.workflow.stage}`, "Already in the new workflow");
      for (const e of kids) {
        const waits = reserved.get(e.contentId);
        if (e.episode) line(e, "unchanged", "Episode", "Already in the new workflow");
        else if (waits)
          line(e, "unchanged", "Waiting to be recorded", `Planned episode ${waits.id}`, `It keeps ${e.contentId} when recorded.`);
        else if (e.archived) line(e, "unchanged", "Archived before the move", "Left as it is", "Archived records are not moved.");
        else
          line(
            e,
            "flagged",
            `Episode at ${e.pipelineStage ?? "no stage"}`,
            "Left in the earlier pipeline",
            "Its season is already in the new workflow. Move it by hand.",
          );
      }
      return;
    }
    const live = kids.filter((e) => !e.archived);
    for (const e of kids.filter((x) => x.archived))
      line(e, "unchanged", "Archived before the move", "Left as it is", "Archived records are not moved.");
    const known = [...NOT_RECORDED, ...POST, "Delivered"];
    const unknown = live.filter((e) => !e.pipelineStage || !known.includes(e.pipelineStage));
    for (const e of unknown)
      line(
        e,
        "flagged",
        `Episode at ${e.pipelineStage ?? "no stage"}`,
        "Left in the earlier pipeline",
        "Its stage is not one the move knows. Move it by hand.",
      );
    const eps = live.filter((e) => !unknown.includes(e));
    const pastDevelopment = eps.some((e) => e.pipelineStage !== "Idea" && e.pipelineStage !== "Scripting");
    const recordedYet = eps.some(
      (e) => e.pipelineStage === "Recording" || POST.includes(e.pipelineStage!) || e.pipelineStage === "Delivered",
    );
    project(season, type, pastDevelopment ? "Pre-production" : "Development", null);
    form(season, type, pastDevelopment ? 1 : 0);
    checkpoint(season.contentId, null, "pitch", pastDevelopment, []);
    checkpoint(season.contentId, null, "outline_script", pastDevelopment, []);
    checklist("handoff", "project", season.contentId, () => pastDevelopment);
    if (pastDevelopment) checklist("preProject", "project", season.contentId, () => recordedYet);

    // Episode numbers stay those of their Content IDs; one that does not follow the pattern takes the next free number.
    const numbers = new Map<string, number>();
    let top = Math.max(0, ...eps.map((e) => codeNumber(e.contentId, season.contentId, EPISODE_TOKEN)).filter((n) => !Number.isNaN(n)));
    for (const e of eps) {
      const n = codeNumber(e.contentId, season.contentId, EPISODE_TOKEN);
      numbers.set(e.contentId, Number.isNaN(n) ? ++top : n);
    }
    // Recording episodes go on an open session per shoot date, in date order; one with no date gets a session with none.
    const recording = eps.filter((e) => e.pipelineStage === "Recording");
    const dates = [...new Set(recording.map((e) => e.scheduledDate ?? ""))].sort((a, b) => (a || "9999").localeCompare(b || "9999"));
    const sessionFor = new Map<string, RecordingSession>();
    dates.forEach((date, i) => {
      const id = sessionCode(season.contentId, i + 1);
      const rootId = season.parentId ?? season.contentId;
      const onDate = recording.filter((e) => (e.scheduledDate ?? "") === date).map((e) => e.contentId);
      const sheet = date
        ? db.callSheets.find((c) => c.contentId === rootId && c.date === date && c.linkedEpisodeIds.some((x) => onDate.includes(x)))
        : undefined;
      const s: RecordingSession = {
        id,
        contentId: season.contentId,
        sessionNumber: i + 1,
        scheduledDate: date || null,
        venue: sheet?.location ?? "",
        status: "Open",
        closedAt: null,
        callSheetId: sheet?.id ?? null,
        runSheet: [],
        dailyLog: "",
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        archivedReason: null,
      };
      db.recordingSessions.push(s);
      checklist("preSession", "session", id, () => true);
      checklist("wrap", "session", id, () => false);
      sessionFor.set(date, s);
    });

    let planNo = 0;
    for (const e of eps) {
      const stage = e.pipelineStage!;
      const guests = e.featured
        .filter((f) => f.kind === "guest")
        .map((f) => f.name)
        .join(", ");
      if (NOT_RECORDED.includes(stage)) {
        const notes = [
          `${MOVED_NOTE} It was ${e.contentId}, at ${stage}.`,
          e.scheduledDate ? `Shoot date then: ${fmtShort(e.scheduledDate)}.` : "",
          e.notes,
        ]
          .filter(Boolean)
          .join(" ");
        const p = planned(season, ++planNo, e.title, e.contentId, notes, guests);
        e.archived = true;
        e.closedReason = `Waiting to be recorded as planned episode ${p.id}. It keeps this Content ID when it is.`;
        e.version += 1;
        changed = true;
        const s = stage === "Recording" ? sessionFor.get(e.scheduledDate ?? "") : undefined;
        if (s) {
          const row: SessionLogEntry = {
            id: `${s.id}|${p.id}`,
            sessionId: s.id,
            plannedEpisodeId: p.id,
            itemLabel: "",
            logDate: s.scheduledDate ?? today,
            guest: guests,
            status: null,
            notesForPost: "",
            createdAt: at,
            updatedAt: at,
          };
          db.sessionLogEntries.push(row);
        }
        line(
          e,
          "moved",
          `Episode at ${stage}`,
          s
            ? `Planned episode ${p.id}, on session ${s.id} (Production${s.scheduledDate ? `, ${fmtShort(s.scheduledDate)}` : ", no date"})`
            : `Planned episode ${p.id}, waiting to be recorded`,
          `It keeps ${e.contentId} when recorded${s?.callSheetId ? `; call sheet ${s.callSheetId} is linked` : ""}.`,
        );
      } else {
        const p = planned(season, ++planNo, e.title, null, `${MOVED_NOTE} Made as ${e.contentId}.`, guests);
        const made = episode(e, season.contentId, numbers.get(e.contentId)!, p.id, stage, e);
        line(e, "moved", `Episode at ${stage}`, made.after, made.note);
      }
    }
    // Every planned episode published: the season is complete.
    const made = db.records.filter((r) => r.parentId === season.contentId && r.episode && !r.archived);
    const plans = db.plannedEpisodes.filter((p) => p.contentId === season.contentId && !p.archivedAt);
    if (
      pastDevelopment &&
      plans.length &&
      plans.every((p) => made.some((r) => r.episode!.plannedEpisodeId === p.id && r.episode!.mdStage === "Published"))
    )
      season.workflow!.status = "Completed";
    line(
      season,
      "moved",
      "Season",
      `${formTypeOf(type).label} project in ${season.workflow!.status === "Completed" ? "Completed" : season.workflow!.stage}`,
      [
        plural(plans.length, "planned episode"),
        made.length ? plural(made.length, "episode") : "",
        sessionFor.size ? plural(sessionFor.size, "open session") : "",
        pastDevelopment ? "the gates it passed before count as met" : "",
      ]
        .filter(Boolean)
        .join(", ") + ".",
    );
    if (pastDevelopment) followUps.push(`${titleOf(season)}: name the show producer and assign the project roles.`);
    else followUps.push(`${titleOf(season)}: fill in the development form, then greenlight it.`);
  }

  function titleOf(r: ContentRecord): string {
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    return parent ? `${parent.title}: ${r.title} (${r.contentId})` : `${r.title} (${r.contentId})`;
  }

  // ── Devotionals: one guest's five days ──
  for (const d of scope.filter((r) => r.category === "devotional").sort(byNumber)) {
    const stage = d.pipelineStage ?? "";
    if (d.workflow) {
      line(d, "unchanged", `Devotion: ${d.workflow.stage}`, "Already in the new workflow");
      continue;
    }
    if (d.archived) {
      line(d, "unchanged", "Archived before the move", "Left as it is", "Archived records are not moved.");
      continue;
    }
    const reviewed = d.reviewApprovedAt
      ? `Theological review approved by ${d.reviewerName || "the reviewer"} on ${fmtShort(d.reviewApprovedAt.slice(0, 10))}, before the new workflow.`
      : "";
    const sections: DevelopmentForm["sections"] = {
      entry: { category: "devotional" },
      guest: { ...(d.guestName ? { name: d.guestName } : {}), ...(d.guestContact ? { contact: d.guestContact } : {}) },
      ...(reviewed ? { messageReview: { notes: reviewed } } : {}),
    };
    const days = () => {
      for (let n = 1; n <= 5; n++) planned(d, n, `Day ${n}`, null, n === 1 ? MOVED_NOTE : "");
    };
    if (stage === "Closed") {
      const reason = d.closedReason?.trim() || "Closed before the new workflow; no reason was recorded.";
      project(d, "devotion", "Development", null);
      d.workflow!.status = "Closed";
      d.archived = true;
      d.closedReason = reason;
      form(d, "devotion", 0, sections);
      checkpoint(d.contentId, null, "pitch", false, []);
      checkpoint(d.contentId, null, "outline_script", false, []);
      line(d, "moved", "Devotional: Closed", "Devotion, closed and archived", `Reason kept: ${reason}`);
    } else if (stage === "Creation" || stage === "Guest") {
      project(d, "devotion", "Development", null);
      form(d, "devotion", 0, sections);
      checkpoint(d.contentId, null, "pitch", !!d.reviewApprovedAt, [], reviewed);
      checkpoint(d.contentId, null, "outline_script", !!d.reviewApprovedAt, [], reviewed);
      checklist("handoff", "project", d.contentId, () => false);
      days();
      line(
        d,
        "moved",
        `Devotional at ${stage}`,
        "Devotion in Development",
        `Five planned days.${reviewed ? " The pitch and outline checkpoints are approved from its theological review." : ""}`,
      );
      followUps.push(`${titleOf(d)}: finish the development form and the five-day outline, then greenlight it.`);
    } else if (stage === "Prep/Scripting") {
      const producer = ownerOf(d, "Creation");
      project(d, "devotion", "Pre-production", producer);
      form(d, "devotion", 1, sections);
      checkpoint(d.contentId, null, "pitch", true, [], reviewed);
      checkpoint(d.contentId, null, "outline_script", true, [], reviewed);
      checklist("handoff", "project", d.contentId, () => true);
      checklist("preProject", "project", d.contentId, () => false);
      days();
      line(
        d,
        "moved",
        "Devotional at Prep/Scripting",
        "Devotion in Pre-production",
        "Five planned days; the gates it passed before count as met.",
      );
      followUps.push(
        `${titleOf(d)}: ${producer ? "" : "name the show producer, "}assign the roles, fill in the five days, and schedule its recording session.`,
      );
    } else if (["Recording", "Editing", "Review", "Published"].includes(stage)) {
      line(
        d,
        "flagged",
        `Devotional at ${stage}`,
        "Left in the earlier pipeline",
        "It was recorded as one item, so there is no per-day data to make its five episodes from. It keeps working as before; decide by hand.",
      );
    } else
      line(
        d,
        "flagged",
        `Devotional at ${stage || "no stage"}`,
        "Left in the earlier pipeline",
        "Its stage is not one the move knows. Move it by hand.",
      );
  }

  // ── Documentaries: one film ──
  for (const doc of scope.filter((r) => r.category === "documentary" && r.hierarchyLevel === 0).sort(byNumber)) {
    const chosen = options.documentaryForms?.[doc.contentId];
    const formType: FormType = doc.workflow?.formType ?? chosen ?? "documentary_dof";
    report.documentaries.push({ contentId: doc.contentId, title: doc.title, form: formType, chosen: !!chosen || !!doc.workflow });
    const kids = childrenOf(doc.contentId);
    if (doc.workflow) {
      line(doc, "unchanged", `Documentary: ${doc.workflow.stage}`, "Already in the new workflow");
      for (const k of kids) line(k, "unchanged", "Episode", k.episode ? "Already in the new workflow" : "Left as it is");
      continue;
    }
    if (doc.archived) {
      for (const r of [doc, ...kids]) line(r, "unchanged", "Archived before the move", "Left as it is", "Archived records are not moved.");
      continue;
    }
    const stage = doc.pipelineStage ?? "";
    const label = formTypeOf(formType).label;
    const dof = formType === "documentary_dof";
    if (stage === "Idea" || stage === "Research") {
      project(doc, formType, "Development", null);
      form(doc, formType, 0);
      checkpoint(doc.contentId, null, "pitch", false, []);
      checkpoint(doc.contentId, null, "outline_script", false, []);
      checklist("handoff", "project", doc.contentId, () => false);
      line(
        doc,
        "moved",
        `Documentary at ${stage}`,
        `${label} project in Development`,
        chosen ? "" : "DOF-made, unless pitched by others is chosen before moving.",
      );
      followUps.push(`${titleOf(doc)}: fill in the development form, then greenlight it.`);
    } else if (stage === "Pre-production" || stage === "Shooting" || POST.includes(stage) || stage === "Delivered") {
      // From Shooting on, a DOF-made film has had its shoot approved too, so both greenlights count as met.
      const shot = stage !== "Pre-production";
      project(doc, formType, "Pre-production", null);
      form(doc, formType, dof ? (shot ? 2 : 1) : 1);
      checkpoint(doc.contentId, null, "pitch", true, []);
      checkpoint(doc.contentId, null, "outline_script", true, []);
      checklist("handoff", "project", doc.contentId, () => true);
      checklist("preProject", "project", doc.contentId, () => shot);
      let after = `${label} project in Pre-production`;
      let note = dof && !shot ? "Its second greenlight (shoot budget, interview sets, shot list) is still to decide." : "";
      if (stage === "Shooting") {
        const id = sessionCode(doc.contentId, 1);
        const sheet = doc.scheduledDate
          ? db.callSheets.find((c) => c.contentId === doc.contentId && c.date === doc.scheduledDate)
          : undefined;
        db.recordingSessions.push({
          id,
          contentId: doc.contentId,
          sessionNumber: 1,
          scheduledDate: doc.scheduledDate,
          venue: sheet?.location ?? "",
          status: "Open",
          closedAt: null,
          callSheetId: sheet?.id ?? null,
          runSheet: [],
          dailyLog: "",
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          archivedReason: null,
        });
        checklist("preSession", "session", id, () => true);
        checklist("wrap", "session", id, () => false);
        after = `${label} project, recording on session ${id} (Production)`;
        note = "Add what was shot to its log, close it, then send the film to post production.";
      } else if (stage !== "Pre-production") {
        const id = episodeCode(doc.contentId, 1);
        if (byId.has(id)) {
          line(
            doc,
            "flagged",
            `Documentary at ${stage}`,
            "Left in the earlier pipeline",
            `${id} already exists, so its film cannot be made there. Move it by hand.`,
          );
          continue;
        }
        const film = blankRecord(id, "documentary", doc.title, doc.contentId, doc.hierarchyLevel + 1);
        Object.assign(film, {
          createdAt: at,
          startDate: today,
          stageEnteredAt: doc.stageEnteredAt,
          scheduledDate: doc.scheduledDate,
          deadline: doc.deadline,
        });
        db.records.push(film);
        byId.set(id, film);
        const made = episode(film, doc.contentId, 1, null, stage, doc);
        if (made.info.mdStage === "Published") doc.workflow!.status = "Completed";
        after = `${label} project; its film is ${id}, ${made.after.charAt(0).toLowerCase()}${made.after.slice(1)}`;
        note = made.note;
      }
      line(
        doc,
        "moved",
        `Documentary at ${stage}`,
        after,
        [chosen ? "" : "DOF-made, unless pitched by others is chosen before moving.", note].filter(Boolean).join(" "),
      );
      followUps.push(`${titleOf(doc)}: name the show producer and assign the project roles.`);
    } else
      line(
        doc,
        "flagged",
        `Documentary at ${stage || "no stage"}`,
        "Left in the earlier pipeline",
        "Its stage is not one the move knows. Move it by hand.",
      );
    for (const k of kids)
      if (!listed.has(k.contentId))
        line(
          k,
          "flagged",
          "A record under a documentary",
          "Left as it is",
          "Documentaries made before the workflow had no episodes. Look at it by hand.",
        );
  }

  // Anything in scope that no rule above reached. There should never be any; the tests check.
  for (const r of scope) if (!listed.has(r.contentId)) report.unexplained.push(`${r.contentId} (${r.title})`);

  if (changed) {
    syncRecordCounters(db);
    syncWorkflowCounters(db);
    const moved = lines.filter((l) => l.outcome === "moved").length;
    const flagged = lines.filter((l) => l.outcome === "flagged").length;
    db.audit.push({
      id: logId("A"),
      at,
      byPersonId: options.byPersonId,
      action: "migrate-workflow",
      entity: "system",
      entityId: "workflow",
      detail: `${plural(moved, "record")} moved to the new workflow, ${plural(flagged, "record")} left for a decision by hand.`,
    });
  }
  const after = countParts(db);
  report.counts = [...after.keys()].map((part) => ({ part, before: before.get(part) ?? 0, after: after.get(part) ?? 0 }));
  report.changed = changed;
  return report;
}

/** A report from a run that may have applied the move: where the copy of the data was kept, if it did. */
export interface AppliedMigrationReport extends WorkflowMigrationReport {
  applied: boolean;
  backup: string | null;
}

/** The report as lines of text, for the command line and the server's log. */
export function describeMigration(r: WorkflowMigrationReport, applied: boolean): string {
  const moved = r.lines.filter((l) => l.outcome === "moved");
  const flagged = r.lines.filter((l) => l.outcome === "flagged");
  const unchanged = r.lines.filter((l) => l.outcome === "unchanged");
  const row = (l: MigrationLine) => `  ${l.contentId.padEnd(22)} ${l.before} → ${l.after}${l.note ? `\n  ${"".padEnd(22)} ${l.note}` : ""}`;
  const counts = r.counts
    .filter(
      (c) =>
        c.before !== c.after ||
        ["records", "developmentForms", "plannedEpisodes", "recordingSessions", "reviewCheckpoints"].includes(c.part),
    )
    .map((c) => `  ${c.part.padEnd(24)} ${String(c.before).padStart(6)} → ${c.after}`);
  return [
    !r.changed
      ? "Nothing to move: everything is already in the new workflow, or listed below for a decision by hand."
      : `${applied ? "Moved" : "Would move"} ${plural(moved.length, "record")} to the new workflow.`,
    "",
    "Rows per part of the data, before → after:",
    ...counts,
    "",
    `Moved (${moved.length}):`,
    ...(moved.length ? moved.map(row) : ["  None."]),
    "",
    `Left for a decision by hand (${flagged.length}):`,
    ...(flagged.length ? flagged.map(row) : ["  None."]),
    "",
    `Left as they are (${unchanged.length}):`,
    ...(unchanged.length ? unchanged.map(row) : ["  None."]),
    "",
    `Rows not accounted for: ${r.unexplained.length}${r.unexplained.length ? ` (${r.unexplained.join(", ")})` : ""}`,
    ...(r.followUps.length ? ["", "To do in the app afterwards:", ...r.followUps.map((f) => `  - ${f}`)] : []),
  ].join("\n");
}
