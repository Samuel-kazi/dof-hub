import type { Block, ReportDoc } from "./reports";

// Lays a report out as a PDF. jsPDF is loaded only when a PDF is asked for, so the app starts fast.

/** The built-in PDF fonts cover Western European text. Anything else is swapped for a plain equivalent. */
export function pdfSafe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u2192/g, "->")
    .replace(/[\u2022\u25CF]/g, "-")
    .replace(/[\u2610]/g, "[ ]")
    .replace(/[\u2611\u2612]/g, "[x]")
    .replace(/[^\x09\x0A\x20-\x7E\u00A0-\u00FF]/g, "");
}

const INK: [number, number, number] = [36, 26, 20];
import { LOGO_PNG, LOGO_PNG_ASPECT } from "../brand/logoPng";

const MUTED: [number, number, number] = [110, 96, 86];
const ACCENT: [number, number, number] = [212, 87, 31];
const RULE: [number, number, number] = [214, 202, 192];
const HEAD_FILL: [number, number, number] = [243, 236, 229];

export async function reportToPdf(report: ReportDoc): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: report.landscape ? "landscape" : "portrait", compress: true });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 42;
  const bottom = H - 48;
  const usable = W - M * 2;
  let y = M;

  const need = (h: number) => { if (y + h > bottom) { doc.addPage(); y = M; } };
  const lines = (text: string, width: number, size: number, style: "normal" | "bold" | "italic" = "normal"): string[] => {
    doc.setFont("helvetica", style); doc.setFontSize(size);
    return doc.splitTextToSize(pdfSafe(text), width) as string[];
  };
  const write = (text: string, x: number, size: number, style: "normal" | "bold" | "italic", color: [number, number, number], width: number, lead = 1.3) => {
    const ls = lines(text, width, size, style);
    doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(...color);
    for (const l of ls) { need(size * lead); y += size * lead - size * 0.25; doc.text(l, x, y); y += size * 0.25; }
  };

  // Logo top right of the first page; the title keeps clear of it
  const logoW = 92;
  const logoH = logoW * LOGO_PNG_ASPECT;
  doc.addImage(LOGO_PNG, "PNG", W - M - logoW, M - 4, logoW, logoH);
  const titleW = usable - logoW - 16;

  // Title
  write(report.title, M, 18, "bold", INK, titleW, 1.25);
  if (report.subtitle) { y += 2; write(report.subtitle, M, 9.5, "normal", MUTED, titleW); }
  y = Math.max(y, M - 4 + logoH + 2);
  y += 6; doc.setDrawColor(...ACCENT); doc.setLineWidth(1.4); doc.line(M, y, M + 54, y); y += 14;

  const block = (b: Block) => {
    if (b.type === "heading") { y += 8; need(30); write(b.text, M, 12.5, "bold", INK, usable); y += 3; }
    else if (b.type === "para") { write(b.text, M, 10, "normal", INK, usable, 1.4); y += 3; }
    else if (b.type === "note") { write(b.text, M, 9.5, "italic", MUTED, usable, 1.4); y += 3; }
    else if (b.type === "check") { write(`${b.done ? "[x]" : "[ ]"}  ${b.text}`, M + 6, 10, "normal", b.done ? MUTED : INK, usable - 6, 1.4); }
    else if (b.type === "bullets") { for (const it of b.items) write(`-  ${it}`, M + 6, 10, "normal", INK, usable - 6, 1.4); y += 3; }
    else if (b.type === "pairs") {
      const keyW = Math.min(150, usable * 0.3);
      for (const [k, v] of b.pairs) {
        const vl = lines(v, usable - keyW, 10);
        need(vl.length * 13 + 2);
        doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...MUTED); doc.text(pdfSafe(k), M, y + 11);
        doc.setFont("helvetica", "normal"); doc.setTextColor(...INK);
        vl.forEach((l, i) => doc.text(l, M + keyW, y + 11 + i * 13));
        y += vl.length * 13 + 2;
      }
      y += 4;
    } else {
      const weights = b.weights ?? b.head.map(() => 1);
      const total = weights.reduce((a, c) => a + c, 0);
      const colW = weights.map((w) => (w / total) * usable);
      const pad = 4;
      const drawRow = (cells: string[], head: boolean) => {
        const ls = cells.map((c, i) => lines(c, colW[i] - pad * 2, 9, head ? "bold" : "normal"));
        const h = Math.max(...ls.map((l) => l.length), 1) * 11.5 + pad * 2;
        if (y + h > bottom) { doc.addPage(); y = M; if (!head) drawRow(b.head, true); }
        if (head) { doc.setFillColor(...HEAD_FILL); doc.rect(M, y, usable, h, "F"); }
        let x = M;
        ls.forEach((l, i) => {
          doc.setFont("helvetica", head ? "bold" : "normal"); doc.setFontSize(9); doc.setTextColor(...(head ? MUTED : INK));
          l.forEach((line, k) => doc.text(line, x + pad, y + pad + 9 + k * 11.5));
          x += colW[i];
        });
        y += h;
        doc.setDrawColor(...RULE); doc.setLineWidth(0.5); doc.line(M, y, M + usable, y);
      };
      if (b.rows.length === 0) { write("Nothing to list.", M, 9.5, "italic", MUTED, usable); y += 3; return; }
      drawRow(b.head, true);
      for (const r of b.rows) drawRow(r, false);
      y += 8;
    }
  };
  report.blocks.forEach(block);

  // Footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    const markW = 40;
    doc.addImage(LOGO_PNG, "PNG", M, H - 26 - markW * LOGO_PNG_ASPECT + 3, markW, markW * LOGO_PNG_ASPECT);
    doc.text("Dawn of Faith Production Hub", M + markW + 8, H - 26);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 26, { align: "right" });
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
