import type { ReportDoc } from "../services/reports";
import { Logo } from "./Logo";

/** A report laid out as a page, used when printing. */
export function ReportView({ report }: { report: ReportDoc }) {
  return (
    <div className="report-page">
      <div className="report-brand"><Logo width={120} /></div>
      <h1>{report.title}</h1>
      <p className="report-sub">{report.subtitle}</p>
      {report.blocks.map((b, i) => {
        if (b.type === "heading") return <h2 key={i}>{b.text}</h2>;
        if (b.type === "para") return <p key={i}>{b.text}</p>;
        if (b.type === "note") return <p key={i}><em>{b.text}</em></p>;
        if (b.type === "check") return <p key={i}>{b.done ? "[x]" : "[ ]"} {b.text}</p>;
        if (b.type === "bullets") return <ul key={i}>{b.items.map((t, j) => <li key={j}>{t}</li>)}</ul>;
        if (b.type === "pairs") return <table key={i} className="report-pairs"><tbody>{b.pairs.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>;
        return (
          <table key={i} className="report-table">
            <thead><tr>{b.head.map((h, j) => <th key={j}>{h}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody>
          </table>
        );
      })}
    </div>
  );
}
