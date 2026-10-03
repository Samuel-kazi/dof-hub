import { useState, type ReactNode } from "react";
import type { DocumentPage, ProjectDocument } from "../../types";
import { textOf } from "../../services/html";
import { addPage, archivePage, movePage, pagesOf, restorePage } from "../../services/wrapped/documents";
import { useApp } from "../../ui/AppContext";

// The middle pane of an open document: its pages as cards, to open, drag into order, delete (kept, archived) and
// restore, with "+ Add page". A document can also show fixed cards for structured forms that belong with it (a
// session's run sheet and wrap checklist on its day sheet); those open the form, and cannot be moved or deleted.

export interface FixedCard {
  id: string; // what onSelect is given
  title: string;
  note: string;
  at: "start" | "end";
}

export function PageList({
  doc,
  pages,
  selected,
  write,
  onSelect,
  fixed = [],
  emptyText = "No pages. Add one to start writing.",
  head,
}: {
  doc: ProjectDocument | null; // null: not started yet (only the fixed cards show)
  pages: DocumentPage[];
  selected: string | null;
  write: boolean;
  onSelect: (pageId: string) => void;
  fixed?: FixedCard[];
  emptyText?: string;
  head?: ReactNode; // shown above the cards: a day sheet's choice of session
}) {
  const { actor, attempt, confirm, menu } = useApp();
  const [dragging, setDragging] = useState<string | null>(null);
  const deleted = doc ? pagesOf(doc.id, true).filter((p) => p.archivedAt) : [];
  const remove = async (p: DocumentPage) => {
    if (
      await confirm({
        title: `Delete "${p.title}"?`,
        body: "The page is taken out of the document and kept, archived. It can be restored from Deleted pages below.",
        confirmLabel: "Delete page",
        danger: true,
      })
    )
      attempt(() => archivePage(actor, p.id), "Page deleted. It can be restored.");
  };
  const fixedCard = (f: FixedCard) => (
    <li key={f.id} className={`pd-card pd-card-form${f.id === selected ? " on" : ""}`}>
      <button className="pd-card-main" aria-current={f.id === selected ? "page" : undefined} onClick={() => onSelect(f.id)}>
        <span className="pd-card-num" aria-hidden>
          ▤
        </span>
        <span className="pd-card-text">
          <span className="pd-card-title">{f.title}</span>
          <span className="pd-card-snip">
            <span className="pd-tag">form</span> {f.note}
          </span>
        </span>
      </button>
    </li>
  );
  return (
    <div className="pd-pages">
      {head}
      <ol aria-label={doc ? `Pages of ${doc.title}` : "Pages"}>
        {fixed.filter((f) => f.at === "start").map(fixedCard)}
        {pages.map((p, i) => (
          <li
            key={p.id}
            className={`pd-card${p.id === selected ? " on" : ""}${dragging === p.id ? " dragging" : ""}`}
            draggable={write}
            onDragStart={(e) => {
              setDragging(p.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", p.id);
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => {
              if (dragging) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              setDragging(null);
              if (id && id !== p.id) attempt(() => movePage(actor, id, i));
            }}
          >
            <button className="pd-card-main" aria-current={p.id === selected ? "page" : undefined} onClick={() => onSelect(p.id)}>
              <span className="pd-card-num">{i + 1}</span>
              <span className="pd-card-text">
                <span className="pd-card-title">{p.title || "Untitled page"}</span>
                {p.subtitle && <span className="pd-card-sub">{p.subtitle}</span>}
                <span className="pd-card-snip">{textOf(p.bodyHtml).slice(0, 90) || "Nothing written yet"}</span>
              </span>
            </button>
            {write && (
              <button
                className="pd-card-menu"
                aria-label={`Options for page ${i + 1}, ${p.title || "Untitled page"}`}
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  menu({ clientX: r.left, clientY: r.bottom, preventDefault: () => {} }, [
                    { label: "Move up", disabled: i === 0, onClick: () => attempt(() => movePage(actor, p.id, i - 1)) },
                    { label: "Move down", disabled: i === pages.length - 1, onClick: () => attempt(() => movePage(actor, p.id, i + 1)) },
                    { label: "", divider: true, onClick: () => {} },
                    { label: "Delete page", danger: true, onClick: () => void remove(p) },
                  ]);
                }}
              >
                ⋮
              </button>
            )}
          </li>
        ))}
        {fixed.filter((f) => f.at === "end").map(fixedCard)}
      </ol>
      {pages.length === 0 && <p className="muted">{emptyText}</p>}
      {write && doc && (
        <button
          className="btn small pd-add"
          onClick={() => {
            const page = attempt(() => addPage(actor, doc.id, {}));
            if (page) onSelect(page.id);
          }}
        >
          + Add page
        </button>
      )}
      {deleted.length > 0 && (
        <details className="pd-deleted">
          <summary>Deleted pages ({deleted.length})</summary>
          <ul>
            {deleted.map((p) => (
              <li key={p.id}>
                <span className="grow">{p.title || "Untitled page"}</span>
                {write && (
                  <button className="btn small" onClick={() => attempt(() => restorePage(actor, p.id), "Page restored")}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
