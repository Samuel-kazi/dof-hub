import type { Actor, CallSheet, CategoryKey, ContentRecord, UrgencyThresholds } from "../types";
import { getDb } from "../data/store";
import { DEFAULT_URGENCY, URGENCY_LEVELS, type UrgencyLevel } from "../config/urgency";
import { canView, visibleRecords } from "./access";
import { leavesUnder, riskOf } from "./content";
import { gearIssues } from "./equipment-manifests";
import { can } from "./permissions";
import { daysLate, overdueLoans } from "./lending";
import { nairobiInstant } from "./alerts";
import { instancesOf, type ProductionInstance } from "./productionInstances";
import { sheetWarnings } from "./sheetAdvice";
import { episodesOf, unscheduledPlanned, type Project } from "./workflow/common";
import { episodeOverdue } from "./workflow/gates";
import { hasTheologicalReview, theologyStatus } from "./documents/theology";
import { addDaysIso, fmtDate, todayIso } from "./utils";

// The urgency report (build prompt v2, section 12): each project gets a level, Critical, High, Watch or On track, and
// the reasons in plain words, from fixed, transparent rules (no AI). The numbers the rules use are in settings
// (src/config/urgency.ts). Overdue still comes only from episodes (and, for categories on their own pipelines, from
// their tracks and items), never from a series, season or project itself.

export interface UrgencyRow {
  kind: "project" | "loan";
  id: string;
  title: string;
  category: CategoryKey | "loan";
  level: UrgencyLevel;
  reasons: string[]; // most urgent first
  soonest: string | null; // the nearest date the reasons are about, to sort by
  link: string; // where it opens
}

export const urgencyThresholds = (): UrgencyThresholds => ({ ...DEFAULT_URGENCY, ...(getDb().settings.urgency ?? {}) });

const rank = (l: UrgencyLevel): number => URGENCY_LEVELS.indexOf(l);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "in 3 hours", "tomorrow", "in 3 days", "today". */
function inWords(hours: number): string {
  if (hours < 0) return "today";
  if (hours < 12) return `in ${plural(Math.max(1, Math.round(hours)), "hour")}`;
  const days = Math.round(hours / 24);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

class Finding {
  level: UrgencyLevel = "On track";
  reasons: { level: UrgencyLevel; text: string }[] = [];
  soonest: string | null = null;
  add(level: UrgencyLevel, text: string, date?: string | null) {
    this.reasons.push({ level, text });
    if (rank(level) < rank(this.level)) this.level = level;
    if (date && (!this.soonest || date < this.soonest)) this.soonest = date;
  }
  sorted = (): string[] => [...this.reasons].sort((a, b) => rank(a.level) - rank(b.level)).map((r) => r.text);
}

/** Hours from now to an instance's start (its date at its start time, or 08:00). */
const hoursTo = (i: ProductionInstance, now: string): number =>
  (Date.parse(nairobiInstant(i.date!, i.start)) - Date.parse(now)) / 3_600_000;

const sheetOf = (id: string | null): CallSheet | undefined => (id ? getDb().callSheets.find((c) => c.id === id) : undefined);

/** The rules every production instance (session or show day) shares: a call sheet near the day, gear, details. */
function instanceRules(
  f: Finding,
  insts: ProductionInstance[],
  now: string,
  t: UrgencyThresholds,
  today: string,
  unassigned: number,
): void {
  const coming = insts.filter((i) => i.date && i.date >= today && i.status !== "cancelled" && i.status !== "done");
  for (const i of coming) {
    const h = hoursTo(i, now);
    const what = i.kind === "session" ? "Recording" : "Show";
    const soon = h <= t.soonHours;
    const cs = sheetOf(i.callSheetId);
    if (soon && (!cs || cs.status !== "final"))
      f.add("Critical", `${what} ${inWords(h)} (${i.label}) with no published call sheet.`, i.date);
    if (soon && unassigned > 0)
      f.add("Critical", `${what} ${inWords(h)}. ${plural(unassigned, "item")} not assigned to a session.`, i.date);
    if (cs) {
      const gear = gearIssues(cs.id);
      if (gear.length) f.add(soon ? "Critical" : "High", `Gear clash for ${i.label} (${fmtDate(i.date)}): ${gear[0]}`, i.date);
      if (i.date! <= addDaysIso(today, 14)) {
        const missing = sheetWarnings(cs, today).filter((w) => !w.text.includes("not confirmed"));
        if (missing.length)
          f.add("Watch", `Call sheet for ${i.label}: ${missing.map((w) => w.text.replace(/\.$/, "").toLowerCase()).join(", ")}.`, i.date);
      }
    }
  }
}

function workflowProjectRow(p: Project, now: string, t: UrgencyThresholds, today: string): UrgencyRow {
  const f = new Finding();
  const eps = episodesOf(p.contentId);
  const late = eps.filter((e) => episodeOverdue(e, today));
  if (late.length)
    f.add(
      "Critical",
      `${plural(late.length, "episode")} overdue: ${late.map((e) => e.title).join(", ")}.`,
      late[0].stageDeadlines[late[0].episode.stage],
    );
  const dueSoon = eps.filter((e) => {
    const due = e.stageDeadlines[e.episode.stage];
    return (
      !episodeOverdue(e, today) &&
      e.episode.mdStage !== "Published" &&
      !!due &&
      Date.parse(nairobiInstant(due, "23:59")) - Date.parse(now) <= t.dueHours * 3_600_000
    );
  });
  if (dueSoon.length)
    f.add(
      "High",
      `${plural(dueSoon.length, "episode")} due within ${t.dueHours} hours.`,
      dueSoon[0].stageDeadlines[dueSoon[0].episode.stage],
    );
  const greenlit = p.workflow.stage === "Pre-production";
  if (greenlit && !p.workflow.showProducerId) f.add("High", "No show producer named after the greenlight.");
  const unassigned = greenlit ? unscheduledPlanned(p.contentId) : 0;
  instanceRules(f, instancesOf(p.contentId), now, t, today, unassigned);
  // The theological review is a reminder, never a gate: while it is not done the project is watched.
  if (hasTheologicalReview(p) && !theologyStatus(p.contentId).done) f.add("Watch", "Theological review not done.");
  if (unassigned > 0) f.add("Watch", `${plural(unassigned, "item")} not assigned to a session.`);
  const due = p.stageDeadlines[p.workflow.stage] ?? p.deadline;
  const dated = instancesOf(p.contentId).some((i) => i.date && i.status !== "cancelled");
  if (greenlit && due && due >= today && due <= addDaysIso(today, t.noRecordingDays) && !dated)
    f.add("Watch", `Due ${fmtDate(due)} and no recording date yet.`, due);
  return row(f, "project", p.contentId, p.title, p.category, `#/record/${p.contentId}`);
}

/** A live show or a DOF Music project, on their own pipelines: their days or tracks overdue, and the show days' sheets. */
function legacyProjectRow(r: ContentRecord, now: string, t: UrgencyThresholds, today: string): UrgencyRow {
  const f = new Finding();
  // A show's days are production instances, never overdue themselves; a music project's tracks can be.
  const late = r.category === "live" ? [] : leavesUnder(r).filter((x) => !x.archived && riskOf(x) === "overdue");
  if (late.length) f.add("Critical", `${plural(late.length, "item")} overdue: ${late.map((x) => x.title).join(", ")}.`);
  if (r.category === "live") instanceRules(f, instancesOf(r.contentId), now, t, today, 0);
  return row(f, "project", r.contentId, r.title, r.category, `#/record/${r.contentId}`);
}

const row = (
  f: Finding,
  kind: UrgencyRow["kind"],
  id: string,
  title: string,
  category: UrgencyRow["category"],
  link: string,
): UrgencyRow => ({
  kind,
  id,
  title,
  category,
  level: f.level,
  reasons: f.sorted(),
  soonest: f.soonest,
  link,
});

/**
 * Every project this person may see, with its level and reasons, most urgent first (then by the nearest date), and
 * for those who use the equipment, each loan that is late.
 */
export function urgencyReport(actor: Actor, now = new Date().toISOString()): UrgencyRow[] {
  const t = urgencyThresholds();
  const today = todayIso();
  const rows: UrgencyRow[] = [];
  for (const r of visibleRecords(actor)) {
    if (r.archived || r.category === "general") continue;
    if (r.workflow) {
      if (r.workflow.status === "Completed" || r.workflow.status === "Closed" || r.workflow.status === "Advice only") continue;
      rows.push(workflowProjectRow(r as Project, now, t, today));
    } else if (r.hierarchyLevel === 0 && !r.episode && (r.category === "live" || r.category === "music")) {
      if (canView(actor, r)) rows.push(legacyProjectRow(r, now, t, today));
    }
  }
  if (can(actor, "equipment.use"))
    for (const loan of overdueLoans(today)) {
      const late = daysLate(loan, today);
      rows.push({
        kind: "loan",
        id: loan.id,
        title: `${loan.borrowerName}${loan.organisation ? ` (${loan.organisation})` : ""}`,
        category: "loan",
        level: late > t.loanOverdueHighDays ? "Critical" : "High",
        reasons: [`Loan ${loan.id} ${plural(late, "day")} late: due back ${fmtDate(loan.expectedReturn)}.`],
        soonest: loan.expectedReturn,
        link: "#/equipment",
      });
    }
  return rows.sort(
    (a, b) => rank(a.level) - rank(b.level) || (a.soonest ?? "9999").localeCompare(b.soonest ?? "9999") || a.title.localeCompare(b.title),
  );
}
