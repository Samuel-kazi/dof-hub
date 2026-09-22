import type { AccentKey, Density, FontPairingKey, FontSize } from "../types";

// Personalisation options. Curated, not free-form, so the app always looks like one considered
// design rather than whatever colour or font someone happened to pick.

export interface AccentDef {
  key: AccentKey;
  label: string;
  // Matches the --accent / --accent-hi / --accent-soft tokens in styles.css for dark and light mode.
  dark: { accent: string; hi: string };
  light: { accent: string; hi: string };
}

export const ACCENTS: AccentDef[] = [
  { key: "terracotta", label: "Terracotta", dark: { accent: "#e8703a", hi: "#f28a55" }, light: { accent: "#dc5f26", hi: "#c2481a" } },
  { key: "amber", label: "Amber", dark: { accent: "#d9a441", hi: "#e8bd66" }, light: { accent: "#b9812a", hi: "#96660f" } },
  { key: "sage", label: "Sage", dark: { accent: "#6b9080", hi: "#87ac9c" }, light: { accent: "#4d7566", hi: "#365a4d" } },
  { key: "ocean", label: "Ocean", dark: { accent: "#4f7cac", hi: "#6f9bc9" }, light: { accent: "#3a6389", hi: "#254a6b" } },
  { key: "plum", label: "Plum", dark: { accent: "#a15c8f", hi: "#bd7cac" }, light: { accent: "#8a4576", hi: "#6c2e5b" } },
  { key: "slate", label: "Slate", dark: { accent: "#5b6472", hi: "#77828f" }, light: { accent: "#454d59", hi: "#2f3540" } },
];

export const accentOf = (key: AccentKey): AccentDef => ACCENTS.find((a) => a.key === key) ?? ACCENTS[0];

export interface FontPairingDef {
  key: FontPairingKey;
  label: string;
  heading: string;
  body: string;
}

// Web-safe stacks only, on purpose: the Hub runs as a desktop app that can't always reach a font
// CDN, so a pairing has to look right offline, every time, on macOS and Windows alike.
export const FONT_PAIRINGS: FontPairingDef[] = [
  { key: "modern", label: "Modern", heading: `"Avenir Next", "SF Pro Display", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif`, body: `"Avenir Next", "SF Pro Display", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif` },
  { key: "editorial", label: "Editorial", heading: `Georgia, "Iowan Old Style", "Palatino Linotype", serif`, body: `"Avenir Next", "SF Pro Display", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif` },
  { key: "classic", label: "Classic Serif", heading: `Georgia, "Iowan Old Style", "Palatino Linotype", serif`, body: `Georgia, "Iowan Old Style", "Times New Roman", serif` },
];

export const fontPairingOf = (key: FontPairingKey): FontPairingDef => FONT_PAIRINGS.find((f) => f.key === key) ?? FONT_PAIRINGS[0];

export const FONT_SIZES: { key: FontSize; label: string; scale: number }[] = [
  { key: "small", label: "Small", scale: 0.9 },
  { key: "default", label: "Default", scale: 1 },
  { key: "large", label: "Large", scale: 1.15 },
  { key: "xl", label: "XL", scale: 1.3 },
];

export const fontScaleOf = (key: FontSize): number => FONT_SIZES.find((f) => f.key === key)?.scale ?? 1;

export const DENSITIES: { key: Density; label: string }[] = [
  { key: "comfortable", label: "Comfortable" },
  { key: "compact", label: "Compact" },
];
