import type { Actor, PlannedEpisode } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { plannedSectionOf } from "../../config/devForms";
import { logAudit } from "../audit";
import { pickKeys } from "../utils";
import { formOf, nowStamp, projectForWrite } from "./common";
import { explain, plannedDetailsSchema } from "./forms";
import { nextPlanned } from "./ids";
import { refreshProjectStatus } from "./status";

// The planned episode list, written at Development (in the form's Story or Outline section). A real episode is
// made from a planned one only when a session that recorded it closes. Planned episodes are archived with a
// reason, never deleted, and their numbers are never reused.

export interface PlannedInput {
  workingTitle: string;
  question?: string;
  guest?: string;
  notes?: string;
  details?: Record<string, string>;
}

export const PLANNED_EDITABLE = ["workingTitle", "question", "guest", "notes", "details"] as const;

function checkDetails(projectId: string, details: Record<string, string> | undefined): Record<string, string> {
  if (!details) return {};
  const form = formOf(projectId);
  const parsed = plannedDetailsSchema(form.formType).safeParse(details);
  if (!parsed.success)
    throw new RuleError(
      explain(parsed.error, (k) => plannedSectionOf(form.formType)?.planned?.details.find((d) => d.key === k)?.label ?? k),
    );
  return Object.fromEntries(
    Object.entries(parsed.data as Record<string, string | undefined>).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

export const plannedOf = (projectId: string, includeArchived = false): PlannedEpisode[] =>
  getDb()
    .plannedEpisodes.filter((p) => p.contentId === projectId && (includeArchived || !p.archivedAt))
    .sort((a, b) => a.episodeNumber - b.episodeNumber);

export function addPlannedEpisode(actor: Actor, projectId: string, input: PlannedInput): PlannedEpisode {
  const project = projectForWrite(actor, projectId);
  const section = plannedSectionOf(project.workflow.formType);
  if (!section?.planned) throw new RuleError("This kind of project has no planned episodes.");
  const max = section.planned.max;
  if (max !== undefined && plannedOf(projectId).length >= max) throw new RuleError(`${section.planned.label} has ${max} already.`);
  const details = checkDetails(projectId, input.details);
  const { id, n } = nextPlanned(projectId);
  const at = nowStamp();
  const p: PlannedEpisode = {
    id,
    contentId: projectId,
    episodeNumber: n,
    workingTitle: input.workingTitle.trim(),
    question: (input.question ?? "").trim(),
    guest: (input.guest ?? "").trim(),
    notes: (input.notes ?? "").trim(),
    details,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    archivedReason: null,
    reservedId: null,
    sourcePageId: null,
  };
  getDb().plannedEpisodes.push(p);
  refreshProjectStatus(project);
  logAudit(actor, "planned-add", "record", projectId, `${id}: ${p.workingTitle}`);
  commit();
  return p;
}

export function updatePlannedEpisode(actor: Actor, id: string, input: Partial<PlannedInput>): PlannedEpisode {
  const p = getDb().plannedEpisodes.find((x) => x.id === id);
  if (!p) throw new RuleError("Planned episode not found.");
  projectForWrite(actor, p.contentId);
  if (p.archivedAt) throw new RuleError("This planned episode is archived.");
  const patch = pickKeys(input, PLANNED_EDITABLE);
  if (patch.details !== undefined) p.details = { ...p.details, ...checkDetails(p.contentId, patch.details) };
  for (const k of ["workingTitle", "question", "guest", "notes"] as const) if (patch[k] !== undefined) p[k] = patch[k]!.trim();
  p.updatedAt = nowStamp();
  logAudit(actor, "planned-update", "record", p.contentId, `${id}: ${Object.keys(patch).join(", ")}`);
  commit();
  return p;
}

/** Takes an episode off the plan, with a reason. Refused once it has been recorded or is planned into a session. */
export function archivePlannedEpisode(actor: Actor, id: string, reason: string): PlannedEpisode {
  const p = getDb().plannedEpisodes.find((x) => x.id === id);
  if (!p) throw new RuleError("Planned episode not found.");
  const project = projectForWrite(actor, p.contentId);
  if (p.archivedAt) throw new RuleError("This planned episode is already archived.");
  if (!reason.trim()) throw new RuleError("Write why this episode is coming off the plan.");
  const db = getDb();
  if (db.records.some((r) => r.episode?.plannedEpisodeId === id && !r.archived))
    throw new RuleError("This episode has been recorded, so it stays.");
  const row = db.sessionLogEntries.find(
    (e) => e.plannedEpisodeId === id && db.recordingSessions.some((s) => s.id === e.sessionId && !s.archivedAt && s.status !== "Closed"),
  );
  if (row) throw new RuleError(`It is planned into session ${row.sessionId}. Take it off that session's log first.`);
  p.archivedAt = nowStamp();
  p.archivedReason = reason.trim();
  p.updatedAt = p.archivedAt;
  refreshProjectStatus(project);
  logAudit(actor, "planned-archive", "record", p.contentId, `${id}: ${reason.trim()}`);
  commit();
  return p;
}
