import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DocumentPage, ProjectDocument } from "../../types";
import { ConflictError, RuleError } from "../../types";
import { changeSaved, lastChange } from "../../data/remote";
import { cleanHtml, textOf } from "../../services/html";
import { savePage, type PageEdit } from "../../services/wrapped/documents";
import { nameOf } from "../../services/wrapped/people";
import { fmtTime } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import type { RichTextHandle } from "./RichText";

// The right pane of an open document: one page, with its title, its subtitle (a devotion's scripture, or a note), the
// rich-text body and when it was last saved. It saves by itself 800 ms after the writer stops, and never loses their
// words: a copy is kept on this computer until the server has the save, a save that fails or meets someone else's
// newer save leaves the words on screen with a choice, and leaving with words not saved asks first.

const RichText = lazy(() => import("./RichText"));

const SAVE_AFTER_MS = 800;
// A layout effect in the browser; drawn on the server (in the tests), a plain one, which does nothing there.
const useLayoutEffectHere = typeof window === "undefined" ? useEffect : useLayoutEffect;
const MAX_LINE = 300;

type SaveState =
  | { kind: "idle" } // nothing typed since the page was opened
  | { kind: "pending" } // typed; saving shortly
  | { kind: "sending" } // saved here, on its way to the server
  | { kind: "saved"; at: string }
  | { kind: "failed"; message: string }
  | { kind: "conflict" };

// ── The copy kept on this computer until a save is safe ──────

interface Draft {
  title: string;
  subtitle: string;
  html: string;
  at: string;
  token: string;
}
const draftKey = (pageId: string) => `dof-hub-draft:${pageId}`;

function readDraft(pageId: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(pageId));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
function keepDraft(pageId: string, d: Draft): void {
  try {
    localStorage.setItem(draftKey(pageId), JSON.stringify(d));
  } catch {
    /* no room, or storage turned off: the words are still on screen */
  }
}
/** Forgets the copy, unless a newer one (from a later save) has replaced it. */
function forgetDraft(pageId: string, token?: string): void {
  try {
    if (token && readDraft(pageId)?.token !== token) return;
    localStorage.removeItem(draftKey(pageId));
  } catch {
    /* nothing kept */
  }
}

/** How the service stores a title or subtitle, so a stray space is not mistaken for a change. */
const lineOf = (s: string, empty = "") => s.trim().slice(0, MAX_LINE) || empty;

export interface PageEditorHandle {
  /** Saves anything waiting. Returns null if nothing would be lost by leaving, or what would. */
  leave: () => string | null;
}

interface Props {
  doc: ProjectDocument;
  page: DocumentPage;
  write: boolean;
  subtitleLabel: string;
}

export const PageEditor = forwardRef<PageEditorHandle, Props>(function PageEditor({ doc, page, write, subtitleLabel }, ref) {
  const { actor, setLeaveGuard, toast } = useApp();
  // Cleaned again on the way in, whatever is stored.
  const initialHtml = useMemo(() => cleanHtml(page.bodyHtml), [page.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(page.title);
  const [subtitle, setSubtitle] = useState(page.subtitle);
  const [state, setStateNow] = useState<SaveState>({ kind: "idle" });
  const [leftover, setLeftover] = useState<Draft | null>(null);
  const text = useRef<RichTextHandle | null>(null);
  const status = useRef<SaveState>(state);
  const base = useRef({ version: page.version, title: page.title, subtitle: page.subtitle });
  const bodyTyped = useRef(false);
  const fields = useRef({ title, subtitle });
  fields.current = { title, subtitle };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const setState = (next: SaveState) => {
    status.current = next;
    if (mounted.current) setStateNow(next);
  };

  // Words from an earlier visit that never reached the server are offered back.
  useEffect(() => {
    if (!write) return;
    const d = readDraft(page.id);
    if (!d) return;
    const same =
      cleanHtml(d.html) === cleanHtml(page.bodyHtml) &&
      lineOf(d.title, "Untitled page") === page.title &&
      lineOf(d.subtitle) === page.subtitle;
    if (same) forgetDraft(page.id);
    else setLeftover(d);
  }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const unsavedEdit = (): PageEdit => {
    const edit: PageEdit = {};
    if (bodyTyped.current && text.current) edit.bodyHtml = text.current.html();
    if (lineOf(fields.current.title, "Untitled page") !== base.current.title) edit.title = fields.current.title;
    if (lineOf(fields.current.subtitle) !== base.current.subtitle) edit.subtitle = fields.current.subtitle;
    return edit;
  };

  /** Saves now. False if it could not be saved here (the words stay on screen). */
  const save = (): boolean => {
    clearTimeout(timer.current);
    if (!write) return true;
    const edit = unsavedEdit();
    if (!Object.keys(edit).length) {
      if (status.current.kind === "pending") setState({ kind: "saved", at: new Date().toISOString() });
      return true;
    }
    const token = `${Date.now()}-${Math.random()}`;
    keepDraft(page.id, {
      title: fields.current.title,
      subtitle: fields.current.subtitle,
      html: edit.bodyHtml ?? text.current?.html() ?? initialHtml,
      at: new Date().toISOString(),
      token,
    });
    const before = lastChange();
    let saved: DocumentPage;
    try {
      saved = savePage(actor, page.id, edit, base.current.version);
    } catch (e) {
      if (e instanceof ConflictError) setState({ kind: "conflict" });
      else setState({ kind: "failed", message: e instanceof RuleError ? e.message : "This page could not be saved." });
      return false;
    }
    bodyTyped.current = false;
    base.current = { version: saved.version, title: saved.title, subtitle: saved.subtitle };
    const change = lastChange();
    if (change === before) {
      // The local demo and the desktop app: saved for good.
      forgetDraft(page.id, token);
      setState({ kind: "saved", at: saved.updatedAt });
      return true;
    }
    setState({ kind: "sending" });
    void changeSaved(change).then((ok) => {
      if (ok) {
        forgetDraft(page.id, token);
        if (status.current.kind === "sending" && lastChange() === change) setState({ kind: "saved", at: saved.updatedAt });
      } else {
        // The server refused it, and the screen went back to the server's copy. The words stay here, and the copy kept
        // on this computer stays until they are saved.
        bodyTyped.current = true;
        setState({ kind: "failed", message: "Your last change did not reach the server. Your words are still here." });
      }
    });
    return true;
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const typed = () => {
    if (status.current.kind === "failed" || status.current.kind === "conflict") return; // the writer decides first
    if (status.current.kind !== "pending") setState({ kind: "pending" });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saveRef.current(), SAVE_AFTER_MS);
  };

  const bodyChanged = () => {
    bodyTyped.current = true;
    typed();
  };

  const leave = (): string | null => {
    if (status.current.kind === "pending") saveRef.current();
    const k = status.current.kind;
    if (k !== "failed" && k !== "conflict") return null;
    return `Your last change to "${fields.current.title || "this page"}" is not saved. If you leave, your words are kept on this computer and offered back when you open the page again.`;
  };
  useImperativeHandle(ref, () => ({ leave }));

  // Going to another screen of the app saves first, and asks if something could not be saved. (Set after every
  // draw, so it always holds this page's own check.)
  useEffect(() => {
    setLeaveGuard(() => leave());
    return () => setLeaveGuard(null);
  });

  // Closing the tab or window with words not yet on the server asks first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (status.current.kind === "pending") saveRef.current();
      if (status.current.kind === "idle" || status.current.kind === "saved") return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // Leaving the page by any other way saves what is waiting, while the editor is still there to read.
  useLayoutEffectHere(() => {
    mounted.current = true;
    return () => {
      try {
        if (status.current.kind === "pending") saveRef.current();
      } catch {
        /* the copy kept on this computer has the words */
      }
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  // Someone else's save (or the server's copy after a refusal) arrives.
  useEffect(() => {
    if (page.version === base.current.version) return;
    const k = status.current.kind;
    if (k === "sending" || k === "failed" || k === "conflict") return;
    if (k === "pending") {
      clearTimeout(timer.current);
      setState({ kind: "conflict" });
      return;
    }
    text.current?.setHtml(cleanHtml(page.bodyHtml));
    setTitle(page.title);
    setSubtitle(page.subtitle);
    base.current = { version: page.version, title: page.title, subtitle: page.subtitle };
  }, [page.version]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Saves the writer's words over whatever is saved now. */
  const keepMine = () => {
    base.current = { version: page.version, title: page.title, subtitle: page.subtitle };
    bodyTyped.current = true;
    setState({ kind: "pending" });
    saveRef.current();
  };
  /** Shows the saved version, putting the writer's words aside. */
  const useSaved = () => {
    clearTimeout(timer.current);
    text.current?.setHtml(cleanHtml(page.bodyHtml));
    setTitle(page.title);
    setSubtitle(page.subtitle);
    base.current = { version: page.version, title: page.title, subtitle: page.subtitle };
    bodyTyped.current = false;
    forgetDraft(page.id);
    setState({ kind: "idle" });
  };
  const copyMine = async () => {
    const words = textOf(text.current?.html() ?? "");
    try {
      await navigator.clipboard.writeText(`${fields.current.title}\n${fields.current.subtitle}\n\n${words}`.trim());
      toast("Your words are copied.", "success");
    } catch {
      toast("Could not copy. Select the words and copy them yourself.", "error");
    }
  };
  const putBack = (d: Draft) => {
    text.current?.setHtml(cleanHtml(d.html));
    setTitle(d.title);
    setSubtitle(d.subtitle);
    setLeftover(null);
    base.current = { version: page.version, title: page.title, subtitle: page.subtitle };
    bodyTyped.current = true;
    setState({ kind: "pending" });
    saveRef.current();
  };

  const savedLine =
    state.kind === "pending" || state.kind === "sending" ? (
      <span className="pd-status busy">Saving…</span>
    ) : state.kind === "failed" || state.kind === "conflict" ? (
      <span className="pd-status bad">Not saved</span>
    ) : state.kind === "saved" ? (
      <span className="pd-status">Saved @ {fmtTime(state.at)}</span>
    ) : (
      <span className="pd-status">
        {page.updatedBy === "migration" ? "Moved from the old form" : `Saved @ ${fmtTime(page.updatedAt)}`}
        {page.updatedBy !== "migration" && page.version > 1 ? `, by ${nameOf(page.updatedBy)}` : ""}
      </span>
    );

  return (
    <div className="pd-page" aria-label={`Page: ${title || "Untitled page"}`}>
      <div className="pd-page-head">
        <input
          className="pd-title"
          aria-label="Page title"
          value={title}
          readOnly={!write}
          maxLength={MAX_LINE}
          placeholder="Page title"
          onChange={(e) => {
            setTitle(e.target.value);
            typed();
          }}
        />
        <div aria-live="polite">{savedLine}</div>
      </div>
      <input
        className="pd-subtitle"
        aria-label={subtitleLabel}
        value={subtitle}
        readOnly={!write}
        maxLength={MAX_LINE}
        placeholder={write ? subtitleLabel : ""}
        onChange={(e) => {
          setSubtitle(e.target.value);
          typed();
        }}
      />
      {leftover && (
        <div className="banner warn" role="alert">
          <span className="grow">
            Words you wrote on this page at {fmtTime(leftover.at)} did not reach the server. They are kept on this computer.
          </span>
          <button className="btn small primary" onClick={() => putBack(leftover)}>
            Put my words back
          </button>
          <button
            className="btn small"
            onClick={() => {
              forgetDraft(page.id);
              setLeftover(null);
            }}
          >
            Discard them
          </button>
        </div>
      )}
      {(state.kind === "failed" || state.kind === "conflict") && (
        <div className="banner bad" role="alert">
          <span className="grow">
            {state.kind === "conflict"
              ? "Someone else saved this page while you were writing. Your words are still here: keep yours, or use theirs."
              : state.message}
          </span>
          <button className="btn small primary" onClick={keepMine}>
            {state.kind === "conflict" ? "Keep mine" : "Save again"}
          </button>
          <button className="btn small" onClick={() => void copyMine()}>
            Copy my words
          </button>
          <button className="btn small danger" onClick={useSaved}>
            {state.kind === "conflict" ? "Use theirs" : "Use the saved version"}
          </button>
        </div>
      )}
      <Suspense fallback={<div className="pd-paper pd-loading">Opening the page…</div>}>
        <RichText
          ref={(h) => {
            if (h) text.current = h;
          }}
          initialHtml={initialHtml}
          editable={write}
          label={`${doc.title}: ${title || "page"}`}
          placeholder={write ? "Start writing…" : "Nothing written here yet."}
          onTyping={bodyChanged}
        />
      </Suspense>
    </div>
  );
});
