import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Escape closes only the topmost dialog, so a picker opened from a form does not close the form too.
const open: symbol[] = [];

export function Modal({ title, onClose, children, actions, wide }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
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
      <div className={`modal glass ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
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
