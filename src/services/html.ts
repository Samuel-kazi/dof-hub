import createDOMPurify from "dompurify";

// Document pages are rich text, stored as HTML cleaned to one allow-list: what the editor's toolbar can make, and
// what survives a paste from Google Docs or Word (bold, italic, underline, headings, lists, checklists, links,
// colour, highlight, size and alignment). Everything else (scripts, styles, classes, images, tables, fonts, layout)
// is removed. The same cleaning runs on every save, in the browser and again on the server, and on every load.
//
// The browser cleans with its own document. The server, and the tests, have none, so they hand one over once at
// start-up (server/html.ts), which keeps the HTML library out of the app's bundle.

type Purifier = ReturnType<typeof createDOMPurify>;

const TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "a",
  "span",
  "mark",
  "label",
  "input",
  "div",
];
const ATTRS = ["href", "style", "data-type", "data-checked", "type", "checked", "data-color"];
// The CSS the toolbar sets, and nothing else: colour, highlight, text size, alignment and paragraph indent.
const STYLE: Record<string, RegExp> = {
  color: /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i,
  "background-color": /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i,
  "font-size": /^(0\.\d+|[1-3](\.\d+)?)(em|rem)$|^([89]|[1-4]\d)px$/,
  "text-align": /^(left|center|right|justify)$/,
  "margin-left": /^\d{1,3}(px|em)$/,
  // How Google Docs and Word mark bold, italic, underline and strikethrough when pasted.
  "font-weight": /^(bold|[6-9]00)$/,
  "font-style": /^italic$/,
  "text-decoration": /^(underline|line-through)$/,
};

/** Keeps only the allowed style properties, each with a value of the expected shape. */
export function cleanStyle(style: string): string {
  return style
    .split(";")
    .map((d) => d.split(":"))
    .filter((p) => p.length === 2)
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim()] as const)
    .filter(([k, v]) => STYLE[k]?.test(v))
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

let purifier: Purifier | null = null;
type HtmlWindow = Parameters<typeof createDOMPurify>[0];
let given: HtmlWindow | null = null;

function configure(p: Purifier): Purifier {
  p.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "style") {
      data.attrValue = cleanStyle(data.attrValue);
      if (!data.attrValue) data.keepAttr = false;
    }
    // A checklist's box is the only input a page may hold.
    if (node.nodeName === "INPUT" && data.attrName === "type" && data.attrValue !== "checkbox") data.keepAttr = false;
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "INPUT" && node.getAttribute("type") !== "checkbox") node.remove();
    // Links open in the person's own browser, with no way back into the app (src/ui/workflow/shared.tsx).
    if (node.nodeName === "A") node.setAttribute("rel", "noopener noreferrer nofollow");
  });
  return p;
}

/** For the server and the tests: the document to clean with, from a DOM library such as jsdom. */
export function setHtmlWindow(window: HtmlWindow): void {
  given = window;
  purifier = configure(createDOMPurify(window));
}

function current(): Purifier {
  if (!purifier && typeof window !== "undefined") purifier = configure(createDOMPurify(window));
  if (!purifier) throw new Error("Rich text cannot be cleaned here: no document to clean it with was given (server/html.ts).");
  return purifier;
}

/** A page body, cleaned to the allow-list. Links are web or mail links only. */
export function cleanHtml(html: string): string {
  return current()
    .sanitize(html, {
      ALLOWED_TAGS: TAGS,
      ALLOWED_ATTR: ATTRS,
      // DOMPurify checks every attribute value against this, so plain values ("taskList", "checkbox") must pass; of
      // the values that name a scheme, only web and mail links do.
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
    })
    .trim();
}

/** The words of a page, without its markup: for telling whether it has been written in, and for search. */
export function textOf(html: string): string {
  return html
    .replace(/<(br|\/p|\/h[1-3]|\/li|\/div)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text as HTML paragraphs, safely escaped: for writing old plain-text fields into a page. */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── Pasting ──────────────────────────────────────────────────
// A paste from Google Docs, Word or a web page keeps its bold, italic, headings, lists and links, and nothing else:
// no fonts, colours, sizes, tables or images. Google Docs marks bold and italic with styles, and Word writes its lists
// as paragraphs with a typed bullet, so those are turned into the plain tags first.

const PASTE_TAGS = ["p", "br", "strong", "b", "em", "i", "h1", "h2", "h3", "ul", "ol", "li", "a"];
const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "BLOCKQUOTE", "PRE"]);

function windowOf(): Window & typeof globalThis {
  const w = given ?? (typeof window !== "undefined" ? window : null);
  if (!w) throw new Error("Pasted text cannot be cleaned here: no document to clean it with was given (server/html.ts).");
  return w as unknown as Window & typeof globalThis;
}

const styleOf = (el: Element): string => (el.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();

function rename(el: Element, tag: string): Element {
  const next = el.ownerDocument.createElement(tag);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
  return next;
}

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

/** Word's list paragraphs (class MsoListParagraph…, or a mso-list style) become real lists. */
function wordLists(root: HTMLElement): void {
  const isItem = (el: Element | null): el is HTMLElement =>
    !!el && el.tagName === "P" && (/MsoListParagraph/i.test(el.className) || /mso-list:l\d/.test(styleOf(el)));
  for (const first of Array.from(root.querySelectorAll("p"))) {
    if (!first.isConnected || !isItem(first) || isItem(first.previousElementSibling)) continue;
    const marker =
      Array.from(first.querySelectorAll("[style]"))
        .find((m) => styleOf(m).includes("mso-list:ignore"))
        ?.textContent?.trim() ?? "";
    const list = root.ownerDocument.createElement(/^(\d+|[a-z]|[ivxlc]+)[.)]/i.test(marker) ? "ol" : "ul");
    first.before(list);
    let item: Element | null = first;
    while (isItem(item)) {
      const next: Element | null = item.nextElementSibling;
      // Word's typed bullet or number, marked mso-list:Ignore.
      item.querySelectorAll("[style]").forEach((m) => styleOf(m).includes("mso-list:ignore") && m.remove());
      list.appendChild(rename(item, "li"));
      item = next;
    }
  }
}

/** Pasted HTML, cleaned to what a paste keeps: bold, italic, headings, lists and links. */
export function cleanPastedHtml(html: string): string {
  const doc = new (windowOf().DOMParser)().parseFromString(html, "text/html");
  const body = doc.body;
  body.querySelectorAll("script, style, meta, link, title, img, svg, video, audio, iframe, object, o\\:p").forEach((n) => n.remove());
  wordLists(body);
  // Google Docs wraps the whole paste in a <b> that is not bold.
  body.querySelectorAll('b[id^="docs-internal-guid"], b[style*="font-weight:normal"], b[style*="font-weight: normal"]').forEach(unwrap);
  // Bold and italic written as styles become the plain tags, so they survive the cleaning.
  for (const el of Array.from(body.querySelectorAll("span, font, a, p, li"))) {
    const style = styleOf(el);
    const bold = /font-weight:(bold|[6-9]00)/.test(style);
    const italic = /font-style:italic/.test(style);
    if (!bold && !italic) continue;
    const inner = doc.createElement(bold ? "strong" : "em");
    while (el.firstChild) inner.appendChild(el.firstChild);
    if (bold && italic) {
      const em = doc.createElement("em");
      while (inner.firstChild) em.appendChild(inner.firstChild);
      inner.appendChild(em);
    }
    el.appendChild(inner);
  }
  // Smaller headings become the smallest the editor has; table cells and plain blocks become paragraphs.
  body.querySelectorAll("h4, h5, h6").forEach((h) => rename(h, "h3"));
  for (const el of Array.from(body.querySelectorAll("td, th, div, blockquote, pre"))) {
    if (Array.from(el.children).some((c) => BLOCKS.has(c.tagName))) unwrap(el);
    else rename(el, "p");
  }
  const cleaned = current().sanitize(body.innerHTML, {
    ALLOWED_TAGS: PASTE_TAGS,
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    KEEP_CONTENT: true,
  });
  return cleaned.replace(/<p>(\s|&nbsp;)*<\/p>/g, "").trim();
}
