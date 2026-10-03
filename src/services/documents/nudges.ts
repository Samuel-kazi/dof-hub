import { briefKeyOf, catalogEntry, catalogTypeOf } from "../../config/documentCatalog";
import { textOf } from "../html";
import { openRequired } from "../workflow/common";
import { formProblems } from "../workflow/forms";
import { plannedOf } from "../workflow/planned";
import { documentHasContent, pagesOf, projectOf } from "./common";
import { documentOf } from "./pages";

// Everything a project's Development might still want, once its documents are in use, as short notes: shown beside
// the gate, each one dismissible, and never blocking (./gates.ts holds the few things that do block).

// What the hard gates already cover, so it is not said twice.
const GATED = new Set(["Brief: Logline", "Brief: Core question or tension", "Guest: Name", "Guest: Contact"]);
// Sections kept on the form: the header strip and the consent form. The rest of the earlier form now lives in the documents.
const KEPT_SECTIONS = ["Entry", "Guest", "Consent and release"];

/** Short notes on what is not written or done yet. */
export function softNudges(projectId: string): string[] {
  const p = projectOf(projectId);
  const formType = p.workflow.formType;
  const out: string[] = [];
  for (const problem of formProblems(projectId, 1)) {
    if (GATED.has(problem)) continue;
    if (KEPT_SECTIONS.some((s) => problem.startsWith(`${s}:`))) out.push(`${problem} not filled in yet`);
  }
  const briefKey = briefKeyOf(formType);
  const brief = documentOf(projectId, "Development", briefKey);
  const briefTitle = catalogEntry(formType, "Development", briefKey)?.title ?? "brief";
  if (catalogTypeOf(formType) === "devotion") {
    if (!brief) out.push(`The ${briefTitle} is not started yet`);
    return out;
  }
  if (!brief) out.push(`The ${briefTitle} is not started yet`);
  else
    for (const page of pagesOf(brief.id)) if (!textOf(page.bodyHtml)) out.push(`${brief.title}: ${page.title || "a page"} not written yet`);
  const greenlight = documentOf(projectId, "Development", "greenlight");
  if (!greenlight || !documentHasContent(greenlight.id)) out.push("Greenlight: the six criteria not written up yet");
  if (plannedOf(projectId).length === 0)
    out.push(catalogTypeOf(formType) === "documentary" ? "No planned parts listed yet" : "No planned episodes listed yet");
  out.push(...openRequired("handoff", projectId).map((l) => `Handoff: ${l} not ticked yet`));
  return out;
}
