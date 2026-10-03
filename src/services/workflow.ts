// The five-stage workflow for series, devotions and documentaries (src/config/workflow.ts). The services are split
// by concern under ./workflow/; this file is the one place that decides what the rest of the app, and the server's
// list of actions (server/schemas.ts), can use. Anything not exported here stays internal.

export {
  createWorkflowProject,
  assignProducer,
  closeProject,
  setWorkflowDeadline,
  advanceProject,
  projectLabelOf,
} from "./workflow/projects";
export type { NewWorkflowProject } from "./workflow/projects";

export {
  saveFormSection,
  setCriterion,
  setReviewWindow,
  decideGreenlight,
  formProblems,
  requiredSections,
  greenlightBlockers,
  greenlightStageOf,
  latestDecision,
  applyReviewWindows,
  reviewWindowsDue,
  SYSTEM,
} from "./workflow/forms";
export type { DecisionInput } from "./workflow/forms";

export { addPlannedEpisode, updatePlannedEpisode, archivePlannedEpisode, plannedOf } from "./workflow/planned";
export type { PlannedInput } from "./workflow/planned";

export { assignRole, removeRole, setChecklistItem } from "./workflow/team";
export type { RoleInput } from "./workflow/team";

export { setCheckpointReviewers, decideCheckpoint } from "./workflow/checkpoints";
export type { CheckpointDecision } from "./workflow/checkpoints";

export {
  createSession,
  updateSession,
  archiveSession,
  resetRunSheet,
  addRunSheetItem,
  updateRunSheetItem,
  removeRunSheetItem,
  createSessionCallSheet,
  addLogRow,
  updateLogRow,
  removeLogRow,
  openSession,
  closeSession,
  reopenSession,
  sendToPostProduction,
  availableForLog,
  runSheetTemplate,
  RUN_SHEET_NOTE,
} from "./workflow/sessions";
export type { SessionInput, RunSheetItemInput, LogRowInput, CloseResult } from "./workflow/sessions";

export {
  setEpisodeEditor,
  setEpisodeLinks,
  startEditing,
  setReadyForReview,
  sendForReview,
  moveToMarketing,
  approveReleasePlan,
  publishEpisode,
  addDistribution,
  updateDistribution,
  removeDistribution,
  setLearningNotes,
} from "./workflow/episodes";
export type { DistributionInput } from "./workflow/episodes";

export { evaluateGate, episodeOverdue, projectSummary } from "./workflow/gates";
export type { GateLevel, GateStage, GateResult, ProjectSummary } from "./workflow/gates";

export {
  recordShareLink,
  copyShareLink,
  revokeShareLink,
  resolveShareToken,
  shareTarget,
  canShare,
  SHARE_TOKEN,
  NO_HOSTED_FILE,
} from "./workflow/share";

export {
  isWorkflowProject,
  isWorkflowEpisode,
  checklistItems,
  episodesOf,
  sessionsOf,
  rowsOf,
  checkpointsOf,
  getSession,
} from "./workflow/common";
export type { Project, Episode } from "./workflow/common";
