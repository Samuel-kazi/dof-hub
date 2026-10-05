import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DocumentPage, WorkflowStage } from "../../types";
import { catalogEntry, catalogFor, type CatalogEntry } from "../../config/documentCatalog";
import { WORKFLOW_STAGE_NAMES } from "../../config/workflow";
import { getDb, useDb } from "../../data/store";
import {
  commentsOf,
  documentHasContent,
  documentOf,
  ensureDocument,
  pagesOf,
  storyboardsOf,
  shotListsOf,
  syncReviewThread,
} from "../../services/wrapped/documents";
import { sessionsOf, type Project } from "../../services/wrapped/workflow";
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
import { PageList } from "./PageList";
import { PlanSectionView, PlannedDrive, planCards, type PlanSection } from "./RecordingPlan";
import { DaySheetForm, EpisodeStrip, SessionPicker, defaultSession, formCards } from "./StagePanes";
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

/** The tiles a project shows at a stage: the catalogue's, less any made only by the move that this project does not have. */
const shownAt = (project: Project, stage: WorkflowStage): CatalogEntry[] =>
  catalogFor(project.workflow.formType, stage).filter((e) => !e.onlyIfMade || !!documentOf(project.contentId, stage, e.key));

/** Whether a tile's document or tool has something in it: worked out, never set by hand. */
function hasContent(project: Project, stage: WorkflowStage, entry: CatalogEntry): boolean {
  if (entry.kind === "document") {
    // A day sheet has content if any session's has.
    if (entry.per)
      return getDb().projectDocuments.some(
        (d) => d.contentId === project.contentId && d.stage === stage && d.docKey === entry.key && documentHasContent(d.id),
      );
    const doc = documentOf(project.contentId, stage, entry.key);
    // A Recording Plan has content once it has a session, as well as when something is written in it.
    if (entry.plan && sessionsOf(project.contentId).some((s) => !s.archivedAt)) return true;
    return !!doc && documentHasContent(doc.id);
  }
  if (entry.tool === "storyboard") return storyboardsOf(project.contentId).length > 0;
  if (entry.tool === "shotList") return shotListsOf(project.contentId).length > 0;
  return false;
}

/** The subtitle under a page's title: a devotion's scripture, or a note. */
const subtitleLabelOf = (docKey: string) => (docKey === "devotional_script" ? "Scripture" : "Subtitle or note");
/** A page's title: each devotion's own topic, under the theme every devotion shares. */
const titleLabelOf = (docKey: string) => (docKey === "devotional_script" ? "Topic" : "Page title");

/** The theme every devotion shares, set once for the devotion in its Project details. */
function SharedTheme({ project }: { project: Project }) {
  const theme = String(getDb().developmentForms.find((f) => f.contentId === project.contentId)?.sections.entry?.theme ?? "").trim();
  return (
    <p className="pd-theme">
      {theme ? (
        <>
          Theme, shared by every devotion: <b>{theme}</b>. Each page is one devotion, with its own topic.
        </>
      ) : (
        "No theme yet: set the theme every devotion shares in Project details. Each page is one devotion, with its own topic."
      )}
    </p>
  );
}

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
            {shownAt(project, stage).map((entry) => {
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
  const { actor, attempt } = useApp();
  const formType = project.workflow.formType;
  const entries = shownAt(project, opened.stage);
  const entry = catalogEntry(formType, opened.stage, opened.key);
  // A day sheet is one per recording session: the session chosen here. Its run sheet and wrap checklist are the
  // session's own forms, as fixed cards beside the pages.
  const perSession = entry?.kind === "document" && entry.per === "session";
  const [sessionId, setSessionId] = useState<string | null>(() => (perSession ? defaultSession(project.contentId) : null));
  // A Recording Plan's sections (roles, devotions, sessions, call sheets) are fixed cards before its pages.
  const plan = entry?.kind === "document" && !!entry.plan;
  const cards = perSession && entry ? formCards(entry) : plan ? planCards(project.contentId) : [];
  const [pageId, setPageId] = useState<string | null>(() => cards.find((c) => c.at === "start")?.id ?? null);
  const [print, printNode] = usePrintDocument();
  const ownerId = perSession ? sessionId : null;
  const doc =
    entry?.kind === "document" && (!perSession || ownerId) ? documentOf(project.contentId, opened.stage, opened.key, ownerId) : undefined;
  const pages = doc ? pagesOf(doc.id) : [];
  const formOpen = pageId?.startsWith("form:") ? pageId.slice("form:".length) : null;
  const planOpen = pageId?.startsWith("plan:") ? (pageId.slice("plan:".length) as PlanSection) : null;
  const page = formOpen || planOpen ? undefined : (pages.find((p) => p.id === pageId) ?? pages[0]);
  // A session's day sheet is made the first time someone who may write in it opens it, as other documents are.
  useEffect(() => {
    if (perSession && write && sessionId && !documentOf(project.contentId, opened.stage, opened.key, sessionId))
      attempt(() => ensureDocument(actor, project.contentId, opened.stage, opened.key, sessionId));
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The document this one's theological review is of, if it is reviewed.
  const reviewEntry = entries.find((e) => e.kind === "review" && e.reviews === opened.key);
  const showComments = !!doc && (!!reviewEntry || !!entry?.pagePerEpisode || commentsOf(doc.id).length > 0);
  // The catalogue page that carries the brief's structured fields (the logline and core question): the page of that
  // title, or the first page if it has been renamed.
  const fieldsPage = entry?.pages?.find((p) => p.fields?.length);
  const fieldsTarget = fieldsPage ? (pages.find((p) => p.title === fieldsPage.title) ?? pages[0]) : undefined;
  // The page the footage drive is chosen above (a Recording Plan's Cards and storage), found the same way.
  const storagePage = entry?.pages?.find((p) => p.storage);
  const storageTarget = storagePage ? (pages.find((p) => p.title === storagePage.title) ?? pages[0]) : undefined;
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
        ) : entry.per === "episode" ? (
          <Empty>{entry.title} opens from each episode.</Empty>
        ) : perSession && !sessionId ? (
          <div className="pd-write">
            <Empty>No recording sessions yet. They are scheduled in Pre-production, under Sessions.</Empty>
          </div>
        ) : !doc && !perSession && !plan ? (
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
            <PageList
              doc={doc ?? null}
              pages={pages}
              selected={formOpen || planOpen ? pageId : (page?.id ?? null)}
              write={write}
              fixed={cards}
              emptyText={
                entry.pagePerEpisode
                  ? "No episodes yet: each episode gets its page here once its session closes."
                  : doc
                    ? undefined
                    : plan
                      ? "Nothing has been written yet."
                      : "Nothing has been written for this session yet."
              }
              onSelect={(id) => leaveThen(() => setPageId(id))}
              head={
                perSession && (
                  <SessionPicker
                    project={project}
                    value={sessionId}
                    onChange={(id) =>
                      leaveThen(() => {
                        editor.current = null;
                        setSessionId(id);
                        setPageId(cards.find((c) => c.at === "start")?.id ?? null);
                      })
                    }
                  />
                )
              }
            />
            {planOpen ? (
              <div className="pd-write">
                <PlanSectionView project={project} section={planOpen} write={write} onOpenTool={(key) => onOpen(opened.stage, key)} />
              </div>
            ) : formOpen && sessionId ? (
              <div className="pd-write">
                <DaySheetForm project={project} sessionId={sessionId} form={formOpen} />
              </div>
            ) : !doc ? (
              <div className="pd-write">
                <Empty>
                  {plan ? `Nothing has been written in the ${entry.title} yet.` : "Nothing has been written for this session yet."}
                </Empty>
              </div>
            ) : (
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
                {doc.docKey === "devotional_script" && <SharedTheme project={project} />}
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
                {page?.episodeId && <EpisodeStrip episodeId={page.episodeId} />}
                {page && page.id === storageTarget?.id && <PlannedDrive project={project} write={write} />}
                {page ? (
                  <div className={showComments ? "pd-with-comments" : undefined}>
                    <PageEditor
                      key={page.id}
                      ref={editor}
                      doc={doc}
                      page={page}
                      write={write}
                      subtitleLabel={subtitleLabelOf(doc.docKey)}
                      titleLabel={titleLabelOf(doc.docKey)}
                    />
                    {showComments && <PageComments project={project} doc={doc} page={page} />}
                  </div>
                ) : (
                  <Empty>{entry.pagePerEpisode ? "No episodes yet." : "This document has no pages."}</Empty>
                )}
                <LinksBox doc={doc} write={write} />
              </div>
            )}
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
      // A Review Thread gains a page for each episode that has none yet.
      if (entry?.kind === "document" && entry.pagePerEpisode && write) attempt(() => syncReviewThread(actor, project.contentId));
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
