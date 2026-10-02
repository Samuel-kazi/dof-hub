import type { Actor, ContentRecord, DevelopmentForm, FormType, ReviewCheckpoint, SeriesType } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { categoryOf } from "../../config/categories";
import { CRITERIA, FORM_TYPES, formTypeOf, formTypeForSeries, isWorkflowCategory } from "../../config/workflow";
import { blankRecord, nextChildId, nextTopLevelId } from "../content";
import { canWrite, getRecord } from "../access";
import { requireCan } from "../permissions";
import { logAudit } from "../audit";
import { isIsoDate } from "../utils";
import {
  canDecide,
  canNameProducer,
  ensureChecklist,
  formOf,
  isProducer,
  joinProject,
  nowStamp,
  projectForWrite,
  episodeForWrite,
  requireCrew,
  requireProject,
  type Project,
} from "./common";
import { evaluateGate, gateError } from "./gates";

// Projects of the five-stage workflow: a season of a series, a devotion, or a documentary. A project gets its
// Content ID when its pitch is first entered, keeps it for good, and starts in Development with its form, its
// two project-level review checkpoints (pitch, and outline or script) and its handoff checklist.

export interface NewWorkflowProject {
  category: "series" | "devotional" | "documentary";
  title: string; // a new series, devotion or documentary; for a new season, the season's title (optional)
  seriesType?: SeriesType | null; // a new series: podcast, testimonial or sermon
  seriesId?: string | null; // a new season of an existing series
  formType?: FormType | null; // a documentary: documentary_dof or documentary_pitched
  deadline?: string | null; // the publish date
}

function blankForm(projectId: string, formType: FormType): DevelopmentForm {
  const at = nowStamp();
  return {
    id: projectId,
    contentId: projectId,
    formType,
    sections: {},
    greenlightStage: formTypeOf(formType).greenlights === 2 ? 1 : null,
    criteria: Object.fromEntries(CRITERIA.map((c) => [c.key, { met: null, note: "" }])) as DevelopmentForm["criteria"],
    outcome: null,
    reviewNotes: "",
    decisionDate: null,
    reviewWindowDate: null,
    decisions: [],
    createdAt: at,
    updatedAt: at,
  };
}

function blankCheckpoint(
  contentId: string,
  episodeId: string | null,
  key: ReviewCheckpoint["checkpoint"],
  reviewerIds: string[] = [],
): ReviewCheckpoint {
  const at = nowStamp();
  return {
    id: `${episodeId ?? contentId}|${key}`,
    contentId,
    episodeId,
    checkpoint: key,
    reviewerIds,
    status: "Pending",
    note: "",
    decidedAt: null,
    decidedById: null,
    createdAt: at,
    updatedAt: at,
  };
}
export { blankCheckpoint };

function startProject(actor: Actor, r: ContentRecord, formType: FormType, deadline: string | null | undefined): Project {
  if (deadline && !isIsoDate(deadline)) throw new RuleError("Pick the publish date.");
  r.deadline = deadline || null;
  r.workflow = {
    formType,
    status: "Development",
    stage: "Development",
    showProducerId: null,
    producerAssignedById: null,
    producerAssignedAt: null,
    sermonFormat: null,
    migrated: false,
  };
  const db = getDb();
  db.records.push(r);
  db.developmentForms.push(blankForm(r.contentId, formType));
  db.reviewCheckpoints.push(blankCheckpoint(r.contentId, null, "pitch"), blankCheckpoint(r.contentId, null, "outline_script"));
  ensureChecklist("handoff", "project", r.contentId);
  logAudit(actor, "create", "record", r.contentId, `${formTypeOf(formType).label}: ${r.title}`);
  return r as Project;
}

/**
 * Starts a project in Development. A new series is made with its first season, which is the project; a series
 * that already exists gets a new season. Devotions and documentaries are projects themselves.
 */
export function createWorkflowProject(actor: Actor, input: NewWorkflowProject): Project {
  if (!isWorkflowCategory(input.category)) throw new RuleError("Choose a series, a devotion or a documentary.");
  const name = input.title.trim();
  if (input.category === "series") {
    let series: ContentRecord;
    if (input.seriesId) {
      const found = getRecord(input.seriesId);
      if (!found || found.category !== "series" || found.hierarchyLevel !== 0 || found.archived) throw new RuleError("Series not found.");
      if (!found.seriesType) throw new RuleError("This series was made before the new workflow. Its seasons are added the earlier way.");
      if (!canWrite(actor, found)) throw new RuleError("You are not assigned to this series.");
      series = found;
    } else {
      requireCan(actor, "pipeline.manage", "create a new series");
      if (!name) throw new RuleError("Give the series a title.");
      if (!input.seriesType) throw new RuleError("Choose the kind of series: podcast, testimonial or sermon.");
      series = blankRecord(nextTopLevelId("series"), "series", name, null, 0);
      series.seriesType = input.seriesType;
      getDb().records.push(series);
      logAudit(actor, "create", "record", series.contentId, `Series: ${series.title}`);
    }
    const id = nextChildId(series);
    const season = blankRecord(
      id,
      "series",
      (input.seriesId ? name : "") || `Season ${id.slice(id.lastIndexOf("-S") + 2)}`,
      series.contentId,
      1,
    );
    const project = startProject(actor, season, formTypeForSeries(series.seriesType!), input.deadline);
    commit();
    return project;
  }
  requireCan(actor, "pipeline.manage", "create a new project");
  if (!name) throw new RuleError("Give the project a title.");
  const formType: FormType = input.category === "devotional" ? "devotion" : (input.formType ?? ("" as FormType));
  const def = FORM_TYPES.find((f) => f.key === formType);
  if (!def || def.category !== input.category)
    throw new RuleError("Choose whether DOF is making the documentary or it was pitched by others.");
  const project = startProject(actor, blankRecord(nextTopLevelId(input.category), input.category, name, null, 0), formType, input.deadline);
  commit();
  return project;
}

/** Names the show producer, who coordinates the project and assigns its other roles. Done by Operations at Development. */
export function assignProducer(actor: Actor, projectId: string, personId: string | null): Project {
  if (!canNameProducer(actor))
    throw new RuleError('Only the Head of Production, or someone given "Assign other people\'s work", can name the show producer.');
  const p = requireProject(projectId);
  if (p.archived) throw new RuleError("This project is closed.");
  if (personId) {
    requireCrew(personId, "The show producer");
    joinProject(actor, personId, p);
  }
  p.workflow.showProducerId = personId;
  p.workflow.producerAssignedById = personId ? actor.personId : null;
  p.workflow.producerAssignedAt = personId ? nowStamp() : null;
  p.assigneePersonId = personId;
  p.version += 1;
  logAudit(actor, "producer", "record", projectId, personId ?? "none");
  commit();
  return p;
}

/**
 * Closes a project that is withdrawn, or whose guest did not comply. It is archived, never deleted: its Content
 * ID, form, sessions and episodes are kept as they were, with the reason.
 */
export function closeProject(actor: Actor, projectId: string, reason: string): Project {
  const p = requireProject(projectId);
  if (!canDecide(actor) && !isProducer(actor, p))
    throw new RuleError('Only the show producer, the Head of Production, or someone given "Create projects", can close a project.');
  if (p.archived) throw new RuleError("This project is already closed.");
  if (!reason.trim()) throw new RuleError("Write why the project is being closed. It is kept with the project.");
  p.workflow.status = "Closed";
  p.closedReason = reason.trim();
  p.archived = true;
  p.version += 1;
  logAudit(actor, "close", "record", projectId, reason.trim());
  commit();
  return p;
}

const PROJECT_STAGES = ["Development", "Pre-production"];
const EPISODE_STAGES = ["Post production", "Marketing and distribution"];

/** A stage's deadline: Development and Pre-production on a project, Post production and Marketing on an episode. */
export function setWorkflowDeadline(actor: Actor, id: string, stage: string, date: string | null): ContentRecord {
  const target: ContentRecord = getRecord(id)?.episode ? episodeForWrite(actor, id).ep : projectForWrite(actor, id);
  const allowed = target.episode ? EPISODE_STAGES : PROJECT_STAGES;
  if (!allowed.includes(stage))
    throw new RuleError(
      `${target.episode ? "An episode" : "A project"} has deadlines for ${allowed.join(" and ")} only. A session's deadline is its date.`,
    );
  if (date !== null && date !== "" && !isIsoDate(date)) throw new RuleError("Pick the deadline's date.");
  if (date) target.stageDeadlines[stage] = date;
  else delete target.stageDeadlines[stage];
  target.version += 1;
  logAudit(actor, "stage-deadline", "record", id, `${stage} → ${date || "none"}`);
  commit();
  return target;
}

/**
 * Leaves Development for Pre-production, if the gate passes: greenlit, form complete, pitch and outline approved,
 * handoff done. A DOF-made documentary then waits for its second greenlight before anything is recorded.
 */
export function advanceProject(actor: Actor, projectId: string): Project {
  const p = projectForWrite(actor, projectId);
  if (p.workflow.stage !== "Development") throw new RuleError("This project has already left Development.");
  const gate = evaluateGate("Development", "project", projectId);
  if (!gate.passed) throw gateError("Development", gate.missing);
  p.workflow.stage = "Pre-production";
  p.workflow.status = "Active";
  p.version += 1;
  const form = formOf(projectId);
  if (form.greenlightStage === 1) {
    form.greenlightStage = 2;
    form.outcome = null;
    form.reviewWindowDate = null;
    form.updatedAt = nowStamp();
  }
  ensureChecklist("preProject", "project", projectId);
  logAudit(actor, "stage-advance", "record", projectId, "Development → Pre-production");
  commit();
  return p;
}

export const projectLabelOf = (p: Project): string => categoryOf(p.category).workflow?.projectLabel ?? "Project";
