import { z } from "zod";
import type { Actor, CriterionKey, DevelopmentForm, FormType, GreenlightDecision, GreenlightOutcome } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { CRITERIA, formTypeOf } from "../../config/workflow";
import { DEV_FORMS, plannedSectionOf, sectionOf, type FieldDef, type SectionDef } from "../../config/devForms";
import { isIsoDate, todayIso } from "../utils";
import { logAudit } from "../audit";
import { canDecide, formOf, nowStamp, openRequired, projectForWrite, requireCrew, requireProject, type Project } from "./common";
import { hardGatesMissing } from "../documents/gates";

// The development form: its sections, checked against src/config/devForms.ts every time they are saved, the six
// greenlight criteria, the review window and the greenlight decision.

// ── Checking what is saved ───────────────────────────────────

const OPTIONAL_DATE = z.union([z.literal(""), z.string().refine(isIsoDate, "Expected a date written YYYY-MM-DD.")]);

function fieldSchema(f: FieldDef): z.ZodType {
  switch (f.type) {
    case "text":
      return z.string().max(300);
    case "longtext":
      return z.string().max(20_000);
    case "date":
      return OPTIONAL_DATE;
    case "crew":
      return z.string().max(120);
    case "select":
      return z.enum(["", ...(f.options ?? [])] as [string, ...string[]]);
    case "multiselect":
      return z.array(z.enum([...(f.options ?? [])] as [string, ...string[]])).max(f.options?.length ?? 0);
    case "yesno":
      return z.enum(["", "yes", "no"]);
    case "amount":
      return z.number().min(0).max(1e12).nullable();
  }
}

/** What one section may hold: its own fields, each the right type, and nothing else. */
export const sectionSchema = (def: SectionDef) =>
  z.strictObject(Object.fromEntries(def.fields.map((f) => [f.key, fieldSchema(f).optional()])) as Record<string, z.ZodType>);

/** What each planned episode may carry for a form type, beyond its title, question, guest and notes. */
export const plannedDetailsSchema = (formType: FormType) =>
  z.strictObject(
    Object.fromEntries(
      (plannedSectionOf(formType)?.planned?.details ?? []).map((f) => [f.key, z.string().max(20_000).optional()]),
    ) as Record<string, z.ZodType>,
  );

/** Turns the first problem zod found into a sentence a person can act on. */
export function explain(error: z.ZodError, labelOf: (key: string) => string): string {
  const issue = error.issues[0];
  const key = String(issue?.path[0] ?? "");
  if (issue?.code === "unrecognized_keys") return `This form has no field called ${issue.keys.join(", ")}.`;
  return `${key ? `${labelOf(key)}: ` : ""}${issue?.message ?? "That is not valid."}`;
}

const filled = (f: FieldDef, v: unknown): boolean => {
  switch (f.type) {
    case "multiselect":
      return Array.isArray(v) && v.length > 0;
    case "amount":
      return typeof v === "number";
    case "date":
      return isIsoDate(v);
    default:
      return typeof v === "string" && v.trim() !== "";
  }
};

/** Answers that must be "yes", not only answered, before the form is complete. */
const MUST_BE_YES: Record<string, string> = {
  "consent.agreement": "The person must agree to be recorded and published.",
  "guest.availableAllDays": "The guest's availability must be confirmed for all five days.",
};

/**
 * The sections a greenlight decision needs complete. A DOF-made documentary's first greenlight approves the
 * thesis and treatment, so its team and budget sections only need to be complete for the second.
 */
export function requiredSections(formType: FormType, stage: 1 | 2 = 1): SectionDef[] {
  const all = DEV_FORMS[formType].filter((s) => s.fields.some((f) => f.required) || (s.planned?.min ?? 0) > 0);
  return formType === "documentary_dof" && stage === 1 ? all.filter((s) => s.key !== "team" && s.key !== "budget") : all;
}

/** Everything still missing from a project's form for a greenlight at `stage`, as sentences. */
export function formProblems(projectId: string, stage: 1 | 2 = 1): string[] {
  const form = formOf(projectId);
  const out: string[] = [];
  for (const section of requiredSections(form.formType, stage)) {
    const values = form.sections[section.key] ?? {};
    for (const f of section.fields) {
      if (f.required && !filled(f, values[f.key])) out.push(`${section.label}: ${f.label}`);
      const must = MUST_BE_YES[`${section.key}.${f.key}`];
      if (must && filled(f, values[f.key]) && values[f.key] !== "yes") out.push(`${section.label}: ${must}`);
    }
    if (section.planned) {
      const planned = getDb()
        .plannedEpisodes.filter((p) => p.contentId === projectId && !p.archivedAt)
        .sort((a, b) => a.episodeNumber - b.episodeNumber);
      const { min, max, label } = section.planned;
      if (planned.length < min) out.push(`${section.label}: ${label} needs at least ${min} (${planned.length} so far)`);
      if (max !== undefined && planned.length > max) out.push(`${section.label}: ${label} can have at most ${max}`);
      for (const p of planned)
        for (const d of section.planned.details)
          if (d.required && !filled(d, p.details[d.key]))
            out.push(`${section.label}: ${p.workingTitle || `Episode ${p.episodeNumber}`} needs ${d.label}`);
    }
  }
  return out;
}

// ── Saving the form ──────────────────────────────────────────

/** Saves some fields of one section. Fields left out keep their value; an empty value clears one. */
export function saveFormSection(actor: Actor, projectId: string, sectionKey: string, values: Record<string, unknown>): DevelopmentForm {
  const project = projectForWrite(actor, projectId);
  const form = formOf(projectId);
  const def = sectionOf(form.formType, sectionKey);
  if (!def) throw new RuleError("That section is not part of this project's form.");
  const parsed = sectionSchema(def).safeParse(values ?? {});
  if (!parsed.success) throw new RuleError(explain(parsed.error, (k) => def.fields.find((f) => f.key === k)?.label ?? k));
  const clean = Object.fromEntries(Object.entries(parsed.data as Record<string, unknown>).filter(([, v]) => v !== undefined));
  for (const f of def.fields)
    if (f.type === "crew" && typeof clean[f.key] === "string" && clean[f.key] !== "") requireCrew(clean[f.key] as string, f.label);
  form.sections[sectionKey] = { ...(form.sections[sectionKey] ?? {}), ...clean };
  // A sermon's delivery decides which later stages apply, so it is kept on the project as well.
  if (form.formType === "sermon" && sectionKey === "brief" && "delivery" in clean)
    project.workflow.sermonFormat = clean.delivery === "In person" ? "in_person" : clean.delivery === "Recorded" ? "recorded" : null;
  form.updatedAt = nowStamp();
  logAudit(actor, "form-save", "record", projectId, `${def.label}: ${Object.keys(clean).join(", ")}`);
  commit();
  return form;
}

export function setCriterion(
  actor: Actor,
  projectId: string,
  key: CriterionKey,
  value: { met: boolean | null; note: string },
): DevelopmentForm {
  projectForWrite(actor, projectId);
  if (!CRITERIA.some((c) => c.key === key)) throw new RuleError("That is not one of the six greenlight criteria.");
  const form = formOf(projectId);
  form.criteria[key] = { met: value.met, note: value.note.trim() };
  form.updatedAt = nowStamp();
  logAudit(actor, "form-criterion", "record", projectId, `${key}: ${value.met === null ? "not assessed" : value.met ? "met" : "not met"}`);
  commit();
  return form;
}

/**
 * The date by which a greenlight decision is due. If it passes with no decision, the project moves to Hold by
 * itself. Setting a new window after Hold or "Revise and resubmit" starts a new wait for a decision.
 */
export function setReviewWindow(actor: Actor, projectId: string, date: string | null): DevelopmentForm {
  projectForWrite(actor, projectId);
  const form = formOf(projectId);
  if (date !== null) {
    if (!isIsoDate(date)) throw new RuleError("Pick the review window's date.");
    if (date < todayIso()) throw new RuleError("The review window must end today or later.");
  }
  form.reviewWindowDate = date;
  if (date !== null && (form.outcome === "Hold" || form.outcome === "Revise and resubmit")) form.outcome = null;
  form.updatedAt = nowStamp();
  logAudit(actor, "review-window", "record", projectId, date ?? "cleared");
  commit();
  return form;
}

// ── The greenlight decision ──────────────────────────────────

/** The greenlight stage a decision is made at now: 1, or 2 for a DOF-made documentary past its first. */
export const greenlightStageOf = (form: DevelopmentForm): 1 | 2 => form.greenlightStage ?? 1;

/** The latest decision made at a greenlight stage, if any. */
export const latestDecision = (form: DevelopmentForm, stage: 1 | 2): GreenlightDecision | undefined =>
  [...form.decisions].reverse().find((d) => d.stage === stage);

/** What stops "Greenlight" being chosen now, as sentences. */
export function greenlightBlockers(project: Project, stage: 1 | 2): string[] {
  // The first greenlight needs only the hard gates before the decision (src/services/documents/gates.ts). A live show's
  // Greenlight is a document, not a gate: it can be recorded at any time (build prompt v4, section 9).
  if (stage === 1) return project.category === "live" ? [] : hardGatesMissing(project.contentId, ["greenlight"]);
  // A DOF-made documentary's second greenlight, at Pre-production: its shot list. The shoot budget and interview sets
  // are written in its documents (the Documentary Brief's Ask, the Treatment's Interview guide).
  return openRequired("preProject", project.contentId).filter((l) => l.startsWith("Shot list"));
}

export interface DecisionInput {
  outcome: GreenlightOutcome;
  notes: string;
  date?: string | null;
}

/**
 * Records the team's decision. "Greenlight" needs the hard gates before it met (greenlightBlockers). "Decline"
 * and "Advice only" need a reason and close the project: it is archived, never deleted, with its Content ID kept.
 */
export function decideGreenlight(actor: Actor, projectId: string, input: DecisionInput): DevelopmentForm {
  if (!canDecide(actor))
    throw new RuleError('Only the Head of Production, or someone given "Create projects", can make a greenlight decision.');
  const project = requireProject(projectId);
  if (project.archived) throw new RuleError("This project is closed.");
  const form = formOf(projectId);
  const type = formTypeOf(form.formType);
  const stage = greenlightStageOf(form);
  if (!type.outcomes.includes(input.outcome)) throw new RuleError(`${input.outcome} is not a possible decision for a ${type.label} form.`);
  const expected = stage === 1 ? "Development" : "Pre-production";
  if (project.workflow.stage !== expected)
    throw new RuleError(`The ${stage === 2 ? "second " : ""}greenlight is decided during ${expected}.`);
  const notes = input.notes.trim();
  const date = input.date || todayIso();
  if (!isIsoDate(date)) throw new RuleError("Pick the decision date.");
  if ((input.outcome === "Decline" || input.outcome === "Advice only") && !notes)
    throw new RuleError(`Write the reason for "${input.outcome}". It is kept with the project.`);
  if (input.outcome === "Greenlight") {
    const blockers = greenlightBlockers(project, stage);
    if (blockers.length) throw new RuleError(`Before a greenlight: ${blockers.join("; ")}.`);
  }
  form.decisions.push({ stage, outcome: input.outcome, notes, date, byPersonId: actor.personId, at: nowStamp() });
  form.outcome = input.outcome;
  form.reviewNotes = notes;
  form.decisionDate = date;
  form.updatedAt = nowStamp();
  if (input.outcome === "Decline" || input.outcome === "Advice only") {
    project.workflow.status = input.outcome === "Decline" ? "Closed" : "Advice only";
    project.closedReason = notes;
    project.archived = true;
    project.version += 1;
  }
  logAudit(
    actor,
    "greenlight",
    "record",
    projectId,
    `${stage === 2 ? "Second greenlight" : "Greenlight"}: ${input.outcome}${notes ? `. ${notes}` : ""}`,
  );
  commit();
  return form;
}

// ── The review window, checked every day ─────────────────────

export const SYSTEM: Actor = { personId: "system", role: "HOP" };

/**
 * Moves to Hold every project whose review window has passed with no decision. Run on app load and once a day
 * (by the server, or by the desktop app itself), and safe to run any number of times: a project it has moved
 * already has a decision. Each move is written to the activity log. The caller saves. Returns the projects moved.
 */
export function applyReviewWindows(today: string = todayIso()): string[] {
  const db = getDb();
  const moved: string[] = [];
  for (const form of db.developmentForms) {
    if (!form.reviewWindowDate || form.reviewWindowDate >= today || form.outcome !== null) continue;
    const project = db.records.find((r) => r.contentId === form.contentId);
    if (!project?.workflow || project.archived) continue;
    const stage = greenlightStageOf(form);
    if (project.workflow.stage !== (stage === 1 ? "Development" : "Pre-production")) continue;
    const notes = `The review window closed on ${form.reviewWindowDate} with no decision, so the project moved to Hold.`;
    form.decisions.push({ stage, outcome: "Hold", notes, date: today, byPersonId: SYSTEM.personId, at: nowStamp() });
    form.outcome = "Hold";
    form.reviewNotes = notes;
    form.decisionDate = today;
    form.updatedAt = nowStamp();
    logAudit(SYSTEM, "greenlight", "record", form.contentId, `Hold (automatic): ${notes}`);
    moved.push(form.contentId);
  }
  return moved;
}

/** Whether applyReviewWindows would move anything, without changing anything. */
export const reviewWindowsDue = (today: string = todayIso()): boolean =>
  getDb().developmentForms.some(
    (f) =>
      !!f.reviewWindowDate &&
      f.reviewWindowDate < today &&
      f.outcome === null &&
      !!getDb().records.find((r) => r.contentId === f.contentId && r.workflow && !r.archived),
  );
