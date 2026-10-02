import { useRef, useState, type ReactNode } from "react";
import type { DocumentPage, ProjectDocument, WorkflowStage } from "../../types";
import { catalogEntry, catalogFor, type CatalogEntry } from "../../config/documentCatalog";
import { WORKFLOW_STAGE_NAMES } from "../../config/workflow";
import { getDb, useDb } from "../../data/store";
import { textOf } from "../../services/html";
import {
  addPage,
  archivePage,
  documentHasContent,
  documentOf,
  ensureDocument,
  makeDevotionEpisodes,
  movePage,
  pagesOf,
  restorePage,
  storyboardsOf,
  shotListsOf,
} from "../../services/wrapped/documents";
import { plannedOf, sessionsOf, type Project } from "../../services/wrapped/workflow";
import { fmtDate } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Empty } from "../../ui/parts";
import { IconBack, IconCalendar, IconCam, IconCheck, IconDoc, IconDrive, IconFilm, IconSheet, IconUsers } from "../../ui/Icons";
import { DevelopmentTab } from "../workflow/Development";
import { PreProductionTab } from "../workflow/PreProduction";
import { EpisodeTracker } from "../workflow/EpisodeTracker";
import { CheckpointCard } from "../workflow/common";
import { LinksBox } from "./LinksBox";
import { PageEditor, type PageEditorHandle } from "./PageEditor";
import { usePrintDocument } from "./printDocument";

// A project's documents (the documents rework), StudioBinder style. Project Home has one coloured row per stage, each
// with tiles: a document, a tool (Storyboard, Shot List) or a form. A tile opens full width, in three panes: the
// stage's documents on the left, the open document's pages in the middle, and the page itself on the right. Stage tabs
// along the top jump between stages, and "Project home" comes back. Forms keep their screens and behaviour as before.

export interface Opened {
  stage: WorkflowStage;
  key: string;
}

const STAGE_CLASS: Record<WorkflowStage, string> = {
  Development: "dev",
  "Pre-production": "pre",
  Production: "prod",
  "Post production": "post",
  "Marketing and distribution": "mkt",
};

const KIND_TAG: Record<CatalogEntry["kind"], string> = { document: "", tool: "tool", form: "form", review: "review" };

function iconOf(entry: CatalogEntry): ReactNode {
  if (entry.kind === "document") return <IconDoc />;
  if (entry.kind === "review") return <IconCheck />;
  if (entry.tool === "storyboard") return <IconFilm />;
  if (entry.tool === "shotList") return <IconCam />;
  switch (entry.form) {
    case "sessions":
    case "recordingDayView":
      return <IconCalendar />;
    case "callSheet":
    case "sessionLog":
      return <IconSheet />;
    case "storage":
    case "archive":
      return <IconDrive />;
    case "roles":
    case "acceptDecline":
      return <IconUsers />;
    default:
      return <IconCheck />;
  }
}

/** Whether a tile's document or tool has something in it: worked out, never set by hand. */
function hasContent(project: Project, stage: WorkflowStage, entry: CatalogEntry): boolean {
  if (entry.kind === "document") {
    const doc = documentOf(project.contentId, stage, entry.key);
    return !!doc && documentHasContent(doc.id);
  }
  if (entry.tool === "storyboard") return storyboardsOf(project.contentId).length > 0;
  if (entry.tool === "shotList") return shotListsOf(project.contentId).length > 0;
  return false;
}

/** The subtitle under a page's title: a devotion's scripture, or a note. */
const subtitleLabelOf = (docKey: string) => (docKey === "devotional_script" ? "Scripture" : "Subtitle or note");

// ── Project Home ─────────────────────────────────────────────

export function ProjectHome({ project, onOpen }: { project: Project; onOpen: (stage: WorkflowStage, key: string) => void }) {
  const current = project.workflow.stage;
  return (
    <div className="pd-home" aria-label="Project home">
      {WORKFLOW_STAGE_NAMES.map((stage) => (
        <section key={stage} className={`pd-row st-${STAGE_CLASS[stage]}`} aria-label={stage}>
          <div className="pd-label">
            <span>{stage}</span>
            {stage === current && <span className="pd-now">Now</span>}
          </div>
          <div className="pd-tiles">
            {catalogFor(project.workflow.formType, stage).map((entry) => {
              const filled = hasContent(project, stage, entry);
              return (
                <button
                  key={entry.key}
                  className="pd-tile"
                  onClick={() => onOpen(stage, entry.key)}
                  aria-label={`${entry.title}${KIND_TAG[entry.kind] ? ` (${KIND_TAG[entry.kind]})` : ""}${filled ? ", has content" : ""}`}
                >
                  <span className="pd-tile-icon">{iconOf(entry)}</span>
                  <span className="pd-tile-name">{entry.title}</span>
                  {KIND_TAG[entry.kind] && <span className="pd-tag">{KIND_TAG[entry.kind]}</span>}
                  {filled && <span className="pd-dot" title="Has content" />}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── The pages of a document (middle pane) ────────────────────

function PageList({
  doc,
  pages,
  selected,
  write,
  onSelect,
}: {
  doc: ProjectDocument;
  pages: DocumentPage[];
  selected: string | null;
  write: boolean;
  onSelect: (pageId: string) => void;
}) {
  const { actor, attempt, confirm, menu } = useApp();
  const [dragging, setDragging] = useState<string | null>(null);
  const deleted = pagesOf(doc.id, true).filter((p) => p.archivedAt);
  const remove = async (p: DocumentPage) => {
    if (
      await confirm({
        title: `Delete "${p.title}"?`,
        body: "The page is taken out of the document and kept, archived. It can be restored from Deleted pages below.",
        confirmLabel: "Delete page",
        danger: true,
      })
    )
      attempt(() => archivePage(actor, p.id), "Page deleted. It can be restored.");
  };
  return (
    <div className="pd-pages">
      <ol aria-label={`Pages of ${doc.title}`}>
        {pages.map((p, i) => (
          <li
            key={p.id}
            className={`pd-card${p.id === selected ? " on" : ""}${dragging === p.id ? " dragging" : ""}`}
            draggable={write}
            onDragStart={(e) => {
              setDragging(p.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", p.id);
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => {
              if (dragging) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              setDragging(null);
              if (id && id !== p.id) attempt(() => movePage(actor, id, i));
            }}
          >
            <button className="pd-card-main" aria-current={p.id === selected ? "page" : undefined} onClick={() => onSelect(p.id)}>
              <span className="pd-card-num">{i + 1}</span>
              <span className="pd-card-text">
                <span className="pd-card-title">{p.title || "Untitled page"}</span>
                {p.subtitle && <span className="pd-card-sub">{p.subtitle}</span>}
                <span className="pd-card-snip">{textOf(p.bodyHtml).slice(0, 90) || "Nothing written yet"}</span>
              </span>
            </button>
            {write && (
              <button
                className="pd-card-menu"
                aria-label={`Options for page ${i + 1}, ${p.title || "Untitled page"}`}
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  menu({ clientX: r.left, clientY: r.bottom, preventDefault: () => {} }, [
                    { label: "Move up", disabled: i === 0, onClick: () => attempt(() => movePage(actor, p.id, i - 1)) },
                    { label: "Move down", disabled: i === pages.length - 1, onClick: () => attempt(() => movePage(actor, p.id, i + 1)) },
                    { label: "", divider: true, onClick: () => {} },
                    { label: "Delete page", danger: true, onClick: () => void remove(p) },
                  ]);
                }}
              >
                ⋮
              </button>
            )}
          </li>
        ))}
      </ol>
      {pages.length === 0 && <p className="muted">No pages. Add one to start writing.</p>}
      {write && (
        <button
          className="btn small pd-add"
          onClick={() => {
            const page = attempt(() => addPage(actor, doc.id, {}));
            if (page) onSelect(page.id);
          }}
        >
          + Add page
        </button>
      )}
      {deleted.length > 0 && (
        <details className="pd-deleted">
          <summary>Deleted pages ({deleted.length})</summary>
          <ul>
            {deleted.map((p) => (
              <li key={p.id}>
                <span className="grow">{p.title || "Untitled page"}</span>
                {write && (
                  <button className="btn small" onClick={() => attempt(() => restorePage(actor, p.id), "Page restored")}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── Forms: their screens as they were ────────────────────────

/** A devotion's episodes, made in Pre-production from its script's pages, each with its Content ID. */
function DevotionEpisodes({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt, toast } = useApp();
  const planned = plannedOf(project.contentId).filter((p) => !p.archivedAt);
  const recordedId = (plannedId: string) =>
    getDb().records.find((r) => r.episode?.plannedEpisodeId === plannedId && !r.archived)?.contentId ?? null;
  const pre = project.workflow.stage === "Pre-production";
  return (
    <section className="glass panel" aria-label="Devotions">
      <h2>Devotions</h2>
      <p className="muted">
        Each page of the Devotional Script becomes one devotion here, by its title and the project's theme, with its own Content ID. The ID
        never changes: the episode is made under it when its recording session closes.
      </p>
      {planned.length === 0 ? (
        <Empty>No devotions listed yet.</Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Content ID</th>
                <th>Devotion</th>
                <th>Scripture</th>
                <th>Theme</th>
              </tr>
            </thead>
            <tbody>
              {planned.map((p) => (
                <tr key={p.id}>
                  <td className="cid">{recordedId(p.id) ?? p.reservedId ?? p.id}</td>
                  <td>{p.workingTitle}</td>
                  <td>{String(p.details.scripture ?? "")}</td>
                  <td>{p.question}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {write && (
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn primary"
            disabled={!pre || project.archived}
            title={pre ? undefined : "The devotions are listed in Pre-production, once the script is accepted."}
            onClick={() => {
              const r = attempt(() => makeDevotionEpisodes(actor, project.contentId));
              if (r)
                toast(
                  r.made.length || r.updated.length
                    ? `${r.made.length} listed, ${r.updated.length} brought up to date from the script`
                    : "The list already matches the script",
                  "success",
                );
            }}
          >
            {planned.some((p) => p.sourcePageId) ? "Bring the list up to date from the script" : "List the devotions from the script"}
          </button>
        </div>
      )}
    </section>
  );
}

/** The project's sessions, each opening its own screen: run sheet, call sheet and recording day. */
function SessionShortcuts({ project, what }: { project: Project; what: "callSheet" | "recordingDay" }) {
  const { go } = useApp();
  const sessions = sessionsOf(project.contentId).filter((s) => !s.archivedAt);
  return (
    <section className="glass panel" aria-label={what === "callSheet" ? "Call sheets" : "Recording day"}>
      <h2>{what === "callSheet" ? "Call sheets" : "Recording day"}</h2>
      <p className="muted">
        {what === "callSheet"
          ? "A call sheet is made from its recording session, filled in from the session's date. It works as before."
          : "Each session's recording day: the run sheet, the log and the wrap, as before."}
      </p>
      {sessions.length === 0 ? (
        <Empty>No recording sessions yet. Schedule one under Recording Session in Pre-production.</Empty>
      ) : (
        <ul className="pd-session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="cid">{s.id}</span>
              <span className="grow">{s.scheduledDate ? fmtDate(s.scheduledDate) : "No date yet"}</span>
              {what === "callSheet" && s.callSheetId && (
                <button className="btn small" onClick={() => go({ n: "callsheet", id: s.callSheetId! })}>
                  Open call sheet
                </button>
              )}
              <button className="btn small" onClick={() => go({ n: "session", id: s.id })}>
                {what === "callSheet" ? (s.callSheetId ? "Open session" : "Make it from the session") : "Open recording day"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FormPane({ project, entry, write }: { project: Project; entry: CatalogEntry; write: boolean }) {
  const { go } = useApp();
  if (entry.kind === "review")
    return (
      <section className="glass panel" aria-label="Theological review">
        <h2>Theological Review</h2>
        <p className="muted">The review checkpoints, as before. Reviewing the document page by page comes in the next phase.</p>
        <div className="stack">
          {(["pitch", "outline_script"] as const).map((k) => (
            <CheckpointCard key={k} id={`${project.contentId}|${k}`} canChooseReviewers={write} />
          ))}
        </div>
      </section>
    );
  if (entry.kind === "tool")
    return <Empty>{entry.title} opens here in a later phase. Until then it is on the project's earlier screens.</Empty>;
  switch (entry.form) {
    case "acceptDecline":
      return (
        <div className="stack">
          <div className="banner">
            <span className="grow">
              Until the next phase, the guest, the review, the decision and the move to Pre-production are on the form below, as before.
            </span>
          </div>
          <DevelopmentTab project={project} write={write} />
        </div>
      );
    case "devotionEpisodes":
      return <DevotionEpisodes project={project} write={write} />;
    case "sessions":
    case "roles":
      return <PreProductionTab project={project} write={write} />;
    case "callSheet":
      return <SessionShortcuts project={project} what="callSheet" />;
    case "recordingDayView":
      return <SessionShortcuts project={project} what="recordingDay" />;
    case "review":
    case "episodeTracker":
      return <EpisodeTracker project={project} />;
    case "storage":
      return (
        <section className="glass panel" aria-label="Storage">
          <h2>Storage</h2>
          <p className="muted">Where the recordings are kept, on the Storage screen, as before.</p>
          <button className="btn" onClick={() => go({ n: "storage" })}>
            Open Storage
          </button>
        </section>
      );
    default:
      return <Empty>{entry.title} is on the project's earlier screens until a later phase.</Empty>;
  }
}

// ── An open document (three panes) ───────────────────────────

function DocumentView({
  project,
  opened,
  write,
  editor,
  leaveThen,
  onOpen,
  onHome,
}: {
  project: Project;
  opened: Opened;
  write: boolean;
  editor: React.MutableRefObject<PageEditorHandle | null>;
  leaveThen: (then: () => void) => void;
  onOpen: (stage: WorkflowStage, key: string) => void;
  onHome: () => void;
}) {
  const [pageId, setPageId] = useState<string | null>(null);
  const [print, printNode] = usePrintDocument();
  const formType = project.workflow.formType;
  const entries = catalogFor(formType, opened.stage);
  const entry = catalogEntry(formType, opened.stage, opened.key);
  const doc = entry?.kind === "document" ? documentOf(project.contentId, opened.stage, opened.key) : undefined;
  const pages = doc ? pagesOf(doc.id) : [];
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  const printJob = (only?: DocumentPage) => {
    if (!doc) return;
    leaveThen(() =>
      print({
        projectTitle: project.title,
        contentId: project.contentId,
        doc,
        pages: only ? [pagesOf(doc.id).find((p) => p.id === only.id)!] : pagesOf(doc.id),
      }),
    );
  };
  return (
    <div className="pd-open">
      <div className="pd-bar">
        <button className="btn small" onClick={onHome}>
          <IconBack /> Project home
        </button>
        <nav className="pd-stages" aria-label="Stages">
          {WORKFLOW_STAGE_NAMES.map((stage) => (
            <button
              key={stage}
              className={`pd-stage st-${STAGE_CLASS[stage]}${stage === opened.stage ? " on" : ""}`}
              aria-current={stage === opened.stage ? "true" : undefined}
              onClick={() => {
                const list = catalogFor(formType, stage);
                const first = list.find((e) => e.kind === "document") ?? list[0];
                if (first) onOpen(stage, first.key);
              }}
            >
              {stage}
            </button>
          ))}
        </nav>
      </div>
      <div className={`pd-panes${entry?.kind === "document" ? "" : " wide"}`}>
        <nav className={`pd-docs st-${STAGE_CLASS[opened.stage]}`} aria-label={`${opened.stage} documents`}>
          <h2>{opened.stage}</h2>
          <ul>
            {entries.map((e) => (
              <li key={e.key}>
                <button
                  className={e.key === opened.key ? "on" : ""}
                  aria-current={e.key === opened.key ? "page" : undefined}
                  onClick={() => onOpen(opened.stage, e.key)}
                >
                  <span className="grow">{e.title}</span>
                  {KIND_TAG[e.kind] && <span className="pd-tag">{KIND_TAG[e.kind]}</span>}
                  {hasContent(project, opened.stage, e) && <span className="pd-dot" title="Has content" />}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {!entry ? (
          <Empty>This document is not part of this kind of project.</Empty>
        ) : entry.kind !== "document" ? (
          <div className="pd-form">
            <FormPane project={project} entry={entry} write={write} />
          </div>
        ) : entry.per || entry.pagePerEpisode ? (
          <Empty>{entry.title} opens from each session or episode, in a later phase.</Empty>
        ) : !doc ? (
          <>
            <div className="pd-pages">
              <ol aria-label="Pages">
                {(entry.pages ?? []).map((p, i) => (
                  <li key={p.title} className="pd-card">
                    <span className="pd-card-main">
                      <span className="pd-card-num">{i + 1}</span>
                      <span className="pd-card-text">
                        <span className="pd-card-title">{p.title}</span>
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="pd-write">
              <Empty>Nothing has been written in the {entry.title} yet.</Empty>
            </div>
          </>
        ) : (
          <>
            <PageList doc={doc} pages={pages} selected={page?.id ?? null} write={write} onSelect={(id) => leaveThen(() => setPageId(id))} />
            <div className="pd-write">
              <div className="pd-write-bar">
                <span className="pd-doc-title">{doc.title}</span>
                <button className="btn small" disabled={!page} onClick={() => page && printJob(page)}>
                  Print page
                </button>
                <button className="btn small" disabled={!pages.length} onClick={() => printJob()}>
                  Print document
                </button>
              </div>
              {page ? (
                <PageEditor key={page.id} ref={editor} doc={doc} page={page} write={write} subtitleLabel={subtitleLabelOf(doc.docKey)} />
              ) : (
                <Empty>This document has no pages.</Empty>
              )}
              <LinksBox doc={doc} write={write} />
            </div>
          </>
        )}
      </div>
      {printNode}
    </div>
  );
}

// ── The whole: Project Home, or one thing open ───────────────

export function ProjectDocuments({ project, write }: { project: Project; write: boolean }) {
  useDb();
  const { actor, attempt, confirm } = useApp();
  const [opened, setOpened] = useState<Opened | null>(null);
  const editor = useRef<PageEditorHandle | null>(null);
  const leaveThen = (then: () => void) => {
    const why = editor.current?.leave() ?? null;
    if (!why) return then();
    void confirm({ title: "Leave without saving?", body: why, confirmLabel: "Leave anyway", danger: true }).then((ok) => ok && then());
  };
  const open = (stage: WorkflowStage, key: string) =>
    leaveThen(() => {
      const entry = catalogEntry(project.workflow.formType, stage, key);
      // A document is made from the catalogue the first time someone who may write in it opens it.
      if (entry?.kind === "document" && !entry.per && !entry.pagePerEpisode && write && !documentOf(project.contentId, stage, key))
        attempt(() => ensureDocument(actor, project.contentId, stage, key));
      editor.current = null;
      setOpened({ stage, key });
    });
  if (!opened) return <ProjectHome project={project} onOpen={open} />;
  return (
    <DocumentView
      key={`${opened.stage}|${opened.key}`}
      project={project}
      opened={opened}
      write={write}
      editor={editor}
      leaveThen={leaveThen}
      onOpen={open}
      onHome={() =>
        leaveThen(() => {
          editor.current = null;
          setOpened(null);
        })
      }
    />
  );
}
