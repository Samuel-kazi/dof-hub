// ─────────────────────────────────────────────────────────────
// Core data model for the Dawn of Faith Production Hub.
// Written to map 1:1 onto relational tables so the mock store
// can later be swapped for SQLite/Postgres/MongoDB without
// touching screens.
// ─────────────────────────────────────────────────────────────

export type RoleCode = "HOP" | "CRW" | "VOL" | "PTR";
export type CategoryKey = "series" | "devotional" | "live" | "documentary" | "music";

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
}

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
  archived: boolean;
  version: number; // optimistic concurrency
  createdAt: string;
  notes: string;
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

export type EquipCategoryKey = "camera" | "audio" | "lighting" | "live" | "studio" | "computing" | "cabling" | "power" | "transport" | "ministry" | "safety";
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
  condition: EquipCondition;
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
  kind: "created" | "assigned" | "released" | "checked-out" | "checked-in" | "incident" | "repair-start" | "repair-end" | "retired" | "lost" | "edited" | "photo";
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
  contentId: string;
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
}

export interface Settings {
  stageReminderHours: number;
  storageWarningThreshold: number;
  checkoutReturnDays: number;
  workDays: number[]; // days of the week people are normally at work, 0 is Sunday
  effortOverrides: Record<string, number>; // person-days per stage, keyed "category:Stage", replacing the built-in estimates
  permissions?: { roles: Partial<Record<RoleCode, Partial<Record<string, boolean>>>>; people: Record<string, Partial<Record<string, boolean>>> }; // what the Head of Production has granted or denied
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
