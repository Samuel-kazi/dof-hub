// The parts of the rework (build prompt v2), each switched on or off for the whole workspace by the Head of Production
// in Settings. A part ships on; switching it off goes back to how things were, without touching any data. A part not
// built yet stays off whatever is stored.

export const FEATURES = [
  { key: "shell", label: "New menu, Settings in the profile menu, Ctrl+K search", built: true },
  { key: "reviewNotGate", label: "Theological review as a reminder, not a gate", built: true },
  { key: "recordingPlanAll", label: "Recording Plan for series and documentaries", built: false },
  { key: "templates", label: "Storyboard and shot list templates in Documents", built: false },
  { key: "lending", label: "Equipment lending and role kits", built: false },
  { key: "calendar2", label: "New Calendar with reminders, alerts and the urgency report", built: false },
  { key: "liveFiveStages", label: "Live Shows and DOF Music on the five stages", built: false },
] as const;

export type FeatureKey = (typeof FEATURES)[number]["key"];
export const FEATURE_KEYS = FEATURES.map((f) => f.key) as FeatureKey[];
