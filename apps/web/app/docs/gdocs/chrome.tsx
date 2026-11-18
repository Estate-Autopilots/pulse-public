"use client";
// DOCS-GDOCS (owner, 15 Nov 2026; Codex concept reports/docs-gdocs/concepts/gdocs-desktop.png): Google Docs' menu bar
// (File, Edit, View, Insert, Format, Tools) and its one toolbar row (undo, redo, print, zoom, style, font size, bold,
// italic, underline, colour, highlight, link, comment, image, alignment, lists, indent, clear formatting), with the
// same keyboard shortcuts. The rich blocks (chart, big numbers, diagram, web page) are in Insert, as Google Docs puts
// its charts and drawings there.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, Bold, ChevronDown, Highlighter, ImagePlus, IndentDecrease, IndentIncrease, Italic, Link2,
  List, ListChecks, ListOrdered, MessageSquarePlus, Minus, Plus, Printer, Redo2, RemoveFormatting, Underline, Undo2,
} from "lucide-react";
import { RICH_ITEMS } from "../rich/insert";
import { ALIGNS, COLORS, SIZES, sizeAt, type Align, type ColorKey } from "./format";
import g from "./gdocs.module.css";

export const ZOOMS = [50, 75, 90, 100, 125, 150, 200] as const;
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** "Ctrl+Alt+M" as this computer writes it. */
export const keys = (k: string) => MAC ? k.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : k;

/** What the doc page does for the menus (the editor's own commands are run here). */
export type DocActions = {
  canEdit: boolean;
  share: () => void; comments: () => void; history: () => void; labels: () => void; send: (() => void) | null; reads: (() => void) | null; links: () => void;
  richer: (() => void) | null; archive: (() => void) | null; archived: boolean;
  downloadMarkdown: () => void; downloadWord: () => void; print: () => void; wordCount: () => void; shortcuts: () => void; newDoc: () => void; allDocs: () => void;
  link: () => void; comment: () => void; image: (() => void) | null; addPage: (() => void) | null;
  zoom: number; setZoom: (z: number) => void; printLayout: boolean; setPrintLayout: (on: boolean) => void; outline: boolean; setOutline: (on: boolean) => void;
  pageNumbers: boolean; setPageNumbers: (on: boolean) => void; paper: "a4" | "letter"; setPaper: (p: "a4" | "letter") => void;
};

type Item = { label: string; keys?: string; run?: () => void; on?: boolean; off?: boolean; icon?: ReactNode; sub?: Item[] } | "sep";

/** Keeps the editor's state in step with each transaction (marks and blocks at the cursor). */
function useTick(editor: Editor | null) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const f = () => force((x) => x + 1);
    editor.on("selectionUpdate", f); editor.on("transaction", f);
    return () => { editor.off("selectionUpdate", f); editor.off("transaction", f); };
  }, [editor]);
}

/** A list that opens under its button, outside any scrolling box (fixed, kept on screen). */
function Pop({ anchor, onClose, children, label, wide }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; label: string; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !box.current) return;
    const r = anchor.getBoundingClientRect(), w = box.current.offsetWidth, h = box.current.offsetHeight;
    const below = r.bottom + 4, room = window.innerHeight - below - 8;
    setAt({ top: room >= h || r.top < h ? below : Math.max(8, r.top - 4 - h), left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) });
  }, [anchor]);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); anchor?.focus(); } };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [anchor, onClose]);
  return <div ref={box} className={g.pop} data-wide={wide ? "1" : undefined} role="menu" aria-label={label} style={at ? { top: at.top, left: at.left } : { visibility: "hidden", top: 0, left: 0 }}
    onKeyDown={(e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return; e.preventDefault();
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]") ?? [])].filter((b) => !b.disabled);
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }}>{children}</div>;
}

function MenuList({ items, close }: { items: Item[]; close: () => void }) {
  const [sub, setSub] = useState<{ i: number; el: HTMLElement } | null>(null);
  return <>{items.map((it, i) => it === "sep" ? <hr key={i} className={g.sep} /> : <button key={i} type="button" className={g.item} disabled={it.off}
    role={it.on !== undefined ? "menuitemcheckbox" : "menuitem"} aria-checked={it.on !== undefined ? it.on : undefined} aria-haspopup={it.sub ? "menu" : undefined}
    onMouseDown={(e) => e.preventDefault()}
    onMouseEnter={(e) => { if (it.sub) setSub({ i, el: e.currentTarget }); else if (sub) setSub(null); }}
    onKeyDown={(e) => { if (it.sub && e.key === "ArrowRight") { e.preventDefault(); setSub({ i, el: e.currentTarget }); } }}
    onClick={(e) => { if (it.sub) { setSub({ i, el: e.currentTarget }); return; } close(); it.run?.(); }}>
    <span className={g.tick} aria-hidden="true">{it.on ? "✓" : it.icon ?? ""}</span><span className={g.itemLabel}>{it.label}</span>
    {it.keys ? <kbd className={g.kbd}>{keys(it.keys)}</kbd> : it.sub ? <span className={g.kbd} aria-hidden="true">›</span> : null}
  </button>)}
  {sub && items[sub.i] !== "sep" && (items[sub.i] as { sub?: Item[] }).sub ? <SubMenu anchor={sub.el} items={(items[sub.i] as { sub: Item[] }).sub} close={() => { setSub(null); close(); }} back={() => setSub(null)} /> : null}</>;
}
function SubMenu({ anchor, items, close, back }: { anchor: HTMLElement; items: Item[]; close: () => void; back: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!box.current) return;
    const r = anchor.getBoundingClientRect(), w = box.current.offsetWidth, h = box.current.offsetHeight;
    const left = r.right + w + 8 < window.innerWidth ? r.right + 2 : Math.max(8, r.left - w - 2);
    setAt({ top: Math.max(8, Math.min(r.top - 6, window.innerHeight - h - 8)), left });
    box.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [anchor]);
  return <div ref={box} className={g.pop} role="menu" style={at ?? { visibility: "hidden", top: 0, left: 0 }}
    onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); back(); anchor.focus(); } }}>
    <MenuList items={items} close={close} /></div>;
}

/** POLISH-1115: the Insert menu's plain names for the layout blocks (the "/" menu explains each one in a line). */
const PLAIN_INSERT: Record<string, string> = { Toggle: "Fold-away section", Callout: "Note box", Columns: "Side-by-side columns" };
const STYLES = [{ key: "p", label: "Normal text", keys: "Ctrl+Alt+0" }, { key: "1", label: "Heading 1", keys: "Ctrl+Alt+1" }, { key: "2", label: "Heading 2", keys: "Ctrl+Alt+2" },
  { key: "3", label: "Heading 3", keys: "Ctrl+Alt+3" }, { key: "4", label: "Heading 4", keys: "Ctrl+Alt+4" }] as const;
const styleAt = (e: Editor) => STYLES.find((s) => s.key !== "p" && e.isActive("heading", { level: Number(s.key) })) ?? STYLES[0];
const setStyle = (e: Editor, key: string) => key === "p" ? e.chain().focus().setParagraph().run() : e.chain().focus().setHeading({ level: Number(key) as 1 | 2 | 3 | 4 }).run();
const alignAt = (e: Editor): Align => (ALIGNS.find((a) => a !== "left" && (e.isActive({ textAlign: a }))) ?? "left");
const ALIGN_ICON = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify } as const;
const ALIGN_WORDS = { left: "Left", center: "Center", right: "Right", justify: "Justified" } as const;
const ALIGN_KEYS = { left: "Ctrl+Shift+L", center: "Ctrl+Shift+E", right: "Ctrl+Shift+R", justify: "Ctrl+Shift+J" } as const;

export function MenuBar({ editor, a }: { editor: Editor | null; a: DocActions }) {
  useTick(editor);
  const [open, setOpen] = useState<{ key: string; el: HTMLElement } | null>(null);
  const e = editor, c = () => e!.chain().focus();
  const edit = a.canEdit && !!e;
  const menus: { key: string; label: string; items: Item[] }[] = [
    { key: "file", label: "File", items: [
      { label: "New doc", run: a.newDoc }, { label: "Open Docs", keys: "Ctrl+O", run: a.allDocs }, "sep",
      { label: "Share", run: a.share }, ...(a.send ? [{ label: "Send for approval", run: a.send }] : []), "sep",
      { label: "Download", sub: [{ label: "PDF document (.pdf)", run: a.print }, { label: "Word document (.docx)", run: a.downloadWord }, { label: "Markdown (.md)", run: a.downloadMarkdown }] },
      { label: "Version history", keys: "Ctrl+Alt+Shift+H", run: a.history }, { label: "Folder and tags", run: a.labels }, "sep",
      { label: "Page setup", sub: [{ label: "A4", on: a.paper === "a4", run: () => a.setPaper("a4") }, { label: "Letter", on: a.paper === "letter", run: () => a.setPaper("letter") }, "sep",
        { label: "Page numbers when printed", on: a.pageNumbers, run: () => a.setPageNumbers(!a.pageNumbers) }] },
      { label: "Print", keys: "Ctrl+P", run: a.print },
      ...(a.archive ? ["sep" as const, { label: a.archived ? "Restore from archive" : "Move to archive", run: a.archive }] : []),
    ] },
    { key: "edit", label: "Edit", items: [
      { label: "Undo", keys: "Ctrl+Z", off: !edit || !e!.can().undo(), run: () => c().undo().run() },
      { label: "Redo", keys: "Ctrl+Y", off: !edit || !e!.can().redo(), run: () => c().redo().run() }, "sep",
      { label: "Select all", keys: "Ctrl+A", off: !e, run: () => c().selectAll().run() },
      { label: "Delete", off: !edit || e!.state.selection.empty, run: () => c().deleteSelection().run() },
    ] },
    { key: "view", label: "View", items: [
      { label: "Print layout", on: a.printLayout, run: () => a.setPrintLayout(!a.printLayout) },
      { label: "Show outline", keys: "Ctrl+Alt+A Ctrl+Alt+H", on: a.outline, run: () => a.setOutline(!a.outline) }, "sep",
      { label: "Zoom", sub: ZOOMS.map((z) => ({ label: `${z}%`, on: a.zoom === z, run: () => a.setZoom(z) })) },
      { label: "Comments", keys: "Ctrl+Alt+Shift+A", run: a.comments },
    ] },
    { key: "insert", label: "Insert", items: edit ? [
      ...(a.image ? [{ label: "Image", run: a.image }] : []),
      { label: "Table", run: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      ...RICH_ITEMS.filter((it) => it.group === "Charts and data").map((it) => ({ label: it.label, run: () => it.run(e!, () => a.addPage?.()) })),
      ...(a.addPage ? [{ label: "Web page", run: a.addPage }] : []), "sep",
      { label: "Link", keys: "Ctrl+K", run: a.link }, { label: "Comment", keys: "Ctrl+Alt+M", run: a.comment },
      { label: "Checklist", keys: "Ctrl+Shift+9", run: () => c().toggleTaskList().run() }, "sep",
      ...RICH_ITEMS.filter((it) => it.group === "Layout").map((it) => ({ label: PLAIN_INSERT[it.label] ?? it.label, run: () => it.run(e!, () => a.addPage?.()) })),
      { label: "Horizontal line", run: () => c().setHorizontalRule().run() },
      { label: "Page break", keys: "Ctrl+Enter", run: () => e!.chain().focus().setPageBreak().run() },
      { label: "Code block", run: () => c().toggleCodeBlock().run() },
    ] : [{ label: "You can read this doc but not change it", off: true }] },
    { key: "format", label: "Format", items: edit ? [
      { label: "Text", sub: [
        { label: "Bold", keys: "Ctrl+B", on: e!.isActive("bold"), run: () => c().toggleBold().run() },
        { label: "Italic", keys: "Ctrl+I", on: e!.isActive("italic"), run: () => c().toggleItalic().run() },
        { label: "Underline", keys: "Ctrl+U", on: e!.isActive("underline"), run: () => c().toggleUnderline().run() },
        { label: "Strikethrough", keys: "Alt+Shift+5", on: e!.isActive("strike"), run: () => c().toggleStrike().run() },
        { label: "Code", keys: "Ctrl+E", on: e!.isActive("code"), run: () => c().toggleCode().run() }, "sep",
        { label: "Bigger", keys: "Ctrl+Shift+.", run: () => e!.chain().focus().setFontSize(SIZES.find((s) => s > sizeAt(e!)) ?? 36).run() },
        { label: "Smaller", keys: "Ctrl+Shift+,", run: () => e!.chain().focus().setFontSize([...SIZES].reverse().find((s) => s < sizeAt(e!)) ?? 8).run() },
      ] },
      { label: "Paragraph styles", sub: STYLES.map((s) => ({ label: s.label, keys: s.keys, on: styleAt(e!).key === s.key, run: () => setStyle(e!, s.key) })) },
      { label: "Align and indent", sub: [...ALIGNS.map((x) => ({ label: ALIGN_WORDS[x], keys: ALIGN_KEYS[x], on: alignAt(e!) === x, run: () => e!.chain().focus().setAlign(x).run() })), "sep" as const,
        { label: "Increase indent", keys: "Ctrl+]", run: () => e!.chain().focus().indent().run() }, { label: "Decrease indent", keys: "Ctrl+[", run: () => e!.chain().focus().outdent().run() }] },
      { label: "Bullets and numbering", sub: [
        { label: "Bulleted list", keys: "Ctrl+Shift+8", on: e!.isActive("bulletList"), run: () => c().toggleBulletList().run() },
        { label: "Numbered list", keys: "Ctrl+Shift+7", on: e!.isActive("orderedList"), run: () => c().toggleOrderedList().run() },
        { label: "Checklist", keys: "Ctrl+Shift+9", on: e!.isActive("taskList"), run: () => c().toggleTaskList().run() }] },
      ...(e!.isActive("table") ? ["sep" as const, { label: "Table", sub: [
        { label: "Insert row below", run: () => c().addRowAfter().run() }, { label: "Insert column right", run: () => c().addColumnAfter().run() },
        { label: "Delete row", run: () => c().deleteRow().run() }, { label: "Delete column", run: () => c().deleteColumn().run() }, "sep" as const,
        { label: "Delete table", run: () => c().deleteTable().run() }] }] : []),
      "sep", { label: "Clear formatting", keys: "Ctrl+\\", run: () => e!.chain().focus().clearFormatting().run() },
    ] : [{ label: "You can read this doc but not change it", off: true }] },
    { key: "tools", label: "Tools", items: [
      { label: "Word count", keys: "Ctrl+Shift+C", run: a.wordCount },
      ...(a.richer ? [{ label: "Make this doc richer", run: a.richer }] : []),
      ...(a.reads ? [{ label: "Who read it", run: a.reads }] : []),
      { label: "Linked work", run: a.links }, "sep",
      { label: "Keyboard shortcuts", keys: "Ctrl+/", run: a.shortcuts },
    ] },
  ];
  const menu = menus.find((m) => m.key === open?.key);
  return <nav className={g.menubar} aria-label="Doc menu">
    {menus.map((m) => <button key={m.key} type="button" className={g.menuBtn} aria-haspopup="menu" aria-expanded={open?.key === m.key}
      onMouseDown={(ev) => ev.preventDefault()}
      onMouseEnter={(ev) => { if (open && open.key !== m.key) setOpen({ key: m.key, el: ev.currentTarget }); }}
      onKeyDown={(ev) => { if (ev.key === "ArrowDown") { ev.preventDefault(); setOpen({ key: m.key, el: ev.currentTarget }); } }}
      // The button is read now: React may run the updater later (while the editor re-renders this bar), when the event's
      // currentTarget is already null, and a menu with no anchor stayed hidden at 0,0 (docs-rich walk, 17 Nov).
      onClick={(ev) => { const el = ev.currentTarget; setOpen((o) => o?.key === m.key ? null : { key: m.key, el }); }}>{m.label}</button>)}
    {menu && open ? <Pop anchor={open.el} label={menu.label} onClose={() => setOpen(null)}><MenuList items={menu.items} close={() => setOpen(null)} /></Pop> : null}
  </nav>;
}

function Swatches({ editor, mark, close }: { editor: Editor; mark: "text" | "highlight"; close: () => void }) {
  const now = mark === "text" ? editor.getAttributes("textStyle").color : editor.isActive("highlight") ? editor.getAttributes("highlight").color : null;
  const set = (k: ColorKey | null) => { const ch = editor.chain().focus(); (mark === "text" ? ch.setTextColor(k) : ch.setHighlightColor(k)).run(); close(); };
  return <div className={g.swatchBox}>
    <button type="button" role="menuitem" className={g.item} onMouseDown={(e) => e.preventDefault()} onClick={() => set(null)}><span className={g.tick} aria-hidden="true">{!now ? "✓" : ""}</span>{mark === "text" ? "Default colour" : "No highlight"}</button>
    <div className={g.swatches} role="group" aria-label={mark === "text" ? "Text colour" : "Highlight colour"}>
      {COLORS.map((x) => <button key={x.key} type="button" role="menuitemradio" aria-checked={now === x.key} aria-label={x.label} title={x.label} className={g.swatch}
        data-swatch={x.key} data-mark={mark} onMouseDown={(e) => e.preventDefault()} onClick={() => set(x.key)} />)}
    </div>
  </div>;
}

/** The one toolbar row. */
export function GToolbar({ editor, a }: { editor: Editor; a: DocActions }) {
  useTick(editor);
  // POLISH-1115: once the toolbar is stuck at the top, a solid band above it hides what scrolls under (not before: then
  // the band covered the title row). Stuck = it has left its place (a mark just before it) by more than its margin.
  const sentinel = useRef<HTMLSpanElement | null>(null), bar = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => { frame = 0; const s = sentinel.current, t = bar.current; if (s && t) setStuck(t.getBoundingClientRect().top - s.getBoundingClientRect().top > 12); };
    const on = () => { if (!frame) frame = requestAnimationFrame(check); };
    document.addEventListener("scroll", on, { capture: true, passive: true }); window.addEventListener("resize", on); check();
    return () => { document.removeEventListener("scroll", on, { capture: true }); window.removeEventListener("resize", on); if (frame) cancelAnimationFrame(frame); };
  }, []);
  const [pop, setPop] = useState<{ key: string; el: HTMLElement } | null>(null);
  const [sizeText, setSizeText] = useState<string | null>(null);
  const c = () => editor.chain().focus();
  const toggle = (key: string) => (ev: React.MouseEvent<HTMLElement>) => { const el = ev.currentTarget; setPop((p) => p?.key === key ? null : { key, el }); };
  const close = () => setPop(null);
  const b = (label: string, Icon: typeof Bold, run: () => void, on?: boolean, k?: string, off?: boolean) =>
    <button type="button" className={g.tb} title={k ? `${label} (${keys(k)})` : label} aria-label={label} aria-pressed={on} disabled={off}
      onMouseDown={(ev) => ev.preventDefault()} onClick={run}><Icon size={17} aria-hidden="true" /></button>;
  const size = sizeAt(editor), style = styleAt(editor), align = alignAt(editor);
  const color = editor.getAttributes("textStyle").color as string | undefined, hl = editor.isActive("highlight") ? editor.getAttributes("highlight").color as string : undefined;
  const AlignIcon = ALIGN_ICON[align];
  return <><span ref={sentinel} className={g.stickMark} aria-hidden="true" /><div ref={bar} className={g.toolbar} role="toolbar" aria-label="Formatting" data-stuck={stuck ? "" : undefined}>
    {b("Undo", Undo2, () => c().undo().run(), undefined, "Ctrl+Z", !editor.can().undo())}
    {b("Redo", Redo2, () => c().redo().run(), undefined, "Ctrl+Y", !editor.can().redo())}
    {b("Print", Printer, a.print, undefined, "Ctrl+P")}
    <button type="button" className={`${g.tb} ${g.drop}`} title="Zoom" aria-haspopup="menu" aria-expanded={pop?.key === "zoom"} onMouseDown={(ev) => ev.preventDefault()} onClick={toggle("zoom")}>{a.zoom}%<ChevronDown size={14} aria-hidden="true" /></button>
    <span className={g.div} />
    <button type="button" className={`${g.tb} ${g.drop} ${g.styleBtn}`} title="Styles" aria-haspopup="menu" aria-expanded={pop?.key === "style"} onMouseDown={(ev) => ev.preventDefault()} onClick={toggle("style")}>{style.label}<ChevronDown size={14} aria-hidden="true" /></button>
    <span className={g.div} />
    <span className={g.size} role="group" aria-label="Font size">
      {b("Smaller", Minus, () => c().setFontSize([...SIZES].reverse().find((s) => s < size) ?? 8).run(), undefined, "Ctrl+Shift+,")}
      <input className={g.sizeInput} aria-label="Font size" inputMode="numeric" value={sizeText ?? String(size)} onFocus={() => setSizeText(String(size))}
        onChange={(ev) => setSizeText(ev.target.value.replace(/[^\d]/g, "").slice(0, 2))}
        onBlur={() => setSizeText(null)}
        onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); const n = Number(sizeText); if (n >= 6 && n <= 72) c().setFontSize(n).run(); setSizeText(null); } if (ev.key === "Escape") { setSizeText(null); editor.commands.focus(); } }} />
      {b("Bigger", Plus, () => c().setFontSize(SIZES.find((s) => s > size) ?? 36).run(), undefined, "Ctrl+Shift+.")}
    </span>
    <span className={g.div} />
    {b("Bold", Bold, () => c().toggleBold().run(), editor.isActive("bold"), "Ctrl+B")}
    {b("Italic", Italic, () => c().toggleItalic().run(), editor.isActive("italic"), "Ctrl+I")}
    {b("Underline", Underline, () => c().toggleUnderline().run(), editor.isActive("underline"), "Ctrl+U")}
    <button type="button" className={`${g.tb} ${g.colorBtn}`} title="Text colour" aria-label="Text colour" aria-haspopup="menu" aria-expanded={pop?.key === "color"} onMouseDown={(ev) => ev.preventDefault()} onClick={toggle("color")}>
      <Baseline size={17} aria-hidden="true" /><span className={g.colorBar} data-swatch={color ?? "default"} data-mark="text" /></button>
    <button type="button" className={`${g.tb} ${g.colorBtn}`} title="Highlight colour" aria-label="Highlight colour" aria-haspopup="menu" aria-expanded={pop?.key === "hl"} onMouseDown={(ev) => ev.preventDefault()} onClick={toggle("hl")}>
      <Highlighter size={17} aria-hidden="true" /><span className={g.colorBar} data-swatch={hl ?? "none"} data-mark="highlight" /></button>
    <span className={g.div} />
    {b("Insert link", Link2, a.link, editor.isActive("link"), "Ctrl+K")}
    {b("Add comment", MessageSquarePlus, a.comment, undefined, "Ctrl+Alt+M")}
    {a.image ? b("Insert image", ImagePlus, a.image) : null}
    <span className={g.div} />
    <span className={g.alignWide}>{ALIGNS.map((x) => <span key={x}>{b(`${ALIGN_WORDS[x]} align`, ALIGN_ICON[x], () => c().setAlign(x).run(), align === x, ALIGN_KEYS[x])}</span>)}</span>
    <button type="button" className={`${g.tb} ${g.drop} ${g.alignNarrow}`} title="Align" aria-label="Align" aria-haspopup="menu" aria-expanded={pop?.key === "align"} onMouseDown={(ev) => ev.preventDefault()} onClick={toggle("align")}><AlignIcon size={17} aria-hidden="true" /><ChevronDown size={14} aria-hidden="true" /></button>
    <span className={g.div} />
    {b("Checklist", ListChecks, () => c().toggleTaskList().run(), editor.isActive("taskList"), "Ctrl+Shift+9")}
    {b("Bulleted list", List, () => c().toggleBulletList().run(), editor.isActive("bulletList"), "Ctrl+Shift+8")}
    {b("Numbered list", ListOrdered, () => c().toggleOrderedList().run(), editor.isActive("orderedList"), "Ctrl+Shift+7")}
    {b("Decrease indent", IndentDecrease, () => c().outdent().run(), undefined, "Ctrl+[")}
    {b("Increase indent", IndentIncrease, () => c().indent().run(), undefined, "Ctrl+]")}
    {b("Clear formatting", RemoveFormatting, () => c().clearFormatting().run(), undefined, "Ctrl+\\")}
    {pop?.key === "zoom" ? <Pop anchor={pop.el} label="Zoom" onClose={close}><MenuList close={close} items={ZOOMS.map((z) => ({ label: `${z}%`, on: a.zoom === z, run: () => a.setZoom(z) }))} /></Pop> : null}
    {pop?.key === "style" ? <Pop anchor={pop.el} label="Styles" onClose={close} wide><div className={g.styleList}>{STYLES.map((s) => <button key={s.key} type="button" role="menuitemradio" aria-checked={style.key === s.key}
      className={g.item} data-style={s.key} onMouseDown={(ev) => ev.preventDefault()} onClick={() => { close(); setStyle(editor, s.key); }}>
      <span className={g.tick} aria-hidden="true">{style.key === s.key ? "✓" : ""}</span><span className={g.itemLabel}>{s.label}</span><kbd className={g.kbd}>{keys(s.keys)}</kbd></button>)}</div></Pop> : null}
    {pop?.key === "color" ? <Pop anchor={pop.el} label="Text colour" onClose={close}><Swatches editor={editor} mark="text" close={close} /></Pop> : null}
    {pop?.key === "hl" ? <Pop anchor={pop.el} label="Highlight colour" onClose={close}><Swatches editor={editor} mark="highlight" close={close} /></Pop> : null}
    {pop?.key === "align" ? <Pop anchor={pop.el} label="Align" onClose={close}><MenuList close={close} items={ALIGNS.map((x) => ({ label: ALIGN_WORDS[x], keys: ALIGN_KEYS[x], on: align === x, run: () => c().setAlign(x).run() }))} /></Pop> : null}
  </div></>;
}

/** Google Docs' shortcuts, for Tools → Keyboard shortcuts (Ctrl+/). */
export const SHORTCUTS: [string, string][] = [
  ["Bold, italic, underline", "Ctrl+B, Ctrl+I, Ctrl+U"], ["Strikethrough", "Alt+Shift+5"], ["Insert or change a link", "Ctrl+K"], ["Add a comment", "Ctrl+Alt+M"],
  ["Normal text", "Ctrl+Alt+0"], ["Heading 1 to 4", "Ctrl+Alt+1 … 4"], ["Numbered list", "Ctrl+Shift+7"], ["Bulleted list", "Ctrl+Shift+8"], ["Checklist", "Ctrl+Shift+9"],
  ["Align left, center, right, justified", "Ctrl+Shift+L, E, R, J"], ["Increase or decrease indent", "Ctrl+], Ctrl+["], ["Bigger or smaller text", "Ctrl+Shift+. and ,"],
  ["Clear formatting", "Ctrl+\\"], ["Page break", "Ctrl+Enter"], ["Undo, redo", "Ctrl+Z, Ctrl+Y"], ["Print or save as PDF", "Ctrl+P"], ["Word count", "Ctrl+Shift+C"],
  ["Version history", "Ctrl+Alt+Shift+H"], ["Blocks: charts, tables and more", "/"], ["Mention a person", "@"],
];
