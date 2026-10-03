import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Highlight } from "@tiptap/extension-highlight";
import { TextAlign } from "@tiptap/extension-text-align";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { cleanPastedHtml } from "../../services/html";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/parts";
import { openExternal } from "../../ui/workflow/shared";

// The writing area of a document page: a rich-text editor (TipTap, on ProseMirror) with a toolbar. It keeps its own
// content as people type, so typing never waits on the rest of the app; the page around it reads the HTML when it
// saves. What it makes is what the cleaner allows (src/services/html.ts), and a paste keeps only bold, italic,
// headings, lists and links. This file is loaded only when a page is opened, so the editor stays out of the app's
// first download.

const INDENT_MAX = 4;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
  }
}

/** Indent and outdent: a list item moves in or out a level; a paragraph or heading steps in by 2em, up to four steps. */
const Indent = Extension.create({
  name: "indent",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el: HTMLElement) => {
              const m = /^(\d+)em$/.exec(el.style.marginLeft);
              return m ? Math.min(INDENT_MAX, Math.round(Number(m[1]) / 2)) : 0;
            },
            renderHTML: (attrs: { indent?: number }) => (attrs.indent ? { style: `margin-left: ${attrs.indent * 2}em` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    const shift =
      (delta: number) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TipTap's command props
      ({ editor, commands, tr, state, dispatch }: any): boolean => {
        for (const item of ["taskItem", "listItem"])
          if (editor.isActive(item)) return delta > 0 ? commands.sinkListItem(item) : commands.liftListItem(item);
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => {
          if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
          const now = Number(node.attrs.indent ?? 0);
          const next = Math.max(0, Math.min(INDENT_MAX, now + delta));
          if (next !== now) {
            changed = true;
            if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          }
          return false;
        });
        return changed;
      };
    return { indent: () => shift(1), outdent: () => shift(-1) };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-]": () => this.editor.commands.indent(),
      "Mod-[": () => this.editor.commands.outdent(),
    };
  },
});

/** Ctrl or Cmd with K opens the link box, as in most editors. */
const LinkShortcut = Extension.create<{ open: () => void }>({
  name: "linkShortcut",
  addOptions() {
    return { open: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-k": () => {
        this.options.open();
        return true;
      },
    };
  },
});

// Colours chosen to read on the page's paper, which is light in both themes, and on paper when printed.
export const TEXT_COLOURS: [string, string][] = [
  ["Default", ""],
  ["Terracotta", "#b8431a"],
  ["Red", "#c92a2a"],
  ["Green", "#2b8a3e"],
  ["Blue", "#1864ab"],
  ["Purple", "#6741d9"],
  ["Grey", "#5c5f66"],
];
export const HIGHLIGHTS: [string, string][] = [
  ["None", ""],
  ["Yellow", "#fff3a3"],
  ["Green", "#d3f9d8"],
  ["Blue", "#d0ebff"],
  ["Pink", "#ffdeeb"],
  ["Orange", "#ffe8cc"],
];
export const TEXT_SIZES: [string, string][] = [
  ["Small", "0.85em"],
  ["Normal size", ""],
  ["Large", "1.25em"],
  ["Huge", "1.6em"],
];

/** A colour as #rrggbb, however the browser wrote it (it may give rgb(24, 100, 171) for #1864ab). */
export function hexOf(colour: string): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour.trim());
  return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : colour.trim().toLowerCase();
}

/** A web or mail link as typed: "dawnoffaith.tv" becomes https://dawnoffaith.tv. Null if it is not one. */
export function linkOf(typed: string): string | null {
  const raw = typed.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : raw.includes("@") && !raw.includes("/") ? `mailto:${raw}` : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol === "mailto:") return url.href;
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".") && !url.username) return url.href;
  } catch {
    /* not a link */
  }
  return null;
}

function LinkDialog({ initial, onSave, onClose }: { initial: string; onSave: (href: string | null) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const href = linkOf(value);
  return (
    <Modal
      title={initial ? "Edit link" : "Add a link"}
      onClose={onClose}
      actions={
        <>
          {initial && (
            <button className="btn danger" onClick={() => onSave(null)}>
              Remove link
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!href} onClick={() => onSave(href)}>
            Save link
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (href) onSave(href);
        }}
      >
        <Field label="Web address or email">
          <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://" autoFocus />
        </Field>
        {value.trim() && !href && <p className="wf-error">Use a web address (https://…) or an email address.</p>}
      </form>
    </Modal>
  );
}

const icon = (path: ReactNode) => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);
const ICONS = {
  undo: icon(<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />),
  redo: icon(<path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />),
  left: icon(<path d="M4 6h16M4 10h10M4 14h16M4 18h10" />),
  center: icon(<path d="M4 6h16M7 10h10M4 14h16M7 18h10" />),
  right: icon(<path d="M4 6h16M10 10h10M4 14h16M10 18h10" />),
  bullets: icon(
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" />
    </>,
  ),
  numbers: icon(<path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1V9M3.5 13.5a1.5 1.5 0 1 1 2.6 1L3.5 17.5h3M3.5 20" />),
  checklist: icon(<path d="M3 6l1.5 1.5L7 5M3 13l1.5 1.5L7 12M11 6h10M11 13h10M11 20h10M4 19h2" />),
  indent: icon(<path d="M4 6h16M10 10h10M10 14h10M4 18h16M4 9.5l3 2.5-3 2.5" />),
  outdent: icon(<path d="M4 6h16M10 10h10M10 14h10M4 18h16M7 9.5L4 12l3 2.5" />),
  link: icon(<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" />),
  clear: icon(<path d="M6 5h12M12 5l-3 14M4 20l16-16" />),
};

function Tool({
  label,
  keys,
  on,
  disabled,
  onClick,
  children,
}: {
  label: string;
  keys?: string;
  on?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`pd-tool${on ? " on" : ""}`}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      title={keys ? `${label} (${keys})` : label}
      disabled={disabled}
      // Keeps the selection in the page while the toolbar is clicked.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive("heading", { level: 1 })
        ? "1"
        : e.isActive("heading", { level: 2 })
          ? "2"
          : e.isActive("heading", { level: 3 })
            ? "3"
            : "0",
      size: String(e.getAttributes("textStyle").fontSize ?? ""),
      colour: hexOf(String(e.getAttributes("textStyle").color ?? "")),
      highlight: hexOf(String(e.getAttributes("highlight").color ?? "")),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      align: e.isActive({ textAlign: "center" }) ? "center" : e.isActive({ textAlign: "right" }) ? "right" : "left",
      bullets: e.isActive("bulletList"),
      numbers: e.isActive("orderedList"),
      checklist: e.isActive("taskList"),
      link: e.isActive("link"),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  });
  if (!s) return null;
  const c = () => editor.chain().focus();
  return (
    <div className="pd-toolbar" role="toolbar" aria-label="Formatting">
      <div className="pd-tools">
        <Tool label="Undo" keys={`${MOD}+Z`} disabled={!s.undo} onClick={() => c().undo().run()}>
          {ICONS.undo}
        </Tool>
        <Tool label="Redo" keys={`${MOD}+Shift+Z`} disabled={!s.redo} onClick={() => c().redo().run()}>
          {ICONS.redo}
        </Tool>
      </div>
      <div className="pd-tools">
        <select
          aria-label="Block style"
          value={s.block}
          onChange={(e) => {
            const level = Number(e.target.value) as 0 | 1 | 2 | 3;
            if (level === 0) c().setParagraph().run();
            else c().setHeading({ level }).run();
          }}
        >
          <option value="0">Normal text</option>
          <option value="1">Heading 1</option>
          <option value="2">Heading 2</option>
          <option value="3">Heading 3</option>
        </select>
        <select
          aria-label="Text size"
          value={TEXT_SIZES.some(([, v]) => v === s.size) ? s.size : ""}
          onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())}
        >
          {TEXT_SIZES.map(([name, v]) => (
            <option key={name} value={v}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="pd-tools">
        <Tool label="Bold" keys={`${MOD}+B`} on={s.bold} onClick={() => c().toggleBold().run()}>
          <b>B</b>
        </Tool>
        <Tool label="Italic" keys={`${MOD}+I`} on={s.italic} onClick={() => c().toggleItalic().run()}>
          <i>I</i>
        </Tool>
        <Tool label="Underline" keys={`${MOD}+U`} on={s.underline} onClick={() => c().toggleUnderline().run()}>
          <u>U</u>
        </Tool>
        <Tool label="Strikethrough" keys={`${MOD}+Shift+S`} on={s.strike} onClick={() => c().toggleStrike().run()}>
          <s>S</s>
        </Tool>
      </div>
      <div className="pd-tools">
        <select
          aria-label="Text colour"
          value={TEXT_COLOURS.some(([, v]) => v === s.colour) ? s.colour : ""}
          onChange={(e) => (e.target.value ? c().setColor(e.target.value).run() : c().unsetColor().run())}
        >
          {TEXT_COLOURS.map(([name, v]) => (
            <option key={name} value={v}>
              {name === "Default" ? "Text colour" : name}
            </option>
          ))}
        </select>
        <select
          aria-label="Highlight"
          value={HIGHLIGHTS.some(([, v]) => v === s.highlight) ? s.highlight : ""}
          onChange={(e) => (e.target.value ? c().setHighlight({ color: e.target.value }).run() : c().unsetHighlight().run())}
        >
          {HIGHLIGHTS.map(([name, v]) => (
            <option key={name} value={v}>
              {name === "None" ? "Highlight" : name}
            </option>
          ))}
        </select>
      </div>
      <div className="pd-tools">
        <Tool label="Align left" on={s.align === "left"} onClick={() => c().setTextAlign("left").run()}>
          {ICONS.left}
        </Tool>
        <Tool label="Align centre" on={s.align === "center"} onClick={() => c().setTextAlign("center").run()}>
          {ICONS.center}
        </Tool>
        <Tool label="Align right" on={s.align === "right"} onClick={() => c().setTextAlign("right").run()}>
          {ICONS.right}
        </Tool>
      </div>
      <div className="pd-tools">
        <Tool label="Bullet list" keys={`${MOD}+Shift+8`} on={s.bullets} onClick={() => c().toggleBulletList().run()}>
          {ICONS.bullets}
        </Tool>
        <Tool label="Numbered list" keys={`${MOD}+Shift+7`} on={s.numbers} onClick={() => c().toggleOrderedList().run()}>
          {ICONS.numbers}
        </Tool>
        <Tool label="Checklist" keys={`${MOD}+Shift+9`} on={s.checklist} onClick={() => c().toggleTaskList().run()}>
          {ICONS.checklist}
        </Tool>
        <Tool label="Indent" keys={`${MOD}+]`} onClick={() => c().indent().run()}>
          {ICONS.indent}
        </Tool>
        <Tool label="Outdent" keys={`${MOD}+[`} onClick={() => c().outdent().run()}>
          {ICONS.outdent}
        </Tool>
      </div>
      <div className="pd-tools">
        <Tool label={s.link ? "Edit link" : "Add a link"} keys={`${MOD}+K`} on={s.link} onClick={onLink}>
          {ICONS.link}
        </Tool>
        <Tool label="Clear formatting" onClick={() => c().unsetAllMarks().clearNodes().setTextAlign("left").run()}>
          {ICONS.clear}
        </Tool>
      </div>
    </div>
  );
}

export interface RichTextHandle {
  /** The page's HTML as it stands now. */
  html: () => string;
  /** Replaces what is shown (someone else's saved words, or the writer's own words put back), without counting it as typing. */
  setHtml: (html: string) => void;
  focus: () => void;
}

export interface RichTextProps {
  /** The page's HTML when it is opened, already cleaned. */
  initialHtml: string;
  editable: boolean;
  label: string;
  placeholder?: string;
  /** Called as the writer types, with nothing: the page reads html() when it saves. */
  onTyping: () => void;
}

const RichText = forwardRef<RichTextHandle, RichTextProps>(function RichText({ initialHtml, editable, label, placeholder, onTyping }, ref) {
  const [linking, setLinking] = useState<string | null>(null);
  const typing = useRef(onTyping);
  typing.current = onTyping;
  const openLink = useRef<() => void>(() => {});
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Kept out: the cleaner does not keep them, so they would vanish on save.
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: "https",
          protocols: ["http", "https", "mailto"],
          isAllowedUri: (url) => linkOf(url) !== null,
          HTMLAttributes: { target: null, rel: "noopener noreferrer nofollow" },
        },
      }),
      TextStyle,
      Color,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TaskList,
      TaskItem.configure({ nested: true, onReadOnlyChecked: () => false }),
      Indent,
      LinkShortcut.configure({ open: () => openLink.current() }),
      Placeholder.configure({ placeholder: placeholder ?? "Start writing…" }),
    ],
    content: initialHtml,
    editable,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "pd-prose", "aria-label": label, "aria-multiline": "true", role: "textbox" },
      transformPastedHTML: (html) => cleanPastedHtml(html),
      handleClick: (view, _pos, event) => {
        const a = (event.target as HTMLElement | null)?.closest?.("a");
        if (!a) return false;
        // In a page that cannot be written in, or with Ctrl or Cmd held, a link opens in the person's own browser.
        if (!view.editable || event.ctrlKey || event.metaKey) {
          event.preventDefault();
          void openExternal(a.getAttribute("href") ?? "");
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ transaction }) => {
      if (transaction.getMeta("pd-quiet")) return;
      typing.current();
    },
  });
  openLink.current = () => {
    if (!editor || !editor.isEditable) return;
    setLinking(String(editor.getAttributes("link").href ?? ""));
  };
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);
  useImperativeHandle(
    ref,
    () => ({
      html: () => editor?.getHTML() ?? initialHtml,
      setHtml: (html: string) => {
        if (!editor) return;
        editor.chain().setMeta("pd-quiet", true).setContent(html, { emitUpdate: false }).run();
      },
      focus: () => editor?.commands.focus(),
    }),
    [editor, initialHtml],
  );
  return (
    <div className="pd-editor">
      {editor && editable && <Toolbar editor={editor} onLink={() => openLink.current()} />}
      <EditorContent editor={editor} className="pd-paper" />
      {linking !== null && editor && (
        <LinkDialog
          initial={linking}
          onClose={() => {
            setLinking(null);
            editor.commands.focus();
          }}
          onSave={(href) => {
            setLinking(null);
            const chain = editor.chain().focus().extendMarkRange("link");
            if (!href) chain.unsetLink().run();
            else if (editor.state.selection.empty && !editor.isActive("link"))
              chain.insertContent({ type: "text", text: href.replace(/^mailto:/, ""), marks: [{ type: "link", attrs: { href } }] }).run();
            else chain.setLink({ href }).run();
          }}
        />
      )}
    </div>
  );
});

export default RichText;
