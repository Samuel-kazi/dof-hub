// ─────────────────────────────────────────────────────────────
// Core data model for the Dawn of Faith Production Hub.
// Written to map 1:1 onto relational tables so the mock store
// can later be swapped for SQLite/Postgres/MongoDB without
// touching screens.
// ─────────────────────────────────────────────────────────────

export type RoleCode = "HOP" | "CRW" | "VOL" | "PTR";
export type CategoryKey = "series" | "devotional" | "live" | "documentary" | "music" | "general";

export interface Person {
  personId: string; // DOF-P-CRW-004  (permanent, never regenerated)
  category: RoleCode; // editable (promotion) but the ID number never changes
  name: string;
  email: string;
  phone: string;
  skills: string[];
  equipmentFamiliarity: string[];
  hasLogin: boolean;
  status: "active" | "inactive";
  createdAt: string;
  username?: string; // what they sign in with. Set by the server when a login is made.
  loginOff?: boolean; // the Head of Production switched their login off
  notifyEmail?: boolean; // also wants reminders by email, on top of the ones in the app
  notifySms?: boolean; // and by text message
  photoUrl?: string | null; // profile photo, a data: URL. Falls back to colour-initials when not set.
  fontSize?: FontSize; // per-user: Small/Default/Large/XL
  density?: Density; // per-user: Comfortable/Compact
  contactHidden?: boolean; // only in what one person is shown: their email, phone and equipment are private to them, so those fields are left empty
}

export type FontSize = "small" | "default" | "large" | "xl";
export type Density = "comfortable" | "compact";
export type AccentKey = "terracotta" | "amber" | "sage" | "ocean" | "plum" | "slate";
export type FontPairingKey = "modern" | "editorial" | "classic";

export interface User {
  userId: string;
  personId: string; // login points at identity, not the other way round
  email: string;
  // MOCK ONLY. Replaced by a bcrypt hash once a real backend exists.
  password: string;
  role: RoleCode; // stored explicitly so it can be overridden later
  active: boolean;
}

export interface ProjectMember {
  personId: string;
  projectContentId: string; // membership on an ancestor covers all descendants
  roleOnProject: string;
  canComment: boolean;
}

/** Someone who owns a stage, and what they do on it. A stage can have several owners. */
export interface StageOwner {
  personId: string;
  roles: string[];
}

/** A checklist item inside one stage, such as "Picture lock" in Editorial. */
export interface StageTask {
  id: string;
  stage: string;
  label: string;
  done: boolean;
  dueDate: string | null;
  assigneePersonId: string | null;
  doneAt: string | null;
  doneBy: string | null;
}

/** A link posted at a stage: a review cut, the final published link, an analysis note, or a reference. */
export interface StageLink {
  id: string;
  stage: string;
  kind: "review" | "final" | "analysis" | "reference";
  url: string;
  note: string;
  byPersonId: string;
  at: string;
}

export type ProductionLevel = "small" | "medium" | "large";

/** A host or guest who appears in a show. Free text, so outside guests need no account. */
export interface Featured {
  id: string;
  kind: "host" | "guest";
  name: string;
  note: string; // title, organisation or topic
}

export interface ContentRecord {
  contentId: string; // DOF-SER-001 / DOF-SER-001-S1 / DOF-SER-001-S1-E01
  title: string;
  category: CategoryKey;
  parentId: string | null;
  hierarchyLevel: number; // 0 top, then down to the level that carries the pipeline
  pipelineStage: string | null; // only populated on the level that does production work
  stageOutputs: Record<string, boolean>; // stage-gate: required output present?
  stageDeadlines: Record<string, string>; // ISO date per stage
  stageEnteredAt: string; // ISO date the item arrived at its current pipelineStage; for staleness, not deadlines
  scheduledDate: string | null; // the shoot date (for a live day, the show date)
  startDate: string;
  deadline: string | null; // the publish date
  assigneePersonId: string | null; // who is responsible right now (the owner of the current stage)
  stageAssignees: Record<string, StageOwner[]>; // stage name (or "Project" for the whole project) to its owners, each with roles
  tasks: StageTask[];
  links: StageLink[];
  productionLevel: ProductionLevel | null; // live days: decides whether the call sheet needs a run of show
  featured: Featured[]; // hosts and guests
  showStart: string | null; // series and live shows: the first day of the show
  showEnd: string | null; // and the last
  spunOffFrom: string | null; // for a Music track or Series episode created from a live recording: the live day it came from
  postProductionNeeded: boolean | null; // live days only: was anything recorded that needs post-production? Set before Post Production can be confirmed done.
  strikePattern: "daily" | "continuous" | null; // live shows only (level 0): struck down every day, or built once and struck only on the last day
  strikeChecklist: { daily: string[]; final: string[] } | null; // live shows only (level 0): what comes down every night vs what stays rigged until the last day
  // Devotionals only: a flat project never splits into episodes, so its own pipeline's extra fields
  // live directly here rather than on a child record. Null/blank for every other category.
  guestName: string;
  guestContact: string;
  reviewerName: string | null; // theological reviewer, named, not just a role
  reviewApprovedAt: string | null; // ISO timestamp the reviewer approved the Guest stage
  closedReason: string | null; // set only when Closed: why the guest was non-compliant
  cardStorage: string; // Prep/Scripting: which card or storage slot this was recorded to
  publishDate: string | null; // Prep/Scripting: the target date, separate from the project's own deadline
  recordingDurationMin: number | null;
  recordingNotes: string;
  readyForReview: boolean; // Editing: set before it can move to Review
  editorNotes: string;
  sendBackReason: string | null; // most recent reason Review sent it back to Editing
  archived: boolean;
  version: number; // optimistic concurrency
  createdAt: string;
  notes: string;
  // ── The five-stage workflow: series, devotions and documentaries (src/config/workflow.ts) ──
  // All three are null on Live Shows, Music and General Use, and on records made before the workflow
  // existed, which keep their earlier pipeline until they are moved across.
  seriesType: SeriesType | null; // on a series itself (level 0): podcast, testimonial or sermon
  workflow: ProjectWorkflow | null; // on a project: a season of a series, a devotion, a documentary
  episode: EpisodeInfo | null; // on an episode, made when a recording session closes
}

// ── The five-stage workflow ──────────────────────────────────
// Development and Pre-production happen on the project, Production on each recording session, and
// Post production and Marketing and distribution on each episode. See src/config/workflow.ts.

export type SeriesType = "podcast" | "testimonial" | "sermon";
export type FormType = "podcast" | "testimonial" | "sermon" | "documentary_dof" | "documentary_pitched" | "devotion";
export type WorkflowStage = "Development" | "Pre-production" | "Production" | "Post production" | "Marketing and distribution";
export type ProjectStatus = "Development" | "Active" | "Completed" | "Closed" | "Advice only"; // Hold is a greenlight outcome, on the development form
export type GreenlightOutcome = "Greenlight" | "Revise and resubmit" | "Hold" | "Decline" | "Advice only";
export type CriterionKey = "missionFit" | "messageSoundness" | "audienceNeed" | "feasibility" | "resourceCost" | "teamStrength";
export type SermonFormat = "in_person" | "recorded";

/** Workflow fields on a project record. The project's own stage is Development or Pre-production; later stages live on sessions and episodes. */
export interface ProjectWorkflow {
  formType: FormType;
  status: ProjectStatus;
  stage: "Development" | "Pre-production";
  showProducerId: string | null; // assigned at Development by someone who may assign other people's work
  producerAssignedById: string | null;
  producerAssignedAt: string | null; // timestamp
  sermonFormat: SermonFormat | null; // sermon series only
  migrated: boolean; // moved across from the earlier pipeline: gates it passed there count as met
}

export type PostStage = "Not started" | "Editing" | "Rough cut review" | "Final review" | "Approved";
export type MdStage = "Release plan" | "Scheduled" | "Published";
export type DistributionStatus = "Planned" | "Scheduled" | "Published";

/** One platform an episode goes out on. */
export interface DistributionEntry {
  id: string;
  platform: string; // YouTube, Facebook, a podcast host
  status: DistributionStatus;
  link: string; // http or https only
  date: string | null; // YYYY-MM-DD, Africa/Nairobi
}

/** Workflow fields on an episode record. Its Content ID is the episode code, {projectId}-E{nn}. */
export interface EpisodeInfo {
  episodeNumber: number;
  plannedEpisodeId: string | null;
  sourceSessionId: string | null; // null for episodes that existed before session logging
  productionNotes: string; // copied from the session log row
  stage: "Post production" | "Marketing and distribution";
  postStage: PostStage;
  roughCutStatus: "Pending" | "Done";
  finalReviewStatus: "Pending" | "Done";
  editorId: string | null;
  readyForReview: boolean; // the editor marks it ready before Rough cut review
  reviewLink: string; // http or https only
  finalFileLink: string; // http or https only
  sendBackReason: string | null; // why the latest review sent it back to Editing
  mdStage: MdStage;
  distribution: DistributionEntry[];
  learningNotes: string; // against the brief's success measures
}

/** Every greenlight decision, kept in order, including a project moved to Hold when its review window passed. */
export interface GreenlightDecision {
  stage: 1 | 2;
  outcome: GreenlightOutcome;
  notes: string;
  date: string; // YYYY-MM-DD
  byPersonId: string; // "system" for the automatic move to Hold
  at: string; // timestamp
}

/** One development form per project. Its sections are checked against the form type's schema when saved. */
export interface DevelopmentForm {
  id: string; // the project's Content ID: one form per project
  contentId: string;
  formType: FormType;
  sections: Record<string, Record<string, unknown>>;
  greenlightStage: 1 | 2 | null; // a DOF-made documentary has two greenlights; every other form has one (null)
  criteria: Record<CriterionKey, { met: boolean | null; note: string }>;
  outcome: GreenlightOutcome | null; // the latest decision at the current greenlight stage
  reviewNotes: string;
  decisionDate: string | null; // YYYY-MM-DD
  reviewWindowDate: string | null; // YYYY-MM-DD: no decision by then moves the project to Hold
  decisions: GreenlightDecision[];
  createdAt: string;
  updatedAt: string;
}

/** An episode as planned at Development. A real episode is made from it when a session that recorded it closes. */
export interface PlannedEpisode {
  id: string; // {projectId}-P{nn}
  contentId: string; // the project
  episodeNumber: number;
  workingTitle: string;
  question: string;
  guest: string;
  notes: string;
  details: Record<string, string>; // per form type, for example a devotion day's scripture, key thought and application
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedReason: string | null;
}

export type RoleKey = "director" | "dop" | "audio_engineer" | "camera_operator" | "continuity" | "editor" | "host_guest";

/** A person's role on one project. The show producer is held on the project itself (ProjectWorkflow). */
export interface ProjectRole {
  id: string; // {projectId}|{roleKey}; hosts and guests add a random part, as a project has several
  contentId: string;
  roleKey: RoleKey;
  exclusive: boolean; // one person per role, for every role but hosts and guests
  crewId: string | null; // someone on the crew list
  guestName: string; // hosts and guests only: someone who is not on the crew list
  assignedById: string;
  assignedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ChecklistOwner = "project" | "session" | "episode";

/** One item of a workflow checklist, with a note. */
export interface WorkflowChecklistItem {
  id: string; // {ownerId}|{stage}|{itemKey}
  ownerType: ChecklistOwner;
  ownerId: string;
  stage: WorkflowStage;
  itemKey: string;
  label: string;
  required: boolean;
  done: boolean;
  note: string;
  doneAt: string | null;
  doneById: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = "Planned" | "Open" | "Closed";

/** One recording session. Pre-production while Planned, Production while Open; closing it makes the episodes. */
export interface RecordingSession {
  id: string; // the session code, {projectId}-R{nn}
  contentId: string;
  sessionNumber: number;
  scheduledDate: string | null; // YYYY-MM-DD, Africa/Nairobi
  venue: string;
  status: SessionStatus;
  closedAt: string | null;
  callSheetId: string | null;
  runSheet: RunItem[];
  dailyLog: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedReason: string | null;
}

export type LogStatus = "Recorded" | "Pickup needed" | "Not recorded";

/** One row of a session's recording log. Pickups, timestamps and problems go in the notes. */
export interface SessionLogEntry {
  id: string; // {sessionId}|{plannedEpisodeId}, or {sessionId}|I-{random} for a documentary's free-form item
  sessionId: string;
  plannedEpisodeId: string | null;
  itemLabel: string; // documentary: an interview set, a scene, a location
  logDate: string; // YYYY-MM-DD, the session's date unless changed
  guest: string;
  status: LogStatus | null; // every row needs one before the session can close
  notesForPost: string;
  createdAt: string;
  updatedAt: string;
}

export type CheckpointKey = "pitch" | "outline_script" | "rough_cut" | "final";
export type CheckpointStatus = "Pending" | "Approved" | "Changes requested";

/** A theological review checkpoint: pitch and outline on the project, rough cut and final on each episode. */
export interface ReviewCheckpoint {
  id: string; // {projectId or episodeId}|{checkpoint}
  contentId: string; // the project
  episodeId: string | null;
  checkpoint: CheckpointKey;
  reviewerIds: string[];
  status: CheckpointStatus;
  note: string; // required when changes are requested
  decidedAt: string | null;
  decidedById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A link to one episode's hosted file. On the hosted site it is /share/{token}; in the desktop app it is the file's own link. */
export interface ShareLink {
  id: string;
  episodeId: string;
  token: string | null; // 128 random bits, made by the server only. Null when the desktop app copied the file's link instead.
  targetUrl: string;
  createdById: string;
  createdAt: string;
  revokedAt: string | null;
  sharedWithNote: string;
}

/** One line of a live show's run of show. */
export interface RunItem {
  id: string;
  time: string; // HH:MM
  title: string;
  durationMin: number;
  ownerPersonId: string | null;
  notes: string;
}

export interface CallSheet {
  id: string; // DOF-CS-001
  contentId: string; // top-level project the sheet belongs to
  title: string;
  date: string;
  location: string;
  callTime: string;
  linkedEpisodeIds: string[]; // fixed at creation, never live-recalculated
  crewPersonIds: string[];
  equipmentIds: string[]; // populated by the Equipment module (phase 2)
  runOfShow: RunItem[]; // used when the project's production level is large
  format: string;
  notes: string;
  status: "draft" | "final";
  version: number;
  createdAt: string;
}

export interface Comment {
  id: string;
  contentId: string;
  callSheetId: string | null;
  byPersonId: string;
  text: string;
  at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  byPersonId: string;
  action: string;
  entity: string;
  entityId: string;
  detail: string;
}

// ── Equipment ────────────────────────────────────────────────

export type EquipCategoryKey =
  "camera" | "audio" | "lighting" | "live" | "studio" | "computing" | "cabling" | "power" | "transport" | "ministry" | "safety";
export type EquipCondition = "New" | "Good" | "Fair" | "Poor";
export type TrackingType = "serialized" | "aggregate";
export type BaseStatus = "active" | "in-repair" | "retired" | "lost";

/** A photo, receipt or link. `url` is either a link or a small data: image. */
export interface Attachment {
  id: string;
  url: string;
  caption: string;
  at: string; // timestamp, set when it is added
  byPersonId: string;
}

/**
 * One row per physical unit (serialized) or per purchase batch (aggregate).
 * `id` is the permanent asset code or batch code.
 */
export interface EquipmentItem {
  id: string; // DOF-EQ-CAM-001  or  DOF-EQ-CAB-XLR10M-B01
  trackingType: TrackingType;
  name: string;
  make: string;
  model: string;
  category: EquipCategoryKey;
  itemFamily: string | null; // aggregate only: groups batches, e.g. XLR-10M
  serialNumber: string | null; // serialized only
  unitLabel: string | null; // serialized only: an optional name for this one unit, e.g. "A-cam", to tell identical units apart
  quantityTotal: number; // serialized is always 1
  quantityDamaged: number; // cumulative units removed as damaged (aggregate)
  quantityLost: number; // cumulative units removed as lost (aggregate)
  unitCost: number;
  purchaseDate: string | null;
  vendor: string;
  condition: EquipCondition; // serialized: this one unit's condition. aggregate: the worst condition present, kept in sync from conditionBreakdown
  conditionBreakdown: Partial<Record<EquipCondition, number>> | null; // aggregate only: how many of the active (not damaged/lost) units are in each condition, counts sum to quantityTotal. null for serialized items
  packaging: string;
  accessories: string;
  info: string;
  photos: Attachment[]; // reference photos of current physical state
  receipts: Attachment[]; // proof of purchase
  baseStatus: BaseStatus; // in-repair / retired / lost. Everything else is derived from manifests.
  createdAt: string;
}

export type ManifestStatus = "assigned" | "checked-out" | "returned" | "released";

export interface ManifestLine {
  equipmentId: string; // a batch draw is simply a line against that batch
  quantity: number;
  conditionOut: EquipCondition;
  photosOut: Attachment[];
  conditionIn: EquipCondition | null;
  photosIn: Attachment[];
  returnedGood: number;
  damaged: number;
  lost: number;
}

/** The generated checkout list, always tied to a Content ID. */
export interface Manifest {
  id: string; // DOF-MF-001
  contentId: string;
  callSheetId: string | null;
  destination: "studio" | "outside";
  status: ManifestStatus;
  date: string; // start (shoot date)
  expectedReturn: string | null;
  responsiblePersonId: string;
  lines: ManifestLine[];
  notes: string;
  createdAt: string;
  createdBy: string;
  checkedOutAt: string | null;
  returnedAt: string | null;
}

export interface Incident {
  id: string; // DOF-INC-001
  equipmentId: string;
  at: string;
  type: "damage" | "loss";
  quantity: number;
  description: string;
  personId: string; // who had it
  contentId: string;
  manifestId: string;
}

export interface EquipmentHistory {
  id: string;
  equipmentId: string;
  at: string;
  kind:
    | "created"
    | "assigned"
    | "released"
    | "checked-out"
    | "checked-in"
    | "incident"
    | "repair-start"
    | "repair-end"
    | "retired"
    | "lost"
    | "edited"
    | "photo";
  detail: string;
  byPersonId: string;
  contentId: string | null;
  manifestId: string | null;
}

// ── Storage ──────────────────────────────────────────────────

export interface Drive {
  id: string; // DRV-001
  name: string;
  capacityGB: number;
  otherUsedGB: number; // space used by things not tied to a project
  notes: string;
}

export interface DriveAllocation {
  id: string;
  driveId: string;
  contentId: string | null; // null: recorded ahead of a real project (legacy or ongoing work started before this system), identified by its own id and label instead
  label: string; // required and shown when contentId is null; otherwise an optional short note on top of the project title
  sizeGB: number;
  kind: "raw" | "project" | "delivered" | "other";
  note: string;
  updatedAt: string;
}

export interface StorageSnapshot {
  date: string;
  usedGB: number;
  capacityGB: number;
}

// ── Documents ────────────────────────────────────────────────

export interface DocRecord {
  id: string; // DOF-DCS-001
  contentId: string;
  title: string;
  body: string; // simple markdown: headings, bullets, checkboxes, bold
  templateKey: string | null;
  stage: string | null; // the stage that attached it
  version: number; // optimistic concurrency, like records
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  archived: boolean;
}

/** Every saved state of a document, so changes are always recoverable. */
export interface DocRevision {
  id: string;
  docId: string;
  version: number;
  at: string;
  byPersonId: string;
  title: string;
  body: string;
  note: string;
  trimmed?: boolean; // signed in to the server: an older revision sent without its text, which is fetched when the history is opened
}

export interface Settings {
  stageReminderHours: number;
  storageWarningThreshold: number;
  checkoutReturnDays: number;
  workDays: number[]; // days of the week people are normally at work, 0 is Sunday
  effortOverrides: Record<string, number>; // person-days per stage, keyed "category:Stage", replacing the built-in estimates
  permissions?: {
    roles: Partial<Record<RoleCode, Partial<Record<string, boolean>>>>;
    people: Record<string, Partial<Record<string, boolean>>>;
  }; // what the Head of Production has granted or denied
  // Workspace-wide look and feel, set by the Head of Production. Per-user preferences (font size,
  // density, photo) live on the Person record instead, since each person sets their own.
  appearance?: { accent: AccentKey; fontPairing: FontPairingKey };
}

/** A reminder that was sent, or opened in the mail or messages app, so it is not sent twice by accident. */
export interface OutboxEntry {
  id: string;
  personId: string; // who it was for
  channel: "email" | "text" | "calendar";
  subject: string;
  body: string;
  keys: string[]; // the reminders it covered
  at: string;
  byPersonId: string;
}

export interface Database {
  schemaVersion: number;
  people: Person[];
  users: User[];
  members: ProjectMember[];
  records: ContentRecord[];
  callSheets: CallSheet[];
  comments: Comment[];
  audit: AuditEntry[];
  equipment: EquipmentItem[];
  manifests: Manifest[];
  incidents: Incident[];
  equipmentHistory: EquipmentHistory[];
  drives: Drive[];
  allocations: DriveAllocation[];
  snapshots: StorageSnapshot[];
  docs: DocRecord[];
  docRevisions: DocRevision[];
  outbox: OutboxEntry[];
  // The five-stage workflow (see the interfaces above)
  developmentForms: DevelopmentForm[];
  plannedEpisodes: PlannedEpisode[];
  projectRoles: ProjectRole[];
  workflowChecklistItems: WorkflowChecklistItem[];
  recordingSessions: RecordingSession[];
  sessionLogEntries: SessionLogEntry[];
  reviewCheckpoints: ReviewCheckpoint[];
  shareLinks: ShareLink[];
  settings: Settings;
  counters: Record<string, number>; // ID sequences, keyed by prefix
}

export interface Actor {
  personId: string;
  role: RoleCode;
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}
export class ConflictError extends RuleError {
  constructor(message = "Someone else changed this record while you were editing. Reload it and try again.") {
    super(message);
    this.name = "ConflictError";
  }
}
