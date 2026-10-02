import type { Actor, PlannedEpisode } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { logAudit } from "../audit";
import { textOf } from "../html";
import { nextEpisode, nextPlanned } from "../workflow/ids";
import { formOf } from "../workflow/common";
import { documentOf } from "./pages";
import { nowStamp, pagesOf, projectForWrite } from "./common";

// A devotion's writers type every devotion they will record as a page of its Devotional Script, in Development: a
// title, the scripture, and the script. In Pre-production those pages become the list of separate episodes, by
// title and theme, and each is given its Content ID there and then ({projectId}-E01, -E02, …). The episode itself is
// made under that same ID when the session that records it closes, so the ID never changes.

export interface DevotionList {
  made: string[]; // planned episodes made from new pages
  updated: string[]; // titles or scriptures brought up to date from their pages
  episodes: { plannedId: string; contentId: string; title: string }[];
}

/** Makes, or brings up to date, the list of a devotion's episodes from its script. Running it again only adds pages written since. */
export function makeDevotionEpisodes(actor: Actor, projectId: string): DevotionList {
  const p = projectForWrite(actor, projectId);
  if (p.workflow.formType !== "devotion") throw new RuleError("Only a devotion makes its episodes from its script.");
  if (p.workflow.stage !== "Pre-production") throw new RuleError("The episodes are listed in Pre-production, once the script is accepted.");
  const script = documentOf(projectId, "Development", "devotional_script");
  const pages = script ? pagesOf(script.id).filter((pg) => pg.title.trim() || textOf(pg.bodyHtml)) : [];
  if (!pages.length) throw new RuleError("The Devotional Script has no devotions written yet.");
  const db = getDb();
  const theme = String(formOf(projectId).sections.entry?.theme ?? "");
  const out: DevotionList = { made: [], updated: [], episodes: [] };
  const at = nowStamp();
  let reserved = 0;
  for (const page of pages) {
    let planned = db.plannedEpisodes.find((x) => x.contentId === projectId && x.sourcePageId === page.id);
    const title = page.title.trim() || `Devotion ${pages.indexOf(page) + 1}`;
    if (!planned) {
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
    } else if (planned.workingTitle !== title || planned.details.scripture !== page.subtitle) {
      planned.workingTitle = title;
      planned.details = { ...planned.details, scripture: page.subtitle };
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
