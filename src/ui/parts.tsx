import { useSyncExternalStore } from "react";
import type { Person, Settings } from "../types";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const ACCENT_OPTIONS = {
  terracotta: { label: "Terracotta", value: "#dc5f26", hi: "#c2481a", soft: "rgba(220, 95, 38, 0.14)" },
  rose: { label: "Rosewood", value: "#b65b78", hi: "#933f5f", soft: "rgba(182, 91, 120, 0.14)" },
  gold: { label: "Gold", value: "#c9952f", hi: "#ab7a16", soft: "rgba(201, 149, 47, 0.14)" },
  sage: { label: "Sage", value: "#5e8c70", hi: "#487459", soft: "rgba(94, 140, 112, 0.14)" },
  slate: { label: "Slate", value: "#60728c", hi: "#47596d", soft: "rgba(96, 114, 140, 0.14)" },
} as const;

export const FONT_OPTIONS = {
  modern: { label: "Modern", family: '"Avenir Next", "Segoe UI", sans-serif' },
  serif: { label: "Serif", family: 'Georgia, "Times New Roman", serif' },
  editorial: { label: "Editorial", family: '"Trebuchet MS", "Segoe UI", sans-serif' },
} as const;

export const FONT_SIZE_OPTIONS = {
  small: { label: "Small", px: 14 },
  default: { label: "Default", px: 15 },
  large: { label: "Large", px: 16 },
  xl: { label: "XL", px: 17 },
} as const;

export const DEFAULT_WORKSPACE_APPEARANCE = { accentColor: "terracotta", fontPairing: "modern" } as const;
export const DEFAULT_PERSON_APPEARANCE = { fontSize: "default", density: "comfortable", photoUrl: null } as const;

const THEME_KEY = "dof-theme";
const listeners = new Set<() => void>();
const hasDom = typeof window !== "undefined" && typeof document !== "undefined";

export function getPref(): ThemePref {
  try {
    const v = hasDom ? localStorage.getItem(THEME_KEY) : null;
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const systemTheme = (): Theme => (hasDom && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
export const resolveTheme = (pref: ThemePref): Theme => (pref === "system" ? systemTheme() : pref);

export function applyTheme(pref: ThemePref = getPref()): Theme {
  const t = resolveTheme(pref);
  if (hasDom) {
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
  }
  return t;
}

export function setPref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch { /* keep working without saving */ }
  applyTheme(pref);
  listeners.forEach((l) => l());
}

if (hasDom && typeof window.matchMedia === "function") {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if (getPref() === "system") {
      applyTheme("system");
      listeners.forEach((l) => l());
    }
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void; toggle: () => void } {
  const pref = useSyncExternalStore(subscribe, getPref, () => "system" as ThemePref);
  const theme = resolveTheme(pref);
  return { pref, theme, setPref, toggle: () => setPref(theme === "dark" ? "light" : "dark") };
}

export function applyAppearance(person: Person | null | undefined, settings?: Settings | null): void {
  if (!hasDom) return;
  const workspace = settings?.workspaceAppearance ?? DEFAULT_WORKSPACE_APPEARANCE;
  const accent = ACCENT_OPTIONS[workspace.accentColor] ?? ACCENT_OPTIONS.terracotta;
  const font = FONT_OPTIONS[workspace.fontPairing] ?? FONT_OPTIONS.modern;
  const size = FONT_SIZE_OPTIONS[person?.appearance?.fontSize ?? "default"] ?? FONT_SIZE_OPTIONS.default;
  const density = person?.appearance?.density ?? "comfortable";

  document.documentElement.style.setProperty("--accent", accent.value);
  document.documentElement.style.setProperty("--accent-hi", accent.hi);
  document.documentElement.style.setProperty("--accent-soft", accent.soft);
  document.documentElement.style.setProperty("--btn-a", accent.value);
  document.documentElement.style.setProperty("--btn-b", accent.hi);
  document.documentElement.style.setProperty("--font-ui", font.family);
  document.documentElement.style.setProperty("--base-font-size", `${size.px}px`);
  document.documentElement.style.fontSize = `${size.px}px`;
  document.body.style.fontFamily = font.family;
  document.body.dataset.density = density;
}
