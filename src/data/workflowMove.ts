import type { Actor } from "../types";
import { RuleError } from "../types";
import { commit, getDb, keepCopyOfData, transaction } from "./store";
import { isHop } from "../services/access";
import { todayIso } from "../services/utils";
import { migrateToWorkflow, type AppliedMigrationReport, type MigrationChoices, type WorkflowMigrationReport } from "./migrateWorkflow";

// Moving the existing projects into the five-stage workflow in the desktop app and the demo, where the data is kept
// on this computer. The hosted site does it on the server instead (src/data/remote.ts, server/migrateWorkflow.ts).

/** Where the copy of the data is kept before moving: localStorage, next to the data itself. */
export const MOVE_COPY_LABEL = "before-workflow";

/** What moving would do now, worked out on a copy. Nothing changes. */
export function previewMove(actor: Actor, picked: MigrationChoices): WorkflowMigrationReport {
  return migrateToWorkflow(structuredClone(getDb()), {
    ...picked,
    today: todayIso(),
    at: new Date().toISOString(),
    byPersonId: actor.personId,
  });
}

/** Moves them: a copy of the data is kept first, and the move is all or nothing. The Head of Production only. */
export function applyMoveLocally(actor: Actor, picked: MigrationChoices): AppliedMigrationReport {
  if (!isHop(actor)) throw new RuleError("Only the Head of Production can move the existing projects into the new workflow.");
  const preview = previewMove(actor, picked);
  if (!preview.changed) return { ...preview, applied: false, backup: null };
  const backup = keepCopyOfData(MOVE_COPY_LABEL);
  if (!backup) throw new RuleError("There is no room on this computer to keep a copy of the data first, so nothing was moved.");
  const report = transaction(() => {
    const r = migrateToWorkflow(getDb(), { ...picked, today: todayIso(), at: new Date().toISOString(), byPersonId: actor.personId });
    commit();
    return r;
  });
  return { ...report, applied: true, backup };
}
