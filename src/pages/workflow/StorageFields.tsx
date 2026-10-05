import { useState } from "react";
import { getDb } from "../../data/store";
import { driveUsage } from "../../services/driveUsage";
import { hasStorageAccess } from "../../services/storage";
import { fmtDate, fmtSize } from "../../services/utils";
import {
  assetsOf,
  footageOf,
  sessionName,
  sessionsOf,
  setEpisodeAssets,
  setSessionDrive,
  setSessionFootage,
  type Episode,
  type Project,
} from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { Empty, Field } from "../../ui/parts";
import { SavedInput } from "../documents/toolkit";

// Where a project's recordings are kept, entered as the work goes: in Production, the drive each session's footage
// is on and, once recording has started, how much space it takes; in Post production, the drive and the size of the
// assets the edit makes for each episode. Each is an entry on the Storage screen (raw footage, or project files), so
// the drives' free space, warnings and forecast include it. Drives are seen by those who may use storage.

const driveName = (id: string | null | undefined): string => getDb().drives.find((d) => d.id === id)?.name ?? "";

function DriveOptions() {
  return (
    <>
      {getDb().drives.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name} · {fmtSize(driveUsage(d).freeGB)} free
        </option>
      ))}
    </>
  );
}

const sizeOf = (v: string): number | null => (v.trim() ? Number(v) : null);

/** The Production stage's Storage: each session's drive and the size of its recorded footage. */
export function SessionStorage({ project, write }: { project: Project; write: boolean }) {
  const { actor, attempt, go } = useApp();
  const access = hasStorageAccess(actor);
  const sessions = sessionsOf(project.contentId)
    .filter((s) => !s.archivedAt)
    .sort((a, b) => a.sessionNumber - b.sessionNumber);
  const planned = driveName(project.workflow.storageDriveId);
  const edit = write && access && !project.archived;
  const episodes = getDb()
    .records.filter((r) => r.parentId === project.contentId && r.episode && !r.archived)
    .sort((a, b) => a.contentId.localeCompare(b.contentId));
  return (
    <section className="glass panel" aria-label="Storage">
      <div className="wf-head">
        <h2>Storage</h2>
        <span className="grow" />
        {access && (
          <button className="btn small" onClick={() => go({ n: "storage" })}>
            Open Storage
          </button>
        )}
      </div>
      <p className="muted">
        Each session's footage goes on {planned ? <b>{planned}</b> : "the drive chosen in the Recording Plan"} unless another is chosen
        here. Its size is entered once recording has started, and counts against the drive's free space.
      </p>
      {!access ? (
        <Empty>Drives are seen by those who may use storage.</Empty>
      ) : sessions.length === 0 ? (
        <Empty>No recording sessions yet.</Empty>
      ) : (
        <div className="wf-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Date</th>
                <th>Drive</th>
                <th>Footage (GB)</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const footage = footageOf(s.id);
                return (
                  <tr key={s.id}>
                    <td>
                      {sessionName(s)} <span className="cid">{s.id}</span>
                    </td>
                    <td>{s.scheduledDate ? fmtDate(s.scheduledDate) : <span className="muted">No date yet</span>}</td>
                    <td>
                      <select
                        aria-label={`Drive for ${sessionName(s)}`}
                        value={s.storageDriveId ?? ""}
                        disabled={!edit}
                        onChange={(e) => attempt(() => setSessionDrive(actor, s.id, e.target.value || null), "Drive saved")}
                      >
                        <option value="">{planned ? `The plan's drive (${planned})` : "Not chosen"}</option>
                        <DriveOptions />
                      </select>
                    </td>
                    <td>
                      {s.status === "Planned" ? (
                        <span className="muted">After recording</span>
                      ) : (
                        <SavedInput
                          type="number"
                          min={0}
                          step="any"
                          aria-label={`Footage size for ${sessionName(s)}, in GB`}
                          value={footage ? String(footage.sizeGB) : ""}
                          disabled={!edit}
                          placeholder="GB"
                          onSave={(v) => {
                            const n = sizeOf(v);
                            if (n !== null) attempt(() => setSessionFootage(actor, s.id, n), "Footage size saved");
                          }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {access && episodes.length > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Edit assets</h3>
          <p className="muted">Entered on each episode, in Post production, as the edit grows.</p>
          <ul className="rp-readonly">
            {episodes.map((e) => {
              const a = assetsOf(e.contentId);
              return (
                <li key={e.contentId}>
                  <span>
                    {e.title} <span className="cid">{e.contentId}</span>
                  </span>
                  <b>{a ? `${fmtSize(a.sizeGB)} on ${driveName(a.driveId)}` : <span className="muted">Not entered</span>}</b>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** An episode's edit assets (project files, renders, graphics): the drive they are on and how much space they take. */
export function EpisodeAssets({ ep, project, write }: { ep: Episode; project: Project; write: boolean }) {
  const { actor, attempt } = useApp();
  const existing = assetsOf(ep.contentId);
  const [drive, setDrive] = useState<string>(existing?.driveId ?? project.workflow.storageDriveId ?? "");
  if (!hasStorageAccess(actor)) return null;
  const edit = write && !ep.archived;
  const current = existing?.driveId ?? drive;
  return (
    <div className="rp-assets" aria-label="Edit assets">
      <h3>Edit assets</h3>
      <div className="row" style={{ alignItems: "end" }}>
        <Field label="Drive">
          <select
            value={current}
            disabled={!edit}
            onChange={(e) => {
              const next = e.target.value;
              setDrive(next);
              if (existing && next) attempt(() => setEpisodeAssets(actor, ep.contentId, { driveId: next }), "Drive saved");
            }}
          >
            <option value="">Not chosen</option>
            <DriveOptions />
          </select>
        </Field>
        <Field label="Size (GB)">
          <SavedInput
            type="number"
            min={0}
            step="any"
            value={existing ? String(existing.sizeGB) : ""}
            disabled={!edit}
            placeholder="GB"
            onSave={(v) => {
              const n = sizeOf(v);
              if (n !== null)
                attempt(() => setEpisodeAssets(actor, ep.contentId, { driveId: current || null, sizeGB: n }), "Edit assets saved");
            }}
          />
        </Field>
      </div>
      <p className="muted">The space the edit's project files, renders and graphics take. Change it as the edit grows.</p>
    </div>
  );
}
