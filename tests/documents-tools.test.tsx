// Run with: npm test -- documents-tools
// Phase 4 of the documents rework: the Storyboard and the Shot List. Where pictures may come from; the screens with
// their lists, frames and rows, for someone who may write and someone who may only read; shot numbers that skip setups
// and banners, and the time they add up to; and starting a new board as a copy of one the person may see.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import { RuleError } from "../src/types";
import { enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { login } from "../src/services/auth";
import * as D from "../src/services/wrapped/documents";
import { AppProvider } from "../src/ui/AppContext";
import { StoryboardTool, NewBoardModal } from "../src/pages/documents/Storyboards";
import { ShotListTool, minutesLabel } from "../src/pages/documents/ShotLists";
import { imageSrc } from "../src/pages/documents/images";
import type { Project } from "../src/services/workflow";

let passed = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  setDb(buildWorkflowFixture());
  enableRollback();
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.error("FAIL", name, "\n    ", (e as Error).stack?.split("\n").slice(0, 4).join("\n     "));
    process.exitCode = 1;
  }
};

const hop = () => login("hop@dof.demo", "demo");
const WOW = "DOF-SER-001-S1";
const project = (id: string) => getDb().records.find((r) => r.contentId === id) as Project;
const html = (who: string, el: JSX.Element): string =>
  renderToString(
    <AppProvider actor={login(who, "demo")} onLogout={() => {}}>
      {el}
    </AppProvider>,
  )
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

await t("a picture is a stored file's address, the desktop app's media path, or a picture just shrunk; nothing else", () => {
  const board = D.createStoryboard(hop(), WOW, { name: "Opening" });
  const frame = D.addFrame(hop(), board.id, {});
  for (const ok of ["/api/file?id=0123456789abcdef0123456789abcdef", `media:${WOW}/abc123.jpg`, PIXEL])
    assert.equal(D.updateFrame(hop(), frame.id, { imagePath: ok }).imagePath, ok, ok.slice(0, 30));
  for (const bad of [
    "media:../../etc/passwd.jpg",
    "media:DOF/../x.jpg",
    "file:///C:/pictures/a.jpg",
    "https://example.org/a.jpg",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
  ])
    assert.throws(() => D.updateFrame(hop(), frame.id, { imagePath: bad }), RuleError, bad);
  assert.equal(imageSrc("/api/file?id=0123456789abcdef0123456789abcdef"), "/api/file?id=0123456789abcdef0123456789abcdef");
  assert.equal(imageSrc(PIXEL), PIXEL);
  assert.equal(imageSrc(`media:${WOW}/abc123.jpg`), null, "a desktop picture cannot be shown in a browser");
  assert.equal(imageSrc("https://example.org/a.jpg"), null);
  assert.deepEqual(integrityProblems(getDb()), []);
});

await t("the Storyboard: boards with their frame counts, and frames with scene, number, picture and three fields", () => {
  const board = D.createStoryboard(hop(), WOW, { name: "Opening" });
  D.addFrame(hop(), board.id, { description: "Wide of the studio", soundEffects: "Room tone", videoLink: "https://youtu.be/abc" });
  D.addFrame(hop(), board.id, { description: "Host to camera" });
  D.createStoryboard(hop(), WOW, { name: "Outro" });
  const page = html("hop@dof.demo", <StoryboardTool project={project(WOW)} write />);
  for (const text of [
    "Storyboards",
    "Opening",
    "Outro",
    "+ New storyboard",
    "Select all",
    "+ Frame",
    "· Frame 1",
    "· Frame 2",
    "Wide of the studio",
    "Room tone",
  ])
    assert.ok(page.includes(text), text);
  assert.match(page, /aria-label="Options for frame 1"/);
  assert.match(page, /aria-label="Add a picture: frame 1"/);
  assert.match(page, /value="https:\/\/youtu.be\/abc"/);
  const readOnly = html("partner1@dof.demo", <StoryboardTool project={project(WOW)} write={false} />);
  assert.ok(!readOnly.includes("+ Frame") && !readOnly.includes("Select all") && !readOnly.includes("+ New storyboard"), "read only");
  assert.match(readOnly, /No picture/);
});

await t("the Shot List: shots numbered, setups and banners full width and unnumbered, and the time added up", () => {
  const list = D.createShotList(hop(), WOW, { name: "Session 1" });
  D.addShotRow(hop(), list.id, "banner", { description: "Opening" });
  D.addShotRow(hop(), list.id, "shot", { description: "Wide", shotSize: "Wide", estMinutes: 2 });
  D.addShotRow(hop(), list.id, "setup", { description: "Two lights, 35 mm" });
  D.addShotRow(hop(), list.id, "shot", { description: "Close on hands", movement: "Crane", estMinutes: 61.5 });
  const page = html("hop@dof.demo", <ShotListTool project={project(WOW)} write />);
  for (const text of ["Shot lists", "Session 1", "+ Shot", "+ Setup", "+ Banner", "Banner", "Setup"]) assert.ok(page.includes(text), text);
  assert.match(page, /Estimated time: <b>1 h 3.5 min<\/b>/);
  assert.match(page, /class="pd-cell-num">1</);
  assert.match(page, /class="pd-cell-num">2</);
  assert.ok(!page.includes('class="pd-cell-num">3<'), "two shots, so no shot 3");
  assert.match(page, /value="Crane"/, "a movement not on the list is kept as typed");
  assert.match(page, /<datalist id="pd-shot-sizes"><option value="Wide"><\/option>/);
  assert.match(page, /colSpan="7"|colspan="7"/, "setups and banners run across the table");
  assert.deepEqual([minutesLabel(0), minutesLabel(45), minutesLabel(60), minutesLabel(63.5)], ["0 min", "45 min", "1 h", "1 h 3.5 min"]);
});

await t("a new board or list can start from one the person may see, in this project or another; never one they may not", () => {
  const theirs = D.createStoryboard(hop(), "DOF-DOC-001", { name: "Herd at dawn" });
  D.addFrame(hop(), theirs.id, { description: "Cattle at first light" });
  const mine = D.createStoryboard(hop(), WOW, { name: "Opening" });
  const asHop = html("hop@dof.demo", <NewBoardModal project={project(WOW)} kind="storyboard" onMade={() => {}} onClose={() => {}} />);
  assert.match(asHop, /A copy of Herd at dawn/);
  assert.match(asHop, /A copy of Opening/);
  assert.match(asHop, /label="Samburu Stories \(DOF-DOC-001\)"/, "grouped by project");
  // A crew member on the season, but not the documentary.
  getDb().members.push({ personId: "DOF-P-CRW-003", projectContentId: "DOF-SER-001", roleOnProject: "Camera", canComment: true });
  const asCrew = html("crew3@dof.demo", <NewBoardModal project={project(WOW)} kind="storyboard" onMade={() => {}} onClose={() => {}} />);
  assert.match(asCrew, /A copy of Opening/);
  // Crew see every project, by the workflow's rules; a volunteer does not.
  getDb().members.push({ personId: "DOF-P-VOL-001", projectContentId: "DOF-SER-001", roleOnProject: "Runner", canComment: false });
  const asVolunteer = html(
    "volunteer1@dof.demo",
    <NewBoardModal project={project(WOW)} kind="storyboard" onMade={() => {}} onClose={() => {}} />,
  );
  assert.ok(!asVolunteer.includes("Herd at dawn"), "not from a project they may not see");
  const copy = D.createStoryboard(hop(), WOW, { name: "", copyFrom: theirs.id });
  assert.equal(copy.name, "Herd at dawn (copy)");
  assert.deepEqual(
    D.framesOf(copy.id).map((f) => f.description),
    ["Cattle at first light"],
  );
  assert.equal(D.framesOf(mine.id).length, 0);
});

console.log(`\n${passed} passed`);
