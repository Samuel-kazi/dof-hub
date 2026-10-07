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
  quietHours?: { from: string; to: string } | null; // HH:MM, Nairobi time: no emails in between (data version 21)
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
  // ── Productions (data version 19): how a live show's days are made, and where each came from ──
  production?: ProductionInfo | null; // on a live show (level 0): recurring, one-time or multi-day
  instance?: InstanceInfo | null; // on a day of a recurring show: the template it follows, unless edited
}

// ── Productions: one system, three ways of making its days ───
// A recurring show makes a day (an instance) for each date of its schedule from its Show Template; a one-time event
// has exactly one day; a multi-day event has an Event Plan and a day for each date. Every day has one call sheet.

export type ProductionMode = "recurring" | "one_time" | "multi_day";

export interface ProductionInfo {
  mode: ProductionMode;
  templateId: string | null; // recurring: its Show Template
  eventPlan: EventPlan | null; // multi-day: the plan for the whole event
}

export interface EventPlan {
  overview: string;
  venue: string;
  audience: string;
  travel: string;
  accommodation: string;
  budget: string;
  notes: string;
}

export interface InstanceInfo {
  templateId: string; // the Show Template it was made from
  occurrence: string; // the date the schedule gave it (kept if the day is moved)
  templateVersion: number; // the template's version it last took
  locked: boolean; // edited by hand: later template changes pass it by, until it is reset to the template
  lockedAt: string | null;
  lockedBy: string | null;
  label?: string | null; // Morning, Afternoon, Evening, Late night, Full day, or a name of its own
}

/** When a recurring show happens. Dates are YYYY-MM-DD; weekdays 0 (Sunday) to 6 (Saturday). */
export interface RecurrenceRule {
  freq: "daily" | "weekly" | "monthly";
  interval: number; // every N weeks or months
  weekdays: number[]; // weekly: the days of the week
  monthDay: number | null; // monthly: this day of the month (a shorter month uses its last day)
  nth: { week: 1 | 2 | 3 | 4 | -1; weekday: number } | null; // monthly: the first to fourth, or last (-1), weekday
  startDate: string;
  until: string | null; // the last date it may fall on
  count: number | null; // or how many times it happens in all
  skipDates: string[]; // dates left out (a holiday)
  extraDates: string[]; // dates added (a special service)
}

/** A line of a call sheet's technical check. */
export interface CheckItem {
  id: string;
  label: string;
  done: boolean;
  note: string;
}

/** Someone who appears: a host, guest, speaker or performer. Free text, so outside talent needs no account. */
export interface TalentEntry {
  id: string;
  name: string;
  role: string;
  contact: string;
  callTime: string; // HH:MM, or empty for the sheet's talent call
  notes: string;
}

/** Someone to call on the day who is not on the crew: the venue's manager, security, a driver. */
export interface ContactEntry {
  id: string;
  name: string;
  role: string;
  phone: string;
  email: string;
}

export interface Logistics {
  transport: string;
  parking: string;
  meals: string;
  accommodation: string;
  other: string;
}

export interface Rehearsal {
  time: string; // HH:MM, or empty
  notes: string;
  done: boolean;
}

/** A quantity of an item to book. */
export interface GearRequest {
  equipmentId: string;
  quantity: number;
}

/**
 * What a call sheet holds that a Show Template holds too. Copied whole when a sheet is made from a template, made
 * for a new day of an event, or duplicated; a template change is copied to the days still following it.
 */
export interface SheetContent {
  callTime: string; // crew call, HH:MM
  talentCall: string;
  startTime: string;
  wrapTime: string;
  location: string;
  locationAddress: string;
  locationNotes: string;
  locationId: string | null; // the saved location it was taken from, if any (data version 20)
  format: string;
  notes: string;
  crewPersonIds: string[];
  crewRoles: Record<string, string>; // personId to their role on this sheet
  crewLeadId: string | null;
  talent: TalentEntry[];
  logistics: Logistics;
  contacts: ContactEntry[];
  runOfShow: RunItem[];
  technicalCheck: CheckItem[];
  rehearsal: Rehearsal;
  plannedGear: GearRequest[]; // gear still to book (a template's gear; booked on a day within two weeks of it)
}

/** A recurring show's standard crew, equipment, workflow, run of show and call sheet. */
export interface ShowTemplate {
  id: string; // DOF-TPL-001
  contentId: string; // the show
  rule: RecurrenceRule;
  sheet: SheetContent;
  productionLevel: ProductionLevel | null; // each day's level of production
  ownerPersonId: string | null; // responsible for each day
  horizonWeeks: number; // how far ahead days are made, in weeks, unless horizonCount is set
  horizonCount?: number | null; // or: the next so many dates (build prompt v2: the next 8 by default)
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

// ── The five-stage workflow ──────────────────────────────────
// Development and Pre-production happen on the project, Production on each recording session, and
// Post production and Marketing and distribution on each episode. See src/config/workflow.ts.

export type SeriesType = "podcast" | "testimonial" | "sermon";
export type FormType =
  | "podcast"
  | "testimonial"
  | "sermon"
  | "documentary_dof"
  | "documentary_pitched"
  | "devotion"
  | "music_single" // DOF Music: one song, its audio and its video
  | "music_album" // DOF Music: an album of songs, each with its own or a shared storyboard and shot list
  | "live_event"; // Live Shows: an event (one day, several days, or a recurring show), each day with its call sheet and run of show
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
  storageDriveId?: string | null; // the drive its footage is planned to go on (the Recording Plan's Cards and storage)
  aheadOfReview?: ReviewNote[]; // each time someone went ahead before the theological review was done (build prompt v2, section 14)
  // Recorded before the system and brought in from a drive (build prompt v4, section 7A): its earlier stages show
  // "Recorded before the system", and its dates before importedAt are history (no reminders, overdue, urgency or Google).
  imported?: boolean;
  importedAt?: string | null;
  reviewedBeforeSystem?: boolean; // its theological review was done before the system: the banner is cleared
  // The Checks panel's suggestions set aside (build prompt v4, section 14A), keyed "{ownerId}|{check key}", with a note.
  dismissedChecks?: Record<string, { note: string; byPersonId: string; at: string }>;
}

/** Someone went ahead (scheduled a session, published a call sheet or an episode) before the theological review was done. */
export interface ReviewNote {
  at: string;
  byPersonId: string;
  action: "schedule" | "publish-sheet" | "publish-episode";
  targetId: string; // the session, call sheet or episode
  note: string; // their short note, possibly empty
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
  sourceRowId?: string | null; // a live recording: the row of the day's show log it was made from
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
  // A hard gate of the documents (src/services/documents/gates.ts) passed by hand, with the reason. Absent on forms
  // made before the documents; none means none.
  overrides?: GateOverride[];
  createdAt: string;
  updatedAt: string;
}

export interface GateOverride {
  key: string; // which hard gate
  note: string; // why it was passed by hand
  byPersonId: string;
  at: string;
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
  // An episode made before the workflow and not recorded yet: the Content ID it keeps when it is recorded. Its old
  // record waits, archived with that reason, and becomes the episode when a session that recorded it closes.
  reservedId: string | null;
  sourcePageId: string | null; // a devotion's: the page of its Devotional Script it was made from
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedReason: string | null;
}

export type RoleKey = "director" | "dop" | "audio_engineer" | "camera_operator" | "continuity" | "editor" | "host_guest" | "custom";

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
  // A Recording Plan's roles are the project's own list: named as the producer likes (empty: the role's usual name), in
  // the order they set, and listed before anyone is chosen (no crewId and no guestName yet).
  label?: string;
  position?: number;
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
export type SessionLabel = "Morning" | "Afternoon" | "Evening" | "Late night" | "Full day";

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
  // Set in a devotion's Recording Plan (and open to any project): what the session is called, its part of the day and
  // its hours, the storyboard and shot list chosen for it, and the drive its footage goes on if not the project's.
  name?: string;
  label?: SessionLabel | null;
  startTime?: string | null; // HH:MM
  endTime?: string | null; // HH:MM
  storyboardId?: string | null;
  shotListId?: string | null;
  storageDriveId?: string | null;
  fromCallSheet?: boolean; // made by the move to data version 18, for a devotion's call sheet that had no session
  // A day of a live event (data version 23): made from its recurring show's template, or one day of a multi-day event.
  instance?: InstanceInfo | null;
  productionLevel?: ProductionLevel | null; // a live day's level of production: decides whether its call sheet needs a run of show
  movedFrom?: string | null; // the live day record it replaced in the move to data version 23 (that record is kept, archived)
  // The Recording Log (build prompt v4, section 7A): who attended, and the session's issues and pickups.
  attendees?: string[] | null; // crew Person IDs; null or absent: the call sheet's crew
  attendeesNote?: string; // others who attended, as text
  issues?: string; // carried into the project's Edit Notes when the session closes
}

export type LogStatus = "Recorded" | "Pickup needed" | "Not recorded"; // shown as the take marks Good, Pickup needed, Re-record

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
  duration?: string; // the take's length, as typed: "12:30" or "58 min"
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

// ── Project documents (the documents rework) ─────────────────
// Narrative work is written as documents of pages, one set per project, chosen by its type and stage
// (src/config/documentCatalog.ts). Anything that drives the calendar, reminders, call sheets, gear, storage or
// overdue stays a structured form.

/** One document of a project, made the first time it is opened from the catalogue. */
export interface ProjectDocument {
  id: string; // {contentId}|{stage}|{docKey}, and |{ownerId} for one of a session or episode: one each
  contentId: string;
  stage: WorkflowStage;
  docKey: string;
  ownerId: string | null; // the session or episode it is for (a Recording Day Sheet), or null for the whole project
  title: string;
  migrated: boolean; // written by the move from the old Development form: undoing the move removes exactly these
  createdAt: string;
  updatedAt: string;
}

/** A page of a document: a title, a subtitle (a scripture or a note) and a rich-text body. */
export interface DocumentPage {
  id: string;
  documentId: string;
  position: number;
  title: string;
  subtitle: string;
  bodyHtml: string; // cleaned to an allow-list on every save and every load
  version: number; // a save based on an older version is refused, so two people never overwrite each other unawares
  archivedAt: string | null; // a deleted page is kept, archived, so no writing is ever lost
  updatedAt: string;
  updatedBy: string;
  // The episode a page is about: a Review Thread has one page for each episode. Absent or null on every other page.
  episodeId?: string | null;
}

/** A link kept with a document: a Google Doc, a Drive folder, a WhatsApp thread. The file stays where it is. */
export interface DocumentLink {
  id: string;
  documentId: string;
  url: string; // http or https only
  label: string;
  addedBy: string;
  addedAt: string;
}

export type DocumentReviewStatus = "pending" | "approved" | "changes_requested";

/** A named reviewer's decision on a whole document: one Approve, or Request changes with a reason. */
export interface DocumentReview {
  id: string; // {documentId}|{reviewerId}
  documentId: string;
  reviewerId: string;
  status: DocumentReviewStatus;
  note: string; // required when changes are requested
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A reviewer's comment beside one page. Resolved, it stays, marked resolved. */
export interface ReviewComment {
  id: string;
  documentId: string;
  pageId: string;
  authorId: string;
  body: string;
  resolved: boolean;
  resolvedBy: string | null;
  createdAt: string;
}

/** A storyboard of a project, or of one of its episodes. */
export interface Storyboard {
  id: string;
  contentId: string | null; // null: a template, or a board for practice or an event, kept in Documents (data version 21)
  isTemplate: boolean; // a template: "Use template" in a project makes a copy, and editing the copy never changes it
  episodeId: string | null;
  name: string;
  position: number;
  copiedFrom: string | null; // the storyboard it was started from, if any
  migrated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardFrame {
  id: string;
  storyboardId: string;
  position: number;
  scene: string; // "Sc. 2"
  imagePath: string | null; // the stored image's address: never the image itself
  description: string;
  soundEffects: string;
  videoLink: string; // http or https, or empty
}

export interface ShotList {
  id: string;
  contentId: string | null; // null: a template, or a list for practice or an event, kept in Documents (data version 21)
  isTemplate: boolean; // a template: "Use template" in a project makes a copy, and editing the copy never changes it
  episodeId: string | null;
  name: string;
  position: number;
  copiedFrom: string | null; // the shot list it was started from, if any
  migrated: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ShotRowType = "shot" | "setup" | "banner";

/** A row of a shot list. Only shot rows are numbered; a setup row holds lighting, lens or camera notes and a banner divides sections. */
export interface ShotListRow {
  id: string;
  shotListId: string;
  position: number;
  rowType: ShotRowType;
  imagePath: string | null;
  description: string;
  shotSize: string;
  shotType: string;
  movement: string;
  estMinutes: number | null;
}

/** One line of a live show's run of show. */
export interface RunItem {
  id: string;
  time: string; // HH:MM
  title: string;
  durationMin: number;
  ownerPersonId: string | null;
  notes: string;
  // A live show's run of show also has these (build prompt v2, section 7): who is on camera, audio and graphics for
  // the segment, where it stands on the night, and when it actually started and ended.
  camera?: string;
  audio?: string;
  graphics?: string;
  status?: RunStatus;
  actualStart?: string; // HH:MM
  actualEnd?: string;
}

export type RunStatus = "Planned" | "Live" | "Done" | "Cut";

export interface CallSheet extends SheetContent {
  id: string; // DOF-CS-001
  contentId: string; // top-level project the sheet belongs to
  title: string;
  date: string;
  linkedEpisodeIds: string[]; // fixed at creation, never live-recalculated
  equipmentIds: string[]; // populated by the Equipment module (phase 2)
  instanceId: string | null; // the day of a show it is for (data version 19)
  status: "draft" | "final";
  version: number;
  createdAt: string;
  // Data version 20
  sharedAt: string | null; // first made final (issued to the team); from then on, changes are logged
  confirmations: Record<string, Confirmation>; // by personId (crew) or "talent:<row id>"
  changeLog: SheetChange[]; // changes made after it was shared or someone confirmed, newest last
}

/**
 * Someone confirmed they will be there: at this call time, at this place, in this role. A change to any of the three
 * clears it, so they confirm again.
 */
export interface Confirmation {
  at: string;
  by: string; // who ticked it: the person themself, or someone recording it for them
  callTime: string;
  location: string;
  role: string;
}

/** A change made to a call sheet the team has already seen: what changed, from what to what, who and when. */
export interface SheetChange {
  id: string;
  at: string;
  by: string;
  what: string; // "Crew call", "Location", "Crew", "Talent", "Date"…
  from: string;
  to: string;
}

/** A place the team records at again and again, picked on any call sheet or template. */
export interface SavedLocation {
  id: string; // LOC-xxxxxxxx
  name: string;
  address: string;
  notes: string;
  archived: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
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
    | "photo"
    | "lent" // data version 21: lent out (Equipment, Lending)
    | "loan-returned";
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
  offline?: boolean; // marked by hand: not plugged in or not reachable (the app cannot see the drives themselves)
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
  sessionId?: string | null; // a recording session's footage, entered after it was recorded
  // Storage assigned in Production (build prompt v4, section 7A). The app cannot reach the drives, so the folder is
  // recorded here and the crew copy the files.
  role?: "primary" | "backup" | null; // a session's footage: its main drive, or the backup copy
  folderPath?: string; // where on the drive: "DOF-SER-001-S1/2026-10-09_Morning"
  offloadedAt?: string | null; // the main drive: the cards were offloaded onto it
  offloadedBy?: string | null;
  backedUpAt?: string | null; // the backup drive: the copy was made
  backedUpBy?: string | null;
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
  storageFolderPattern?: string; // a session's folder on a drive (build prompt v4, 7A): {contentId}, {date}, {label}, {session}
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
  // Data version 21. Which parts of the rework are switched on (src/config/features.ts), and the urgency report's
  // thresholds where they differ from the defaults (src/config/urgency.ts).
  features?: Record<string, boolean>;
  urgency?: Partial<UrgencyThresholds>;
}

/** The urgency report's numbers, kept in settings so they change without code. */
export interface UrgencyThresholds {
  soonHours: number; // a session or show this close with no published call sheet, or items not assigned, is Critical
  dueHours: number; // an episode due this close is High
  noRecordingDays: number; // due within this many days with no recording date is Watch
  loanOverdueHighDays: number; // a loan this many days late is High; any later is Critical
  liveWindowDays?: number; // a live event is urgent or at risk only once its next day is this close (30: a month)
}

// ── Lending, role kits, the Calendar's reminders and alerts (data version 21) ──

/** Equipment lent to someone outside a production: a church, a partner, a member. It replaces the General Use category. */
export interface Loan {
  id: string; // DOF-LOAN-0001: its own number, no Content ID
  borrowerName: string;
  borrowerPhone: string;
  organisation: string;
  lines: LoanLine[];
  dateOut: string; // YYYY-MM-DD
  expectedReturn: string; // YYYY-MM-DD
  notes: string;
  lentBy: string; // the person who lent it
  status: "out" | "returned" | "cancelled";
  createdAt: string;
  updatedAt: string;
  returnedAt: string | null; // when the last item came back
  fromContentId: string | null; // the General Use record it was made from, if any, so the old ID still finds it
}

export interface LoanLine {
  equipmentId: string;
  quantity: number;
  conditionOut: EquipCondition;
  returns: LoanReturn[]; // items come back in one go or a few at a time
}

export interface LoanReturn {
  at: string;
  by: string;
  quantity: number;
  condition: EquipCondition;
  note: string;
}

/** The gear a role usually takes, offered on a call sheet item by item. An editable default, never forced. */
export interface RoleKit {
  id: string; // DOF-KIT-001
  role: string; // "Camera operator"
  keywords: string[]; // words in a call sheet role that this kit is for: "camera", "dop"
  cameraModel: string; // "FX6", or empty for any
  items: GearRequest[];
  notes: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * A reminder on the Calendar: attached to something with a date (a recording session or show day, a call sheet, an
 * episode's due date, a project's, a loan's return) or standing alone. It fires `offsetMinutes` before that date and
 * time, in the app and, if chosen, by email.
 */
export interface CalendarReminder {
  id: string;
  targetType: ReminderTarget | null; // null: a reminder standing alone
  targetId: string | null;
  title: string; // what it is about; for one attached to something, an optional note
  date: string; // YYYY-MM-DD; for one attached to something, worked out from it
  time: string; // HH:MM, or empty for the whole day (fires from 08:00)
  offsetMinutes: number; // 0 at the time, 60 an hour before, 1440 a day, 10080 a week, or any number
  channels: ("app" | "email")[];
  recipientIds: string[];
  repeat: "none" | "daily" | "weekly" | "monthly"; // a reminder standing alone can repeat
  fireAt: string | null; // when it is next due, as an ISO time; null once it has fired and does not repeat
  firedAt: string | null; // when it last fired in the app (into the bell)
  emailedAt: string | null; // when its email was last queued
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export type ReminderTarget = "instance" | "callsheet" | "episode" | "project" | "loan";

/** Something in the bell for one person: a reminder that fired, a sheet that changed. */
export interface AppNotification {
  id: string;
  personId: string;
  title: string;
  body: string;
  link: string | null; // where it opens, as the app's link (#/callsheet/DOF-CS-004)
  key: string; // what it is about, so the same thing is not sent twice
  at: string;
  readAt: string | null;
}

/** An email waiting to go out, or sent, through the workspace's SMTP account. Kept on the server only. */
export interface EmailMessage {
  id: string;
  personId: string | null;
  to: string;
  subject: string;
  body: string;
  key: string; // what it is about, so the same thing is not emailed twice
  status: "queued" | "sent" | "failed";
  attempts: number;
  nextTryAt: string;
  createdAt: string;
  sentAt: string | null;
  lastError: string;
}

/** A dated item pushed to someone's "DOF Production Hub" Google calendar, so a change updates the same event. */
export interface GoogleSyncLink {
  id: string;
  personId: string;
  itemType: string;
  itemId: string;
  googleEventId: string;
  fingerprint: string; // what was last pushed, so an unchanged item is not pushed again
  syncedAt: string;
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
  // Project documents, storyboards and shot lists (see the interfaces above)
  projectDocuments: ProjectDocument[];
  documentPages: DocumentPage[];
  documentLinks: DocumentLink[];
  documentReviews: DocumentReview[];
  reviewComments: ReviewComment[];
  storyboards: Storyboard[];
  storyboardFrames: StoryboardFrame[];
  shotLists: ShotList[];
  shotListRows: ShotListRow[];
  showTemplates: ShowTemplate[]; // data version 19
  locations: SavedLocation[]; // data version 20
  // Data version 21
  loans: Loan[];
  roleKits: RoleKit[];
  calendarReminders: CalendarReminder[];
  notifications: AppNotification[];
  emailQueue: EmailMessage[];
  googleSyncLinks: GoogleSyncLink[];
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
