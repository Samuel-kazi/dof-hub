import type { Actor, RecordingSession } from "../../types";
import { getDb } from "../../data/store";
import { catalogEntry } from "../../config/documentCatalog";
import { cleanHtml, escapeHtml, textToHtml } from "../html";
import { addPage, ensureDocument } from "../documents/pages";
import { pagesOf } from "../documents/common";
import { nowStamp, rowsOf, type Project } from "./common";
import { sessionName } from "./plan";

// When a session closes, what the editor must know goes into the project's Edit Notes (build prompt v4, section 7A):
// the items marked Pickup needed, with their notes, and the session's issues. One page per session, named for it, so
// closing again after a reopen rewrites that page rather than adding another.

/** Writes a session's pickups and issues into Edit Notes. Nothing to say, or no Edit Notes for the kind: nothing. */
export function carryToEditNotes(actor: Actor, project: Project, session: RecordingSession): string | null {
  const pickups = rowsOf(session.id).filter((r) => r.status === "Pickup needed");
  const issues = (session.issues ?? "").trim();
  if (!pickups.length && !issues) return null;
  if (!catalogEntry(project.workflow.formType, "Post production", "edit_notes")) return null;
  const doc = ensureDocument(actor, project.contentId, "Post production", "edit_notes");
  const title = `Pickups and issues: ${sessionName(session)}`;
  const page = pagesOf(doc.id).find((p) => p.title === title) ?? addPage(actor, doc.id, { title });
  const planned = new Map(getDb().plannedEpisodes.map((p) => [p.id, p.workingTitle]));
  const items = pickups
    .map((r) => {
      const what = (r.plannedEpisodeId && planned.get(r.plannedEpisodeId)) || r.itemLabel || r.plannedEpisodeId || "An item";
      return `<li><strong>${escapeHtml(what)}</strong>${r.notesForPost ? `: ${escapeHtml(r.notesForPost)}` : ""}</li>`;
    })
    .join("");
  page.subtitle = `${session.id}${session.scheduledDate ? `, ${session.scheduledDate}` : ""}`;
  page.bodyHtml = cleanHtml(
    `${pickups.length ? `<p><strong>Pickups needed</strong></p><ul>${items}</ul>` : ""}${issues ? `<p><strong>Issues</strong></p>${textToHtml(issues)}` : ""}`,
  );
  page.version += 1;
  page.updatedAt = nowStamp();
  page.updatedBy = actor.personId;
  return doc.id;
}
