// ── Dates ────────────────────────────────────────────────────
// A date is a plain YYYY-MM-DD string, and "today" is today in Nairobi, wherever the code runs: in a browser
// abroad, or on the server, whose clock is on UTC. Dates are never made by turning a moment into UTC and
// cutting off the time (toISOString().slice(0, 10)), which gives yesterday between midnight and 03:00 here.

export const TIME_ZONE = "Africa/Nairobi";
/** Nairobi keeps East Africa Time all year, with no daylight saving. */
const NAIROBI_OFFSET = "+03:00";

const nairobiDay = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The date in Nairobi at a given moment. */
export const dateInNairobi = (at: Date): string => {
  const parts = nairobiDay.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const nairobiClock = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The time in Nairobi at a given moment, as HH:MM (a live show's actual start and end). */
export const timeInNairobi = (at: Date): string => {
  const parts = nairobiClock.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
};

/** Today's date in Nairobi. */
export const todayIso = (): string => dateInNairobi(new Date());

/** A date a number of days from another, by the calendar alone. */
export const addDaysIso = (iso: string, days: number): string => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); // a UTC midnight, so no hours to lose
};

/** A real calendar date written YYYY-MM-DD. */
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return addDaysIso(s, 0) === s; // 2026-02-30 comes back as 2026-03-02
};

export const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

/** Whole days from today to the given date. Negative means the date has passed. */
export const daysUntil = (iso: string): number => dayNumber(iso) - dayNumber(todayIso());

/** Hours from now to the end of the given day in Nairobi (deadlines are due end-of-day). */
export const hoursUntilEndOfDay = (iso: string): number => {
  const end = Date.parse(`${iso.slice(0, 10)}T23:59:59${NAIROBI_OFFSET}`);
  return (end - Date.now()) / 3600000;
};

export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "Not set";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

export const fmtShort = (iso: string | null | undefined): string => {
  if (!iso) return "Not set";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export const relativeDays = (iso: string): string => {
  const n = daysUntil(iso);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
};

export const pad = (n: number, width = 3): string => String(n).padStart(width, "0");

export const fromDayNumber = (n: number): string => new Date(n * 86400000).toISOString().slice(0, 10);

/** 1200 becomes "1.20 TB", 350 becomes "350 GB". */
export const fmtSize = (gb: number): string => (gb >= 1000 ? `${(gb / 1000).toFixed(2)} TB` : `${Math.round(gb)} GB`);

/** The time of a moment in Nairobi, as hh:mm. */
export const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE });
export const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Copies only the listed keys that are present. Every "update" function runs its patch through this, so a
 * request can only ever change the fields that function is meant to change. TypeScript types alone do not
 * do this: they are gone by the time the server runs, and the server receives whatever the request sent.
 */
export function pickKeys<T extends object, K extends keyof T>(patch: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  if (!patch || typeof patch !== "object") return out;
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined) out[k] = patch[k];
  return out;
}

/** A photo stored on the server (see server/layout.ts). Signed in to the server, photos are links of this form. */
export const STORED_FILE = /^\/api\/file\?id=[a-f0-9]{32}$/;
/** A picture the desktop app keeps in its media folder: media:<project>/<file>. Only the path is stored. */
export const MEDIA_FILE = /^media:[A-Za-z0-9-]{1,80}\/[A-Za-z0-9_-]{1,80}\.(jpg|png|webp)$/;
