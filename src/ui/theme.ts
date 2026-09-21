import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "dof-theme";
const listeners = new Set<() => void>();
const hasDom = typeof window !== "undefined" && typeof document !== "undefined";

export function getPref(): ThemePref {
  try {
    const v = hasDom ? localStorage.getItem(KEY) : null;
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const systemTheme = (): Theme => (hasDom && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
export const resolveTheme = (pref: ThemePref): Theme => (pref === "system" ? systemTheme() : pref);

/** Puts the theme on <html> so every colour token switches at once. */
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
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch { /* keep working without saving */ }
  applyTheme(pref);
  listeners.forEach((l) => l());
}

// Follow the operating system while the choice is "system".
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
