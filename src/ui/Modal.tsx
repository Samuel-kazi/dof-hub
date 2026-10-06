import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Escape closes only the topmost dialog, so a picker opened from a form does not close the form too.
// Enter confirms: it presses the dialog's main button (the last primary or danger button that is not disabled, so a
// reason still to be written blocks it). In a text area Enter starts a new line and Ctrl+Enter (Cmd+Enter) confirms.
// A deliberate action (publishing, approving, a greenlight, accepting or declining) is never confirmed by Enter alone:
// only by a click, or Ctrl+Enter.
// Opening a dialog moves the keys into it (to the field that asked for the cursor, or else the dialog itself), so an
// Enter meant for the dialog never presses the button that opened it again; closing it gives the cursor back.
const open: symbol[] = [];

export function Modal({
  title,
  onClose,
  children,
  actions,
  wide,
  deliberate = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  deliberate?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      // Only if the cursor went nowhere else (it was in the dialog, now gone).
      const now = document.activeElement;
      if (before?.isConnected && (!now || now === document.body)) before.focus?.();
    };
  }, []);
  useEffect(() => {
    const me = Symbol("modal");
    open.push(me);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && open[open.length - 1] === me && onClose();
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      open.splice(open.indexOf(me), 1);
    };
  }, [onClose]);
  const node = (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal glass ${wide ? "wide" : ""}`}
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return;
          // Only this dialog's own fields: a dialog opened from inside it handles its own keys.
          if (!e.currentTarget.contains(e.target as Node)) return;
          const t = e.target as HTMLElement;
          const mod = e.ctrlKey || e.metaKey;
          if (!mod && (deliberate || ["TEXTAREA", "BUTTON", "A", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
          const buttons = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > .actions .btn.primary, :scope > .actions .btn.danger"),
          ];
          const main = buttons.filter((b) => !b.disabled).pop();
          if (!main) return;
          e.preventDefault();
          e.stopPropagation();
          main.click();
        }}
      >
        <h2>{title}</h2>
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
  // Rendered at the document root: a modal opened from inside a glass panel would otherwise be
  // positioned relative to that panel, because backdrop-filter creates a containing block.
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}
