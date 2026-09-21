import type { DriveUsage, Forecast } from "../services/wrapped/storage";
import { isNearlyFull } from "../services/wrapped/storage";
import { getRecord } from "../services/access";
import { dayNumber, fmtDate, fmtShort, fmtSize } from "../services/utils";

const PALETTE = ["#e8703a", "#f3b943", "#7fbf95", "#8f9fdc", "#d58fb8", "#6fb4cf", "#b89468"];
export const colorFor = (i: number): string => PALETTE[i % PALETTE.length];

/** Like the storage bar on a Mac: one segment per project, then other files, then free space. */
export function StorageBar({ usage, legend = true }: { usage: DriveUsage; legend?: boolean }) {
  const cap = usage.drive.capacityGB;
  const pct = usage.pct;
  const cls = pct >= 95 ? "full" : isNearlyFull(usage) ? "warn" : "";
  return (
    <div>
      <div className={`sbar ${cls}`} role="img" aria-label={`${usage.drive.name}: ${fmtSize(usage.usedGB)} of ${fmtSize(cap)} used`}>
        {usage.projects.map((p, i) => <i key={p.contentId} style={{ width: `${(p.gb / cap) * 100}%`, background: colorFor(i) }} title={`${p.contentId}: ${fmtSize(p.gb)}`} />)}
        {usage.otherGB > 0 && <i style={{ width: `${(usage.otherGB / cap) * 100}%`, background: "#6f5a4d" }} title={`Other files: ${fmtSize(usage.otherGB)}`} />}
      </div>
      {legend && (
        <div className="legend">
          {usage.projects.map((p, i) => <span key={p.contentId}><i style={{ background: colorFor(i) }} />{getRecord(p.contentId)?.title ?? p.contentId} {fmtSize(p.gb)}</span>)}
          {usage.otherGB > 0 && <span><i style={{ background: "#6f5a4d" }} />Other files {fmtSize(usage.otherGB)}</span>}
        </div>
      )}
    </div>
  );
}

const axisLabel = (gb: number): string => (gb === 0 ? "0" : `${(gb / 1000).toFixed(gb % 1000 === 0 ? 0 : 1)} TB`);

/** Used space over time, with the projected line and the level where drives are flagged as full. */
export function ForecastChart({ data }: { data: Forecast }) {
  const W = 640, H = 200, L = 58, R = 14, T = 14, B = 26;
  const pts = [...data.history, ...data.projected.slice(1)];
  if (data.history.length < 2 || !data.capacityGB) return <p className="muted">Forecast appears after a few weeks of storage history.</p>;
  const x0 = dayNumber(data.history[0].date);
  const x1 = dayNumber(pts[pts.length - 1].date);
  const yMax = Math.max(data.capacityGB, ...pts.map((p) => p.usedGB));
  const sx = (d: string) => L + ((dayNumber(d) - x0) / Math.max(1, x1 - x0)) * (W - L - R);
  const sy = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const path = (arr: { date: string; usedGB: number }[]) => arr.map((p, i) => `${i ? "L" : "M"}${sx(p.date).toFixed(1)},${sy(p.usedGB).toFixed(1)}`).join(" ");
  const todayX = sx(data.history[data.history.length - 1].date);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Storage used over time with forecast">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - R} y1={sy(yMax * f)} y2={sy(yMax * f)} stroke="var(--line-soft)" />
          <text x={L - 6} y={sy(yMax * f) + 4} textAnchor="end">{axisLabel(yMax * f)}</text>
        </g>
      ))}
      <line x1={L} x2={W - R} y1={sy(data.thresholdGB)} y2={sy(data.thresholdGB)} stroke="var(--bad)" strokeDasharray="5 4" />
      <text x={W - R} y={sy(data.thresholdGB) - 5} textAnchor="end" style={{ fill: "var(--bad)" }}>flagged as full</text>
      <line x1={todayX} x2={todayX} y1={T} y2={H - B} stroke="var(--glass-line)" />
      <path d={path(data.history)} fill="none" stroke="var(--amber)" strokeWidth="2.4" strokeLinejoin="round" />
      {data.projected.length > 1 && <path d={path(data.projected)} fill="none" stroke="var(--accent-hi)" strokeWidth="2.4" strokeDasharray="6 5" />}
      <circle cx={todayX} cy={sy(data.history[data.history.length - 1].usedGB)} r="4" fill="var(--amber)" />
      <text x={L} y={H - 6}>{fmtShort(data.history[0].date)}</text>
      <text x={todayX} y={H - 6} textAnchor="middle">today</text>
      <text x={W - R} y={H - 6} textAnchor="end">{fmtShort(pts[pts.length - 1].date)}</text>
    </svg>
  );
}

export function ForecastNote({ data }: { data: Forecast }) {
  const gbPerWeek = data.slopeGBPerDay * 7;
  if (data.slopeGBPerDay <= 0) return <p className="sub">Usage is steady. No drives are forecast to fill up.</p>;
  return (
    <p className="sub">
      About {fmtSize(gbPerWeek)} added per week.{" "}
      {data.fillDate ? (data.fillDate <= new Date().toISOString().slice(0, 10) ? "The drives are already past the full mark." : `At this rate the drives reach the full mark around ${fmtDate(data.fillDate)}.`) : ""}
    </p>
  );
}

