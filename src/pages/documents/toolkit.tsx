import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import type { Actor, ContentRecord } from "../../types";
import { getDb } from "../../data/store";
import { canView } from "../../services/access";
import { useApp } from "../../ui/AppContext";
import { imageSrc, storeImage } from "./images";
import { focusNext } from "../../ui/keys";

// Pieces the Storyboard and Shot List share: a field that saves itself as people type (800 ms after they stop, and
// when they leave it), an image slot (click or drop a picture to add it, replace or remove it), and the lists the
// "new" forms offer (the project's episodes, and boards to start from).

const SAVE_AFTER_MS = 800;

/**
 * A one-line field that keeps what is typed and saves it shortly after typing stops, or on leaving the field. Enter
 * saves it and moves to the next field (or, at the end of a row of a run sheet or shot list, adds a row below with
 * `onEnterAdd`); Esc puts back what was there before the edit.
 */
export function SavedInput({
  value,
  onSave,
  disabled,
  onEnterAdd,
  ...rest
}: { value: string; onSave: (next: string) => void; disabled?: boolean; onEnterAdd?: (draft: string) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
>) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(draft);
  latest.current = draft;
  const save = useRef(onSave);
  save.current = onSave;
  // Someone else's change shows, unless this field is being typed in.
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    if (latest.current !== value) save.current(latest.current);
  };
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      {...rest}
      type={rest.type ?? "text"}
      value={draft}
      disabled={disabled}
      onChange={(e) => {
        setDraft(e.target.value);
        dirty.current = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, SAVE_AFTER_MS);
      }}
      onBlur={flush}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault(); // a dialog the field is in does not take this Enter as its own
          if (onEnterAdd) {
            // The row's last field: its words and the new row below go in one change.
            clearTimeout(timer.current);
            dirty.current = false;
            onEnterAdd(latest.current);
          } else {
            flush();
            focusNext(e.currentTarget);
          }
        } else if (e.key === "Escape" && dirty.current) {
          e.preventDefault();
          e.stopPropagation(); // put back the edit; a second Esc closes a dialog
          clearTimeout(timer.current);
          dirty.current = false;
          setDraft(value);
        }
        rest.onKeyDown?.(e);
      }}
    />
  );
}

/** A picture's slot: shows it, and lets someone who may write add one by clicking or dropping, replace it or remove it. */
export function ImageSlot({
  path,
  projectId,
  write,
  label,
  onChange,
  compact,
}: {
  path: string | null;
  projectId: string;
  write: boolean;
  label: string;
  onChange: (next: string | null) => void;
  compact?: boolean;
}) {
  const { toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const src = imageSrc(path);
  const take = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
      toast("Choose a picture: a JPEG, PNG or WebP file.", "error");
      return;
    }
    setBusy(true);
    try {
      onChange(await storeImage(file, projectId));
    } catch (e) {
      toast(e instanceof Error ? e.message : "That picture could not be added.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`pd-image${compact ? " compact" : ""}${over ? " over" : ""}${src ? " has" : ""}`}
      onDragOver={(e) => {
        if (!write || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!write || !e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void take(e.dataTransfer.files[0]);
      }}
    >
      {src ? (
        <img src={src} alt={label} />
      ) : write ? (
        <button type="button" className="pd-image-add" onClick={() => input.current?.click()} aria-label={`Add a picture: ${label}`}>
          {busy ? "Adding…" : compact ? "+ Image" : "Click or drop a picture"}
        </button>
      ) : (
        <span className="pd-image-none">No picture</span>
      )}
      {src && write && (
        <div className="pd-image-actions">
          <button type="button" className="btn small" onClick={() => input.current?.click()} aria-label={`Replace the picture: ${label}`}>
            {compact ? "↺" : "Replace"}
          </button>
          <button type="button" className="btn small" onClick={() => onChange(null)} aria-label={`Remove the picture: ${label}`}>
            {compact ? "×" : "Remove"}
          </button>
        </div>
      )}
      {write && (
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => {
            void take(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      )}
    </div>
  );
}

/** A project's episodes, for tying a board or list to one of them. */
export const episodesOfProject = (projectId: string): ContentRecord[] =>
  getDb()
    .records.filter((r) => r.parentId === projectId && r.episode && !r.archived)
    .sort((a, b) => a.contentId.localeCompare(b.contentId));

/** Boards (or lists) someone may start a new one from: in this project or any other they may see, by project. */
export function startingPoints<T extends { id: string; contentId: string | null; name: string; isTemplate?: boolean }>(
  actor: Actor,
  all: T[],
): { project: string; items: T[] }[] {
  const db = getDb();
  const groups = new Map<string, T[]>();
  // Templates come first; the ones kept in Documents for practice or an event after them (anyone but a partner).
  const library = actor.role === "PTR" ? [] : all.filter((it) => !it.contentId);
  if (library.some((it) => it.isTemplate))
    groups.set(
      "Templates",
      library.filter((it) => it.isTemplate),
    );
  if (library.some((it) => !it.isTemplate))
    groups.set(
      "Kept in Documents",
      library.filter((it) => !it.isTemplate),
    );
  for (const it of all) {
    if (!it.contentId) continue;
    const p = db.records.find((r) => r.contentId === it.contentId);
    if (!p || !canView(actor, p)) continue;
    const key = `${p.title} (${p.contentId})`;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return [...groups].map(([project, items]) => ({ project, items }));
}
