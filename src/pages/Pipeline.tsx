import { useState } from "react";
import { ReportButton } from "../ui/ReportDialog";
import { can } from "../services/wrapped/permissions";
import type { CategoryKey, ContentRecord } from "../types";
import { useApp, type MenuItem } from "../ui/AppContext";
import { useDb } from "../data/store";
import { CATEGORIES, categoryOf } from "../config/categories";
import { canWrite, isHop, visibleRecords } from "../services/access";
import { canDelete, currentStageDeadline, deleteRecord, deletionImpact, deletionSummary, displayTitle, getChildren, getRollupStatus, isComplete, levelLabel, usesPipeline } from "../services/wrapped/content";
import { nameOf } from "../services/wrapped/people";
import { fmtShort } from "../services/utils";
import { Empty, RiskBadge, StageBadge } from "../ui/parts";
import { IconChevron, IconDown, IconPlus } from "../ui/Icons";
import { EditRecordModal, NewRecordModal } from "./RecordForms";

/** Right-click and "more" actions shared by every record row and card. */
export function useRecordMenu() {
  const { actor, go, menu, confirm, attempt, toast } = useApp();
  const [editing, setEditing] = useState<ContentRecord | null>(null);
  const items = (r: ContentRecord): MenuItem[] => {
    const write = canWrite(actor, r);
    const del = canDelete(r.contentId);
    return [
      { label: "Open", onClick: () => go({ n: "record", id: r.contentId }) },
      { label: "Edit details…", disabled: !write, onClick: () => setEditing(r) },
      { divider: true, label: "", onClick: () => {} },
      {
        label: del.ok ? "Delete" : "Delete (has active items)",
        danger: true,
        disabled: !write || !del.ok,
        onClick: async () => {
          const impact = attempt(() => deletionImpact(actor, r.contentId));
          if (!impact) return;
          if (impact.blockers.length) { toast(impact.blockers[0], "error"); return; }
          if (await confirm({ title: `Delete “${r.title}”?`, body: deletionSummary(impact), confirmLabel: "Delete", danger: true })) attempt(() => deleteRecord(actor, r.contentId), "Deleted");
        },
      },
    ];
  };
  const modal = editing ? <EditRecordModal record={editing} onClose={() => setEditing(null)} /> : null;
  return { onContext: (e: React.MouseEvent, r: ContentRecord) => menu(e, items(r)), modal };
}

export function Pipeline({ category }: { category?: CategoryKey }) {
  const { actor, go, menu } = useApp();
  useDb();
  const [view, setView] = useState<"board" | "tree">("board");
  const [adding, setAdding] = useState<CategoryKey | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const rm = useRecordMenu();
  const cfg = category ? categoryOf(category) : null;
  const all = visibleRecords(actor);
  const shownCategories = cfg ? [cfg] : CATEGORIES;
  const closedCount = all.filter((r) => (!category || r.category === category) && r.pipelineStage === "Closed").length;
  const tops = all.filter((r) => r.hierarchyLevel === 0 && (!category || r.category === category) && (showClosed || r.pipelineStage !== "Closed"));
  const effective = cfg ? view : "tree";

  const pickCategory = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    menu({ clientX: rect.left - 120, clientY: rect.bottom + 6, preventDefault: () => {} }, CATEGORIES.map((c) => ({ label: `Add to ${c.label}`, onClick: () => setAdding(c.key) })));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>{cfg ? cfg.label : "Content pipeline"}</h1>
          <p className="sub">{cfg ? (cfg.supportsChildren ? (cfg.leafLevel === 1 ? `${cfg.singular} → ${cfg.childLevelLabel}. Each ${cfg.childLevelLabel?.toLowerCase()} moves through the stages on its own.` : `${cfg.singular} → ${cfg.childLevelLabel} → ${cfg.grandchildLevelLabel}. Only ${cfg.grandchildLevelLabel?.toLowerCase()}s move through the stages.`) : `${cfg.stages.map((s) => s.name).join(", ")}`) : "Every project across all categories."}</p>
        </div>
        {cfg && (
          <div className="seg" role="group" aria-label="View">
            <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>Board</button>
            <button className={view === "tree" ? "on" : ""} onClick={() => setView("tree")}>Tree</button>
          </div>
        )}
        <ReportButton scope="pipeline" />
        {can(actor, "pipeline.manage") && (
          <div className="split">
            <button className="btn primary" onClick={(e) => (cfg ? setAdding(cfg.key) : pickCategory(e))}><IconPlus /> {cfg ? `Add ${cfg.singular.toLowerCase()}` : "Add record"}</button>
            <button className="btn primary" onClick={pickCategory} aria-label="Choose category"><IconDown /></button>
          </div>
        )}
      </div>

      <div className="chips" role="group" aria-label="Category">
        <button className={`chip ${cfg ? "" : "on"}`} onClick={() => go({ n: "pipeline" })}>All</button>
        {CATEGORIES.map((c) => <button key={c.key} className={`chip ${category === c.key ? "on" : ""}`} onClick={() => go({ n: "pipeline", category: c.key })}>{c.label}</button>)}
        {closedCount > 0 && <button className={`chip ${showClosed ? "on" : ""}`} onClick={() => setShowClosed((s) => !s)}>Closed ({closedCount})</button>}
      </div>

      {effective === "board" && cfg && (
        <div className="board">
          {cfg.stages.map((st) => {
            const cards = all.filter((r) => r.category === cfg.key && usesPipeline(r) && r.pipelineStage === st.name);
            return (
              <section key={st.name} className="col glass" aria-label={st.name}>
                <h3>{st.name}<span className="muted">{cards.length}</span></h3>
                {cards.map((r) => (
                  <div key={r.contentId} className="card" tabIndex={0} onClick={() => go({ n: "record", id: r.contentId })} onKeyDown={(e) => e.key === "Enter" && go({ n: "record", id: r.contentId })} onContextMenu={(e) => rm.onContext(e, r)}>
                    <span className="t">{displayTitle(r)}</span>
                    <span className="cid">{r.contentId}</span>
                    <span className="muted" style={{ fontSize: ".82rem" }}>{nameOf(r.assigneePersonId)}{currentStageDeadline(r) ? `, due ${fmtShort(currentStageDeadline(r))}` : ""}</span>
                    <RiskBadge record={r} />
                  </div>
                ))}
              </section>
            );
          })}
          {showClosed && closedCount > 0 && (
            <section className="col glass" aria-label="Closed">
              <h3>Closed<span className="muted">{all.filter((r) => r.category === cfg.key && r.pipelineStage === "Closed").length}</span></h3>
              {all.filter((r) => r.category === cfg.key && r.pipelineStage === "Closed").map((r) => (
                <div key={r.contentId} className="card" tabIndex={0} onClick={() => go({ n: "record", id: r.contentId })} onKeyDown={(e) => e.key === "Enter" && go({ n: "record", id: r.contentId })} onContextMenu={(e) => rm.onContext(e, r)}>
                  <span className="t">{displayTitle(r)}</span>
                  <span className="cid">{r.contentId}</span>
                  <span className="muted" style={{ fontSize: ".82rem" }}>{r.closedReason}</span>
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {effective === "tree" && (
        <div className="stack">
          {shownCategories.map((c) => {
            const rows = tops.filter((r) => r.category === c.key);
            return (
              <section key={c.key} className="glass panel">
                {!cfg && <h2>{c.label}</h2>}
                {rows.length === 0 ? <Empty>No {c.label.toLowerCase()} yet.</Empty> : rows.map((r) => <TreeNode key={r.contentId} record={r} onContext={rm.onContext} />)}
              </section>
            );
          })}
        </div>
      )}

      {rm.modal}
      {adding && <NewRecordModal category={adding} onClose={() => setAdding(null)} onCreated={(r) => { setAdding(null); go({ n: "record", id: r.contentId }); }} />}
    </div>
  );
}

function TreeNode({ record, onContext }: { record: ContentRecord; onContext: (e: React.MouseEvent, r: ContentRecord) => void }) {
  const { go } = useApp();
  const [open, setOpen] = useState(record.hierarchyLevel === 0);
  const kids = getChildren(record.contentId);
  const hasKids = kids.length > 0;
  const roll = !usesPipeline(record) ? getRollupStatus(record.contentId) : null;
  return (
    <div>
      <div className="tree-row" onContextMenu={(e) => onContext(e, record)} onClick={() => go({ n: "record", id: record.contentId })}>
        <button className={`tw ${open ? "open" : ""}`} style={{ visibility: hasKids ? "visible" : "hidden" }} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} aria-label={open ? "Collapse" : "Expand"}><IconChevron /></button>
        <div className="grow">
          <div className="title">{record.title}</div>
          <span className="cid">{record.contentId}</span>
        </div>
        <span className="muted" style={{ fontSize: ".82rem" }}>{levelLabel(record)}</span>
        {roll ? <span className="badge">{roll.complete} of {roll.total} complete</span> : <><StageBadge record={record} /><RiskBadge record={record} /></>}
      </div>
      {open && hasKids && (
        <div className="tree-kids">
          {kids.map((k) => <TreeNode key={k.contentId} record={k} onContext={onContext} />)}
        </div>
      )}
    </div>
  );
}
