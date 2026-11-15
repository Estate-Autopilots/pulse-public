"use client";
// DOCS-RICH: Insert ▾ in the editor's toolbar (Codex concept "rich-insert"): Charts and data (Chart, Big numbers,
// Diagram), Layout (Callout, Toggle, Columns), From a file (Web page). The same items are in the "/" menu.
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { BarChart3, ChevronDown, Columns2, FileCode2, Hash, ListCollapse, Megaphone, Network, Plus } from "lucide-react";
import { markFresh } from "../blocks";
import { insertColumns, insertToggle } from "./layout-nodes";
import r from "./rich.module.css";

export type RichItem = { key: string; label: string; hint: string; group: "Charts and data" | "Layout" | "From a file"; icon: typeof Plus; run: (e: Editor, openPage: () => void) => void };
const block = (e: Editor, b: Record<string, unknown>) => {
  const id = `b_${Math.random().toString(36).slice(2, 12)}`;
  markFresh(id);
  // after what is selected, never over it (a block picked with a click is selected whole)
  e.chain().focus().insertContentAt(e.state.selection.to, { type: "pulseBlock", attrs: { block: { ...b, id } } }).run();
};
export const RICH_ITEMS: RichItem[] = [
  { key: "chart", label: "Chart", hint: "Compare numbers", group: "Charts and data", icon: BarChart3,
    run: (e) => block(e, { kind: "chart", type: "line", title: "", unit: "", columns: ["Month", "Revenue", "Cost"], rows: [["Jan", 2.4, 1.8], ["Feb", 2.7, 1.9], ["Mar", 2.6, 2], ["Apr", 3.1, 2.2]] }) },
  { key: "stat", label: "Big numbers", hint: "Highlight key figures", group: "Charts and data", icon: Hash,
    run: (e) => block(e, { kind: "stat", title: "", items: [{ value: "₹42.6 L", label: "Revenue", delta: "+12% vs last month", tone: "good" }, { value: "318", label: "Leads", delta: "-4%", tone: "bad" }] }) },
  { key: "diagram", label: "Diagram", hint: "Show a flow or a plan", group: "Charts and data", icon: Network,
    run: (e) => block(e, { kind: "diagram", title: "", code: "flowchart TD\n  A[Start] --> B[Next step]\n  B --> C[Done]" }) },
  // DOCS-POLISH: the order the "/" menu shows them in (Codex concept 4).
  { key: "columns", label: "Columns", hint: "Put blocks side by side", group: "Layout", icon: Columns2, run: (e) => insertColumns(e, 2) },
  { key: "toggle", label: "Toggle", hint: "Hide extra detail until opened", group: "Layout", icon: ListCollapse, run: (e) => insertToggle(e) },
  { key: "callout", label: "Callout", hint: "Make a point stand out", group: "Layout", icon: Megaphone, run: (e) => { e.chain().focus().wrapIn("callout", { tone: "info" }).run(); } },
  { key: "page", label: "Web page (HTML)", hint: "An interactive page from a file", group: "From a file", icon: FileCode2, run: (_e, openPage) => openPage() },
];

export function InsertMenu({ editor, openPage }: { editor: Editor; openPage: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", key);
    box.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  return <span className={r.insertWrap} ref={box}>
    <button type="button" className={r.insertBtn} aria-haspopup="menu" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((x) => !x)}>
      <Plus size={16} aria-hidden="true" />Insert<ChevronDown size={14} aria-hidden="true" /></button>
    {open ? <div className={r.insertMenu} role="menu" aria-label="Insert"
      onKeyDown={(e) => { if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return; e.preventDefault();
        const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])], i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }}>
      {RICH_ITEMS.map((it, i) => { const I = it.icon; return <div key={it.key}>
        {i === 0 || RICH_ITEMS[i - 1].group !== it.group ? <p>{it.group}</p> : null}
        <button type="button" role="menuitem" onClick={() => { setOpen(false); it.run(editor, openPage); }}><I size={18} aria-hidden="true" /><strong>{it.label}</strong><small>{it.hint}</small></button>
      </div>; })}
    </div> : null}
  </span>;
}
