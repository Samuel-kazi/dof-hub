import type { Actor, GateOverride, WorkflowChecklistItem } from "../types";
import { RuleError } from "../types";
import { commit, getDb } from "../data/store";
import { CHECKLISTS, type ChecklistKey } from "../config/workflow";
import { GATE_GO, goForText, type CheckGo } from "../config/checks";
import { briefKeyOf, catalogTypeOf } from "../config/documentCatalog";
import { getRecord } from "./access";
import { logAudit } from "./audit";
import { sheetWarnings } from "./sheetAdvice";
import { todayIso } from "./utils";
import { hardGates } from "./documents/gates";
import { hasTheologicalReview, theologyStatus } from "./documents/theology";
import { checklistItems, ensureChecklist, getSession, projectForWrite, type Project } from "./workflow/common";
import { evaluateGate } from "./workflow/gates";
import { softNudges } from "./documents/nudges";
import { storageWarnings } from "./workflow/recordingLog";
import { setChecklistItem } from "./workflow/team";

// The Checks panel's evaluator (build prompt v4, section 14A): one for every stage and kind. It reads the same gates
// as the Done buttons (src/services/workflow/gates.ts and the documents' hard gates), so what the panel says is what
// the button needs, and turns them into two groups: Required to move on, and Suggestions (soft nudges, including the
// theological review). Done items are Completed. Manual items (the handoff, Pre-production) are ticked in the panel;
// derived ones are read-only. Each item says where it is fixed (src/config/checks.ts).

export type CheckGroup = "required" | "suggestion";

export interface CheckItem {
  key: string; // stable within its owner, for dismissing and for React
  group: CheckGroup;
  label: string;
  reason: string; // what is missing or found, in a few words
  done: boolean;
  go: CheckGo | null;
  manual?: { list: ChecklistKey; ownerId: string; itemKey: string; note: string; auto: boolean }; // ticked by hand
  gate?: { key: string; overridable: boolean; override: GateOverride | null }; // a Development hard gate
  dismissed?: { note: string; byPersonId: string; at: string } | null; // a suggestion set aside, with its note
}

export interface Checks {
  ownerId: string; // the project, session, episode or call sheet the checks are for
  projectId: string;
  required: CheckItem[]; // still needed to move on
  suggestions: CheckItem[]; // never block
  completed: CheckItem[]; // done, passed by hand, or dismissed
}

const projectOf = (id: string): Project | undefined => {
  const r = getRecord(id);
  return r?.workflow ? (r as Project) : undefined;
};

/** The project an owner's checks are kept on: itself, a session's or an episode's project, a call sheet's session's. */
function projectFor(ownerId: string): Project | undefined {
  const direct = projectOf(ownerId);
  if (direct) return direct;
  const session = getSession(ownerId);
  if (session) return projectOf(session.contentId);
  const ep = getRecord(ownerId);
  if (ep?.episode && ep.parentId) return projectOf(ep.parentId);
  const sheet = getDb().callSheets.find((c) => c.id === ownerId);
  if (sheet) {
    const s = getDb().recordingSessions.find((x) => x.callSheetId === sheet.id);
    return s ? projectOf(s.contentId) : projectOf(sheet.contentId);
  }
  return undefined;
}

function finish(ownerId: string, projectId: string, items: CheckItem[]): Checks {
  const dismissed = projectOf(projectId)?.workflow.dismissedChecks ?? {};
  for (const i of items) if (i.group === "suggestion") i.dismissed = dismissed[`${ownerId}|${i.key}`] ?? null;
  return {
    ownerId,
    projectId,
    required: items.filter((i) => i.group === "required" && !i.done),
    suggestions: items.filter((i) => i.group === "suggestion" && !i.done && !i.dismissed),
    completed: items.filter((i) => i.done || !!i.dismissed),
  };
}

/** A check given as a sentence (a gate's missing item or warning). */
const fromText = (text: string, group: CheckGroup, prefix: string): CheckItem => {
  const [head, ...rest] = text.split(": ");
  const split = rest.length > 0 && head.length <= 40;
  return {
    key: `${prefix}:${text}`,
    group,
    label: split ? head : text,
    reason: split ? rest.join(": ") : "",
    done: false,
    go: goForText(text),
  };
};

/** A checklist's items as rows: manual ones are ticked in the panel, auto ones are worked out and shown read-only. */
function manualRows(list: ChecklistKey, ownerId: string, auto: Record<string, [boolean, string]> = {}): CheckItem[] {
  const def = CHECKLISTS[list];
  const stored = checklistItems(list, ownerId);
  return def.items.map((i) => {
    const row: WorkflowChecklistItem | undefined = stored.find((c) => c.itemKey === i.key);
    const a = auto[i.key];
    return {
      key: `${list}:${i.key}`,
      group: i.required ? "required" : "suggestion",
      label: i.label,
      reason: i.auto ? (a?.[1] ?? "Done by the app") : (row?.note ?? ""),
      done: i.auto ? !!a?.[0] : !!row?.done,
      go: null,
      manual: { list, ownerId, itemKey: i.key, note: row?.note ?? "", auto: !!i.auto },
    };
  });
}

/** The lists a gate names its manual items by ("Wrap: Gear returned to storage"), so they are ticked in the panel. */
const MANUAL_PREFIX: Record<string, ChecklistKey> = {
  "Pre-production": "preProject",
  Session: "preSession",
  Wrap: "wrap",
  "Release plan": "release",
};

/** A gate's sentence as the manual item it names, if it names one: ticked in the panel, with its note. */
function asManual(text: string, group: CheckGroup, owners: { project: string; session?: string; episode?: string }): CheckItem | null {
  const at = text.indexOf(": ");
  const list = at > 0 ? MANUAL_PREFIX[text.slice(0, at)] : undefined;
  if (!list) return null;
  const def = CHECKLISTS[list];
  const ownerId = def.owner === "project" ? owners.project : def.owner === "session" ? owners.session : owners.episode;
  const key = def.items.find((i) => i.label === text.slice(at + 2) && !i.auto)?.key;
  if (!ownerId || !key) return null;
  const row = manualRows(list, ownerId).find((r) => r.manual?.itemKey === key);
  return row ? { ...row, group } : null;
}

/** "Theological review not done": a suggestion while it is not approved, never a block. */
function theologyItem(p: Project): CheckItem[] {
  if (!hasTheologicalReview(p) || theologyStatus(p.contentId).done) return [];
  return [
    {
      key: "theology",
      group: "suggestion",
      label: "Theological review not done",
      reason: theologyStatus(p.contentId).detail,
      done: false,
      go: { doc: { stage: "Development", key: "theological_review" } },
    },
  ];
}

/** A project's checks, at its stage: Development (its hard gates, nudges and handoff), or Pre-production. */
export function projectChecks(projectId: string): Checks {
  const p = projectOf(projectId);
  if (!p) return finish(projectId, projectId, []);
  const items: CheckItem[] = [];
  if (p.workflow.stage === "Development") {
    const brief = briefKeyOf(p.workflow.formType);
    for (const g of hardGates(projectId)) {
      const go = GATE_GO[g.key] ?? null;
      items.push({
        key: `gate:${g.key}`,
        group: "required",
        label: g.label,
        reason: g.override ? `Passed by hand: ${g.override.note}` : g.detail,
        done: g.met || !!g.override,
        go: go?.doc?.key === "brief" ? { doc: { stage: "Development", key: brief } } : go,
        gate: { key: g.key, overridable: g.overridable, override: g.override },
      });
    }
    // The handoff's own items are ticked here; the nudge that repeats them is left out.
    items.push(
      ...manualRows("handoff", projectId, {
        producer_named: [!!p.workflow.showProducerId, p.workflow.showProducerId ? "Named" : "Named with the greenlight"],
        project_created: [true, p.contentId],
      }).map((i) => ({ ...i, group: "suggestion" as const })),
    );
    for (const n of softNudges(projectId))
      if (!n.startsWith("Handoff:")) items.push({ ...fromText(n, "suggestion", "nudge"), label: n, reason: "" });
  } else if (p.workflow.stage === "Pre-production" && !p.archived) {
    const gate = evaluateGate("Pre-production", "project", projectId);
    for (const m of gate.missing) if (!m.startsWith("Pre-production: ")) items.push(fromText(m, "required", "need"));
    for (const w of gate.warnings) items.push(fromText(w, "suggestion", "warn"));
    const roles = getDb().projectRoles.filter((r) => r.contentId === projectId);
    items.push(
      ...manualRows("preProject", projectId, {
        roles_assigned: [roles.length > 0 && !gate.missing.some((m) => m.startsWith("Role")), "From the Recording Plan's roles"],
      }),
    );
  }
  items.push(...theologyItem(p));
  return finish(projectId, projectId, items);
}

/** A session's checks: getting ready to record (Pre-production), or closing it (Production), with its Recording Log's. */
export function sessionChecks(sessionId: string): Checks {
  const s = getSession(sessionId);
  const p = s ? projectOf(s.contentId) : undefined;
  if (!s || !p) return finish(sessionId, s?.contentId ?? sessionId, []);
  const items: CheckItem[] = [];
  if (s.status !== "Closed" && !s.archivedAt) {
    const gate = evaluateGate(s.status === "Planned" ? "Pre-production" : "Production", "session", sessionId);
    const owners = { project: p.contentId, session: sessionId };
    for (const m of gate.missing) items.push(asManual(m, "required", owners) ?? fromText(m, "required", "need"));
    for (const w of gate.warnings) items.push(asManual(w, "suggestion", owners) ?? fromText(w, "suggestion", "warn"));
  }
  items.push(...theologyItem(p));
  return finish(sessionId, p.contentId, items);
}

/**
 * A Recording Log's own checks, for the count chip in its header: rows with no take mark, at least one item recorded,
 * and the storage. While the session is open they are the Production gate's own (so a dismissal is shared with the
 * session's panel); before and after, the storage only.
 */
export function recordingLogChecks(sessionId: string): Checks {
  const s = getSession(sessionId);
  if (!s) return finish(sessionId, sessionId, []);
  const storage = storageWarnings(sessionId);
  const mine = (t: string) => /^No take mark for|^At least one item recorded/.test(t) || storage.includes(t);
  const items: CheckItem[] = [];
  if (s.status === "Open" && !s.archivedAt) {
    const gate = evaluateGate("Production", "session", sessionId);
    for (const m of gate.missing) if (mine(m)) items.push(fromText(m, "required", "need"));
    for (const w of gate.warnings) if (mine(w)) items.push(fromText(w, "suggestion", "warn"));
  } else for (const w of storage) items.push(fromText(w, "suggestion", "warn"));
  return finish(sessionId, s.contentId, items);
}

/** An episode's checks at its step: editing, the reviews of the cut, or publishing. */
export function episodeChecks(episodeId: string): Checks {
  const ep = getRecord(episodeId);
  const p = ep?.parentId ? projectOf(ep.parentId) : undefined;
  if (!ep?.episode || !p) return finish(episodeId, p?.contentId ?? episodeId, []);
  const items: CheckItem[] = [];
  const info = ep.episode;
  const stage =
    info.mdStage === "Published"
      ? null
      : info.stage === "Post production"
        ? info.postStage === "Editing"
          ? "Editing"
          : info.postStage === "Approved" || info.postStage === "Rough cut review" || info.postStage === "Final review"
            ? "Post production"
            : null
        : "Marketing and distribution";
  if (stage) {
    const gate = evaluateGate(stage, "episode", episodeId);
    const owners = { project: p.contentId, episode: episodeId };
    for (const m of gate.missing) items.push(asManual(m, "required", owners) ?? fromText(m, "required", "need"));
    for (const w of gate.warnings) items.push(fromText(w, "suggestion", "warn"));
  }
  items.push(...theologyItem(p));
  return finish(episodeId, p.contentId, items);
}

/** A call sheet's checks, for the chip in its header: what it is missing (warnings only: they never block). */
export function callSheetChecks(sheetId: string): Checks {
  const cs = getDb().callSheets.find((c) => c.id === sheetId);
  if (!cs) return finish(sheetId, sheetId, []);
  const p = projectFor(sheetId);
  const items: CheckItem[] = sheetWarnings(cs, todayIso()).map((w) => ({
    key: `sheet:${w.section}:${w.text}`,
    group: "suggestion" as const,
    label: w.text.replace(/\.$/, ""),
    reason: "",
    done: false,
    go: { anchor: `sec-${w.section}` },
  }));
  return finish(sheetId, p?.contentId ?? cs.contentId, items);
}

/** Counts in words, for the slim bar: "2 required, 4 suggestions", or "All clear". */
export function checksSummary(c: Checks): string {
  if (!c.required.length && !c.suggestions.length) return "All clear";
  const parts = [];
  if (c.required.length) parts.push(`${c.required.length} required`);
  if (c.suggestions.length) parts.push(`${c.suggestions.length} suggestion${c.suggestions.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// ── Changes from the panel ───────────────────────────────────

/** Sets a suggestion aside, with an optional note. It is kept on the project, for everyone, and can be brought back. */
export function dismissCheck(actor: Actor, ownerId: string, key: string, note = ""): void {
  const p = projectFor(ownerId);
  if (!p) throw new RuleError("That check's project no longer exists.");
  projectForWrite(actor, p.contentId);
  const text = note.trim();
  if (text.length > 300) throw new RuleError("Keep the note under 300 characters.");
  p.workflow.dismissedChecks = {
    ...(p.workflow.dismissedChecks ?? {}),
    [`${ownerId}|${key}`]: { note: text, byPersonId: actor.personId, at: new Date().toISOString() },
  };
  p.version += 1;
  logAudit(actor, "check-dismiss", "record", p.contentId, `${key.replace(/^[a-z]+:/, "")}${text ? `: ${text}` : ""}`);
  commit();
}

/** Brings a dismissed suggestion back. */
export function restoreCheck(actor: Actor, ownerId: string, key: string): void {
  const p = projectFor(ownerId);
  if (!p) throw new RuleError("That check's project no longer exists.");
  projectForWrite(actor, p.contentId);
  const next = { ...(p.workflow.dismissedChecks ?? {}) };
  delete next[`${ownerId}|${key}`];
  p.workflow.dismissedChecks = next;
  p.version += 1;
  logAudit(actor, "check-restore", "record", p.contentId, key.replace(/^[a-z]+:/, ""));
  commit();
}

/** Ticks a manual check (a handoff or Pre-production item) in the panel, with its note; the item is made if new. */
export function setCheck(
  actor: Actor,
  list: ChecklistKey,
  ownerId: string,
  itemKey: string,
  change: { done?: boolean; note?: string },
): WorkflowChecklistItem {
  const def = CHECKLISTS[list];
  const item = def.items.find((i) => i.key === itemKey);
  if (!item || item.auto) throw new RuleError("That check is worked out by the app.");
  if (def.owner === "project") projectForWrite(actor, ownerId);
  ensureChecklist(list, def.owner, ownerId);
  return setChecklistItem(actor, `${ownerId}|${def.stage}|${itemKey}`, change);
}

/** Whether a kind's Development is accepted rather than greenlit (a devotion), for the panel's words. */
export const acceptsAtDevelopment = (p: Project): boolean => catalogTypeOf(p.workflow.formType) === "devotion";
