import type { UrgencyThresholds } from "../types";

// The urgency report's rules are plain and fixed (src/services/urgency.ts); these are their numbers. The Head of
// Production can change them in Settings (stored in settings.urgency), so they change without code.

export const DEFAULT_URGENCY: UrgencyThresholds = {
  soonHours: 24,
  dueHours: 48,
  noRecordingDays: 14,
  loanOverdueHighDays: 7,
};

export const URGENCY_LEVELS = ["Critical", "High", "Watch", "On track"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];
