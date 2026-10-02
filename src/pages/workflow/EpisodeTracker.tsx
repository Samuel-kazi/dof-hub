import { getDb } from "../../data/store";
import { episodeOverdue, episodesOf, plannedOf, shareTarget, type Project } from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { Empty } from "../../ui/parts";
import { OpenLinkButton, copyText, shareUrlOf } from "../../ui/workflow/shared";

// The episode tracker: one row per episode, each moving through Post production and Marketing and distribution
// on its own. A row opens the episode.

const stageText = (e: { stage: string; postStage: string; mdStage: string }) =>
  e.stage === "Post production" ? `Post: ${e.postStage}` : e.mdStage === "Published" ? "Published" : `Marketing: ${e.mdStage}`;

export function EpisodeTracker({ project }: { project: Project }) {
  const { go, toast } = useApp();
  const eps = episodesOf(project.contentId);
  const archived = episodesOf(project.contentId, true).length - eps.length;
  const planned = plannedOf(project.contentId);
  const waiting = planned.filter((p) => !eps.some((e) => e.episode.plannedEpisodeId === p.id));
  const shares = getDb().shareLinks.filter((l) => !l.revokedAt);
  return (
    <section className="glass panel" aria-label="Episode tracker">
      <div className="wf-head">
        <h2>Episode tracker</h2>
        <span className="muted">
          {eps.length} episode{eps.length === 1 ? "" : "s"}
          {planned.length ? `, ${waiting.length} planned and not yet recorded` : ""}
          {archived ? `, ${archived} archived` : ""}
        </span>
      </div>
      {eps.length === 0 ? (
        <Empty>
          {project.workflow.formType.startsWith("documentary")
            ? "The film's episode is made when it is sent to post production, after a session closes."
            : "Episodes are made when a recording session closes."}
        </Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Episode</th>
                <th>Title</th>
                <th>Source session</th>
                <th>Stage</th>
                <th>Rough cut reviewed</th>
                <th>Final reviewed</th>
                <th>Review link</th>
                <th>Share link</th>
              </tr>
            </thead>
            <tbody>
              {eps.map((e) => {
                const share = shares.find((l) => l.episodeId === e.contentId);
                const target = shareTarget(e);
                return (
                  <tr
                    key={e.contentId}
                    className="clickable"
                    tabIndex={0}
                    onClick={() => go({ n: "record", id: e.contentId })}
                    onKeyDown={(ev) => ev.key === "Enter" && go({ n: "record", id: e.contentId })}
                  >
                    <td className="cid">{e.contentId}</td>
                    <td>{e.title}</td>
                    <td className="cid">{e.episode.sourceSessionId ?? <span className="muted">None</span>}</td>
                    <td>
                      <span className={`badge ${e.episode.mdStage === "Published" ? "ok" : "accent"}`}>{stageText(e.episode)}</span>
                      {episodeOverdue(e) && (
                        <span className="badge bad" style={{ marginLeft: 6 }}>
                          Overdue
                        </span>
                      )}
                    </td>
                    <td>
                      {e.episode.roughCutStatus === "Done" ? (
                        <span className="badge ok">Done</span>
                      ) : (
                        <span className="muted">Pending</span>
                      )}
                    </td>
                    <td>
                      {e.episode.finalReviewStatus === "Done" ? (
                        <span className="badge ok">Done</span>
                      ) : (
                        <span className="muted">Pending</span>
                      )}
                    </td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <OpenLinkButton url={e.episode.reviewLink}>Open</OpenLinkButton>
                    </td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      {share ? (
                        <button className="btn small" onClick={() => void copyText(shareUrlOf(share), toast, "Share link")}>
                          Copy
                        </button>
                      ) : target ? (
                        <button className="btn small ghost" onClick={() => go({ n: "record", id: e.contentId })}>
                          Make one
                        </button>
                      ) : (
                        <span className="muted" title="Attach a hosted file link first.">
                          No hosted file
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
