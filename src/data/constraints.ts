import type { Database } from "../types";
import { RuleError } from "../types";
import { EPISODE_TOKEN } from "../config/workflow";
import { codeNumber } from "./ids";

// The rules the data itself must keep, whoever changes it. There is no SQL database here to declare them in,
// so they are declared once, below, and enforced in three places:
// - MongoDB: each uniqueness rule is a unique index (server/mongo.ts), so a duplicate is refused by the
//   database even if a bug let it through the code.
// - The server's in-memory store, for tests and laptops (server/stores.ts), refuses duplicates the same way.
// - Every save on the server, and every save in the desktop app and local demo, checks both kinds of rule
//   before anything is written (server/state.ts, src/data/store.ts). A change that breaks one is refused whole.
// They cover the five-stage workflow's data. The parts of the app that came before it are left as they were.

/** The lists that hold the five-stage workflow's data. */
export const WORKFLOW_PARTS = [
  "developmentForms",
  "plannedEpisodes",
  "projectRoles",
  "workflowChecklistItems",
  "recordingSessions",
  "sessionLogEntries",
  "reviewCheckpoints",
  "shareLinks",
] as const;
export type WorkflowPart = (typeof WORKFLOW_PARTS)[number];

/** A document's ID: its project, stage and kind, and the session or episode it is for if it is one of those. */
export const documentIdOf = (contentId: string, stage: string, docKey: string, ownerId: string | null): string =>
  `${contentId}|${stage}|${docKey}${ownerId ? `|${ownerId}` : ""}`;

/** The lists that hold project documents, storyboards and shot lists (data version 16). */
export const DOCUMENT_PARTS = [
  "projectDocuments",
  "documentPages",
  "documentLinks",
  "documentReviews",
  "reviewComments",
  "storyboards",
  "storyboardFrames",
  "shotLists",
  "shotListRows",
] as const;

export interface UniqueRule {
  name: string; // the MongoDB index is called unique_<name>
  part: string; // the list it applies to
  fields: string[]; // paths inside each element, together unique
  when?: { field: string; is: true | "string" | "object" }; // only elements where this holds
  message: string; // what the person is told
}

export const UNIQUE_RULES: UniqueRule[] = [
  { name: "development_form", part: "developmentForms", fields: ["contentId"], message: "This project already has a development form." },
  {
    name: "planned_episode_number",
    part: "plannedEpisodes",
    fields: ["contentId", "episodeNumber"],
    message: "That episode number is already planned for this project.",
  },
  {
    name: "project_role",
    part: "projectRoles",
    fields: ["contentId", "roleKey"],
    when: { field: "exclusive", is: true },
    message: "Someone already has that role on this project.",
  },
  {
    name: "checklist_item",
    part: "workflowChecklistItems",
    fields: ["ownerId", "stage", "itemKey"],
    message: "That checklist item already exists.",
  },
  {
    name: "planned_reserved_id",
    part: "plannedEpisodes",
    fields: ["reservedId"],
    when: { field: "reservedId", is: "string" },
    message: "That earlier episode is already waiting as another planned episode.",
  },
  {
    name: "session_number",
    part: "recordingSessions",
    fields: ["contentId", "sessionNumber"],
    message: "That session number is already used in this project.",
  },
  {
    name: "session_log_episode",
    part: "sessionLogEntries",
    fields: ["sessionId", "plannedEpisodeId"],
    when: { field: "plannedEpisodeId", is: "string" },
    message: "That episode already has a row in this session's log.",
  },
  {
    name: "episode_number",
    part: "records",
    fields: ["parentId", "episode.episodeNumber"],
    when: { field: "episode", is: "object" },
    message: "That episode number is already used in this project.",
  },
  {
    name: "review_checkpoint",
    part: "reviewCheckpoints",
    fields: ["contentId", "episodeId", "checkpoint"],
    message: "That review checkpoint already exists.",
  },
  {
    name: "project_document",
    part: "projectDocuments",
    fields: ["contentId", "stage", "docKey", "ownerId"],
    message: "This project already has that document.",
  },
  {
    name: "document_reviewer",
    part: "documentReviews",
    fields: ["documentId", "reviewerId"],
    message: "That person already reviews this document.",
  },
  {
    name: "share_token",
    part: "shareLinks",
    fields: ["token"],
    when: { field: "token", is: "string" },
    message: "That share link already exists. Make a new one.",
  },
  // Productions (data version 19): a day of a show has one call sheet, and a show one template.
  {
    name: "day_call_sheet",
    part: "callSheets",
    fields: ["instanceId"],
    when: { field: "instanceId", is: "string" },
    message: "That day of the show already has its call sheet.",
  },
  { name: "show_template", part: "showTemplates", fields: ["contentId"], message: "This show already has a template." },
];

/** The value at a dotted path, such as "episode.episodeNumber". */
export function valueAt(el: unknown, path: string): unknown {
  let cur: unknown = el;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const applies = (rule: UniqueRule, el: unknown): boolean => {
  if (!rule.when) return true;
  const v = valueAt(el, rule.when.field);
  if (rule.when.is === true) return v === true;
  if (rule.when.is === "object") return !!v && typeof v === "object" && !Array.isArray(v);
  return typeof v === rule.when.is;
};

/** The uniqueness rules that a list of one part's elements breaks, as messages. */
export function uniqueViolations(part: string, elements: unknown[]): string[] {
  const out: string[] = [];
  for (const rule of UNIQUE_RULES) {
    if (rule.part !== part) continue;
    const seen = new Set<string>();
    for (const el of elements) {
      if (!applies(rule, el)) continue;
      const key = JSON.stringify(rule.fields.map((f) => valueAt(el, f) ?? null));
      if (seen.has(key)) {
        out.push(rule.message);
        break;
      }
      seen.add(key);
    }
  }
  return out;
}

/**
 * Everything in the workflow's data that points at something that does not exist, or breaks a uniqueness rule.
 * An empty list means the data is consistent.
 */
export function integrityProblems(db: Database): string[] {
  const out: string[] = [];
  const parts = db as unknown as Record<string, unknown[] | undefined>;
  for (const part of [...WORKFLOW_PARTS, ...DOCUMENT_PARTS, "records", "callSheets", "showTemplates", "locations"])
    out.push(...uniqueViolations(part, parts[part] ?? []));

  const records = new Set(db.records.map((r) => r.contentId));
  const people = new Set(db.people.map((p) => p.personId));
  const sessions = new Map((db.recordingSessions ?? []).map((s) => [s.id, s]));
  const planned = new Map((db.plannedEpisodes ?? []).map((p) => [p.id, p]));
  const sheets = new Set(db.callSheets.map((c) => c.id));
  const missing = (what: string, id: string, from: string) => out.push(`${from} refers to ${what} ${id}, which does not exist.`);
  const project = (id: string, from: string) => {
    if (!records.has(id)) missing("project", id, from);
  };
  const person = (id: string | null, from: string) => {
    if (id !== null && id !== "system" && !people.has(id)) missing("person", id, from);
  };

  for (const f of db.developmentForms ?? []) project(f.contentId, `Development form ${f.id}`);
  const byId = new Map(db.records.map((r) => [r.contentId, r]));
  for (const p of db.plannedEpisodes ?? []) {
    project(p.contentId, `Planned episode ${p.id}`);
    if (p.reservedId) {
      // Either an episode made before the workflow, waiting under this project, or one of this project's episode codes
      // given out ahead of recording (a devotion's episodes get theirs in Pre-production).
      const kept = byId.get(p.reservedId);
      const ownCode = !Number.isNaN(codeNumber(p.reservedId, p.contentId, EPISODE_TOKEN));
      if (kept ? kept.parentId !== p.contentId : !ownCode)
        out.push(`Planned episode ${p.id} keeps ${p.reservedId}, which belongs to a different project.`);
    }
  }
  for (const r of db.projectRoles ?? []) {
    project(r.contentId, `Role ${r.id}`);
    person(r.crewId, `Role ${r.id}`);
    // A role of the usual kind is held once per project. Hosts and guests, and roles a Recording Plan adds by hand, can
    // be several (each row still names one person).
    const several = r.roleKey === "host_guest" || r.roleKey === "custom";
    if (r.exclusive === several) out.push(`Role ${r.id}: only hosts, guests and roles added by hand may be held by several people.`);
  }
  for (const c of db.workflowChecklistItems ?? []) {
    const exists = c.ownerType === "session" ? sessions.has(c.ownerId) : records.has(c.ownerId);
    if (!exists) missing(c.ownerType, c.ownerId, `Checklist item ${c.id}`);
  }
  for (const s of db.recordingSessions ?? []) {
    project(s.contentId, `Session ${s.id}`);
    if (s.callSheetId !== null && !sheets.has(s.callSheetId)) missing("call sheet", s.callSheetId, `Session ${s.id}`);
  }
  for (const e of db.sessionLogEntries ?? []) {
    const s = sessions.get(e.sessionId);
    if (!s) missing("session", e.sessionId, `Log row ${e.id}`);
    if (e.plannedEpisodeId !== null) {
      const p = planned.get(e.plannedEpisodeId);
      if (!p) missing("planned episode", e.plannedEpisodeId, `Log row ${e.id}`);
      else if (s && p.contentId !== s.contentId) out.push(`Log row ${e.id} is for an episode of a different project.`);
    }
  }
  for (const r of db.records) {
    if (r.workflow) person(r.workflow.showProducerId, `Project ${r.contentId}`);
    if (!r.episode) continue;
    const from = `Episode ${r.contentId}`;
    if (r.episode.sourceSessionId !== null && !sessions.has(r.episode.sourceSessionId)) missing("session", r.episode.sourceSessionId, from);
    if (r.episode.plannedEpisodeId !== null && !planned.has(r.episode.plannedEpisodeId))
      missing("planned episode", r.episode.plannedEpisodeId, from);
    person(r.episode.editorId, from);
  }
  for (const c of db.reviewCheckpoints ?? []) {
    project(c.contentId, `Checkpoint ${c.id}`);
    if (c.episodeId !== null && !records.has(c.episodeId)) missing("episode", c.episodeId, `Checkpoint ${c.id}`);
    for (const id of c.reviewerIds) person(id, `Checkpoint ${c.id}`);
  }
  for (const l of db.shareLinks ?? []) if (!records.has(l.episodeId)) missing("episode", l.episodeId, `Share link ${l.id}`);

  // Project documents, storyboards and shot lists.
  const documents = new Set((db.projectDocuments ?? []).map((d) => d.id));
  const pages = new Map((db.documentPages ?? []).map((p) => [p.id, p]));
  const doc = (id: string, from: string) => {
    if (!documents.has(id)) missing("document", id, from);
  };
  for (const d of db.projectDocuments ?? []) {
    project(d.contentId, `Document ${d.id}`);
    if (d.id !== documentIdOf(d.contentId, d.stage, d.docKey, d.ownerId))
      out.push(`Document ${d.id} is filed under the wrong project, stage or kind.`);
  }
  const docProject = new Map((db.projectDocuments ?? []).map((d) => [d.id, d.contentId]));
  const episodes = new Map(db.records.filter((r) => r.episode).map((r) => [r.contentId, r]));
  for (const p of db.documentPages ?? []) {
    doc(p.documentId, `Page ${p.id}`);
    if (p.episodeId) {
      const ep = episodes.get(p.episodeId);
      if (!ep) missing("episode", p.episodeId, `Page ${p.id}`);
      else if (ep.parentId !== docProject.get(p.documentId)) out.push(`Page ${p.id} is about an episode of a different project.`);
    }
  }
  for (const l of db.documentLinks ?? []) doc(l.documentId, `Link ${l.id}`);
  for (const r of db.documentReviews ?? []) {
    doc(r.documentId, `Review ${r.id}`);
    person(r.reviewerId, `Review ${r.id}`);
  }
  for (const c of db.reviewComments ?? []) {
    doc(c.documentId, `Comment ${c.id}`);
    const page = pages.get(c.pageId);
    if (!page) missing("page", c.pageId, `Comment ${c.id}`);
    else if (page.documentId !== c.documentId) out.push(`Comment ${c.id} is on a page of a different document.`);
    person(c.authorId, `Comment ${c.id}`);
  }
  const boards = new Set((db.storyboards ?? []).map((b) => b.id));
  const lists = new Set((db.shotLists ?? []).map((l) => l.id));
  for (const b of [...(db.storyboards ?? []), ...(db.shotLists ?? [])]) {
    project(b.contentId, b.id);
    if (b.episodeId !== null && !records.has(b.episodeId)) missing("episode", b.episodeId, b.id);
  }
  for (const f of db.storyboardFrames ?? []) if (!boards.has(f.storyboardId)) missing("storyboard", f.storyboardId, `Frame ${f.id}`);
  // A session's chosen storyboard and shot list are its own project's; the drives a project or session plans to use
  // exist; a storage entry for a session's footage names a real session.
  const boardProject = new Map([...(db.storyboards ?? []), ...(db.shotLists ?? [])].map((b) => [b.id, b.contentId]));
  const drives = new Set((db.drives ?? []).map((d) => d.id));
  for (const s of db.recordingSessions ?? []) {
    for (const [what, id] of [
      ["storyboard", s.storyboardId],
      ["shot list", s.shotListId],
    ] as const)
      if (id && boardProject.get(id) !== s.contentId) out.push(`Session ${s.id} shows a ${what} that is not its project's: ${id}.`);
    if (s.storageDriveId && !drives.has(s.storageDriveId)) missing("drive", s.storageDriveId, `Session ${s.id}`);
  }
  for (const r of db.records)
    if (r.workflow?.storageDriveId && !drives.has(r.workflow.storageDriveId))
      missing("drive", r.workflow.storageDriveId, `Project ${r.contentId}`);
  for (const a of db.allocations ?? [])
    if (a.sessionId && !sessions.has(a.sessionId)) missing("session", a.sessionId, `Storage entry ${a.id}`);
  for (const r of db.shotListRows ?? []) if (!lists.has(r.shotListId)) missing("shot list", r.shotListId, `Row ${r.id}`);
  // Productions: a show's template is its own, a day made from a template belongs to that template's show, and a
  // day's call sheet is that day's show's.
  const recordById = new Map(db.records.map((r) => [r.contentId, r]));
  const templates = new Map((db.showTemplates ?? []).map((t) => [t.id, t]));
  for (const t of db.showTemplates ?? []) {
    const show = recordById.get(t.contentId);
    if (!show) missing("show", t.contentId, `Template ${t.id}`);
    else if (show.production?.templateId !== t.id) out.push(`Template ${t.id} is not its show's template.`);
  }
  for (const r of db.records) {
    if (r.production?.templateId && !templates.has(r.production.templateId))
      missing("template", r.production.templateId, `Show ${r.contentId}`);
    if (r.instance) {
      const t = templates.get(r.instance.templateId);
      if (!t) missing("template", r.instance.templateId, `Day ${r.contentId}`);
      else if (t.contentId !== r.parentId) out.push(`Day ${r.contentId} follows another show's template.`);
    }
  }
  for (const c of db.callSheets)
    if (c.instanceId) {
      const day = recordById.get(c.instanceId);
      if (!day) missing("day", c.instanceId, `Call sheet ${c.id}`);
      else if (day.parentId !== c.contentId) out.push(`Call sheet ${c.id} is for a day of another show.`);
    }
  // A sheet picked from a saved location points at one that exists, and its confirmations are for people on it.
  const locations = new Set((db.locations ?? []).map((l) => l.id));
  for (const c of db.callSheets) {
    if (c.locationId && !locations.has(c.locationId)) missing("saved location", c.locationId, `Call sheet ${c.id}`);
    for (const key of Object.keys(c.confirmations ?? {}))
      if (key.startsWith("talent:") ? !c.talent.some((t) => `talent:${t.id}` === key) : !c.crewPersonIds.includes(key))
        out.push(`Call sheet ${c.id} has a confirmation for ${key}, who is not on it.`);
  }
  return out;
}

/** Refuses a change that would leave the workflow's data inconsistent. Nothing has been saved when this throws. */
export function assertIntegrity(db: Database): void {
  const problems = integrityProblems(db);
  if (problems.length) throw new RuleError(problems[0]);
}
