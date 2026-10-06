import { useState } from "react";
import type { ShotList, ShotListRow, ShotRowType } from "../../types";
import { getDb } from "../../data/store";
import { SHOT_MOVEMENTS, SHOT_SIZES, SHOT_TYPES } from "../../config/documentCatalog";
import {
  addShotRow,
  deleteShotRows,
  duplicateShotRow,
  estimatedMinutes,
  moveShotRow,
  renameShotList,
  rowsOfShotList,
  shotListsOf,
  shotNumbers,
  updateShotRow,
  type RowEdit,
} from "../../services/wrapped/documents";
import type { Project } from "../../services/wrapped/workflow";
import { useApp } from "../../ui/AppContext";
import { Empty } from "../../ui/parts";
import { NewBoardModal } from "./Storyboards";
import { ImageSlot, SavedInput } from "./toolkit";

// The Shot List, in Pre-production: the project's lists on the left, each with its number of shots, and "+ New shot
// list", which can start as a copy of any list the person may see. The chosen list is a table: a picture, the shot's
// number (counting shots only), what it is, its size, type and movement (chosen from the usual ones or typed), and
// its estimated time; a setup row holds lighting, lens or camera notes across the table, and a banner divides it into
// sections. Rows are dragged into order, duplicated and deleted, and the times add up at the foot. Everything saves as
// it is typed. A call sheet may read it; only this page changes it.

/** Minutes as "1 h 25 min". */
export function minutesLabel(total: number): string {
  const m = Math.round(total * 10) / 10;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = Math.round((m - h * 60) * 10) / 10;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const ROW_LABEL: Record<ShotRowType, string> = { shot: "Shot", setup: "Setup", banner: "Banner" };

function Row({
  list,
  row,
  index,
  count,
  number,
  write,
  selected,
  onSelect,
  onDragStart,
  onDrop,
}: {
  list: ShotList;
  row: ShotListRow;
  index: number;
  count: number;
  number: number | undefined;
  write: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const { actor, attempt, confirm, menu } = useApp();
  const save = (edit: RowEdit) => attempt(() => updateShotRow(actor, row.id, edit));
  const name = row.rowType === "shot" ? `shot ${number}` : `${ROW_LABEL[row.rowType].toLowerCase()} row ${index + 1}`;
  const lead = (
    <>
      <td className="pd-cell-check">
        {write && <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${name}`} />}
      </td>
      <td
        className="pd-cell-grip"
        draggable={write}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/x-row", row.id);
          e.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
        title={write ? "Drag to reorder" : undefined}
        aria-hidden="true"
      >
        {write ? "⠿" : ""}
      </td>
    </>
  );
  const options = write ? (
    <td className="pd-cell-menu">
      <button
        className="pd-card-menu"
        aria-label={`Options for ${name}`}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          menu({ clientX: Math.max(0, r.left - 160), clientY: r.bottom, preventDefault: () => {} }, [
            { label: "Duplicate", onClick: () => attempt(() => duplicateShotRow(actor, row.id), "Row duplicated") },
            { label: "Move up", disabled: index === 0, onClick: () => attempt(() => moveShotRow(actor, row.id, index - 1)) },
            { label: "Move down", disabled: index === count - 1, onClick: () => attempt(() => moveShotRow(actor, row.id, index + 1)) },
            { label: "", divider: true, onClick: () => {} },
            {
              label: "Delete",
              danger: true,
              onClick: async () => {
                if (
                  await confirm({
                    title: `Delete ${name}?`,
                    body: "The row is removed from this shot list.",
                    confirmLabel: "Delete",
                    danger: true,
                  })
                )
                  attempt(() => deleteShotRows(actor, [row.id]), "Row deleted");
              },
            },
          ]);
        }}
      >
        ⋮
      </button>
    </td>
  ) : (
    <td />
  );
  const dropProps = {
    onDragOver: (e: React.DragEvent) => write && e.dataTransfer.types.includes("text/x-row") && e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("text/x-row")) return;
      e.preventDefault();
      onDrop();
    },
  };
  if (row.rowType !== "shot")
    return (
      <tr className={`pd-row-${row.rowType}${selected ? " on" : ""}`} {...dropProps}>
        {lead}
        <td colSpan={7}>
          <div className="pd-row-wide">
            <span className="pd-row-kind">{ROW_LABEL[row.rowType]}</span>
            <SavedInput
              value={row.description}
              disabled={!write}
              placeholder={row.rowType === "setup" ? "Lighting, lens or camera setup" : "Section name"}
              aria-label={`${ROW_LABEL[row.rowType]}, row ${index + 1}`}
              onSave={(v) => save({ description: v })}
            />
          </div>
        </td>
        {options}
      </tr>
    );
  return (
    <tr className={selected ? "on" : undefined} {...dropProps}>
      {lead}
      <td className="pd-cell-image">
        <ImageSlot
          compact
          path={row.imagePath}
          projectId={list.contentId ?? "documents"}
          write={write}
          label={name}
          onChange={(imagePath) => save({ imagePath })}
        />
      </td>
      <td className="pd-cell-num">{number}</td>
      <td>
        <SavedInput
          value={row.description}
          disabled={!write}
          placeholder="What the shot shows"
          aria-label={`Description of ${name}`}
          onSave={(v) => save({ description: v })}
        />
      </td>
      <td className="pd-cell-pick">
        <SavedInput
          list="pd-shot-sizes"
          value={row.shotSize}
          disabled={!write}
          aria-label={`Shot size of ${name}`}
          onSave={(v) => save({ shotSize: v })}
        />
      </td>
      <td className="pd-cell-pick">
        <SavedInput
          list="pd-shot-types"
          value={row.shotType}
          disabled={!write}
          aria-label={`Shot type of ${name}`}
          onSave={(v) => save({ shotType: v })}
        />
      </td>
      <td className="pd-cell-pick">
        <SavedInput
          list="pd-shot-moves"
          value={row.movement}
          disabled={!write}
          aria-label={`Movement of ${name}`}
          onSave={(v) => save({ movement: v })}
        />
      </td>
      <td className="pd-cell-time">
        <SavedInput
          type="number"
          min={0}
          max={600}
          step={0.5}
          inputMode="decimal"
          value={row.estMinutes === null ? "" : String(row.estMinutes)}
          disabled={!write}
          aria-label={`Estimated minutes of ${name}`}
          onSave={(v) => save({ estMinutes: v.trim() === "" ? null : Number(v) })}
        />
      </td>
      {options}
    </tr>
  );
}

function ListView({ list, write }: { list: ShotList; write: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const rows = rowsOfShotList(list.id);
  const numbers = shotNumbers(list.id);
  const total = estimatedMinutes(list.id);
  const [selected, setSelected] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const live = selected.filter((id) => rows.some((r) => r.id === id));
  const episode = list.episodeId ? getDb().records.find((r) => r.contentId === list.episodeId) : undefined;
  const add = (type: ShotRowType) => attempt(() => addShotRow(actor, list.id, type, {}));
  return (
    <div className="pd-board">
      <div className="pd-board-head">
        {write ? (
          <SavedInput
            className="pd-board-name"
            value={list.name}
            aria-label="Shot list name"
            onSave={(v) => attempt(() => renameShotList(actor, list.id, v))}
          />
        ) : (
          <h3>{list.name}</h3>
        )}
        {episode && <span className="badge">{episode.contentId}</span>}
        <span className="muted">
          {numbers.size} shot{numbers.size === 1 ? "" : "s"}
        </span>
      </div>
      {write && live.length > 0 && (
        <div className="pd-bulk">
          <span className="muted">{live.length} selected</span>
          <button
            className="btn small danger"
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete ${live.length} row${live.length === 1 ? "" : "s"}?`,
                  body: "They are removed from this shot list.",
                  confirmLabel: "Delete",
                  danger: true,
                })
              )
                if (attempt(() => deleteShotRows(actor, live), "Deleted")) setSelected([]);
            }}
          >
            Delete selected
          </button>
        </div>
      )}
      <div className="wf-scroll">
        <table className="table pd-shots">
          <thead>
            <tr>
              <th className="pd-cell-check">
                {write && rows.length > 0 && (
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={live.length === rows.length}
                    onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
                  />
                )}
              </th>
              <th className="pd-cell-grip" aria-label="Drag" />
              <th>Image</th>
              <th>Shot</th>
              <th>Description</th>
              <th>Shot size</th>
              <th>Shot type</th>
              <th>Movement</th>
              <th>Est. time (min)</th>
              <th aria-label="Options" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Row
                key={r.id}
                list={list}
                row={r}
                index={i}
                count={rows.length}
                number={numbers.get(r.id)}
                write={write}
                selected={live.includes(r.id)}
                onSelect={(on) => setSelected(on ? [...live, r.id] : live.filter((x) => x !== r.id))}
                onDragStart={() => setDragging(r.id)}
                onDrop={() => {
                  if (dragging && dragging !== r.id) attempt(() => moveShotRow(actor, dragging, i));
                  setDragging(null);
                }}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="muted">
                  No rows yet.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={10}>
                <div className="pd-shots-foot">
                  {write && (
                    <>
                      <button className="btn small" onClick={() => add("shot")}>
                        + Shot
                      </button>
                      <button className="btn small" onClick={() => add("setup")}>
                        + Setup
                      </button>
                      <button className="btn small" onClick={() => add("banner")}>
                        + Banner
                      </button>
                    </>
                  )}
                  <span className="grow" />
                  <span className="pd-total">
                    Estimated time: <b>{minutesLabel(total)}</b>
                  </span>
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <datalist id="pd-shot-sizes">
        {SHOT_SIZES.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id="pd-shot-types">
        {SHOT_TYPES.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id="pd-shot-moves">
        {SHOT_MOVEMENTS.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
    </div>
  );
}

export function ShotListTool({ project, write }: { project: Project; write: boolean }) {
  const lists = shotListsOf(project.contentId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const list = lists.find((l) => l.id === chosen) ?? lists[0];
  return (
    <div className="pd-toolpane">
      <aside className="pd-tool-list" aria-label="Shot lists">
        <h3>Shot lists</h3>
        <ul>
          {lists.map((l) => (
            <li key={l.id}>
              <button
                className={l.id === list?.id ? "on" : ""}
                aria-current={l.id === list?.id ? "true" : undefined}
                onClick={() => setChosen(l.id)}
              >
                <span className="grow">{l.name}</span>
                <span className="muted">{shotNumbers(l.id).size}</span>
              </button>
            </li>
          ))}
        </ul>
        {lists.length === 0 && <p className="muted">No shot lists yet.</p>}
        {write && (
          <button className="btn small pd-add" onClick={() => setMaking(true)}>
            + New shot list
          </button>
        )}
      </aside>
      <section className="pd-tool-main" aria-label="Shot list">
        {list ? (
          <ListView key={list.id} list={list} write={write} />
        ) : (
          <Empty>Make a shot list to start: blank, or a copy of one already made.</Empty>
        )}
      </section>
      {making && (
        <NewBoardModal
          project={project}
          kind="shotList"
          onClose={() => setMaking(false)}
          onMade={(id) => {
            setMaking(false);
            setChosen(id);
          }}
        />
      )}
    </div>
  );
}
