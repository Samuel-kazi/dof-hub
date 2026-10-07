import type { CheckItem, ContactEntry, GearRequest, RehearsalStep, RunItem, SheetContent, TalentEntry } from "../types";
import { RuleError } from "../types";
import { CHECK_STATES, SHEET_CONTENT_KEYS, blankSheetContent } from "../config/callSheet";
import { getDb } from "../data/store";
import { localId } from "../data/ids";

// A call sheet's content, the part a Show Template holds too: copied whole when a day is made from a template, when
// a new day of an event starts from the day before, and when a sheet is duplicated. One way of copying, one set of
// checks, for sheets and templates alike.

/** The content of a sheet or template, as a plain copy. */
export function contentOf(src: SheetContent): SheetContent {
  const out = blankSheetContent() as unknown as Record<string, unknown>;
  for (const k of SHEET_CONTENT_KEYS) out[k] = structuredClone((src as unknown as Record<string, unknown>)[k] ?? out[k]);
  return out as unknown as SheetContent;
}

/** A copy for another day: the same content, with new row IDs and every tick cleared. */
export function cloneContent(src: SheetContent): SheetContent {
  const c = contentOf(src);
  c.talent = c.talent.map((x) => ({ ...x, id: localId("TL") }));
  c.contacts = c.contacts.map((x) => ({ ...x, id: localId("CT") }));
  c.runOfShow = c.runOfShow.map((x) => ({ ...x, id: localId("RS") }));
  c.technicalCheck = c.technicalCheck.map((x) => ({
    ...x,
    id: localId("TC"),
    done: false,
    note: "",
    ...(x.state !== undefined ? { state: "Not checked" as const, result: "" } : {}),
  }));
  // The rehearsal's steps and who does them are kept; when each was checked, and its notes, are the day's own.
  c.rehearsal = {
    ...c.rehearsal,
    done: false,
    ...(c.rehearsal.steps ? { steps: c.rehearsal.steps.map((x) => ({ ...x, id: localId("RH"), time: "", notes: "", done: false })) } : {}),
  };
  return c;
}

/** Writes content onto a sheet (or template), every field. */
export function applyContent(target: SheetContent, content: SheetContent): void {
  const t = target as unknown as Record<string, unknown>;
  for (const k of SHEET_CONTENT_KEYS) t[k] = structuredClone((content as unknown as Record<string, unknown>)[k]);
}

/** Whether a change to the technical check or rehearsal only ticks lines or adds notes to them: work on the day, not a change of plan. */
export function onlyTicks(before: SheetContent, patch: Partial<SheetContent>): boolean {
  for (const k of Object.keys(patch) as (keyof SheetContent)[]) {
    if (k === "technicalCheck") {
      // The day's own: the tick, the state, the test result and the note. The lines, who checks them and the gear are the plan.
      const now = patch.technicalCheck!;
      if (now.length !== before.technicalCheck.length) return false;
      const was = before.technicalCheck;
      if (
        now.some(
          (x, i) =>
            x.id !== was[i].id ||
            x.label !== was[i].label ||
            (x.assigneeId ?? null) !== (was[i].assigneeId ?? null) ||
            (x.equipmentId ?? null) !== (was[i].equipmentId ?? null),
        )
      )
        return false;
    } else if (k === "rehearsal") {
      // The day's own: when each step was checked, who checked it, its notes and tick. The steps themselves are the plan.
      const r = patch.rehearsal!;
      if (r.time !== before.rehearsal.time || r.notes !== before.rehearsal.notes) return false;
      const now = r.steps ?? [];
      const was = before.rehearsal.steps ?? [];
      if (now.length !== was.length || now.some((x, i) => x.id !== was[i].id || x.step !== was[i].step)) return false;
    } else return false;
  }
  return true;
}

// ── Checks ───────────────────────────────────────────────────

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const checkTime = (v: string, what: string): void => {
  if (v !== "" && !TIME.test(v)) throw new RuleError(`Enter the ${what} as hours and minutes, for example 09:30.`);
};
const checkText = (v: unknown, what: string, max: number): void => {
  if (typeof v !== "string") throw new RuleError(`${what} must be text.`);
  if (v.length > max) throw new RuleError(`Keep ${what.toLowerCase()} under ${max} characters.`);
};
const checkRows = <T extends { id: string }>(rows: T[], what: string, max: number): void => {
  if (rows.length > max) throw new RuleError(`A sheet can list up to ${max} ${what}.`);
  const ids = new Set<string>();
  for (const r of rows) {
    if (!r.id || ids.has(r.id)) throw new RuleError(`Each line of ${what} needs its own ID.`);
    ids.add(r.id);
  }
};

function checkTalent(t: TalentEntry): void {
  if (!t.name.trim()) throw new RuleError("Give each person in Talent a name.");
  checkText(t.name, "A name", 120);
  checkText(t.role, "A role", 120);
  checkText(t.contact, "A contact", 200);
  checkText(t.notes, "Notes", 1000);
  checkTime(t.callTime, "call time");
}
function checkContact(c: ContactEntry): void {
  if (!c.name.trim()) throw new RuleError("Give each contact a name.");
  checkText(c.name, "A name", 120);
  checkText(c.role, "A role", 120);
  checkText(c.phone, "A phone number", 60);
  checkText(c.email, "An email", 200);
}
function checkItem(c: CheckItem): void {
  if (!c.label.trim()) throw new RuleError("Give each line of the technical check a name.");
  checkText(c.label, "A line of the check", 200);
  checkText(c.note, "A note", 1000);
  if (c.state !== undefined && !CHECK_STATES.includes(c.state)) throw new RuleError("A line of the check is Not checked, OK or Issue.");
  if (c.result !== undefined) checkText(c.result, "A test result", 1000);
  if (c.assigneeId) checkPerson(c.assigneeId, "each line of the check");
  if (c.equipmentId && !getDb().equipment.some((e) => e.id === c.equipmentId))
    throw new RuleError("That equipment item is no longer in the inventory.");
}
function checkPerson(personId: string, what: string): void {
  const p = getDb().people.find((x) => x.personId === personId);
  if (!p || p.status !== "active") throw new RuleError(`Choose an active person for ${what}.`);
}
function checkStep(r: RehearsalStep): void {
  if (!r.step.trim()) throw new RuleError("Give each rehearsal step a name.");
  checkText(r.step, "A rehearsal step", 120);
  checkTime(r.time, "time the step was checked");
  checkText(r.notes, "Notes", 1000);
  if (r.personId) checkPerson(r.personId, "each rehearsal step");
}
function checkRun(i: RunItem): void {
  if (!TIME.test(i.time)) throw new RuleError("Enter each segment's start as hours and minutes, for example 09:30.");
  if (!i.title.trim()) throw new RuleError("Give each segment a name.");
  checkText(i.title, "A segment", 300);
  checkText(i.notes, "Notes", 2000);
  if (!Number.isInteger(i.durationMin) || i.durationMin < 0 || i.durationMin > 600)
    throw new RuleError("A segment runs from 0 to 600 minutes.");
  if (i.ownerPersonId) {
    const p = getDb().people.find((x) => x.personId === i.ownerPersonId);
    if (!p || p.status !== "active") throw new RuleError("Choose an active person for each segment.");
  }
  // A live show's columns.
  for (const [k, what] of [
    ["camera", "Camera"],
    ["audio", "Audio"],
    ["graphics", "Graphics"],
  ] as const)
    if (i[k] !== undefined) checkText(i[k]!, what, 120);
  if (i.status !== undefined && !["Planned", "Live", "Done", "Cut"].includes(i.status))
    throw new RuleError("A segment is planned, live, done or cut.");
  for (const t of [i.actualStart, i.actualEnd])
    if (t && !TIME.test(t)) throw new RuleError("Enter actual times as hours and minutes, for example 09:30.");
}
function checkGear(g: GearRequest): void {
  if (!g.equipmentId) throw new RuleError("Choose the gear.");
  if (!Number.isInteger(g.quantity) || g.quantity < 1) throw new RuleError("Gear quantities start at 1.");
}

/** Checks a change to a sheet's or template's content, field by field. Crew must be active people. */
export function checkContent(patch: Partial<SheetContent>, crewAfter?: string[]): void {
  for (const [k, what] of [
    ["callTime", "crew call"],
    ["talentCall", "talent call"],
    ["startTime", "start time"],
    ["wrapTime", "wrap time"],
  ] as const)
    if (patch[k] !== undefined) checkTime(patch[k]!, what);
  if (patch.location !== undefined) checkText(patch.location, "The location", 500);
  if (patch.locationAddress !== undefined) checkText(patch.locationAddress, "The address", 1000);
  if (patch.locationNotes !== undefined) checkText(patch.locationNotes, "Location notes", 4000);
  if (patch.locationId !== undefined && patch.locationId !== null) {
    const saved = (getDb().locations ?? []).find((l) => l.id === patch.locationId);
    if (!saved || saved.archived) throw new RuleError("That saved location is no longer on the list.");
  }
  if (patch.format !== undefined) checkText(patch.format, "The format", 300);
  if (patch.notes !== undefined) checkText(patch.notes, "Notes", 20_000);
  const people = getDb().people;
  if (patch.crewPersonIds !== undefined) {
    if (patch.crewPersonIds.length > 200) throw new RuleError("A sheet can list up to 200 crew.");
    for (const pid of patch.crewPersonIds) {
      const p = people.find((x) => x.personId === pid);
      if (!p || p.status !== "active") throw new RuleError("Choose active people for the crew.");
      if (p.category === "PTR") throw new RuleError("Partners review work; put crew or volunteers on the crew.");
    }
  }
  const crew = new Set(crewAfter ?? patch.crewPersonIds ?? []);
  if (patch.crewRoles !== undefined)
    for (const [pid, role] of Object.entries(patch.crewRoles)) {
      checkText(role, "A crew role", 120);
      if (crewAfter && !crew.has(pid)) throw new RuleError("Give roles only to people on the crew.");
    }
  if (patch.crewLeadId !== undefined && patch.crewLeadId !== null && crewAfter && !crew.has(patch.crewLeadId))
    throw new RuleError("The crew lead must be on the crew.");
  if (patch.talent !== undefined) {
    checkRows(patch.talent, "talent", 100);
    patch.talent.forEach(checkTalent);
  }
  if (patch.contacts !== undefined) {
    checkRows(patch.contacts, "contacts", 100);
    patch.contacts.forEach(checkContact);
  }
  if (patch.technicalCheck !== undefined) {
    checkRows(patch.technicalCheck, "technical checks", 100);
    patch.technicalCheck.forEach(checkItem);
  }
  if (patch.runOfShow !== undefined) {
    checkRows(patch.runOfShow, "segments", 200);
    patch.runOfShow.forEach(checkRun);
  }
  if (patch.logistics !== undefined) for (const v of Object.values(patch.logistics)) checkText(v, "Logistics", 4000);
  if (patch.rehearsal !== undefined) {
    checkTime(patch.rehearsal.time, "rehearsal time");
    checkText(patch.rehearsal.notes, "Rehearsal notes", 4000);
    if (patch.rehearsal.steps !== undefined) {
      checkRows(patch.rehearsal.steps, "rehearsal steps", 40);
      patch.rehearsal.steps.forEach(checkStep);
    }
  }
  if (patch.plannedGear !== undefined) {
    if (patch.plannedGear.length > 200) throw new RuleError("A sheet can plan up to 200 items of gear.");
    patch.plannedGear.forEach(checkGear);
  }
}

/**
 * Keeps only the content fields of a change, and tidies them: crew roles and the lead follow the crew, and a sheet
 * whose place is changed by hand no longer points at the saved location it was picked from.
 */
export function tidyContent(patch: Partial<SheetContent>, current: SheetContent): Partial<SheetContent> {
  const out: Partial<SheetContent> = {};
  for (const k of SHEET_CONTENT_KEYS) if (k in patch) (out as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
  if (out.locationId === current.locationId) delete out.locationId;
  if (out.locationId === undefined && current.locationId && (out.location !== undefined || out.locationAddress !== undefined)) {
    const saved = (getDb().locations ?? []).find((l) => l.id === current.locationId);
    const name = out.location ?? current.location;
    const address = out.locationAddress ?? current.locationAddress;
    if (!saved || saved.name !== name.trim() || saved.address !== address.trim()) out.locationId = null;
  }
  // A line with a state is done exactly when it is OK, so a tick and a state never disagree: a tick sets the state
  // (a screen that only ticks), and a state sets the tick.
  if (out.technicalCheck) {
    const was = new Map(current.technicalCheck.map((x) => [x.id, x]));
    out.technicalCheck = out.technicalCheck.map((x) => {
      if (!x.state) return x;
      const before = was.get(x.id);
      const ticked = !!before && x.done !== before.done && x.state === (before.state ?? (before.done ? "OK" : "Not checked"));
      return ticked ? { ...x, state: x.done ? "OK" : "Not checked" } : { ...x, done: x.state === "OK" };
    });
  }
  if (out.crewPersonIds) {
    const crew = new Set(out.crewPersonIds);
    const roles = out.crewRoles ?? current.crewRoles;
    out.crewRoles = Object.fromEntries(Object.entries(roles).filter(([pid]) => crew.has(pid)));
    const lead = out.crewLeadId !== undefined ? out.crewLeadId : current.crewLeadId;
    out.crewLeadId = lead && crew.has(lead) ? lead : null;
  }
  return out;
}
