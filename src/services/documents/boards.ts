import type { Actor, ShotList, ShotListRow, ShotRowType, Storyboard, StoryboardFrame } from "../../types";
import { RuleError } from "../../types";
import { commit, getDb } from "../../data/store";
import { localId } from "../../data/ids";
import { logAudit } from "../audit";
import { asWebUrl } from "../urls";
import { STORED_FILE } from "../utils";
import { getRecord } from "../access";
import { moveTo, nowStamp, projectForView, projectForWrite, renumber } from "./common";

// Storyboards and shot lists, Pre-production's two tools. Either can start as a copy of one that already exists, in
// this project or any other the person may see, so good boards are reused. Images are stored as files; a frame or a
// row keeps only the image's address.

const MAX_LINE = 500;
/** A stored image's address, or a photo the browser has just shrunk (the server files it and keeps the address). */
const IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGE = 2_000_000;

function imageOf(value: string | null): string | null {
  if (value === null || value === "") return null;
  if (STORED_FILE.test(value)) return value;
  if (IMAGE.test(value) && value.length <= MAX_IMAGE) return value;
  throw new RuleError("That image could not be stored. Choose a JPEG, PNG or WebP picture.");
}

const line = (s: string | undefined): string => (s ?? "").trim().slice(0, MAX_LINE);

function episodeOf(contentId: string, episodeId: string | null | undefined): string | null {
  if (!episodeId) return null;
  const ep = getRecord(episodeId);
  if (!ep?.episode || ep.parentId !== contentId) throw new RuleError("Choose one of this project's episodes.");
  return episodeId;
}

// ── Storyboards ──────────────────────────────────────────────

export const storyboardsOf = (contentId: string): Storyboard[] =>
  getDb()
    .storyboards.filter((b) => b.contentId === contentId)
    .sort((a, b) => a.position - b.position);
export const framesOf = (storyboardId: string): StoryboardFrame[] =>
  getDb()
    .storyboardFrames.filter((f) => f.storyboardId === storyboardId)
    .sort((a, b) => a.position - b.position);

function boardForWrite(actor: Actor, id: string): Storyboard {
  const b = getDb().storyboards.find((x) => x.id === id);
  if (!b) throw new RuleError("That storyboard no longer exists.");
  projectForWrite(actor, b.contentId);
  return b;
}

function frameForWrite(actor: Actor, id: string): { frame: StoryboardFrame; board: Storyboard } {
  const frame = getDb().storyboardFrames.find((f) => f.id === id);
  if (!frame) throw new RuleError("That frame no longer exists.");
  return { frame, board: boardForWrite(actor, frame.storyboardId) };
}

export interface NewBoard {
  name: string;
  episodeId?: string | null;
  copyFrom?: string | null; // a storyboard (or shot list) to start from: its frames (or rows) are copied
}

export function createStoryboard(actor: Actor, contentId: string, input: NewBoard): Storyboard {
  projectForWrite(actor, contentId);
  const db = getDb();
  const source = input.copyFrom ? db.storyboards.find((b) => b.id === input.copyFrom) : undefined;
  if (input.copyFrom) {
    if (!source) throw new RuleError("The storyboard to start from no longer exists.");
    projectForView(actor, source.contentId);
  }
  const at = nowStamp();
  const board: Storyboard = {
    id: localId("SB"),
    contentId,
    episodeId: episodeOf(contentId, input.episodeId),
    name: line(input.name) || (source ? `${source.name} (copy)` : "Storyboard"),
    position: storyboardsOf(contentId).length,
    copiedFrom: source?.id ?? null,
    migrated: false,
    createdAt: at,
    updatedAt: at,
  };
  db.storyboards.push(board);
  if (source) for (const f of framesOf(source.id)) db.storyboardFrames.push({ ...f, id: localId("SF"), storyboardId: board.id });
  logAudit(actor, "storyboard", "record", contentId, `${board.name}${source ? `, from ${source.name}` : ""}`);
  commit();
  return board;
}

export function renameStoryboard(actor: Actor, id: string, name: string): Storyboard {
  const b = boardForWrite(actor, id);
  b.name = line(name) || b.name;
  b.updatedAt = nowStamp();
  commit();
  return b;
}

export interface FrameEdit {
  scene?: string;
  imagePath?: string | null;
  description?: string;
  soundEffects?: string;
  videoLink?: string;
}

function applyFrame(f: StoryboardFrame, edit: FrameEdit): void {
  if (edit.scene !== undefined) f.scene = line(edit.scene).slice(0, 40);
  if (edit.imagePath !== undefined) f.imagePath = imageOf(edit.imagePath);
  if (edit.description !== undefined) f.description = line(edit.description);
  if (edit.soundEffects !== undefined) f.soundEffects = line(edit.soundEffects);
  if (edit.videoLink !== undefined) {
    const v = edit.videoLink.trim();
    if (v && !asWebUrl(v)) throw new RuleError("The video link must be a web link starting with http:// or https://.");
    f.videoLink = v ? asWebUrl(v)! : "";
  }
}

export function addFrame(actor: Actor, storyboardId: string, edit: FrameEdit = {}): StoryboardFrame {
  const b = boardForWrite(actor, storyboardId);
  const frames = framesOf(b.id);
  const frame: StoryboardFrame = {
    id: localId("SF"),
    storyboardId: b.id,
    position: frames.length,
    scene: frames[frames.length - 1]?.scene ?? "Sc. 1",
    imagePath: null,
    description: "",
    soundEffects: "",
    videoLink: "",
  };
  applyFrame(frame, edit);
  getDb().storyboardFrames.push(frame);
  b.updatedAt = nowStamp();
  commit();
  return frame;
}

export function updateFrame(actor: Actor, frameId: string, edit: FrameEdit): StoryboardFrame {
  const { frame, board } = frameForWrite(actor, frameId);
  applyFrame(frame, edit);
  board.updatedAt = nowStamp();
  commit();
  return frame;
}

export function moveFrame(actor: Actor, frameId: string, toIndex: number): StoryboardFrame {
  const { frame, board } = frameForWrite(actor, frameId);
  moveTo(framesOf(board.id), frame.id, toIndex);
  commit();
  return frame;
}

export function duplicateFrame(actor: Actor, frameId: string): StoryboardFrame {
  const { frame, board } = frameForWrite(actor, frameId);
  const copy: StoryboardFrame = { ...frame, id: localId("SF"), position: frame.position + 0.5 };
  getDb().storyboardFrames.push(copy);
  renumber(framesOf(board.id));
  commit();
  return copy;
}

/** Deletes frames, several at once. Asked to confirm on screen first. */
export function deleteFrames(actor: Actor, frameIds: string[]): number {
  const db = getDb();
  const boards = new Set<string>();
  for (const id of frameIds) boards.add(frameForWrite(actor, id).board.id);
  db.storyboardFrames = db.storyboardFrames.filter((f) => !frameIds.includes(f.id));
  for (const b of boards) renumber(framesOf(b));
  logAudit(actor, "storyboard", "record", db.storyboards.find((b) => boards.has(b.id))!.contentId, `${frameIds.length} frame(s) deleted`);
  commit();
  return frameIds.length;
}

/** Moves frames to the end of another storyboard of the same project. */
export function moveFramesTo(actor: Actor, frameIds: string[], storyboardId: string): number {
  const target = boardForWrite(actor, storyboardId);
  const from = new Set<string>();
  let next = framesOf(target.id).length;
  for (const id of frameIds) {
    const { frame, board } = frameForWrite(actor, id);
    if (board.contentId !== target.contentId) throw new RuleError("Frames move only between storyboards of the same project.");
    from.add(board.id);
    frame.storyboardId = target.id;
    frame.position = next++;
  }
  for (const b of from) renumber(framesOf(b));
  commit();
  return frameIds.length;
}

// ── Shot lists ───────────────────────────────────────────────

export const shotListsOf = (contentId: string): ShotList[] =>
  getDb()
    .shotLists.filter((l) => l.contentId === contentId)
    .sort((a, b) => a.position - b.position);
export const rowsOfShotList = (shotListId: string): ShotListRow[] =>
  getDb()
    .shotListRows.filter((r) => r.shotListId === shotListId)
    .sort((a, b) => a.position - b.position);

/** Shot numbers, counting only shot rows: setups and banners take none. */
export function shotNumbers(shotListId: string): Map<string, number> {
  let n = 0;
  return new Map(rowsOfShotList(shotListId).flatMap((r) => (r.rowType === "shot" ? [[r.id, ++n] as const] : [])));
}

/** The total estimated time of a shot list's shots, in minutes. */
export const estimatedMinutes = (shotListId: string): number =>
  rowsOfShotList(shotListId).reduce((sum, r) => sum + (r.rowType === "shot" && r.estMinutes ? r.estMinutes : 0), 0);

function listForWrite(actor: Actor, id: string): ShotList {
  const l = getDb().shotLists.find((x) => x.id === id);
  if (!l) throw new RuleError("That shot list no longer exists.");
  projectForWrite(actor, l.contentId);
  return l;
}

function rowForWrite(actor: Actor, id: string): { row: ShotListRow; list: ShotList } {
  const row = getDb().shotListRows.find((r) => r.id === id);
  if (!row) throw new RuleError("That row no longer exists.");
  return { row, list: listForWrite(actor, row.shotListId) };
}

export function createShotList(actor: Actor, contentId: string, input: NewBoard): ShotList {
  projectForWrite(actor, contentId);
  const db = getDb();
  const source = input.copyFrom ? db.shotLists.find((l) => l.id === input.copyFrom) : undefined;
  if (input.copyFrom) {
    if (!source) throw new RuleError("The shot list to start from no longer exists.");
    projectForView(actor, source.contentId);
  }
  const at = nowStamp();
  const list: ShotList = {
    id: localId("SL"),
    contentId,
    episodeId: episodeOf(contentId, input.episodeId),
    name: line(input.name) || (source ? `${source.name} (copy)` : "Shot list"),
    position: shotListsOf(contentId).length,
    copiedFrom: source?.id ?? null,
    migrated: false,
    createdAt: at,
    updatedAt: at,
  };
  db.shotLists.push(list);
  if (source) for (const r of rowsOfShotList(source.id)) db.shotListRows.push({ ...r, id: localId("SR"), shotListId: list.id });
  logAudit(actor, "shot-list", "record", contentId, `${list.name}${source ? `, from ${source.name}` : ""}`);
  commit();
  return list;
}

export function renameShotList(actor: Actor, id: string, name: string): ShotList {
  const l = listForWrite(actor, id);
  l.name = line(name) || l.name;
  l.updatedAt = nowStamp();
  commit();
  return l;
}

export interface RowEdit {
  imagePath?: string | null;
  description?: string;
  shotSize?: string;
  shotType?: string;
  movement?: string;
  estMinutes?: number | null;
}

function applyRow(r: ShotListRow, edit: RowEdit): void {
  if (edit.imagePath !== undefined) r.imagePath = imageOf(edit.imagePath);
  if (edit.description !== undefined) r.description = line(edit.description);
  if (edit.shotSize !== undefined) r.shotSize = line(edit.shotSize).slice(0, 60);
  if (edit.shotType !== undefined) r.shotType = line(edit.shotType).slice(0, 60);
  if (edit.movement !== undefined) r.movement = line(edit.movement).slice(0, 60);
  if (edit.estMinutes !== undefined) {
    const m = edit.estMinutes;
    if (m !== null && (!Number.isFinite(m) || m < 0 || m > 600)) throw new RuleError("Estimated time is in minutes, from 0 to 600.");
    r.estMinutes = m === null ? null : Math.round(m * 10) / 10;
  }
}

export function addShotRow(actor: Actor, shotListId: string, rowType: ShotRowType, edit: RowEdit = {}): ShotListRow {
  const l = listForWrite(actor, shotListId);
  if (!["shot", "setup", "banner"].includes(rowType)) throw new RuleError("A row is a shot, a setup or a banner.");
  const row: ShotListRow = {
    id: localId("SR"),
    shotListId: l.id,
    position: rowsOfShotList(l.id).length,
    rowType,
    imagePath: null,
    description: "",
    shotSize: "",
    shotType: "",
    movement: "",
    estMinutes: null,
  };
  applyRow(row, edit);
  getDb().shotListRows.push(row);
  l.updatedAt = nowStamp();
  commit();
  return row;
}

export function updateShotRow(actor: Actor, rowId: string, edit: RowEdit): ShotListRow {
  const { row, list } = rowForWrite(actor, rowId);
  applyRow(row, edit);
  list.updatedAt = nowStamp();
  commit();
  return row;
}

export function moveShotRow(actor: Actor, rowId: string, toIndex: number): ShotListRow {
  const { row, list } = rowForWrite(actor, rowId);
  moveTo(rowsOfShotList(list.id), row.id, toIndex);
  list.updatedAt = nowStamp();
  commit();
  return row;
}

export function duplicateShotRow(actor: Actor, rowId: string): ShotListRow {
  const { row, list } = rowForWrite(actor, rowId);
  const copy: ShotListRow = { ...row, id: localId("SR"), position: row.position + 0.5 };
  getDb().shotListRows.push(copy);
  renumber(rowsOfShotList(list.id));
  list.updatedAt = nowStamp();
  commit();
  return copy;
}

/** Deletes rows, several at once. Asked to confirm on screen first. */
export function deleteShotRows(actor: Actor, rowIds: string[]): number {
  const db = getDb();
  const lists = new Set<string>();
  for (const id of rowIds) lists.add(rowForWrite(actor, id).list.id);
  db.shotListRows = db.shotListRows.filter((r) => !rowIds.includes(r.id));
  const at = nowStamp();
  for (const l of db.shotLists.filter((x) => lists.has(x.id))) {
    renumber(rowsOfShotList(l.id));
    l.updatedAt = at;
  }
  logAudit(actor, "shot-list", "record", db.shotLists.find((l) => lists.has(l.id))!.contentId, `${rowIds.length} row(s) deleted`);
  commit();
  return rowIds.length;
}
