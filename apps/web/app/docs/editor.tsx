"use client";
// DOCS-WORKBENCH: the editor. TipTap (MIT, ProseMirror underneath): headings, lists, checklists, tables, code with
// highlighting (lowlight), images, callouts, links, and mentions. Type @ for people and AI employees (and anything
// else), # for tasks, projects, goals, contracts, clients, files and docs; each mention is a live chip with the
// thing's name and state now. What is stored is the editor's HTML, sanitised again by the API (services/api/src/docs.ts).
import { createContext, useContext, useEffect, useImperativeHandle, useRef, useState, forwardRef, type MouseEvent, type ReactNode, type RefObject } from "react";
import { EditorContent, Extension, Node, NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, mergeAttributes, useEditor, type Editor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extensions";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { common, createLowlight } from "lowlight";
import {
  Bold, Code, Plus, FileCode2, Heading1, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListChecks, ListOrdered, Megaphone, Minus, Quote, Redo2, Strikethrough, Table as TableIcon, Undo2,
  User, Bot, CheckSquare, FolderKanban, Target, FileSignature, Building2, File as FileIcon, FileText, Type,
} from "lucide-react";
import { isNumberCell, isTotalRow } from "../lib/doc-read.mjs";
import { repairDocHtml } from "../lib/doc-repair.mjs";
import { BLOCK_MENU, BlockHost, PulseBlock, markFresh, starterBlock } from "./blocks";
import { LAYOUT_NODES } from "./rich/layout-nodes";
import { InsertMenu, RICH_ITEMS } from "./rich/insert";
import { GDOCS_FORMAT } from "./gdocs/format";
import { AddPageDialog } from "./rich/web-page";
import rich from "./rich/rich.module.css";
import { usePrompt } from "../kit/dialogs";
import css from "./docs.module.css";

export type MentionKind = "person" | "agent" | "task" | "project" | "goal" | "contract" | "client" | "file" | "doc";
export type Resolved = { kind: MentionKind; id: string; label: string; sub: string | null; href: string; hidden: boolean; mime?: string };
type Hit = { kind: MentionKind; id: string; label: string; sub: string | null };

export const KIND_WORDS: Record<MentionKind, string> = { person: "Person", agent: "AI employee", task: "Task", project: "Project", goal: "Goal", contract: "Contract", client: "Client", file: "File", doc: "Doc" };
const ICON: Record<MentionKind, typeof User> = { person: User, agent: Bot, task: CheckSquare, project: FolderKanban, goal: Target, contract: FileSignature, client: Building2, file: FileIcon, doc: FileText };
export const KindIcon = ({ kind, size = 14 }: { kind: MentionKind; size?: number }) => { const I = ICON[kind] ?? FileText; return <I size={size} aria-hidden="true" />; };

/** The chips' live state (name and status now), filled by the doc page; a file chip opens the side viewer. */
export const ChipContext = createContext<{ get: (kind: string, id: string) => Resolved | undefined; openFile: (r: Resolved) => void }>({ get: () => undefined, openFile: () => {} });

function MentionChip({ node }: NodeViewProps) {
  const { get, openFile } = useContext(ChipContext);
  const kind = (node.attrs.kind ?? "person") as MentionKind, id = String(node.attrs.id ?? ""), label = String(node.attrs.label ?? "");
  const live = get(kind, id);
  const name = live ? live.label : label;
  const sub = live?.sub && !["company", "private", "people", "active"].includes(live.sub) ? live.sub.replace(/_/g, " ") : null;
  const open = (e: MouseEvent) => {
    if (!live || live.hidden) { e.preventDefault(); return; }
    if (kind === "file") { e.preventDefault(); openFile(live); }
  };
  return <NodeViewWrapper as="span" className={css.chip} data-hidden={live?.hidden ? "1" : undefined} title={`${KIND_WORDS[kind]}${live?.hidden ? " (hidden from you)" : ""}`}>
    <a href={live && !live.hidden ? live.href : undefined} onClick={open} style={{ color: "inherit", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
      contentEditable={false} target={kind === "file" ? undefined : "_self"}>
      <KindIcon kind={kind} size={13} />{kind === "person" || kind === "agent" ? "@" : ""}{name}{sub ? <small>· {sub}</small> : null}
    </a>
  </NodeViewWrapper>;
}

const DocMention = Mention.extend({
  addAttributes() {
    return { ...this.parent?.(), kind: { default: "person", parseHTML: (el: HTMLElement) => el.getAttribute("data-kind") ?? "person", renderHTML: (a: { kind?: string }) => ({ "data-kind": a.kind ?? "person" }) } };
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-type": "mention" }, HTMLAttributes, { "data-label": node.attrs.label ?? "" }), `@${node.attrs.label ?? ""}`];
  },
  addNodeView() { return ReactNodeViewRenderer(MentionChip, { as: "span" }); },
});

const Callout = Node.create({
  name: "callout", group: "block", content: "block+", defining: true,
  addAttributes() { return { tone: { default: "info", parseHTML: (el: HTMLElement) => el.getAttribute("data-tone") ?? "info", renderHTML: (a: { tone?: string }) => ({ "data-tone": a.tone ?? "info" }) } }; },
  parseHTML() { return [{ tag: 'div[data-type="callout"]' }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout" }), 0]; },
});

// DOCS-POLISH (owner, 14 Nov 2026): tables that read well. A column whose cells are mostly numbers is right-aligned (header
// too), and a "Total" row is bold with a line above; drawn as decorations, so the stored HTML does not change.
function tableLook(doc: PMNode): DecorationSet {
  const out: Decoration[] = [];
  doc.descendants((table, pos) => {
    if (table.type.name !== "table") return true;
    const rows: { pos: number; node: PMNode; cells: { pos: number; node: PMNode }[] }[] = [];
    table.forEach((row, rowOff) => {
      const rowPos = pos + 1 + rowOff, cells: { pos: number; node: PMNode }[] = [];
      row.forEach((cell, cellOff) => cells.push({ pos: rowPos + 1 + cellOff, node: cell }));
      rows.push({ pos: rowPos, node: row, cells });
    });
    const body = rows.filter((r) => r.cells.some((c) => c.node.type.name === "tableCell"));
    const width = Math.max(0, ...rows.map((r) => r.cells.length));
    for (let j = 0; j < width; j++) {
      const filled = body.map((r) => r.cells[j]?.node.textContent.trim() ?? "").filter((t) => t && !/^[-–—]$/.test(t));
      if (!filled.length || filled.filter(isNumberCell).length * 3 < filled.length * 2) continue;
      for (const r of rows) { const c = r.cells[j]; if (c) out.push(Decoration.node(c.pos, c.pos + c.node.nodeSize, { "data-num": "" })); }
    }
    for (const r of body) if (isTotalRow(r.cells[0]?.node.textContent ?? "")) out.push(Decoration.node(r.pos, r.pos + r.node.nodeSize, { "data-total": "" }));
    // POLISH-1115 (judge: a 3- or 4-column table on a phone runs off the edge): each cell knows its column's name, and a
    // table of three columns or more is marked, so a phone can show each row as a card ("Today: …", "Target: …").
    // A Word or Google table often has no marked header row: its first row is the header then (hidden as a card).
    const head = rows[0] ?? null, marked = !!head?.cells.some((c) => c.node.type.name === "tableHeader");
    if (head && width >= 3 && rows.length >= (marked ? 2 : 3)) {
      out.push(Decoration.node(pos, pos + table.nodeSize, { "data-stack": "" }));
      if (!marked) out.push(Decoration.node(head.pos, head.pos + head.node.nodeSize, { "data-head-row": "" }));
      for (const r of marked ? body : rows.slice(1)) r.cells.forEach((c, j) => { const label = head.cells[j]?.node.textContent.trim().slice(0, 60); if (label) out.push(Decoration.node(c.pos, c.pos + c.node.nodeSize, { "data-label": label })); });
    }
    return false;
  });
  return DecorationSet.create(doc, out);
}
// DOCS-POLISH: an imported or written doc often opens with its own title as a heading, right under the cover's title.
// Readers do not see it twice; writers see it quiet, marked "same as the title" (it stays in the doc and its exports).
type TitleState = { title: string; deco: DecorationSet };
const TITLE_KEY = new PluginKey<TitleState>("titleRepeat");
const repeatOf = (doc: PMNode, title: string) => {
  const first = doc.firstChild, same = (a: string) => a.replace(/\s+/g, " ").trim().toLowerCase();
  return first && first.type.name === "heading" && title.trim() && same(first.textContent) === same(title)
    ? DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { "data-title-repeat": "" })]) : DecorationSet.empty;
};
/** The title arrives as a transaction's meta (the doc page sends it when it changes). */
const TitleRepeat = Extension.create({
  name: "titleRepeat",
  addProseMirrorPlugins() {
    return [new Plugin<TitleState>({ key: TITLE_KEY,
      state: { init: () => ({ title: "", deco: DecorationSet.empty }),
        apply: (tr, old) => { const t = tr.getMeta(TITLE_KEY); const title = typeof t === "string" ? t : old.title;
          return tr.docChanged || typeof t === "string" ? { title, deco: repeatOf(tr.doc, title) } : old; } },
      props: { decorations: (st) => TITLE_KEY.getState(st)?.deco } })];
  },
});
const TableLook = Extension.create({
  name: "tableLook",
  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>("tableLook");
    return [new Plugin<DecorationSet>({ key,
      state: { init: (_c, st) => tableLook(st.doc), apply: (tr, old) => tr.docChanged ? tableLook(tr.doc) : old },
      props: { decorations: (st) => key.getState(st) } })];
  },
});

// DOCS-POLISH: a picture with its caption under it (kept in the picture's title, so the stored HTML stays <img>). Writers
// type the caption under a picked picture; readers see it in small grey words. An imported picture's description is
// shown when it reads as words (not a file name).
function PictureView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const src = String(node.attrs.src ?? ""), alt = String(node.attrs.alt ?? ""), title = String(node.attrs.title ?? "");
  const shown = title || (/\s/.test(alt) && !/\.(png|jpe?g|gif|webp|svg|heic)$/i.test(alt) ? alt : "");
  return <NodeViewWrapper as="figure" className={css.figure} data-selected={selected ? "1" : undefined}>
    {/* eslint-disable-next-line @next/next/no-img-element -- a doc's own picture, any size, from its files or https */}
    <img src={src} alt={alt} draggable={false} data-drag-handle="" />
    {editor.isEditable && (selected || title) ? <input className={css.captionInput} value={title} placeholder="Add a caption" maxLength={200} aria-label="Picture caption"
      onChange={(e) => updateAttributes({ title: e.target.value })} />
      : shown ? <figcaption>{shown}</figcaption> : null}
  </NodeViewWrapper>;
}
const DocImage = Image.extend({
  addNodeView() { return ReactNodeViewRenderer(PictureView, { stopEvent: ({ event }) => event.target instanceof HTMLInputElement }); },
});

// ------------------------------------------------------------------------------------------------ the @ / # picker
type ListHandle = { onKeyDown: (p: SuggestionKeyDownProps) => boolean };
const MentionList = forwardRef<ListHandle, SuggestionProps<Hit>>(function MentionList(props, ref) {
  const [picked, setAt] = useState(0);
  const at = picked < props.items.length ? picked : 0;
  const choose = (i: number) => { const it = props.items[i]; if (it) props.command(it); };
  useImperativeHandle(ref, () => ({ onKeyDown: ({ event }) => {
    if (event.key === "ArrowDown") { setAt((x) => (x + 1) % Math.max(props.items.length, 1)); return true; }
    if (event.key === "ArrowUp") { setAt((x) => (x - 1 + props.items.length) % Math.max(props.items.length, 1)); return true; }
    if (event.key === "Enter" || event.key === "Tab") { choose(at); return props.items.length > 0; }
    return false;
  } }));
  return <div role="listbox" aria-label="Mention">
    {props.items.length ? props.items.map((it, i) => <button key={`${it.kind}:${it.id}`} type="button" role="option" aria-selected={i === at} onMouseDown={(e) => { e.preventDefault(); choose(i); }}>
      <KindIcon kind={it.kind} />{it.label}<small>{KIND_WORDS[it.kind]}{it.sub ? ` · ${it.sub.replace(/_/g, " ")}` : ""}</small>
    </button>) : <p className={css.hint} style={{ padding: 8, margin: 0 }}>Nothing found. Keep typing a name.</p>}
  </div>;
});

async function findMentions(query: string, kinds: MentionKind[]): Promise<Hit[]> {
  try {
    const r = await fetch(`/api/v0/docs/mentions?q=${encodeURIComponent(query)}&kinds=${kinds.join(",")}`, { cache: "no-store" });
    return r.ok ? ((await r.json()).items as Hit[]).slice(0, 12) : [];
  } catch { return []; }
}

function picker(kinds: MentionKind[]) {
  return {
    items: ({ query }: { query: string }) => findMentions(query, kinds),
    render: () => {
      let view: ReactRenderer<ListHandle, SuggestionProps<Hit>> | null = null;
      let box: HTMLDivElement | null = null;
      const place = (p: SuggestionProps<Hit>) => {
        const r = p.clientRect?.();
        if (!box || !r) return;
        const below = r.bottom + 6, left = Math.min(r.left, window.innerWidth - 300);
        box.style.top = `${below + 320 > window.innerHeight ? Math.max(8, r.top - 326) : below}px`;
        box.style.left = `${Math.max(8, left)}px`;
      };
      return {
        onStart: (p: SuggestionProps<Hit>) => {
          view = new ReactRenderer(MentionList, { props: p, editor: p.editor });
          box = document.createElement("div"); box.className = css.suggest; box.appendChild(view.element); document.body.appendChild(box); place(p);
        },
        onUpdate: (p: SuggestionProps<Hit>) => { view?.updateProps(p); place(p); },
        onKeyDown: (p: SuggestionKeyDownProps) => { if (p.event.key === "Escape") { box?.remove(); return true; } return view?.ref?.onKeyDown(p) ?? false; },
        onExit: () => { box?.remove(); view?.destroy(); box = null; view = null; },
      };
    },
  };
}
const insertMention = ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: unknown }) => {
  const hit = props as Hit;
  editor.chain().focus().insertContentAt(range, [{ type: "mention", attrs: { id: hit.id, label: hit.label, kind: hit.kind } }, { type: "text", text: " " }]).run();
};

const AT_KINDS: MentionKind[] = ["person", "agent", "task", "project", "goal", "contract", "client", "file", "doc"];
const HASH_KINDS: MentionKind[] = ["task", "project", "goal", "contract", "client", "file", "doc"];
const HashMention = Extension.create({
  name: "hashMention",
  addProseMirrorPlugins() {
    return [Suggestion<Hit>({ editor: this.editor, char: "#", pluginKey: new PluginKey("hashMention"), allowSpaces: true, command: insertMention, ...picker(HASH_KINDS) })];
  },
});

// ------------------------------------------------------------------------------------------------ the "/" menu
// DOCS-INTERACTIVE: "/" opens the block menu (the slash-command pattern of Novel and Notion, written here): text blocks
// first, then the interactive blocks. Type to filter, arrows to move, Enter to insert, Escape to close.
// DOCS-POLISH (owner, 14 Nov 2026: "the rich parts sit behind Insert"; Codex concept 4): the menu opens on the basics, then
// the rich blocks (Chart, Big numbers, Diagram, Columns, Toggle, Callout, Web page), each with an icon and one line saying
// what it is for; the rest of the text blocks and the interactive ones follow. The "+" beside an empty line opens it too.
type Group = "Basics" | "Rich blocks" | "More text" | "Interactive";
type Cmd = { key: string; label: string; hint: string; group: Group; icon: typeof Bold; run: (e: Editor) => void };
const BASIC_CMDS: Cmd[] = [
  { key: "text", label: "Text", hint: "Plain words", group: "Basics", icon: Type, run: (e) => { e.chain().focus().setParagraph().run(); } },
  { key: "h2", label: "Heading", hint: "Give a section a title", group: "Basics", icon: Heading2, run: (e) => { e.chain().focus().setHeading({ level: 2 }).run(); } },
  { key: "bullets", label: "List", hint: "Keep ideas in order", group: "Basics", icon: List, run: (e) => { e.chain().focus().toggleBulletList().run(); } },
  { key: "table", label: "Table", hint: "Rows and columns", group: "Basics", icon: TableIcon, run: (e) => { e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
  { key: "quote", label: "Quote", hint: "Show someone's words", group: "Basics", icon: Quote, run: (e) => { e.chain().focus().toggleBlockquote().run(); } },
];
const MORE_CMDS: Cmd[] = [
  { key: "h1", label: "Big heading", hint: "Starts a part", group: "More text", icon: Heading1, run: (e) => { e.chain().focus().setHeading({ level: 1 }).run(); } },
  { key: "h3", label: "Small heading", hint: "Inside a section", group: "More text", icon: Heading3, run: (e) => { e.chain().focus().setHeading({ level: 3 }).run(); } },
  { key: "numbers", label: "Numbered list", hint: "1. 2. 3.", group: "More text", icon: ListOrdered, run: (e) => { e.chain().focus().toggleOrderedList().run(); } },
  { key: "todo", label: "To-do list", hint: "Boxes to tick", group: "More text", icon: ListChecks, run: (e) => { e.chain().focus().toggleTaskList().run(); } },
  { key: "code", label: "Code", hint: "Code with colours", group: "More text", icon: FileCode2, run: (e) => { e.chain().focus().toggleCodeBlock().run(); } },
  { key: "divider", label: "Divider", hint: "A line across", group: "More text", icon: Minus, run: (e) => { e.chain().focus().setHorizontalRule().run(); } },
];
/** Without rich blocks (an HR policy is kept as Markdown): every text block, the callout among them. */
const TEXT_CMDS: Cmd[] = [...BASIC_CMDS, ...MORE_CMDS, { key: "callout", label: "Callout", hint: "Make a point stand out", group: "More text", icon: Megaphone, run: (e) => { e.chain().focus().wrapIn("callout", { tone: "info" }).run(); } }];
// DOCS-RICH: charts, big numbers, diagrams, toggles, columns and web pages (a web page opens the "Add a web page" dialog).
export const ADD_PAGE_EVENT = "pulse-doc-add-page";
const RICH_CMDS: Cmd[] = RICH_ITEMS.map((it) => ({ key: it.key, label: it.label.replace(/ \(HTML\)$/, ""), hint: it.hint, group: "Rich blocks" as const, icon: it.icon,
  run: (e: Editor) => it.run(e, () => window.dispatchEvent(new CustomEvent(ADD_PAGE_EVENT, { detail: e }))) }));
const BLOCK_CMDS: Cmd[] = BLOCK_MENU.map((b) => ({ key: `ask-${b.kind}`, label: b.label, hint: b.hint, group: "Interactive" as const, icon: b.icon,
  run: (e: Editor) => { const block = starterBlock(b.kind); markFresh(block.id); e.chain().focus().insertContent({ type: "pulseBlock", attrs: { block } }).run(); } }));

const CommandList = forwardRef<ListHandle, SuggestionProps<Cmd>>(function CommandList(props, ref) {
  const [picked, setAt] = useState(0);
  const at = picked < props.items.length ? picked : 0;
  const choose = (i: number) => { const it = props.items[i]; if (it) props.command(it); };
  useImperativeHandle(ref, () => ({ onKeyDown: ({ event }) => {
    if (event.key === "ArrowDown") { setAt((x) => (x + 1) % Math.max(props.items.length, 1)); return true; }
    if (event.key === "ArrowUp") { setAt((x) => (x - 1 + props.items.length) % Math.max(props.items.length, 1)); return true; }
    if (event.key === "Enter" || event.key === "Tab") { choose(at); return props.items.length > 0; }
    return false;
  } }));
  useEffect(() => { document.getElementById(`slash-${props.items[at]?.key}`)?.scrollIntoView({ block: "nearest" }); }, [at, props.items]);
  return <div role="listbox" aria-label="Add a block" className={css.slash}>
    {props.items.length ? props.items.map((it, i) => { const I = it.icon; return <div key={it.key}>
      {i === 0 || props.items[i - 1].group !== it.group ? <p className={css.menuGroup}>{it.group}</p> : null}
      <button type="button" role="option" id={`slash-${it.key}`} aria-selected={i === at} onMouseDown={(e) => { e.preventDefault(); choose(i); }}>
        <span className={css.slashIcon} data-group={it.group === "Rich blocks" ? "rich" : undefined}><I size={17} aria-hidden="true" /></span>
        <span className={css.slashWords}><strong>{it.label}</strong><small>{it.hint}</small></span></button></div>; })
      : <p className={css.hint} style={{ padding: 8, margin: 0 }}>No block by that name.</p>}
    <p className={css.slashFoot}>Type / anywhere for this menu</p>
  </div>;
});

function slashMenu(withBlocks: boolean) {
  const all = withBlocks ? [...BASIC_CMDS, ...RICH_CMDS, ...MORE_CMDS, ...BLOCK_CMDS] : TEXT_CMDS;
  return Extension.create({
    name: "slashMenu",
    addProseMirrorPlugins() {
      return [Suggestion<Cmd>({
        editor: this.editor, char: "/", pluginKey: new PluginKey("slashMenu"), startOfLine: false,
        items: ({ query }) => { const q = query.toLowerCase(); return all.filter((c) => !q || c.label.toLowerCase().includes(q) || c.key.startsWith(q) || c.hint.toLowerCase().includes(q)).slice(0, 30); },
        command: ({ editor, range, props }) => { editor.chain().focus().deleteRange(range).run(); (props as Cmd).run(editor); },
        render: () => {
          let view: ReactRenderer<ListHandle, SuggestionProps<Cmd>> | null = null;
          let box: HTMLDivElement | null = null;
          const place = (p: SuggestionProps<Cmd>) => {
            const r = p.clientRect?.();
            if (!box || !r) return;
            // below the line when 240 px fit there (shorter if need be), else above it; never over the page's top
            const below = r.bottom + 6, room = window.innerHeight - below - 8;
            const tall = room >= 240 ? Math.min(420, room) : Math.min(420, r.top - 14);
            box.style.maxHeight = `${Math.max(160, tall)}px`;
            box.style.top = `${room >= 240 ? below : Math.max(8, r.top - 6 - tall)}px`;
            box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 336))}px`;
          };
          return {
            onStart: (p: SuggestionProps<Cmd>) => {
              view = new ReactRenderer(CommandList, { props: p, editor: p.editor });
              box = document.createElement("div"); box.className = `${css.suggest} ${css.slashBox}`; box.appendChild(view.element); document.body.appendChild(box); place(p);
            },
            onUpdate: (p: SuggestionProps<Cmd>) => { view?.updateProps(p); place(p); },
            onKeyDown: (p: SuggestionKeyDownProps) => { if (p.event.key === "Escape") { box?.remove(); return true; } return view?.ref?.onKeyDown(p) ?? false; },
            onExit: () => { box?.remove(); view?.destroy(); box = null; view = null; },
          };
        },
      })];
    },
  });
}

const lowlight = createLowlight(common);

// ------------------------------------------------------------------------------------------------ the editor
export type DocEditorHandle = { editor: Editor | null };
/** DOCS-INTERACTIVE: one editor for every document in Pulse. `features` turns parts off where the stored format cannot
 *  hold them (an HR policy is kept as Markdown for its reader and Word file: no mentions, blocks or pictures). */
export type EditorFeatures = { mentions?: boolean; blocks?: boolean; images?: boolean };
// DOCS-GDOCS: `chrome` — the doc page draws Google Docs' menu bar and toolbar itself (gdocs/chrome.tsx), above the page,
// so the old toolbar is not drawn here; `onReady` hands it the editor.
export const DocEditor = forwardRef<DocEditorHandle, { html: string; editable: boolean; onChange: (html: string) => void; onUpload?: (f: File) => Promise<string | null>; toolbar?: ReactNode;
  features?: EditorFeatures; placeholder?: string; label?: string; title?: string; chrome?: boolean; onReady?: (e: Editor | null) => void }>(
  function DocEditor({ html, editable, onChange, onUpload = async () => null, toolbar, features, placeholder, label, title = "", chrome = false, onReady }, ref) {
    const withMentions = features?.mentions !== false, withBlocks = features?.blocks !== false, withImages = features?.images !== false;
    const changed = useRef(onChange), upload = useRef(onUpload);
    useEffect(() => { changed.current = onChange; upload.current = onUpload; }, [onChange, onUpload]);
    const editorRef = useRef<Editor | null>(null);
    const editor = useEditor({
      immediatelyRender: false,
      editable,
      // DOCS-GDOCS: Markdown left in a stored doc (an import from Google Docs or Word) is read as formatting.
      content: repairDocHtml(html) || "<p></p>",
      extensions: [
        StarterKit.configure({ codeBlock: false, heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"], HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } } }),
        CodeBlockLowlight.configure({ lowlight }),
        // A header cell is a column header to screen readers (scope="col", as the app's other tables say).
        Table.configure({ resizable: false }), TableRow, TableHeader.configure({ HTMLAttributes: { scope: "col" } }), TableCell,
        TaskList, TaskItem.configure({ nested: true }),
        DocImage.configure({ inline: false, allowBase64: false }),
        Callout,
        ...GDOCS_FORMAT,
        TableLook,
        TitleRepeat,
        // DOCS-POLISH: the empty line being written on says how to add a block (not inside tables or lists).
        Placeholder.configure({ placeholder: ({ editor: e, node, pos }) => e.isEmpty ? placeholder ?? (withMentions ? "Write here. Type / for charts, tables and more, @ to mention someone, # for a task or file." : "Write here. Type / for headings, lists and tables.")
          : withBlocks && node.type.name === "paragraph" && e.state.doc.resolve(pos).depth === 0 ? "Type / for charts, tables and more" : "" }),
        ...(withMentions ? [DocMention.configure({ suggestion: { char: "@", allowSpaces: true, command: insertMention, ...picker(AT_KINDS) } }), HashMention] : []),
        PulseBlock,
        ...LAYOUT_NODES,
        slashMenu(withBlocks),
      ],
      editorProps: {
        attributes: { class: css.prose, "aria-label": label ?? "Doc", role: "textbox", "aria-multiline": "true" },
        handlePaste: (_view, event) => {
          if (!withImages) return false;
          const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          void Promise.all(files.map((f) => upload.current(f))).then((urls) => urls.forEach((src) => { if (src) editorRef.current?.chain().focus().setImage({ src }).run(); }));
          return true;
        },
        handleDrop: (_view, event) => {
          if (!withImages) return false;
          const files = Array.from((event as DragEvent).dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          event.preventDefault();
          void Promise.all(files.map((f) => upload.current(f))).then((urls) => urls.forEach((src) => { if (src) editorRef.current?.chain().focus().setImage({ src }).run(); }));
          return true;
        },
      },
      onUpdate: ({ editor: e }) => changed.current(e.getHTML()),
    });
    useEffect(() => { editorRef.current = editor; }, [editor]);
    const ready = useRef(onReady);
    useEffect(() => { ready.current = onReady; }, [onReady]);
    useEffect(() => { ready.current?.(editor); return () => ready.current?.(null); }, [editor]);
    useEffect(() => {
      if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(TITLE_KEY, title).setMeta("addToHistory", false));
    }, [editor, title]);
    useImperativeHandle(ref, () => ({ editor }), [editor]);
    useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);
    // DOCS-RICH: "Add a web page" (from Insert or "/"), for this doc (BlockHost: the doc page provides it).
    const host = useContext(BlockHost);
    const wrapRef = useRef<HTMLDivElement>(null);
    const [addingPage, setAddingPage] = useState(false);
    useEffect(() => {
      const on = (e: Event) => { if ((e as CustomEvent).detail === editorRef.current) setAddingPage(true); };
      window.addEventListener(ADD_PAGE_EVENT, on); return () => window.removeEventListener(ADD_PAGE_EVENT, on);
    }, []);
    return <>
      {editable && editor && !chrome ? <Toolbar editor={editor} onUpload={withImages ? (f) => upload.current(f) : null} onAddPage={withBlocks && host.docId ? () => setAddingPage(true) : null} /> : null}
      {toolbar}
      <div className={rich.richDoc} ref={wrapRef} style={{ position: "relative" }}><EditorContent editor={editor} />
        {editable && withBlocks && editor ? <LinePlus editor={editor} wrap={wrapRef} /> : null}</div>
      {withBlocks && editor ? <AddPageDialog open={addingPage} docId={host.docId} onClose={() => setAddingPage(false)}
        onKeep={({ title, fileId }) => { const id = `b_${Math.random().toString(36).slice(2, 12)}`; editor.chain().focus().insertContentAt(editor.state.selection.to, { type: "pulseBlock", attrs: { block: { kind: "html", id, title, fileId } } }).run(); }}
        onConvert={(html) => { editor.chain().focus().insertContentAt(editor.state.selection.to, html).run(); }} /> : null}
    </>;
  });

// DOCS-POLISH (Codex concept 4): a round "+" beside the empty line being written on opens the block menu (it types the "/").
function LinePlus({ editor, wrap }: { editor: Editor; wrap: RefObject<HTMLDivElement | null> }) {
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const place = () => {
      const { selection } = editor.state, box = wrap.current;
      const p = selection.$from.parent;
      if (!box || !selection.empty || selection.$from.depth !== 1 || p.type.name !== "paragraph" || p.content.size || (!editor.isFocused && !editor.isEmpty)) { setTop(null); return; }
      try { const c = editor.view.coordsAtPos(selection.from); setTop(c.top - box.getBoundingClientRect().top + (c.bottom - c.top) / 2); } catch { setTop(null); }
    };
    place();
    const later = () => setTimeout(place, 120);
    editor.on("selectionUpdate", place); editor.on("transaction", place); editor.on("focus", place); editor.on("blur", later);
    return () => { editor.off("selectionUpdate", place); editor.off("transaction", place); editor.off("focus", place); editor.off("blur", later); };
  }, [editor, wrap]);
  if (top === null) return null;
  return <button type="button" className={css.linePlus} style={{ top }} aria-label="Add a block: chart, big numbers, table and more" title="Add a block"
    onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().insertContent("/").run(); }}><Plus size={16} aria-hidden="true" /></button>;
}

function Toolbar({ editor, onUpload, onAddPage }: { editor: Editor; onUpload: ((f: File) => Promise<string | null>) | null; onAddPage: (() => void) | null }) {
  const [, force] = useState(0);
  const ask = usePrompt();
  useEffect(() => { const f = () => force((x) => x + 1); editor.on("selectionUpdate", f); editor.on("transaction", f); return () => { editor.off("selectionUpdate", f); editor.off("transaction", f); }; }, [editor]);
  const b = (label: string, Icon: typeof Bold, run: () => void, on = false) =>
    <button type="button" title={label} aria-label={label} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={run}><Icon size={16} aria-hidden="true" /></button>;
  const c = () => editor.chain().focus();
  // UI-DIALOGS: the app's own prompt checks the link (https://, http:// or mailto:; "example.com" gets https://).
  const link = async () => {
    const had = editor.getAttributes("link").href as string | undefined;
    const url = await ask({ title: had ? "Change the link" : "Add a link", label: "Link", placeholder: "https://example.com", defaultValue: had ?? "",
      helper: had ? "Leave it empty to remove the link." : "Paste the web address the words should open.", confirmLabel: had ? "Save link" : "Add link",
      url: ["https:", "http:", "mailto:"], required: !had });
    if (url === null) { c().run(); return; }
    if (!url) { c().unsetLink().run(); return; }
    c().extendMarkRange("link").setLink({ href: url }).run();
  };
  const inTable = editor.isActive("table");
  return <div className={css.tools} role="toolbar" aria-label="Formatting">
    {onAddPage ? <><InsertMenu editor={editor} openPage={onAddPage} /><span className={css.sep} /></> : null}
    {b("Heading 1", Heading1, () => c().toggleHeading({ level: 1 }).run(), editor.isActive("heading", { level: 1 }))}
    {b("Heading 2", Heading2, () => c().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
    {b("Heading 3", Heading3, () => c().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
    <span className={css.sep} />
    {b("Bold", Bold, () => c().toggleBold().run(), editor.isActive("bold"))}
    {b("Italic", Italic, () => c().toggleItalic().run(), editor.isActive("italic"))}
    {b("Strikethrough", Strikethrough, () => c().toggleStrike().run(), editor.isActive("strike"))}
    {b("Inline code", Code, () => c().toggleCode().run(), editor.isActive("code"))}
    {b("Link", Link2, link, editor.isActive("link"))}
    <span className={css.sep} />
    {b("Bulleted list", List, () => c().toggleBulletList().run(), editor.isActive("bulletList"))}
    {b("Numbered list", ListOrdered, () => c().toggleOrderedList().run(), editor.isActive("orderedList"))}
    {b("Checklist", ListChecks, () => c().toggleTaskList().run(), editor.isActive("taskList"))}
    {b("Quote", Quote, () => c().toggleBlockquote().run(), editor.isActive("blockquote"))}
    {b("Code block", FileCode2, () => c().toggleCodeBlock().run(), editor.isActive("codeBlock"))}
    {b("Callout", Megaphone, () => editor.isActive("callout") ? c().lift("callout").run() : c().wrapIn("callout", { tone: "info" }).run(), editor.isActive("callout"))}
    {b("Divider", Minus, () => c().setHorizontalRule().run())}
    {b("Table", TableIcon, () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), inTable)}
    {onUpload ? <label title="Image" aria-label="Image"><ImagePlus size={16} aria-hidden="true" />
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = "";
        if (f) { const src = await onUpload(f); if (src) c().setImage({ src, alt: f.name }).run(); }
      }} /></label> : null}
    {inTable ? <>
      <span className={css.sep} />
      <button type="button" onClick={() => c().addRowAfter().run()}>+ Row</button>
      <button type="button" onClick={() => c().addColumnAfter().run()}>+ Column</button>
      <button type="button" onClick={() => c().deleteRow().run()}>− Row</button>
      <button type="button" onClick={() => c().deleteColumn().run()}>− Column</button>
      <button type="button" onClick={() => c().deleteTable().run()}>Remove table</button>
    </> : null}
    {editor.isActive("callout") ? <>
      <span className={css.sep} />
      {(["info", "tip", "warning", "danger"] as const).map((t) => <button key={t} type="button" onClick={() => c().updateAttributes("callout", { tone: t }).run()}
        aria-pressed={editor.getAttributes("callout").tone === t}>{t === "info" ? "Note" : t === "tip" ? "Tip" : t === "warning" ? "Warning" : "Danger"}</button>)}
    </> : null}
    <span className={css.sep} />
    {b("Undo", Undo2, () => c().undo().run())}
    {b("Redo", Redo2, () => c().redo().run())}
  </div>;
}

/** Every mention in the editor, for the live chips. */
export function mentionsIn(editor: Editor | null): { kind: string; id: string }[] {
  const out = new Map<string, { kind: string; id: string }>();
  editor?.state.doc.descendants((n) => { if (n.type.name === "mention" && n.attrs.id) out.set(`${n.attrs.kind}:${n.attrs.id}`, { kind: String(n.attrs.kind ?? "person"), id: String(n.attrs.id) }); });
  return [...out.values()];
}
