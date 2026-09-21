import { useState } from "react";
import { RuleError } from "../types";
import { useApp } from "./AppContext";
import { Modal } from "./Modal";
import { Field } from "./parts";
import { canExport, buildReport, reportToText, reportsFor, type Params, type ReportScope } from "../services/reports";
import { reportToPdf } from "../services/pdf";
import { saveFile } from "../services/download";

type Format = "pdf" | "print" | "copy";

/** Choose which report you want and what to do with it. The app says when it is done. */
export function ReportDialog({ scope, params = {}, onClose }: { scope: ReportScope; params?: Params; onClose: () => void }) {
  const { actor, notify, toast, printReport } = useApp();
  const kinds = reportsFor(scope);
  const [key, setKey] = useState(kinds[0]?.key ?? "");
  const kind = kinds.find((k) => k.key === key);
  const [opts, setOpts] = useState<Params>({});
  const [busy, setBusy] = useState<Format | null>(null);
  const value = (f: { key: string; default: string | boolean }) => opts[f.key] ?? params[f.key] ?? f.default;

  const run = async (format: Format) => {
    if (!kind) return;
    setBusy(format);
    try {
      const merged: Params = { ...params, ...Object.fromEntries((kind.fields ?? []).map((f) => [f.key, value(f)])) };
      const report = buildReport(actor, kind.key, merged);
      if (format === "pdf") {
        const saved = await saveFile(`${report.filename}.pdf`, await reportToPdf(report));
        if (!saved) { setBusy(null); return; } // the person cancelled the save dialog
        notify("Report downloaded", saved.how === "saved" ? `${report.title} was saved to ${saved.where}.` : `${report.title} was saved as ${saved.where}. Look in your Downloads folder.`);
      } else if (format === "print") {
        printReport(report);
        notify("Report sent to print", `${report.title} is ready to print.`);
      } else {
        await navigator.clipboard.writeText(reportToText(report));
        notify("Report copied", `${report.title} is copied. Paste it wherever you need it.`);
      }
      onClose();
    } catch (e) {
      toast(e instanceof RuleError ? e.message : "The report could not be made. Nothing was changed.", "error");
      setBusy(null);
    }
  };

  if (!canExport(actor)) {
    return <Modal title="Reports" onClose={onClose} actions={<button className="btn" onClick={onClose}>Close</button>}><p>You do not have permission to produce reports. Ask the Head of Production for access.</p></Modal>;
  }

  return (
    <Modal
      title="Create a report"
      onClose={onClose}
      actions={
        busy ? <span className="muted" role="status" style={{ marginRight: "auto" }}>Preparing your report…</span> : (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn" onClick={() => run("copy")}>Copy as text</button>
            <button className="btn" onClick={() => run("print")}>Print</button>
            <button className="btn primary" onClick={() => run("pdf")}>Download PDF</button>
          </>
        )
      }
    >
      <div className="stack">
        {kinds.length > 1 && (
          <div className="stack" role="radiogroup" aria-label="Kind of report" style={{ gap: 8 }}>
            {kinds.map((k) => (
              <label key={k.key} className={`report-choice ${k.key === key ? "on" : ""}`}>
                <input type="radio" name="report-kind" checked={k.key === key} onChange={() => setKey(k.key)} />
                <span><b>{k.label}</b><br /><span className="muted" style={{ fontSize: ".86rem" }}>{k.description}</span></span>
              </label>
            ))}
          </div>
        )}
        {kinds.length === 1 && kind && <p className="muted">{kind.description}</p>}
        {kind?.fields?.map((f) => f.kind === "select" ? (
          <Field key={f.key} label={f.label}>
            <select value={String(value(f))} onChange={(e) => setOpts({ ...opts, [f.key]: e.target.value })}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          </Field>
        ) : (
          <label key={f.key} className="check"><input type="checkbox" checked={!!value(f)} onChange={(e) => setOpts({ ...opts, [f.key]: e.target.checked })} /> {f.label}</label>
        ))}
      </div>
    </Modal>
  );
}

/** A button that opens the report dialog. It is not shown to people who may not produce reports. */
export function ReportButton({ scope, params, label = "Report…", small = false, ghost = false }: { scope: ReportScope; params?: Params; label?: string; small?: boolean; ghost?: boolean }) {
  const { actor } = useApp();
  const [open, setOpen] = useState(false);
  if (!canExport(actor)) return null;
  return (
    <>
      <button className={`btn ${small ? "small" : ""} ${ghost ? "ghost" : ""} no-print`} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{label}</button>
      {open && <ReportDialog scope={scope} params={params} onClose={() => setOpen(false)} />}
    </>
  );
}
