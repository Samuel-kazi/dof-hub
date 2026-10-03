import type { Actor, ContentRecord, DistributionEntry, DistributionStatus, EpisodeInfo } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { codeNumber, localId } from "../../data/ids";
import { blankRecord } from "../content";
import { logAudit } from "../audit";
import { addDaysIso, isIsoDate, todayIso } from "../utils";
import { requireWebUrl } from "../urls";
import { EPISODE_TOKEN } from "../../config/workflow";
import { checkpoint, ensureChecklist, episodeForWrite, openRequired, requireCrew, type Episode, type Project } from "./common";
import { blankCheckpoint } from "./projects";
import { evaluateGate, gateError } from "./gates";
import { nextEpisode } from "./ids";
import { refreshProjectStatus } from "./status";

// Episodes: made when a recording session closes (or, for a documentary, when it is sent to post production),
// then each moves through Post production and Marketing and distribution on its own.

/** Default days from an episode being made to the end of each of its stages. Each can be changed. */
const POST_DAYS = 14;
const MARKETING_DAYS = 28;

export interface NewEpisode {
  title: string;
  plannedEpisodeId: string | null;
  sourceSessionId: string | null;
  productionNotes: string;
  scheduledDate: string | null;
}

/**
 * Makes one episode under a project, with the next episode code, its two review checkpoints and its post checklist.
 * Given `kept`, an episode made before the workflow that was waiting to be recorded, it becomes that record instead,
 * so its Content ID, documents and notes stay as they were. The caller saves.
 */
export function makeEpisode(actor: Actor, project: Project, input: NewEpisode, kept?: ContentRecord | string): Episode {
  let id: string;
  let n: number;
  let r: ContentRecord;
  if (typeof kept === "string") {
    // A Content ID given out ahead of recording (a devotion's, in Pre-production): the episode is made under it.
    id = kept;
    n = codeNumber(id, project.contentId, EPISODE_TOKEN);
    if (Number.isNaN(n) || getDb().records.some((x) => x.contentId === id))
      throw new RuleError(`${id} cannot become an episode of ${project.contentId}.`);
    r = blankRecord(id, project.category, input.title, project.contentId, project.hierarchyLevel + 1);
  } else if (kept) {
    id = kept.contentId;
    n = codeNumber(id, project.contentId, EPISODE_TOKEN);
    if (kept.parentId !== project.contentId || (kept.episode && !kept.archived) || Number.isNaN(n))
      throw new RuleError(`${id} cannot become an episode of ${project.contentId}.`);
    r = kept;
    r.archived = false;
    r.closedReason = null;
    r.version += 1;
  } else {
    ({ id, n } = nextEpisode(project.contentId));
    r = blankRecord(id, project.category, input.title, project.contentId, project.hierarchyLevel + 1);
  }
  const info: EpisodeInfo = {
    episodeNumber: n,
    plannedEpisodeId: input.plannedEpisodeId,
    sourceSessionId: input.sourceSessionId,
    productionNotes: input.productionNotes,
    stage: "Post production",
    postStage: "Not started",
    roughCutStatus: "Pending",
    finalReviewStatus: "Pending",
    editorId: getDb().projectRoles.find((x) => x.id === `${project.contentId}|editor`)?.crewId ?? null,
    readyForReview: false,
    reviewLink: "",
    finalFileLink: "",
    sendBackReason: null,
    mdStage: "Release plan",
    distribution: [],
    learningNotes: "",
  };
  r.episode = info;
  r.scheduledDate = input.scheduledDate;
  // A kept record's earlier stage deadlines stay alongside, unread by the workflow, as the rest of its old fields do.
  r.stageDeadlines = {
    ...(kept && typeof kept !== "string" ? r.stageDeadlines : {}),
    "Post production": addDaysIso(todayIso(), POST_DAYS),
    "Marketing and distribution": addDaysIso(todayIso(), MARKETING_DAYS),
  };
  r.stageEnteredAt = todayIso();
  r.assigneePersonId = info.editorId;
  const db = getDb();
  if (!kept || typeof kept === "string") db.records.push(r);
  // The episode's reviewers start as whoever reviewed the project's outline.
  const reviewers = checkpoint(project.contentId, "outline_script")?.reviewerIds ?? [];
  for (const key of ["rough_cut", "final"] as const) {
    // A kept episode recorded a second time starts its reviews again.
    const earlier = checkpoint(id, key);
    if (earlier)
      Object.assign(earlier, { status: "Pending", note: "", decidedAt: null, decidedById: null, updatedAt: new Date().toISOString() });
    else db.reviewCheckpoints.push(blankCheckpoint(project.contentId, id, key, reviewers));
  }
  ensureChecklist("post", "episode", id);
  logAudit(
    actor,
    kept ? "recorded" : "create",
    "record",
    id,
    `Episode ${n}: ${kept ? `${r.title} (kept its Content ID from before the workflow)` : input.title}`,
  );
  return r as Episode;
}

// ── Post production ──────────────────────────────────────────

export function setEpisodeEditor(actor: Actor, episodeId: string, personId: string | null): Episode {
  const { ep } = episodeForWrite(actor, episodeId);
  if (personId) requireCrew(personId, "The editor");
  ep.episode.editorId = personId;
  ep.assigneePersonId = personId;
  ep.version += 1;
  logAudit(actor, "editor", "record", episodeId, personId ?? "none");
  commit();
  return ep;
}

/** The review link (for example an unlisted upload) and the final file's hosted link. Web links only. */
export function setEpisodeLinks(actor: Actor, episodeId: string, links: { reviewLink?: string; finalFileLink?: string }): Episode {
  const { ep } = episodeForWrite(actor, episodeId);
  const info = ep.episode;
  if (links.reviewLink !== undefined) {
    const url = requireWebUrl(links.reviewLink, "The review link", true);
    if (!url && (info.postStage === "Rough cut review" || info.postStage === "Final review"))
      throw new RuleError("The episode is in review, so it needs its review link.");
    info.reviewLink = url;
  }
  if (links.finalFileLink !== undefined) info.finalFileLink = requireWebUrl(links.finalFileLink, "The final file link", true);
  ep.version += 1;
  logAudit(actor, "episode-links", "record", episodeId, Object.keys(links).join(", "));
  commit();
  return ep;
}

export function startEditing(actor: Actor, episodeId: string): Episode {
  const { ep } = episodeForWrite(actor, episodeId);
  if (ep.episode.stage !== "Post production" || ep.episode.postStage !== "Not started") throw new RuleError("Editing has already started.");
  ep.episode.postStage = "Editing";
  ep.stageEnteredAt = todayIso();
  ep.version += 1;
  logAudit(actor, "post-stage", "record", episodeId, "Not started → Editing");
  commit();
  return ep;
}

/** The editor marks the cut ready (or not) for review. */
export function setReadyForReview(actor: Actor, episodeId: string, ready: boolean): Episode {
  const { ep } = episodeForWrite(actor, episodeId);
  if (ep.episode.postStage !== "Editing") throw new RuleError("Only a cut in Editing can be marked ready for review.");
  ep.episode.readyForReview = ready;
  ep.version += 1;
  logAudit(actor, "post-ready", "record", episodeId, ready ? "Ready for review" : "Not ready for review");
  commit();
  return ep;
}

/**
 * Sends a cut that is ready, with its review link, for review: to Rough cut review, or straight to Final review
 * when the rough cut was already approved and the final sent it back.
 */
export function sendForReview(actor: Actor, episodeId: string): Episode {
  const { ep } = episodeForWrite(actor, episodeId);
  const gate = evaluateGate("Editing", "episode", episodeId);
  if (!gate.passed) throw gateError("Editing", gate.missing);
  const roughApproved = checkpoint(episodeId, "rough_cut")?.status === "Approved";
  const next = roughApproved ? "final" : "rough_cut";
  ep.episode.postStage = roughApproved ? "Final review" : "Rough cut review";
  const c = checkpoint(episodeId, next);
  if (c && c.status !== "Pending")
    Object.assign(c, { status: "Pending", decidedAt: null, decidedById: null, updatedAt: new Date().toISOString() });
  ep.version += 1;
  logAudit(actor, "post-stage", "record", episodeId, `Editing → ${ep.episode.postStage}`);
  commit();
  return ep;
}

/** Leaves Post production once the rough cut and the final are approved. */
export function moveToMarketing(actor: Actor, episodeId: string): Episode {
  const { ep } = episodeForWrite(actor, episodeId);
  const gate = evaluateGate("Post production", "episode", episodeId);
  if (!gate.passed) throw gateError("Post production", gate.missing);
  ep.episode.postStage = "Approved";
  ep.episode.stage = "Marketing and distribution";
  ep.episode.mdStage = "Release plan";
  ep.stageEnteredAt = todayIso();
  ep.version += 1;
  ensureChecklist("release", "episode", episodeId);
  logAudit(actor, "stage-advance", "record", episodeId, "Post production → Marketing and distribution");
  commit();
  return ep;
}

// ── Marketing and distribution ───────────────────────────────

/** The release plan is approved once its checklist is done, and the episode is scheduled. */
export function approveReleasePlan(actor: Actor, episodeId: string): Episode {
  const { ep } = episodeForWrite(actor, episodeId);
  if (ep.episode.stage !== "Marketing and distribution" || ep.episode.mdStage !== "Release plan")
    throw new RuleError("This episode is not at its release plan.");
  const open = openRequired("release", episodeId);
  if (open.length)
    throw gateError(
      "Marketing and distribution",
      open.map((l) => `Release plan: ${l}`),
    );
  ep.episode.mdStage = "Scheduled";
  ep.version += 1;
  logAudit(actor, "md-stage", "record", episodeId, "Release plan → Scheduled");
  commit();
  return ep;
}

/** Published once the release plan is done and at least one distribution link is logged. Then the project may be complete. */
export function publishEpisode(actor: Actor, episodeId: string): Episode {
  const { ep, project } = episodeForWrite(actor, episodeId);
  const gate = evaluateGate("Marketing and distribution", "episode", episodeId);
  if (!gate.passed) throw gateError("Marketing and distribution", gate.missing);
  ep.episode.mdStage = "Published";
  ep.version += 1;
  refreshProjectStatus(project);
  logAudit(actor, "md-stage", "record", episodeId, "Published");
  commit();
  return ep;
}

export interface DistributionInput {
  platform: string;
  status: DistributionStatus;
  link?: string;
  date?: string | null;
}

function checkDistribution(input: DistributionInput): Omit<DistributionEntry, "id"> {
  const platform = input.platform.trim();
  if (!platform) throw new RuleError("Name the platform, for example YouTube.");
  if (platform.length > 100) throw new RuleError("Keep the platform's name short.");
  const link = requireWebUrl(input.link ?? "", "The link", true);
  if (input.status === "Published" && !link) throw new RuleError("A published entry needs its link.");
  const date = input.date || null;
  if (date !== null && !isIsoDate(date)) throw new RuleError("Pick the date.");
  return { platform, status: input.status, link, date };
}

export function addDistribution(actor: Actor, episodeId: string, input: DistributionInput): DistributionEntry {
  const { ep } = episodeForWrite(actor, episodeId);
  if (ep.episode.stage !== "Marketing and distribution")
    throw new RuleError("Distribution is logged once the episode reaches Marketing and distribution.");
  const entry: DistributionEntry = {
    id: localId("D", (x) => ep.episode.distribution.some((d) => d.id === x)),
    ...checkDistribution(input),
  };
  ep.episode.distribution.push(entry);
  ep.version += 1;
  logAudit(actor, "distribution-add", "record", episodeId, `${entry.platform}: ${entry.status}`);
  commit();
  return entry;
}

export function updateDistribution(actor: Actor, episodeId: string, entryId: string, input: DistributionInput): DistributionEntry {
  const { ep } = episodeForWrite(actor, episodeId);
  const entry = ep.episode.distribution.find((d) => d.id === entryId);
  if (!entry) throw new RuleError("That distribution entry no longer exists.");
  Object.assign(entry, checkDistribution(input));
  ep.version += 1;
  logAudit(actor, "distribution-update", "record", episodeId, `${entry.platform}: ${entry.status}`);
  commit();
  return entry;
}

export function removeDistribution(actor: Actor, episodeId: string, entryId: string): void {
  const { ep } = episodeForWrite(actor, episodeId);
  if (ep.episode.mdStage === "Published" && ep.episode.distribution.filter((d) => d.link).length <= 1)
    throw new RuleError("A published episode keeps at least one distribution link.");
  ep.episode.distribution = ep.episode.distribution.filter((d) => d.id !== entryId);
  ep.version += 1;
  logAudit(actor, "distribution-remove", "record", episodeId, entryId);
  commit();
}

/** What was learned, written against the brief's success measures. */
export function setLearningNotes(actor: Actor, episodeId: string, notes: string): Episode {
  const { ep } = episodeForWrite(actor, episodeId);
  if (notes.length > 20_000) throw new RuleError("Keep the learning notes under 20,000 characters.");
  ep.episode.learningNotes = notes.trim();
  ep.version += 1;
  logAudit(actor, "learning-notes", "record", episodeId);
  commit();
  return ep;
}
