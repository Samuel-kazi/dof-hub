import type { Actor, ContentRecord, DevelopmentForm, FormType, ReviewCheckpoint, SeriesType } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { categoryOf } from "../../config/categories";
import { CRITERIA, FORM_TYPES, formTypeOf, formTypeForSeries, isMusicForm, isWorkflowCategory } from "../../config/workflow";
import { checkEventSetup, setUpEventDays, type EventSetup } from "../production";
import { nextPlanned } from "./ids";
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

// Projects of the five-stage workflow: a season of a series, a devotion, a documentary, a live event or a music release. A project gets its
// Content ID when its pitch is first entered, keeps it for good, and starts in Development with its form, its
// two project-level review checkpoints (pitch, and outline or script) and its handoff checklist.

export interface NewWorkflowProject {
  category: "series" | "devotional" | "documentary" | "music" | "live";
  // A new series, music project, live show, devotion or documentary. For a new season, release or event of an existing
  // one, its own title (a season's is optional).
  title: string;
  seriesType?: SeriesType | null; // a new series: podcast, testimonial or sermon
  seriesId?: string | null; // a new season, release or event of an existing series, music project or live show
  formType?: FormType | null; // a documentary: documentary_dof or documentary_pitched; a music release: music_single or music_album
  projectTitle?: string | null; // a new music project's first release, or a new live show's first event, if named apart
  deadline?: string | null; // the publish date
  event?: EventSetup | null; // a live event: how its days are made (one day, several, or a recurring show)
}

/** What a series, music project or live show is called in messages. */
const CONTAINER: Record<"series" | "music" | "live", { one: string; child: string }> = {
  series: { one: "series", child: "Season" },
  music: { one: "music project", child: "Release" },
  live: { one: "live show", child: "Event" },
};

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
  ensureChecklist("handoff", "project", r.contentId);
  logAudit(actor, "create", "record", r.contentId, `${formTypeOf(formType).label}: ${r.title}`);
  return r as Project;
}

/**
 * Starts a project in Development. A new series is made with its first season, which is the project; a series
 * that already exists gets a new season. A music project holds its releases (a single or an album) and a live show its
 * events in the same way. Devotions and documentaries are projects themselves.
 */
export function createWorkflowProject(actor: Actor, input: NewWorkflowProject): Project {
  if (!isWorkflowCategory(input.category))
    throw new RuleError("Choose a series, a devotion, a documentary, a live event or a music release.");
  const name = input.title.trim();
  if (input.category === "series" || input.category === "music" || input.category === "live") {
    const cat = input.category;
    const words = CONTAINER[cat];
    // Everything is checked before anything is made.
    const formType: FormType = cat === "series" ? "podcast" : cat === "live" ? "live_event" : (input.formType ?? ("" as FormType));
    if (cat === "music" && !isMusicForm(formType)) throw new RuleError("Choose a single or an album.");
    if (cat === "live") {
      if (!input.event) throw new RuleError("Choose how the event runs: one day, several days, or a recurring show.");
      checkEventSetup(input.event);
    }
    let parent: ContentRecord;
    if (input.seriesId) {
      const found = getRecord(input.seriesId);
      if (!found || found.category !== cat || found.hierarchyLevel !== 0 || found.archived)
        throw new RuleError(`${words.one.charAt(0).toUpperCase()}${words.one.slice(1)} not found.`);
      if (cat === "series" && !found.seriesType)
        throw new RuleError("This series was made before the new workflow. Its seasons are added the earlier way.");
      if (!canWrite(actor, found)) throw new RuleError(`You are not assigned to this ${words.one}.`);
      if (cat !== "series" && !name) throw new RuleError(`Give the ${words.child.toLowerCase()} a title.`);
      parent = found;
    } else {
      requireCan(actor, "pipeline.manage", `create a new ${words.one}`);
      if (!name) throw new RuleError(`Give the ${words.one} a title.`);
      if (cat === "series" && !input.seriesType) throw new RuleError("Choose the kind of series: podcast, testimonial or sermon.");
      parent = blankRecord(nextTopLevelId(cat), cat, name, null, 0);
      if (cat === "series") parent.seriesType = input.seriesType!;
      getDb().records.push(parent);
      logAudit(actor, "create", "record", parent.contentId, `${words.one.charAt(0).toUpperCase()}${words.one.slice(1)}: ${parent.title}`);
    }
    const id = nextChildId(parent);
    const number = id.slice(id.lastIndexOf("-") + 2); // after the one letter: S2, A2, E2
    const title =
      cat === "series"
        ? (input.seriesId ? name : "") || `Season ${number}`
        : (input.seriesId ? name : input.projectTitle?.trim() || name) || `${words.child} ${number}`;
    const child = blankRecord(id, cat, title, parent.contentId, 1);
    const project = startProject(actor, child, cat === "series" ? formTypeForSeries(parent.seriesType!) : formType, input.deadline);
    // A single is one song: it is listed already, under the release's title.
    if (formType === "music_single") {
      const { id: plannedId, n } = nextPlanned(project.contentId);
      const at = nowStamp();
      getDb().plannedEpisodes.push({
        id: plannedId,
        contentId: project.contentId,
        episodeNumber: n,
        workingTitle: project.title,
        question: "",
        guest: "",
        notes: "",
        details: {},
        reservedId: null,
        sourcePageId: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        archivedReason: null,
      });
    }
    if (cat === "live") setUpEventDays(actor, project, input.event!);
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
