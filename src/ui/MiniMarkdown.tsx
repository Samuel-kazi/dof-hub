import type { ReactNode } from "react";

// A small format for documents: numbered sections, italic notes, bullets, checkboxes, tables and **bold**.
// It builds React elements, never raw HTML, so pasted text cannot inject anything.

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : part));
}

export function MiniMarkdown({ text, onToggle }: { text: string; onToggle?: (line: number) => void }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `l${i}`;
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      const start = i;
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[\s|:-]+\|?$/.test(lines[i])) rows.push(lines[i].split("|").slice(1, lines[i].endsWith("|") ? -1 : undefined).map((c) => c.trim()));
        i++;
      }
      out.push(
        <table key={`t${start}`} className="doc-table">
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{inline(c)}</th> : <td key={ci}>{inline(c)}</td>))}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    const check = /^- \[( |x|X)\] ?(.*)$/.exec(line);
    const numbered = /^(\d+)\.\s+(\S.*)$/.exec(line);
    if (numbered) out.push(<h3 key={key} className="doc-section"><span className="doc-num">{numbered[1]}</span>{inline(numbered[2])}</h3>);
    else if (/^_.+_$/.test(line.trim())) out.push(<p key={key} className="doc-note"><em>{line.trim().slice(1, -1)}</em></p>);
    else if (line.startsWith("### ")) out.push(<h4 key={key}>{inline(line.slice(4))}</h4>);
    else if (line.startsWith("## ")) out.push(<h3 key={key}>{inline(line.slice(3))}</h3>);
    else if (line.startsWith("# ")) out.push(<h2 key={key}>{inline(line.slice(2))}</h2>);
    else if (check) {
      const done = check[1] !== " ";
      const n = i;
      out.push(
        <label key={key} className={`doc-check ${done ? "done" : ""}`}>
          <input type="checkbox" checked={done} disabled={!onToggle} onChange={() => onToggle?.(n)} />
          <span>{inline(check[2])}</span>
        </label>,
      );
    } else if (line.startsWith("- ")) out.push(<div key={key} className="doc-bullet"><span aria-hidden>•</span><span>{inline(line.slice(2))}</span></div>);
    else if (!line.trim()) out.push(<div key={key} className="doc-gap" />);
    else out.push(<p key={key}>{inline(line)}</p>);
    i++;
  }
  return <div className="doc-body">{out}</div>;
}

/** Flips one checkbox line in the text. Used when someone ticks a box in the preview. */
export function toggleCheckLine(text: string, line: number): string {
  const lines = text.split("\n");
  lines[line] = lines[line].replace(/^- \[( |x|X)\]/, (_, c: string) => (c === " " ? "- [x]" : "- [ ]"));
  return lines.join("\n");
}
