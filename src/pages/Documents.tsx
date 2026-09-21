import { useEffect, useRef, useState } from "react";
import { ReportButton } from "../ui/ReportDialog";
import { buildReport } from "../services/reports";
import { reportToPdf } from "../services/pdf";
import { saveFile } from "../services/download";
import { ConflictError, RuleError } from "../types";
import { useApp } from "../ui/AppContext";
import { getDb, useDb } from "../data/store";
import { DOC_TEMPLATES } from "../config/docTemplates";
import { Modal } from "../ui/Modal";
import { Empty, Field } from "../ui/parts";
import { IconPlus } from "../ui/Icons";
import { MiniMarkdown, toggleCheckLine } from "../ui/MiniMarkdown";
import { joinSections, parseSections, type ParsedDoc } from "../config/docTemplates";
import { canWrite, getRecord } from "../services/access";
import { archiveDoc, canEditDoc, canViewDoc, createDoc, diffLines, getDoc, listDocs, restoreRevision, revisionsOf, saveDoc } from "../services/docs";
import { nameOf } from "../services/people";
import { fmtDateTime, relativeDays } from "../services/utils";

export function NewDocModal({ contentId, onClose, onCreated }: { contentId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { actor, attempt } = useApp();
  const projects = getDb().records.filter((r) => !r.archived && canWrite(actor, r)).sort((a, b) => a.contentId.localeCompare(b.contentId));
  const [project, setProject] = useState(contentId ?? projects[0]?.contentId ?? "");
  const [template, setTemplate] = useState("");
  const [title, setTitle] = useState("");
  const save = () => {
    const d = attempt(() => createDoc(actor, { contentId: project, title, templateKey: template || null }), "Document created");
    if (d) onCreated(d.id);
  };
  return (
    <Modal title="New document" onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Create</button></>}>
      <div className="stack">
        {!contentId && (
          <Field label="Project or episode">
            <select value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.contentId} value={p.contentId}>{p.title}, {p.contentId}</option>)}</select>
          </Field>
        )}
        <Field label="Start from">
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Blank document</option>
            {DOC_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}
          </select>
        </Field>
        <Field label="Title (optional for templates)"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leave empty to name it after the template" /></Field>
      </div>
    </Modal>
  );
}

export function Documents() {
  const { actor, go } = useApp();
  useDb();
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [adding, setAdding] = useState(false);
  const all = listDocs(actor);
  const projects = [...new Set(all.map((d) => d.contentId))];
  const shown = all.filter((d) => (!project || d.contentId === project) && (!q.trim() || `${d.title} ${d.id} ${d.contentId}`.toLowerCase().includes(q.trim().toLowerCase())));
  const canCreate = getDb().records.some((r) => !r.archived && canWrite(actor, r));

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Documents</h1>
          <p className="sub">Scripts, briefs and notes for every project. Everyone on a project can read them, crew can edit them, and every change is kept.</p>
        </div>
        {canCreate && <button className="btn primary" onClick={() => setAdding(true)}><IconPlus /> New document</button>}
      </div>
      <section className="glass panel">
        <div className="row" style={{ marginBottom: 14 }}>
          <Field label="Search"><input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, document ID or Content ID" /></Field>
          <Field label="Project">
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((id) => <option key={id} value={id}>{getRecord(id)?.title ?? id}</option>)}
            </select>
          </Field>
        </div>
        {shown.length === 0 ? <Empty>No documents match. Documents are attached automatically when an item reaches a stage that needs one.</Empty> : (
          <table className="table">
            <thead><tr><th>Document</th><th>Content ID</th><th>Project</th><th>Attached at</th><th>Last edited</th></tr></thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} className="clickable" onClick={() => go({ n: "doc", id: d.id })}>
                  <td><div>{d.title}</div><span className="cid">{d.id}</span></td>
                  <td><span className="cid" style={{ fontSize: ".86rem" }}>{d.contentId}</span></td>
                  <td>{getRecord(d.contentId)?.title ?? d.contentId}</td>
                  <td>{d.stage ?? <span className="muted">Added by hand</span>}</td>
                  <td>{relativeDays(d.updatedAt.slice(0, 10))}<div className="muted" style={{ fontSize: ".82rem" }}>{nameOf(d.updatedBy)}, version {d.version}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {adding && <NewDocModal onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); go({ n: "doc", id }); }} />}
    </div>
  );
}

/** Keeps changed lines and one line of context around them, with … where lines were skipped. */
function compactDiff(lines: ReturnType<typeof diffLines>): (ReturnType<typeof diffLines>[number] | null)[] {
  const keep = lines.map((l, i) => l.type !== "same" || (lines[i - 1] && lines[i - 1].type !== "same") || (lines[i + 1] && lines[i + 1].type !== "same"));
  const out: (ReturnType<typeof diffLines>[number] | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}

type SaveState = "saved" | "saving" | "dirty" | "conflict" | "error";

export function DocPage({ id }: { id: string }) {
  const { actor, go, back, attempt, confirm, notify, toast } = useApp();
  useDb();
  const doc = getDoc(id);
  const [title, setTitle] = useState(doc?.title ?? "");
  const [body, setBody] = useState(doc?.body ?? "");
  const [status, setStatus] = useState<SaveState>("saved");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"write" | "plain" | "preview">("write");
  const [secs, setSecs] = useState<ParsedDoc | null>(() => parseSections(doc?.body ?? ""));
  const [history, setHistory] = useState(false);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const version = useRef(doc?.version ?? 0);
  const latest = useRef({ title, body, dirty: false });
  const area = useRef<HTMLTextAreaElement>(null);
  const editable = !!doc && canEditDoc(actor, doc);

  // If the text changes some way other than typing in a section (restore, plain text), read it again.
  const composedFromSecs = secs ? joinSections(secs) : null;
  if (mode !== "plain" && composedFromSecs !== null && composedFromSecs !== body && parseSections(body)) {
    const fresh = parseSections(body);
    if (fresh && joinSections(fresh) !== composedFromSecs) setSecs(fresh);
  }

  const persist = () => {
    if (!latest.current.dirty || !doc) return;
    setStatus("saving");
    try {
      const saved = saveDoc(actor, id, { title: latest.current.title, body: latest.current.body }, version.current);
      version.current = saved.version;
      latest.current.dirty = false;
      setStatus("saved");
      setMessage("");
    } catch (e) {
      if (e instanceof ConflictError) { setStatus("conflict"); setMessage("Someone else saved a newer version while you were editing."); }
      else { setStatus("error"); setMessage(e instanceof RuleError ? e.message : "Could not save."); }
    }
  };

  // Save shortly after typing stops, and once more when leaving the page.
  useEffect(() => {
    if (!latest.current.dirty) return;
    const t = setTimeout(persist, 1200);
    return () => clearTimeout(t);
  });
  useEffect(() => () => { persist(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc || !canViewDoc(actor, doc)) return <div className="page"><Empty>This document does not exist or is not part of a project you are attached to.</Empty></div>;
  const rec = getRecord(doc.contentId);

  const edit = (next: { title?: string; body?: string }) => {
    if (!editable) return;
    if (next.title !== undefined) setTitle(next.title);
    if (next.body !== undefined) setBody(next.body);
    latest.current = { title: next.title ?? latest.current.title, body: next.body ?? latest.current.body, dirty: true };
    setStatus("dirty");
  };
  const editSection = (i: number, patch: Partial<ParsedDoc["sections"][number]>) => {
    if (!secs) return;
    const next = { ...secs, sections: secs.sections.map((x, j) => (j === i ? { ...x, ...patch } : x)) };
    setSecs(next);
    edit({ body: joinSections(next) });
  };
  const addSection = () => {
    if (!secs) return;
    const next = { ...secs, sections: [...secs.sections, { title: "New section", note: "", answer: "" }] };
    setSecs(next);
    edit({ body: joinSections(next) });
  };
  const removeSection = (i: number) => {
    if (!secs) return;
    const next = { ...secs, sections: secs.sections.filter((_, j) => j !== i) };
    setSecs(next);
    edit({ body: joinSections(next) });
  };
  const wrap = (before: string, after = "") => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: z } = el;
    edit({ body: body.slice(0, a) + before + body.slice(a, z) + after + body.slice(z) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + before.length, z + before.length); });
  };
  const linePrefix = (prefix: string) => {
    const el = area.current;
    if (!el) return;
    const start = body.lastIndexOf("\n", el.selectionStart - 1) + 1;
    edit({ body: body.slice(0, start) + prefix + body.slice(start) });
    requestAnimationFrame(() => el.focus());
  };

  const downloadPdf = async () => {
    persist(); // the PDF is of what is on screen, so save first
    try {
      const report = buildReport(actor, "doc.pdf", { docId: id });
      const saved = await saveFile(`${report.filename}.pdf`, await reportToPdf(report));
      if (saved) notify("Document downloaded", saved.how === "saved" ? `${doc.title} was saved to ${saved.where}.` : `${doc.title} was saved as ${saved.where}. Look in your Downloads folder.`);
    } catch (e) { toast(e instanceof RuleError ? e.message : "The PDF could not be made.", "error"); }
  };
  const revs = revisionsOf(id);
  const statusText = { saved: `Saved, version ${version.current}`, saving: "Saving…", dirty: "Unsaved changes", conflict: "Not saved", error: "Not saved" }[status];

  return (
    <div className="page">
      <nav className="crumbs no-print"><button onClick={() => go({ n: "documents" })}>Documents</button><span aria-hidden> / </span><span>{doc.title}</span></nav>
      <div className="page-head">
        <div className="grow">
          <input className="doc-title" type="text" value={title} disabled={!editable} onChange={(e) => edit({ title: e.target.value })} aria-label="Document title" />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
            <span className="cid">{doc.id}</span>
            <span className="badge" title="The Content ID this document belongs to">{doc.contentId}</span>
            {rec && <button className="badge accent" style={{ cursor: "pointer" }} onClick={() => go({ n: "record", id: rec.contentId })}>{rec.title}</button>}
            {doc.stage && <span className="badge">{doc.stage}</span>}
            <span className={`badge ${status === "saved" ? "ok" : status === "dirty" || status === "saving" ? "" : "bad"}`}>{statusText}</span>
            <span className="muted" style={{ fontSize: ".84rem" }}>Last edited by {nameOf(doc.updatedBy)}, {fmtDateTime(doc.updatedAt)}</span>
          </div>
        </div>
        <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => setHistory(true)}>History ({revs.length})</button>
          <button className="btn primary" onClick={downloadPdf}>Download PDF</button>
          <ReportButton scope="document" params={{ docId: id }} label="Print or copy" />
          {editable && <button className="btn" onClick={persist} disabled={status === "saved"}>Save now</button>}
          {editable && (
            <button className="btn danger" onClick={async () => { if (await confirm({ title: `Archive ${doc.title}?`, body: "It disappears from the list. Its history is kept.", confirmLabel: "Archive", danger: true })) { latest.current.dirty = false; if (attempt(() => archiveDoc(actor, id), "Archived")) back(); } }}>Archive</button>
          )}
        </div>
      </div>

      <div className="print-only" aria-hidden="true">Content ID {doc.contentId}, {rec?.title}. Document {doc.id}, version {doc.version}.</div>
      {!editable && <div className="banner"><span className="grow">You can read this document but not edit it.</span></div>}
      {(status === "conflict" || status === "error") && (
        <div className="banner bad" role="alert"><span className="grow">{message}</span>{status === "conflict" && <button className="btn small" onClick={() => { version.current = doc.version; latest.current = { title: doc.title, body: doc.body, dirty: false }; setTitle(doc.title); setBody(doc.body); setStatus("saved"); setMessage(""); }}>Discard mine and load the latest</button>}</div>
      )}

      <section className="glass panel doc-sheet">
        {editable && (
          <div className="doc-toolbar no-print">
            <div className="seg" role="group" aria-label="Mode">
              <button className={mode === "write" ? "on" : ""} onClick={() => setMode("write")}>Write</button>
              {secs && <button className={mode === "plain" ? "on" : ""} onClick={() => setMode("plain")}>Plain text</button>}
              <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>Preview</button>
            </div>
            {(mode === "plain" || (mode === "write" && !secs)) && (
              <div className="chips">
                <button className="chip" onClick={() => linePrefix("# ")} title="Heading">H1</button>
                <button className="chip" onClick={() => linePrefix("## ")} title="Subheading">H2</button>
                <button className="chip" onClick={() => wrap("**", "**")} title="Bold"><b>B</b></button>
                <button className="chip" onClick={() => linePrefix("- ")} title="Bullet">• List</button>
                <button className="chip" onClick={() => linePrefix("- [ ] ")} title="Checkbox">☐ Checklist</button>
              </div>
            )}
          </div>
        )}
        {editable && mode === "write" && secs ? (
          <div className="stack" style={{ gap: 22 }}>
            {secs.intro && <p className="doc-note"><em>{secs.intro.replace(/^_|_$/g, "")}</em></p>}
            {secs.sections.map((sec, i) => (
              <div key={i} className="doc-block">
                <div className="doc-block-head">
                  <span className="doc-num">{i + 1}</span>
                  <input type="text" className="doc-block-title" value={sec.title} aria-label={`Title of section ${i + 1}`} onChange={(e) => editSection(i, { title: e.target.value })} />
                  <button className="btn small ghost" aria-label={`Remove section ${i + 1}`} onClick={() => removeSection(i)}>Remove</button>
                </div>
                {sec.note && <p className="doc-note"><em>{sec.note}</em></p>}
                <textarea className="doc-answer" value={sec.answer} aria-label={`Answer for ${sec.title}`} placeholder="Write here" onChange={(e) => editSection(i, { answer: e.target.value })} />
              </div>
            ))}
            <div><button className="btn" onClick={addSection}><IconPlus /> Add a section</button> <span className="muted" style={{ marginLeft: 10, fontSize: ".84rem" }}>Start a line with a dash for a list, or a dash and [ ] for a checklist.</span></div>
          </div>
        ) : editable && (mode === "write" || mode === "plain") ? (
          <textarea ref={area} className="doc-editor" value={body} onChange={(e) => edit({ body: e.target.value })} spellCheck aria-label="Document text" placeholder="Start writing" />
        ) : (
          <MiniMarkdown text={body} onToggle={editable ? (n) => edit({ body: toggleCheckLine(body, n) }) : undefined} />
        )}
      </section>

      {history && (
        <Modal wide title="Version history" onClose={() => { setHistory(false); setDiffFor(null); }} actions={<button className="btn" onClick={() => { setHistory(false); setDiffFor(null); }}>Close</button>}>
          <p className="muted" style={{ marginBottom: 10 }}>Every save is kept. Quick edits by the same person within ten minutes are grouped together.</p>
          <div className="list" style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {revs.map((v, i) => {
              const prev = revs[i + 1];
              return (
                <div key={v.id}>
                  <div className="list-item" style={{ cursor: "default" }}>
                    <div className="grow">
                      <div>{fmtDateTime(v.at)}{i === 0 && <span className="badge ok" style={{ marginLeft: 8 }}>Current</span>}</div>
                      <div className="muted" style={{ fontSize: ".84rem" }}>{nameOf(v.byPersonId)}, {v.note}</div>
                    </div>
                    {prev && <button className="btn small ghost" onClick={() => setDiffFor(diffFor === v.id ? null : v.id)}>{diffFor === v.id ? "Hide changes" : "What changed"}</button>}
                    {editable && i > 0 && <button className="btn small" onClick={async () => { if (await confirm({ title: "Restore this version?", body: "It becomes the current text. The versions after it stay in the history.", confirmLabel: "Restore" })) { latest.current.dirty = false; const d = attempt(() => restoreRevision(actor, id, v.id), "Version restored"); if (d) { version.current = d.version; setTitle(d.title); setBody(d.body); latest.current = { title: d.title, body: d.body, dirty: false }; setStatus("saved"); setHistory(false); } } }}>Restore</button>}
                  </div>
                  {diffFor === v.id && prev && (
                    <div className="diff">
                      {compactDiff(diffLines(prev.body, v.body)).map((l, k) => l === null ? <div key={k} className="diff-same">…</div> : <div key={k} className={`diff-${l.type}`}><span aria-hidden>{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>{l.text || " "}</div>)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}

