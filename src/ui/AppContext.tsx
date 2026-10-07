import { createPortal } from "react-dom";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Actor, CategoryKey, Person } from "../types";
import { RuleError } from "../types";
import type { ModuleKey } from "../config/roles";
import { getPerson } from "../services/wrapped/people";
import { Modal } from "./Modal";
import { PersonPanel, type PersonContext } from "./PersonPanel";
import { MOD_KEY } from "./keys";

export type Route =
  | { n: "dashboard" }
  | { n: "pipeline"; category?: CategoryKey }
  | { n: "record"; id: string }
  | { n: "session"; id: string }
  | { n: "livecontrol"; id: string } // a live day's Live Control (build prompt v4, section 9b)
  | { n: "template"; id: string }
  | { n: "callsheets" }
  | { n: "callsheet"; id: string }
  | { n: "crew"; tab?: "crew" | "volunteers" | "partners" | "workload" }
  | { n: "person"; id: string }
  | { n: "soon"; module: ModuleKey }
  | { n: "equipment"; tab?: "inventory" | "checkouts" | "lending" | "kits" | "incidents" }
  | { n: "item"; id: string }
  | { n: "manifest"; id: string }
  | { n: "documents" }
  | { n: "doc"; id: string }
  | { n: "storage" }
  | { n: "drive"; id: string }
  | { n: "access" }
  | { n: "calendar" }
  | { n: "settings" };

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
}

interface ConfirmOpts {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  // A deliberate action (publish, approve, greenlight, accept or decline): Enter alone never confirms it, only a click
  // or Ctrl+Enter (Cmd+Enter on a Mac). A danger confirmation (a delete, a removal) is always deliberate.
  deliberate?: boolean;
}

interface Ctx {
  actor: Actor;
  me: Person;
  route: Route;
  go: (r: Route) => void;
  back: () => void;
  canBack: boolean;
  toast: (msg: string, kind?: "info" | "error" | "success") => void;
  /** Runs an action, turning rule violations into friendly toasts. Returns undefined on failure. */
  attempt: <T>(fn: () => T, okMsg?: string) => T | undefined;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  menu: (e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) => void;
  logout: () => void;
  /** Tells the person something finished, with a message and an entry in the bell. */
  notify: (title: string, body?: string) => void;
  notifications: AppNote[];
  clearNotifications: () => void;
  printReport: (report: ReportDoc) => void;
  /** A shareable URL to a screen (the current one by default). Anyone who opens it and has access lands there directly. */
  shareLink: (r?: Route) => string;
  /** Copies a shareable link to the clipboard and confirms with a toast. */
  copyLink: (r?: Route) => Promise<void>;
  /**
   * A screen with words not yet saved (a page of writing) sets this. Before going to another screen, the app calls
   * it: it saves what it can and returns null, or says what would be lost, and the person is asked first.
   */
  setLeaveGuard: (guard: (() => string | null) | null) => void;
  /** Opens someone's contact card: their phone, email and role, as far as the viewer may see them. */
  showPerson: (personId: string, context?: PersonContext) => void;
}

export interface AppNote {
  id: number;
  title: string;
  body: string;
  at: string;
}

import type { ReportDoc } from "../services/reports";
import { syncEvents } from "../data/remote";
import { ReportView } from "./ReportView";
import { encodeRoute, routeFromLocation, urlForRoute } from "./routeLink";

const AppCtx = createContext<Ctx | null>(null);
export const useApp = (): Ctx => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside provider");
  return c;
};

export function AppProvider({ actor, onLogout, children }: { actor: Actor; onLogout: () => void; children: ReactNode }) {
  // A link shared before signing in lands here once, right after login, instead of on the dashboard.
  const [stack, setStack] = useState<Route[]>(() => {
    const r = routeFromLocation();
    return [r ?? { n: "dashboard" }];
  });
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const [menuState, setMenuState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const idRef = useRef(0);
  const [notes, setNotes] = useState<AppNote[]>([]);
  useEffect(() => {
    syncEvents.onError = (m) => toast(m, "error");
    return () => {
      syncEvents.onError = () => {};
    };
  }, []);
  const [printing, setPrinting] = useState<ReportDoc | null>(null);
  const [personShown, setPersonShown] = useState<{ id: string; context?: PersonContext } | null>(null);
  const showPerson = useCallback((id: string, context?: PersonContext) => setPersonShown({ id, context }), []);

  const leaveGuard = useRef<(() => string | null) | null>(null);
  const setLeaveGuard = useCallback((guard: (() => string | null) | null) => {
    leaveGuard.current = guard;
  }, []);
  const [leaving, setLeaving] = useState<{ why: string; then: () => void } | null>(null);
  const guarded = useCallback((then: () => void) => {
    const why = leaveGuard.current?.() ?? null;
    if (why) setLeaving({ why, then });
    else then();
  }, []);
  const go = useCallback((r: Route) => guarded(() => setStack((s) => [...s, r])), [guarded]);
  const back = useCallback(() => guarded(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))), [guarded]);
  const toast = useCallback((msg: string, kind: "info" | "error" | "success" = "info") => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4500);
  }, []);
  const notify = useCallback((title: string, body = "") => {
    const id = ++idRef.current;
    setNotes((n) => [{ id, title, body, at: new Date().toISOString() }, ...n].slice(0, 20));
    setToasts((t) => [...t, { id, msg: body ? `${title}. ${body}` : title, kind: "success" }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);
  const printReport = useCallback((report: ReportDoc) => {
    setPrinting(report);
    // Let the report draw, then open the print dialog.
    setTimeout(() => {
      document.body.classList.add("printing-report");
      const done = () => {
        document.body.classList.remove("printing-report");
        setPrinting(null);
        window.removeEventListener("afterprint", done);
      };
      window.addEventListener("afterprint", done);
      window.print();
    }, 150);
  }, []);
  const attempt = useCallback(
    <T,>(fn: () => T, okMsg?: string): T | undefined => {
      try {
        const out = fn();
        if (okMsg) toast(okMsg, "success");
        return out;
      } catch (e) {
        if (e instanceof RuleError) toast(e.message, "error");
        else {
          console.error(e);
          toast("Something went wrong. Nothing was changed.", "error");
        }
        return undefined;
      }
    },
    [toast],
  );
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...o, resolve })), []);
  const menu = useCallback((e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) => {
    e.preventDefault();
    setMenuState({
      x: Math.min(e.clientX, window.innerWidth - 220),
      y: Math.min(e.clientY, window.innerHeight - items.length * 40 - 20),
      items,
    });
  }, []);

  useEffect(() => {
    if (!menuState) return;
    const close = () => setMenuState(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", esc);
    };
  }, [menuState]);

  const me = getPerson(actor.personId)!;
  const route = stack[stack.length - 1];
  // Keeps the address bar (and Copy Link) always pointed at the screen actually showing, without
  // touching browser history: back and forward inside the app stay purely the in-app stack above.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = `#${encodeRoute(route)}`;
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }, [route]);
  const shareLink = useCallback((r?: Route) => urlForRoute(r ?? route), [route]);
  const copyLink = useCallback(
    async (r?: Route) => {
      const url = shareLink(r);
      try {
        await navigator.clipboard.writeText(url);
        toast("Link copied. Anyone with access can open it to jump straight here.", "success");
      } catch {
        toast(url, "info");
      }
    },
    [shareLink, toast],
  );
  const value = useMemo<Ctx>(
    () => ({
      actor,
      me,
      route,
      go,
      back,
      canBack: stack.length > 1,
      toast,
      attempt,
      confirm,
      menu,
      logout: () => guarded(onLogout),
      notify,
      notifications: notes,
      clearNotifications: () => setNotes([]),
      printReport,
      shareLink,
      copyLink,
      setLeaveGuard,
      showPerson,
    }),
    [
      actor,
      me,
      route,
      stack,
      go,
      back,
      guarded,
      toast,
      attempt,
      confirm,
      menu,
      onLogout,
      notify,
      notes,
      printReport,
      shareLink,
      copyLink,
      setLeaveGuard,
      showPerson,
    ],
  );

  return (
    <AppCtx.Provider value={value}>
      {children}
      {menuState && (
        <div className="menu" style={{ left: menuState.x, top: menuState.y }} onClick={(e) => e.stopPropagation()} role="menu">
          {menuState.items.map((it, i) =>
            it.divider ? (
              <hr key={i} />
            ) : (
              <button
                key={i}
                role="menuitem"
                className={it.danger ? "danger" : ""}
                disabled={it.disabled}
                onClick={() => {
                  setMenuState(null);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
      {confirmState && (
        <Modal
          title={confirmState.title}
          deliberate={confirmState.deliberate || confirmState.danger}
          onClose={() => {
            confirmState.resolve(false);
            setConfirmState(null);
          }}
          actions={
            <>
              <button
                className="btn"
                onClick={() => {
                  confirmState.resolve(false);
                  setConfirmState(null);
                }}
              >
                Cancel
              </button>
              <button
                className={`btn ${confirmState.danger ? "danger" : "primary"}`}
                onClick={() => {
                  confirmState.resolve(true);
                  setConfirmState(null);
                }}
              >
                {confirmState.confirmLabel ?? "Confirm"}
              </button>
            </>
          }
        >
          <p className="sub">{confirmState.body}</p>
          {(confirmState.deliberate || confirmState.danger) && (
            <p className="muted" style={{ fontSize: ".84rem" }}>
              Click {confirmState.confirmLabel ?? "Confirm"}, or press {MOD_KEY}+Enter.
            </p>
          )}
        </Modal>
      )}
      {leaving && (
        <Modal
          title="Leave without saving?"
          onClose={() => setLeaving(null)}
          actions={
            <>
              <button className="btn" onClick={() => setLeaving(null)} autoFocus>
                Stay here
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const { then } = leaving;
                  leaveGuard.current = null;
                  setLeaving(null);
                  then();
                }}
              >
                Leave anyway
              </button>
            </>
          }
        >
          <p className="sub">{leaving.why}</p>
        </Modal>
      )}
      {personShown && (
        <PersonPanel
          actor={actor}
          personId={personShown.id}
          context={personShown.context}
          onClose={() => setPersonShown(null)}
          onOpenPage={(id) => {
            setPersonShown(null);
            go({ n: "person", id });
          }}
        />
      )}
      {printing &&
        typeof document !== "undefined" &&
        createPortal(
          <div id="print-root">
            <ReportView report={printing} />
          </div>,
          document.body,
        )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}
