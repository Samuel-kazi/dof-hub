import { getDb } from "../../data/store";
import { episodesOf, type Project } from "./common";

/**
 * A project is Completed when every planned episode has been published (a documentary without planned parts:
 * when its film is published), and Active again if something new is planned after that. Called after anything
 * that can change the answer; the caller saves.
 */
export function refreshProjectStatus(p: Project): void {
  if (p.archived || p.workflow.stage !== "Pre-production") return;
  const eps = episodesOf(p.contentId);
  const planned = getDb().plannedEpisodes.filter((x) => x.contentId === p.contentId && !x.archivedAt);
  const published = (plannedId: string) => eps.some((e) => e.episode.plannedEpisodeId === plannedId && e.episode.mdStage === "Published");
  const done = eps.length > 0 && eps.every((e) => e.episode.mdStage === "Published") && planned.every((x) => published(x.id));
  const next = done ? "Completed" : "Active";
  if (p.workflow.status !== next) {
    p.workflow.status = next;
    p.version += 1;
  }
}
