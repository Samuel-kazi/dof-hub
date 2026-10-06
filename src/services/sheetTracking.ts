import type { Actor, CallSheet, Confirmation, RunItem, SheetChange, TalentEntry } from "../types";
import { getDb } from "../data/store";
import { localId } from "../data/ids";
import { fmtDate } from "./utils";

// What a call sheet keeps once the team relies on it. From the moment it is shared (first made final) or anyone
// confirms, every change to its call time, location, crew, talent and schedule is logged with who made it and
// when. A confirmation records the call time, place and role the person said yes to; when any of the three
// changes, it is cleared (and the log says so), and they confirm again.

/** The parts of a sheet whose changes are logged. */
export interface Tracked {
  date: string;
  callTime: string;
  talentCall: string;
  startTime: string;
  wrapTime: string;
  location: string;
  crew: string[];
  roles: Record<string, string>;
  lead: string | null;
  talent: TalentEntry[];
  runOfShow: RunItem[];
}

export function trackedOf(cs: CallSheet): Tracked {
  return structuredClone({
    date: cs.date,
    callTime: cs.callTime,
    talentCall: cs.talentCall,
    startTime: cs.startTime,
    wrapTime: cs.wrapTime,
    location: placeOf(cs),
    crew: cs.crewPersonIds,
    roles: cs.crewRoles,
    lead: cs.crewLeadId,
    talent: cs.talent,
    runOfShow: cs.runOfShow,
  });
}

/** Whether a sheet's changes are logged: it has been shared, or someone has confirmed. */
export const isTracked = (cs: CallSheet): boolean => !!cs.sharedAt || Object.keys(cs.confirmations ?? {}).length > 0;

/** Where the sheet sends people: the place and its address. */
export const placeOf = (cs: { location: string; locationAddress: string }): string =>
  [cs.location.trim(), cs.locationAddress.trim()].filter(Boolean).join(", ");

const nameOf = (personId: string | null): string =>
  personId ? (getDb().people.find((p) => p.personId === personId)?.name ?? personId) : "";
const orNone = (v: string): string => v || "not set";

/** A talent row's call time: its own, else the sheet's talent call, else the crew call. */
export const talentCallOf = (cs: Pick<CallSheet, "talentCall" | "callTime">, t: TalentEntry): string =>
  t.callTime || cs.talentCall || cs.callTime;

const talentLine = (t: TalentEntry): string => `${t.name}${t.role ? ` (${t.role})` : ""}${t.callTime ? `, call ${t.callTime}` : ""}`;
const runLine = (i: RunItem): string => `${i.time} ${i.title} (${i.durationMin} min)`;

/** The differences between two states of a sheet, as lines of its change log (without who or when). */
export function diffTracked(a: Tracked, b: Tracked): Omit<SheetChange, "id" | "at" | "by">[] {
  const out: Omit<SheetChange, "id" | "at" | "by">[] = [];
  const add = (what: string, from: string, to: string) => out.push({ what, from, to });
  if (a.date !== b.date) add("Date", a.date ? fmtDate(a.date) : "not set", b.date ? fmtDate(b.date) : "not set");
  for (const [k, what] of [
    ["callTime", "Crew call"],
    ["talentCall", "Talent call"],
    ["startTime", "Start"],
    ["wrapTime", "Wrap"],
  ] as const)
    if (a[k] !== b[k]) add(what, orNone(a[k]), orNone(b[k]));
  if (a.location !== b.location) add("Location", orNone(a.location), orNone(b.location));
  for (const pid of b.crew) if (!a.crew.includes(pid)) add("Crew added", "", `${nameOf(pid)}${b.roles[pid] ? ` (${b.roles[pid]})` : ""}`);
  for (const pid of a.crew) if (!b.crew.includes(pid)) add("Crew removed", nameOf(pid), "");
  for (const pid of b.crew)
    if (a.crew.includes(pid) && (a.roles[pid] ?? "") !== (b.roles[pid] ?? ""))
      add(`Role of ${nameOf(pid)}`, orNone(a.roles[pid] ?? ""), orNone(b.roles[pid] ?? ""));
  if (a.lead !== b.lead) add("Crew lead", nameOf(a.lead) || "none", nameOf(b.lead) || "none");
  rows(a.talent, b.talent, talentLine, "Talent", add);
  rows(a.runOfShow, b.runOfShow, runLine, "Run of show", add);
  return out;
}

function rows<T extends { id: string }>(
  a: T[],
  b: T[],
  line: (x: T) => string,
  what: string,
  add: (what: string, from: string, to: string) => void,
): void {
  const before = new Map(a.map((x) => [x.id, x]));
  const after = new Map(b.map((x) => [x.id, x]));
  for (const x of b) {
    const old = before.get(x.id);
    if (!old) add(`${what} added`, "", line(x));
    else if (line(old) !== line(x)) add(`${what} changed`, line(old), line(x));
  }
  for (const x of a) if (!after.has(x.id)) add(`${what} removed`, line(x), "");
}

/** What a person on the sheet would be confirming now: its call time, place and their role. */
export function confirmationTerms(cs: CallSheet, key: string): Omit<Confirmation, "at" | "by"> | null {
  if (key.startsWith("talent:")) {
    const t = cs.talent.find((x) => x.id === key.slice(7));
    return t ? { callTime: talentCallOf(cs, t), location: placeOf(cs), role: t.role } : null;
  }
  if (!cs.crewPersonIds.includes(key)) return null;
  return { callTime: cs.callTime, location: placeOf(cs), role: cs.crewRoles[key] ?? "" };
}

/** Whom a confirmation key stands for. */
export function confirmationName(cs: CallSheet, key: string): string {
  if (key.startsWith("talent:")) return cs.talent.find((x) => x.id === key.slice(7))?.name ?? "Talent";
  return nameOf(key);
}

/** Whether a confirmation still holds: the person is on the sheet and its call time, place and their role are as they were. */
export function confirmationHolds(cs: CallSheet, key: string): boolean {
  const c = cs.confirmations[key];
  const now = confirmationTerms(cs, key);
  return !!c && !!now && c.callTime === now.callTime && c.location === now.location && c.role === now.role;
}

/** Why a confirmation no longer holds, in a few words. */
function whyStale(cs: CallSheet, key: string): string {
  const c = cs.confirmations[key];
  const now = confirmationTerms(cs, key);
  if (!now) return key.startsWith("talent:") ? "taken off the talent" : "taken off the crew";
  const why = [c.callTime !== now.callTime && "call time", c.location !== now.location && "location", c.role !== now.role && "role"].filter(
    Boolean,
  );
  return `${why.join(" and ")} changed`;
}

/**
 * After a change to a sheet: logs what changed (when the sheet was shared or confirmed before the change), and
 * clears every confirmation the change made stale, logging that too. Returns the lines added.
 */
export function noteChanges(actor: Actor, cs: CallSheet, before: Tracked): SheetChange[] {
  const tracked = isTracked(cs);
  const at = new Date().toISOString();
  const lines: SheetChange[] = [];
  const push = (x: Omit<SheetChange, "id" | "at" | "by">) =>
    lines.push({ id: localId("CH", (id) => cs.changeLog.some((c) => c.id === id)), at, by: actor.personId, ...x });
  if (tracked) for (const x of diffTracked(before, trackedOf(cs))) push(x);
  for (const key of Object.keys(cs.confirmations ?? {}).sort()) {
    if (confirmationHolds(cs, key)) continue;
    // A talent row taken off has its name only in the sheet as it was.
    const gone = key.startsWith("talent:") ? before.talent.find((x) => x.id === key.slice(7))?.name : undefined;
    push({ what: "Confirmation cleared", from: `${gone ?? confirmationName(cs, key)} had confirmed`, to: whyStale(cs, key) });
    delete cs.confirmations[key];
  }
  cs.changeLog.push(...lines);
  return lines;
}

/** The sheet's change log, newest first. */
export const changesOf = (cs: CallSheet): SheetChange[] => [...(cs.changeLog ?? [])].reverse();
