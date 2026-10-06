import type {
  ContentRecord,
  Database,
  DocumentPage,
  DocumentReview,
  FormType,
  ProjectDocument,
  ShotList,
  ShotListRow,
  WorkflowStage,
} from "../types";
import { CRITERIA } from "../config/workflow";
import { DEV_FORMS, type FieldDef } from "../config/devForms";
import { EARLIER_FORM_KEY, briefKeyOf, catalogEntry, catalogTypeOf } from "../config/documentCatalog";
import { templateOf } from "../config/docTemplates";
import { escapeHtml, textToHtml } from "../services/html";
import { fmtDate } from "../services/utils";
import { documentIdOf } from "./constraints";
import { localId } from "./ids";

// Moves each project's old Development form into its documents (the documents rework, section 5 of its brief): the
// brief's fields onto the brief's pages, each as a bold label and the old value; the six criteria onto the Greenlight
// document; the pitch and outline checkpoints into reviews of the brief; a devotion's five days onto its script; and a
// shot list made from the camera plan. Fields that drive something stay structured on the form, where they are, and are
// listed; a field the mapping does not know is still written, on an "Also from the old form" page, so nothing is lost.
//
// The old form, checkpoints and checklists are left exactly as they were. Everything written here is marked, so undoing
// the move (undoDocumentMove) removes exactly that. Running it again changes nothing: a project that already has its
// documents is left alone. It runs with the move into the workflow (src/data/migrateWorkflow.ts), on a copy first.

export interface DocumentMigrationLine {
  contentId: string;
  title: string;
  documents: string[]; // what was written
  fields: number; // old fields written onto pages
  note: string;
}

export interface DocumentMigrationReport {
  lines: DocumentMigrationLine[];
  kept: { contentId: string; field: string; why: string }[]; // fields that stay structured on the form
  extras: { contentId: string; field: string }[]; // fields the mapping does not know, written on "Also from the old form"
  unaccounted: string[]; // filled fields neither written nor kept: always empty, and the tests check it
  changed: boolean;
}

export interface DocumentMigrationOptions {
  at: string;
}

const MIGRATION = "migration"; // who a page written by the move is "by", so undoing it can find it
type Target = { doc: string; stage: WorkflowStage; page: string; heading?: string };
type Rule = Target | { keep: string } | { comment: true } | null;

// Kept on the form: the header strip (entry, guest), the consent and release form, and the fields gates or later stages
// read (the logline and core question, shown at the top of the brief, and a sermon's delivery).
function ruleFor(formType: FormType, section: string, field: string): Rule {
  const brief = briefKeyOf(formType);
  const doc = catalogTypeOf(formType) === "documentary";
  const at = (page: string, heading?: string): Target => ({ doc: brief, stage: "Development", page, heading });
  if (section === "entry" || section === "guest") return { keep: "the header strip" };
  if (section === "consent") return { keep: "the Consent and Release form" };
  if (section === "brief" && (field === "logline" || field === "coreQuestion")) return { keep: "the two fields at the top of The idea" };
  if (section === "brief" && field === "delivery") return { keep: "the project's sermon format, which decides later stages" };
  switch (section) {
    case "brief":
      if (
        [
          "workingTitle",
          "targetAudience",
          "formatDuration",
          "thesis",
          "person",
          "storyCore",
          "audience",
          "speaker",
          "seriesTheme",
          "duration",
        ].includes(field)
      )
        return at("The idea");
      if (["showType", "mustNotBecome"].includes(field)) return at(doc ? "The idea" : "Shape");
      if (["scriptureBasis", "scriptureConnection", "mainScripture"].includes(field))
        return at(doc ? "Sources and fact-checking" : "Scripture and source basis");
      if (field === "contributors") return at(doc ? "Subjects and locations" : "Shape");
      if (["resourceAsk", "distributionPlan", "distribution", "successMeasures", "learningQuestions"].includes(field)) return at("Ask");
      return null;
    case "research":
      return at(doc ? "Sources and fact-checking" : "Scripture and source basis", "Research");
    case "stressTest":
      return at("The idea", "Stress-test");
    case "story":
      return doc
        ? { doc: "treatment", stage: "Pre-production", page: field === "interviewSets" ? "Interview guide" : "Story structure" }
        : at("Shape", "Story");
    case "team":
      return at(doc ? "Subjects and locations" : "Shape", "Team");
    case "budget":
      return at("Ask", "Budget");
    case "sensitivity":
      return at("Sensitivity");
    case "outline":
      return at("Outline");
    case "readiness":
      return at("Proposer readiness");
    case "support":
      return at("Support asked for");
    case "ownership":
      return at("Ownership terms");
    case "messageReview":
      return { comment: true };
    case "recordingPlan":
      return { doc: "recording_plan", stage: "Pre-production", page: "Notes" };
  }
  return null;
}

const blank = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** An old field's value as words, the way the form showed it. */
function show(f: FieldDef | undefined, v: unknown, nameOf: (id: string) => string): string {
  switch (f?.type) {
    case "crew":
      return nameOf(String(v));
    case "yesno":
      return v === "yes" ? "Yes" : v === "no" ? "No" : String(v);
    case "date":
      return fmtDate(String(v));
    case "amount":
      return typeof v === "number" ? v.toLocaleString("en-GB") : String(v);
    case "multiselect":
      return Array.isArray(v) ? v.join(", ") : String(v);
    default:
      return Array.isArray(v) ? v.join(", ") : String(v);
  }
}

const labelled = (label: string, value: string): string => `<p><strong>${escapeHtml(label)}</strong></p>${textToHtml(value)}`;

export function migrateDocuments(db: Database, options: DocumentMigrationOptions): DocumentMigrationReport {
  const { at } = options;
  const report: DocumentMigrationReport = { lines: [], kept: [], extras: [], unaccounted: [], changed: false };
  const people = new Map(db.people.map((p) => [p.personId, p.name]));
  const nameOf = (id: string) => people.get(id) ?? id;
  const byId = new Map(db.records.map((r) => [r.contentId, r]));

  // ── Builders that write into `db`, never into the app's own data, so a dry run works on a copy ──
  const newDocument = (p: ContentRecord, stage: WorkflowStage, key: string): ProjectDocument | null => {
    const entry = catalogEntry(p.workflow!.formType, stage, key);
    if (!entry) return null;
    const id = documentIdOf(p.contentId, stage, key, null);
    const existing = db.projectDocuments.find((d) => d.id === id);
    if (existing) return existing;
    const d: ProjectDocument = {
      id,
      contentId: p.contentId,
      stage,
      docKey: key,
      ownerId: null,
      title: entry.title,
      migrated: true,
      createdAt: at,
      updatedAt: at,
    };
    db.projectDocuments.push(d);
    (entry.pages ?? []).forEach((pg, i) => db.documentPages.push(page(d.id, i, pg.title, pg.subtitle ?? "", pg.body ?? "")));
    return d;
  };
  const page = (documentId: string, position: number, title: string, subtitle: string, bodyHtml: string): DocumentPage => ({
    id: localId("PG"),
    documentId,
    position,
    title,
    subtitle,
    bodyHtml,
    version: 1,
    archivedAt: null,
    updatedAt: at,
    updatedBy: MIGRATION,
  });
  const pagesOf = (documentId: string) =>
    db.documentPages.filter((p) => p.documentId === documentId && !p.archivedAt).sort((a, b) => a.position - b.position);
  /** Writes onto a page of a document: the page of that title, made at the end if the document has none. */
  const write = (d: ProjectDocument, title: string, html: string) => {
    let pg = pagesOf(d.id).find((p) => p.title === title);
    if (!pg) {
      pg = page(d.id, pagesOf(d.id).length, title, "", "");
      db.documentPages.push(pg);
    }
    pg.bodyHtml += html;
  };

  for (const p of db.records
    .filter((r) => r.workflow)
    .sort((a, b) => a.contentId.localeCompare(b.contentId, undefined, { numeric: true }))) {
    const formType = p.workflow!.formType;
    const form = db.developmentForms.find((f) => f.contentId === p.contentId);
    const briefKey = briefKeyOf(formType);
    const title = p.parentId && byId.get(p.parentId) ? `${byId.get(p.parentId)!.title}: ${p.title}` : p.title;
    // A brief started by hand before the move (while the documents were a preview) is never written into: what the
    // form held goes to the "Earlier Development form" document instead. A brief made by the move, or that document,
    // means it is done. A brief only opened, with nothing written, linked, reviewed or commented on, is its starting
    // pages and nothing more: it is made again by the move, as if it had never been opened.
    let started = db.projectDocuments.find((d) => d.contentId === p.contentId && d.docKey === briefKey && !d.ownerId);
    const carried = db.projectDocuments.some((d) => d.contentId === p.contentId && d.docKey === EARLIER_FORM_KEY);
    if ((started && started.migrated) || carried) {
      report.lines.push({ contentId: p.contentId, title, documents: [], fields: 0, note: "It already has its documents. Left as it is." });
      continue;
    }
    if (started && form && onlyOpened(db, started.id)) {
      const id = started.id;
      db.projectDocuments = db.projectDocuments.filter((d) => d.id !== id);
      db.documentPages = db.documentPages.filter((pg) => pg.documentId !== id);
      started = undefined;
    }
    const late = !!started;
    if (!form) {
      report.lines.push({
        contentId: p.contentId,
        title,
        documents: [],
        fields: 0,
        note: "It has no Development form, so there is nothing to move.",
      });
      continue;
    }
    const written = new Set<string>();
    let fields = 0;
    const grouped = new Map<string, { target: Target; parts: Map<string, string[]> }>(); // per page, per heading, in form order

    // 1. Every filled field of the old form, by the mapping.
    for (const section of DEV_FORMS[formType]) {
      const values = form.sections[section.key] ?? {};
      const keys = [...section.fields.map((f) => f.key), ...Object.keys(values).filter((k) => !section.fields.some((f) => f.key === k))];
      for (const key of keys) {
        const v = values[key];
        if (blank(v)) continue;
        const def = section.fields.find((f) => f.key === key);
        const name = `${section.label}: ${def?.label ?? key}`;
        const rule = ruleFor(formType, section.key, key);
        if (rule && "keep" in rule) {
          report.kept.push({ contentId: p.contentId, field: name, why: rule.keep });
          continue;
        }
        if (rule && "comment" in rule) continue; // written as a review comment below, once the script exists
        const target: Target = rule ?? { doc: briefKey, stage: "Development", page: "Also from the old form" };
        if (!rule) report.extras.push({ contentId: p.contentId, field: name });
        const pageKey = `${target.stage}|${target.doc}|${target.page}`;
        if (!grouped.has(pageKey)) grouped.set(pageKey, { target, parts: new Map() });
        const heading = rule ? (target.heading ?? "") : section.label;
        const parts = grouped.get(pageKey)!.parts;
        if (!parts.has(heading)) parts.set(heading, []);
        parts.get(heading)!.push(labelled(def?.label ?? key, show(def, v, nameOf)));
        fields++;
      }
    }
    // Sections the form no longer has: written too, never dropped.
    for (const [sectionKey, values] of Object.entries(form.sections)) {
      if (DEV_FORMS[formType].some((s) => s.key === sectionKey)) continue;
      for (const [key, v] of Object.entries(values ?? {})) {
        if (blank(v)) continue;
        const pageKey = `Development|${briefKey}|Also from the old form`;
        if (!grouped.has(pageKey))
          grouped.set(pageKey, { target: { doc: briefKey, stage: "Development", page: "Also from the old form" }, parts: new Map() });
        const parts = grouped.get(pageKey)!.parts;
        if (!parts.has(sectionKey)) parts.set(sectionKey, []);
        parts.get(sectionKey)!.push(labelled(key, show(undefined, v, nameOf)));
        report.extras.push({ contentId: p.contentId, field: `${sectionKey}: ${key}` });
        fields++;
      }
    }

    // 2. The brief (or a devotion's script) always exists, so it can be written and reviewed. A document someone had
    // already started is left as it is: what was meant for it is kept on the "Earlier Development form", page by page.
    let keep: ProjectDocument | null = null;
    const keeping = (): ProjectDocument => {
      keep ??= newDocument(p, "Development", EARLIER_FORM_KEY)!;
      written.add(keep.title);
      return keep;
    };
    const ours = (stage: WorkflowStage, key: string): ProjectDocument | null => {
      const existing = db.projectDocuments.find((d) => d.id === documentIdOf(p.contentId, stage, key, null));
      return existing && !existing.migrated ? null : newDocument(p, stage, key);
    };
    const brief = late ? null : newDocument(p, "Development", briefKey);
    if (brief) written.add(brief.title);
    for (const { target, parts } of grouped.values()) {
      const d = target.doc === briefKey ? brief : ours(target.stage, target.doc);
      const docTitle = catalogEntry(formType, target.stage, target.doc)?.title ?? target.doc;
      const [into, pageTitle] = d ? [d, target.page] : [keeping(), `${docTitle}: ${target.page}`];
      written.add(into.title);
      for (const [heading, blocks] of parts)
        write(into, pageTitle, `${heading ? `<h3>${escapeHtml(heading)}</h3>` : ""}${blocks.join("")}`);
    }

    // 3. A devotion's planned days become the pages of its script: title, scripture and the script itself.
    if (formType === "devotion" && late) {
      // The script was started by hand: its pages are the devotions, so the earlier days are kept beside it, not added.
      const days = db.plannedEpisodes.filter((x) => x.contentId === p.contentId).sort((a, b) => a.episodeNumber - b.episodeNumber);
      if (days.length) {
        const k = keeping();
        days.forEach((day, i) => {
          write(
            k,
            "Devotions on the earlier form",
            `<h3>${escapeHtml(day.workingTitle || `Devotion ${i + 1}`)}${day.archivedAt ? " (taken off the list)" : ""}</h3>` +
              [
                day.details.scripture ? labelled("Scripture", day.details.scripture) : "",
                day.details.keyThought ? labelled("Key thought", day.details.keyThought) : "",
                day.details.application ? labelled("Application or closing", day.details.application) : "",
                day.question ? labelled("Question", day.question) : "",
                day.guest ? labelled("Guest", day.guest) : "",
                day.notes ? labelled("Notes", day.notes) : "",
                ...Object.entries(day.details)
                  .filter(([key, v]) => !["scripture", "keyThought", "application"].includes(key) && v)
                  .map(([key, v]) => labelled(key, v)),
              ].join(""),
          );
          fields++;
        });
      }
      const notes = form.sections.messageReview?.notes;
      if (typeof notes === "string" && notes.trim()) {
        write(keeping(), "Devotions on the earlier form", labelled("From the team's message review", notes.trim()));
        fields++;
      }
    }
    if (formType === "devotion" && brief) {
      const days = db.plannedEpisodes.filter((x) => x.contentId === p.contentId).sort((a, b) => a.episodeNumber - b.episodeNumber);
      if (days.length) {
        db.documentPages = db.documentPages.filter((x) => x.documentId !== brief.id); // the five blank starting pages
        days.forEach((day, i) => {
          const body = [
            day.details.keyThought ? labelled("Key thought", day.details.keyThought) : "",
            day.details.application ? labelled("Application or closing", day.details.application) : "",
            day.question ? labelled("Question", day.question) : "",
            day.guest ? labelled("Guest", day.guest) : "",
            day.notes ? labelled("Notes", day.notes) : "",
            ...Object.entries(day.details)
              .filter(([k, v]) => !["scripture", "keyThought", "application"].includes(k) && v)
              .map(([k, v]) => labelled(k, v)),
          ].join("");
          const pg = page(brief.id, i, day.workingTitle || `Devotion ${i + 1}`, day.details.scripture ?? "", body);
          if (day.archivedAt) pg.archivedAt = day.archivedAt;
          db.documentPages.push(pg);
          day.sourcePageId = pg.id;
          fields++;
        });
      }
      const notes = form.sections.messageReview?.notes;
      const first = pagesOf(brief.id)[0];
      if (typeof notes === "string" && notes.trim() && first) {
        db.reviewComments.push({
          id: localId("RC"),
          documentId: brief.id,
          pageId: first.id,
          authorId: "system",
          body: `From the team's message review: ${notes.trim()}`,
          resolved: false,
          resolvedBy: null,
          createdAt: at,
        });
        fields++;
      }
    }

    // 4. The six criteria, with their notes, become the Greenlight document's list. The decision stays on the form.
    if (catalogEntry(formType, "Development", "greenlight")) {
      const judged = CRITERIA.filter((c) => form.criteria[c.key]?.met !== null || form.criteria[c.key]?.note);
      if (judged.length) {
        const list = CRITERIA.map((c) => {
          const cr = form.criteria[c.key] ?? { met: null, note: "" };
          const verdict = cr.met === true ? "Met" : cr.met === false ? "Not met" : "Not judged yet";
          return `<li><p><strong>${escapeHtml(c.label)}:</strong> ${verdict}${cr.note ? `. ${escapeHtml(cr.note)}` : ""}</p></li>`;
        }).join("");
        const g = ours("Development", "greenlight");
        if (g) {
          written.add(g.title);
          const pg = pagesOf(g.id)[0];
          if (pg) pg.bodyHtml = `<p>The six criteria:</p><ul>${list}</ul>`;
        } else write(keeping(), "Greenlight: the six criteria", `<ul>${list}</ul>`);
        fields += judged.length;
      }
    }

    // 5. The pitch and outline checkpoints become the brief's review: approved only if both were. A brief started by
    // hand keeps them in words (an approval there still counts for its review gate until reviewers are named on it).
    if (late) {
      const cps = db.reviewCheckpoints.filter(
        (c) =>
          c.contentId === p.contentId &&
          !c.episodeId &&
          (c.checkpoint === "pitch" || c.checkpoint === "outline_script") &&
          (c.status !== "Pending" || c.reviewerIds.length || c.note),
      );
      for (const c of cps) {
        write(
          keeping(),
          "Theological review on the earlier form",
          `<h3>${c.checkpoint === "pitch" ? "Pitch" : "Outline or script"}: ${escapeHtml(c.status)}</h3>` +
            (c.reviewerIds.length ? labelled("Reviewers", c.reviewerIds.map(nameOf).join(", ")) : "") +
            (c.note ? labelled("Note", c.note) : "") +
            (c.decidedAt ? labelled("Decided", fmtDate(c.decidedAt.slice(0, 10))) : ""),
        );
      }
    }
    if (brief) {
      const cps = db.reviewCheckpoints.filter(
        (c) => c.contentId === p.contentId && !c.episodeId && (c.checkpoint === "pitch" || c.checkpoint === "outline_script"),
      );
      const both = cps.length === 2 && cps.every((c) => c.status === "Approved");
      const sentBack = cps.find((c) => c.status === "Changes requested");
      const reviewers = [...new Set(cps.flatMap((c) => c.reviewerIds))];
      const decidedBy = [...new Set(cps.map((c) => c.decidedById).filter((x): x is string => !!x))];
      const ids = reviewers.length ? reviewers : both ? (decidedBy.length ? decidedBy : ["system"]) : [];
      for (const reviewerId of ids) {
        const r: DocumentReview = {
          id: `${brief.id}|${reviewerId}`,
          documentId: brief.id,
          reviewerId,
          status: both ? "approved" : sentBack ? "changes_requested" : "pending",
          note: both
            ? cps
                .map((c) => c.note)
                .filter(Boolean)
                .join(" ") || "Approved at the pitch and outline checkpoints."
            : (sentBack?.note ?? ""),
          decidedAt: both
            ? (cps
                .map((c) => c.decidedAt)
                .filter(Boolean)
                .sort()
                .pop() ?? at)
            : (sentBack?.decidedAt ?? null),
          createdAt: at,
          updatedAt: at,
        };
        if (!db.documentReviews.some((x) => x.id === r.id)) db.documentReviews.push(r);
      }
    }

    // 6. The camera plan: the Pre-production shot list note, and the old shot list documents, become a shot list.
    const camera = db.shotLists.some((l) => l.contentId === p.contentId && l.migrated) ? [] : cameraPlanRows(db, p);
    if (camera.length) {
      const list: ShotList = {
        id: localId("SL"),
        contentId: p.contentId,
        isTemplate: false,
        episodeId: null,
        name: "Camera plan (from before the documents)",
        position: db.shotLists.filter((l) => l.contentId === p.contentId).length,
        copiedFrom: null,
        migrated: true,
        createdAt: at,
        updatedAt: at,
      };
      db.shotLists.push(list);
      camera.forEach((r, i) => db.shotListRows.push({ ...r, id: localId("SR"), shotListId: list.id, position: i }));
      written.add("Shot List");
    }

    if (late && !written.size) {
      report.lines.push({
        contentId: p.contentId,
        title,
        documents: [],
        fields: 0,
        note: "Its brief was started by hand, and its old form was empty.",
      });
      continue;
    }
    report.lines.push({
      contentId: p.contentId,
      title,
      documents: [...written],
      fields,
      note: late
        ? "Its brief had been started by hand, so it is left as it was: the old form is kept on the Earlier Development form."
        : fields
          ? ""
          : "Its Development form was empty: its documents start blank.",
    });
    report.changed = true;
  }

  // Proof that nothing was dropped: every filled field is either written or kept.
  report.unaccounted = unaccountedFields(db, report);
  return report;
}

/** A document someone only opened: its starting pages never saved, and no link, review or comment on it. */
function onlyOpened(db: Database, documentId: string): boolean {
  return (
    db.documentPages.filter((pg) => pg.documentId === documentId).every((pg) => pg.version === 1 && !pg.archivedAt) &&
    !db.documentLinks.some((l) => l.documentId === documentId) &&
    !db.documentReviews.some((r) => r.documentId === documentId) &&
    !db.reviewComments.some((c) => c.documentId === documentId)
  );
}

/** A shot list's rows from a project's camera plan: its Pre-production shot list note, and any old shot list document. */
function cameraPlanRows(db: Database, p: ContentRecord): Omit<ShotListRow, "id" | "shotListId" | "position">[] {
  const row = (rowType: ShotListRow["rowType"], description: string): Omit<ShotListRow, "id" | "shotListId" | "position"> => ({
    rowType,
    imagePath: null,
    description: description.slice(0, 500),
    shotSize: "",
    shotType: "",
    movement: "",
    estMinutes: null,
  });
  const out: Omit<ShotListRow, "id" | "shotListId" | "position">[] = [];
  const note = db.workflowChecklistItems.find((c) => c.id === `${p.contentId}|Pre-production|shot_list`)?.note.trim();
  if (note) {
    out.push(row("banner", "Shot list note from Pre-production"));
    for (const line of note
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean))
      out.push(row("setup", line));
  }
  const family = new Set([p.contentId, ...db.records.filter((r) => r.parentId === p.contentId).map((r) => r.contentId)]);
  const template = templateOf("shotlist")?.body.trim();
  for (const d of db.docs.filter((x) => x.templateKey === "shotlist" && family.has(x.contentId) && !x.archived)) {
    if (d.body.trim() === template) continue; // never written in
    out.push(row("banner", d.title));
    let inShots = false;
    for (const raw of d.body.split("\n")) {
      const line = raw.trim();
      if (!line || /^_.*_$/.test(line) || /^\|?\s*-{3,}/.test(line) || /^\|\s*#\s*\|/.test(line)) continue; // template notes, table header
      const heading = /^\d+\.\s+(.*)$/.exec(line);
      if (heading) {
        inShots = /shot/i.test(heading[1]);
        out.push(row("banner", heading[1]));
        continue;
      }
      if (line.startsWith("|")) {
        const cells = line
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean);
        const text = (cells.length > 1 && /^\d+$/.test(cells[0]) ? cells.slice(1) : cells).join(", ");
        if (text) out.push(row("shot", text));
        continue;
      }
      const item = /^-\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
      out.push(row(item && inShots ? "shot" : "setup", item ? item[2] : line));
    }
  }
  return out;
}

/** Filled old fields that appear on no page and are not kept on the form. */
function unaccountedFields(db: Database, report: DocumentMigrationReport): string[] {
  const out: string[] = [];
  const kept = new Set(report.kept.map((k) => `${k.contentId}|${k.field}`));
  for (const form of db.developmentForms) {
    const p = db.records.find((r) => r.contentId === form.contentId);
    if (!p?.workflow) continue;
    const text = db.documentPages
      .filter((pg) => pg.documentId.startsWith(`${p.contentId}|`))
      .map((pg) => `${pg.title} ${pg.subtitle} ${pg.bodyHtml}`)
      .join(" ");
    const comments = db.reviewComments
      .filter((c) => c.documentId.startsWith(`${p.contentId}|`))
      .map((c) => c.body)
      .join(" ");
    for (const section of DEV_FORMS[form.formType]) {
      for (const [key, v] of Object.entries(form.sections[section.key] ?? {})) {
        if (blank(v) || typeof v !== "string") continue;
        const def = section.fields.find((f) => f.key === key);
        const name = `${section.label}: ${def?.label ?? key}`;
        if (kept.has(`${p.contentId}|${name}`) || def?.type === "crew" || def?.type === "date" || def?.type === "yesno") continue;
        const words = escapeHtml(v.trim().split("\n")[0]);
        if (!text.includes(words) && !comments.includes(v.trim())) out.push(`${p.contentId}: ${name}`);
      }
    }
  }
  return out;
}

/**
 * Undoes the move: removes the documents, pages, reviews, comments and shot lists it wrote, and nothing else. A
 * document or shot list written in since is never removed: it is kept, and listed, unless `force` is given.
 */
export function undoDocumentMove(db: Database, force = false): { removed: number; keptEdited: string[] } {
  const migrated = new Set(db.projectDocuments.filter((d) => d.migrated).map((d) => d.id));
  const edited = new Set(
    db.documentPages.filter((p) => migrated.has(p.documentId) && (p.updatedBy !== MIGRATION || p.version > 1)).map((p) => p.documentId),
  );
  const remove = new Set([...migrated].filter((id) => force || !edited.has(id)));
  const before = db.projectDocuments.length + db.shotLists.length;
  const pageIds = new Set(db.documentPages.filter((p) => remove.has(p.documentId)).map((p) => p.id));
  db.projectDocuments = db.projectDocuments.filter((d) => !remove.has(d.id));
  db.documentPages = db.documentPages.filter((p) => !remove.has(p.documentId));
  db.documentLinks = db.documentLinks.filter((l) => !remove.has(l.documentId));
  db.documentReviews = db.documentReviews.filter((r) => !remove.has(r.documentId));
  db.reviewComments = db.reviewComments.filter((c) => !remove.has(c.documentId));
  for (const p of db.plannedEpisodes) if (p.sourcePageId && pageIds.has(p.sourcePageId)) p.sourcePageId = null;
  const movedLists = db.shotLists.filter((l) => l.migrated);
  const editedLists = movedLists.filter((l) => l.updatedAt !== l.createdAt).map((l) => l.id);
  const lists = new Set(movedLists.map((l) => l.id).filter((id) => force || !editedLists.includes(id)));
  db.shotLists = db.shotLists.filter((l) => !lists.has(l.id));
  db.shotListRows = db.shotListRows.filter((r) => !lists.has(r.shotListId));
  return {
    removed: before - db.projectDocuments.length - db.shotLists.length,
    keptEdited: force ? [] : [...edited, ...editedLists],
  };
}
