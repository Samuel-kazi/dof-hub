import { useEffect } from "react";
import type { AccentKey, Density, FontPairingKey, FontSize } from "../types";
import { ACCENTS, FONT_PAIRINGS, FONT_SIZES } from "../config/appearance";
import type { Theme } from "./theme";

const hasDom = typeof document !== "undefined";

/** rgba() of a hex colour, for the soft accent tint the way styles.css already builds it. */
function softTint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Puts the person's appearance choices onto <html> as CSS custom properties, so every view picks
 * them up through the same tokens it already uses (--accent, --font-heading, --sp-panel-y, …).
 * Mounted once, near the app root, and re-applied whenever the theme or a choice changes.
 */
export function useApplyAppearance(opts: { theme: Theme; accent: AccentKey; fontPairing: FontPairingKey; fontSize: FontSize; density: Density }): void {
  const { theme, accent, fontPairing, fontSize, density } = opts;
  useEffect(() => {
    if (!hasDom) return;
    const root = document.documentElement;
    const a = ACCENTS.find((x) => x.key === accent) ?? ACCENTS[0];
    const vals = theme === "light" ? a.light : a.dark;
    root.style.setProperty("--accent", vals.accent);
    root.style.setProperty("--accent-hi", vals.hi);
    root.style.setProperty("--accent-soft", softTint(vals.accent, theme === "light" ? 0.12 : 0.2));
  }, [theme, accent]);

  useEffect(() => {
    if (!hasDom) return;
    const f = FONT_PAIRINGS.find((x) => x.key === fontPairing) ?? FONT_PAIRINGS[0];
    document.documentElement.style.setProperty("--font-heading", f.heading);
    document.documentElement.style.setProperty("--font-body", f.body);
  }, [fontPairing]);

  useEffect(() => {
    if (!hasDom) return;
    const scale = FONT_SIZES.find((x) => x.key === fontSize)?.scale ?? 1;
    document.documentElement.style.setProperty("--font-scale", String(scale));
  }, [fontSize]);

  useEffect(() => {
    if (!hasDom) return;
    document.documentElement.dataset.density = density;
  }, [density]);
}
