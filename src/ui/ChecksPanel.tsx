import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { CheckGo } from "../config/checks";
import { useDb } from "../data/store";
import { getRecord, isHop } from "../services/access";
import { can } from "../services/wrapped/permissions";
import { nameOf } from "../services/wrapped/people";
import { setGateOverride } from "../services/wrapped/documents";
import type { HardGateKey } from "../services/documents/gates";
import {
  callSheetChecks,
  checksSummary,
  dismissCheck,
  episodeChecks,
  projectChecks,
  recordingLogChecks,
  restoreCheck,
  sessionChecks,
  setCheck,
  type CheckItem,
  type Checks,
} from "../services/wrapped/checks";
import { fmtDate } from "../services/utils";
import { useApp } from "./AppContext";
import { goToAnchor, onOpenChecks, openDoc } from "./checksNav";
import { NoteField } from "./workflow/shared";

// The Checks panel (build prompt v4, section 14A): one component for every stage and kind. Collapsed, it is one slim
// bar ("Checks: 2 required, 4 suggestions", or "All clear" in green) under the stage tracker, or a small count chip in
// a call sheet's or Recording Log's header. Opened, it drops down (a popover on wide windows, inline on narrow ones,
// with its own scroll) with Required to move on, Suggestions, and Completed (n). Each item says what is missing and
// goes to where it is fixed. It opens by itself when a Done button is pressed while something required is missing,
// and remembers being open or closed for each project, session or episode.

export type ChecksKind = "project" | "session" | "episode" | "sheet" | "log";

const EVALUATE: Record<ChecksKind, (id: string) => Checks> = {
  project: projectChecks,
  session: sessionChecks,
  episode: episodeChecks,
  sheet: callSheetChecks,
  log: recordingLogChecks,
};

const openKey = (ownerId: string) => `dof-hub-checks-open:${ownerId}`;
function readOpen(ownerId: string): boolean {
  try {
    return localStorage.getItem(openKey(ownerId)) === "1";
  } catch {
    return false;
  }
}
function keepOpen(ownerId: string, open: boolean): void {
  try {
    if (open) localStorage.setItem(openKey(ownerId), "1");
    else localStorage.removeItem(openKey(ownerId));
  } catch {
    /* remembered until the page is reloaded */
  }
}

/** Wide windows get a popover over the page; narrow ones open the panel in place. */
const isWide = () => typeof window !== "undefined" && !!window.matchMedia?.("(min-width: 900px)").matches;

type Editing = { key: string; kind: "note" | "dismiss" | "pass" } | null;

function Row({
  item,
  checks,
  write,
  mayPass,
  editing,
  setEditing,
  onGo,
}: {
  item: CheckItem;
  checks: Checks;
  write: boolean;
  mayPass: boolean;
  editing: Editing;
  setEditing: (e: Editing) => void;
  onGo: (go: CheckGo) => void;
}) {
  const { actor, attempt, confirm } = useApp();
  const [note, setNote] = useState("");
  const open = editing?.key === item.key ? editing.kind : null;
  const manual = item.manual && !item.manual.auto ? item.manual : null;
  const passed = !!item.gate?.override;
  const state = item.dismissed ? "dismissed" : passed ? "passed" : item.done ? "done" : item.group;
  const mark = { done: "✓", passed: "↷", dismissed: "–", required: "○", suggestion: "•" }[state];
  const reason = item.dismissed
    ? `Dismissed by ${nameOf(item.dismissed.byPersonId)}, ${fmtDate(item.dismissed.at.slice(0, 10))}${item.dismissed.note ? `: ${item.dismissed.note}` : ""}`
    : passed && item.gate?.override
      ? `Passed by hand by ${nameOf(item.gate.override.byPersonId)}, ${fmtDate(item.gate.override.at.slice(0, 10))}: ${item.gate.override.note}`
      : item.reason;
  const toggle = (kind: "note" | "dismiss" | "pass") => {
    setNote(kind === "note" ? (manual?.note ?? "") : "");
    setEditing(open === kind ? null : { key: item.key, kind });
  };
  return (
    <li className={`ck-item ${state}`} tabIndex={-1} data-check-row>
      {manual ? (
        <input
          type="checkbox"
          className="ck-tick"
          aria-label={`Done: ${item.label}`}
          checked={item.done}
          disabled={!write}
          onChange={(e) => attempt(() => setCheck(actor, manual.list, manual.ownerId, manual.itemKey, { done: e.target.checked }))}
        />
      ) : (
        <span className="ck-mark" aria-hidden="true">
          {mark}
        </span>
      )}
      <span className="ck-text">
        <span className="ck-label">{item.label}</span>
        {reason && <span className="ck-reason">{reason}</span>}
        {item.manual?.auto && <span className="sr-only">Worked out by the app</span>}
        <span className="sr-only">
          {state === "done" ? "Done" : state === "passed" ? "Passed by hand" : state === "dismissed" ? "Dismissed" : "Not yet"}
        </span>
      </span>
      <span className="ck-acts">
        {item.go && !item.done && (
          <button className="btn small ghost" aria-label={`Go to: ${item.label}`} onClick={() => onGo(item.go!)}>
            Go to
          </button>
        )}
        {manual && write && (
          <button
            className="btn small ghost"
            aria-expanded={open === "note"}
            aria-label={`Note: ${item.label}`}
            onClick={() => toggle("note")}
          >
            Note
          </button>
        )}
        {item.group === "suggestion" && !item.manual && !item.done && !item.dismissed && write && (
          <button
            className="btn small ghost"
            aria-expanded={open === "dismiss"}
            aria-label={`Dismiss: ${item.label}`}
            onClick={() => toggle("dismiss")}
          >
            Dismiss…
          </button>
        )}
        {item.dismissed && write && (
          <button
            className="btn small ghost"
            aria-label={`Bring back: ${item.label}`}
            onClick={() => attempt(() => restoreCheck(actor, checks.ownerId, item.key), "Brought back")}
          >
            Bring back
          </button>
        )}
        {item.gate?.overridable && mayPass && !item.done && (
          <button className="btn small ghost" aria-expanded={open === "pass"} onClick={() => toggle("pass")}>
            Pass by hand…
          </button>
        )}
        {item.gate && passed && mayPass && (
          <button
            className="btn small ghost"
            onClick={async () => {
              if (
                await confirm({
                  title: "Take back passing this gate?",
                  body: `${item.label}. It will need to be met again before the project moves on.`,
                  confirmLabel: "Take back",
                })
              )
                attempt(() => setGateOverride(actor, checks.projectId, item.gate!.key as HardGateKey, null), "Taken back");
            }}
          >
            Take back
          </button>
        )}
      </span>
      {open === "note" && manual && (
        <div className="ck-edit">
          <NoteField
            value={manual.note}
            disabled={!write}
            label={`Note for ${item.label}`}
            onSave={(v) => attempt(() => setCheck(actor, manual.list, manual.ownerId, manual.itemKey, { note: v }), "Note saved")}
          />
        </div>
      )}
      {(open === "dismiss" || open === "pass") && (
        <div className="ck-edit">
          <textarea
            aria-label={open === "pass" ? "Why it can move on without this" : "Why it is dismissed (optional)"}
            placeholder={open === "pass" ? "Why it can move on without this (kept with the project)" : "A note (optional)"}
            value={note}
            maxLength={300}
            rows={2}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="ck-edit-acts">
            <button className="btn small" onClick={() => setEditing(null)}>
              Cancel
            </button>
            {open === "dismiss" ? (
              <button
                className="btn small primary"
                onClick={() => attempt(() => dismissCheck(actor, checks.ownerId, item.key, note), "Dismissed") && setEditing(null)}
              >
                Dismiss
              </button>
            ) : (
              <button
                className="btn small primary"
                disabled={!note.trim()}
                onClick={() =>
                  attempt(
                    () => setGateOverride(actor, checks.projectId, item.gate!.key as HardGateKey, note),
                    "Passed by hand, with your note",
                  ) && setEditing(null)
                }
              >
                Pass it
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function ChecksPanel({
  kind,
  id,
  write,
  chip = false,
  label = "Checks",
}: {
  kind: ChecksKind;
  id: string;
  write: boolean;
  chip?: boolean; // a small count chip, in a call sheet's or Recording Log's header
  label?: string;
}) {
  useDb();
  const { actor, go } = useApp();
  const checks = EVALUATE[kind](id);
  const [open, setOpenState] = useState(() => !chip && readOpen(id));
  const [editing, setEditing] = useState<Editing>(null);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) setEditing(null);
    if (!chip) keepOpen(id, next);
  };
  const focusRow = (which: "first" | "required") => {
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-check-row]") ?? [])];
    (rows.find((r) => which === "first" || r.classList.contains("required")) ?? rows[0])?.focus();
  };
  // A Done button pressed while something required is missing opens the panel (the bar, never a chip), at the first
  // required item.
  useEffect(
    () =>
      chip
        ? undefined
        : onOpenChecks(id, () => {
            setOpen(true);
            root.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            setTimeout(() => focusRow("required"), 0);
          }),
    [id, chip], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // On a wide window the panel floats over the page: a click outside it closes it (a dialog it opened does not).
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!isWide() || !t || root.current?.contains(t) || t.closest(".scrim")) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const project = getRecord(checks.projectId);
  // Dismissals are kept on the project, so a sheet of something else has nowhere to keep them.
  const keeps = write && !!project?.workflow && !project.archived;
  const mayPass =
    write && project?.workflow?.stage === "Development" && !project.archived && (isHop(actor) || can(actor, "pipeline.manage"));
  const summary = checksSummary(checks);
  const clear = !checks.required.length && !checks.suggestions.length;
  const onGo = (g: CheckGo) => {
    if (isWide()) setOpen(false);
    if (g.doc) {
      // The project's page opens the document; from anywhere else, the project's page is opened first.
      if (!openDoc(checks.projectId, g.doc.stage, g.doc.key)) go({ n: "record", id: checks.projectId });
    } else if (g.anchor) goToAnchor(g.anchor);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      bar.current?.focus();
      return;
    }
    const t = e.target as HTMLElement;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-check-row]") ?? [])].filter((r) => r.offsetParent !== null);
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.contains(t));
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? rows.length - 1
          : at < 0
            ? 0
            : (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus();
  };
  const group = (title: string, items: CheckItem[]) =>
    items.length > 0 && (
      <section className="ck-group" aria-label={title}>
        <h3>
          {title} <span className="ck-count">{items.length}</span>
        </h3>
        <ul>
          {items.map((i) => (
            <Row
              key={i.key}
              item={i}
              checks={checks}
              write={keeps}
              mayPass={!!mayPass}
              editing={editing}
              setEditing={setEditing}
              onGo={onGo}
            />
          ))}
        </ul>
      </section>
    );
  return (
    <div className={`ck ${chip ? "ck-chip" : "ck-bar"}${open ? " open" : ""}`} ref={root} onKeyDown={keys}>
      <button
        ref={bar}
        className={`ck-toggle ${clear ? "clear" : checks.required.length ? "need" : "soft"}`}
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => {
          setOpen(!open);
          if (!open) setTimeout(() => focusRow("first"), 0);
        }}
      >
        <span className="ck-dot" aria-hidden="true" />
        <span className="grow">{chip ? (clear ? "All clear" : summary) : `${label}: ${summary}`}</span>
        <span className="ck-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <span className="sr-only" aria-live="polite">
        {label}: {summary}
      </span>
      <div id={popId} className="ck-pop" role="region" aria-label={label} hidden={!open}>
        {clear && !checks.completed.length && <p className="muted ck-empty">Nothing to check here.</p>}
        {clear && checks.completed.length > 0 && <p className="ck-empty ok">Everything needed is in place.</p>}
        {group("Required to move on", checks.required)}
        {group("Suggestions", checks.suggestions)}
        {checks.completed.length > 0 && (
          <details className="ck-done">
            <summary>Completed ({checks.completed.length})</summary>
            <ul>
              {checks.completed.map((i) => (
                <Row
                  key={i.key}
                  item={i}
                  checks={checks}
                  write={keeps}
                  mayPass={!!mayPass}
                  editing={editing}
                  setEditing={setEditing}
                  onGo={onGo}
                />
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
