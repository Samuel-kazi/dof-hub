import type { Actor, DocumentPage, PlannedEpisode } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { logAudit } from "../audit";
import { textOf } from "../html";
import { nextEpisode, nextPlanned } from "../workflow/ids";
import { formOf } from "../workflow/common";
import { decideGreenlight } from "../workflow/forms";
import { advanceProject } from "../workflow/projects";
import { todayIso } from "../utils";
import { documentOf } from "./pages";
import { newDocumentsOn, nowStamp, pagesOf, projectForWrite } from "./common";

// A devotion's writers type every devotion they will record as a page of its Devotional Script, in Development: its
// topic (the page's title), the scripture, and the script. In Pre-production those pages become the list of separate
// episodes, each by its own topic under the theme every devotion shares, and each is given its Content ID there and
// then ({projectId}-E01, -E02, …). The episode itself is made under that same ID when the session that records it
// closes, so the ID never changes.

export interface DevotionList {
  made: string[]; // planned episodes made from new pages
  updated: string[]; // titles or scriptures brought up to date from their pages
  episodes: { plannedId: string; contentId: string; title: string }[];
}

// A page counts once something is written on it (its script, its scripture or a title of its own), or once the move
// from the earlier form wrote it. The starting pages ("Devotion 3", empty) do not.
const countsAsDevotion = (pg: DocumentPage): boolean =>
  textOf(pg.bodyHtml) !== "" || pg.subtitle.trim() !== "" || pg.version > 1 || pg.updatedBy === "migration";

/** Makes, or brings up to date, the list of a devotion's episodes from its script. Running it again only adds pages written since. */
export function makeDevotionEpisodes(actor: Actor, projectId: string): DevotionList {
  const p = projectForWrite(actor, projectId);
  if (p.workflow.formType !== "devotion") throw new RuleError("Only a devotion makes its episodes from its script.");
  if (p.workflow.stage !== "Pre-production") throw new RuleError("The episodes are listed in Pre-production, once the script is accepted.");
  const script = documentOf(projectId, "Development", "devotional_script");
  const pages = script ? pagesOf(script.id).filter(countsAsDevotion) : [];
  if (!pages.length) throw new RuleError("The Devotional Script has no devotions written yet.");
  const db = getDb();
  // One theme for every devotion, set once in the devotion's entry; each devotion has its own topic (its page's title).
  const theme = String(formOf(projectId).sections.entry?.theme ?? "").trim();
  const out: DevotionList = { made: [], updated: [], episodes: [] };
  const at = nowStamp();
  let reserved = 0;
  // Days already listed on the earlier form, not yet tied to a page: each page takes the next one, in order, so a day is
  // never listed twice and keeps its Content ID. Anything a page replaces is kept in the day's notes.
  const earlier = db.plannedEpisodes
    .filter((x) => x.contentId === projectId && !x.archivedAt && !x.sourcePageId)
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
  for (const page of pages) {
    let planned = db.plannedEpisodes.find((x) => x.contentId === projectId && x.sourcePageId === page.id);
    const title = page.title.trim() || `Devotion ${pages.indexOf(page) + 1}`;
    const day = planned ? undefined : earlier.shift();
    if (day) {
      const scripture = page.subtitle.trim() || String(day.details.scripture ?? "");
      const replaced = [
        day.workingTitle.trim() && day.workingTitle !== title ? `Title on the earlier form: ${day.workingTitle}` : "",
        day.details.scripture && day.details.scripture !== scripture
          ? `Scripture on the earlier form: ${String(day.details.scripture)}`
          : "",
        theme && day.question.trim() && day.question !== theme ? `Question on the earlier form: ${day.question}` : "",
      ].filter(Boolean);
      Object.assign(day, {
        sourcePageId: page.id,
        workingTitle: title,
        question: theme || day.question,
        details: { ...day.details, scripture },
        notes: [day.notes, ...replaced].filter(Boolean).join("\n"),
        updatedAt: at,
      });
      planned = day;
      out.updated.push(day.id);
    } else if (!planned) {
      const { id, n } = nextPlanned(projectId);
      const made: PlannedEpisode = {
        id,
        contentId: projectId,
        episodeNumber: n,
        workingTitle: title,
        question: theme,
        guest: String(formOf(projectId).sections.guest?.name ?? ""),
        notes: "",
        details: { scripture: page.subtitle },
        reservedId: null,
        sourcePageId: page.id,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        archivedReason: null,
      };
      db.plannedEpisodes.push(made);
      planned = made;
      out.made.push(id);
    } else if (planned.workingTitle !== title || planned.details.scripture !== page.subtitle || (theme && planned.question !== theme)) {
      planned.workingTitle = title;
      planned.details = { ...planned.details, scripture: page.subtitle };
      if (theme) planned.question = theme; // the shared theme, if it has changed since
      planned.updatedAt = at;
      out.updated.push(planned.id);
    }
    // Its Content ID, given now and kept: the episode is made under it when it is recorded.
    const recorded = db.records.find((r) => r.episode?.plannedEpisodeId === planned!.id && !r.archived);
    if (!planned.reservedId && !recorded) {
      planned.reservedId = nextEpisode(projectId).id;
      reserved++;
    }
    out.episodes.push({ plannedId: planned.id, contentId: recorded?.contentId ?? planned.reservedId!, title });
  }
  if (out.made.length || out.updated.length || reserved) {
    logAudit(actor, "devotion-episodes", "record", projectId, `${out.made.length} listed, ${out.updated.length} updated from the script`);
    commit();
  }
  return out;
}

/**
 * Accepts a devotion, once its hard gates are met or passed by hand (./gates.ts): the decision is recorded, the devotion
 * moves to Pre-production, and its devotions are listed from the script, each with its Content ID. One change: all of
 * it, or none. Declining is the greenlight decision "Decline", which closes and archives it with the reason.
 */
export function acceptDevotion(actor: Actor, projectId: string, note: string): DevotionList {
  const p = projectForWrite(actor, projectId);
  if (p.workflow.formType !== "devotion") throw new RuleError("Only a devotion is accepted this way.");
  if (!newDocumentsOn("devotion"))
    throw new RuleError("Devotions are accepted from their Development form while their documents are not in use.");
  decideGreenlight(actor, projectId, { outcome: "Greenlight", notes: note, date: todayIso() });
  advanceProject(actor, projectId);
  logAudit(actor, "devotion-accepted", "record", projectId, note.trim() ? `Accepted. ${note.trim()}` : "Accepted");
  const script = documentOf(projectId, "Development", "devotional_script");
  const written = script ? pagesOf(script.id).filter(countsAsDevotion) : [];
  return written.length ? makeDevotionEpisodes(actor, projectId) : { made: [], updated: [], episodes: [] };
}
