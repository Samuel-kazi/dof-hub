import type { Actor, Database, RoleCode } from "../types";
import { RuleError } from "../types";
import { setDb, setPersist } from "./store";
import { setRpcSink, type Call } from "./rpc";

// The app has two ways to run. On your computer with nothing behind it, it is a demo that keeps sample
// data in the browser. On the real site it signs in to the server, which holds the data, decides who
// may see and do what, and answers every change. This file is the second way.

export interface SessionUser { personId: string; role: RoleCode; name: string; username: string; mustChange: boolean }
export interface SessionInfo { needsSetup: boolean; user: SessionUser | null; google: { available: boolean }; unavailable?: string }

let remote = false;
export const isRemote = (): boolean => remote;

/** What the app does when the server says something is wrong. The screens fill these in. */
export const syncEvents = { onError: (_message: string): void => {}, onSignedOut: (): void => {} };

export class ApiError extends RuleError {
  constructor(message: string, public code?: string, public status?: number) { super(message); }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T & { ok: true }> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError("The server could not be reached. Check your connection and try again.", "offline");
  }
  const json = (await res.json().catch(() => null)) as ({ ok: boolean; error?: string; code?: string } & Record<string, unknown>) | null;
  if (!json || json.ok !== true) throw new ApiError(json?.error ?? (res.status === 404 ? "The server could not find that address (404). If you have just updated the site, wait a minute, refresh the page and try again." : `The server sent an answer the app could not read (status ${res.status}). Try again. If it keeps happening, look at the Vercel logs for this deployment.`), json?.code, res.status);
  return json as T & { ok: true };
}

export const api = {
  get: <T,>(path: string) => call<T>("GET", path),
  post: <T = Record<string, never>>(path: string, body: unknown = {}) => call<T>("POST", path, body),
};

/** Asks the server who is signed in. Returns null when there is no server, which means the local demo. */
export async function probe(): Promise<SessionInfo | null> {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const json = (await res.json()) as { remote?: boolean; ok?: boolean; error?: string } & SessionInfo;
    if (json?.remote !== true) return null; // no server behind this page: the local demo
    remote = true;
    // There is a server, but it could not do its job (for example, it cannot reach the database).
    // Never fall back to the demo here: that would show data that is not the real data.
    if (json.ok === false) return { needsSetup: false, user: null, google: { available: false }, unavailable: json.error ?? "The server is not answering properly. Try again in a minute." };
    return json;
  } catch {
    return null;
  }
}

// ── Keeping the screen and the server in step ────────────────

let revision = 0;
let queue: Call[] = [];
let running = false;
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(force = false): Promise<void> {
  try {
    const r = await api.get<{ unchanged?: boolean; revision: number; db?: Database }>(`/api/state?rev=${force ? 0 : revision}`);
    if (queue.length && !force) return; // the person changed something while this was on its way
    if (r.unchanged || !r.db) return;
    revision = r.revision;
    setDb(r.db);
  } catch (e) {
    if (e instanceof ApiError && (e.code === "signed-out" || e.code === "must-change")) syncEvents.onSignedOut();
  }
}

/** Sends the changes one at a time, in order. If the server refuses one, the screen goes back to what the server has. */
async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      try {
        await api.post("/api/action", queue[0]);
        queue.shift();
      } catch (e) {
        queue = [];
        if (e instanceof ApiError && e.code === "signed-out") { syncEvents.onSignedOut(); return; }
        syncEvents.onError(e instanceof Error ? e.message : "That change could not be saved.");
        await refresh(true);
        return;
      }
    }
    await refresh();
  } finally {
    running = false;
  }
}

const poll = (): void => { if (!running && !queue.length && document.visibilityState !== "hidden") void refresh(); };

/** Resolves once every change made on this screen has been sent to the server (or has failed and been undone). */
export async function whenSynced(): Promise<void> {
  while (running || queue.length) await new Promise((r) => setTimeout(r, 40));
}

export async function hydrate(): Promise<void> {
  const r = await api.get<{ revision: number; db: Database }>("/api/state");
  revision = r.revision;
  setDb(r.db);
}

export function startSync(): void {
  setPersist(false); // what the server sends stays off this computer's storage
  setRpcSink((c) => { queue.push(c); void pump(); }, "That is handled by the server.");
  timer = setInterval(poll, 15000);
  document.addEventListener("visibilitychange", poll);
}

export function stopSync(): void {
  setRpcSink(null);
  queue = [];
  if (timer) clearInterval(timer);
  document.removeEventListener("visibilitychange", poll);
}

export const actorOf = (u: SessionUser): Actor => ({ personId: u.personId, role: u.role });

export async function signOut(): Promise<void> {
  try { await api.post("/api/logout"); } catch { /* signed out on this device anyway */ }
  stopSync();
  window.location.reload(); // clears everything the server sent from memory
}
