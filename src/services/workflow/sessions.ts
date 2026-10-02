import type { Actor, CallSheet, LogStatus, RecordingSession, RunItem, SessionLogEntry } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { localId } from "../../data/ids";
import { categoryOf } from "../../config/categories";
import { formTypeOf } from "../../config/workflow";
import { createCallSheet } from "../callsheets";
import { displayTitle } from "../content";
import { rootOf } from "../access";
import { getPerson } from "../people";
import { logAudit } from "../audit";
import { isIsoDate, pickKeys, todayIso } from "../utils";
import {
  canManageTeam,
  ensureChecklist,
  episodesOf,
  isDocumentary,
  nowStamp,
  projectForWrite,
  rowsOf,
  sessionForWrite,
  sessionsOf,
  type Episode,
} from "./common";
import { makeEpisode } from "./episodes";
import { evaluateGate, gateError } from "./gates";
import { nextSession } from "./ids";

// Recording sessions. A session is planned and prepared at Pre-production (status Planned), recorded at
// Production (Open), and closed. Closing splits it: every row of its log that was recorded becomes an episode.

// ── The recording-day run sheet ──────────────────────────────

/** Shown with every run sheet. */
export const RUN_SHEET_NOTE =
  "Real conversations often run long. If takes reach 65 to 70 minutes, expect the day to run 35 to 60 minutes over. Five long conversations in a row tire the host. Never skip the Episode 1 spot check.";

const MAX_DAY = 24 * 60;
const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * The recording day for a number of episodes of a given length: crew call at 07:00, setup, technical check, then
 * each episode with a changeover after it (a longer spot check after the first, lunch after the third when
 * there are four or more), and wrap. For five 58-minute episodes it is the brief's timeline exactly.
 */
export function runSheetTemplate(episodes: number, minutes = 58): Omit<RunItem, "id">[] {
  if (!Number.isInteger(episodes) || episodes < 1 || episodes > 12) throw new RuleError("A recording day can hold from 1 to 12 episodes.");
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw new RuleError("An episode's length must be from 5 to 240 minutes.");
  const out: Omit<RunItem, "id">[] = [];
  let t = 7 * 60;
  const add = (title: string, durationMin: number, notes = "") => {
    out.push({ time: hhmm(t), title, durationMin, ownerPersonId: null, notes });
    t += durationMin;
  };
  add("Crew call, load-in", 0, "Gear check against the call sheet");
  add("Setup", 90, "Cameras, lighting, audio, set dressing; take a reference photo of the set");
  add("Technical check", 30, "Mic levels, camera sync, color match, storage and battery, short mock recording");
  add("Talent arrival, mic-up, start routine", 10, "Quiet room, phones off");
  for (let i = 1; i <= episodes; i++) {
    add(`Episode ${i}`, minutes, i === 1 ? "Slate with the episode ID" : "");
    if (i === episodes) break;
    if (i === 1) add("Spot check and changeover", 22, "Review Ep 1 for audio, focus and sync; reset set, water; brief the next guest");
    else if (i === 3 && episodes >= 4) add("Lunch", 44, "Media offload can run while everyone eats");
    else add("Changeover", 20, i % 2 === 0 ? "Log timestamps for any pickups" : "Check battery and card capacity");
  }
  add("Wrap", 59, "See wrap checklist");
  if (t > MAX_DAY) throw new RuleError("That many episodes do not fit in one day. Split them across sessions.");
  return out;
}

const withIds = (items: Omit<RunItem, "id">[]): RunItem[] => items.map((x) => ({ id: localId("RS"), ...x }));

/** The planned length of the project's episodes, if its plan says, or 58 minutes. */
function plannedMinutes(projectId: string): number {
  for (const p of getDb().plannedEpisodes)
    if (p.contentId === projectId && !p.archivedAt) {
      const n = Number(p.details.targetMinutes);
      if (Number.isInteger(n) && n >= 5 && n <= 240) return n;
    }
  return 58;
}

// ── Sessions ─────────────────────────────────────────────────

export interface SessionInput {
  scheduledDate?: string | null;
  venue?: string;
  dailyLog?: string;
}

const checkDate = (d: string | null | undefined): void => {
  if (d !== null && d !== undefined && d !== "" && !isIsoDate(d)) throw new RuleError("Pick the session's date.");
};

/** Schedules a recording session. Sessions are planned at Pre-production, once the project is greenlit and handed off. */
export function createSession(actor: Actor, projectId: string, input: SessionInput = {}): RecordingSession {
  const p = projectForWrite(actor, projectId);
  if (p.workflow.stage !== "Pre-production")
    throw new RuleError("Sessions are scheduled at Pre-production, once the project is greenlit and handed off.");
  checkDate(input.scheduledDate);
  const { id, n } = nextSession(projectId);
  const at = nowStamp();
  const s: RecordingSession = {
    id,
    contentId: projectId,
    sessionNumber: n,
    scheduledDate: input.scheduledDate || null,
    venue: (input.venue ?? "").trim(),
    status: "Planned",
    closedAt: null,
    callSheetId: null,
    runSheet: withIds(runSheetTemplate(5, plannedMinutes(projectId))),
    dailyLog: "",
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    archivedReason: null,
  };
  getDb().recordingSessions.push(s);
  ensureChecklist("preSession", "session", id);
  logAudit(actor, "create", "session", id, s.scheduledDate ?? "no date yet");
  commit();
  return s;
}

export const SESSION_EDITABLE = ["scheduledDate", "venue", "dailyLog"] as const;

export function updateSession(actor: Actor, sessionId: string, input: SessionInput): RecordingSession {
  const { session } = sessionForWrite(actor, sessionId);
  if (session.status === "Closed") throw new RuleError("This session is closed. Reopen it to change it.");
  const patch = pickKeys(input, SESSION_EDITABLE);
  checkDate(patch.scheduledDate);
  if (patch.venue !== undefined && patch.venue.length > 300) throw new RuleError("Keep the venue under 300 characters.");
  if (patch.dailyLog !== undefined && patch.dailyLog.length > 20_000) throw new RuleError("Keep the daily log under 20,000 characters.");
  if (patch.scheduledDate !== undefined) session.scheduledDate = patch.scheduledDate || null;
  if (patch.venue !== undefined) session.venue = patch.venue.trim();
  if (patch.dailyLog !== undefined) session.dailyLog = patch.dailyLog.trim();
  session.updatedAt = nowStamp();
  logAudit(actor, "update", "session", sessionId, Object.keys(patch).join(", "));
  commit();
  return session;
}

/** Takes a session that never started off the schedule, with a reason. It is archived, never deleted. */
export function archiveSession(actor: Actor, sessionId: string, reason: string): RecordingSession {
  const { session } = sessionForWrite(actor, sessionId);
  if (session.status !== "Planned") throw new RuleError("Only a session that has not started can be taken off the schedule.");
  if (!reason.trim()) throw new RuleError("Write why the session is being taken off the schedule.");
  session.archivedAt = nowStamp();
  session.archivedReason = reason.trim();
  session.updatedAt = session.archivedAt;
  logAudit(actor, "archive", "session", sessionId, reason.trim());
  commit();
  return session;
}

// ── Run sheet ────────────────────────────────────────────────

export interface RunSheetItemInput {
  time: string;
  title: string;
  durationMin: number;
  ownerPersonId?: string | null;
  notes?: string;
}

function checkRunItem(input: RunSheetItemInput): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new RuleError("Enter the start time as hours and minutes, for example 09:30.");
  if (!input.title.trim()) throw new RuleError("Give this part of the day a name.");
  if (!Number.isInteger(input.durationMin) || input.durationMin < 0 || input.durationMin > 600)
    throw new RuleError("Length must be a whole number of minutes, up to 600.");
  if (input.ownerPersonId) {
    const p = getPerson(input.ownerPersonId);
    if (!p || p.status !== "active") throw new RuleError("Choose an active person.");
  }
}

const editableRunSheet = (actor: Actor, sessionId: string): RecordingSession => {
  const { session } = sessionForWrite(actor, sessionId);
  if (session.status === "Closed") throw new RuleError("This session is closed. Reopen it to change it.");
  return session;
};

/** Starts the run sheet again from the template, for as many episodes as the log plans (five if none yet). */
export function resetRunSheet(actor: Actor, sessionId: string, minutes?: number): RecordingSession {
  const session = editableRunSheet(actor, sessionId);
  const planned = rowsOf(sessionId).filter((r) => r.plannedEpisodeId).length;
  session.runSheet = withIds(runSheetTemplate(planned || 5, minutes ?? plannedMinutes(session.contentId)));
  session.updatedAt = nowStamp();
  logAudit(actor, "run-sheet-reset", "session", sessionId, `${planned || 5} episodes`);
  commit();
  return session;
}

export function addRunSheetItem(actor: Actor, sessionId: string, input: RunSheetItemInput): RunItem {
  const session = editableRunSheet(actor, sessionId);
  checkRunItem(input);
  const item: RunItem = {
    id: localId("RS", (x) => session.runSheet.some((i) => i.id === x)),
    time: input.time,
    title: input.title.trim(),
    durationMin: input.durationMin,
    ownerPersonId: input.ownerPersonId || null,
    notes: (input.notes ?? "").trim(),
  };
  session.runSheet.push(item);
  session.runSheet.sort((a, b) => a.time.localeCompare(b.time));
  session.updatedAt = nowStamp();
  logAudit(actor, "run-sheet-add", "session", sessionId, `${item.time} ${item.title}`);
  commit();
  return item;
}

export function updateRunSheetItem(actor: Actor, sessionId: string, itemId: string, input: Partial<RunSheetItemInput>): RunItem {
  const session = editableRunSheet(actor, sessionId);
  const item = session.runSheet.find((x) => x.id === itemId);
  if (!item) throw new RuleError("That part of the run sheet no longer exists.");
  const next = {
    time: input.time ?? item.time,
    title: input.title ?? item.title,
    durationMin: input.durationMin ?? item.durationMin,
    ownerPersonId: input.ownerPersonId === undefined ? item.ownerPersonId : input.ownerPersonId,
    notes: input.notes ?? item.notes,
  };
  checkRunItem(next);
  Object.assign(item, { ...next, title: next.title.trim(), notes: next.notes.trim(), ownerPersonId: next.ownerPersonId || null });
  session.runSheet.sort((a, b) => a.time.localeCompare(b.time));
  session.updatedAt = nowStamp();
  logAudit(actor, "run-sheet-update", "session", sessionId, item.title);
  commit();
  return item;
}

export function removeRunSheetItem(actor: Actor, sessionId: string, itemId: string): void {
  const session = editableRunSheet(actor, sessionId);
  session.runSheet = session.runSheet.filter((x) => x.id !== itemId);
  session.updatedAt = nowStamp();
  logAudit(actor, "run-sheet-remove", "session", sessionId, itemId);
  commit();
}

// ── The call sheet ───────────────────────────────────────────

/**
 * Makes the session's call sheet in the Call Sheet module, filled in from what is known: date, venue, call time,
 * the crew holding the project's roles, the producer, and the episodes and guests planned for the day. Every field
 * can be changed there, and the sheet can be duplicated like any other.
 */
export function createSessionCallSheet(actor: Actor, sessionId: string): CallSheet {
  const { session, project } = sessionForWrite(actor, sessionId);
  if (session.status === "Closed") throw new RuleError("This session is closed.");
  if (session.callSheetId && getDb().callSheets.some((c) => c.id === session.callSheetId))
    throw new RuleError(`This session already has call sheet ${session.callSheetId}.`);
  if (!session.scheduledDate) throw new RuleError("Set the session's date before making its call sheet.");
  const db = getDb();
  const crew = [
    ...new Set(
      [project.workflow.showProducerId, ...db.projectRoles.filter((r) => r.contentId === project.contentId).map((r) => r.crewId)].filter(
        (x): x is string => !!x,
      ),
    ),
  ];
  const lines = rowsOf(sessionId).map((r) => {
    const planned = db.plannedEpisodes.find((p) => p.id === r.plannedEpisodeId);
    const what = planned ? `${planned.id} ${planned.workingTitle}` : r.itemLabel;
    return `- ${what}${r.guest ? ` (guest: ${r.guest})` : ""}`;
  });
  const sheet = createCallSheet(actor, {
    contentId: rootOf(project).contentId,
    date: session.scheduledDate,
    title: `${displayTitle(project)}: ${session.id}`,
    location: session.venue,
    callTime: [...session.runSheet].sort((a, b) => a.time.localeCompare(b.time))[0]?.time ?? "07:00",
    crewPersonIds: crew,
    format: formTypeOf(project.workflow.formType).label,
    notes: lines.length ? `Recording session ${session.id}.\n${lines.join("\n")}` : `Recording session ${session.id}.`,
  });
  session.callSheetId = sheet.id;
  session.updatedAt = nowStamp();
  logAudit(actor, "callsheet", "session", sessionId, sheet.id);
  commit();
  return sheet;
}

// ── The recording session log ────────────────────────────────

export interface LogRowInput {
  plannedEpisodeId?: string | null; // every row of a series or devotion: one of the project's planned episodes
  itemLabel?: string; // a documentary's rows: an interview set, a scene, a location
  guest?: string;
  logDate?: string | null; // the session's date unless changed
  status?: LogStatus | null;
  notesForPost?: string; // pickups, retakes, timestamps, audio or focus problems, and any dates
}

const RECORDED: (LogStatus | null)[] = ["Recorded", "Pickup needed"];

/** Planned episodes a session's log may add: the project's own, not archived, and not recorded anywhere yet. */
export function availableForLog(sessionId: string): string[] {
  const db = getDb();
  const session = db.recordingSessions.find((s) => s.id === sessionId);
  if (!session) return [];
  const live = new Set(db.recordingSessions.filter((s) => !s.archivedAt).map((s) => s.id));
  const recorded = new Set(
    db.sessionLogEntries
      .filter((e) => e.sessionId !== sessionId && live.has(e.sessionId) && RECORDED.includes(e.status))
      .map((e) => e.plannedEpisodeId),
  );
  const made = new Set(db.records.filter((r) => r.episode && !r.archived).map((r) => r.episode!.plannedEpisodeId));
  const here = new Set(rowsOf(sessionId).map((e) => e.plannedEpisodeId));
  return db.plannedEpisodes
    .filter((p) => p.contentId === session.contentId && !p.archivedAt && !recorded.has(p.id) && !made.has(p.id) && !here.has(p.id))
    .sort((a, b) => a.episodeNumber - b.episodeNumber)
    .map((p) => p.id);
}

function checkStatus(session: RecordingSession, status: LogStatus | null | undefined): void {
  if (status && session.status !== "Open") throw new RuleError("A row's status is set during the session, once it is in Production.");
}

export function addLogRow(actor: Actor, sessionId: string, input: LogRowInput): SessionLogEntry {
  const { session, project } = sessionForWrite(actor, sessionId);
  if (session.status === "Closed") throw new RuleError("This session is closed. Reopen it to change its log.");
  checkStatus(session, input.status);
  const db = getDb();
  const plannedId = input.plannedEpisodeId || null;
  const label = (input.itemLabel ?? "").trim();
  let guest = (input.guest ?? "").trim();
  if (isDocumentary(project)) {
    if (!label) throw new RuleError("Name what was recorded: an interview set, a scene or a location.");
  } else if (!plannedId) throw new RuleError("Choose the planned episode this row is for.");
  if (plannedId) {
    const planned = db.plannedEpisodes.find((p) => p.id === plannedId && p.contentId === project.contentId);
    if (!planned || planned.archivedAt) throw new RuleError("That is not one of this project's planned episodes.");
    if (!availableForLog(sessionId).includes(plannedId))
      throw new RuleError(`${planned.workingTitle || planned.id} is already in this log, or was recorded in another session.`);
    guest ||= planned.guest;
  }
  const logDate = input.logDate || session.scheduledDate || todayIso();
  if (!isIsoDate(logDate)) throw new RuleError("Pick the row's date.");
  const at = nowStamp();
  const row: SessionLogEntry = {
    id: plannedId
      ? `${sessionId}|${plannedId}`
      : `${sessionId}|${localId("I", (x) => db.sessionLogEntries.some((e) => e.id === `${sessionId}|${x}`))}`,
    sessionId,
    plannedEpisodeId: plannedId,
    itemLabel: label,
    logDate,
    guest,
    status: input.status ?? null,
    notesForPost: (input.notesForPost ?? "").trim(),
    createdAt: at,
    updatedAt: at,
  };
  db.sessionLogEntries.push(row);
  session.updatedAt = at;
  logAudit(actor, "log-add", "session", sessionId, row.plannedEpisodeId ?? row.itemLabel);
  commit();
  return row;
}

export const LOG_EDITABLE = ["itemLabel", "guest", "logDate", "status", "notesForPost"] as const;

export function updateLogRow(actor: Actor, rowId: string, input: Omit<LogRowInput, "plannedEpisodeId">): SessionLogEntry {
  const row = getDb().sessionLogEntries.find((e) => e.id === rowId);
  if (!row) throw new RuleError("That log row no longer exists.");
  const { session } = sessionForWrite(actor, row.sessionId);
  if (session.status === "Closed") throw new RuleError("This session is closed. Reopen it to change its log.");
  const patch = pickKeys(input, LOG_EDITABLE);
  checkStatus(session, patch.status);
  if (patch.logDate !== undefined && !isIsoDate(patch.logDate)) throw new RuleError("Pick the row's date.");
  if (patch.itemLabel !== undefined) {
    if (!row.plannedEpisodeId && !patch.itemLabel.trim()) throw new RuleError("Name what was recorded.");
    row.itemLabel = patch.itemLabel.trim();
  }
  if (patch.guest !== undefined) row.guest = patch.guest.trim();
  if (patch.logDate) row.logDate = patch.logDate;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.notesForPost !== undefined) {
    if (patch.notesForPost.length > 20_000) throw new RuleError("Keep the notes under 20,000 characters.");
    row.notesForPost = patch.notesForPost.trim();
  }
  row.updatedAt = nowStamp();
  logAudit(actor, "log-update", "session", row.sessionId, `${row.plannedEpisodeId ?? row.itemLabel}: ${Object.keys(patch).join(", ")}`);
  commit();
  return row;
}

export function removeLogRow(actor: Actor, rowId: string): void {
  const db = getDb();
  const row = db.sessionLogEntries.find((e) => e.id === rowId);
  if (!row) throw new RuleError("That log row no longer exists.");
  const { session } = sessionForWrite(actor, row.sessionId);
  if (session.status === "Closed") throw new RuleError("This session is closed. Reopen it to change its log.");
  db.sessionLogEntries = db.sessionLogEntries.filter((e) => e.id !== rowId);
  logAudit(actor, "log-remove", "session", row.sessionId, row.plannedEpisodeId ?? row.itemLabel);
  commit();
}

// ── Production: opening, closing (the split), reopening ──────

/** Moves a session from Pre-production into Production, if its gate passes. */
export function openSession(actor: Actor, sessionId: string): RecordingSession {
  const { session } = sessionForWrite(actor, sessionId);
  const gate = evaluateGate("Pre-production", "session", sessionId);
  if (!gate.passed) throw gateError("Pre-production", gate.missing);
  session.status = "Open";
  session.updatedAt = nowStamp();
  ensureChecklist("wrap", "session", sessionId);
  logAudit(actor, "stage-advance", "session", sessionId, "Pre-production → Production");
  commit();
  return session;
}

export interface CloseResult {
  session: RecordingSession;
  made: string[]; // episodes made by this close
  kept: string[]; // episodes that already existed from an earlier close
  archived: string[]; // episodes from an earlier close whose row is now Not recorded
}

/**
 * "Close session and send to post production". All of it happens or none of it does:
 * 1. The gate is checked (wrap checklist complete, every log row has a status). If it fails, nothing changes.
 * 2. Every row Recorded or Pickup needed becomes an episode, {projectId}-E{nn}, numbered on from the project's
 *    last episode in the order of the plan, with the row's notes as its production notes. An episode that already
 *    exists is skipped, so closing twice never makes it twice.
 * 3. Rows Not recorded make nothing, and their planned episodes stay free for a later session.
 * 4. The session is Closed, with the time.
 * 5. Each new episode gets its rough cut and final review checkpoints, Pending.
 * A documentary's rows are not episodes: its film is made by sendToPostProduction.
 */
export function closeSession(actor: Actor, sessionId: string): CloseResult {
  const { session, project } = sessionForWrite(actor, sessionId);
  const gate = evaluateGate("Production", "session", sessionId);
  if (!gate.passed) throw gateError("Production", gate.missing);
  const db = getDb();
  const made: string[] = [];
  const kept: string[] = [];
  const archived: string[] = [];
  if (!isDocumentary(project)) {
    const planned = new Map(db.plannedEpisodes.map((p) => [p.id, p]));
    const rows = rowsOf(sessionId)
      .filter((r) => r.plannedEpisodeId && planned.has(r.plannedEpisodeId))
      .sort((a, b) => planned.get(a.plannedEpisodeId!)!.episodeNumber - planned.get(b.plannedEpisodeId!)!.episodeNumber);
    const label = categoryOf(project.category).workflow?.episodeLabel ?? "Episode";
    for (const row of rows) {
      const existing = db.records.find((r) => r.episode?.plannedEpisodeId === row.plannedEpisodeId && !r.archived);
      if (RECORDED.includes(row.status)) {
        if (existing) {
          kept.push(existing.contentId);
          continue;
        }
        const p = planned.get(row.plannedEpisodeId!)!;
        // An episode made before the workflow and waiting to be recorded becomes the episode, keeping its Content ID.
        // (It may also be that episode, archived because a reopened session marked it Not recorded.)
        const waiting = p.reservedId
          ? db.records.find((r) => r.contentId === p.reservedId && (!r.episode || (r.archived && r.episode.plannedEpisodeId === p.id)))
          : undefined;
        // Or a Content ID given out ahead of recording, with no record yet: the episode is made under it.
        const given = p.reservedId && !db.records.some((r) => r.contentId === p.reservedId) ? p.reservedId : undefined;
        const ep = makeEpisode(
          actor,
          project,
          {
            title: p.workingTitle || `${label} ${p.episodeNumber}`,
            plannedEpisodeId: p.id,
            sourceSessionId: sessionId,
            productionNotes: row.notesForPost,
            scheduledDate: row.logDate,
          },
          waiting ?? given,
        );
        made.push(ep.contentId);
      } else if (existing && existing.episode?.sourceSessionId === sessionId) {
        // Closed before, reopened, and now marked Not recorded: the untouched episode is archived, not deleted.
        existing.archived = true;
        existing.closedReason = `Session ${sessionId} was reopened and this was marked Not recorded.`;
        existing.version += 1;
        archived.push(existing.contentId);
      }
    }
  }
  session.status = "Closed";
  session.closedAt = nowStamp();
  session.updatedAt = session.closedAt;
  logAudit(
    actor,
    "stage-advance",
    "session",
    sessionId,
    `Production → closed. ${made.length ? `Made ${made.join(", ")}.` : "No new episodes."}${archived.length ? ` Archived ${archived.join(", ")}.` : ""}`,
  );
  commit();
  return { session, made, kept, archived };
}

/** Reopens a closed session, only while every episode made from it is still at Not started. */
export function reopenSession(actor: Actor, sessionId: string): RecordingSession {
  const { session, project } = sessionForWrite(actor, sessionId);
  if (session.status !== "Closed") throw new RuleError("This session is not closed.");
  const eps: Episode[] = isDocumentary(project)
    ? episodesOf(project.contentId)
    : episodesOf(project.contentId).filter((e) => e.episode.sourceSessionId === sessionId);
  const started = eps.filter((e) => e.episode.stage !== "Post production" || e.episode.postStage !== "Not started");
  if (started.length)
    throw new RuleError(
      `This session cannot be reopened: work has started on ${started.map((e) => `${e.contentId} (${e.episode.stage === "Post production" ? e.episode.postStage : e.episode.stage})`).join(", ")}.`,
    );
  session.status = "Open";
  session.closedAt = null;
  session.updatedAt = nowStamp();
  logAudit(actor, "reopen", "session", sessionId);
  commit();
  return session;
}

/**
 * A documentary's "Send to post production", once at least one session has closed: makes its film (or one episode
 * per planned part), with the notes from every closed session's log as its production notes.
 */
export function sendToPostProduction(actor: Actor, projectId: string): Episode[] {
  const p = projectForWrite(actor, projectId);
  if (!isDocumentary(p)) throw new RuleError("Series and devotions make their episodes when each session closes.");
  if (!canManageTeam(actor, p))
    throw new RuleError("Only the show producer or the Head of Production sends a documentary to post production.");
  const closed = sessionsOf(projectId).filter((s) => s.status === "Closed" && !s.archivedAt);
  if (!closed.length) throw new RuleError("Close at least one recording session first.");
  if (episodesOf(projectId).length) throw new RuleError("This documentary is already in post production.");
  const notes = closed
    .flatMap((s) =>
      rowsOf(s.id).map(
        (r) =>
          `${s.id}, ${r.logDate}, ${r.itemLabel || r.plannedEpisodeId}${r.guest ? ` (${r.guest})` : ""}: ${r.notesForPost || "no notes"}`,
      ),
    )
    .join("\n");
  const parts = getDb()
    .plannedEpisodes.filter((x) => x.contentId === projectId && !x.archivedAt)
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
  const made = (parts.length ? parts : [null]).map((part) =>
    makeEpisode(actor, p, {
      title: part ? part.workingTitle || `Part ${part.episodeNumber}` : p.title,
      plannedEpisodeId: part?.id ?? null,
      sourceSessionId: null,
      productionNotes: notes,
      scheduledDate: closed[closed.length - 1].scheduledDate,
    }),
  );
  logAudit(actor, "stage-advance", "record", projectId, `Sent to post production: ${made.map((e) => e.contentId).join(", ")}`);
  commit();
  return made;
}
