import { useState } from "react";
import type { Storyboard, StoryboardFrame } from "../../types";
import { getDb } from "../../data/store";
import {
  addFrame,
  createShotList,
  createStoryboard,
  deleteFrames,
  duplicateFrame,
  framesOf,
  moveFrame,
  moveFramesTo,
  renameStoryboard,
  storyboardsOf,
  updateFrame,
  type FrameEdit,
  saveStoryboardAsTemplate,
} from "../../services/wrapped/documents";
import { useApp } from "../../ui/AppContext";
import { Modal } from "../../ui/Modal";
import { Empty, Field } from "../../ui/parts";
import { episodesOfProject, ImageSlot, SavedInput, startingPoints } from "./toolkit";
import { canKeepLibrary } from "../../services/documents/boards";
import { useReason } from "../workflow/common";

/** Where boards belong: a project, or with no Content ID the Documents library (templates, practice boards). */
export interface BoardScope {
  contentId: string | null;
}

// The Storyboard, in Pre-production: the project's boards on the left, each with its number of frames, and "+ New
// storyboard", which can start as a copy of any board the person may see. The chosen board's frames sit in a grid,
// each with its scene and number, a 16:9 picture, a description, sound effects and a video link. Frames are added,
// dragged into order, duplicated, moved to another board and deleted, one at a time or several at once. Everything
// saves as it is typed.

/** "+ New storyboard" or "+ New shot list": a name, an episode if it is for one, and what to start from. */
export function NewBoardModal({
  project,
  kind,
  onMade,
  onClose,
}: {
  project: BoardScope;
  kind: "storyboard" | "shotList";
  onMade: (id: string) => void;
  onClose: () => void;
}) {
  const { actor, attempt } = useApp();
  const [name, setName] = useState("");
  const [episodeId, setEpisodeId] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const db = getDb();
  const groups = startingPoints(actor, kind === "storyboard" ? db.storyboards : db.shotLists);
  const episodes = project.contentId ? episodesOfProject(project.contentId) : [];
  const [template, setTemplate] = useState(!project.contentId);
  const what = kind === "storyboard" ? "storyboard" : "shot list";
  const make = () => {
    const input = { name, episodeId: episodeId || null, copyFrom: copyFrom || null, template: !project.contentId && template };
    const made = attempt(
      () => (kind === "storyboard" ? createStoryboard(actor, project.contentId, input) : createShotList(actor, project.contentId, input)),
      copyFrom ? `New ${what}, started from the one you chose` : `New ${what}`,
    );
    if (made) onMade(made.id);
  };
  return (
    <Modal
      title={`New ${what}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={make}>
            Make it
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "storyboard" ? "Opening sequence" : "Session 1"}
            autoFocus
          />
        </Field>
        {project.contentId ? (
          <Field label="For one episode (optional)">
            <select value={episodeId} onChange={(e) => setEpisodeId(e.target.value)}>
              <option value="">The whole project</option>
              {episodes.map((ep) => (
                <option key={ep.contentId} value={ep.contentId}>
                  {ep.contentId}: {ep.title}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <label className="check">
            <input type="checkbox" checked={template} onChange={(e) => setTemplate(e.target.checked)} />
            <span>A template, for projects to start from (otherwise kept here for practice or an event)</span>
          </label>
        )}
        <Field label="Start from">
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">A blank {what}</option>
            {groups.map((g) => (
              <optgroup key={g.project} label={g.project}>
                {g.items.map((it) => (
                  <option key={it.id} value={it.id}>
                    A copy of {it.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        {copyFrom && (
          <p className="muted">
            Its {kind === "storyboard" ? "frames, with their pictures," : "rows"} are copied. The original is not changed.
          </p>
        )}
      </div>
    </Modal>
  );
}

function FrameCard({
  board,
  frame,
  index,
  count,
  write,
  selected,
  others,
  onSelect,
  onDragStart,
  onDrop,
}: {
  board: Storyboard;
  frame: StoryboardFrame;
  index: number;
  count: number;
  write: boolean;
  selected: boolean;
  others: Storyboard[];
  onSelect: (on: boolean) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const { actor, attempt, confirm, menu } = useApp();
  const [moving, setMoving] = useState(false);
  const save = (edit: FrameEdit) => attempt(() => updateFrame(actor, frame.id, edit));
  const n = index + 1;
  return (
    <article
      className={`pd-frame${selected ? " on" : ""}`}
      aria-label={`Frame ${n}`}
      onDragOver={(e) => write && e.dataTransfer.types.includes("text/x-frame") && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("text/x-frame")) return;
        e.preventDefault();
        onDrop();
      }}
    >
      <header
        className="pd-frame-head"
        draggable={write}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/x-frame", frame.id);
          e.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
      >
        {write && (
          <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select frame ${n}`} />
        )}
        {write ? (
          <SavedInput className="pd-scene" value={frame.scene} onSave={(v) => save({ scene: v })} aria-label={`Scene of frame ${n}`} />
        ) : (
          <span>{frame.scene}</span>
        )}
        <span className="pd-frame-n">· Frame {n}</span>
        {write && (
          <span className="pd-grip" aria-hidden="true" title="Drag to reorder">
            ⠿
          </span>
        )}
        {write && (
          <button
            className="pd-card-menu"
            aria-label={`Options for frame ${n}`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              menu({ clientX: r.left, clientY: r.bottom, preventDefault: () => {} }, [
                { label: "Duplicate", onClick: () => attempt(() => duplicateFrame(actor, frame.id), "Frame duplicated") },
                { label: "Move earlier", disabled: index === 0, onClick: () => attempt(() => moveFrame(actor, frame.id, index - 1)) },
                { label: "Move later", disabled: index === count - 1, onClick: () => attempt(() => moveFrame(actor, frame.id, index + 1)) },
                { label: "Move to another storyboard…", disabled: others.length === 0, onClick: () => setMoving(true) },
                { label: "", divider: true, onClick: () => {} },
                {
                  label: "Delete",
                  danger: true,
                  onClick: async () => {
                    if (
                      await confirm({
                        title: `Delete frame ${n}?`,
                        body: "Its picture and words are removed from this storyboard.",
                        confirmLabel: "Delete",
                        danger: true,
                      })
                    )
                      attempt(() => deleteFrames(actor, [frame.id]), "Frame deleted");
                  },
                },
              ]);
            }}
          >
            ⋮
          </button>
        )}
      </header>
      <ImageSlot
        path={frame.imagePath}
        projectId={board.contentId ?? "documents"}
        write={write}
        label={`frame ${n}`}
        onChange={(imagePath) => save({ imagePath })}
      />
      <div className="pd-frame-fields">
        <SavedInput
          placeholder="Description"
          aria-label={`Description of frame ${n}`}
          value={frame.description}
          disabled={!write}
          onSave={(v) => save({ description: v })}
        />
        <SavedInput
          placeholder="Sound effects"
          aria-label={`Sound effects of frame ${n}`}
          value={frame.soundEffects}
          disabled={!write}
          onSave={(v) => save({ soundEffects: v })}
        />
        <SavedInput
          placeholder="Video link"
          type="url"
          aria-label={`Video link of frame ${n}`}
          value={frame.videoLink}
          disabled={!write}
          onSave={(v) => save({ videoLink: v })}
        />
      </div>
      {moving && <MoveFramesModal ids={[frame.id]} others={others} onClose={() => setMoving(false)} />}
    </article>
  );
}

function MoveFramesModal({ ids, others, onClose }: { ids: string[]; others: Storyboard[]; onClose: () => void }) {
  const { actor, attempt } = useApp();
  const [target, setTarget] = useState(others[0]?.id ?? "");
  return (
    <Modal
      title={ids.length === 1 ? "Move this frame" : `Move ${ids.length} frames`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!target}
            onClick={() => attempt(() => moveFramesTo(actor, ids, target), ids.length === 1 ? "Frame moved" : "Frames moved") && onClose()}
          >
            Move
          </button>
        </>
      }
    >
      <Field label="To the end of">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {others.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function BoardView({ project, board, write }: { project: BoardScope; board: Storyboard; write: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const [ask, askModal] = useReason();
  const frames = framesOf(board.id);
  const others = storyboardsOf(project.contentId).filter((b) => b.id !== board.id);
  const [selected, setSelected] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const live = selected.filter((id) => frames.some((f) => f.id === id));
  const episode = board.episodeId ? getDb().records.find((r) => r.contentId === board.episodeId) : undefined;
  return (
    <div className="pd-board">
      <div className="pd-board-head">
        {write ? (
          <SavedInput
            className="pd-board-name"
            value={board.name}
            aria-label="Storyboard name"
            onSave={(v) => attempt(() => renameStoryboard(actor, board.id, v))}
          />
        ) : (
          <h3>{board.name}</h3>
        )}
        {episode && <span className="badge">{episode.contentId}</span>}
        {board.isTemplate && <span className="badge accent">Template</span>}
        <span className="muted">
          {frames.length} frame{frames.length === 1 ? "" : "s"}
        </span>
        {project.contentId && canKeepLibrary(actor) && (
          <button
            className="btn small ghost"
            onClick={async () => {
              const name = await ask(
                "Save as a template",
                "The template's name. A copy goes to Documents, Templates; this board stays as it is.",
                "Save as template",
              );
              if (name) attempt(() => saveStoryboardAsTemplate(actor, board.id, name), "Saved as a template in Documents");
            }}
          >
            Save as template
          </button>
        )}
        {askModal}
      </div>
      {write && frames.length > 0 && (
        <div className="pd-bulk">
          <label className="pd-selectall">
            <input
              type="checkbox"
              checked={live.length === frames.length}
              onChange={(e) => setSelected(e.target.checked ? frames.map((f) => f.id) : [])}
            />
            <span>Select all</span>
          </label>
          {live.length > 0 && (
            <>
              <span className="muted">{live.length} selected</span>
              <button className="btn small" disabled={others.length === 0} onClick={() => setMoving(true)}>
                Move to another storyboard…
              </button>
              <button
                className="btn small danger"
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Delete ${live.length} frame${live.length === 1 ? "" : "s"}?`,
                      body: "Their pictures and words are removed from this storyboard.",
                      confirmLabel: "Delete",
                      danger: true,
                    })
                  )
                    if (attempt(() => deleteFrames(actor, live), "Deleted")) setSelected([]);
                }}
              >
                Delete selected
              </button>
            </>
          )}
        </div>
      )}
      {frames.length === 0 && !write && <Empty>No frames yet.</Empty>}
      <div className="pd-frames">
        {frames.map((f, i) => (
          <FrameCard
            key={f.id}
            board={board}
            frame={f}
            index={i}
            count={frames.length}
            write={write}
            selected={live.includes(f.id)}
            others={others}
            onSelect={(on) => setSelected(on ? [...live, f.id] : live.filter((x) => x !== f.id))}
            onDragStart={() => setDragging(f.id)}
            onDrop={() => {
              if (dragging && dragging !== f.id) attempt(() => moveFrame(actor, dragging, i));
              setDragging(null);
            }}
          />
        ))}
        {write && (
          <button className="pd-frame-add" onClick={() => attempt(() => addFrame(actor, board.id, {}))}>
            + Frame
          </button>
        )}
      </div>
      {moving && (
        <MoveFramesModal
          ids={live}
          others={others}
          onClose={() => {
            setMoving(false);
            setSelected([]);
          }}
        />
      )}
    </div>
  );
}

export function StoryboardTool({ project, write }: { project: BoardScope; write: boolean }) {
  const boards = storyboardsOf(project.contentId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const board = boards.find((b) => b.id === chosen) ?? boards[0];
  return (
    <div className="pd-toolpane">
      <aside className="pd-tool-list" aria-label="Storyboards">
        <h3>Storyboards</h3>
        <ul>
          {boards.map((b) => (
            <li key={b.id}>
              <button
                className={b.id === board?.id ? "on" : ""}
                aria-current={b.id === board?.id ? "true" : undefined}
                onClick={() => setChosen(b.id)}
              >
                <span className="grow">{b.name}</span>
                <span className="muted">{framesOf(b.id).length}</span>
              </button>
            </li>
          ))}
        </ul>
        {boards.length === 0 && <p className="muted">No storyboards yet.</p>}
        {write && (
          <button className="btn small pd-add" onClick={() => setMaking(true)}>
            + New storyboard
          </button>
        )}
      </aside>
      <section className="pd-tool-main" aria-label="Storyboard">
        {board ? (
          <BoardView key={board.id} project={project} board={board} write={write} />
        ) : (
          <Empty>Make a storyboard to start: blank, or a copy of one already made.</Empty>
        )}
      </section>
      {making && (
        <NewBoardModal
          project={project}
          kind="storyboard"
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
