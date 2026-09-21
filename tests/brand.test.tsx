// Run with: npx tsx tests/brand.test.tsx
// The DOF TV logo: on screen, on printed pages, in PDFs, and as the site and app icons.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { Logo } from "../src/ui/Logo";
import { ReportView } from "../src/ui/ReportView";
import { Login, RemoteLogin } from "../src/pages/Login";
import { LOGO_H, LOGO_PATH, LOGO_W } from "../src/brand/logo";
import { LOGO_PNG, LOGO_PNG_ASPECT } from "../src/brand/logoPng";
import { reportToPdf } from "../src/services/pdf";

let passed = 0;
const t = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { passed++; console.log("ok  ", name); }, (e) => { console.log("FAIL", name, "\n    ", e instanceof Error ? e.message : e); process.exitCode = 1; });
const pngSize = (buf: Buffer) => { assert.equal(buf.subarray(1, 4).toString(), "PNG"); return [buf.readUInt32BE(16), buf.readUInt32BE(20)]; };

await t("the logo draws in the surrounding colour and keeps the artwork's proportions", () => {
  const html = renderToString(<Logo width={200} />);
  assert.match(html, /aria-label="DOF TV"/);
  assert.match(html, /fill="currentColor"/);
  assert.match(html, /fill-rule="evenodd"/);
  assert.match(html, new RegExp(`viewBox="0 0 ${LOGO_W} ${LOGO_H}"`));
  assert.match(html, new RegExp(`height="${Math.round((200 * LOGO_H) / LOGO_W)}"`));
  assert.ok(LOGO_PATH.length > 1000 && (LOGO_PATH.match(/M/g) ?? []).length === 12, "3 blocks, 2 dots, 3 letter cut-outs, 2 counters and the TV mark");
});

await t("the logo is on the sign-in screens and on printed reports", () => {
  assert.match(renderToString(<Login onLogin={() => {}} />), /aria-label="DOF TV"/);
  assert.match(renderToString(<RemoteLogin onLogin={() => {}} />), /aria-label="DOF TV"/);
  const report = renderToString(<ReportView report={{ title: "Equipment list", subtitle: "", blocks: [] } as never} />);
  assert.match(report, /report-brand/);
  assert.match(report, /aria-label="DOF TV"/);
});

await t("PDFs carry the logo, with its transparent background, and stay small", async () => {
  const bytes = await reportToPdf({ title: "Call sheet", subtitle: "Sunday", landscape: false, blocks: [{ type: "para", text: "Call time 06:30." }] } as never);
  const text = Buffer.from(bytes).toString("latin1");
  assert.match(text, /\/Subtype\s*\/Image/);
  assert.match(text, /\/SMask/);
  assert.ok(bytes.length < 60_000, `a one-page PDF should be small, was ${bytes.length} bytes`);
  const [w, h] = pngSize(Buffer.from(LOGO_PNG.split(",")[1], "base64"));
  assert.ok(Math.abs(h / w - LOGO_PNG_ASPECT) < 0.001);
});

await t("every icon the site names is really there, at the right size", () => {
  const html = readFileSync("index.html", "utf8");
  const hrefs = [...html.matchAll(/href="\/([^"]+)"/g)].map((m) => m[1]);
  for (const f of ["favicon.svg", "favicon-32.png", "favicon.ico", "apple-touch-icon.png", "site.webmanifest"]) assert.ok(hrefs.includes(f), `index.html links ${f}`);
  for (const f of hrefs) assert.ok(existsSync(`public/${f}`), `public/${f} exists`);
  const manifest = JSON.parse(readFileSync("public/site.webmanifest", "utf8")) as { icons: { src: string; sizes: string }[] };
  for (const i of manifest.icons) {
    assert.ok(existsSync(`public${i.src}`), `${i.src} exists`);
    const [w, h] = pngSize(readFileSync(`public${i.src}`));
    assert.equal(`${w}x${h}`, i.sizes);
  }
  assert.deepEqual(pngSize(readFileSync("public/favicon-32.png")), [32, 32]);
  assert.deepEqual(pngSize(readFileSync("public/apple-touch-icon.png")), [180, 180]);
});

await t("the desktop app has its full icon set, made from the 1024 px artwork", () => {
  assert.deepEqual(pngSize(readFileSync("brand/app-icon.png")), [1024, 1024]);
  const conf = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico", "icon.png"];
  for (const f of conf) assert.ok(existsSync(`src-tauri/icons/${f}`), `src-tauri/icons/${f}`);
  assert.deepEqual(pngSize(readFileSync("src-tauri/icons/32x32.png")), [32, 32]);
  assert.deepEqual(pngSize(readFileSync("src-tauri/icons/128x128@2x.png")), [256, 256]);
  assert.match(readFileSync("package.json", "utf8"), /"icons": "tauri icon brand\/app-icon\.png"/);
});

console.log(`\n${passed} passed`);
