import type { ProductionLevel } from "../types";

export const PRODUCTION_LEVELS: { key: ProductionLevel; label: string; hint: string }[] = [
  { key: "small", label: "Small", hint: "One camera or a phone stream, one operator." },
  { key: "medium", label: "Medium", hint: "Two or three cameras, a small crew." },
  { key: "large", label: "Large", hint: "Full broadcast with a full crew. The call sheet needs a run of the show." },
];

export const levelLabel = (l: ProductionLevel | null): string => PRODUCTION_LEVELS.find((x) => x.key === l)?.label ?? "Not set";
