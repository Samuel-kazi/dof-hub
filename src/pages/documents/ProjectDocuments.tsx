import { useRef, useState, type ReactNode } from "react";
import type { DocumentPage, ProjectDocument, WorkflowStage } from "../../types";
import { catalogEntry, catalogFor, type CatalogEntry } from "../../config/documentCatalog";
import { WORKFLOW_STAGE_NAMES } from "../../config/workflow";
import { useDb } from "../../data/store";
import { textOf } from "../../services/html";
import {
  addPage,
  archivePage,
  commentsOf,
  documentHasContent,
  documentOf,
  ensureDocument,
  movePage,
  pagesOf,
  restorePage,
  storyboardsOf,
  shotListsOf,
} from "../../services/wrapped/documents";
import type { Project } from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { Empty } from "../../ui/parts";
import { IconBack, IconCalendar, IconCam, IconCheck, IconDoc, IconDrive, IconFilm, IconSheet, IconUsers } from "../../ui/Icons";
import { DecisionHistory, DecisionPanel } from "../workflow/Development";
import { DevelopmentGate, ProducerField } from "./DevelopmentGate";
import { FormPane } from "./FormPanes";
import { LinksBox } from "./LinksBox";
import { FormFields, pageFields, ProjectDetails } from "./ProjectDetails";
import { PageComments, ReviewBanner, ReviewPanes } from "./ReviewView";
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

export function ProjectHome({
  project,
  write,
  onOpen,
}: {
  project: Project;
  write: boolean;
  onOpen: (stage: WorkflowStage, key: string) => void;
}) {
  const current = project.workflow.stage;
  return (
    <div className="pd-home" aria-label="Project home">
      <ProjectDetails project={project} write={write} />
      <DevelopmentGate project={project} write={write} />
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

// ── The greenlight, above the Greenlight document's page ─────

/** The recorded decision, its date and notes, and the show producer: structured, as before. Then the gate to move on. */
function GreenlightPanel({ project, write }: { project: Project; write: boolean }) {
  const inDevelopment = project.workflow.stage === "Development";
  return (
    <div className="stack">
      <section className="pd-greenlight" aria-label="Greenlight decision">
        {inDevelopment ? <DecisionPanel project={project} write={write} active /> : <DecisionHistory projectId={project.contentId} />}
        <ProducerField project={project} />
      </section>
      <DevelopmentGate project={project} write={write} />
    </div>
  );
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
  // The document this one's theological review is of, if it is reviewed.
  const reviewEntry = entries.find((e) => e.kind === "review" && e.reviews === opened.key);
  const showComments = !!doc && (!!reviewEntry || commentsOf(doc.id).length > 0);
  // The catalogue page that carries the brief's structured fields (the logline and core question): the page of that
  // title, or the first page if it has been renamed.
  const fieldsPage = entry?.pages?.find((p) => p.fields?.length);
  const fieldsTarget = fieldsPage ? (pages.find((p) => p.title === fieldsPage.title) ?? pages[0]) : undefined;
  const reviewed = entry?.kind === "review" && entry.reviews ? documentOf(project.contentId, "Development", entry.reviews) : undefined;
  const printJob = (only?: DocumentPage) => {
    if (!doc) return;
    leaveThen(() => {
      const all = pagesOf(doc.id);
      const chosen = only ? all.filter((p) => p.id === only.id) : all;
      print({
        projectTitle: project.title,
        contentId: project.contentId,
        doc,
        pages: chosen,
        fields: Object.fromEntries(chosen.map((p) => [p.id, pageFields(project, doc, p, all)])),
      });
    });
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
      <div className={`pd-panes${entry?.kind === "document" || entry?.kind === "review" ? "" : " wide"}`}>
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
        ) : entry.kind === "review" ? (
          <ReviewPanes
            project={project}
            doc={reviewed}
            title={catalogFor(formType, "Development").find((e) => e.key === entry.reviews)?.title ?? "document"}
            write={write}
            pageId={pageId}
            onSelectPage={setPageId}
          />
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
              {reviewEntry && <ReviewBanner doc={doc} write={write} />}
              {opened.key === "greenlight" && <GreenlightPanel project={project} write={write} />}
              {page && fieldsPage?.fields && page.id === fieldsTarget?.id && (
                <FormFields
                  project={project}
                  sectionKey={fieldsPage.fields[0].section}
                  keys={fieldsPage.fields.map((f) => f.key)}
                  write={write && !project.archived}
                  label="Logline and core question"
                />
              )}
              {page ? (
                <div className={showComments ? "pd-with-comments" : undefined}>
                  <PageEditor key={page.id} ref={editor} doc={doc} page={page} write={write} subtitleLabel={subtitleLabelOf(doc.docKey)} />
                  {showComments && <PageComments project={project} doc={doc} page={page} />}
                </div>
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
  if (!opened) return <ProjectHome project={project} write={write} onOpen={open} />;
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
