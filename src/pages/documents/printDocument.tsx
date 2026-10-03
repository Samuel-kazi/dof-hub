import { useState } from "react";
import { createPortal } from "react-dom";
import type { DocumentPage, ProjectDocument } from "../../types";
import { cleanHtml } from "../../services/html";
import { fmtDate, todayIso } from "../../services/utils";

// Printing a page, or a whole document, on paper or to PDF through the browser's own print: the pages alone, without
// the app around them, each document page starting on a new sheet. It uses the same print root as the app's reports
// (#print-root, shown only while printing).

export interface PrintJob {
  projectTitle: string;
  contentId: string;
  doc: ProjectDocument;
  pages: DocumentPage[];
  /** Structured fields printed at the top of a page, by page: the brief's logline and core question. */
  fields?: Record<string, [string, string][]>;
}

function PrintedDocument({ job }: { job: PrintJob }) {
  return (
    <article className="pd-print">
      <header className="pd-print-head">
        <div>
          {job.projectTitle} · {job.contentId}
        </div>
        <div>
          {job.doc.title} · printed {fmtDate(todayIso())}
        </div>
      </header>
      {job.pages.map((p) => (
        <section key={p.id} className="pd-print-page">
          <h1>{p.title}</h1>
          {p.subtitle && <p className="pd-print-sub">{p.subtitle}</p>}
          {(job.fields?.[p.id] ?? []).map(([label, value]) => (
            <p key={label} className="pd-print-field">
              <strong>{label}:</strong> {value || "Not written yet"}
            </p>
          ))}
          {/* Cleaned to the editor's allow-list, as on every load. */}
          <div className="pd-prose" dangerouslySetInnerHTML={{ __html: cleanHtml(p.bodyHtml) }} />
        </section>
      ))}
    </article>
  );
}

/** A print button's helper: call print(job) to print it; render the returned node somewhere on the page. */
export function usePrintDocument(): [(job: PrintJob) => void, React.ReactNode] {
  const [job, setJob] = useState<PrintJob | null>(null);
  const print = (next: PrintJob) => {
    setJob(next);
    // Let the pages draw, then open the print dialog.
    setTimeout(() => {
      document.body.classList.add("printing-report");
      const done = () => {
        document.body.classList.remove("printing-report");
        setJob(null);
        window.removeEventListener("afterprint", done);
      };
      window.addEventListener("afterprint", done);
      window.print();
    }, 150);
  };
  const node =
    job && typeof document !== "undefined"
      ? createPortal(
          <div id="print-root">
            <PrintedDocument job={job} />
          </div>,
          document.body,
        )
      : null;
  return [print, node];
}
