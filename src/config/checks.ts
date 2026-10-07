import type { WorkflowStage } from "../types";

// The Checks panel's rules (build prompt v4, section 14A), kept here so they change without code: where each check's
// "Go to" lands. The checks themselves come from the one gate evaluator (src/services/workflow/gates.ts and the
// documents' hard gates); this only says where to fix each.

/** Where "Go to" lands: a document of the project (its stage and catalogue key), and/or an element on the page. */
export interface CheckGo {
  doc?: { stage: WorkflowStage; key: string };
  anchor?: string; // an element id on the page the check is shown on
}

/** A Development hard gate's key, and the document it is fixed in ("brief": the kind's own brief). */
export const GATE_GO: Record<string, CheckGo> = {
  idea: { doc: { stage: "Development", key: "brief" } },
  greenlight: { doc: { stage: "Development", key: "greenlight" } },
  review: { doc: { stage: "Development", key: "theological_review" } },
  guest: { doc: { stage: "Development", key: "accept_decline" } },
  pages: { doc: { stage: "Development", key: "devotional_script" } },
  consent: { doc: { stage: "Development", key: "consent" } },
  date: { doc: { stage: "Development", key: "show_days" } },
  producer: { doc: { stage: "Development", key: "greenlight" } },
};

/** The checks given as sentences: the first rule whose pattern matches says where it is fixed. */
export const TEXT_GO: { match: RegExp; go: CheckGo }[] = [
  { match: /^Roles?\b|needs a person|^A show producer/, go: { doc: { stage: "Pre-production", key: "recording_plan" } } },
  { match: /not assigned to a session|planned for this session/, go: { doc: { stage: "Pre-production", key: "recording_plan" } } },
  { match: /Second greenlight/, go: { doc: { stage: "Development", key: "greenlight" } } },
  { match: /^Tech Check/, go: { doc: { stage: "Pre-production", key: "tech_check" } } },
  { match: /call sheet|Call sheet|Gear/, go: { anchor: "session-call-sheet" } },
  { match: /session's date|The session's date/, go: { anchor: "recording-day" } },
  { match: /drive|backup|offloaded|offline|full$/, go: { anchor: "rl-storage" } },
  { match: /take mark|item recorded|Recording Log/, go: { anchor: "rl-recorded" } },
  { match: /review link|ready for review/, go: { anchor: "episode-links" } },
  { match: /review checkpoint/, go: { anchor: "episode-reviews" } },
  { match: /distribution link|Release plan/, go: { anchor: "episode-release" } },
  { match: /Theological review/, go: { doc: { stage: "Development", key: "theological_review" } } },
];

/** A Development nudge or a check given as a sentence: where to go, if a rule says. */
export function goForText(text: string): CheckGo | null {
  return TEXT_GO.find((r) => r.match.test(text))?.go ?? null;
}
