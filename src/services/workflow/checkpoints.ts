import type { Actor, CheckpointStatus, ReviewCheckpoint } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { logAudit } from "../audit";
import { canDecide, canManageTeam, checkpoint, isHop, joinProject, nowStamp, projectForWrite, requireCrew, requireEpisode } from "./common";

// Theological review checkpoints: the pitch and the outline or script on the project, the rough cut and the final
// on each episode. Reviewers are chosen from the crew list. Sending something back always needs a reason.

const requireCheckpoint = (id: string): ReviewCheckpoint => {
  const c = getDb().reviewCheckpoints.find((x) => x.id === id);
  if (!c) throw new RuleError("Review checkpoint not found.");
  return c;
};

export function setCheckpointReviewers(actor: Actor, checkpointId: string, reviewerIds: string[]): ReviewCheckpoint {
  const c = requireCheckpoint(checkpointId);
  const p = projectForWrite(actor, c.contentId);
  if (!canManageTeam(actor, p) && !canDecide(actor))
    throw new RuleError("Only the show producer or the Head of Production can choose who reviews.");
  const ids = [...new Set(reviewerIds)];
  if (ids.length > 10) throw new RuleError("Choose up to 10 reviewers.");
  // A reviewer joins the project, so they can read it and decide.
  for (const id of ids) {
    requireCrew(id, "A reviewer");
    joinProject(actor, id, p);
  }
  c.reviewerIds = ids;
  c.updatedAt = nowStamp();
  logAudit(actor, "checkpoint-reviewers", "record", c.episodeId ?? c.contentId, `${c.checkpoint}: ${ids.join(", ") || "none"}`);
  commit();
  return c;
}

export interface CheckpointDecision {
  status: Exclude<CheckpointStatus, "Pending">;
  note: string;
}

/**
 * A reviewer's decision. Approving the rough cut sends the episode on to Final review; approving the final
 * approves the episode. Requesting changes needs a reason and sends the episode back to Editing.
 */
export function decideCheckpoint(actor: Actor, checkpointId: string, decision: CheckpointDecision): ReviewCheckpoint {
  const c = requireCheckpoint(checkpointId);
  projectForWrite(actor, c.contentId);
  if (!isHop(actor) && !c.reviewerIds.includes(actor.personId))
    throw new RuleError("Only a reviewer named on this checkpoint, or the Head of Production, can decide it.");
  const note = decision.note.trim();
  if (decision.status === "Changes requested" && !note) throw new RuleError("Write what needs to change. The reason goes back with it.");
  if (c.episodeId) {
    const ep = requireEpisode(c.episodeId);
    const info = ep.episode;
    const waitingFor = c.checkpoint === "rough_cut" ? "Rough cut review" : "Final review";
    if (info.stage !== "Post production" || info.postStage !== waitingFor)
      throw new RuleError(`This episode is not waiting for its ${waitingFor.toLowerCase()}.`);
    if (decision.status === "Approved") {
      if (c.checkpoint === "rough_cut") {
        info.roughCutStatus = "Done";
        info.postStage = "Final review";
        const final = checkpoint(ep.contentId, "final");
        if (final && final.status !== "Pending")
          Object.assign(final, { status: "Pending", decidedAt: null, decidedById: null, updatedAt: nowStamp() });
      } else {
        info.finalReviewStatus = "Done";
        info.postStage = "Approved";
      }
    } else {
      info.postStage = "Editing";
      info.readyForReview = false;
      info.sendBackReason = note;
      if (c.checkpoint === "rough_cut") info.roughCutStatus = "Pending";
      else info.finalReviewStatus = "Pending";
    }
    ep.version += 1;
  }
  c.status = decision.status;
  c.note = note;
  c.decidedAt = nowStamp();
  c.decidedById = actor.personId;
  c.updatedAt = c.decidedAt;
  logAudit(actor, "checkpoint", "record", c.episodeId ?? c.contentId, `${c.checkpoint}: ${decision.status}${note ? `. ${note}` : ""}`);
  commit();
  return c;
}
