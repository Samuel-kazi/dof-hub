import type { Database } from "../types";
import { logId } from "./ids";
import { countParts, migrateToWorkflow, type WorkflowMigrationOptions, type WorkflowMigrationReport } from "./migrateWorkflow";
import { migrateDocuments, type DocumentMigrationReport } from "./migrateDocuments";

// Moving old data to the new system, in one go: projects made before the five-stage workflow into it
// (src/data/migrateWorkflow.ts), then every project's old Development form into its documents
// (src/data/migrateDocuments.ts). One dry run reports both; applying does both as one all-or-nothing change, after a
// copy of all the data is kept. Running it again changes nothing.

export interface MoveReport extends WorkflowMigrationReport {
  documents: DocumentMigrationReport;
}

/** A report from a run that may have applied the move: where the copy of the data was kept, if it did. */
export interface AppliedMigrationReport extends MoveReport {
  applied: boolean;
  backup: string | null;
}

export function moveToNewSystem(db: Database, options: WorkflowMigrationOptions): MoveReport {
  const before = countParts(db);
  const workflow = migrateToWorkflow(db, options);
  const documents = migrateDocuments(db, { at: options.at });
  if (documents.changed) {
    const projects = documents.lines.filter((l) => l.documents.length).length;
    db.audit.push({
      id: logId("A"),
      at: options.at,
      byPersonId: options.byPersonId,
      action: "migrate-documents",
      entity: "system",
      entityId: "documents",
      detail: `The Development forms of ${projects} project${projects === 1 ? "" : "s"} moved into their documents.`,
    });
  }
  const after = countParts(db);
  const parts = [...new Set([...before.keys(), ...after.keys()])];
  return {
    ...workflow,
    documents,
    changed: workflow.changed || documents.changed,
    counts: parts.map((part) => ({ part, before: before.get(part) ?? 0, after: after.get(part) ?? 0 })),
  };
}

/** The documents part of the report as lines of text, for the command line. */
export function describeDocumentMove(r: DocumentMigrationReport): string {
  const moved = r.lines.filter((l) => l.documents.length);
  return [
    `Development forms moved into documents (${moved.length}):`,
    ...(moved.length
      ? moved.map(
          (l) =>
            `  ${l.contentId.padEnd(22)} ${l.documents.join(", ")}: ${l.fields} field${l.fields === 1 ? "" : "s"}${l.note ? `. ${l.note}` : ""}`,
        )
      : ["  None."]),
    ...r.lines.filter((l) => !l.documents.length).map((l) => `  ${l.contentId.padEnd(22)} ${l.note}`),
    `Fields kept on the form, as structured fields: ${r.kept.length}`,
    ...(r.extras.length
      ? [
          `Fields the mapping does not know, written on "Also from the old form": ${r.extras.map((e) => `${e.contentId} ${e.field}`).join("; ")}`,
        ]
      : []),
    `Fields not accounted for: ${r.unaccounted.length}${r.unaccounted.length ? ` (${r.unaccounted.join(", ")})` : ""}`,
  ].join("\n");
}
