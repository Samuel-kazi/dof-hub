import type { CategoryKey, FormType } from "../types";

// One source of truth for how each content category behaves.
// The UI reads this; no per-category logic is scattered elsewhere.
export interface StageDef {
  name: string;
  // The output that must exist before this stage can be marked Done.
  requiredOutput: string;
  // Checklist created when an item enters the stage. Every item must be ticked before the stage is done.
  tasks?: string[];
  // Document templates attached automatically when an item enters the stage.
  docs?: string[];
}

export interface CategoryConfig {
  key: CategoryKey;
  label: string;
  singular: string;
  code: string; // used in Content IDs: DOF-SER-001
  supportsChildren: boolean;
  childLevelLabel: string | null; // "Season", "Album"
  grandchildLevelLabel: string | null; // "Episode", "Track"
  childToken: string | null; // S1, A1
  grandchildToken: string | null; // E01, T01
  // For series, devotions and documentaries this is the earlier pipeline, kept for records made before the
  // five-stage workflow until they are moved across. Their new records follow `workflow` instead.
  stages: StageDef[];
  // The level that carries the pipeline: 0 for a flat project, 1 for a live show's days, 2 for episodes and tracks.
  leafLevel: number;
  // From this stage on there is footage to store, so the item prompts for a drive.
  footageStage: string;
  // The one place this category's colour is defined. Every view that renders a category (Kanban
  // cards, the calendar, dashboard charts) reads it from here rather than choosing its own.
  color: string;
  // The five-stage workflow (src/config/workflow.ts). Null for categories that keep their own pipeline.
  workflow: CategoryWorkflow | null;
}

/** Where a category's projects and episodes sit in its hierarchy, for the five-stage workflow. */
export interface CategoryWorkflow {
  projectLevel: number; // 1: a season of a series, a live show's event, a music release. 0: a devotion or documentary itself.
  projectLabel: string;
  episodeLevel: number; // always projectLevel + 1
  episodeLabel: string;
  formTypes: FormType[];
  sessionLabel?: string; // what a recording session is called: "Session", or a live event's "Day"
  sessionToken?: string; // the letter of its code: R (DOF-SER-001-S1-R01), or D for a live event's days
  episodeToken?: string; // the letter of an episode's code: E, T for a song, R for a live recording
}

const s = (name: string, requiredOutput: string, extra: { tasks?: string[]; docs?: string[] } = {}): StageDef => ({
  name,
  requiredOutput,
  ...extra,
});

// The levels of finishing an edit, in order. Each one can have its own deadline and person.
export const EDIT_TASKS = ["Story lock", "Picture lock", "Sound check", "Color"];

export const CATEGORIES: CategoryConfig[] = [
  {
    key: "series",
    label: "Series",
    singular: "Series",
    code: "SER",
    color: "#e8703a",
    supportsChildren: true,
    childLevelLabel: "Season",
    grandchildLevelLabel: "Episode",
    childToken: "S",
    grandchildToken: "E",
    stages: [
      s("Idea", "Approved concept", { docs: ["concept"] }),
      s("Scripting", "Locked script", { docs: ["script"] }),
      s("Pre-production", "Shot list and call sheet", { docs: ["shotlist"] }),
      s("Recording", "Recorded footage"),
      s("Ingest", "Verified footage"),
      s("Editorial", "Finished edit", { tasks: EDIT_TASKS, docs: ["edit-notes"] }),
      s("Review", "Approved cut"),
      s("Delivered", "Final delivery file", { docs: ["analysis"] }),
    ],
    footageStage: "Recording",
    leafLevel: 2,
    workflow: {
      projectLevel: 1,
      projectLabel: "Season",
      episodeLevel: 2,
      episodeLabel: "Episode",
      formTypes: ["podcast", "testimonial", "sermon"],
    },
  },
  {
    key: "devotional",
    label: "Devotionals",
    singular: "Devotional",
    code: "DEV",
    color: "#7fbf95",
    supportsChildren: false,
    childLevelLabel: null,
    grandchildLevelLabel: null,
    childToken: null,
    grandchildToken: null,
    stages: [
      s("Creation", "Theme, guest and producer set"),
      s("Guest", "Theological review approved", { tasks: ["Guest outreach", "Setup shared", "Summary submitted"] }),
      s("Prep/Scripting", "Locked script", { docs: ["script"] }),
      s("Recording", "Recording logged"),
      s("Editing", "Ready for review", { docs: ["edit-notes"] }),
      s("Review", "Approved cut"),
      s("Published", "Final delivery file", { docs: ["analysis"] }),
    ],
    footageStage: "Recording",
    leafLevel: 0,
    // One guest's five-day sharing: one project, five episodes (Day 1 to Day 5) recorded in one session.
    workflow: { projectLevel: 0, projectLabel: "Devotion", episodeLevel: 1, episodeLabel: "Day", formTypes: ["devotion"] },
  },
  {
    key: "live",
    label: "Live Shows",
    singular: "Live show",
    code: "LIVE",
    color: "#f3b943",
    supportsChildren: true,
    // A live show holds its events, as a series holds its seasons (data version 23). An event is the project: one day,
    // several days, or a recurring show. Its days are its sessions, each with its own call sheet and run of show; what
    // was recorded on a day goes on as recordings, through post production and release, like a series' episodes.
    childLevelLabel: "Event",
    grandchildLevelLabel: "Recording",
    childToken: "E",
    grandchildToken: "R",
    // The earlier pipeline of a show's days, kept for records made before data version 23 (they are moved across by it).
    stages: [
      s("Development", "Show plan ready: show date set and producer named"),
      s("Pre-production", "Technical prep and rehearsal done", {
        tasks: ["Gear tested and packed", "Rig built and safety-checked", "Camera, audio and stream checks passed"],
        docs: ["run-of-show"],
      }),
      s("Production", "Stream completed and strike done"),
      s("Post production", "Recording reviewed, clips exported"),
      s("Marketing and distribution", "Archived, with the show report", { docs: ["analysis"] }),
    ],
    footageStage: "Production",
    // The level the earlier pipeline ran on: a show's days, kept as they were in data made before data version 23.
    leafLevel: 1,
    workflow: {
      projectLevel: 1,
      projectLabel: "Event",
      episodeLevel: 2,
      episodeLabel: "Recording",
      formTypes: ["live_event"],
      sessionLabel: "Day",
      sessionToken: "D",
      episodeToken: "R",
    },
  },
  {
    key: "documentary",
    label: "Documentaries",
    singular: "Documentary",
    code: "DOC",
    color: "#8f9fdc",
    supportsChildren: false,
    childLevelLabel: null,
    grandchildLevelLabel: null,
    childToken: null,
    grandchildToken: null,
    stages: [
      s("Idea", "Approved treatment", { docs: ["concept"] }),
      s("Research", "Research file", { docs: ["research"] }),
      s("Pre-production", "Shot list and call sheet", { docs: ["shotlist"] }),
      s("Shooting", "Recorded footage"),
      s("Ingest", "Verified footage"),
      s("Editorial", "Finished edit", { tasks: EDIT_TASKS, docs: ["edit-notes"] }),
      s("Review", "Approved cut"),
      s("Delivered", "Final delivery file", { docs: ["analysis"] }),
    ],
    footageStage: "Shooting",
    leafLevel: 0,
    // One deliverable, the film, unless it is planned as several parts.
    workflow: {
      projectLevel: 0,
      projectLabel: "Documentary",
      episodeLevel: 1,
      episodeLabel: "Part",
      formTypes: ["documentary_dof", "documentary_pitched"],
    },
  },
  {
    key: "music",
    label: "DOF Music",
    singular: "Music project",
    code: "MUS",
    color: "#d58fb8",
    supportsChildren: true,
    // A music project holds its releases, as a series holds its seasons (data version 23). A release is the project: a
    // single (one song, its audio and its video) or an album. Its songs are planned at Development, recorded in sessions
    // (audio and video), and go on as songs through mixing, mastering, the video edit, review and release.
    childLevelLabel: "Release",
    grandchildLevelLabel: "Song",
    childToken: "A",
    grandchildToken: "T",
    // The earlier pipeline of a release's tracks, kept for records made before data version 23 (moved across by it).
    stages: [
      s("Development", "Approved concept and lyrics", { docs: ["concept"] }),
      s("Pre-production", "Session plan", { docs: ["music-plan"] }),
      // Recording is tracked as two parts, so audio and video each have an owner and a date.
      s("Production", "Audio and video recorded", { tasks: ["Audio recording", "Video recording"] }),
      s("Post production", "Approved mix, master and edit", { tasks: ["Mixing", "Mastering", ...EDIT_TASKS], docs: ["edit-notes"] }),
      s("Marketing and distribution", "Published, with final link", { docs: ["analysis"] }),
    ],
    footageStage: "Production",
    leafLevel: 2,
    workflow: {
      projectLevel: 1,
      projectLabel: "Release",
      episodeLevel: 2,
      episodeLabel: "Song",
      formTypes: ["music_single", "music_album"],
      episodeToken: "T",
    },
  },
  {
    key: "general",
    label: "General Use",
    singular: "General use",
    code: "GEN",
    color: "#8a8a92",
    supportsChildren: false,
    childLevelLabel: null,
    grandchildLevelLabel: null,
    childToken: null,
    grandchildToken: null,
    // Not a production: a placeholder project ID for storage, a call sheet, a document, or a gear
    // checkout that has nowhere real to attach yet — equipment lent out for something that was never
    // going to become a tracked production, for instance. One stage, nothing to advance through, and
    // it stays out of the Pipeline board and Calendar (see Pipeline.tsx and calendarView.ts).
    stages: [s("In use", "")],
    footageStage: "In use",
    leafLevel: 0,
    workflow: null,
  },
];

export const categoryOf = (key: CategoryKey): CategoryConfig => {
  const c = CATEGORIES.find((x) => x.key === key);
  if (!c) throw new Error(`Unknown category ${key}`);
  return c;
};

/** The single source of truth for a category's colour. No view should hardcode or pick its own. */
export const categoryColor = (key: CategoryKey): string => categoryOf(key).color;

/** What a project's recording sessions are called: "Session", or a live event's "Day". */
export const sessionLabelOf = (key: CategoryKey): string => categoryOf(key).workflow?.sessionLabel ?? "Session";
/** The letter of a session's code (R, or D for a live event's days) and of an episode's (E, T for songs, R for live recordings). */
export const sessionTokenOf = (key: CategoryKey): string => categoryOf(key).workflow?.sessionToken ?? "R";
export const episodeTokenOf = (key: CategoryKey): string => categoryOf(key).workflow?.episodeToken ?? "E";

/** What a record's pipeline items are called: Episode, Track, Day, or the project itself. */
export const leafLabel = (key: CategoryKey): string => {
  const c = categoryOf(key);
  return c.leafLevel === 2 ? (c.grandchildLevelLabel ?? "Item") : c.leafLevel === 1 ? (c.childLevelLabel ?? "Item") : c.singular;
};

/** The shoot date is a show date for live days, which are streamed rather than shot. */
export const shootDateLabel = (key: CategoryKey): string => (key === "live" ? "Show date" : "Shoot date");

export const finalStageOf = (key: CategoryKey): StageDef => {
  const st = categoryOf(key).stages;
  return st[st.length - 1];
};

/** Maps old music stage names to the current pipeline, for data saved before the change. */
export const MUSIC_STAGE_MAP: Record<string, string> = {
  Idea: "Idea",
  Writing: "Idea",
  "Pre-production": "Pre-production",
  Recording: "Recording",
  Mixing: "Audio post-production",
  Mastering: "Audio post-production",
  Delivered: "Publish",
};
