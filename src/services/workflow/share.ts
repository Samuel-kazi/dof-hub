import type { Actor, ShareLink } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { localId, logId } from "../../data/ids";
import { canWrite, getRecord } from "../access";
import { logAudit } from "../audit";
import { asWebUrl } from "../urls";
import { episodeForWrite, nowStamp, type Episode } from "./common";

// Share links: a link to one episode's hosted file that can be sent to someone outside the app.
//
// On the hosted site, the link is {site}/share/{token}. The token is 128 random bits made by the server alone
// (server/router.ts), never by a browser and never derived from the episode, so it cannot be guessed. Opening the
// link sends the person to the episode's file and shows nothing else. A link can be revoked, and made again.
//
// The desktop app has no server anyone else can reach, so there it records the share and copies the file's own
// hosted link instead. Either way, only a file hosted somewhere reachable (Google Drive, YouTube or similar) can
// be shared: a path on one computer cannot.

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{22}$/;
export const NO_HOSTED_FILE = "Attach a hosted file link first.";

/** Where an episode's share link leads: its final file if it has one, otherwise its review link. Web links only. */
export const shareTarget = (ep: Episode): string | null => asWebUrl(ep.episode.finalFileLink) ?? asWebUrl(ep.episode.reviewLink);

function newShare(actor: Actor, episodeId: string, token: string | null, note: string): ShareLink {
  const { ep } = episodeForWrite(actor, episodeId);
  const target = shareTarget(ep);
  if (!target) throw new RuleError(NO_HOSTED_FILE);
  if (note.length > 500) throw new RuleError("Keep the note under 500 characters.");
  const link: ShareLink = {
    id: token ? logId("SL") : localId("SL"),
    episodeId,
    token,
    targetUrl: target,
    createdById: actor.personId,
    createdAt: nowStamp(),
    revokedAt: null,
    sharedWithNote: note.trim(),
  };
  getDb().shareLinks.push(link);
  return link;
}

/**
 * Records a share link with a token the server made. Never offered to browsers (see scripts/gen-wrapped.mjs):
 * only POST /api/share-links calls it. With `replaces`, that link is revoked in the same step (Regenerate).
 */
export function recordShareLink(actor: Actor, episodeId: string, token: string, note = "", replaces: string | null = null): ShareLink {
  if (!SHARE_TOKEN.test(token)) throw new Error("A share token must be 22 URL-safe characters.");
  if (replaces) revokeIn(actor, replaces, episodeId);
  const link = newShare(actor, episodeId, token, note);
  logAudit(actor, "share-link", "record", episodeId, replaces ? `made again (replacing ${replaces})` : "made");
  commit();
  return link;
}

/** The desktop app's share: records it and returns the hosted file's own link, for the screen to copy. */
export function copyShareLink(actor: Actor, episodeId: string, note = ""): ShareLink {
  const link = newShare(actor, episodeId, null, note);
  logAudit(actor, "share-link", "record", episodeId, "hosted link copied");
  commit();
  return link;
}

function revokeIn(actor: Actor, linkId: string, episodeId?: string): ShareLink {
  const link = getDb().shareLinks.find((l) => l.id === linkId);
  if (!link || (episodeId && link.episodeId !== episodeId)) throw new RuleError("Share link not found.");
  episodeForWrite(actor, link.episodeId);
  if (!link.revokedAt) link.revokedAt = nowStamp();
  return link;
}

/** Stops a share link working. It is kept, with when it was revoked. */
export function revokeShareLink(actor: Actor, linkId: string): ShareLink {
  const link = revokeIn(actor, linkId);
  logAudit(actor, "share-link", "record", link.episodeId, `revoked ${linkId}`);
  commit();
  return link;
}

/** Who may make or revoke an episode's share links: anyone who may change the episode. */
export const canShare = (actor: Actor, episodeId: string): boolean => {
  const ep = getRecord(episodeId);
  const project = ep?.parentId ? getRecord(ep.parentId) : undefined;
  return !!ep?.episode && !!project && canWrite(actor, project) && !ep.archived && !project.archived;
};

/**
 * Where a share token leads now, or null: an unknown or revoked token, an archived episode or project, or an
 * episode with no hosted file. Only the token's own episode is ever looked at.
 */
export function resolveShareToken(token: string): string | null {
  if (!SHARE_TOKEN.test(token)) return null;
  const link = getDb().shareLinks.find((l) => l.token === token);
  if (!link || link.revokedAt) return null;
  const ep = getRecord(link.episodeId);
  const project = ep?.parentId ? getRecord(ep.parentId) : undefined;
  if (!ep?.episode || ep.archived || !project || project.archived) return null;
  return shareTarget(ep as Episode);
}
