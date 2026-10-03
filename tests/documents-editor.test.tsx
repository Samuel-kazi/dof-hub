// Run with: npm test -- documents-editor
// Phase 2 of the documents rework: the editor shell and the rich-text editor, behind a setting, devotions first. What a
// paste keeps; the setting and who may change it; the derived "has content" dot; the link and colour helpers; and the
// screens a devotion shows with the setting on and off. Typing, saving, printing and refusals in a real browser are in
// the phase report.
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { JSX } from "react";
import { RuleError } from "../src/types";
import { enableRollback, getDb, setDb } from "../src/data/store";
import { buildWorkflowFixture } from "../src/data/seedWorkflow";
import { changeSaved, lastChange } from "../src/data/remote";
import { cleanHtml, cleanPastedHtml } from "../src/services/html";
import { login } from "../src/services/auth";
import * as D from "../src/services/wrapped/documents";
import * as S from "../src/services/wrapped/settings";
import { AppProvider } from "../src/ui/AppContext";
import { RecordPage } from "../src/pages/RecordPage";
import { ProjectHome } from "../src/pages/documents/ProjectDocuments";
import { PageEditor } from "../src/pages/documents/PageEditor";
import { linkKind } from "../src/pages/documents/LinksBox";
import { hexOf, linkOf } from "../src/pages/documents/RichText";
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
const DEV = "DOF-DEV-001";
const WOW = "DOF-SER-001-S1";
const project = (id: string) => getDb().records.find((r) => r.contentId === id) as Project;

// ── Pasting ──────────────────────────────────────────────────

await t("a paste from Google Docs keeps headings, bold, italic, links and lists, and nothing else", () => {
  const google =
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-abc"><h1 dir="ltr" style="line-height:1.38"><span style="font-size:20pt;font-family:Arial;color:#ff0000">Pasted heading</span></h1><p dir="ltr"><span style="font-size:11pt;font-weight:700">Bold bit</span><span> and </span><span style="font-style:italic">italic bit</span> <a href="https://example.org/x"><span style="color:#1155cc">a link</span></a></p><ul><li dir="ltr"><p><span>first</span></p></li><li><p><span>second</span></p></li></ul><table><tr><td>cell text</td></tr></table><img src="x.png"></b>';
  assert.equal(
    cleanPastedHtml(google),
    '<h1>Pasted heading</h1><p><strong>Bold bit</strong> and <em>italic bit</em> <a href="https://example.org/x" rel="noopener noreferrer nofollow">a link</a></p><ul><li><p>first</p></li><li><p>second</p></li></ul><p>cell text</p>',
  );
});

await t("a paste from Word turns its typed bullets into real lists, and drops its own markup", () => {
  const word =
    "<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>1.<span>&nbsp;&nbsp;</span></span>One</p>" +
    "<p class=MsoListParagraphCxSpLast style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>2.<span>&nbsp;</span></span>Two</p>" +
    "<p class=MsoNormal><b>Bold</b> <i>it</i><o:p></o:p></p>" +
    "<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'><span style='mso-list:Ignore'>·<span>&nbsp;</span></span>Dot</p>";
  assert.equal(cleanPastedHtml(word), "<ol><li>One</li><li>Two</li></ol><p><b>Bold</b> <i>it</i></p><ul><li>Dot</li></ul>");
});

await t("a paste loses scripts, images, colours, sizes and links that are not web or mail links", () => {
  const out = cleanPastedHtml(
    '<p><span style="color:red;font-size:30px">Plain</span><img src=x onerror="alert(1)"><script>alert(2)</script>' +
      '<a href="javascript:alert(3)">bad</a> <a href="mailto:a@b.org">mail</a> <span style="font-weight:700;font-style:italic">Both</span></p><h5>Small</h5>',
  );
  assert.ok(!/alert|<img|<script|color|font-size|javascript/.test(out), out);
  assert.match(out, /<a href="mailto:a@b.org"[^>]*>mail<\/a>/);
  assert.match(out, /<strong><em>Both<\/em><\/strong>/);
  assert.match(out, /<h3>Small<\/h3>/);
});

await t("what the editor makes survives the cleaner: checklists, colours, highlight, size, alignment and indent", () => {
  const made =
    '<h2 style="text-align: center; margin-left: 2em">Prayer</h2><p><span style="color: rgb(24, 100, 171); font-size: 1.25em">Blue</span>' +
    '<mark data-color="#fff3a3" style="background-color: rgb(255, 243, 163); color: inherit">marked</mark></p>' +
    '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p></div></li></ul>';
  const kept = cleanHtml(made);
  for (const part of [
    "text-align: center",
    "margin-left: 2em",
    "color: rgb(24, 100, 171)",
    "font-size: 1.25em",
    "background-color: rgb(255, 243, 163)",
    'data-type="taskList"',
    'data-checked="true"',
    'type="checkbox"',
  ])
    assert.ok(kept.includes(part), part);
  assert.ok(!kept.includes("color: inherit"), "only the colours the toolbar sets");
});

// ── No setting: the documents are how every project shows ────

await t("there is no setting for the documents any more: every kind of project shows them, and Settings takes no such key", () => {
  S.updateSettings(hop(), { newDocuments: [] } as never);
  assert.equal("newDocuments" in getDb().settings, false, "an old screen sending it changes nothing");
  assert.throws(() => S.updateSettings(login("crew2@dof.demo", "demo"), {}), RuleError, "Settings are still the Head of Production's");
});

// ── The "has content" dot ────────────────────────────────────

await t("a document has content once someone writes on a page or adds a link; its starting pages alone are not content", () => {
  const script = D.ensureDocument(hop(), DEV, "Development", "devotional_script");
  assert.equal(D.documentHasContent(script.id), false);
  const greenlight = D.ensureDocument(hop(), WOW, "Development", "greenlight");
  assert.equal(D.documentHasContent(greenlight.id), false, "the six criteria it starts with are not content");
  const first = D.pagesOf(script.id)[0];
  D.savePage(hop(), first.id, { bodyHtml: "<p></p>" }, first.version);
  assert.equal(D.documentHasContent(script.id), false, "an empty save is still empty");
  D.savePage(hop(), first.id, { subtitle: "Psalm 23" }, D.pagesOf(script.id)[0].version);
  assert.equal(D.documentHasContent(script.id), true, "a scripture counts");
  const plan = D.ensureDocument(hop(), DEV, "Pre-production", "recording_plan");
  D.addDocumentLink(hop(), plan.id, "https://drive.google.com/drive/folders/abc", "Cards");
  assert.equal(D.documentHasContent(plan.id), true, "a link counts");
});

// ── Helpers ──────────────────────────────────────────────────

await t("links typed into the editor: web and mail only, a bare address made https", () => {
  assert.equal(linkOf("dawnoffaith.tv"), "https://dawnoffaith.tv/");
  assert.equal(linkOf("https://dawnoffaith.tv/watch?v=1"), "https://dawnoffaith.tv/watch?v=1");
  assert.equal(linkOf("me@dawnoffaith.tv"), "mailto:me@dawnoffaith.tv");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///C:/x", "ftp://x.org", "localhost", "", "https://user:pw@x.org"])
    assert.equal(linkOf(bad), null, bad);
  assert.equal(hexOf("rgb(24, 100, 171)"), "#1864ab");
  assert.equal(hexOf("#FFF3A3"), "#fff3a3");
  assert.deepEqual(
    [
      "https://docs.google.com/document/d/a/edit",
      "https://drive.google.com/x",
      "https://wa.me/254700000000",
      "https://chat.whatsapp.com/abc",
      "https://example.org",
      "not a link",
    ].map(linkKind),
    ["Google Doc", "Google Drive", "WhatsApp", "WhatsApp", "Link", "Link"],
  );
});

await t("in the local demo every save is final at once: there is no server to wait for", async () => {
  assert.equal(lastChange(), 0);
  assert.equal(await changeSaved(0), true);
});

// ── The screens ──────────────────────────────────────────────

await t("a devotion opens on Project Home: five stage rows of tiles, no Show Brief or Greenlight, and no way back to old screens", () => {
  const page = html("hop@dof.demo", <RecordPage id={DEV} />);
  assert.match(page, /aria-label="Project home"/);
  assert.ok(!page.includes("Documents (preview)") && !page.includes("Earlier screens"), "no switch to the old screens");
  assert.ok(!page.includes('aria-label="Stages of this project"'), "no old tabs");
  assert.equal((page.match(/class="pd-row /g) ?? []).length, 5);
  for (const stage of ["Development", "Pre-production", "Production", "Post production", "Marketing and distribution"])
    assert.ok(page.includes(`aria-label="${stage}"`), stage);
  assert.match(page, /class="rail"/, "the stage tracker stays");
  for (const tile of [
    "Devotional Script",
    "Theological Review (review)",
    "Accept or Decline (form)",
    "Recording Plan",
    "Call Sheet (form)",
  ])
    assert.ok(page.includes(`aria-label="${tile}`), tile);
  assert.ok(!page.includes('aria-label="Show Brief') && !page.includes('aria-label="Greenlight'));
  // A series opens on its own Project Home too.
  const series = html("hop@dof.demo", <RecordPage id={WOW} />);
  assert.match(series, /aria-label="Project home"/);
  assert.ok(series.includes('aria-label="Show Brief') && series.includes('aria-label="Greenlight'));
});

await t("a tile shows a dot once its document has content, worked out from the pages", () => {
  const home = () => html("hop@dof.demo", <ProjectHome project={project(DEV)} write onOpen={() => {}} />);
  assert.ok(!home().includes("has content"));
  const script = D.ensureDocument(hop(), DEV, "Development", "devotional_script");
  const first = D.pagesOf(script.id)[0];
  D.savePage(hop(), first.id, { bodyHtml: "<p>Grace for today.</p>" }, first.version);
  assert.match(home(), /aria-label="Devotional Script, has content"/);
});

await t("a page opens with its title, its scripture and the editor loading; read-only for someone who may not write", () => {
  const script = D.ensureDocument(hop(), DEV, "Development", "devotional_script");
  const first = D.pagesOf(script.id)[0];
  D.savePage(
    hop(),
    first.id,
    { title: "Morning mercy", subtitle: "Lamentations 3:22", bodyHtml: "<p>New every morning</p>" },
    first.version,
  );
  const page = D.pagesOf(script.id)[0];
  const editable = html("hop@dof.demo", <PageEditor doc={script} page={page} write subtitleLabel="Scripture" />);
  assert.match(editable, /aria-label="Page title"[^>]*value="Morning mercy"|value="Morning mercy"[^>]*aria-label="Page title"/);
  assert.match(editable, /aria-label="Scripture"/);
  assert.match(editable, /Lamentations 3:22/);
  assert.match(editable, /Saved @ \d\d:\d\d, by/);
  assert.match(editable, /Opening the page/);
  const readOnly = html("partner1@dof.demo", <PageEditor doc={script} page={page} write={false} subtitleLabel="Scripture" />);
  assert.match(readOnly, /readOnly=""|readonly=""/);
});

console.log(`\n${passed} passed`);
