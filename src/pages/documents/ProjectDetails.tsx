import type { DocumentPage, ProjectDocument } from "../../types";
import { sectionOf } from "../../config/devForms";
import { catalogEntry } from "../../config/documentCatalog";
import { getDb } from "../../data/store";
import { saveFormSection, formProblems, type Project } from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { Field } from "../../ui/parts";
import { SectionEditor } from "../workflow/Development";
import { FieldInput, useDraft } from "../workflow/common";

// What stays a structured form while the writing moves into documents: the header strip (who brought the idea, when,
// its owner and mandate, and a devotion's guest), a sermon's delivery, and the two fields of the brief the first gate
// reads (the logline and the core question), shown at the top of The idea.

/** Some fields of one section of the development form, with a Save button. */
export function FormFields({
  project,
  sectionKey,
  keys,
  write,
  label,
}: {
  project: Project;
  sectionKey: string;
  keys: string[];
  write: boolean;
  label: string;
}) {
  const { actor, attempt } = useApp();
  const section = sectionOf(project.workflow.formType, sectionKey);
  const form = getDb().developmentForms.find((f) => f.contentId === project.contentId);
  const stored = Object.fromEntries(keys.map((k) => [k, form?.sections[sectionKey]?.[k] ?? ""])) as Record<string, unknown>;
  const [draft, setDraft, dirty, saved] = useDraft(stored);
  const defs = keys.map((k) => section?.fields.find((f) => f.key === k)).filter((f) => !!f);
  if (!section || !defs.length) return null;
  const save = () => {
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== stored[k]));
    if (attempt(() => saveFormSection(actor, project.contentId, sectionKey, changed), `${label} saved`)) saved();
  };
  return (
    <section className="pd-fields" aria-label={label}>
      <div className="wf-fields">
        {defs.map((f) => (
          <Field key={f.key} label={f.label}>
            <FieldInput def={f} value={draft[f.key]} disabled={!write} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
          </Field>
        ))}
      </div>
      {write && (
        <div className="wf-actions">
          <button className="btn small primary" disabled={!dirty} onClick={save}>
            Save {label.toLowerCase()}
          </button>
          {dirty && <span className="muted">Not saved yet.</span>}
        </div>
      )}
    </section>
  );
}

/** The header strip: the project's entry details, a devotion's guest, and a sermon's delivery. Folded until opened. */
export function ProjectDetails({ project, write }: { project: Project; write: boolean }) {
  const formType = project.workflow.formType;
  const form = getDb().developmentForms.find((f) => f.contentId === project.contentId);
  if (!form) return null;
  const sections = ["entry", "guest"].map((k) => sectionOf(formType, k)).filter((s) => !!s);
  const problems = formProblems(project.contentId, 1);
  const missing = sections.reduce((n, s) => n + problems.filter((m) => m.startsWith(`${s.label}:`)).length, 0);
  return (
    <details className="glass panel pd-details">
      <summary>
        <h2>Project details</h2>
        <span className="muted">{sections.map((s) => s.label).join(", ")}</span>
        {missing ? <span className="badge warn">{missing} to fill in</span> : <span className="badge ok">Complete</span>}
      </summary>
      <div className="stack">
        {sections.map((s) => (
          <SectionEditor key={s.key} project={project} section={s} write={write && !project.archived} open />
        ))}
        {formType === "sermon" && <FormFields project={project} sectionKey="brief" keys={["delivery"]} write={write} label="Delivery" />}
      </div>
    </details>
  );
}

/**
 * The structured fields a document shows at the top of one of its pages (the brief's logline and core question, on The
 * idea), with their values: for the review and for printing, where the page is read rather than written. The page of
 * that title carries them, or the first page if it has been renamed.
 */
export function pageFields(project: Project, doc: ProjectDocument, page: DocumentPage, pages: DocumentPage[]): [string, string][] {
  const entry = catalogEntry(project.workflow.formType, doc.stage, doc.docKey);
  const carrier = entry?.pages?.find((p) => p.fields?.length);
  if (!carrier?.fields) return [];
  const target = pages.find((p) => p.title === carrier.title) ?? pages[0];
  if (target?.id !== page.id) return [];
  const form = getDb().developmentForms.find((f) => f.contentId === project.contentId);
  return carrier.fields.map((f) => [f.label, String(form?.sections[f.section]?.[f.key] ?? "").trim()]);
}
