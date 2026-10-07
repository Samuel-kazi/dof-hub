import { useEffect, useState, type ReactNode } from "react";
import type { Person } from "../../types";
import { getDb } from "../../data/store";
import { asWebUrl } from "../../services/urls";
import type { GateResult } from "../../services/wrapped/workflow";
import { openChecks } from "../checksNav";
import { useApp } from "../AppContext";
import { Empty } from "../parts";

// Building blocks shared by the workflow's screens: the Crew dropdown, a checklist with notes, the gate panel
// every Done button sits in, and links that open outside the app.

// ── The Crew dropdown ────────────────────────────────────────

/** Everyone an assignment can go to: active Crew and the Head of Production, by name. */
export function crewOptions(): Person[] {
  return getDb()
    .people.filter((p) => p.status === "active" && (p.category === "CRW" || p.category === "HOP"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every assignee is chosen here, never typed: the crew list, with an empty choice when `none` is given. */
export function CrewSelect({
  value,
  onChange,
  disabled,
  none = "Not chosen",
  label,
}: {
  value: string | null;
  onChange: (personId: string | null) => void;
  disabled?: boolean;
  none?: string | null;
  label: string;
}) {
  const options = crewOptions();
  const missing = value && !options.some((p) => p.personId === value) ? getDb().people.find((p) => p.personId === value) : undefined;
  return (
    <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      {none !== null && <option value="">{none}</option>}
      {missing && <option value={missing.personId}>{missing.name} (no longer active)</option>}
      {options.map((p) => (
        <option key={p.personId} value={p.personId}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

// ── A checklist with notes ───────────────────────────────────

export interface ChecklistRow {
  id: string;
  label: string;
  done: boolean;
  note: string;
  required: boolean;
  group?: string;
  auto?: string; // worked out by the app, with why: never ticked by hand
}

/** A note that saves when the person leaves the field, so typing does not send a change per key. */
export function NoteField({
  value,
  disabled,
  label,
  onSave,
}: {
  value: string;
  disabled: boolean;
  label: string;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      className="wf-note"
      aria-label={label}
      placeholder="Note"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function Checklist({
  title,
  rows,
  disabled,
  onToggle,
  onNote,
  empty = "Nothing on this checklist yet.",
}: {
  title: string;
  rows: ChecklistRow[];
  disabled: boolean;
  onToggle: (id: string, done: boolean) => void;
  onNote: (id: string, note: string) => void;
  empty?: string;
}) {
  const required = rows.filter((r) => r.required);
  const done = required.filter((r) => r.done).length;
  let lastGroup: string | undefined;
  return (
    <section className="glass panel" aria-label={title}>
      <div className="wf-head">
        <h2>{title}</h2>
        {required.length > 0 && (
          <span className={`badge ${done === required.length ? "ok" : ""}`}>
            {done} of {required.length} required done
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {rows.map((r) => {
            const heading = r.group && r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <div key={r.id}>
                {heading && <div className="wf-group">{heading}</div>}
                <div className="task-row">
                  <label className="check" style={{ flex: "1 1 260px" }}>
                    <input
                      type="checkbox"
                      checked={r.done}
                      disabled={disabled || !!r.auto}
                      onChange={(e) => onToggle(r.id, e.target.checked)}
                    />
                    <span style={{ color: r.done ? "var(--ink-3)" : undefined }}>
                      {r.label}
                      {!r.required && <span className="muted"> (optional)</span>}
                    </span>
                  </label>
                  {r.auto ? (
                    <span className="muted wf-auto">{r.auto}</span>
                  ) : (
                    <NoteField value={r.note} disabled={disabled} label={`Note for ${r.label}`} onSave={(v) => onNote(r.id, v)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── The gate ─────────────────────────────────────────────────

/**
 * A Done button, and whether what it needs is in place. The list of what is missing is in the Checks panel at the top
 * of the page (src/ui/ChecksPanel.tsx): pressing the button while something required is missing opens it there.
 */
export function GatePanel({
  title,
  gate,
  action,
  checksFor,
  disabled,
  onDone,
  extra,
}: {
  title: string;
  gate: GateResult;
  action: string;
  checksFor: string; // the owner whose Checks panel lists what is missing
  disabled?: boolean;
  onDone: () => void;
  extra?: ReactNode;
}) {
  return (
    <section className="glass panel" aria-label={title}>
      <h2>{title}</h2>
      <div className={`gate ${gate.passed ? "ready" : ""}`}>
        <p className="grow" style={{ flex: 1, minWidth: 220 }}>
          {gate.passed
            ? "Everything this step needs is in place."
            : `${gate.missing.length} still needed: see Checks, at the top of the page.`}
        </p>
        <div className="stack" style={{ gap: 8, flex: "none" }}>
          <button className="btn primary" disabled={disabled} onClick={() => (gate.passed ? onDone() : openChecks(checksFor))}>
            {action}
          </button>
          {extra}
        </div>
      </div>
    </section>
  );
}

// ── Links that open outside the app ──────────────────────────

const inDesktopApp = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Opens a web link in the person's own browser. Only http and https links are opened. In a browser, the new tab
 * gets no access back to this one (noopener) and is not told where the person came from (noreferrer). In the
 * desktop app, the system browser opens it, never the app's own window.
 */
export async function openExternal(url: string): Promise<boolean> {
  const safe = asWebUrl(url);
  if (!safe) return false;
  if (inDesktopApp()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(safe);
    return true;
  }
  const w = window.open(safe, "_blank", "noopener,noreferrer");
  if (w) w.opener = null;
  return true;
}

export function OpenLinkButton({ url, children, className = "btn small" }: { url: string; children: ReactNode; className?: string }) {
  const { toast } = useApp();
  const safe = asWebUrl(url);
  return (
    <button
      className={className}
      disabled={!safe}
      title={safe ? safe : "No web link yet"}
      onClick={async () => {
        if (!(await openExternal(url))) toast("That is not a web link starting with http:// or https://.", "error");
      }}
    >
      {children}
    </button>
  );
}

/** The address of a share link on this site. The server's own answer, when a link is made, uses PUBLIC_BASE_URL if set. */
export const shareUrlOf = (link: { token: string | null; targetUrl: string }): string =>
  link.token ? `${typeof window === "undefined" ? "" : window.location.origin}/share/${link.token}` : link.targetUrl;

/** Copies text, with a toast either way. */
export async function copyText(text: string, toast: (m: string, k?: "info" | "error" | "success") => void, what = "Link"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`, "success");
  } catch {
    toast(`Could not copy. Select it and copy it yourself: ${text}`, "error");
  }
}
