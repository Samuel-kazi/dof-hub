import { useState } from "react";
import type { DistributionEntry, DistributionStatus } from "../../types";
import { categoryOf } from "../../config/categories";
import { getDb } from "../../data/store";
import { createShareLinkRemote, isRemote } from "../../data/remote";
import { canWrite } from "../../services/access";
import { getBreadcrumb } from "../../services/wrapped/content";
import { nameOf } from "../../services/wrapped/people";
import {
  addDistribution,
  approveReleasePlan,
  copyShareLink,
  episodeOverdue,
  evaluateGate,
  moveToMarketing,
  NO_HOSTED_FILE,
  publishEpisode,
  removeDistribution,
  revokeShareLink,
  sendForReview,
  setEpisodeEditor,
  setEpisodeLinks,
  setLearningNotes,
  setReadyForReview,
  setWorkflowDeadline,
  shareTarget,
  startEditing,
  updateDistribution,
  type Episode,
  type Project,
} from "../../services/wrapped/workflow";
import { asWebUrl } from "../../services/urls";
import { fmtDateTime } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { useReviewCheck } from "../../ui/ReviewCheck";
import { Empty, Field } from "../../ui/parts";
import { CrewSelect, GatePanel, OpenLinkButton, copyText, shareUrlOf } from "../../ui/workflow/shared";
import { CheckpointCard, ConfigChecklist, useDraft } from "./common";
import { EpisodeAssets } from "./StorageFields";

// One episode, from the moment its session closes: Post production (editing, the rough cut and final reviews) and
// Marketing and distribution (the release plan, publishing, learning notes), with its review and share links.

const stageLabel = (ep: Episode) =>
  ep.episode.stage === "Post production"
    ? `Post production: ${ep.episode.postStage}`
    : ep.episode.mdStage === "Published"
      ? "Published"
      : `Marketing and distribution: ${ep.episode.mdStage}`;

/** A link field that checks the link, saves it, and opens it in the person's own browser. */
function LinkField({
  label,
  value,
  disabled,
  onSave,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onSave: (v: string) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  const bad = draft.trim() !== "" && !asWebUrl(draft);
  return (
    <Field label={label}>
      <div className="wf-chips">
        <input
          type="url"
          style={{ flex: "1 1 260px" }}
          value={draft}
          placeholder="https://"
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={bad}
        />
        {!disabled && (
          <button className="btn small" disabled={bad || draft === value} onClick={() => onSave(draft)}>
            Save
          </button>
        )}
        <OpenLinkButton url={value}>Open</OpenLinkButton>
      </div>
      {bad && <small className="wf-error">Only web links starting with http:// or https:// are accepted.</small>}
    </Field>
  );
}

function ShareLinks({ ep, write }: { ep: Episode; write: boolean }) {
  const { actor, attempt, toast, confirm } = useApp();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const links = getDb().shareLinks.filter((l) => l.episodeId === ep.contentId);
  const target = shareTarget(ep);
  const remote = isRemote();
  const make = async (replaces: string | null = null) => {
    setBusy(true);
    setError("");
    try {
      const r = await createShareLinkRemote(ep.contentId, note, replaces);
      setNote("");
      await copyText(r.url, toast, "Share link");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The share link could not be made.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="glass panel" aria-label="Share links">
      <h2>Share links</h2>
      <p className="muted">
        {remote
          ? "A share link takes whoever opens it straight to this episode's hosted file: the final file if there is one, otherwise the review link. It shows nothing else."
          : "This copy of the app has no address other people can reach, so sharing copies the file's own hosted link."}
      </p>
      {!target ? (
        <div className="banner warn">{NO_HOSTED_FILE} A file on one computer cannot be shared: use Google Drive, YouTube or similar.</div>
      ) : (
        write && (
          <div className="row" style={{ alignItems: "end" }}>
            <Field label="Who it is for, and when (optional)">
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div style={{ flex: "none" }}>
              {remote ? (
                <button className="btn primary" disabled={busy} onClick={() => void make()}>
                  {busy ? "Making the link…" : "Make a share link"}
                </button>
              ) : (
                <button
                  className="btn primary"
                  onClick={() => {
                    const link = attempt(() => copyShareLink(actor, ep.contentId, note));
                    if (link) {
                      setNote("");
                      void copyText(link.targetUrl, toast, "Hosted link");
                    }
                  }}
                >
                  Copy the hosted link
                </button>
              )}
            </div>
          </div>
        )
      )}
      {error && <div className="banner bad">{error}</div>}
      {links.length === 0 ? (
        <Empty>No share links yet.</Empty>
      ) : (
        <div className="list">
          {[...links].reverse().map((l) => (
            <div key={l.id} className="list-item">
              <div className="grow">
                <div className="title">{shareUrlOf(l)}</div>
                <span className="muted">
                  {l.token ? "Share link" : "Hosted link, copied"} by {nameOf(l.createdById)}, {fmtDateTime(l.createdAt)}
                  {l.sharedWithNote ? `. ${l.sharedWithNote}` : ""}
                  {l.revokedAt ? `. Revoked ${fmtDateTime(l.revokedAt)}.` : ""}
                </span>
              </div>
              {!l.revokedAt && (
                <>
                  <button className="btn small" onClick={() => void copyText(shareUrlOf(l), toast, "Link")}>
                    Copy
                  </button>
                  {write && l.token && remote && (
                    <button className="btn small" disabled={busy} onClick={() => void make(l.id)}>
                      Make again
                    </button>
                  )}
                  {write && (
                    <button
                      className="btn small ghost"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: "Revoke this link?",
                            body: "Anyone who has it can no longer open the file through it.",
                            confirmLabel: "Revoke",
                            danger: true,
                          })
                        )
                          attempt(() => revokeShareLink(actor, l.id), "Revoked");
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DistributionRow({ ep, d, write }: { ep: Episode; d: DistributionEntry; write: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const [draft, setDraft, dirty, saved] = useDraft({ platform: d.platform, status: d.status, link: d.link, date: d.date });
  return (
    <tr>
      <td>
        <input
          type="text"
          aria-label="Platform"
          value={draft.platform}
          disabled={!write}
          onChange={(e) => setDraft({ ...draft, platform: e.target.value })}
        />
      </td>
      <td>
        <select
          aria-label="Status"
          value={draft.status}
          disabled={!write}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as DistributionStatus })}
        >
          {(["Planned", "Scheduled", "Published"] as const).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="url"
          aria-label="Link"
          value={draft.link}
          disabled={!write}
          onChange={(e) => setDraft({ ...draft, link: e.target.value })}
        />
      </td>
      <td>
        <input
          type="date"
          aria-label="Date"
          value={draft.date ?? ""}
          disabled={!write}
          onChange={(e) => setDraft({ ...draft, date: e.target.value || null })}
        />
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <OpenLinkButton url={d.link}>Open</OpenLinkButton>
        {write && (
          <>
            <button
              className="btn small"
              disabled={!dirty}
              onClick={() => attempt(() => updateDistribution(actor, ep.contentId, d.id, draft), "Saved") && saved()}
            >
              Save
            </button>
            <button
              className="btn small ghost"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Remove ${d.platform}?`,
                    body: "This entry comes off the episode's distribution log.",
                    confirmLabel: "Remove",
                    danger: true,
                  })
                )
                  attempt(() => removeDistribution(actor, ep.contentId, d.id), "Removed");
              }}
            >
              Remove
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

function Distribution({ ep, write }: { ep: Episode; write: boolean }) {
  const { actor, attempt } = useApp();
  const [platform, setPlatform] = useState("");
  const [status, setStatus] = useState<DistributionStatus>("Planned");
  const [link, setLink] = useState("");
  const add = () => {
    if (attempt(() => addDistribution(actor, ep.contentId, { platform, status, link, date: null }), "Added")) {
      setPlatform("");
      setLink("");
    }
  };
  return (
    <section className="glass panel" aria-label="Distribution">
      <h2>Distribution</h2>
      {ep.episode.distribution.length === 0 ? (
        <Empty>No platforms logged yet. At least one link is needed before it is published.</Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table wf-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Status</th>
                <th>Link</th>
                <th>Date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ep.episode.distribution.map((d) => (
                <DistributionRow key={d.id} ep={ep} d={d} write={write} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {write && (
        <div className="row" style={{ alignItems: "end", marginTop: 10 }}>
          <Field label="Platform">
            <input type="text" value={platform} placeholder="YouTube" onChange={(e) => setPlatform(e.target.value)} />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as DistributionStatus)}>
              <option>Planned</option>
              <option>Scheduled</option>
              <option>Published</option>
            </select>
          </Field>
          <Field label="Link">
            <input type="url" value={link} placeholder="https://" onChange={(e) => setLink(e.target.value)} />
          </Field>
          <div style={{ flex: "none" }}>
            <button className="btn primary" disabled={!platform.trim()} onClick={add}>
              Add
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function EpisodePage({ ep, project }: { ep: Episode; project: Project }) {
  const { actor, go, attempt, confirm } = useApp();
  const [reviewCheck, reviewModal] = useReviewCheck();
  const [learning, setLearning] = useState<string | null>(null);
  const write = canWrite(actor, project) && !project.archived && !ep.archived;
  const info = ep.episode;
  const crumbs = getBreadcrumb(ep.contentId);
  const inPost = info.stage === "Post production";
  const form = getDb().developmentForms.find((f) => f.contentId === project.contentId);
  const measures = form?.sections.brief?.successMeasures;
  const deadline = (stage: "Post production" | "Marketing and distribution") => (
    <Field label={`${stage} deadline`}>
      <input
        type="date"
        value={ep.stageDeadlines[stage] ?? ""}
        disabled={!write}
        onChange={(e) => attempt(() => setWorkflowDeadline(actor, ep.contentId, stage, e.target.value || null))}
      />
    </Field>
  );
  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => go({ n: "pipeline", category: project.category })}>{categoryOf(project.category).label}</button>
        {crumbs.map((c, i) => (
          <span key={c.contentId}>
            <span aria-hidden> / </span>
            {i === crumbs.length - 1 ? (
              <span>{c.title}</span>
            ) : (
              <button onClick={() => go({ n: "record", id: c.contentId })}>{c.title}</button>
            )}
          </span>
        ))}
      </nav>
      <div className="page-head">
        <div className="grow">
          <h1>{ep.title}</h1>
          <div className="wf-chips" style={{ marginTop: 4 }}>
            <span className="cid">{ep.contentId}</span>
            <span className={`badge ${info.mdStage === "Published" ? "ok" : "accent"}`}>{stageLabel(ep)}</span>
            {episodeOverdue(ep) && <span className="badge bad">Overdue</span>}
            {info.sourceSessionId && (
              <button className="btn small ghost" onClick={() => go({ n: "session", id: info.sourceSessionId! })}>
                From {info.sourceSessionId}
              </button>
            )}
            {info.plannedEpisodeId && <span className="muted">Planned as {info.plannedEpisodeId}</span>}
          </div>
        </div>
      </div>
      {ep.archived && <div className="banner bad">Archived: {ep.closedReason}</div>}

      <section className="glass panel" aria-label="Production notes">
        <h2>Production notes</h2>
        {info.productionNotes ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{info.productionNotes}</p>
        ) : (
          <Empty>No notes came from the session log.</Empty>
        )}
      </section>

      <section className="glass panel" aria-label="Post production">
        <h2>Post production</h2>
        <div className="row" style={{ alignItems: "end" }}>
          <Field label="Editor">
            <CrewSelect
              label="Editor"
              value={info.editorId}
              disabled={!write}
              onChange={(p) => attempt(() => setEpisodeEditor(actor, ep.contentId, p), p ? `Editor: ${nameOf(p)}` : "Editor removed")}
            />
          </Field>
          {deadline("Post production")}
          {deadline("Marketing and distribution")}
        </div>
        <LinkField
          label="Review link (for example an unlisted upload)"
          value={info.reviewLink}
          disabled={!write}
          onSave={(v) => !!attempt(() => setEpisodeLinks(actor, ep.contentId, { reviewLink: v }), "Review link saved")}
        />
        <LinkField
          label="Final file link (hosted)"
          value={info.finalFileLink}
          disabled={!write}
          onSave={(v) => !!attempt(() => setEpisodeLinks(actor, ep.contentId, { finalFileLink: v }), "Final file link saved")}
        />
        <EpisodeAssets ep={ep} project={project} write={write} />
        {info.sendBackReason && info.postStage === "Editing" && (
          <div className="banner warn">Sent back from review: {info.sendBackReason}</div>
        )}
        {inPost && info.postStage === "Not started" && write && (
          <button className="btn primary" onClick={() => attempt(() => startEditing(actor, ep.contentId), "Editing started")}>
            Start editing
          </button>
        )}
        {inPost && info.postStage === "Editing" && (
          <label className="check" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={info.readyForReview}
              disabled={!write}
              onChange={(e) => attempt(() => setReadyForReview(actor, ep.contentId, e.target.checked))}
            />
            <span>The editor marks this cut ready for review</span>
          </label>
        )}
      </section>

      {inPost && info.postStage === "Editing" && (
        <GatePanel
          title="Send for review"
          gate={evaluateGate("Editing", "episode", ep.contentId)}
          action="Send for review"
          disabled={!write}
          onDone={() => attempt(() => sendForReview(actor, ep.contentId), "Sent for review")}
        />
      )}

      <section className="glass panel" aria-label="Reviews">
        <h2>Theological review</h2>
        <div className="grid-2">
          <CheckpointCard
            id={`${ep.contentId}|rough_cut`}
            canChooseReviewers={write}
            decideHint={info.postStage === "Rough cut review" ? undefined : "Decided when the episode is in Rough cut review."}
          />
          <CheckpointCard
            id={`${ep.contentId}|final`}
            canChooseReviewers={write}
            decideHint={info.postStage === "Final review" ? undefined : "Decided when the episode is in Final review."}
          />
        </div>
      </section>

      {inPost && <ConfigChecklist title="Post production work" listKey="post" ownerId={ep.contentId} disabled={!write} />}

      {inPost && (
        <GatePanel
          title="Leave Post production"
          gate={evaluateGate("Post production", "episode", ep.contentId)}
          action="Done: move to Marketing and distribution"
          disabled={!write}
          onDone={async () => {
            if (
              await confirm({
                title: "Move to Marketing and distribution?",
                body: "Post production is finished for this episode. It cannot move back.",
                confirmLabel: "Move on",
              })
            )
              attempt(() => moveToMarketing(actor, ep.contentId), "Moved to Marketing and distribution");
          }}
        />
      )}

      {!inPost && (
        <>
          <ConfigChecklist title="Release plan and publishing" listKey="release" ownerId={ep.contentId} disabled={!write} />
          {info.mdStage === "Release plan" && write && (
            <button
              className="btn"
              onClick={() => attempt(() => approveReleasePlan(actor, ep.contentId), "Release plan approved: scheduled")}
            >
              Approve the release plan
            </button>
          )}
          <Distribution ep={ep} write={write} />
          {info.mdStage !== "Published" && (
            <GatePanel
              title="Publish"
              gate={evaluateGate("Marketing and distribution", "episode", ep.contentId)}
              action="Done: published"
              disabled={!write}
              onDone={async () => {
                // Before the theological review is done, the question about it is the confirmation.
                const ok = await reviewCheck({
                  contentId: ep.contentId,
                  action: "publish-episode",
                  targetId: ep.contentId,
                  confirmLabel: "Publish anyway",
                  deliberate: true,
                });
                if (!ok) return;
                if (
                  !ok.asked &&
                  !(await confirm({
                    title: `Mark ${ep.contentId} published?`,
                    body: "It is logged as published. When every planned episode is published, the project is complete.",
                    confirmLabel: "Published",
                    deliberate: true,
                  }))
                )
                  return;
                if (attempt(() => publishEpisode(actor, ep.contentId), "Published")) ok.done();
              }}
            />
          )}
          <section className="glass panel" aria-label="Learning notes">
            <h2>Learning notes</h2>
            {typeof measures === "string" && measures && (
              <p className="muted">
                The brief's success measures: <i>{measures}</i>
              </p>
            )}
            <textarea
              aria-label="Learning notes"
              value={learning ?? info.learningNotes}
              disabled={!write}
              onChange={(e) => setLearning(e.target.value)}
              onBlur={() => {
                if (
                  learning !== null &&
                  learning !== info.learningNotes &&
                  attempt(() => setLearningNotes(actor, ep.contentId, learning), "Learning notes saved")
                )
                  setLearning(null);
              }}
            />
          </section>
        </>
      )}

      <ShareLinks ep={ep} write={write} />
      {reviewModal}
    </div>
  );
}
