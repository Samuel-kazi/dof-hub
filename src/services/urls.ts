import { RuleError } from "../types";

// Links people paste in: review links, final file links, distribution links. Only web links are accepted, so a
// link can never run code (javascript:), read a file on someone's computer (file:), or carry data that looks like
// a page (data:). Every link is checked here when it is saved, and again before the app sends anyone to it.

const MAX_LENGTH = 2048;

/** The link as a normalised web address, or null if it is not an http or https link to a named host. */
export function asWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_LENGTH) return null;
  // Spaces and control characters are never part of a real link, and some browsers drop them silently,
  // which is how "java\tscript:" gets past a naive check.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null; // https://user:pass@host hides where a link really goes
  return url.href;
}

export const isWebUrl = (value: unknown): boolean => asWebUrl(value) !== null;

/** The link, checked. Empty is allowed when `optional`, and means "no link". */
export function requireWebUrl(value: string, what: string, optional = false): string {
  if (optional && value.trim() === "") return "";
  const url = asWebUrl(value);
  if (!url) throw new RuleError(`${what} must be a web link starting with http:// or https://.`);
  return url;
}
