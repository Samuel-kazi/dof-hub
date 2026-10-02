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
export function setHtmlWindow(window: Parameters<typeof createDOMPurify>[0]): void {
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
