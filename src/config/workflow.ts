import type {
  CategoryKey,
  ChecklistOwner,
  CheckpointKey,
  CriterionKey,
  FormType,
  GreenlightOutcome,
  RoleKey,
  SeriesType,
  WorkflowStage,
} from "../types";

// The five-stage workflow for series (podcast, testimonial and sermon), devotions and documentaries: one source
// of truth for its stages, forms, roles and checklists. Live Shows, Music and General Use keep their own
// pipelines in categories.ts and never use anything here.

export type WorkflowLevel = "project" | "session" | "episode";

export interface WorkflowStageDef {
  name: WorkflowStage;
  level: WorkflowLevel; // where the work of this stage is tracked
  ledBy: string;
  gate: string; // what must be true to leave the stage
}

export const WORKFLOW_STAGES: WorkflowStageDef[] = [
  {
    name: "Development",
    level: "project",
    ledBy: "Proposer and DOF team",
    gate: "Greenlight, with team message review",
  },
  {
    name: "Pre-production",
    level: "project",
    ledBy: "Show producer",
    gate: "Rehearsal passed, call sheet issued",
  },
  {
    name: "Production",
    level: "session",
    ledBy: "Show producer",
    gate: "Wrap checklist complete and session log filled",
  },
  {
    name: "Post production",
    level: "episode",
    ledBy: "Editor",
    gate: "Rough cut and final cut approved",
  },
  {
    name: "Marketing and distribution",
    level: "episode",
    ledBy: "Post and distribution lead",
    gate: "Release plan approved, episode published and logged",
  },
];

export const WORKFLOW_STAGE_NAMES: WorkflowStage[] = WORKFLOW_STAGES.map((s) => s.name);

/** The categories that run this workflow. */
export const WORKFLOW_CATEGORIES: CategoryKey[] = ["series", "devotional", "documentary"];
export const isWorkflowCategory = (key: CategoryKey): boolean => WORKFLOW_CATEGORIES.includes(key);

// ── Types and forms ──────────────────────────────────────────

export const SERIES_TYPES: { key: SeriesType; label: string }[] = [
  { key: "podcast", label: "Podcast" },
  { key: "testimonial", label: "Testimonial" },
  { key: "sermon", label: "Sermon" },
];

export interface FormTypeDef {
  key: FormType;
  label: string;
  category: CategoryKey;
  greenlights: 1 | 2; // a DOF-made documentary is greenlit twice: thesis, then shoot
  outcomes: GreenlightOutcome[];
}

const OUTCOMES: GreenlightOutcome[] = ["Greenlight", "Revise and resubmit", "Hold", "Decline"];

export const FORM_TYPES: FormTypeDef[] = [
  { key: "podcast", label: "Series: Podcast", category: "series", greenlights: 1, outcomes: OUTCOMES },
  { key: "testimonial", label: "Series: Testimonial", category: "series", greenlights: 1, outcomes: OUTCOMES },
  { key: "sermon", label: "Series: Sermon", category: "series", greenlights: 1, outcomes: OUTCOMES },
  { key: "documentary_dof", label: "Documentary: DOF-made", category: "documentary", greenlights: 2, outcomes: OUTCOMES },
  {
    key: "documentary_pitched",
    label: "Documentary: Pitched by others",
    category: "documentary",
    greenlights: 1,
    outcomes: [...OUTCOMES, "Advice only"],
  },
  { key: "devotion", label: "Devotion", category: "devotional", greenlights: 1, outcomes: OUTCOMES },
];

export const formTypeOf = (key: FormType): FormTypeDef => {
  const f = FORM_TYPES.find((x) => x.key === key);
  if (!f) throw new Error(`Unknown form type ${key}`);
  return f;
};

/** The form a series uses is decided by its type. */
export const formTypeForSeries = (t: SeriesType): FormType => t;

export const SERMON_FORMATS = [
  { key: "in_person", label: "In person" },
  { key: "recorded", label: "Recorded" },
] as const;

/** The six things every pitch is assessed against at Greenlight. */
export const CRITERIA: { key: CriterionKey; label: string }[] = [
  { key: "missionFit", label: "Mission fit" },
  { key: "messageSoundness", label: "Message soundness" },
  { key: "audienceNeed", label: "Audience need" },
  { key: "feasibility", label: "Feasibility" },
  { key: "resourceCost", label: "Resource cost" },
  { key: "teamStrength", label: "Team strength" },
];

// ── Theological review checkpoints ───────────────────────────

export const CHECKPOINTS: { key: CheckpointKey; label: string; on: "project" | "episode" }[] = [
  { key: "pitch", label: "Pitch", on: "project" },
  { key: "outline_script", label: "Outline or script", on: "project" },
  { key: "rough_cut", label: "Rough cut", on: "episode" },
  { key: "final", label: "Final", on: "episode" },
];

// ── Project roles ────────────────────────────────────────────
// The show producer is named at Development and held on the project itself. The producer assigns these at
// Pre-production. A person's project role can differ from their role in the company.

export const PROJECT_ROLE_DEFS: { key: RoleKey; label: string; exclusive: boolean }[] = [
  { key: "director", label: "Director", exclusive: true },
  { key: "dop", label: "DOP", exclusive: true },
  { key: "audio_engineer", label: "Audio engineer", exclusive: true },
  { key: "camera_operator", label: "Camera operator (B-roll)", exclusive: true },
  { key: "continuity", label: "Continuity", exclusive: true },
  { key: "editor", label: "Editor", exclusive: true },
  { key: "host_guest", label: "Host or guest", exclusive: false },
];

/** Roles that must be filled before a session can move into Production. Hosts and guests need at least one. */
export const REQUIRED_ROLES: RoleKey[] = ["director", "dop", "audio_engineer", "editor", "host_guest"];

export const roleLabel = (key: RoleKey): string => PROJECT_ROLE_DEFS.find((r) => r.key === key)?.label ?? key;

// ── Checklists ───────────────────────────────────────────────
// Items marked `auto` are worked out from the data (a call sheet that is final, a producer who is named) and
// never ticked by hand, so they cannot disagree with it. Every other item is stored with its tick and a note.

export interface ChecklistItemDef {
  key: string;
  label: string;
  group?: string; // a heading the item is shown under
  required: boolean;
  auto?: true;
}

export interface ChecklistDef {
  owner: ChecklistOwner;
  stage: WorkflowStage;
  items: ChecklistItemDef[];
}

const item = (key: string, label: string, extra: Partial<ChecklistItemDef> = {}): ChecklistItemDef => ({
  key,
  label,
  required: true,
  ...extra,
});

export const CHECKLISTS = {
  /** Development, Handoff: ends when a producer is named and the project exists. */
  handoff: {
    owner: "project",
    stage: "Development",
    items: [
      item("outline_locked", "Outline locked"),
      item("owner_resources", "Owner and resource commitment confirmed"),
      item("producer_named", "Show producer named", { auto: true }),
      item("project_created", "Project created with its Content ID", { auto: true }),
    ],
  },
  /** Pre-production, for the whole project. */
  preProject: {
    owner: "project",
    stage: "Pre-production",
    items: [
      item("roles_assigned", "Production roles assigned by the producer", { auto: true }),
      item("outline_locked", "Outline locked"),
      item("visual_plan", "Storyboarding and concept art: visual plan and episode rundown (framing, colours, graphics style, segments)"),
      item("shot_list", "Shot list: which camera covers host, guest and wide, lenses, inserts, graphics, B-roll"),
      item("set_design", "Set design: seating, backdrop, lighting, sound treatment, props, wardrobe"),
    ],
  },
  /** Pre-production, for each recording session. */
  preSession: {
    owner: "session",
    stage: "Pre-production",
    items: [
      item("gear_selected", "Gear selected from the Equipment picker, with no unresolved conflict", { auto: true }),
      item(
        "technical_rehearsal",
        "Technical rehearsal: audio levels, camera sync, colour match, storage and batteries, short mock recording",
      ),
      item("call_sheet_issued", "Call sheet issued", { auto: true }),
    ],
  },
  /** Production: the wrap checklist. Every item is required. */
  wrap: {
    owner: "session",
    stage: "Production",
    items: [
      item("media_offloaded", "All cards and drives offloaded and backed up to a second location", { group: "Media" }),
      item("files_checked", "Files checked: a few seconds played back from each camera and audio track", { group: "Media" }),
      item("cards_labeled", "Cards labeled and stored in the project's folder", { group: "Media" }),
      item("nothing_wiped", "Nothing formatted or wiped until the backup is confirmed", { group: "Media" }),
      item("gear_counted", "All equipment counted against the call sheet", { group: "Gear" }),
      item("batteries_faults", "Batteries on charge; damage or faults noted", { group: "Gear" }),
      item("gear_returned", "Gear returned to storage", { group: "Gear" }),
      item("set_struck", "Set struck and the space returned to how it was", { group: "Set" }),
      item("props_returned", "Props and wardrobe returned", { group: "Set" }),
      item("daily_log", "Daily log written: what was recorded, pickup timestamps, technical problems, who attended", { group: "Records" }),
      item("continuity_notes", "Continuity notes handed to the editor", { group: "Records" }),
      item("episode_status", "Episode status updated in the Hub", { group: "Records", auto: true }),
      item("guests_thanked", "Guests thanked; follow-up noted (release forms, photos, next steps)", { group: "People" }),
      item("crew_wrap_note", "Crew wrap-up note: what worked, what to change", { group: "People" }),
    ],
  },
  /** Post production, for each episode. The gates are the editor's "ready" and the two review checkpoints. */
  post: {
    owner: "episode",
    stage: "Post production",
    items: [
      item("offload_check", "Offload check", { required: false }),
      item("edit", "Edit", { required: false }),
      item("audio_cleanup", "Audio clean-up", { required: false }),
      item("rough_cut", "Rough cut", { required: false }),
      item("final_cut", "Final cut", { required: false }),
      item("story_lock", "Story lock", { required: false, group: "Finer steps (optional)" }),
      item("picture_lock", "Picture lock", { required: false, group: "Finer steps (optional)" }),
      item("color", "Color grade", { required: false, group: "Finer steps (optional)" }),
      item("sound_mix", "Sound mix", { required: false, group: "Finer steps (optional)" }),
      item("graphics", "Graphics", { required: false, group: "Finer steps (optional)" }),
    ],
  },
  /** Marketing and distribution, for each episode. The release plan items are required; publishing is tracked. */
  release: {
    owner: "episode",
    stage: "Marketing and distribution",
    items: [
      item("episode_titles", "Episode titles", { group: "Release plan" }),
      item("cover_art", "Cover art", { group: "Release plan" }),
      item("short_clips", "Short clips", { group: "Release plan" }),
      item("captions", "Captions", { group: "Release plan" }),
      item("release_calendar", "Release calendar", { group: "Release plan" }),
      item("upload", "Upload", { required: false, group: "Publishing" }),
      item("schedule", "Schedule", { required: false, group: "Publishing" }),
      item("publish", "Publish", { required: false, group: "Publishing" }),
      item("log_links", "Log the links", { required: false, group: "Publishing" }),
      item("early_numbers", "Review early listener numbers", { required: false, group: "Publishing" }),
    ],
  },
} satisfies Record<string, ChecklistDef>;

export type ChecklistKey = keyof typeof CHECKLISTS;

// ── IDs ──────────────────────────────────────────────────────
// A project keeps the Content ID the app already gives it. Its sessions, planned episodes and episodes add a
// suffix, zero-padded to two digits: DOF-SER-001-S1-R01, DOF-SER-001-S1-P01, DOF-SER-001-S1-E01.

export const SESSION_TOKEN = "R";
export const PLANNED_TOKEN = "P";
export const EPISODE_TOKEN = "E";
