import type { Database } from "../types";
import { RuleError } from "../types";

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
    name: "share_token",
    part: "shareLinks",
    fields: ["token"],
    when: { field: "token", is: "string" },
    message: "That share link already exists. Make a new one.",
  },
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
  for (const part of [...WORKFLOW_PARTS, "records"]) out.push(...uniqueViolations(part, parts[part] ?? []));

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
  for (const p of db.plannedEpisodes ?? []) project(p.contentId, `Planned episode ${p.id}`);
  for (const r of db.projectRoles ?? []) {
    project(r.contentId, `Role ${r.id}`);
    person(r.crewId, `Role ${r.id}`);
    if (r.exclusive !== (r.roleKey !== "host_guest")) out.push(`Role ${r.id}: only hosts and guests may be held by several people.`);
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
  return out;
}

/** Refuses a change that would leave the workflow's data inconsistent. Nothing has been saved when this throws. */
export function assertIntegrity(db: Database): void {
  const problems = integrityProblems(db);
  if (problems.length) throw new RuleError(problems[0]);
}
