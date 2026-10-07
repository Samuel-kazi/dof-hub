import { useState } from "react";
import type { CategoryKey, FormType, SeriesType } from "../../types";
import { FORM_TYPES, SERIES_TYPES } from "../../config/workflow";
import { getDb } from "../../data/store";
import { driveUsage } from "../../services/driveUsage";
import { importProject, importableFolders, type ImportCategory } from "../../services/wrapped/workflow";
import { fmtSize, todayIso } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/parts";

// Import existing project (build prompt v4, section 7A): a project recorded before the system, from a folder on a
// drive that no project is linked to yet. It starts in Production (its Recording Log opens, blank) or in Post
// production (one episode for each item recorded). Opened from Storage & Media ("Import as project" on a folder) and
// from the pipeline's Add menu.

const KINDS: { key: ImportCategory; label: string }[] = [
  { key: "series", label: "Series" },
  { key: "devotional", label: "Devotional" },
  { key: "documentary", label: "Documentary" },
  { key: "music", label: "DOF Music" },
  { key: "live", label: "Live Show" },
];

export function ImportProjectModal({
  onClose,
  allocationId,
  category,
}: {
  onClose: () => void;
  allocationId?: string; // the folder, when opened from Storage & Media
  category?: CategoryKey; // the pipeline it was opened from
}) {
  const { actor, attempt, go, toast } = useApp();
  const preset = allocationId ? getDb().allocations.find((a) => a.id === allocationId) : undefined;
  const [driveId, setDriveId] = useState(preset?.driveId ?? getDb().drives[0]?.id ?? "");
  const [linked, setLinked] = useState(false);
  const [folder, setFolder] = useState(allocationId ?? "");
  const [kind, setKind] = useState<ImportCategory>(KINDS.some((k) => k.key === category) ? (category as ImportCategory) : "series");
  const [seriesType, setSeriesType] = useState<SeriesType | "">("");
  const [formType, setFormType] = useState<FormType | "">("");
  const [title, setTitle] = useState(preset?.label ?? "");
  const [start, setStart] = useState<"Production" | "Post production">("Production");
  const [recordedOn, setRecordedOn] = useState(todayIso());
  const [items, setItems] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const folders = driveId ? importableFolders(actor, driveId, linked) : [];
  const chosen = folders.find((f) => f.allocationId === folder);
  const save = () => {
    const r = attempt(() =>
      importProject(actor, {
        allocationId: folder,
        category: kind,
        title,
        seriesType: kind === "series" ? seriesType || null : null,
        formType: kind === "documentary" || kind === "music" ? formType || null : null,
        start,
        recordedOn,
        items: items.split("\n"),
        reviewedBeforeSystem: reviewed,
      }),
    );
    if (!r) return;
    toast(`Imported as ${r.project.contentId}${r.episodes.length ? `, with ${r.episodes.join(", ")}` : ""}.`, "success");
    onClose();
    go(r.sessionId ? { n: "session", id: r.sessionId } : { n: "record", id: r.project.contentId });
  };
  return (
    <Modal
      title="Import existing project"
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!folder || (chosen?.contentId ?? null) !== null} onClick={save}>
            Import
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted">
          A project recorded before the system: its footage is already in a folder on a drive. It gets a Content ID, the folder is linked to
          it, and it starts where it is now. The stages it skipped show &quot;Recorded before the system&quot;.
        </p>
        <div className="row">
          <Field label="Drive">
            <select
              value={driveId}
              onChange={(e) => {
                setDriveId(e.target.value);
                setFolder("");
              }}
            >
              <option value="">Choose a drive…</option>
              {getDb().drives.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {fmtSize(driveUsage(d).freeGB)} free{d.offline ? " · offline" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Folder">
            <select
              value={folder}
              onChange={(e) => {
                setFolder(e.target.value);
                const f = folders.find((x) => x.allocationId === e.target.value);
                if (f && !title.trim()) setTitle(f.title);
              }}
            >
              <option value="">{folders.length ? "Choose a folder…" : "No folders without a project on this drive"}</option>
              {folders.map((f) => (
                <option key={f.allocationId} value={f.allocationId} disabled={f.contentId !== null}>
                  {f.folderPath}
                  {f.contentId ? ` (already ${f.contentId})` : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} /> Also show folders already linked to a
          project
        </label>
        <div className="row">
          <Field label="Kind">
            <select value={kind} onChange={(e) => setKind(e.target.value as ImportCategory)}>
              {KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          {kind === "series" && (
            <Field label="Kind of series">
              <select value={seriesType} onChange={(e) => setSeriesType(e.target.value as SeriesType | "")}>
                <option value="">Choose…</option>
                {SERIES_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(kind === "documentary" || kind === "music") && (
            <Field label={kind === "music" ? "Single or album" : "Who is making it"}>
              <select value={formType} onChange={(e) => setFormType(e.target.value as FormType | "")}>
                <option value="">Choose…</option>
                {FORM_TYPES.filter((f) => f.category === (kind === "music" ? "music" : "documentary")).map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Title">
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The folder's name if left empty" />
          </Field>
        </div>
        <fieldset className="mode-pick">
          <legend>Where does it start?</legend>
          {(
            [
              ["Production", "Production", "Its Recording Log opens, blank: what was recorded, take marks, issues, where the footage is"],
              ["Post production", "Post production", "One episode for each item recorded, ready for editing"],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className={`mode-card${start === key ? " on" : ""}`}>
              <input type="radio" name="import-start" checked={start === key} onChange={() => setStart(key)} />
              <span>
                <b>{label}</b>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="row">
          <Field label="Recorded on">
            <input type="date" aria-label="Recorded on" value={recordedOn} onChange={(e) => setRecordedOn(e.target.value)} />
          </Field>
        </div>
        <Field
          label={
            start === "Post production"
              ? "What was recorded, one a line (each becomes an episode)"
              : "What was recorded, one a line (optional)"
          }
        >
          <textarea aria-label="What was recorded" value={items} onChange={(e) => setItems(e.target.value)} rows={4} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> Reviewed before the system (its
          theological review was done before)
        </label>
      </div>
    </Modal>
  );
}
