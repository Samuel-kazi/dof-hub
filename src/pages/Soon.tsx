import { MODULE_LABELS, type ModuleKey } from "../config/roles";

const PLANS: Partial<Record<ModuleKey, string[]>> = {
  documents: [
    "Links to Drive documents, filed by Content ID",
    "Open, team-only and restricted visibility",
    "Documents surfaced on the show, season and episode pages",
  ],
};

export function Soon({ module }: { module: ModuleKey }) {
  return (
    <div className="page">
      <div>
        <h1>{MODULE_LABELS[module]}</h1>
        <p className="sub">This module is built after the pipeline, call sheets and crew are settled.</p>
      </div>
      <div className="glass panel">
        <h2>What it will cover</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          {(PLANS[module] ?? []).map((p) => <li key={p}>{p}</li>)}
        </ul>
      </div>
    </div>
  );
}
