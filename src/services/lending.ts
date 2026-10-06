import type { Actor, EquipCondition, Loan, LoanLine } from "../types";
import { RuleError } from "../types";
import { commit, getDb, nextCounter } from "../data/store";
import { claimId } from "../data/ids";
import { logAudit } from "./audit";
import { availabilityOn, getItem, requireGearAccess } from "./equipment-items";
import { hist } from "./equipment-log";
import { isIsoDate, pad, pickKeys, todayIso } from "./utils";

// Lending (Equipment, Lending): gear lent to someone outside a production, a church, a partner or a member, with its
// own number (DOF-LOAN-0001) and no Content ID. It replaces the General Use category. A lent item is unavailable to
// bookings and to the conflict check from the day it goes out until its expected return, and once late, until it is
// checked back in (src/services/equipment-items.ts, availabilityOn). Items can come back a few at a time.

const CONDITIONS: EquipCondition[] = ["New", "Good", "Fair", "Poor"];
const text = (v: unknown, max: number, what: string): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max) throw new RuleError(`Keep ${what} under ${max} characters.`);
  return s;
};

export const getLoan = (id: string): Loan | undefined => (getDb().loans ?? []).find((l) => l.id === id);

/** How many of a line are still with the borrower. */
export const outstanding = (line: LoanLine): number => line.quantity - line.returns.reduce((n, r) => n + r.quantity, 0);

/** The last day a loan holds its items: its expected return, or, once late and still out, until it is checked in. */
export function loanEnd(loan: Loan, today = todayIso()): string {
  return loan.status === "out" && loan.expectedReturn < today ? "9999-12-31" : loan.expectedReturn;
}

/** Loans still out (any item not back), soonest due first. */
export const loansOut = (): Loan[] =>
  (getDb().loans ?? []).filter((l) => l.status === "out").sort((a, b) => a.expectedReturn.localeCompare(b.expectedReturn));

/** Loans past their expected return with something still out. */
export const overdueLoans = (today = todayIso()): Loan[] => loansOut().filter((l) => l.expectedReturn < today);

/** Days a loan is late (0 if not). */
export const daysLate = (loan: Loan, today = todayIso()): number =>
  loan.status !== "out" || loan.expectedReturn >= today
    ? 0
    : Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${loan.expectedReturn}T00:00:00Z`)) / 86_400_000);

export interface LoanInput {
  borrowerName: string;
  borrowerPhone?: string;
  organisation?: string;
  dateOut: string;
  expectedReturn: string;
  notes?: string;
  lines: { equipmentId: string; quantity: number }[];
}

function checkDates(dateOut: string, expectedReturn: string): void {
  if (!isIsoDate(dateOut)) throw new RuleError("Pick the day the gear goes out.");
  if (!isIsoDate(expectedReturn)) throw new RuleError("Pick the day it is expected back.");
  if (expectedReturn < dateOut) throw new RuleError("It cannot be expected back before it goes out.");
}

/** Lends gear. Each item must be free for the whole loan: not booked for a production, not lent, not out of service. */
export function createLoan(actor: Actor, input: LoanInput): Loan {
  requireGearAccess(actor);
  const borrowerName = text(input.borrowerName, 120, "the borrower's name");
  if (!borrowerName) throw new RuleError("Who is borrowing it? Give a name.");
  checkDates(input.dateOut, input.expectedReturn);
  if (!input.lines.length) throw new RuleError("Choose at least one item to lend.");
  if (new Set(input.lines.map((l) => l.equipmentId)).size !== input.lines.length) throw new RuleError("Each item is listed once.");
  const lines: LoanLine[] = input.lines.map((l) => {
    const item = getItem(l.equipmentId);
    if (!item) throw new RuleError("That item no longer exists.");
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw new RuleError("Quantities start at 1.");
    if (item.trackingType === "serialized" && l.quantity !== 1) throw new RuleError(`${item.name} is a single unit.`);
    if (item.baseStatus !== "active") throw new RuleError(`${item.name} (${item.id}) is out of service and cannot be lent.`);
    const a = availabilityOn(item, input.dateOut, input.expectedReturn);
    if (a.availableQty < l.quantity)
      throw new RuleError(
        a.availableQty > 0
          ? `Only ${a.availableQty} of ${item.name} (${item.id}) are free for those dates. ${a.reason}.`
          : `${item.name} (${item.id}) is not free for those dates. ${a.reason}.`,
      );
    return { equipmentId: item.id, quantity: l.quantity, conditionOut: item.condition, returns: [] };
  });
  const at = new Date().toISOString();
  const loan: Loan = {
    id: claimId(`DOF-LOAN-${pad(nextCounter("loan"), 4)}`),
    borrowerName,
    borrowerPhone: text(input.borrowerPhone, 60, "the phone number"),
    organisation: text(input.organisation, 160, "the organisation"),
    lines,
    dateOut: input.dateOut,
    expectedReturn: input.expectedReturn,
    notes: text(input.notes, 2000, "the notes"),
    lentBy: actor.personId,
    status: "out",
    createdAt: at,
    updatedAt: at,
    returnedAt: null,
    fromContentId: null,
  };
  (getDb().loans ??= []).push(loan);
  for (const l of lines)
    hist(
      actor,
      l.equipmentId,
      "lent",
      `Lent to ${borrowerName}${loan.organisation ? ` (${loan.organisation})` : ""} until ${loan.expectedReturn}, ${loan.id}`,
    );
  logAudit(actor, "lend", "loan", loan.id, `${borrowerName}, ${lines.length} item${lines.length === 1 ? "" : "s"}`);
  commit();
  return loan;
}

export const LOAN_EDITABLE = ["borrowerName", "borrowerPhone", "organisation", "expectedReturn", "notes"] as const;
export type LoanPatch = Partial<Pick<Loan, (typeof LOAN_EDITABLE)[number]>>;

function loanForWrite(actor: Actor, id: string): Loan {
  requireGearAccess(actor);
  const loan = getLoan(id);
  if (!loan) throw new RuleError("That loan no longer exists.");
  return loan;
}

/** Changes a loan still out: the borrower's details, the notes, or the day it is expected back (checked for clashes). */
export function updateLoan(actor: Actor, id: string, input: LoanPatch): Loan {
  const loan = loanForWrite(actor, id);
  if (loan.status !== "out") throw new RuleError("This loan is closed.");
  const patch = pickKeys(input, LOAN_EDITABLE);
  if (patch.borrowerName !== undefined) {
    const name = text(patch.borrowerName, 120, "the borrower's name");
    if (!name) throw new RuleError("Who is borrowing it? Give a name.");
    loan.borrowerName = name;
  }
  if (patch.borrowerPhone !== undefined) loan.borrowerPhone = text(patch.borrowerPhone, 60, "the phone number");
  if (patch.organisation !== undefined) loan.organisation = text(patch.organisation, 160, "the organisation");
  if (patch.notes !== undefined) loan.notes = text(patch.notes, 2000, "the notes");
  if (patch.expectedReturn !== undefined && patch.expectedReturn !== loan.expectedReturn) {
    checkDates(loan.dateOut, patch.expectedReturn);
    // Kept longer: each item still out must be free for the extra days.
    if (patch.expectedReturn > loan.expectedReturn)
      for (const l of loan.lines) {
        const left = outstanding(l);
        if (!left) continue;
        const item = getItem(l.equipmentId);
        if (!item) continue;
        const a = availabilityOn(item, loan.expectedReturn, patch.expectedReturn, undefined, loan.id);
        if (a.availableQty < left) throw new RuleError(`${item.name} (${item.id}) is booked after ${loan.expectedReturn}: ${a.reason}.`);
      }
    loan.expectedReturn = patch.expectedReturn;
  }
  loan.updatedAt = new Date().toISOString();
  logAudit(actor, "update", "loan", id, Object.keys(patch).join(", "));
  commit();
  return loan;
}

export interface LoanReturnInput {
  equipmentId: string;
  quantity: number;
  condition: EquipCondition;
  note?: string;
}

/** Checks items back in, all or some. When the last one is back the loan closes. A serialized item takes the condition it came back in. */
export function returnLoanItems(actor: Actor, id: string, returns: LoanReturnInput[]): Loan {
  const loan = loanForWrite(actor, id);
  if (loan.status !== "out") throw new RuleError("Everything on this loan is already back.");
  if (!returns.length) throw new RuleError("Choose what came back.");
  const at = new Date().toISOString();
  for (const r of returns) {
    const line = loan.lines.find((l) => l.equipmentId === r.equipmentId);
    if (!line) throw new RuleError("That item is not on this loan.");
    if (!Number.isInteger(r.quantity) || r.quantity < 1) throw new RuleError("Quantities start at 1.");
    if (r.quantity > outstanding(line)) throw new RuleError(`Only ${outstanding(line)} of that item are still out.`);
    if (!CONDITIONS.includes(r.condition)) throw new RuleError("Choose the condition it came back in.");
    line.returns.push({ at, by: actor.personId, quantity: r.quantity, condition: r.condition, note: text(r.note, 500, "the note") });
    const item = getItem(r.equipmentId);
    if (item?.trackingType === "serialized") item.condition = r.condition;
    hist(
      actor,
      r.equipmentId,
      "loan-returned",
      `${r.quantity} back from ${loan.borrowerName}, ${r.condition}${r.note ? `. ${r.note.trim()}` : ""}, ${loan.id}`,
    );
  }
  if (loan.lines.every((l) => outstanding(l) === 0)) {
    loan.status = "returned";
    loan.returnedAt = at;
  }
  loan.updatedAt = at;
  logAudit(
    actor,
    "loan-return",
    "loan",
    id,
    `${returns.reduce((n, r) => n + r.quantity, 0)} back${loan.status === "returned" ? ", all back" : ""}`,
  );
  commit();
  return loan;
}

/** Calls off a loan before anything has come back (made by mistake, or the borrower did not come). Kept, never deleted. */
export function cancelLoan(actor: Actor, id: string, reason: string): Loan {
  const loan = loanForWrite(actor, id);
  if (loan.status !== "out") throw new RuleError("This loan is closed.");
  if (loan.lines.some((l) => l.returns.length)) throw new RuleError("Items have already come back. Check the rest in instead.");
  if (!reason.trim()) throw new RuleError("Say why the loan is called off.");
  loan.status = "cancelled";
  loan.notes = [loan.notes, `Called off: ${reason.trim()}`].filter(Boolean).join("\n");
  loan.updatedAt = new Date().toISOString();
  for (const l of loan.lines) hist(actor, l.equipmentId, "loan-returned", `Loan ${loan.id} called off`);
  logAudit(actor, "loan-cancel", "loan", id, reason.trim());
  commit();
  return loan;
}
