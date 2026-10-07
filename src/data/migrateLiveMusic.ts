import type {
  ChecklistOwner,
  CheckpointKey,
  ContentRecord,
  Database,
  DevelopmentForm,
  EpisodeInfo,
  FormType,
  PlannedEpisode,
  RecordingSession,
  ReviewCheckpoint,
  SessionLogEntry,
  WorkflowChecklistItem,
} from "../types";
import { CHECKLISTS, CRITERIA, type ChecklistKey } from "../config/workflow";
import { blankRecord } from "../services/content";
import { asWebUrl } from "../services/urls";
import { fmtShort } from "../services/utils";
import { childCounter, codeNumber, episodeCode, plannedEpisodeId, sessionCode } from "./ids";

// Data version 23: Live Shows and DOF Music move onto the five-stage workflow, as the series did (build prompt v2,
// agreed after the rework). Everything is moved in place; nothing is deleted, and every Content ID stays:
//
//   Live Shows   A live show keeps its record and gets its first event (DOF-LIVE-002-E1), which is the project: the
//                show's production (recurring, one-time or multi-day), its template and its Event Plan move onto it.
//                Each day becomes one of the event's sessions (DOF-LIVE-002-E1-D01) with its call sheet, its template
//                link and label, its level of production; its record is kept, archived, saying which session it is now.
//                A day at Development or Pre-production is a session being planned; at Production one on air; past it,
//                closed. A day that went on to post production (and had something recorded for it) gives a recording
//                (DOF-LIVE-002-E1-R01) in Post production or Marketing and distribution, as it stood.
//   DOF Music    A music project keeps its record; each album becomes a release, the project (a single if it has one
//                track). A track not recorded yet becomes a planned song that keeps the track's Content ID: its record
//                waits, archived with that reason, and becomes the song when a session that recorded it closes. A track
//                being recorded goes on an open session on its shoot date. A track in post production or later becomes a
//                song (its record, its Content ID) in Post production or Marketing and distribution.
//
// A project past Development counts as greenlit, with its gates met ("migrated", as the series' move did), and its
// theological review as approved on the earlier pipeline. Reminders set on a day follow it to its session. Running it
// again changes nothing: what is already on the workflow is left alone.

const MOVED = "Moved to the workflow (data version 23)";
const NOTE = "Moved across from the earlier pipeline (data version 23).";
const STAGES = ["Development", "Pre-production", "Production", "Post production", "Marketing and distribution"];
/** Where a record stood on the five stages: 0 to 4, or -1 (closed on the earlier pipeline, or a stage not known). */
const stageIndex = (s: string | null): number => STAGES.indexOf(s ?? "");

export interface LiveMusicResult {
  lines: string[]; // what was moved, in words, for the dry-run report
  changed: boolean;
}

export function liveMusicToWorkflow(db: Database, at = new Date().toISOString()): LiveMusicResult {
  const today = at.slice(0, 10);
  const out: LiveMusicResult = { lines: [], changed: false };
  db.recordingSessions ??= [];
  db.sessionLogEntries ??= [];
  db.plannedEpisodes ??= [];
  db.developmentForms ??= [];
  db.reviewCheckpoints ??= [];
  db.workflowChecklistItems ??= [];
  const people = new Map(db.people.map((p) => [p.personId, p]));
  const isCrew = (id: string | null | undefined): id is string => {
    const p = id ? people.get(id) : undefined;
    return !!p && p.status === "active" && (p.category === "CRW" || p.category === "HOP");
  };
  const childrenOf = (id: string) =>
    db.records.filter((r) => r.parentId === id).sort((a, b) => a.contentId.localeCompare(b.contentId, undefined, { numeric: true }));
  const raise = (key: string, n: number) => {
    if (!Number.isNaN(n) && n > (db.counters[key] ?? 0)) db.counters[key] = n;
  };

  // ── Builders, shaped as the services make them ──
  const checklist = (key: ChecklistKey, ownerType: ChecklistOwner, ownerId: string, done: boolean): void => {
    const def = CHECKLISTS[key];
    for (const item of def.items) {
      if (item.auto) continue;
      const id = `${ownerId}|${def.stage}|${item.key}`;
      if (db.workflowChecklistItems.some((c) => c.id === id)) continue;
      const row: WorkflowChecklistItem = {
        id,
        ownerType,
        ownerId,
        stage: def.stage,
        itemKey: item.key,
        label: item.label,
        required: item.required,
        done,
        note: done ? NOTE : "",
        doneAt: done ? at : null,
        doneById: done ? "system" : null,
        createdAt: at,
        updatedAt: at,
      };
      db.workflowChecklistItems.push(row);
    }
  };
  const checkpoint = (contentId: string, episodeId: string | null, key: CheckpointKey, approved: boolean): void => {
    const id = `${episodeId ?? contentId}|${key}`;
    if (db.reviewCheckpoints.some((c) => c.id === id)) return;
    const c: ReviewCheckpoint = {
      id,
      contentId,
      episodeId,
      checkpoint: key,
      reviewerIds: [],
      status: approved ? "Approved" : "Pending",
      note: approved ? "Approved before the new workflow." : "",
      decidedAt: approved ? at : null,
      decidedById: approved ? "system" : null,
      createdAt: at,
      updatedAt: at,
    };
    db.reviewCheckpoints.push(c);
  };
  const form = (p: ContentRecord, formType: FormType, greenlit: boolean): void => {
    if (db.developmentForms.some((f) => f.contentId === p.contentId)) return;
    const notes = `Greenlit before the new workflow (moved across on ${fmtShort(today)}).`;
    const f: DevelopmentForm = {
      id: p.contentId,
      contentId: p.contentId,
      formType,
      sections: p.notes ? { entry: { mandate: p.notes } } : {},
      greenlightStage: null,
      criteria: Object.fromEntries(CRITERIA.map((c) => [c.key, { met: null, note: "" }])) as DevelopmentForm["criteria"],
      outcome: greenlit ? "Greenlight" : null,
      reviewNotes: greenlit ? notes : "",
      decisionDate: greenlit ? today : null,
      reviewWindowDate: null,
      decisions: greenlit ? [{ stage: 1, outcome: "Greenlight", notes, date: today, byPersonId: "system", at }] : [],
      createdAt: at,
      updatedAt: at,
    };
    db.developmentForms.push(f);
  };
  /** A record made a project of the workflow, with its form, review checkpoints and checklists. */
  const project = (p: ContentRecord, formType: FormType, past: boolean, producer: string | null): void => {
    p.workflow = {
      formType,
      status: past ? "Active" : "Development",
      stage: past ? "Pre-production" : "Development",
      showProducerId: producer,
      producerAssignedById: producer ? "system" : null,
      producerAssignedAt: producer ? at : null,
      sermonFormat: null,
      migrated: true,
      storageDriveId: null,
    };
    p.pipelineStage = null;
    p.version += 1;
    form(p, formType, past);
    checkpoint(p.contentId, null, "pitch", past);
    checkpoint(p.contentId, null, "outline_script", past);
    checklist("handoff", "project", p.contentId, past);
    if (past) checklist("preProject", "project", p.contentId, false);
    out.changed = true;
  };
  /** The first crew-list owner named on any stage of these records, or their responsible person. */
  const ownerOf = (records: ContentRecord[]): string | null => {
    for (const r of records) {
      if (isCrew(r.assigneePersonId)) return r.assigneePersonId;
      for (const list of Object.values(r.stageAssignees ?? {})) for (const o of list) if (isCrew(o.personId)) return o.personId;
    }
    return null;
  };
  const latestLink = (r: ContentRecord, kind: "review" | "final"): string =>
    r.links
      .filter((l) => l.kind === kind)
      .map((l) => asWebUrl(l.url))
      .filter((u): u is string => !!u)
      .pop() ?? "";
  /** The workflow's episode block for something past recording, in Post production or Marketing, as it stood. */
  const episodeInfo = (
    src: ContentRecord,
    n: number,
    plannedId: string | null,
    sessionId: string | null,
    rowId: string | null,
  ): EpisodeInfo => {
    const marketing = stageIndex(src.pipelineStage) >= 4;
    const published = marketing && !!src.stageOutputs["Marketing and distribution"];
    return {
      episodeNumber: n,
      plannedEpisodeId: plannedId,
      sourceSessionId: sessionId,
      productionNotes: [NOTE, src.recordingNotes, src.notes].filter(Boolean).join("\n"),
      stage: marketing ? "Marketing and distribution" : "Post production",
      postStage: marketing ? "Approved" : "Editing",
      roughCutStatus: marketing ? "Done" : "Pending",
      finalReviewStatus: marketing ? "Done" : "Pending",
      editorId: null,
      readyForReview: false,
      reviewLink: latestLink(src, "review"),
      finalFileLink: latestLink(src, "final"),
      sendBackReason: null,
      mdStage: published ? "Published" : "Release plan",
      distribution: [],
      learningNotes: "",
      ...(rowId ? { sourceRowId: rowId } : {}),
    };
  };
  const episodeExtras = (projectId: string, ep: ContentRecord, src: ContentRecord): void => {
    const marketing = ep.episode!.stage === "Marketing and distribution";
    const due = src.stageDeadlines;
    ep.stageDeadlines = {
      ...ep.stageDeadlines,
      ...(due["Post production"] ? { "Post production": due["Post production"] } : {}),
      ...(due["Marketing and distribution"] || src.deadline
        ? { "Marketing and distribution": due["Marketing and distribution"] ?? src.deadline! }
        : {}),
    };
    checkpoint(projectId, ep.contentId, "rough_cut", marketing);
    checkpoint(projectId, ep.contentId, "final", marketing);
    checklist("post", "episode", ep.contentId, false);
    if (marketing) checklist("release", "episode", ep.contentId, ep.episode!.mdStage === "Published");
  };
  const session = (input: Partial<RecordingSession> & Pick<RecordingSession, "id" | "contentId" | "sessionNumber">): RecordingSession => {
    const s: RecordingSession = {
      scheduledDate: null,
      venue: "",
      status: "Planned",
      closedAt: null,
      callSheetId: null,
      runSheet: [],
      dailyLog: "",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      archivedReason: null,
      name: "",
      label: null,
      startTime: null,
      endTime: null,
      storyboardId: null,
      shotListId: null,
      storageDriveId: null,
      ...input,
    };
    db.recordingSessions.push(s);
    raise(`session:${s.contentId}`, s.sessionNumber);
    checklist("preSession", "session", s.id, s.status !== "Planned");
    if (s.status !== "Planned") checklist("wrap", "session", s.id, s.status === "Closed");
    return s;
  };
  /** A row of a session's log: for a planned song, or (`key`) a live day's recording named in words. */
  const logRow = (sessionId: string, key: string, input: Partial<Omit<SessionLogEntry, "id" | "sessionId">>): SessionLogEntry => {
    const row: SessionLogEntry = {
      id: `${sessionId}|${input.plannedEpisodeId ?? key}`,
      sessionId,
      plannedEpisodeId: null,
      itemLabel: "",
      logDate: today,
      guest: "",
      status: null,
      notesForPost: "",
      createdAt: at,
      updatedAt: at,
      ...input,
    };
    db.sessionLogEntries.push(row);
    return row;
  };

  // ── Live Shows: each show gets its first event; its days become the event's sessions ──
  for (const show of db.records.filter((r) => r.category === "live" && r.hierarchyLevel === 0)) {
    const kids = childrenOf(show.contentId);
    if (kids.some((k) => k.workflow)) continue; // already moved
    const days = kids.filter((k) => !k.workflow && !k.episode);
    if (show.archived && !days.length) continue;
    const eventId = `${show.contentId}-E1`;
    if (db.records.some((r) => r.contentId === eventId)) continue;
    const event = blankRecord(eventId, "live", show.title, show.contentId, 1);
    event.startDate = show.startDate;
    event.deadline = show.deadline;
    event.showStart = show.showStart;
    event.showEnd = show.showEnd;
    event.productionLevel = show.productionLevel;
    event.notes = show.notes;
    event.archived = show.archived;
    event.closedReason = show.archived ? show.closedReason : null;
    event.production = show.production ?? null;
    show.production = null;
    show.version += 1;
    db.records.push(event);
    raise(`${childCounter(show.contentId)}:E`, 1);
    const live = days.filter((d) => !d.archived && d.pipelineStage !== "Closed");
    const past = live.some((d) => stageIndex(d.pipelineStage) > 0) || (!live.length && days.length > 0);
    project(event, "live_event", past, ownerOf([show, ...days]));
    if (event.archived) event.workflow!.status = "Closed";
    for (const t of db.showTemplates ?? []) if (t.contentId === show.contentId) t.contentId = eventId;
    const ordered = [...days].sort(
      (a, b) => (a.scheduledDate ?? "9999").localeCompare(b.scheduledDate ?? "9999") || a.contentId.localeCompare(b.contentId),
    );
    let recordings = 0;
    const moved: string[] = [];
    ordered.forEach((day, i) => {
      const at_ = stageIndex(day.pipelineStage);
      const sheet =
        db.callSheets.find((c) => c.instanceId === day.contentId) ??
        (day.scheduledDate
          ? db.callSheets.find((c) => c.contentId === show.contentId && c.instanceId === null && c.date === day.scheduledDate)
          : undefined);
      // A day closed on the earlier pipeline (not done: called off) is kept as a session taken off the schedule.
      const closedEarlier = day.pipelineStage === "Closed";
      const gone = day.archived || closedEarlier;
      const status: RecordingSession["status"] = at_ >= 0 && at_ <= 1 ? "Planned" : at_ === 2 ? "Open" : at_ >= 3 ? "Closed" : "Planned";
      const s = session({
        id: sessionCode(eventId, i + 1, "D"),
        contentId: eventId,
        sessionNumber: i + 1,
        scheduledDate: day.scheduledDate,
        venue: sheet?.location ?? "",
        status,
        closedAt: status === "Closed" ? at : null,
        callSheetId: sheet?.id ?? null,
        dailyLog: day.recordingNotes ?? "",
        archivedAt: gone ? at : null,
        archivedReason: gone ? day.closedReason || (closedEarlier ? "Closed before the move" : "Archived before the move") : null,
        name: day.title,
        instance: day.instance ?? null,
        productionLevel: day.productionLevel,
        movedFrom: day.contentId,
      });
      if (sheet) sheet.instanceId = s.id;
      // What the day recorded goes on as a recording, where it stood, unless the day said nothing needed post.
      if (!gone && (at_ === 3 || at_ === 4) && day.postProductionNeeded !== false) {
        recordings += 1;
        const row = logRow(s.id, "I-recording", {
          itemLabel: "Recording of the day",
          logDate: day.scheduledDate ?? today,
          status: "Recorded",
          notesForPost: day.recordingNotes ?? "",
        });
        const ep = blankRecord(episodeCode(eventId, recordings, "R"), "live", `${day.title}: Recording of the day`, eventId, 2);
        ep.episode = episodeInfo(day, recordings, null, s.id, row.id);
        ep.scheduledDate = day.scheduledDate;
        ep.startDate = day.startDate;
        ep.stageEnteredAt = day.stageEnteredAt;
        db.records.push(ep);
        episodeExtras(eventId, ep, day);
        raise(childCounter(eventId), recordings);
      }
      // Reminders set on the day follow it to its session.
      for (const rm of db.calendarReminders ?? []) if (rm.targetType === "instance" && rm.targetId === day.contentId) rm.targetId = s.id;
      if (!day.archived) {
        day.archived = true;
        day.closedReason = `${MOVED}: it is day ${s.id} of ${eventId}.`;
      } else day.closedReason = `${day.closedReason ? `${day.closedReason} ` : ""}(${MOVED}: day ${s.id} of ${eventId}.)`;
      day.version += 1;
      moved.push(`${day.contentId} → ${s.id}`);
    });
    out.lines.push(
      `  ${show.contentId} ${show.title}: event ${eventId}${event.production ? ` (${event.production.mode.replace("_", "-")})` : ""}, ${ordered.length} day${ordered.length === 1 ? "" : "s"} as sessions${recordings ? `, ${recordings} recording${recordings === 1 ? "" : "s"}` : ""}, in ${event.workflow!.stage}.${moved.length ? ` ${moved.join(", ")}.` : ""}`,
    );
  }

  // ── DOF Music: each album becomes a release; its tracks, songs or planned songs ──
  for (const music of db.records.filter((r) => r.category === "music" && r.hierarchyLevel === 0)) {
    for (const album of childrenOf(music.contentId)) {
      if (album.workflow || album.archived) continue;
      const tracks = childrenOf(album.contentId).filter((t) => !t.archived && !t.episode);
      const known = tracks.filter((t) => stageIndex(t.pipelineStage) >= 0);
      const past = known.some((t) => stageIndex(t.pipelineStage) > 0);
      const formType: FormType = childrenOf(album.contentId).filter((t) => !t.archived).length === 1 ? "music_single" : "music_album";
      project(album, formType, past, ownerOf([album, music, ...tracks]));
      const words: string[] = [];
      // Song numbers stay those of their Content IDs (T01); one that does not follow the pattern takes the next free number.
      let top = Math.max(0, ...tracks.map((t) => codeNumber(t.contentId, album.contentId, "T")).filter((n) => !Number.isNaN(n)));
      const numberOf = (t: ContentRecord) => {
        const n = codeNumber(t.contentId, album.contentId, "T");
        return Number.isNaN(n) ? ++top : n;
      };
      const recordingDates = [...new Set(known.filter((t) => stageIndex(t.pipelineStage) === 2).map((t) => t.scheduledDate ?? ""))].sort(
        (a, b) => (a || "9999").localeCompare(b || "9999"),
      );
      const sessionFor = new Map<string, RecordingSession>();
      recordingDates.forEach((date, i) =>
        sessionFor.set(
          date,
          session({
            id: sessionCode(album.contentId, i + 1),
            contentId: album.contentId,
            sessionNumber: i + 1,
            scheduledDate: date || null,
            status: "Open",
            name: "Recording",
          }),
        ),
      );
      for (const t of known) {
        const n = numberOf(t);
        const stage = stageIndex(t.pipelineStage);
        if (stage <= 2) {
          // Not recorded yet: a planned song that keeps the track's Content ID, waiting to be recorded.
          const plannedId = plannedEpisodeId(album.contentId, n);
          const p: PlannedEpisode = {
            id: plannedId,
            contentId: album.contentId,
            episodeNumber: n,
            workingTitle: t.title,
            question: "",
            guest: t.featured.map((f) => f.name).join(", "),
            notes: [t.notes, NOTE].filter(Boolean).join("\n"),
            details: {},
            reservedId: t.contentId,
            sourcePageId: null,
            createdAt: at,
            updatedAt: at,
            archivedAt: null,
            archivedReason: null,
          };
          db.plannedEpisodes.push(p);
          raise(`planned:${album.contentId}`, n);
          const s = stage === 2 ? sessionFor.get(t.scheduledDate ?? "") : undefined;
          if (s)
            logRow(s.id, plannedId, {
              plannedEpisodeId: plannedId,
              logDate: t.scheduledDate ?? today,
              notesForPost: t.recordingNotes ?? "",
            });
          t.archived = true;
          t.closedReason = `Waiting to be recorded as planned song ${plannedId}. It keeps ${t.contentId} when recorded (${MOVED}).`;
          t.version += 1;
          words.push(`${t.contentId} planned${s ? ` (on ${s.id})` : ""}`);
        } else {
          // Recorded: the track is the song, in Post production or Marketing and distribution.
          t.episode = episodeInfo(t, n, null, null, null);
          t.pipelineStage = null;
          t.version += 1;
          episodeExtras(album.contentId, t, t);
          raise(childCounter(album.contentId), n);
          words.push(`${t.contentId} a song in ${t.episode.stage}`);
        }
      }
      for (const t of tracks.filter((x) => !known.includes(x)))
        words.push(`${t.contentId} left as it was (its stage, ${t.pipelineStage ?? "none"}, is not one the move knows)`);
      out.lines.push(
        `  ${album.contentId} ${album.title}: a ${formType === "music_single" ? "single" : "album"}, in ${album.workflow!.stage}${words.length ? `. ${words.join("; ")}` : ""}.`,
      );
    }
  }
  return out;
}

/** What the move would do, without doing it: run on a copy, for the dry-run report. */
export function liveMusicPlan(db: Database): string[] {
  return liveMusicToWorkflow(structuredClone(db)).lines;
}
