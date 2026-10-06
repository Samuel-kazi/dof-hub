import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type Route } from "./AppContext";
import { Modal } from "./Modal";
import { KIND_LABEL, searchAll } from "../services/search";
import { modulesFor } from "../services/wrapped/permissions";
import { featureOn } from "../services/wrapped/settings";
import { visibleCallSheets } from "../services/access";
import { requestPrint } from "../pages/documents/printCallSheet";
import { todayIso } from "../services/utils";
import { MOD_KEY } from "./keys";

// Ctrl+K (Cmd+K on a Mac): one box to find anything this person may see, projects, episodes and devotions, documents,
// call sheets, crew, gear, loans and drives, and to run a few commands. Arrow keys move, Enter opens, Esc closes.

interface Item {
  key: string;
  kind: string; // shown before the title: "Command", "Project", "Call sheet"
  title: string;
  sub: string;
  run: () => void;
}

export { MOD_KEY };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { actor, go } = useApp();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const open = (r: Route) => {
    onClose();
    go(r);
  };

  const commands = useMemo((): Item[] => {
    const mods = modulesFor(actor);
    const out: Item[] = [];
    const cmd = (key: string, title: string, sub: string, run: () => void) =>
      out.push({ key: `cmd:${key}`, kind: "Command", title, sub, run });
    if (mods.includes("calendar")) cmd("calendar", "Open the Calendar", "", () => open({ n: "calendar" }));
    cmd("callsheets", "Open Call Sheets", "", () => open({ n: "callsheets" }));
    if (mods.includes("equipment")) cmd("equipment", "Open Equipment", "", () => open({ n: "equipment" }));
    if (mods.includes("equipment") && featureOn("lending")) cmd("loan", "New loan", "Lend equipment", () => open({ n: "equipment" }));
    for (const cs of visibleCallSheets(actor).filter((c) => c.date === todayIso()))
      cmd(`print:${cs.id}`, "Print today's run sheet", cs.title, () => {
        requestPrint({ sheetId: cs.id, only: "run" });
        open({ n: "callsheet", id: cs.id });
      });
    cmd("settings", "Open Settings", `${MOD_KEY}+,`, () => open({ n: "settings" }));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  const items = useMemo((): Item[] => {
    const words = q.trim().toLowerCase();
    const cmds = commands.filter((c) => !words || `${c.title} ${c.sub}`.toLowerCase().includes(words));
    const hits = searchAll(actor, q, 5).map((h): Item => ({
      key: `${h.kind}:${h.id}`,
      kind: KIND_LABEL[h.kind],
      title: h.title,
      sub: h.sub,
      run: () => open(h.open),
    }));
    return [...cmds, ...hits];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, commands, actor]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [sel]);

  return (
    <Modal title="Search and commands" onClose={onClose} wide>
      <div className="palette">
        <input
          type="text"
          className="palette-input"
          value={q}
          autoFocus
          placeholder="Find a project, episode, document, call sheet, person or item, or type a command"
          aria-label="Search everything"
          aria-controls="palette-results"
          aria-activedescendant={items[sel] ? `palette-${sel}` : undefined}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              items[sel]?.run();
            }
          }}
        />
        <div className="palette-results" id="palette-results" role="listbox" ref={list} aria-label="Results">
          {items.length === 0 ? (
            <div className="empty">{q.trim().length < 2 ? "Type at least two letters to search." : `Nothing matches "${q.trim()}".`}</div>
          ) : (
            items.map((it, i) => (
              <button
                key={it.key}
                id={`palette-${i}`}
                data-i={i}
                type="button"
                role="option"
                aria-selected={i === sel}
                className={`result ${i === sel ? "sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={it.run}
              >
                <span className="kind">{it.kind}</span>
                <span className="grow" style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block" }}>{it.title}</span>
                  {it.sub && <span className="cid">{it.sub}</span>}
                </span>
              </button>
            ))
          )}
        </div>
        <p className="muted palette-keys">↑ ↓ to move, Enter to open, Esc to close. {MOD_KEY}+K opens this from anywhere.</p>
      </div>
    </Modal>
  );
}
