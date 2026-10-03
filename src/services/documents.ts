// Project documents, their reviews, and Pre-production's storyboards and shot lists (the documents rework). The
// services are split by concern under ./documents/; this file decides what the rest of the app, and the server's list
// of actions (server/schemas.ts), can use.

export {
  ensureDocument,
  syncReviewThread,
  addPage,
  savePage,
  movePage,
  archivePage,
  restorePage,
  addDocumentLink,
  removeDocumentLink,
  documentOf,
  linksOf,
  MAX_PAGE_HTML,
} from "./documents/pages";
export type { PageInput, PageEdit } from "./documents/pages";

export {
  setDocumentReviewers,
  decideDocumentReview,
  askForReviewAgain,
  addReviewComment,
  resolveReviewComment,
  reviewsOf,
  reviewStateOf,
  commentsOf,
} from "./documents/reviews";
export type { ReviewDecision } from "./documents/reviews";

export {
  createStoryboard,
  renameStoryboard,
  addFrame,
  updateFrame,
  moveFrame,
  duplicateFrame,
  deleteFrames,
  moveFramesTo,
  storyboardsOf,
  framesOf,
  createShotList,
  renameShotList,
  addShotRow,
  updateShotRow,
  moveShotRow,
  duplicateShotRow,
  deleteShotRows,
  shotListsOf,
  rowsOfShotList,
  shotNumbers,
  estimatedMinutes,
} from "./documents/boards";
export type { NewBoard, FrameEdit, RowEdit } from "./documents/boards";

export { makeDevotionEpisodes, acceptDevotion } from "./documents/devotions";

export { hardGates, hardGatesPass, setGateOverride, devotionPageReady, DEVOTION_PAGES_NEEDED } from "./documents/gates";
export type { HardGate, HardGateKey } from "./documents/gates";
export { softNudges } from "./documents/nudges";
export type { DevotionList } from "./documents/devotions";

export { pagesOf, getDocument, newDocumentsOn, documentHasContent } from "./documents/common";
