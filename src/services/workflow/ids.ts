import { getDb } from "../../data/store";
import {
  claimId,
  codeNumber,
  episodeCode,
  episodeCounter,
  plannedCounter,
  plannedEpisodeId,
  sessionCode,
  sessionCounter,
} from "../../data/ids";
import { episodeTokenOf, sessionTokenOf } from "../../config/categories";
import { getRecord } from "../access";

// New codes for a project's sessions, planned episodes and episodes. Each comes from a counter that every
// browser is sent, and never from the highest number on screen alone, so a number is never given twice, even
// for something archived. The browser and the server must agree on each one (claimId, src/data/ids.ts).

/** The letters of a project's session and episode codes: R and E, or a live event's D and R, or a song's T. */
export const sessionToken = (projectId: string): string => {
  const p = getRecord(projectId);
  return p ? sessionTokenOf(p.category) : "R";
};
export const episodeToken = (projectId: string): string => {
  const p = getRecord(projectId);
  return p ? episodeTokenOf(p.category) : "E";
};

function next(key: string, used: number[]): number {
  const db = getDb();
  const n = Math.max(db.counters[key] ?? 0, ...used.filter((x) => !Number.isNaN(x))) + 1;
  db.counters[key] = n;
  return n;
}

export function nextSession(projectId: string): { id: string; n: number } {
  const used = getDb()
    .recordingSessions.filter((s) => s.contentId === projectId)
    .map((s) => s.sessionNumber);
  const n = next(sessionCounter(projectId), used);
  return { id: claimId(sessionCode(projectId, n, sessionToken(projectId))), n };
}

export function nextPlanned(projectId: string): { id: string; n: number } {
  const used = getDb()
    .plannedEpisodes.filter((p) => p.contentId === projectId)
    .map((p) => p.episodeNumber);
  const n = next(plannedCounter(projectId), used);
  return { id: claimId(plannedEpisodeId(projectId, n)), n };
}

/** The next episode of a project. Episodes made before the workflow count too, so numbering carries on from them. */
export function nextEpisode(projectId: string): { id: string; n: number } {
  const db = getDb();
  const token = episodeToken(projectId);
  const used = [
    ...db.records.filter((r) => r.parentId === projectId).map((r) => r.episode?.episodeNumber ?? codeNumber(r.contentId, projectId, token)),
    // Codes already given out ahead of recording count too.
    ...db.plannedEpisodes.filter((p) => p.contentId === projectId && p.reservedId).map((p) => codeNumber(p.reservedId!, projectId, token)),
  ];
  const n = next(episodeCounter(projectId), used);
  return { id: claimId(episodeCode(projectId, n, token)), n };
}
