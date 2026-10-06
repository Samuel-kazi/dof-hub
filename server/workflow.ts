import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ShareLink } from "../src/types";
import { applyReviewWindows, recordShareLink, resolveShareToken, reviewWindowsDue } from "../src/services/workflow";
import { recurringDue, topUpRecurring } from "../src/services/production";
import { asWebUrl } from "../src/services/urls";
import { todayIso } from "../src/services/utils";
import type { Authed } from "./accounts";
import { loadDb, mutateState, withDb } from "./state";
import type { Store } from "./stores";

// The parts of the five-stage workflow only the server can do: make share link tokens and follow them, and the
// daily check that moves projects whose review window has passed to Hold.

/** 128 bits from the operating system's secure random source, written as 22 URL-safe characters. */
export const newShareToken = (): string => randomBytes(16).toString("base64url");

/** The address share links start with: PUBLIC_BASE_URL if it is set, otherwise the address the request came to. */
export function shareBase(origin: string): string {
  const configured = asWebUrl(process.env.PUBLIC_BASE_URL ?? "");
  return (configured ?? origin).replace(/\/+$/, "");
}

/** Makes a share link for an episode, or makes one again in place of `replaces`. */
export async function createShareLink(
  store: Store,
  who: Authed,
  origin: string,
  input: { episodeId: string; note: string; replaces: string | null },
): Promise<{ link: ShareLink; url: string }> {
  const token = newShareToken();
  const { result } = await mutateState(store, () => recordShareLink(who.actor, input.episodeId, token, input.note, input.replaces));
  return { link: result, url: `${shareBase(origin)}/share/${token}` };
}

/**
 * Follows a share link: a 302 to the episode's hosted file, or a short "not available" page. Nothing else about the
 * app, the episode or the project is shown, and the reply is never cached or indexed.
 */
export async function followShareLink(store: Store, token: string, res: ServerResponse): Promise<void> {
  const loaded = await loadDb(store);
  const target = loaded ? withDb(loaded.db, () => resolveShareToken(token)) : null;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (target) {
    res.statusCode = 302;
    res.setHeader("Location", target);
    res.end();
    return;
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("This link is not available. It may have been withdrawn. Ask the person who sent it for a new one.");
}

// ── Once a day ───────────────────────────────────────────────

const checkedOn = new WeakMap<Store, string>();

/**
 * Moves projects whose review window has passed with no decision to Hold. Runs the first time each server sees a
 * request on a new day in Nairobi, and from the daily cron (vercel.json). Writes only when something is due, so a
 * second run, on this server or another, does nothing. A failure is logged and never stops the request it rode on.
 */
export async function dailyChecks(store: Store, force = false): Promise<string[]> {
  const today = todayIso();
  if (!force && checkedOn.get(store) === today) return [];
  try {
    const loaded = await loadDb(store);
    if (!loaded) return [];
    let moved: string[] = [];
    if (withDb(loaded.db, () => reviewWindowsDue(today))) moved = (await mutateState(store, () => applyReviewWindows(today))).result;
    // Recurring shows: the coming days of each, up to its horizon, and gear booked for days within two weeks.
    if (withDb(loaded.db, () => recurringDue(today))) {
      const made = (await mutateState(store, () => topUpRecurring(today))).result;
      if (made.made || made.booked) console.info(`Recurring shows: ${made.made} days made, ${made.booked} items of gear booked`);
    }
    checkedOn.set(store, today);
    if (moved.length) console.info(`Review windows passed: moved to Hold ${moved.join(", ")}`);
    return moved;
  } catch (e) {
    console.error("The daily check failed", e);
    return [];
  }
}
