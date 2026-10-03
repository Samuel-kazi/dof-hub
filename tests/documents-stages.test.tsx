// Run with: npm test -- documents-stages
// Phase 5 of the documents rework: the later stages' documents. A day sheet for each recording session, whose run
// sheet and wrap checklist stay the session's own forms and whose notes start with the session's daily log; and the
// Review Thread, with a page for each episode that is added as episodes are made and never taken away.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import { enableRollback, getDb, getTick, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { integrityProblems } from "../src/data/constraints";
import { catalogEntry } from "../src/config/documentCatalog";
import { login } from "../src/services/auth";
import * as D from "../src/services/wrapped/documents";
import { AppProvider } from "../src/ui/AppContext";
import { DaySheetForm, EpisodeStrip, defaultSession, formCards } from "../src/pages/documents/StagePanes";
import { PageList } from "../src/pages/documents/PageList";
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

await t("a day sheet for each session: its run sheet and wrap stay the session's forms, and its notes start with the daily log", () => {
  const log = getDb().recordingSessions.find((s) => s.id === `${WOW}-R01`)!.dailyLog;
  assert.ok(log.length > 0, "the fixture's first session has a daily log");
  const first = D.ensureDocument(hop(), WOW, "Production", "recording_day_sheet", `${WOW}-R01`);
  const pages = D.pagesOf(first.id);
  assert.deepEqual(
    pages.map((p) => p.title),
    ["Daily notes"],
    "the run sheet and wrap checklist are not pages of writing",
  );
  assert.match(pages[0].bodyHtml, /^<p>Recorded episodes 1, 2, 3 and 5\. Episode 4's guest was ill\.<\/p>$/);
  assert.equal(getDb().recordingSessions.find((s) => s.id === `${WOW}-R01`)!.dailyLog, log, "the session's own log is left as it was");
  assert.ok(D.documentHasContent(first.id), "the carried log is writing: the tile shows it has content");
  const second = D.ensureDocument(hop(), WOW, "Production", "recording_day_sheet", `${WOW}-R02`);
  assert.notEqual(second.id, first.id, "one for each session");
  assert.equal(D.pagesOf(second.id)[0].bodyHtml, "", "a session with no log starts empty");
  assert.ok(!D.documentHasContent(second.id));
  assert.equal(D.ensureDocument(hop(), WOW, "Production", "recording_day_sheet", `${WOW}-R01`).id, first.id, "opened again, the same one");
  assert.equal(D.pagesOf(first.id).length, 1);
  // The form cards, in the catalogue's order: the run sheet before the notes, the wrap after.
  assert.deepEqual(
    formCards(catalogEntry("podcast", "Production", "recording_day_sheet")!).map((c) => [c.id, c.at]),
    [
      ["form:runSheet", "start"],
      ["form:wrapChecklist", "end"],
    ],
  );
  assert.deepEqual(
    formCards(catalogEntry("documentary_dof", "Production", "shoot_day_sheet")!).map((c) => c.title),
    ["Run sheet", "Wrap checklist"],
  );
  // It opens on the session recording now, else the next one planned.
  assert.equal(defaultSession(WOW), `${WOW}-R02`);
  getDb().recordingSessions.find((s) => s.id === `${WOW}-R03`)!.status = "Open";
  assert.equal(defaultSession(WOW), `${WOW}-R03`);
  getDb().recordingSessions.find((s) => s.id === `${WOW}-R03`)!.status = "Planned";
  assert.deepEqual(integrityProblems(getDb()), []);
});

await t("the day sheet's forms keep the session's rules: the run sheet is changed until the session closes, the wrap once it opens", () => {
  const planned = html("hop@dof.demo", <DaySheetForm project={project(WOW)} sessionId={`${WOW}-R02`} form="runSheet" />);
  assert.match(planned, /Run sheet/);
  assert.match(planned, /Add a line/, "a planned session's run sheet can be changed");
  assert.match(
    html("hop@dof.demo", <DaySheetForm project={project(WOW)} sessionId={`${WOW}-R02`} form="wrapChecklist" />),
    /opens once recording starts/,
  );
  const closed = html("hop@dof.demo", <DaySheetForm project={project(WOW)} sessionId={`${WOW}-R01`} form="runSheet" />);
  assert.ok(!closed.includes("Add a line"), "a closed session's run sheet is as it was");
  assert.match(html("hop@dof.demo", <DaySheetForm project={project(WOW)} sessionId={`${WOW}-R01`} form="wrapChecklist" />), /Wrap/);
  const cards = formCards(catalogEntry("podcast", "Production", "recording_day_sheet")!);
  const doc = D.ensureDocument(hop(), WOW, "Production", "recording_day_sheet", `${WOW}-R01`);
  const list = html(
    "hop@dof.demo",
    <PageList doc={doc} pages={D.pagesOf(doc.id)} selected="form:runSheet" write fixed={cards} onSelect={() => {}} />,
  );
  assert.ok(list.indexOf("Run sheet") < list.indexOf("Daily notes") && list.indexOf("Daily notes") < list.indexOf("Wrap checklist"), list);
  assert.match(list, /pd-card pd-card-form on/);
  assert.match(list, /\+ Add page/);
  const notStarted = html(
    "crew3@dof.demo",
    <PageList doc={null} pages={[]} selected={null} write={false} fixed={cards} onSelect={() => {}} />,
  );
  assert.match(notStarted, /Run sheet/, "the forms show before anything is written");
  assert.ok(!notStarted.includes("+ Add page"));
});

await t("the Review Thread has a page for each episode, added as episodes are made, and never taken away", () => {
  const e04 = getDb().records.find((r) => r.contentId === `${WOW}-E04`)!;
  e04.archived = true; // as if the fourth episode were not made yet
  const thread = D.syncReviewThread(hop(), WOW)!;
  assert.equal(thread.id, `${WOW}|Post production|review_thread`);
  const titles = () => D.pagesOf(thread.id).map((p) => [p.episodeId, p.subtitle]);
  assert.deepEqual(
    titles(),
    [1, 2, 3].map((n) => [`${WOW}-E0${n}`, `${WOW}-E0${n}`]),
  );
  assert.equal(D.pagesOf(thread.id)[0].title, getDb().records.find((r) => r.contentId === `${WOW}-E01`)!.title);
  const tick = getTick();
  D.syncReviewThread(hop(), WOW);
  assert.equal(getTick(), tick, "nothing new, nothing changed");
  e04.archived = false;
  D.syncReviewThread(hop(), WOW);
  assert.deepEqual(
    titles().map(([id]) => id),
    [1, 2, 3, 4].map((n) => `${WOW}-E0${n}`),
    "the new episode's page is added at the end",
  );
  // A page deleted by hand stays deleted (and can be restored); the thread does not add it again.
  const p2 = D.pagesOf(thread.id)[1];
  D.archivePage(hop(), p2.id);
  D.syncReviewThread(hop(), WOW);
  assert.equal(D.pagesOf(thread.id).length, 3);
  D.restorePage(hop(), p2.id);
  assert.equal(D.pagesOf(thread.id).length, 4);
  // An archived episode keeps its page and what was written on it.
  e04.archived = true;
  D.syncReviewThread(hop(), WOW);
  assert.equal(D.pagesOf(thread.id).length, 4);
  e04.archived = false;
  assert.deepEqual(integrityProblems(getDb()), []);
  // A page can only be about an episode of its own project.
  D.pagesOf(thread.id)[0].episodeId = "DOF-DOC-001";
  assert.match(integrityProblems(getDb()).join(" "), /Page .* episode/);
});

await t("someone who may only read gets the thread as it is: nothing is made or added for them", () => {
  // A partner attached to the season reads it, and may not write in it.
  getDb().members.push({ personId: "DOF-P-PTR-001", projectContentId: "DOF-SER-001", roleOnProject: "Partner reviewer", canComment: true });
  const reader = login("partner1@dof.demo", "demo");
  const tick = getTick();
  assert.equal(D.syncReviewThread(reader, WOW), undefined);
  assert.equal(getTick(), tick);
  const made = D.syncReviewThread(hop(), WOW)!;
  assert.equal(D.syncReviewThread(reader, WOW)?.id, made.id);
});

await t("each episode's page shows where its review stands, read only, with the way to the episode", () => {
  const strip = html("hop@dof.demo", <EpisodeStrip episodeId={`${WOW}-E01`} />);
  for (const text of [`${WOW}-E01`, "Not started", "Editor:", "Rough cut review:", "Final review:", "Open the episode"])
    assert.ok(strip.includes(text), text);
  const ep = getDb().records.find((r) => r.contentId === `${WOW}-E02`)!;
  ep.episode!.postStage = "Editing";
  ep.episode!.sendBackReason = "Trim the opening";
  ep.episode!.reviewLink = "https://example.org/cut";
  const sent = html("hop@dof.demo", <EpisodeStrip episodeId={`${WOW}-E02`} />);
  assert.match(sent, /Sent back from review: Trim the opening/);
  assert.match(sent, /Open the review link/);
});

console.log(`\n${passed} passed`);
