import { useEffect, useState } from "react";
import type { ContentRecord, ReviewCheckpoint } from "../../types";
import { getDb } from "../../data/store";
import { CHECKLISTS, CHECKPOINTS, WORKFLOW_STAGES, type ChecklistKey } from "../../config/workflow";
import type { FieldDef } from "../../config/devForms";
import { isHop } from "../../services/access";
import { nameOf } from "../../services/wrapped/people";
import { checklistItems, decideCheckpoint, setChecklistItem, setCheckpointReviewers } from "../../services/wrapped/workflow";
import { fmtDateTime } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { PromptModal } from "../../ui/Prompt";
import { Checklist, CrewSelect, type ChecklistRow } from "../../ui/workflow/shared";

// Pieces the workflow's pages share: the stage rail, the reason prompt, checklists from config, review
// checkpoints, and form fields drawn from src/config/devForms.ts.

/** The five stages, with the current one marked. */
export function StageRail({ current }: { current: string }) {
  const idx = WORKFLOW_STAGES.findIndex((s) => s.name === current);
  const done = current === "Completed";
  return (
    <div className="rail" aria-label="Stages">
      {WORKFLOW_STAGES.map((s, i) => (
        <div
          key={s.name}
          className={`rail-step ${done || i < idx ? "done" : i === idx ? "now" : ""}`}
          title={`${s.ledBy}. To leave: ${s.gate}.`}
        >
          {s.name}
        </div>
      ))}
    </div>
  );
}

/** Asks for a reason before something is closed, archived or sent back. Resolves to the reason, or null if cancelled. */
export function useReason(): [(title: string, label: string, confirmLabel: string) => Promise<string | null>, React.ReactNode] {
  const [state, setState] = useState<{ title: string; label: string; confirmLabel: string; resolve: (v: string | null) => void } | null>(
    null,
  );
  const ask = (title: string, label: string, confirmLabel: string) =>
    new Promise<string | null>((resolve) => setState({ title, label, confirmLabel, resolve }));
  const modal = state ? (
    <PromptModal
      title={state.title}
      label={state.label}
      confirmLabel={state.confirmLabel}
      required
      onSubmit={(text) => {
        state.resolve(text.trim());
        setState(null);
      }}
      onClose={() => {
        state.resolve(null);
        setState(null);
      }}
    />
  ) : null;
  return [ask, modal];
}

/** A checklist's rows: what the config lists, with each stored tick and note, and automatic items worked out by the caller. */
export function checklistRows(key: ChecklistKey, ownerId: string, auto: Record<string, [boolean, string]> = {}): ChecklistRow[] {
  const def = CHECKLISTS[key];
  const stored = checklistItems(key, ownerId);
  return def.items
    .map((i): ChecklistRow | null => {
      const id = `${ownerId}|${def.stage}|${i.key}`;
      if (i.auto) {
        const [done, why] = auto[i.key] ?? [false, "Worked out by the app"];
        return { id, label: i.label, done, note: "", required: i.required, group: i.group, auto: why };
      }
      const s = stored.find((c) => c.itemKey === i.key);
      return s ? { id: s.id, label: i.label, done: s.done, note: s.note, required: i.required, group: i.group } : null;
    })
    .filter((r): r is ChecklistRow => r !== null);
}

/** A checklist from config, saved through the workflow's checklist action. */
export function ConfigChecklist({
  title,
  listKey,
  ownerId,
  disabled,
  auto,
  empty,
}: {
  title: string;
  listKey: ChecklistKey;
  ownerId: string;
  disabled: boolean;
  auto?: Record<string, [boolean, string]>;
  empty?: string;
}) {
  const { actor, attempt } = useApp();
  return (
    <Checklist
      title={title}
      rows={checklistRows(listKey, ownerId, auto)}
      disabled={disabled}
      empty={empty}
      onToggle={(id, done) => attempt(() => setChecklistItem(actor, id, { done }))}
      onNote={(id, note) => attempt(() => setChecklistItem(actor, id, { note }), "Note saved")}
    />
  );
}

// ── Review checkpoints ───────────────────────────────────────

const checkpointLabel = (key: ReviewCheckpoint["checkpoint"]) => CHECKPOINTS.find((c) => c.key === key)?.label ?? key;

/** One theological review checkpoint: who reviews it, its status, and the reviewer's decision. */
export function CheckpointCard({
  id,
  canChooseReviewers,
  decideHint,
}: {
  id: string;
  canChooseReviewers: boolean;
  decideHint?: string; // why it cannot be decided right now, if it cannot
}) {
  const { actor, attempt } = useApp();
  const [ask, reasonModal] = useReason();
  const c = getDb().reviewCheckpoints.find((x) => x.id === id);
  if (!c) return null;
  const mayDecide = isHop(actor) || c.reviewerIds.includes(actor.personId);
  const tone = c.status === "Approved" ? "ok" : c.status === "Changes requested" ? "bad" : "";
  return (
    <div className="wf-card">
      <div className="wf-head">
        <b>{checkpointLabel(c.checkpoint)}</b>
        <span className={`badge ${tone}`}>{c.status}</span>
      </div>
      <div className="wf-chips">
        {c.reviewerIds.length === 0 && <span className="muted">No reviewer chosen yet.</span>}
        {c.reviewerIds.map((r) => (
          <span key={r} className="chip on">
            {nameOf(r)}
            {canChooseReviewers && (
              <button
                className="wf-x"
                aria-label={`Remove ${nameOf(r)} as a reviewer`}
                onClick={() =>
                  attempt(() =>
                    setCheckpointReviewers(
                      actor,
                      c.id,
                      c.reviewerIds.filter((x) => x !== r),
                    ),
                  )
                }
              >
                ×
              </button>
            )}
          </span>
        ))}
        {canChooseReviewers && (
          <CrewSelect
            label={`Add a reviewer for ${checkpointLabel(c.checkpoint)}`}
            value={null}
            none="Add a reviewer…"
            onChange={(p) => p && attempt(() => setCheckpointReviewers(actor, c.id, [...c.reviewerIds, p]), "Reviewer added")}
          />
        )}
      </div>
      {c.decidedAt && (
        <p className="muted" style={{ fontSize: ".84rem" }}>
          {c.status} by {nameOf(c.decidedById)}, {fmtDateTime(c.decidedAt)}
          {c.note ? `: ${c.note}` : ""}
        </p>
      )}
      {mayDecide && (
        <div className="wf-actions">
          {decideHint ? (
            <span className="muted">{decideHint}</span>
          ) : (
            <>
              <button
                className="btn small primary"
                onClick={() => attempt(() => decideCheckpoint(actor, c.id, { status: "Approved", note: "" }), "Approved")}
              >
                Approve
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  const note = await ask(`Request changes: ${checkpointLabel(c.checkpoint)}`, "What needs to change", "Send back");
                  if (note)
                    attempt(() => decideCheckpoint(actor, c.id, { status: "Changes requested", note }), "Sent back with your reason");
                }}
              >
                Request changes
              </button>
            </>
          )}
        </div>
      )}
      {reasonModal}
    </div>
  );
}

// ── Form fields ──────────────────────────────────────────────

/** One field of a development form, drawn from its definition. */
export function FieldInput({
  def,
  value,
  onChange,
  disabled,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const str = typeof value === "string" ? value : "";
  switch (def.type) {
    case "longtext":
      return <textarea aria-label={def.label} value={str} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <input type="date" aria-label={def.label} value={str} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "crew":
      return <CrewSelect label={def.label} value={str || null} disabled={disabled} onChange={(p) => onChange(p ?? "")} />;
    case "select":
      return (
        <select aria-label={def.label} value={str} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not chosen</option>
          {def.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "yesno":
      return (
        <select aria-label={def.label} value={str} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not answered</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case "multiselect": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="wf-chips" role="group" aria-label={def.label}>
          {def.options?.map((o) => (
            <label key={o} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(o)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o))}
              />
              <span>{o}</span>
            </label>
          ))}
        </div>
      );
    }
    case "amount":
      return (
        <input
          type="number"
          min={0}
          step="any"
          aria-label={def.label}
          value={typeof value === "number" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    default:
      return <input type="text" aria-label={def.label} value={str} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Keeps a draft of stored values that follows the stored ones until the person starts changing it. */
export function useDraft<T>(stored: T): [T, (next: T) => void, boolean, () => void] {
  const key = JSON.stringify(stored);
  const [draft, setDraft] = useState<{ base: string; value: T; dirty: boolean }>({ base: key, value: stored, dirty: false });
  useEffect(() => {
    setDraft((d) => (d.dirty || d.base === key ? d : { base: key, value: JSON.parse(key) as T, dirty: false }));
  }, [key]);
  // After a save the stored values change, and the draft follows them again.
  const saved = () => setDraft((d) => ({ ...d, base: "", dirty: false }));
  return [draft.value, (value) => setDraft({ base: key, value, dirty: true }), draft.dirty, saved];
}

export const recordTitle = (r: ContentRecord): string => r.title;
