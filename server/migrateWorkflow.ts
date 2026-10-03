import { z } from "zod";
import type { Store } from "./stores";
import { changeAllData } from "./state";
import { HttpError } from "./errors";
import type { Authed } from "./accounts";
import { isHop } from "../src/services/access";
import { todayIso } from "../src/services/utils";
import type { MigrationChoices } from "../src/data/migrateWorkflow";
import { moveToNewSystem, type AppliedMigrationReport } from "../src/data/moveToNewSystem";
import { undoDocumentMove } from "../src/data/migrateDocuments";

// Moving the existing series, devotionals and documentaries into the five-stage workflow, on the server: from the
// command line (scripts/migrate-workflow.ts) and, for the Head of Production, from Settings on the hosted site.
// A dry run reads the data and reports; applying keeps a copy of all the data first (hub_items_before_workflow and
// hub_meta_before_workflow in MongoDB), then saves the move as one all-or-nothing change.

export type { MigrationChoices };

export type ServerMigrationReport = AppliedMigrationReport;

const choices = z
  .object({
    seriesTypes: z.record(z.string().max(120), z.enum(["podcast", "testimonial", "sermon"])).optional(),
    documentaryForms: z.record(z.string().max(120), z.enum(["documentary_dof", "documentary_pitched"])).optional(),
  })
  .strict();

/** The choices a person sent, checked: a series type or documentary kind per Content ID, nothing else. */
export function parseChoices(body: unknown): MigrationChoices {
  const r = choices.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, "Those choices are not valid.");
  return r.data;
}

export async function migrateWorkflowStore(
  store: Store,
  apply: boolean,
  byPersonId: string,
  picked: MigrationChoices = {},
): Promise<ServerMigrationReport | null> {
  const at = new Date().toISOString();
  const r = await changeAllData(store, apply, "before_workflow", (db) =>
    moveToNewSystem(db, { ...picked, today: todayIso(), at, byPersonId }),
  );
  if (!r) return null;
  // The counts come from the database itself, part by part, so they include what people are not sent.
  return {
    ...r.result,
    counts: r.parts.map((p) => ({ part: p.part, before: p.before, after: p.after })),
    applied: r.applied,
    backup: r.backup,
  };
}

/**
 * Undoes the move of the Development forms into documents (src/data/migrateDocuments.ts): removes what it wrote, and
 * nothing else. A document written in since is kept unless `force`. A copy of all the data is kept first, as for the move.
 */
export async function undoDocumentMoveStore(store: Store, apply: boolean, force = false) {
  return changeAllData(store, apply, "before_undo_documents", (db) => undoDocumentMove(db, force));
}

/** POST /api/migrate-workflow: the Head of Production only. `apply: true` moves; anything else is a dry run. */
export async function migrateWorkflowRequest(store: Store, who: Authed, body: Record<string, unknown>): Promise<ServerMigrationReport> {
  if (!isHop(who.actor)) throw new HttpError(403, "Only the Head of Production can move the existing projects into the new workflow.");
  const { apply, ...rest } = body;
  if (apply !== undefined && typeof apply !== "boolean") throw new HttpError(400, "Those choices are not valid.");
  const report = await migrateWorkflowStore(store, apply === true, who.actor.personId, parseChoices(rest));
  if (!report) throw new HttpError(503, "The app has not been set up yet.");
  if (apply === true && report.changed && !report.applied)
    throw new HttpError(409, "Someone saved a change at the same moment. Try again.");
  return report;
}
