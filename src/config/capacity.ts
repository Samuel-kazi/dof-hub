import type { CategoryKey } from "../types";

// How much of a person's working time each stage takes, in person-days, when they have nothing else on.
// The series editorial figure is a rule of thumb from the production team: finishing a cut, which means
// adding B-roll and working through the notes from the picture-lock review, takes at least two days.
// The others are starting estimates and can be changed in Settings.
export const DEFAULT_STAGE_EFFORT: Record<CategoryKey, Record<string, number>> = {
  series: { Idea: 0.5, Scripting: 2, "Pre-production": 1.5, Ingest: 0.5, Editorial: 2, Review: 0.5, Delivered: 0.5 },
  devotional: { Idea: 0.5, Scripting: 1, Editorial: 1, Review: 0.5, Delivered: 0.5 },
  live: { Idea: 0.5, Scripting: 1, Review: 0.5, "Post Production": 1 },
  documentary: { Idea: 1, Research: 3, "Pre-production": 2, Ingest: 1, Editorial: 5, Review: 1, Delivered: 0.5 },
  music: { Idea: 0.5, "Pre-production": 1, "Audio post-production": 2, "Video editing": 2, Review: 0.5, Publish: 0.5 },
};

export const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];

export const effortKey = (category: CategoryKey, stage: string): string => `${category}:${stage}`;

/** Person-days a stage needs. Filming, recording and streaming stages are counted as shoot days instead. */
export function effortFor(category: CategoryKey, stage: string, overrides: Record<string, number> = {}): number {
  return overrides[effortKey(category, stage)] ?? DEFAULT_STAGE_EFFORT[category]?.[stage] ?? 0.5;
}

/** Load as a share of a working day. */
export const LOAD_BANDS = { ok: 0.5, busy: 0.85, over: 1.0001 };
export const HORIZON_DAYS = 28;
