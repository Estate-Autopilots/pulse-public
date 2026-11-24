// DOCS-GDOCS (owner, 15 Nov 2026: "Look at how Google Docs is made, that is the UI we want, everybody knows how it
// functions"): the formatting Google Docs' toolbar has and TipTap's starter kit does not: alignment, indent, text
// colour and size, highlight and page breaks, with Google Docs' own keyboard shortcuts. Written here (small, no new
// dependency). What is stored stays inside the API's allow-list (services/api/src/docs.ts SANITIZE): alignment and
// size as a style the sanitiser checks, colour and highlight as a named colour (data-color) that the CSS draws in a
// shade that reads in light and dark, never a raw colour that disappears on a dark page.
import { Extension, Mark, Node, mergeAttributes, type ChainedCommands, type Editor } from "@tiptap/react";
import type { EditorState, Transaction } from "@tiptap/pm/state";

export const ALIGNS = ["left", "center", "right", "justify"] as const;
export type Align = (typeof ALIGNS)[number];
/** Google Docs' palette, named so it can be drawn for light and dark pages (docs.module.css [data-color]). */
export const COLORS = [
  { key: "grey", label: "Grey" }, { key: "red", label: "Red" }, { key: "orange", label: "Orange" }, { key: "yellow", label: "Yellow" },
  { key: "green", label: "Green" }, { key: "teal", label: "Teal" }, { key: "blue", label: "Blue" }, { key: "violet", label: "Violet" },
  { key: "pink", label: "Pink" }, { key: "brown", label: "Brown" },
] as const;
export type ColorKey = (typeof COLORS)[number]["key"];
const COLOR_KEYS = new Set<string>(COLORS.map((c) => c.key));
/** A colour pasted from Google Docs or Word ("rgb(204, 0, 0)", "#c00000") as the nearest named one; black, white and
 *  near-greys are the page's own colour (null), so a pasted doc never turns black on a dark page. */
export function nearestColor(css: string, background = false): ColorKey | null {
  const m = css.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/) ?? css.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  const hex = css.startsWith("#");
  const [r, gg, b] = [1, 2, 3].map((i) => (hex ? parseInt(m[i], 16) : Number(m[i])) / 255);
  if (!hex && m[4] !== undefined && Number(m[4]) < 0.2) return null;
  const max = Math.max(r, gg, b), min = Math.min(r, gg, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (background && l > 0.97) return null;
  if (s < 0.18 || d < 0.08) return background ? (l < 0.93 ? "grey" : null) : (l < 0.3 || l > 0.9 ? null : "grey");
  let h = max === r ? ((gg - b) / d) % 6 : max === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h >= 15 && h < 45 && l < 0.38) return "brown";
  return h < 15 ? "red" : h < 40 ? "orange" : h < 66 ? "yellow" : h < 165 ? "green" : h < 195 ? "teal" : h < 255 ? "blue" : h < 290 ? "violet" : h < 340 ? "pink" : "red";
}

/** Font sizes in points, as Google Docs lists them; the body is 11 pt there and 12 pt (16 px) here. */
export const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36] as const;
export const BODY_PT = 12;

declare module "@tiptap/react" {
  interface Commands<ReturnType> {
    gdocsFormat: {
      setAlign: (a: Align) => ReturnType;
      indent: () => ReturnType;
      outdent: () => ReturnType;
      setTextColor: (c: ColorKey | null) => ReturnType;
      setHighlightColor: (c: ColorKey | null) => ReturnType;
      setFontSize: (pt: number | null) => ReturnType;
      clearFormatting: () => ReturnType;
      setPageBreak: () => ReturnType;
    };
  }
}

const BLOCKS = ["paragraph", "heading"];

/** Alignment and indent of paragraphs and headings (Ctrl+Shift+L/E/R/J, Ctrl+] and Ctrl+[). */
const BlockFormat = Extension.create({
  name: "gdocsBlockFormat",
  addGlobalAttributes() {
    return [{ types: BLOCKS, attributes: {
      textAlign: { default: null,
        parseHTML: (el: HTMLElement) => { const a = el.style.textAlign; return (ALIGNS as readonly string[]).includes(a) && a !== "left" ? a : null; },
        renderHTML: (a: { textAlign?: string | null }) => a.textAlign ? { style: `text-align: ${a.textAlign}` } : {} },
      indent: { default: 0,
        parseHTML: (el: HTMLElement) => Math.min(8, Math.max(0, Number(el.getAttribute("data-indent")) || 0)),
        renderHTML: (a: { indent?: number }) => a.indent ? { "data-indent": String(a.indent) } : {} },
    } }];
  },
  addCommands() {
    const eachBlock = (f: (attrs: Record<string, unknown>) => Record<string, unknown>) => ({ tr, state }: { tr: Transaction; state: EditorState }) => {
      const { from, to } = state.selection; let changed = false;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!BLOCKS.includes(node.type.name)) return true;
        const next = f(node.attrs);
        if (Object.keys(next).some((k) => next[k] !== node.attrs[k])) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next }); changed = true; }
        return false;
      });
      return changed;
    };
    return {
      setAlign: (a) => eachBlock(() => ({ textAlign: a === "left" ? null : a })),
      // In a list, indent nests the item (as Google Docs does); elsewhere it moves the paragraph in by half an inch.
      indent: () => ({ editor, commands }) => editor.isActive("listItem") ? commands.sinkListItem("listItem") : editor.isActive("taskItem") ? commands.sinkListItem("taskItem")
        : commands.command(eachBlock((x) => ({ indent: Math.min(8, Number(x.indent ?? 0) + 1) }))),
      outdent: () => ({ editor, commands }) => editor.isActive("listItem") ? commands.liftListItem("listItem") : editor.isActive("taskItem") ? commands.liftListItem("taskItem")
        : commands.command(eachBlock((x) => ({ indent: Math.max(0, Number(x.indent ?? 0) - 1) }))),
      setPageBreak: () => ({ commands }) => commands.insertContent([{ type: "pageBreak" }, { type: "paragraph" }]),
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-l": () => this.editor.commands.setAlign("left"),
      "Mod-Shift-e": () => this.editor.commands.setAlign("center"),
      "Mod-Shift-r": () => this.editor.commands.setAlign("right"),
      "Mod-Shift-j": () => this.editor.commands.setAlign("justify"),
      "Mod-]": () => this.editor.commands.indent(),
      "Mod-[": () => this.editor.commands.outdent(),
      "Mod-Enter": () => this.editor.commands.setPageBreak(),
      "Alt-Shift-5": () => this.editor.chain().focus().toggleStrike().run(),
      "Mod-\\": () => this.editor.commands.clearFormatting(),
      "Mod-Shift-.": () => this.editor.commands.setFontSize(stepSize(this.editor, 1)),
      "Mod-Shift-,": () => this.editor.commands.setFontSize(stepSize(this.editor, -1)),
    };
  },
});

/** The next size up or down Google Docs' list from the size at the cursor. */
export function stepSize(editor: Editor, dir: 1 | -1): number {
  const now = sizeAt(editor);
  const list = SIZES as readonly number[];
  return dir > 0 ? list.find((s) => s > now) ?? list[list.length - 1] : [...list].reverse().find((s) => s < now) ?? list[0];
}
export function sizeAt(editor: Editor): number {
  const pt = Number(editor.getAttributes("textStyle").fontSize);
  if (Number.isFinite(pt) && pt > 0) return pt;
  // POLISH-1115 (judge: the size box said 12 on a heading): a heading's size as it is drawn (26/21/17.5/16 px in pt).
  const level = Number(editor.getAttributes("heading").level);
  return editor.isActive("heading") && HEADING_PT[level] ? HEADING_PT[level] : BODY_PT;
}
const HEADING_PT: Record<number, number> = { 1: 20, 2: 16, 3: 13, 4: 12 };

/** Text colour and size: <span data-color="red" style="font-size: 14pt">. */
const TextStyle = Mark.create({
  name: "textStyle",
  priority: 101,
  addAttributes() {
    return {
      color: { default: null, parseHTML: (el: HTMLElement) => { const c = el.getAttribute("data-color"); return c && COLOR_KEYS.has(c) ? c : el.style.color ? nearestColor(el.style.color) : null; },
        renderHTML: (a: { color?: string | null }) => a.color ? { "data-color": a.color } : {} },
      fontSize: { default: null, parseHTML: (el: HTMLElement) => { const m = el.style.fontSize.match(/^(\d{1,2}(?:\.\d)?)pt$/); const pt = m ? Number(m[1]) : NaN; return pt >= 6 && pt <= 72 && pt !== BODY_PT ? pt : null; },
        renderHTML: (a: { fontSize?: number | null }) => a.fontSize ? { style: `font-size: ${a.fontSize}pt` } : {} },
    };
  },
  // A span from Google Docs or Word with only its usual 11 pt and black is plain text, not a style.
  parseHTML() { return [{ tag: "span", consuming: false, getAttrs: (el: HTMLElement) => el.hasAttribute("data-color") || (el.style.color && nearestColor(el.style.color))
    || /^\d{1,2}(\.\d)?pt$/.test(el.style.fontSize) && el.style.fontSize !== "11pt" ? {} : false }]; },
  renderHTML({ HTMLAttributes }) { return ["span", mergeAttributes(HTMLAttributes), 0]; },
  addCommands() {
    const set = (attrs: Record<string, unknown>) => ({ chain, editor }: { chain: () => ChainedCommands; editor: Editor }) => {
      const next = { ...editor.getAttributes("textStyle"), ...attrs };
      return Object.values(next).some((v) => v != null) ? chain().setMark("textStyle", next).run() : chain().unsetMark("textStyle", { extendEmptyMarkRange: true }).run();
    };
    return {
      setTextColor: (c) => set({ color: c }),
      setFontSize: (pt) => set({ fontSize: pt && pt !== BODY_PT ? pt : null }),
      clearFormatting: () => ({ chain }) => chain().unsetAllMarks().setAlign("left").run(),
    };
  },
});

/** Highlight: <mark data-color="yellow">. */
const Highlight = Mark.create({
  name: "highlight",
  addAttributes() {
    return { color: { default: "yellow", parseHTML: (el: HTMLElement) => { const c = el.getAttribute("data-color"); return c && COLOR_KEYS.has(c) ? c : "yellow"; },
      renderHTML: (a: { color?: string }) => ({ "data-color": a.color ?? "yellow" }) } };
  },
  // Google Docs and Word paste a highlight as a span's background.
  parseHTML() { return [{ tag: "mark" }, { tag: "span", consuming: false, getAttrs: (el: HTMLElement) => { const c = el.style.backgroundColor ? nearestColor(el.style.backgroundColor, true) : null; return c ? { color: c } : false; } }]; },
  renderHTML({ HTMLAttributes }) { return ["mark", mergeAttributes(HTMLAttributes), 0]; },
  addCommands() {
    return { setHighlightColor: (c) => ({ chain }) => c ? chain().setMark("highlight", { color: c }).run() : chain().unsetMark("highlight", { extendEmptyMarkRange: true }).run() };
  },
});

/** A page break: a quiet dashed line on screen, a new page when printed (Ctrl+Enter, as in Google Docs). */
const PageBreak = Node.create({
  name: "pageBreak", group: "block", atom: true, selectable: true,
  parseHTML() { return [{ tag: 'div[data-type="page-break"]' }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { "data-type": "page-break" })]; },
});

export const GDOCS_FORMAT = [BlockFormat, TextStyle, Highlight, PageBreak];
