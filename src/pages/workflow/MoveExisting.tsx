import { useMemo, useState } from "react";
import type { SeriesType } from "../../types";
import { isRemote, migrateWorkflowRemote } from "../../data/remote";
import { applyMoveLocally, previewMove } from "../../data/workflowMove";
import type { AppliedMigrationReport, MigrationChoices, MigrationLine, WorkflowMigrationReport } from "../../data/migrateWorkflow";
import { SERIES_TYPES } from "../../config/workflow";
import { useDb } from "../../data/store";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";

// Settings, for the Head of Production: moving the series, devotionals and documentaries made before the five-stage
// workflow into it. What it would do is shown first, worked out from the data as it is now (a dry run). Moving keeps
// a copy of all the data, then makes the change all at once. Running it again changes nothing.

const PART_LABEL: Record<string, string> = {
  records: "Records (projects and episodes)",
  developmentForms: "Development forms",
  plannedEpisodes: "Planned episodes",
  projectRoles: "Project roles",
  workflowChecklistItems: "Checklist items",
  recordingSessions: "Recording sessions",
  sessionLogEntries: "Session log rows",
  reviewCheckpoints: "Review checkpoints",
  audit: "Activity log",
};

function Lines({ lines, empty }: { lines: MigrationLine[]; empty: string }) {
  if (!lines.length) return <Empty>{empty}</Empty>;
  return (
    <div className="wf-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Content ID</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.contentId}>
              <td>
                <span className="cid">{l.contentId}</span>
                <div className="muted" style={{ fontSize: ".84rem" }}>
                  {l.title}
                </div>
              </td>
              <td>{l.before}</td>
              <td>
                {l.after}
                {l.note && (
                  <div className="muted" style={{ fontSize: ".84rem" }}>
                    {l.note}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MigrationReportView({ report }: { report: WorkflowMigrationReport }) {
  const moved = report.lines.filter((l) => l.outcome === "moved");
  const flagged = report.lines.filter((l) => l.outcome === "flagged");
  const unchanged = report.lines.filter((l) => l.outcome === "unchanged");
  const counts = report.counts.filter((c) => c.before !== c.after || c.part === "records");
  return (
    <div className="stack">
      <div className="wf-scroll">
        <table className="table" aria-label="Rows before and after">
          <thead>
            <tr>
              <th>Part of the data</th>
              <th>Rows before</th>
              <th>Rows after</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((c) => (
              <tr key={c.part}>
                <td>{PART_LABEL[c.part] ?? c.part}</td>
                <td>{c.before}</td>
                <td>{c.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Moved ({moved.length})</h3>
      <Lines lines={moved} empty="Nothing to move." />
      <h3>Left for a decision by hand ({flagged.length})</h3>
      <Lines lines={flagged} empty="Nothing needs a decision by hand." />
      {unchanged.length > 0 && (
        <details>
          <summary>Left as they are ({unchanged.length})</summary>
          <Lines lines={unchanged} empty="" />
        </details>
      )}
      <p className={report.unexplained.length ? "wf-error" : "muted"}>
        Rows not accounted for: {report.unexplained.length}
        {report.unexplained.length ? ` (${report.unexplained.join(", ")})` : ""}
      </p>
      {report.followUps.length > 0 && (
        <>
          <h3>To do in the app afterwards</h3>
          <ul className="wf-missing">
            {report.followUps.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function MoveExistingPanel() {
  const { actor, confirm, toast } = useApp();
  const db = useDb();
  const [seriesTypes, setSeriesTypes] = useState<Record<string, SeriesType>>({});
  const [documentaryForms, setDocumentaryForms] = useState<Record<string, "documentary_dof" | "documentary_pitched">>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AppliedMigrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picked: MigrationChoices = { seriesTypes, documentaryForms };
  const preview = useMemo((): { report: WorkflowMigrationReport | null; problem: string | null } => {
    void db; // the data is a dependency: the dry run follows every change, made here or anywhere else
    try {
      return { report: previewMove(actor, { seriesTypes, documentaryForms }), problem: null };
    } catch (e) {
      return { report: null, problem: (e as Error).message };
    }
  }, [actor, db, seriesTypes, documentaryForms]);
  const report = preview.report;
  const moving = report ? report.lines.filter((l) => l.outcome === "moved").length : 0;
  const toChoose = {
    series: report?.series.filter((s) => !s.chosen || seriesTypes[s.contentId]) ?? [],
    documentaries: report?.documentaries.filter((d) => !d.chosen || documentaryForms[d.contentId]) ?? [],
  };

  const move = async () => {
    if (!report) return;
    const ok = await confirm({
      title: `Move ${moving} record${moving === 1 ? "" : "s"} to the new workflow?`,
      body: `A copy of all the data is kept first, ${isRemote() ? "in the database" : "on this computer"}, and the move happens all at once or not at all. Content IDs stay the same. ${report.lines.filter((l) => l.outcome === "flagged").length} record(s) stay in the earlier pipeline for a decision by hand. Running it again later changes nothing.`,
      confirmLabel: "Move them",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = isRemote() ? await migrateWorkflowRemote(true, picked) : applyMoveLocally(actor, picked);
      setDone(r);
      toast(
        r.applied ? `Moved ${r.lines.filter((l) => l.outcome === "moved").length} records to the new workflow` : "Nothing needed moving",
        "success",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass panel" aria-label="Move existing projects">
      <h2>Move existing projects to the new workflow</h2>
      <p className="sub" style={{ marginBottom: 12 }}>
        Series, devotionals and documentaries made before the five-stage workflow keep their earlier stages until they are moved. Below is
        what moving would do with the data as it is now. Nothing changes until you press Move. Content IDs stay the same, a copy of all the
        data is kept first, and running it again changes nothing.
      </p>
      {preview.problem ? (
        <p className="wf-error">The move could not be worked out: {preview.problem}</p>
      ) : !report ? (
        <p className="muted">Working it out…</p>
      ) : (
        <div className="stack">
          {(toChoose.series.length > 0 || toChoose.documentaries.length > 0) && (
            <div className="wf-fields">
              {toChoose.series.map((s) => (
                <Field key={s.contentId} label={`${s.title} (${s.contentId}) is a`}>
                  <select
                    value={seriesTypes[s.contentId] ?? s.type}
                    disabled={busy}
                    onChange={(e) => setSeriesTypes({ ...seriesTypes, [s.contentId]: e.target.value as SeriesType })}
                  >
                    {SERIES_TYPES.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label} series
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
              {toChoose.documentaries.map((d) => (
                <Field key={d.contentId} label={`${d.title} (${d.contentId}) is`}>
                  <select
                    value={documentaryForms[d.contentId] ?? d.form}
                    disabled={busy}
                    onChange={(e) =>
                      setDocumentaryForms({
                        ...documentaryForms,
                        [d.contentId]: e.target.value as "documentary_dof" | "documentary_pitched",
                      })
                    }
                  >
                    <option value="documentary_dof">Made by DOF</option>
                    <option value="documentary_pitched">Pitched by others</option>
                  </select>
                </Field>
              ))}
            </div>
          )}
          {done && (
            <div className="banner">
              <span className="grow">
                {done.applied ? `Moved. A copy of the data from before is in ${done.backup}.` : "Nothing needed moving."} The report of that
                run is below the current one.
              </span>
            </div>
          )}
          {error && <p className="wf-error">{error}</p>}
          <h3>{report.changed ? "What moving would do (dry run)" : "Nothing left to move"}</h3>
          <MigrationReportView report={report} />
          {report.changed && (
            <div>
              <button className="btn primary" disabled={busy || report.unexplained.length > 0} onClick={() => void move()}>
                {busy ? "Moving…" : `Move ${moving} record${moving === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
          {done && (
            <details>
              <summary>The report of the move that was made</summary>
              <MigrationReportView report={done} />
            </details>
          )}
        </div>
      )}
    </section>
  );
}
