import type { Actor, CallSheet, ContentRecord, ProductionLevel, RunItem } from "../types";
import { ConflictError, RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { canWrite, getRecord, rootOf } from "./access";
import { leavesUnder } from "./content";
import { logAudit } from "./audit";
import { copyGearBetweenSheets, gearIssues, rebookSheetGear, releaseSheetGear } from "./equipment";
import { getPerson } from "./people";
import { pad } from "./utils";

export const getCallSheet = (id: string): CallSheet | undefined => getDb().callSheets.find((c) => c.id === id);

/** Episodes/leaves inside the same project scheduled for a date. Never crosses projects. */
export function episodesOnDate(projectId: string, date: string): ContentRecord[] {
  const root = getRecord(projectId);
  if (!root) return [];
  return leavesUnder(root).filter((r) => r.scheduledDate === date);
}

/** The existing call sheet that already covers this record, if any. */
export function callSheetForRecord(record: ContentRecord): CallSheet | undefined {
  const rootId = rootOf(record).contentId;
  return getDb().callSheets.find(
    (cs) => cs.contentId === rootId && (cs.linkedEpisodeIds.includes(record.contentId) || (record.scheduledDate !== null && cs.date === record.scheduledDate)),
  );
}

export interface CallSheetInput {
  contentId: string;
  date: string;
  title?: string;
  location?: string;
  callTime?: string;
  crewPersonIds?: string[];
  format?: string;
  notes?: string;
}

export function createCallSheet(actor: Actor, input: CallSheetInput): CallSheet {
  const root = getRecord(input.contentId);
  if (!root) throw new RuleError("Project not found.");
  if (!canWrite(actor, root)) throw new RuleError("You are not assigned to this project.");
  if (!input.date) throw new RuleError("Pick a date for the call sheet.");
  const cs: CallSheet = {
    id: `DOF-CS-${pad(nextCounter("callsheet"))}`,
    contentId: root.contentId,
    title: input.title?.trim() || `${root.title}: ${input.date}`,
    date: input.date,
    location: input.location ?? "",
    callTime: input.callTime ?? "08:00",
    linkedEpisodeIds: episodesOnDate(root.contentId, input.date).map((r) => r.contentId), // fixed at creation
    crewPersonIds: input.crewPersonIds ?? [],
    equipmentIds: [],
    runOfShow: [],
    format: input.format ?? "",
    notes: input.notes ?? "",
    status: "draft",
    version: 1,
    createdAt: new Date().toISOString(),
  };
  getDb().callSheets.push(cs);
  logAudit(actor, "create", "callsheet", cs.id, `${cs.linkedEpisodeIds.length} linked`);
  commit();
  return cs;
}

/** From the pipeline's call sheet button: open the existing sheet or create the first one. */
export function openOrCreateForRecord(actor: Actor, recordId: string): { sheet: CallSheet; created: boolean } {
  const rec = getRecord(recordId);
  if (!rec) throw new RuleError("Record not found.");
  const existing = callSheetForRecord(rec);
  if (existing) return { sheet: existing, created: false };
  if (!rec.scheduledDate) throw new RuleError("Set a shoot date on this record before creating a call sheet.");
  const root = rootOf(rec);
  return { sheet: createCallSheet(actor, { contentId: root.contentId, date: rec.scheduledDate }), created: true };
}

/** Crew, location, format and gear carry over. Episode links are re-resolved for the new date. */
export function duplicateCallSheet(actor: Actor, id: string, newDate: string): { sheet: CallSheet; gear: { copied: number; skipped: string[] } } {
  const src = getCallSheet(id);
  if (!src) throw new RuleError("Call sheet not found.");
  const copy = createCallSheet(actor, {
    contentId: src.contentId,
    date: newDate,
    title: `${src.title.replace(/:.*$/, "")}: ${newDate}`,
    location: src.location,
    callTime: src.callTime,
    crewPersonIds: [...src.crewPersonIds],
    format: src.format,
    notes: src.notes,
  });
  copy.runOfShow = src.runOfShow.map((x) => ({ ...x, id: `RS-${pad(nextCounter("runitem"), 4)}` }));
  // Gear that is already booked on the new date is skipped and reported, never double-booked.
  const gear = copyGearBetweenSheets(actor, src.id, { id: copy.id, contentId: copy.contentId, date: copy.date });
  logAudit(actor, "duplicate", "callsheet", copy.id, `from ${src.id}`);
  commit();
  return { sheet: copy, gear };
}

export interface Mismatch {
  moved: ContentRecord[]; // linked, but the episode's date no longer matches
  unlinked: ContentRecord[]; // now scheduled on this date but not linked
}

/** Flags drift for a human to resolve. Never changes the link on its own. */
export function getMismatches(cs: CallSheet): Mismatch {
  const linked = cs.linkedEpisodeIds.map((id) => getRecord(id)).filter((r): r is ContentRecord => !!r);
  const moved = linked.filter((r) => r.scheduledDate !== cs.date || r.archived);
  const unlinked = episodesOnDate(cs.contentId, cs.date).filter((r) => !cs.linkedEpisodeIds.includes(r.contentId));
  return { moved, unlinked };
}

export function resolveMismatches(actor: Actor, id: string, expectedVersion?: number): CallSheet {
  const cs = loadSheet(actor, id, expectedVersion);
  cs.linkedEpisodeIds = episodesOnDate(cs.contentId, cs.date).map((r) => r.contentId);
  cs.version += 1;
  logAudit(actor, "resolve-mismatch", "callsheet", id, `${cs.linkedEpisodeIds.length} linked`);
  commit();
  return cs;
}

function loadSheet(actor: Actor, id: string, expectedVersion?: number): CallSheet {
  const cs = getCallSheet(id);
  if (!cs) throw new RuleError("Call sheet not found.");
  const root = getRecord(cs.contentId);
  if (!root || !canWrite(actor, root)) throw new RuleError("You have view-only access to this project.");
  if (expectedVersion !== undefined && cs.version !== expectedVersion) throw new ConflictError();
  return cs;
}

export function updateCallSheet(
  actor: Actor,
  id: string,
  patch: Partial<Pick<CallSheet, "title" | "location" | "callTime" | "crewPersonIds" | "format" | "notes" | "date">>,
  expectedVersion?: number,
): CallSheet {
  const cs = loadSheet(actor, id, expectedVersion);
  if (cs.status === "final") throw new RuleError("This call sheet is final. Reopen it to make changes.");
  // Gear bookings follow the shoot date, or the change is refused.
  if (patch.date !== undefined && patch.date !== cs.date) {
    if (!patch.date) throw new RuleError("Pick a date for the call sheet.");
    rebookSheetGear(actor, cs.id, patch.date);
  }
  Object.assign(cs, patch);
  cs.version += 1;
  logAudit(actor, "update", "callsheet", id, Object.keys(patch).join(", "));
  commit();
  return cs;
}

/** People on another call sheet on the same date. */
export function crewConflicts(cs: CallSheet): { personId: string; otherSheet: CallSheet }[] {
  const out: { personId: string; otherSheet: CallSheet }[] = [];
  for (const other of getDb().callSheets) {
    if (other.id === cs.id || other.date !== cs.date) continue;
    for (const pid of cs.crewPersonIds) if (other.crewPersonIds.includes(pid)) out.push({ personId: pid, otherSheet: other });
  }
  return out;
}

export function finalizeCallSheet(actor: Actor, id: string, expectedVersion?: number): CallSheet {
  const cs = loadSheet(actor, id, expectedVersion);
  const conflicts = crewConflicts(cs);
  if (conflicts.length) {
    const names = conflicts.map((c) => getDb().people.find((p) => p.personId === c.personId)?.name ?? c.personId);
    throw new RuleError(`Crew double-booked on ${cs.date}: ${[...new Set(names)].join(", ")}. Resolve before finalizing.`);
  }
  const mm = getMismatches(cs);
  if (mm.moved.length || mm.unlinked.length) throw new RuleError("Episode dates no longer match this call sheet. Resolve the mismatch before finalizing.");
  if (runOfShowRequired(cs) && cs.runOfShow.length === 0) throw new RuleError("This is a large production, so the call sheet needs a run of show before it can be final.");
  const gear = gearIssues(cs.id);
  if (gear.length) throw new RuleError(`Gear needs attention before finalizing: ${gear[0]}${gear.length > 1 ? ` (and ${gear.length - 1} more)` : ""}`);
  cs.status = "final";
  cs.version += 1;
  logAudit(actor, "finalize", "callsheet", id);
  commit();
  return cs;
}

export function reopenCallSheet(actor: Actor, id: string): CallSheet {
  const cs = loadSheet(actor, id);
  cs.status = "draft";
  cs.version += 1;
  logAudit(actor, "reopen", "callsheet", id);
  commit();
  return cs;
}

export function duplicateOf(cs: CallSheet): CallSheet[] {
  return getDb().callSheets.filter((c) => c.contentId === cs.contentId && c.id !== cs.id);
}

export function deleteCallSheet(actor: Actor, id: string): void {
  const cs = loadSheet(actor, id);
  releaseSheetGear(actor, id); // refuses if the gear is out
  getDb().callSheets = getDb().callSheets.filter((c) => c.id !== id);
  logAudit(actor, "delete", "callsheet", cs.id, cs.title);
  commit();
}

// ── Run of show (large live productions) ─────────────────────

/** The days a call sheet covers. Each day of a live show carries its own level of production. */
export function daysOf(cs: CallSheet): ContentRecord[] {
  return cs.linkedEpisodeIds.map((id) => getRecord(id)).filter((r): r is ContentRecord => !!r && !r.archived);
}

/** The biggest level among the days on this sheet, or the show's own if no days are linked. */
export function sheetLevel(cs: CallSheet): ProductionLevel | null {
  const order: ProductionLevel[] = ["small", "medium", "large"];
  const levels = [...daysOf(cs).map((d) => d.productionLevel), getRecord(cs.contentId)?.productionLevel ?? null].filter((l): l is ProductionLevel => !!l);
  return levels.sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? null;
}

/** A large production needs a minute-by-minute run of show on its call sheet. */
export function runOfShowRequired(cs: CallSheet): boolean {
  return sheetLevel(cs) === "large";
}

export const sortedRunOfShow = (cs: CallSheet): RunItem[] => [...cs.runOfShow].sort((a, b) => a.time.localeCompare(b.time));

export interface RunItemInput { time: string; title: string; durationMin: number; ownerPersonId?: string | null; notes?: string }

function checkRunItem(input: RunItemInput): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new RuleError("Enter the start time as hours and minutes, for example 09:30.");
  if (!input.title.trim()) throw new RuleError("Give this segment a name.");
  if (!Number.isInteger(input.durationMin) || input.durationMin < 0 || input.durationMin > 600) throw new RuleError("Length must be a whole number of minutes, up to 600.");
  if (input.ownerPersonId) {
    const p = getPerson(input.ownerPersonId);
    if (!p || p.status !== "active") throw new RuleError("Choose an active person.");
  }
}

function editableSheet(actor: Actor, id: string): CallSheet {
  const cs = loadSheet(actor, id);
  if (cs.status === "final") throw new RuleError("This call sheet is final. Reopen it to make changes.");
  if (!runOfShowRequired(cs) && cs.runOfShow.length === 0) throw new RuleError("A run of show is for large productions. Set the level of production to Large on the day first.");
  return cs;
}

export function addRunItem(actor: Actor, sheetId: string, input: RunItemInput): RunItem {
  const cs = editableSheet(actor, sheetId);
  checkRunItem(input);
  const item: RunItem = { id: `RS-${pad(nextCounter("runitem"), 4)}`, time: input.time, title: input.title.trim(), durationMin: input.durationMin, ownerPersonId: input.ownerPersonId || null, notes: (input.notes ?? "").trim() };
  cs.runOfShow.push(item);
  cs.version += 1;
  logAudit(actor, "run-add", "callsheet", sheetId, `${item.time} ${item.title}`);
  commit();
  return item;
}

export function updateRunItem(actor: Actor, sheetId: string, itemId: string, patch: Partial<RunItemInput>): RunItem {
  const cs = editableSheet(actor, sheetId);
  const item = cs.runOfShow.find((x) => x.id === itemId);
  if (!item) throw new RuleError("That segment no longer exists.");
  const next = { time: patch.time ?? item.time, title: patch.title ?? item.title, durationMin: patch.durationMin ?? item.durationMin, ownerPersonId: patch.ownerPersonId === undefined ? item.ownerPersonId : patch.ownerPersonId, notes: patch.notes ?? item.notes };
  checkRunItem(next);
  Object.assign(item, { ...next, title: next.title.trim(), notes: next.notes.trim() });
  cs.version += 1;
  logAudit(actor, "run-update", "callsheet", sheetId, item.title);
  commit();
  return item;
}

export function removeRunItem(actor: Actor, sheetId: string, itemId: string): void {
  const cs = editableSheet(actor, sheetId);
  cs.runOfShow = cs.runOfShow.filter((x) => x.id !== itemId);
  cs.version += 1;
  logAudit(actor, "run-remove", "callsheet", sheetId, itemId);
  commit();
}

/** Total running time, and the time the last segment ends. */
export function runOfShowTotals(cs: CallSheet): { minutes: number; ends: string | null } {
  const items = sortedRunOfShow(cs);
  if (!items.length) return { minutes: 0, ends: null };
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const end = Math.max(...items.map((i) => toMin(i.time) + i.durationMin));
  const first = toMin(items[0].time);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return { minutes: end - first, ends: `${pad2(Math.floor(end / 60) % 24)}:${pad2(end % 60)}` };
}
