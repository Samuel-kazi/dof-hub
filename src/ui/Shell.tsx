import type { ReactNode } from "react";
import type { ContentRecord } from "../types";
import { isComplete, riskOf } from "../services/wrapped/content";
import { ACCENT_OPTIONS } from "./theme";

export function RiskBadge({ record }: { record: ContentRecord }) {
  const r = riskOf(record);
  if (r === "done") return <span className="badge ok">Complete</span>;
  if (r === "overdue") return <span className="badge bad">Overdue</span>;
  if (r === "at-risk") return <span className="badge warn">At risk</span>;
  return null;
}

export const StageBadge = ({ record }: { record: ContentRecord }) =>
  record.pipelineStage ? <span className={`badge ${isComplete(record) ? "ok" : "accent"}`}>{record.pipelineStage}</span> : null;

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

export function Initials({ name, photoUrl, accent = "terracotta" }: { name: string; photoUrl?: string | null; accent?: keyof typeof ACCENT_OPTIONS }) {
  if (photoUrl) {
    return <img className="avatar-image" src={photoUrl} alt={name} title={name} />;
  }
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return <span className="avatar" style={{ background: `linear-gradient(135deg, ${ACCENT_OPTIONS[accent]?.value ?? ACCENT_OPTIONS.terracotta.value}, ${ACCENT_OPTIONS[accent]?.hi ?? ACCENT_OPTIONS.terracotta.hi})` }}>{initials}</span>;
}
