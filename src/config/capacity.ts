import type { CategoryKey } from "../types";

// How much of a person's working time each stage takes, in person-days, when they have nothing else on.
// The series editorial figure is a rule of thumb from the production team: finishing a cut, which means
// adding B-roll and working through the notes from the picture-lock review, takes at least two days.
// The others are starting estimates and can be changed in Settings.
//
// Series, devotions and documentaries also have the five-stage workflow's per-episode stages: the edit in Post
// production (the editor) and the release work in Marketing and distribution (the producer). A devotion's figure is
// for one day's episode; a documentary's is for the film.
export const DEFAULT_STAGE_EFFORT: Record<CategoryKey, Record<string, number>> = {
  series: {
    Idea: 0.5,
    Scripting: 2,
    "Pre-production": 1.5,
    Ingest: 0.5,
    Editorial: 2,
    Review: 0.5,
    Delivered: 0.5,
    "Post production": 2,
    "Marketing and distribution": 0.5,
  },
  devotional: {
    Creation: 0.3,
    Guest: 1.5,
    "Prep/Scripting": 1,
    Recording: 0.5,
    Editing: 1,
    Review: 0.3,
    Published: 0.2,
    "Post production": 1,
    "Marketing and distribution": 0.3,
  },
  general: { "In use": 0 },
  live: { Development: 0.5, "Pre-production": 2.5, Production: 1.5, "Post production": 1.5, "Marketing and distribution": 0.5 },
  documentary: {
    Idea: 1,
    Research: 3,
    "Pre-production": 2,
    Ingest: 1,
    Editorial: 5,
    Review: 1,
    Delivered: 0.5,
    "Post production": 5,
    "Marketing and distribution": 1,
  },
  music: { Development: 0.5, "Pre-production": 1, Production: 1, "Post production": 4.5, "Marketing and distribution": 0.5 },
};

/** The workflow's stages that are measured per episode, shown in Settings under each category that runs it. */
export const EPISODE_EFFORT_STAGES = ["Post production", "Marketing and distribution"] as const;

export const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];

export const effortKey = (category: CategoryKey, stage: string): string => `${category}:${stage}`;

/** Person-days a stage needs. Filming, recording and streaming stages are counted as shoot days instead. */
export function effortFor(category: CategoryKey, stage: string, overrides: Record<string, number> = {}): number {
  return overrides[effortKey(category, stage)] ?? DEFAULT_STAGE_EFFORT[category]?.[stage] ?? 0.5;
}

/** Load as a share of a working day. */
export const LOAD_BANDS = { ok: 0.5, busy: 0.85, over: 1.0001 };
export const HORIZON_DAYS = 28;
