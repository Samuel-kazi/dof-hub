import type { Actor, CategoryKey, RecordingSession, WorkflowStage } from "../types";
import { getDb } from "../data/store";
import { categoryOf } from "../config/categories";
import { WORKFLOW_STAGES } from "../config/workflow";
import { canView, getRecord } from "./access";
import { episodeOverdue, evaluateGate, type GateResult } from "./workflow/gates";
import {
  episodesOf,
  isDocumentary,
  isWorkflowProject,
  sessionsOf,
  unscheduledPlanned,
  type Episode,
  type Project,
} from "./workflow/common";
import { fmtShort } from "./utils";
import { briefKeyOf, catalogEntry } from "../config/documentCatalog";
import { newDocumentsOn } from "./documents/common";
import { documentOf } from "./documents/pages";
import { reviewsOf, reviewStateOf } from "./documents/reviews";
import type { Route } from "../ui/AppContext";

// The work of the five-stage workflow as one list, at the level each stage works at (src/config/workflow.ts):
// a project in Development and Pre-production, a recording session in Production, and an episode in Post
// production and Marketing and distribution. The board, calendar, reminders, dashboard, reports and workload all
// read it, so they agree. It is worked out on every render from what is stored, and nothing here is saved.
//
// Overdue is worked out for episodes only: once the deadline of the stage an episode is in has passed. A session,
// season, series or project is never overdue itself.

export type WorkLevel = "project" | "session" | "episode";

/** A review checkpoint still waiting for its reviewers. */
export interface PendingReview {
  checkpointId: string;
  label: string;
  reviewerIds: string[];
}

export interface WorkItem {
  key: string; // `${level}:${id}`, stable, so a list can key on it
  level: WorkLevel;
  id: string; // the project's or episode's Content ID, or the session code
  title: string;
  context: string; // the project it belongs to, or for a project its kind
  project: Project;
  category: CategoryKey;
  stage: WorkflowStage;
  step: string; // where it is inside its stage, in words
  ownerId: string | null; // who moves it on: the producer, the development owner, or the episode's editor
  reviews: PendingReview[];
  waitingOn: string[]; // everyone it is waiting on now
  due: string | null; // YYYY-MM-DD: the stage deadline, or the session's date
  start: string; // YYYY-MM-DD: when the current stage, or the session, began
  overdue: boolean;
  done: boolean; // a closed session or a published episode
  gate: GateResult | null; // what its next Done button still needs; null while it waits on reviewers or has no button
  callSheetId: string | null; // a session's call sheet, once it has one
  open: Route;
}

/** Which level of work each stage's board column shows (section 8 of the brief). */
export const BOARD_LEVEL: Record<WorkflowStage, WorkLevel> = {
  Development: "project",
  "Pre-production": "project",
  Production: "session",
  "Post production": "episode",
  "Marketing and distribution": "episode",
};

/** The one exception: a documentary whose sessions are all closed waits in Production to be sent to post production. */
export const onBoard = (i: WorkItem): boolean => i.level === BOARD_LEVEL[i.stage] || (i.level === "project" && i.stage === "Production");

/** A season carries its series' name, so "Season 1" of two series stay apart. */
export function projectName(p: Project): string {
  const parent = p.parentId ? getRecord(p.parentId) : undefined;
  return parent ? `${parent.title}: ${p.title}` : p.title;
}

const dateOf = (stamp: string): string => stamp.slice(0, 10);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

function developmentOwner(p: Project): string | null {
  const owner = getDb().developmentForms.find((f) => f.contentId === p.contentId)?.sections.entry?.ownerId;
  return typeof owner === "string" && owner ? owner : p.workflow.showProducerId;
}

function pendingReviews(ownerId: string, keys: readonly [string, string][]): PendingReview[] {
  const out: PendingReview[] = [];
  for (const [key, label] of keys) {
    const c = getDb().reviewCheckpoints.find((x) => x.id === `${ownerId}|${key}`);
    if (c && c.status === "Pending" && c.reviewerIds.length) out.push({ checkpointId: c.id, label, reviewerIds: c.reviewerIds });
  }
  return out;
}

/**
 * With the documents in use, the review a project's Development waits on is the theological review of its brief (or a
 * devotion's script): its reviewers still to decide. When they ask for changes, it waits on the owner instead.
 */
function briefReview(p: Project): { title: string; state: ReturnType<typeof reviewStateOf>; reviews: PendingReview[] } {
  const key = briefKeyOf(p.workflow.formType);
  const title = catalogEntry(p.workflow.formType, "Development", key)?.title ?? "brief";
  const doc = documentOf(p.contentId, "Development", key);
  const state = doc ? reviewStateOf(doc.id) : "no reviewers";
  const pending = doc
    ? reviewsOf(doc.id)
        .filter((r) => r.status === "pending")
        .map((r) => r.reviewerId)
    : [];
  return {
    title,
    state,
    reviews:
      doc && state === "pending" && pending.length ? [{ checkpointId: doc.id, label: "Theological review", reviewerIds: pending }] : [],
  };
}

const waiting = (ownerId: string | null, reviews: PendingReview[], ownerToo = true): string[] => [
  ...new Set([...(ownerToo && ownerId ? [ownerId] : []), ...reviews.flatMap((r) => r.reviewerIds)]),
];

function projectItem(p: Project, stage: WorkflowStage, step: string, ownerId: string | null, gate: GateResult | null): WorkItem {
  const reviews =
    stage !== "Development"
      ? []
      : newDocumentsOn(p.workflow.formType)
        ? briefReview(p).reviews
        : pendingReviews(p.contentId, [
            ["pitch", "Pitch review"],
            ["outline_script", "Outline or script review"],
          ]);
  return {
    key: `project:${p.contentId}`,
    level: "project",
    id: p.contentId,
    title: projectName(p),
    context: categoryOf(p.category).workflow?.projectLabel ?? "Project",
    project: p,
    category: p.category,
    stage,
    step,
    ownerId,
    reviews,
    waitingOn: waiting(ownerId, reviews),
    due: stage === "Development" || stage === "Pre-production" ? (p.stageDeadlines[stage] ?? null) : null,
    start: p.stageEnteredAt,
    overdue: false,
    done: false,
    gate,
    callSheetId: null,
    open: { n: "record", id: p.contentId },
  };
}

function sessionItem(p: Project, s: RecordingSession, gates: boolean): WorkItem {
  const ownerId = p.workflow.showProducerId;
  return {
    key: `session:${s.id}`,
    level: "session",
    id: s.id,
    title: `Session ${s.sessionNumber}`,
    context: projectName(p),
    project: p,
    category: p.category,
    stage: s.status === "Planned" ? "Pre-production" : "Production",
    step: s.status === "Planned" ? "Planned" : s.status === "Open" ? "Recording" : "Closed",
    ownerId,
    reviews: [],
    waitingOn: s.status === "Closed" ? [] : waiting(ownerId, []),
    due: s.scheduledDate,
    start: dateOf(s.createdAt),
    overdue: false,
    done: s.status === "Closed",
    gate: !gates || s.status === "Closed" ? null : evaluateGate(s.status === "Planned" ? "Pre-production" : "Production", "session", s.id),
    callSheetId: s.callSheetId && getDb().callSheets.some((c) => c.id === s.callSheetId) ? s.callSheetId : null,
    open: { n: "session", id: s.id },
  };
}

function episodeItem(p: Project, ep: Episode, gates: boolean): WorkItem {
  const info = ep.episode;
  const inPost = info.stage === "Post production";
  const inReview = inPost && (info.postStage === "Rough cut review" || info.postStage === "Final review");
  const reviews = inReview
    ? pendingReviews(ep.contentId, [info.postStage === "Rough cut review" ? ["rough_cut", "Rough cut review"] : ["final", "Final review"]])
    : [];
  const ownerId = inPost ? (info.editorId ?? p.workflow.showProducerId) : p.workflow.showProducerId;
  const published = info.mdStage === "Published";
  let gate: GateResult | null = null;
  if (gates && !published) {
    if (inPost && info.postStage === "Editing") gate = evaluateGate("Editing", "episode", ep.contentId);
    else if (inPost && info.postStage === "Approved") gate = evaluateGate("Post production", "episode", ep.contentId);
    else if (!inPost) gate = evaluateGate("Marketing and distribution", "episode", ep.contentId);
  }
  return {
    key: `episode:${ep.contentId}`,
    level: "episode",
    id: ep.contentId,
    title: ep.title,
    context: projectName(p),
    project: p,
    category: p.category,
    stage: info.stage,
    step: inPost ? (info.postStage === "Editing" && info.sendBackReason ? "Editing (sent back)" : info.postStage) : info.mdStage,
    ownerId,
    reviews,
    waitingOn: published ? [] : waiting(ownerId, reviews, !inReview),
    due: ep.stageDeadlines[info.stage] ?? null,
    start: ep.stageEnteredAt,
    overdue: episodeOverdue(ep),
    done: published,
    gate,
    callSheetId: null,
    open: { n: "record", id: ep.contentId },
  };
}

function itemsOf(p: Project, gates: boolean): WorkItem[] {
  if (p.workflow.stage === "Development") {
    const outcome = getDb().developmentForms.find((f) => f.contentId === p.contentId)?.outcome;
    let step = outcome === "Greenlight" ? "Greenlit: handoff" : outcome ? outcome : "Form and reviews";
    if (newDocumentsOn(p.workflow.formType) && outcome !== "Greenlight") {
      const { title, state } = briefReview(p);
      if (state === "changes_requested") step = `Changes requested on the ${title}`;
      else if (state === "pending") step = "Theological review";
      else if (!outcome) step = `${title} and its review`;
    }
    return [projectItem(p, "Development", step, developmentOwner(p), gates ? evaluateGate("Development", "project", p.contentId) : null)];
  }
  const items: WorkItem[] = [];
  const sessions = sessionsOf(p.contentId).filter((s) => !s.archivedAt);
  const episodes = episodesOf(p.contentId);
  const producer = p.workflow.showProducerId;
  if (p.workflow.status === "Active") {
    const planned = sessions
      .filter((s) => s.status === "Planned")
      .sort((a, b) => (a.scheduledDate ?? "9999").localeCompare(b.scheduledDate ?? "9999"));
    const open = sessions.some((s) => s.status === "Open");
    const projectGate = () => (gates ? evaluateGate("Pre-production", "project", p.contentId) : null);
    if (isDocumentary(p)) {
      if (!episodes.length && (sessions.length === 0 || planned.length))
        items.push(
          projectItem(p, "Pre-production", planned.length ? nextSession(planned) : "No sessions scheduled yet", producer, projectGate()),
        );
      else if (!episodes.length && !open && !planned.length && sessions.some((s) => s.status === "Closed"))
        items.push(projectItem(p, "Production", "Sessions closed: send to post production", producer, null));
    } else {
      const left = unscheduledPlanned(p.contentId);
      const label = (categoryOf(p.category).workflow?.episodeLabel ?? "Episode").toLowerCase();
      if (sessions.length === 0 || planned.length || left)
        items.push(
          projectItem(
            p,
            "Pre-production",
            planned.length
              ? nextSession(planned)
              : sessions.length === 0
                ? "No sessions scheduled yet"
                : `${plural(left, `planned ${label}`)} still to schedule`,
            producer,
            projectGate(),
          ),
        );
    }
  }
  for (const s of sessions) items.push(sessionItem(p, s, gates));
  for (const ep of episodes) items.push(episodeItem(p, ep, gates));
  return items;
}

const nextSession = (planned: RecordingSession[]): string => {
  const s = planned[0];
  const more = planned.length > 1 ? `, and ${planned.length - 1} more` : "";
  const when = s.scheduledDate ? ` on ${fmtShort(s.scheduledDate)}` : ", no date yet";
  return `Next: session ${s.sessionNumber}${when}${more}`;
};

const byDue = (a: WorkItem, b: WorkItem): number => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.key.localeCompare(b.key);

/** Every open project's work, whoever may see it. For reminders and workload, which are worked out per person. */
export function allWorkItems(gates = false): WorkItem[] {
  return getDb()
    .records.filter((r): r is Project => isWorkflowProject(r) && !r.archived)
    .flatMap((p) => itemsOf(p, gates))
    .sort(byDue);
}

/** The work this person may see. */
export function workItems(actor: Actor, gates = true): WorkItem[] {
  return getDb()
    .records.filter((r): r is Project => isWorkflowProject(r) && !r.archived && canView(actor, r))
    .flatMap((p) => itemsOf(p, gates))
    .sort(byDue);
}

export interface BoardColumn {
  stage: WorkflowStage;
  cards: WorkItem[];
}

/** The board for one category: a column per stage, each with the cards at that stage's level. Done work is left off. */
export function workflowBoard(items: WorkItem[]): BoardColumn[] {
  const open = items.filter((i) => !i.done && onBoard(i));
  return WORKFLOW_STAGES.map((st) => ({
    stage: st.name,
    cards: open.filter((i) => i.stage === st.name).sort((a, b) => Number(b.overdue) - Number(a.overdue) || byDue(a, b)),
  }));
}

/** What is waiting on this person now: the board's cards they move on, and reviews they are named on. */
export const waitingOnPerson = (items: WorkItem[], personId: string): WorkItem[] =>
  items.filter((i) => !i.done && onBoard(i) && i.waitingOn.includes(personId));
