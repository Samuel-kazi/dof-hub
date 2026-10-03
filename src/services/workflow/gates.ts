import type { ContentRecord, RecordingSession, WorkflowStage } from "../../types";
import { RuleError } from "../../types";
import { getDb } from "../../data/store";
import { REQUIRED_ROLES, roleLabel } from "../../config/workflow";
import { getRecord } from "../access";
import { gearIssues, manifestForSheet } from "../equipment";
import { asWebUrl } from "../urls";
import { todayIso } from "../utils";
import {
  checkpoint,
  episodesOf,
  formOf,
  getSession,
  isDocumentary,
  openRequired,
  rowsOf,
  sessionsOf,
  unscheduledPlanned,
  type Episode,
  type Project,
} from "./common";
import { formProblems, latestDecision } from "./forms";
import { newDocumentsOn } from "../documents/common";
import { hardGatesMissing } from "../documents/gates";
import { softNudges } from "../documents/nudges";

// One function decides whether anything may move on: evaluateGate. Every Done button calls it and moves only if
// it passes; the screens show its `missing` list. Dates in the wrong order are warnings, never blockers.
//
//   stage                         level      id
//   Development                   project    leaving Development for Pre-production
//   Pre-production                project    the project's own part of every session's gate
//   Pre-production                session    a session moving into Production
//   Production                    session    a session closing, which makes its episodes
//   Editing                       episode    an episode going for review (a step inside Post production)
//   Post production               episode    an episode moving to Marketing and distribution
//   Marketing and distribution    episode    an episode being published

export type GateLevel = "project" | "session" | "episode";
export type GateStage = WorkflowStage | "Editing";

export interface GateResult {
  passed: boolean;
  missing: string[];
  warnings: string[];
}

const result = (missing: string[], warnings: string[] = []): GateResult => ({ passed: missing.length === 0, missing, warnings });

/** The error a Done button gives when its gate has not passed: everything missing, in one sentence. */
export const gateError = (stage: GateStage, missing: string[]): RuleError =>
  new RuleError(`Not ready to leave ${stage}. Still needed: ${missing.join("; ")}.`);

const projectOf = (id: string): Project | null => {
  const r = getRecord(id);
  return r?.workflow ? (r as Project) : null;
};

/** Stage dates after the project's publish date. A warning only. */
function lateDates(project: ContentRecord, dates: [string, string | null | undefined][]): string[] {
  const publish = project.deadline;
  if (!publish) return [];
  return dates.filter(([, d]) => !!d && d > publish).map(([what, d]) => `${what} (${d}) is after the publish date (${publish})`);
}

function developmentGate(p: Project): GateResult {
  const late = lateDates(p, [["The Development deadline", p.stageDeadlines.Development]]);
  // A project whose documents are in use: the short list of hard gates, and everything else as nudges.
  if (newDocumentsOn(p.workflow.formType)) {
    const missing = p.workflow.stage === "Development" ? hardGatesMissing(p.contentId) : ["The project has already left Development"];
    return result(missing, [...softNudges(p.contentId), ...late]);
  }
  const missing: string[] = [];
  if (p.workflow.stage !== "Development") missing.push("The project has already left Development");
  const form = formOf(p.contentId);
  if (latestDecision(form, 1)?.outcome !== "Greenlight")
    missing.push(form.greenlightStage ? "First greenlight decision: Greenlight" : "Greenlight decision: Greenlight");
  missing.push(...formProblems(p.contentId, 1));
  for (const [key, label] of [
    ["pitch", "Pitch"],
    ["outline_script", "Outline or script"],
  ] as const)
    if (checkpoint(p.contentId, key)?.status !== "Approved") missing.push(`${label} review checkpoint Approved`);
  missing.push(...openRequired("handoff", p.contentId).map((l) => `Handoff: ${l}`));
  if (!p.workflow.showProducerId) missing.push("Handoff: Show producer named");
  return result(missing, late);
}

/** The project's own part of every session's Pre-production gate. */
function preProductionProjectGate(p: Project): GateResult {
  const missing: string[] = [];
  if (p.workflow.stage !== "Pre-production") missing.push("The project must have left Development");
  if (!p.workflow.showProducerId) missing.push("A show producer");
  const roles = getDb().projectRoles.filter((r) => r.contentId === p.contentId);
  for (const key of REQUIRED_ROLES) if (!roles.some((r) => r.roleKey === key)) missing.push(`Role: ${roleLabel(key)}`);
  missing.push(...openRequired("preProject", p.contentId).map((l) => `Pre-production: ${l}`));
  if (p.workflow.formType === "documentary_dof" && latestDecision(formOf(p.contentId), 2)?.outcome !== "Greenlight")
    missing.push("Second greenlight decision: Greenlight (shoot budget, interview sets and shot list)");
  return result(missing, lateDates(p, [["The Pre-production deadline", p.stageDeadlines["Pre-production"]]]));
}

function preProductionSessionGate(s: RecordingSession, p: Project): GateResult {
  const project = preProductionProjectGate(p);
  const missing = [...project.missing];
  const warnings = [...project.warnings, ...lateDates(p, [[`Session ${s.id}`, s.scheduledDate]])];
  if (s.status !== "Planned") missing.push("The session must be in Pre-production (Planned)");
  if (!s.scheduledDate) missing.push("The session's date");
  const sheet = s.callSheetId ? getDb().callSheets.find((c) => c.id === s.callSheetId) : undefined;
  if (!sheet) missing.push("A call sheet for this session");
  else {
    const gear = manifestForSheet(sheet.id);
    if (!gear || gear.lines.length === 0) missing.push("Gear selected from the Equipment picker");
    missing.push(...gearIssues(sheet.id).map((g) => `Gear: ${g}`));
    if (sheet.status !== "final") missing.push(`Call sheet ${sheet.id} issued (final)`);
    if (s.scheduledDate && sheet.date !== s.scheduledDate)
      missing.push(`Call sheet ${sheet.id} is for ${sheet.date}, not the session's date, ${s.scheduledDate}`);
  }
  missing.push(...openRequired("preSession", s.id).map((l) => `Session: ${l}`));
  if (p.workflow.formType !== "documentary_dof" && p.workflow.formType !== "documentary_pitched" && rowsOf(s.id).length === 0)
    warnings.push("No episodes are planned for this session yet");
  return result(missing, warnings);
}

function productionGate(s: RecordingSession): GateResult {
  const missing: string[] = [];
  if (s.status !== "Open") missing.push("The session must be in Production (Open)");
  missing.push(...openRequired("wrap", s.id).map((l) => `Wrap: ${l}`));
  const rows = rowsOf(s.id);
  if (rows.length === 0) missing.push("At least one row in the session log");
  for (const r of rows) if (!r.status) missing.push(`A status for log row "${r.itemLabel || r.plannedEpisodeId}"`);
  return result(missing);
}

function editingGate(ep: Episode): GateResult {
  const missing: string[] = [];
  if (ep.episode.stage !== "Post production" || ep.episode.postStage !== "Editing") missing.push("The episode must be in Editing");
  if (!ep.episode.readyForReview) missing.push("The editor marks it ready for review");
  if (!asWebUrl(ep.episode.reviewLink)) missing.push("A review link (http or https)");
  return result(missing);
}

function postGate(ep: Episode, p: Project): GateResult {
  const missing: string[] = [];
  if (ep.episode.stage !== "Post production") missing.push("The episode must be in Post production");
  for (const [key, label] of [
    ["rough_cut", "Rough cut"],
    ["final", "Final"],
  ] as const)
    if (checkpoint(ep.contentId, key)?.status !== "Approved") missing.push(`${label} review checkpoint Approved`);
  return result(missing, lateDates(p, [["The Post production deadline", ep.stageDeadlines["Post production"]]]));
}

function marketingGate(ep: Episode, p: Project): GateResult {
  const missing: string[] = [];
  if (ep.episode.stage !== "Marketing and distribution") missing.push("The episode must be in Marketing and distribution");
  if (ep.episode.mdStage === "Published") missing.push("The episode is already published");
  missing.push(...openRequired("release", ep.contentId).map((l) => `Release plan: ${l}`));
  if (!ep.episode.distribution.some((d) => asWebUrl(d.link))) missing.push("At least one distribution link logged");
  return result(missing, lateDates(p, [["The Marketing and distribution deadline", ep.stageDeadlines["Marketing and distribution"]]]));
}

export function evaluateGate(stage: GateStage, level: GateLevel, id: string): GateResult {
  if (level === "project") {
    const p = projectOf(id);
    if (!p) return result(["Project not found"]);
    if (p.archived) return result(["The project is closed"]);
    if (stage === "Development") return developmentGate(p);
    if (stage === "Pre-production") return preProductionProjectGate(p);
  }
  if (level === "session") {
    const s = getSession(id);
    const p = s ? projectOf(s.contentId) : null;
    if (!s || !p) return result(["Session not found"]);
    if (p.archived || s.archivedAt) return result(["The session is closed"]);
    if (stage === "Pre-production") return preProductionSessionGate(s, p);
    if (stage === "Production") return productionGate(s);
  }
  if (level === "episode") {
    const r = getRecord(id);
    const p = r?.episode ? projectOf(r.parentId ?? "") : null;
    if (!r?.episode || !p) return result(["Episode not found"]);
    if (r.archived || p.archived) return result(["The episode is archived"]);
    const ep = r as Episode;
    if (stage === "Editing") return editingGate(ep);
    if (stage === "Post production") return postGate(ep, p);
    if (stage === "Marketing and distribution") return marketingGate(ep, p);
  }
  return result([`${stage} has no gate at the ${level} level`]);
}

// ── Overdue (episodes only: never a session, season, series or project) ──

/** An episode is overdue once the deadline of the stage it is in has passed, until it is published. */
export function episodeOverdue(ep: ContentRecord, today: string = todayIso()): boolean {
  if (!ep.episode || ep.archived || ep.episode.mdStage === "Published") return false;
  const due = ep.stageDeadlines[ep.episode.stage];
  return !!due && due < today;
}

// ── Where a project stands ───────────────────────────────────

export interface ProjectSummary {
  stage: string; // for the show header: the earliest stage that still has work in it
  text: string; // "Production: 2 of 6 sessions closed. Post: 4 episodes."
}

/** A project's stage is worked out from its sessions and episodes, never stored past Pre-production. */
export function projectSummary(p: Project): ProjectSummary {
  if (p.archived) {
    const label = p.workflow.status === "Advice only" ? "Advice only" : "Closed";
    return { stage: label, text: `${label}${p.closedReason ? `: ${p.closedReason}` : ""}` };
  }
  if (p.workflow.stage === "Development") {
    const outcome = formOf(p.contentId).outcome;
    return { stage: "Development", text: outcome && outcome !== "Greenlight" ? `Development: ${outcome}.` : "Development." };
  }
  const sessions = sessionsOf(p.contentId).filter((s) => !s.archivedAt);
  const eps = episodesOf(p.contentId);
  const inPost = eps.filter((e) => e.episode.stage === "Post production").length;
  const inMd = eps.filter((e) => e.episode.stage === "Marketing and distribution" && e.episode.mdStage !== "Published").length;
  const published = eps.filter((e) => e.episode.mdStage === "Published").length;
  const closed = sessions.filter((s) => s.status === "Closed").length;
  const parts: string[] = [];
  if (sessions.length) parts.push(`Production: ${closed} of ${sessions.length} session${sessions.length === 1 ? "" : "s"} closed.`);
  if (inPost) parts.push(`Post: ${inPost} episode${inPost === 1 ? "" : "s"}.`);
  if (inMd) parts.push(`Marketing and distribution: ${inMd} episode${inMd === 1 ? "" : "s"}.`);
  if (published) parts.push(`Published: ${published}.`);
  // Planned episodes with no session yet are Pre-production's work. A project moved across from the earlier pipeline
  // may have episodes and no sessions; a documentary whose sessions are all closed waits to be sent to post production.
  const doc = isDocumentary(p);
  const toPlan = sessions.some((s) => s.status === "Planned") || (!doc && unscheduledPlanned(p.contentId) > 0);
  const stage =
    p.workflow.status === "Completed"
      ? "Completed"
      : sessions.some((s) => s.status === "Open")
        ? "Production"
        : toPlan || (sessions.length === 0 && eps.length === 0)
          ? "Pre-production"
          : doc && eps.length === 0
            ? "Production"
            : inPost
              ? "Post production"
              : inMd
                ? "Marketing and distribution"
                : "Pre-production";
  return { stage, text: parts.length ? parts.join(" ") : "Pre-production: no sessions yet." };
}
