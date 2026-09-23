import type { CategoryKey } from "../types";

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
  stages: StageDef[];
  // The level that carries the pipeline: 0 for a flat project, 1 for a live show's days, 2 for episodes and tracks.
  leafLevel: number;
  // From this stage on there is footage to store, so the item prompts for a drive.
  footageStage: string;
  // The one place this category's colour is defined. Every view that renders a category (Kanban
  // cards, the calendar, dashboard charts) reads it from here rather than choosing its own.
  color: string;
}

const s = (name: string, requiredOutput: string, extra: { tasks?: string[]; docs?: string[] } = {}): StageDef => ({ name, requiredOutput, ...extra });

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
  },
  {
    key: "live",
    label: "Live Shows",
    singular: "Live show",
    code: "LIVE",
    color: "#f3b943",
    supportsChildren: true,
    childLevelLabel: "Day",
    grandchildLevelLabel: "Day",
    childToken: "D",
    grandchildToken: "D",
    // A show can run for one day or several. Each day is its own item with its own pipeline, call sheet and run of show.
    stages: [
      s("Prep", "Gear tested and packed", { docs: ["run-of-show"] }),
      s("Build", "Rig built and safety-checked"),
      s("Rehearse", "Camera, audio and stream checks passed"),
      s("Show", "Stream completed"),
      s("Wrap", "Strike checklist complete"),
      s("Review", "Stream review notes"),
      s("Post Production", "Archive and clips exported", { docs: ["analysis"] }),
    ],
    footageStage: "Show",
    leafLevel: 1,
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
  },
  {
    key: "music",
    label: "DOF Music",
    singular: "Music project",
    code: "MUS",
    color: "#d58fb8",
    supportsChildren: true,
    childLevelLabel: "Album",
    grandchildLevelLabel: "Track",
    childToken: "A",
    grandchildToken: "T",
    stages: [
      s("Idea", "Approved concept and lyrics", { docs: ["concept"] }),
      s("Pre-production", "Session plan", { docs: ["music-plan"] }),
      // Recording is tracked as two parts, so audio and video each have an owner and a date.
      s("Recording", "Audio and video recorded", { tasks: ["Audio recording", "Video recording"] }),
      s("Audio post-production", "Approved mix and master", { tasks: ["Mixing", "Mastering"] }),
      s("Video editing", "Finished edit", { tasks: EDIT_TASKS, docs: ["edit-notes"] }),
      s("Review", "Approved cut"),
      s("Publish", "Published, with final link", { docs: ["analysis"] }),
    ],
    footageStage: "Recording",
    leafLevel: 2,
  },
];

export const categoryOf = (key: CategoryKey): CategoryConfig => {
  const c = CATEGORIES.find((x) => x.key === key);
  if (!c) throw new Error(`Unknown category ${key}`);
  return c;
};

/** The single source of truth for a category's colour. No view should hardcode or pick its own. */
export const categoryColor = (key: CategoryKey): string => categoryOf(key).color;

/** What a record's pipeline items are called: Episode, Track, Day, or the project itself. */
export const leafLabel = (key: CategoryKey): string => {
  const c = categoryOf(key);
  return c.leafLevel === 2 ? c.grandchildLevelLabel ?? "Item" : c.leafLevel === 1 ? c.childLevelLabel ?? "Item" : c.singular;
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
