import type { Actor, CallSheet, CheckItem, ContentRecord, LiveLightKey, LiveLightState, RecordingSession, RunItem } from "../types";
import { RuleError } from "../types";
import { LIVE_LIGHTS, LIGHT_STATES, checkStateOf } from "../config/callSheet";
import { commit, getDb } from "../data/store";
import { localId } from "../data/ids";
import { canWrite, getRecord } from "./access";
import { logAudit } from "./audit";
import { getCallSheet } from "./callsheets";
import { canPlanEvent, daysOfEvent, isLiveEvent, productionOf, sheetOfDay, templateOfEvent, updateShowTemplate } from "./production";
import { checkContent } from "./sheetContent";
import { assertSheetOpen } from "./sheetLock";
import { timeInNairobi, todayIso } from "./utils";

// Live Shows, completed (build prompt v4, section 9): the Broadcast Plan's Rundown copied to the days, the Tech Check
// copied from the previous show, Live Control on the night (the rundown advanced by hand and status lights set by
// hand), and gear not returned after a show. A show's days are its sessions; each has one call sheet, which holds the
// day's run of show, Tech Check and Rehearsal Log.

// ── Reading ──────────────────────────────────────────────────

/** The segments every day of a show starts from: a recurring show's template's run of show, or the event's Rundown. */
export function rundownOf(eventId: string): RunItem[] {
  const event = getRecord(eventId);
  if (!isLiveEvent(event)) return [];
  const production = productionOf(event);
  if (production?.mode === "recurring") return templateOfEvent(eventId)?.sheet.runOfShow ?? [];
  return production?.rundown ?? [];
}

/** The lines of a day's Tech Check that have an issue: soft warnings, never a block. */
export const techIssues = (cs: CallSheet): CheckItem[] => cs.technicalCheck.filter((c) => checkStateOf(c) === "Issue");

/** How a day's Tech Check stands. */
export function techCounts(cs: CallSheet): { ok: number; issue: number; notChecked: number } {
  const states = cs.technicalCheck.map(checkStateOf);
  return {
    ok: states.filter((s) => s === "OK").length,
    issue: states.filter((s) => s === "Issue").length,
    notChecked: states.filter((s) => s === "Not checked").length,
  };
}

const liveSheets = (): CallSheet[] =>
  getDb().callSheets.filter((c) => {
    const day = getDb().recordingSessions.find((s) => s.callSheetId === c.id || c.instanceId === s.id);
    return !!day && getRecord(day.contentId)?.category === "live";
  });

/** The show before this sheet's day whose Tech Check it can start from: this show's latest earlier day, else any show's. */
export function previousTechSheet(sheetId: string): CallSheet | undefined {
  const cs = getCallSheet(sheetId);
  if (!cs) return undefined;
  const earlier = liveSheets()
    .filter((c) => c.id !== cs.id && c.date <= cs.date && c.technicalCheck.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return earlier.find((c) => c.contentId === cs.contentId) ?? earlier[0];
}

/** Where a day stands on the night: the segment on air, the next one, and the one after. */
export function liveNow(cs: CallSheet): {
  current: RunItem | null;
  next: RunItem | null;
  upNext: RunItem | null;
  done: number;
  total: number;
} {
  const rows = [...cs.runOfShow].sort((a, b) => a.time.localeCompare(b.time)).filter((r) => r.status !== "Cut");
  const at = rows.findIndex((r) => r.status === "Live");
  const ahead = rows.filter((r, i) => i > at && (r.status ?? "Planned") === "Planned");
  return {
    current: at >= 0 ? rows[at] : null,
    next: ahead[0] ?? null,
    upNext: ahead[1] ?? null,
    done: rows.filter((r) => r.status === "Done").length,
    total: rows.length,
  };
}

/** Gear checked out for a day whose show is over and not brought back yet: flagged on its sheet and in the urgency report. */
export interface NotReturned {
  manifestId: string;
  sheetId: string;
  due: string; // the day it was due back
  items: number;
  responsiblePersonId: string;
}

export function gearNotReturned(sheetId: string, today = todayIso()): NotReturned | null {
  const m = getDb()
    .manifests.filter((x) => x.callSheetId === sheetId && x.status === "checked-out")
    .find((x) => (x.expectedReturn ?? x.date) < today);
  if (!m) return null;
  const items = m.lines.reduce((n, l) => n + Math.max(0, l.quantity - l.returnedGood - l.damaged - l.lost), 0);
  return { manifestId: m.id, sheetId, due: m.expectedReturn ?? m.date, items, responsiblePersonId: m.responsiblePersonId };
}

/** Every day of a project with gear not brought back after it. */
export function projectGearNotReturned(projectId: string, today = todayIso()): NotReturned[] {
  return getDb()
    .recordingSessions.filter((s) => s.contentId === projectId && s.callSheetId)
    .map((s) => gearNotReturned(s.callSheetId!, today))
    .filter((x): x is NotReturned => !!x);
}

// ── Who may change what ──────────────────────────────────────

function eventForPlan(actor: Actor, eventId: string): ContentRecord {
  const event = getRecord(eventId);
  if (!isLiveEvent(event)) throw new RuleError("That show no longer exists.");
  if (event.archived) throw new RuleError("This show is closed.");
  if (!canPlanEvent(actor, event))
    throw new RuleError("Only the Head of Production, someone who manages the pipeline, or the show producer can change the Rundown.");
  return event;
}

function sheetForWrite(actor: Actor, sheetId: string): CallSheet {
  const cs = getCallSheet(sheetId);
  if (!cs) throw new RuleError("Call sheet not found.");
  const root = getRecord(cs.contentId);
  if (!root || !canWrite(actor, root)) throw new RuleError("You have view-only access to this project.");
  assertSheetOpen(cs);
  return cs;
}

const fresh = (rows: RunItem[]): RunItem[] =>
  rows.map((r) => ({ ...r, id: localId("RS"), status: "Planned" as const, actualStart: "", actualEnd: "" }));

// ── Changes ──────────────────────────────────────────────────

/**
 * Saves the Broadcast Plan's Rundown: its segments, with time, length, camera, audio and graphics. A recurring show's
 * Rundown is its template's run of show, so every coming day still following the template takes it at once.
 */
export function setRundown(actor: Actor, eventId: string, rows: RunItem[]): RunItem[] {
  const event = eventForPlan(actor, eventId);
  checkContent({ runOfShow: rows });
  const production = productionOf(event)!;
  if (production.mode === "recurring") {
    const t = templateOfEvent(eventId);
    if (!t) throw new RuleError("This show has no template yet.");
    updateShowTemplate(actor, t.id, { sheet: { runOfShow: rows } });
    return t.sheet.runOfShow;
  }
  event.production = { ...production, rundown: structuredClone(rows) };
  event.version += 1;
  logAudit(actor, "rundown", "record", eventId, `${rows.length} segment${rows.length === 1 ? "" : "s"}`);
  commit();
  return event.production.rundown!;
}

/**
 * Copies the Rundown to the show's days still to come (Pre-production): to those with no run of show yet, or, with
 * `replace`, to every one whose sheet is not final. A day that started keeps its own.
 */
export function copyRundownToDays(actor: Actor, eventId: string, replace = false): { copied: string[]; kept: string[] } {
  const event = eventForPlan(actor, eventId);
  const rows = rundownOf(eventId);
  if (!rows.length) throw new RuleError("The Rundown has no segments yet.");
  const out = { copied: [] as string[], kept: [] as string[] };
  for (const day of daysOfEvent(event.contentId)) {
    const cs = sheetOfDay(day);
    const open = !!cs && day.status === "Planned" && cs.status !== "final";
    if (!cs || !open || (cs.runOfShow.length > 0 && !replace)) {
      out.kept.push(day.id);
      continue;
    }
    cs.runOfShow = fresh(rows);
    cs.version += 1;
    out.copied.push(day.id);
  }
  logAudit(actor, "rundown-copy", "record", eventId, `${out.copied.length} days took the Rundown, ${out.kept.length} kept their own`);
  commit();
  return out;
}

/**
 * Starts a day's Tech Check from the previous show's: the same lines, who checks them and the gear, each Not checked
 * again, with no results or notes. Replaces the day's list.
 */
export function copyTechCheckFromPrevious(actor: Actor, sheetId: string): { from: string; lines: number } {
  const cs = sheetForWrite(actor, sheetId);
  const prev = previousTechSheet(sheetId);
  if (!prev) throw new RuleError("No earlier show has a Tech Check to copy.");
  cs.technicalCheck = prev.technicalCheck.map((c) => ({
    id: localId("TC"),
    label: c.label,
    done: false,
    note: "",
    state: "Not checked" as const,
    assigneeId: c.assigneeId ?? null,
    equipmentId: c.equipmentId ?? null,
    result: "",
  }));
  cs.version += 1;
  logAudit(actor, "techcheck-copy", "callsheet", cs.id, `From ${prev.id} (${prev.date}): ${cs.technicalCheck.length} lines`);
  commit();
  return { from: prev.id, lines: cs.technicalCheck.length };
}

/**
 * Live Control: moves the day on by one segment, by hand. "next" ends the segment on air (its actual end is now) and
 * puts the next planned one on air (its actual start is now); "back" undoes that. Work on the night: it never stops a
 * day following its template, and needs no new version of the sheet.
 */
export function advanceRundown(actor: Actor, sheetId: string, step: "next" | "back"): RunItem | null {
  const cs = sheetForWrite(actor, sheetId);
  const now = timeInNairobi(new Date());
  const rows = [...cs.runOfShow].sort((a, b) => a.time.localeCompare(b.time)).filter((r) => r.status !== "Cut");
  const at = rows.findIndex((r) => r.status === "Live");
  let onAir: RunItem | null = null;
  if (step === "next") {
    if (at >= 0) Object.assign(rows[at], { status: "Done", actualEnd: now });
    const next = rows.find((r, i) => i > at && (r.status ?? "Planned") === "Planned");
    if (next) {
      Object.assign(next, { status: "Live", actualStart: now, actualEnd: "" });
      onAir = next;
    } else if (at < 0) throw new RuleError("Every segment is done.");
  } else {
    if (at >= 0) Object.assign(rows[at], { status: "Planned", actualStart: "", actualEnd: "" });
    const before = [...rows.slice(0, at < 0 ? rows.length : at)].reverse().find((r) => r.status === "Done");
    if (before) {
      Object.assign(before, { status: "Live", actualEnd: "" });
      onAir = before;
    } else if (at < 0) throw new RuleError("Nothing has gone on air yet.");
  }
  cs.version += 1;
  logAudit(actor, "live-control", "callsheet", cs.id, onAir ? `On air: ${onAir.title} (${now})` : `Off air (${now})`);
  commit();
  return onAir;
}

/** Live Control: one status light, set by hand (cameras, audio, stream, graphics, recording, comms, internet). */
export function setLiveLight(actor: Actor, sessionId: string, key: LiveLightKey, state: LiveLightState): RecordingSession {
  const day = getDb().recordingSessions.find((s) => s.id === sessionId);
  if (!day) throw new RuleError("That day no longer exists.");
  const event = getRecord(day.contentId);
  if (!isLiveEvent(event)) throw new RuleError("Live Control is for a live show's day.");
  if (!canWrite(actor, event) || event.archived) throw new RuleError("You have view-only access to this show.");
  if (day.archivedAt) throw new RuleError("This day is off the schedule.");
  if (!LIVE_LIGHTS.some((l) => l.key === key)) throw new RuleError("That is not one of Live Control's lights.");
  if (!LIGHT_STATES.some((l) => l.key === state)) throw new RuleError("A light is Not set, OK, Watch or Down.");
  day.liveLights = { ...(day.liveLights ?? {}), [key]: state };
  day.liveLightsAt = new Date().toISOString();
  day.liveLightsBy = actor.personId;
  logAudit(
    actor,
    "live-light",
    "session",
    day.id,
    `${LIVE_LIGHTS.find((l) => l.key === key)!.label}: ${LIGHT_STATES.find((l) => l.key === state)!.label}`,
  );
  commit();
  return day;
}
