"use client";
// DOCS-WORKBENCH: the editor. TipTap (MIT, ProseMirror underneath): headings, lists, checklists, tables, code with
// highlighting (lowlight), images, callouts, links, and mentions. Type @ for people and AI employees (and anything
// else), # for tasks, projects, goals, contracts, clients, files and docs; each mention is a live chip with the
// thing's name and state now. What is stored is the editor's HTML, sanitised again by the API (services/api/src/docs.ts).
import { createContext, useContext, useEffect, useImperativeHandle, useRef, useState, forwardRef, type MouseEvent, type ReactNode } from "react";
import { EditorContent, Extension, Node, NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, mergeAttributes, useEditor, type Editor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extensions";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { common, createLowlight } from "lowlight";
import {
  Bold, Code, FileCode2, Heading1, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListChecks, ListOrdered, Megaphone, Minus, Quote, Redo2, Strikethrough, Table as TableIcon, Undo2,
  User, Bot, CheckSquare, FolderKanban, Target, FileSignature, Building2, File as FileIcon, FileText,
} from "lucide-react";
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

const lowlight = createLowlight(common);

// ------------------------------------------------------------------------------------------------ the editor
export type DocEditorHandle = { editor: Editor | null };
export const DocEditor = forwardRef<DocEditorHandle, { html: string; editable: boolean; onChange: (html: string) => void; onUpload: (f: File) => Promise<string | null>; toolbar?: ReactNode }>(
  function DocEditor({ html, editable, onChange, onUpload, toolbar }, ref) {
    const changed = useRef(onChange), upload = useRef(onUpload);
    useEffect(() => { changed.current = onChange; upload.current = onUpload; }, [onChange, onUpload]);
    const editorRef = useRef<Editor | null>(null);
    const editor = useEditor({
      immediatelyRender: false,
      editable,
      content: html || "<p></p>",
      extensions: [
        StarterKit.configure({ codeBlock: false, heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"], HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } } }),
        CodeBlockLowlight.configure({ lowlight }),
        Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
        TaskList, TaskItem.configure({ nested: true }),
        Image.configure({ inline: false, allowBase64: false }),
        Callout,
        Placeholder.configure({ placeholder: "Write here. Type @ to mention someone, # for a task, project or file." }),
        DocMention.configure({ suggestion: { char: "@", allowSpaces: true, command: insertMention, ...picker(AT_KINDS) } }),
        HashMention,
      ],
      editorProps: {
        attributes: { class: css.prose, "aria-label": "Doc" },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          void Promise.all(files.map((f) => upload.current(f))).then((urls) => urls.forEach((src) => { if (src) editorRef.current?.chain().focus().setImage({ src }).run(); }));
          return true;
        },
        handleDrop: (_view, event) => {
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
    useImperativeHandle(ref, () => ({ editor }), [editor]);
    useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);
    return <>
      {editable && editor ? <Toolbar editor={editor} onUpload={(f) => upload.current(f)} /> : null}
      {toolbar}
      <EditorContent editor={editor} />
    </>;
  });

function Toolbar({ editor, onUpload }: { editor: Editor; onUpload: (f: File) => Promise<string | null> }) {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((x) => x + 1); editor.on("selectionUpdate", f); editor.on("transaction", f); return () => { editor.off("selectionUpdate", f); editor.off("transaction", f); }; }, [editor]);
  const b = (label: string, Icon: typeof Bold, run: () => void, on = false) =>
    <button type="button" title={label} aria-label={label} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={run}><Icon size={16} aria-hidden="true" /></button>;
  const c = () => editor.chain().focus();
  const link = () => {
    const had = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link to (https://…)", had ?? "https://");
    if (url === null) return;
    if (!url.trim()) { c().unsetLink().run(); return; }
    if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) { window.alert("Links start with https://, http:// or mailto:"); return; }
    c().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  const inTable = editor.isActive("table");
  return <div className={css.tools} role="toolbar" aria-label="Formatting">
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
    <label title="Image" aria-label="Image"><ImagePlus size={16} aria-hidden="true" />
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = "";
        if (f) { const src = await onUpload(f); if (src) c().setImage({ src, alt: f.name }).run(); }
      }} /></label>
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
