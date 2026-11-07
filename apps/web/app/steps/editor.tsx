"use client";
// FLOW-C: the writing field of every work screen (a document's section, an asset's tab, a pack). Rich text kept as
// Markdown, so Pip reads and writes the same text: a toolbar (bold, italic, heading, lists, quote, link, table) and
// ⌘/Ctrl+B · I · K, and a Read view that typesets it (headings, lists, tables) the way the policy reader does.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Bold, Heading2, Italic, Link2, List, ListOrdered, Quote, Table2 } from "lucide-react";
import { parseMarkdown } from "../lib/markdown.mjs";
import { MarkdownBody } from "../hr/policy-reader";
import css from "./work.module.css";

type Edit = { text: string; start: number; end: number };
function wrap(e: Edit, left: string, right = left, empty = "text"): Edit {
  const sel = e.text.slice(e.start, e.end) || empty;
  const text = e.text.slice(0, e.start) + left + sel + right + e.text.slice(e.end);
  return { text, start: e.start + left.length, end: e.start + left.length + sel.length };
}
function lines(e: Edit, prefix: (i: number, line: string) => string): Edit {
  const from = e.text.lastIndexOf("\n", e.start - 1) + 1, toNl = e.text.indexOf("\n", e.end), to = toNl < 0 ? e.text.length : toNl;
  const block = e.text.slice(from, to).split("\n").map((l, i) => prefix(i, l.replace(/^(#{1,6} |[-*] |\d+\. |> )/, ""))).join("\n");
  return { text: e.text.slice(0, from) + block + e.text.slice(to), start: from, end: from + block.length };
}
const TABLE = "\n| Column | Column |\n| --- | --- |\n| | |\n";
const FORMAT: Record<string, (e: Edit) => Edit> = {
  bold: (e) => wrap(e, "**"), italic: (e) => wrap(e, "*"), heading: (e) => lines(e, (_i, l) => `## ${l}`), bullets: (e) => lines(e, (_i, l) => `- ${l}`),
  numbers: (e) => lines(e, (i, l) => `${i + 1}. ${l}`), quote: (e) => lines(e, (_i, l) => `> ${l}`), link: (e) => wrap(e, "[", "](https://)", "words"),
  table: (e) => ({ text: e.text.slice(0, e.end) + TABLE + e.text.slice(e.end), start: e.end + TABLE.length, end: e.end + TABLE.length }),
};
const KEYS: Record<string, string> = { b: "bold", i: "italic", k: "link" };
const TOOLS = [
  { key: "bold", label: "Bold (Ctrl+B)", icon: <Bold size={15} /> }, { key: "italic", label: "Italic (Ctrl+I)", icon: <Italic size={15} /> },
  { key: "heading", label: "Heading", icon: <Heading2 size={15} /> }, { key: "bullets", label: "Bulleted list", icon: <List size={15} /> },
  { key: "numbers", label: "Numbered list", icon: <ListOrdered size={15} /> }, { key: "quote", label: "Quote", icon: <Quote size={15} /> },
  { key: "link", label: "Link (Ctrl+K)", icon: <Link2 size={15} /> }, { key: "table", label: "Table", icon: <Table2 size={15} /> },
];

export function TextEditor({ value, onChange, onBlur, readOnly, label, placeholder, rows = 14 }: {
  value: string; onChange: (v: string) => void; onBlur?: () => void; readOnly?: boolean; label: string; placeholder?: string; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"write" | "read">(readOnly || value.trim() ? "read" : "write");
  const shown = readOnly ? "read" : mode;
  const blocks = useMemo(() => (shown === "read" ? parseMarkdown(value).blocks : []), [shown, value]);
  function run(key: string) {
    const t = ref.current; if (!t) return;
    const next = FORMAT[key]({ text: t.value, start: t.selectionStart, end: t.selectionEnd });
    onChange(next.text);
    requestAnimationFrame(() => { t.focus(); t.setSelectionRange(next.start, next.end); });
  }
  return <div className={css.editor} data-mode={shown}>
    {!readOnly ? <div className={css.tools} role="toolbar" aria-label={`Format ${label}`}>
      {shown === "write" ? TOOLS.map((t) => <button key={t.key} type="button" title={t.label} aria-label={t.label} onMouseDown={(e) => e.preventDefault()} onClick={() => run(t.key)}>{t.icon}</button>) : <span className={css.toolsNote}>Reading</span>}
      <span className={css.modes} role="group" aria-label="Write or read">
        <button type="button" aria-pressed={shown === "write"} onClick={() => setMode("write")}>Write</button>
        <button type="button" aria-pressed={shown === "read"} onClick={() => { onBlur?.(); setMode("read"); }}>Read</button>
      </span>
    </div> : null}
    {shown === "write" ? <textarea ref={ref} className={css.area} value={value} rows={rows} aria-label={label} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
      onKeyDown={(ev: KeyboardEvent<HTMLTextAreaElement>) => { const k = (ev.key ?? "").toLowerCase(); if ((ev.metaKey || ev.ctrlKey) && KEYS[k]) { ev.preventDefault(); run(KEYS[k]); } }} maxLength={100000} spellCheck />
      : <div className={css.read} onDoubleClick={() => { if (!readOnly) setMode("write"); }}>{value.trim() ? <MarkdownBody blocks={blocks} anchors={false} /> : <p className={css.quiet}>{readOnly ? "Nothing written." : "Nothing written yet. Press Write to start."}</p>}</div>}
  </div>;
}
