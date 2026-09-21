// Run with: npx tsx tests/templates.test.ts
// Document templates: numbered sections, italic notes, no symbols to type.
import assert from "node:assert/strict";
import { DOC_TEMPLATES, fillTemplate, joinSections, parseSections } from "../src/config/docTemplates";
import { bodyToBlocks } from "../src/services/reports";

let passed = 0;
const t = (name: string, fn: () => void) => { try { fn(); passed++; console.log("ok  ", name); } catch (e) { console.error("FAIL", name, "\n    ", (e as Error).message); process.exitCode = 1; } };

t("no template asks the writer to type a # symbol", () => {
  for (const tpl of DOC_TEMPLATES) assert.ok(!/^#/m.test(tpl.body), tpl.key);
});
t("every section is numbered in order and has an italic note saying what to write", () => {
  for (const tpl of DOC_TEMPLATES) {
    const heads = tpl.body.split("\n").filter((l) => /^\d+\.\s/.test(l));
    assert.deepEqual(heads.map((h) => Number(h.split(".")[0])), tpl.sections.map((_, i) => i + 1), tpl.key);
    for (const s of tpl.sections) assert.ok(tpl.body.includes(`_${s.note}_`), `${tpl.key}: ${s.title}`);
    assert.ok(tpl.body.startsWith("_"), `${tpl.key} opens with its purpose in italics`);
  }
});
t("the templates cover the document types in the spec", () => {
  const kinds = new Set(DOC_TEMPLATES.map((x) => x.kind));
  for (const k of ["Content brief", "Script, treatment or outline", "Shot list and run of show", "Editor's brief", "Technical spec", "Report", "Contract or release form", "Reference"]) assert.ok(kinds.has(k), k);
});
t("a document reads back as the same sections, and writes back unchanged", () => {
  for (const tpl of DOC_TEMPLATES) {
    const parsed = parseSections(tpl.body)!;
    assert.deepEqual(parsed.sections.map((s) => s.title), tpl.sections.map((s) => s.title), tpl.key);
    assert.deepEqual(parsed.sections.map((s) => s.note), tpl.sections.map((s) => s.note), tpl.key);
    assert.equal(joinSections(parsed), tpl.body, tpl.key);
  }
});
t("answers stay with their section, and sections are renumbered when one is added or removed", () => {
  const body = fillTemplate("script", { "Cold open": "Why do we doubt?", "Segment 1": "Thomas." });
  const p = parseSections(body)!;
  assert.equal(p.sections[0].answer, "Why do we doubt?"); assert.equal(p.sections[1].answer, "Thomas.");
  p.sections.splice(1, 1);
  const again = joinSections(p);
  assert.match(again, /\n2\. Segment 2\n/);
  assert.ok(!again.includes("Thomas."));
});
t("text with no numbered sections is left alone", () => {
  assert.equal(parseSections("# An old document\n\nSome text"), null);
});
t("a checklist inside a section is kept", () => {
  const p = parseSections(fillTemplate("script", { Approval: "- [x] Script read through\n- [ ] Theology checked" }))!;
  assert.equal(p.sections[p.sections.length - 1].answer, "- [x] Script read through\n- [ ] Theology checked");
});
t("the PDF and printed versions carry the numbered sections and the italic notes", () => {
  const blocks = bodyToBlocks(fillTemplate("concept", { "Working title": "Why do we doubt?" }));
  assert.equal(blocks.filter((b) => b.type === "note").length, DOC_TEMPLATES.find((x) => x.key === "concept")!.sections.length + 1);
  assert.ok(blocks.some((b) => b.type === "heading" && b.text === "1. Working title"));
});

console.log(`\n${passed} passed`);
