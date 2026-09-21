import type { ProductionLevel } from "../types";
import { PRODUCTION_LEVELS } from "../config/production";

/** Small, medium or large. Large live productions get a run of show on their call sheet. */
export function LevelField({ value, onChange, disabled }: { value: ProductionLevel | null; onChange: (v: ProductionLevel | null) => void; disabled?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: ".86rem", color: "var(--ink-2)", marginBottom: 5 }}>Level of production</div>
      <div className="seg" role="group" aria-label="Level of production">
        <button type="button" className={value === null ? "on" : ""} disabled={disabled} onClick={() => onChange(null)}>Not set</button>
        {PRODUCTION_LEVELS.map((l) => <button key={l.key} type="button" className={value === l.key ? "on" : ""} disabled={disabled} onClick={() => onChange(l.key)}>{l.label}</button>)}
      </div>
      <p className="muted" style={{ marginTop: 6, fontSize: ".84rem" }}>{PRODUCTION_LEVELS.find((l) => l.key === value)?.hint ?? "Set this so the call sheet knows how much planning the show needs."}</p>
    </div>
  );
}
