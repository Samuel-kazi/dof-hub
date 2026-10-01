export const todayIso = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

/** Whole days from today to the given date. Negative means the date has passed. */
export const daysUntil = (iso: string): number => dayNumber(iso) - dayNumber(todayIso());

/** Hours from now to the end of the given day (deadlines are due end-of-day). */
export const hoursUntilEndOfDay = (iso: string): number => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const end = new Date(y, m - 1, d, 23, 59, 59).getTime();
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
