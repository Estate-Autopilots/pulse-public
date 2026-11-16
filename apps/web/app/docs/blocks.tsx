"use client";
// DOCS-INTERACTIVE: the interactive blocks. A fixed catalogue (approval, checklist, form, action list, quote card, chart,
// timeline) rendered by Pulse's own components from plain data, never from code an agent sends (the A2UI / AI SDK way;
// DOCS-INTERACTIVE-RESEARCH.md). The same `BlockCard` draws a block anywhere: in a doc (the TipTap node below) and, later,
// in a chat message. Answers are per person and kept by the API (doc-interactive.ts, table doc_block_answer).
import { createContext, useContext, useEffect, useState } from "react";
import { Node, NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes, type NodeViewProps } from "@tiptap/react";
import { Check, CheckCircle2, CircleHelp, ClipboardList, Clock, ListTodo, MessageSquareQuote, Pencil, ThumbsUp, Trash2, X } from "lucide-react";
import { post } from "../orgs/client";
import { ChartEditor, DocChart, type ChartBlock } from "./rich/chart";
import { DiagramEditor, DiagramView, type DiagramBlock } from "./rich/diagram";
import { PageView, type PageBlock } from "./rich/web-page";
import { StatEditor, StatView, type StatBlock, type StatItem } from "./rich/stat";
import type { Cell, ChartType } from "../lib/doc-rich.mjs";
import css from "./blocks.module.css";

// DOCS-RICH (owner, 9 Nov 2026): chart (now line, bar, area, pie, scatter, table or a number, from a data table), diagram,
// html (a web page in a sealed frame) and stat (big numbers) join the catalogue; their parts live in ./rich/.
export type BlockKind = "approval" | "checklist" | "form" | "actions" | "quote" | "chart" | "timeline" | "diagram" | "html" | "stat";
type Field = { label: string; type: "text" | "long" | "number" | "date" | "choice"; options?: string[] };
export type Block = { kind: BlockKind; id: string; question?: string; onApprove?: { createTask?: string; taskId?: string }; title?: string; items?: string[] | StatItem[];
  fields?: Field[]; rows?: (string | { label: string; value: number } | Cell[])[]; text?: string; who?: string; role?: string; unit?: string;
  steps?: { date: string; text: string; done: boolean }[]; type?: ChartType; columns?: string[]; stacked?: boolean; horizontal?: boolean; note?: string;
  code?: string; fileId?: string; height?: number };
export type Answer = { blockId: string; kind: string; personId: string; who: string; value: Record<string, unknown>; effect: Record<string, unknown> | null; answeredAt: string; mine: boolean };

export const BLOCK_MENU: { kind: BlockKind; label: string; hint: string; icon: typeof Check }[] = [
  { kind: "approval", label: "Approve or decline", hint: "Ask for a yes or no", icon: ThumbsUp },
  { kind: "checklist", label: "Checklist to tick", hint: "Each person ticks their own", icon: ListTodo },
  { kind: "form", label: "Questions (form)", hint: "Collect answers", icon: ClipboardList },
  { kind: "actions", label: "Action list", hint: "Rows to mark done, later or ask", icon: CheckCircle2 },
  { kind: "quote", label: "Quote card", hint: "Words someone said", icon: MessageSquareQuote },
  { kind: "timeline", label: "Timeline", hint: "Dates and steps", icon: Clock },
];

const newId = () => `b_${Math.random().toString(36).slice(2, 12)}`;
/** A new block of a kind, with example words to replace. */
export function starterBlock(kind: BlockKind): Block {
  const id = newId();
  switch (kind) {
    case "approval": return { kind, id, question: "Do you approve this?" };
    case "checklist": return { kind, id, title: "Checklist", items: ["First thing", "Second thing"] };
    case "form": return { kind, id, title: "A few questions", fields: [{ label: "Your name", type: "text" }, { label: "How many?", type: "number" }] };
    case "actions": return { kind, id, title: "Actions", rows: ["Send the draft", "Book the meeting"] };
    case "quote": return { kind, id, text: "Write the words here.", who: "Who said it", role: "" };
    case "chart": return { kind, id, type: "bar", title: "Chart", unit: "", columns: ["Name", "Value"], rows: [["This month", 12], ["Last month", 8]] };
    case "timeline": return { kind, id, title: "Timeline", steps: [{ date: "Mon", text: "Start", done: true }, { date: "Fri", text: "Finish", done: false }] };
    case "diagram": return { kind, id, title: "", code: "flowchart TD\n  A[Start] --> B[Done]" };
    case "html": return { kind, id, title: "Web page" };
    case "stat": return { kind, id, title: "", items: [{ value: "0", label: "What it is", delta: "", tone: "neutral" }] };
  }
}

/** Where blocks live: the doc (for answers), everyone's answers, and whether this viewer may answer. */
export const BlockHost = createContext<{ docId: string | null; answers: Answer[]; onAnswers: (a: Answer[]) => void; canAnswer: boolean }>({
  docId: null, answers: [], onAnswers: () => {}, canAnswer: false });

const at = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); };
const KIND_WORD: Record<BlockKind, string> = { approval: "Approval", checklist: "Checklist", form: "Questions", actions: "Action list", quote: "Quote", chart: "Chart", timeline: "Timeline",
  diagram: "Diagram", html: "Web page", stat: "Big numbers" };
/** A checklist's items and an action list's rows as words (a chart's rows and big numbers' items are other shapes). */
const textItems = (b: Block) => (b.items ?? []).map((x) => typeof x === "string" ? x : x.value);
const rowWords = (b: Block) => (b.rows ?? []).map((r) => typeof r === "string" ? r : Array.isArray(r) ? String(r[0] ?? "") : r.label);
/** Blocks just added from Insert or "/" open in their editor. */
const FRESH = new Set<string>();
export const markFresh = (id: string) => { FRESH.add(id); };

function useAnswer(block: Block) {
  const host = useContext(BlockHost);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = host.answers.find((a) => a.blockId === block.id && a.mine) ?? null;
  const all = host.answers.filter((a) => a.blockId === block.id);
  async function send(value: Record<string, unknown>) {
    if (!host.docId) return;
    setBusy(true); setError(null);
    try { const r = await post<{ answers: Answer[] }>(`docs/${host.docId}/blocks/${block.id}`, value); host.onAnswers(r.answers); }
    catch (e) { setError(e instanceof Error ? e.message : "That did not save. Try again."); }
    finally { setBusy(false); }
  }
  return { mine, all, send, busy, error, canAnswer: host.canAnswer && !!host.docId };
}

// ------------------------------------------------------------------------------------------------ the cards
/** What a web page block needs from the doc around it: may this person change it, the doc, and how to swap or replace it. */
export type PageHooks = { canEdit: boolean; docId: string | null; onReplace: (fileId: string) => void; onConvert: (html: string) => void };
export function BlockCard({ block, page }: { block: Block; page?: PageHooks }) {
  switch (block.kind) {
    case "diagram": return <div className={css.card} data-kind="diagram" data-print=""><DiagramView code={block.code ?? ""} title={block.title} /></div>;
    case "html": return <PageView block={block as PageBlock} canEdit={page?.canEdit ?? false} docId={page?.docId ?? null} onReplace={page?.onReplace ?? (() => {})} onConvert={page?.onConvert ?? (() => {})} />;
    case "stat": return <div data-print=""><StatView block={block as StatBlock} /></div>;
    case "approval": return <Approval block={block} />;
    case "checklist": return <Checklist block={block} />;
    case "form": return <Form block={block} />;
    case "actions": return <Actions block={block} />;
    case "quote": return <figure className={css.quote}><blockquote>“{block.text}”</blockquote>{block.who ? <figcaption>{block.who}{block.role ? <span> · {block.role}</span> : null}</figcaption> : null}</figure>;
    case "chart": return <div className={css.card} data-kind="chart" data-print=""><DocChart block={block as ChartBlock} /></div>;
    case "timeline": return <Timeline block={block} />;
  }
}

const DECIDED: Record<string, string> = { approved: "Approved", declined: "Declined", changes: "Asked for changes" };
function Approval({ block }: { block: Block }) {
  const a = useAnswer(block);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState<null | "declined" | "changes">(null);
  const decision = a.mine?.value.decision as string | undefined;
  const effect = a.all.find((x) => x.effect && (x.effect as { taskId?: string }).taskId)?.effect as { taskId?: string; created?: boolean; done?: boolean; error?: string } | undefined;
  return <div className={css.card} data-kind="approval" data-state={decision}>
    <p className={css.question}>{block.question}</p>
    {block.onApprove?.createTask ? <p className={css.small}>Approving makes the task “{block.onApprove.createTask}”.</p> : block.onApprove?.taskId ? <p className={css.small}>Approving finishes the linked task.</p> : null}
    {decision && !asking ? <p className={css.stamp} data-state={decision}><Check size={16} aria-hidden="true" />{DECIDED[decision]} by you, {at(a.mine!.answeredAt)}
      {a.canAnswer ? <button type="button" className={css.link} onClick={() => setAsking("changes")}>Change</button> : null}</p> : null}
    {a.canAnswer && (!decision || asking) ? <>
      {asking ? <label className={css.field}>{asking === "declined" ? "Why not? (optional)" : "What should change?"}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} /></label> : null}
      <div className={css.row}>
        <button type="button" className={`${css.btn} ${css.yes}`} disabled={a.busy} onClick={() => { void a.send({ decision: "approved", note }); setAsking(null); }}><ThumbsUp size={16} aria-hidden="true" />Approve</button>
        {asking ? <button type="button" className={css.btn} disabled={a.busy || (asking === "changes" && !note.trim())} onClick={() => { void a.send({ decision: asking, note }); setAsking(null); }}>
          {asking === "declined" ? "Decline" : "Ask for changes"}</button>
          : <>
            <button type="button" className={css.btn} disabled={a.busy} onClick={() => setAsking("changes")}><Pencil size={16} aria-hidden="true" />Ask for changes</button>
            <button type="button" className={`${css.btn} ${css.quiet}`} disabled={a.busy} onClick={() => setAsking("declined")}><X size={16} aria-hidden="true" />Decline</button>
          </>}
      </div>
    </> : null}
    {effect?.taskId ? <p className={css.small}><a href={`/tasks/${effect.taskId}`}>{effect.created ? "Task made from this approval" : "The linked task"} →</a></p> : effect?.error ? <p className={css.error}>{effect.error}</p> : null}
    {a.all.filter((x) => !x.mine).length ? <ul className={css.people}>{a.all.filter((x) => !x.mine).map((x) => <li key={x.personId} data-state={String(x.value.decision)}>
      <strong>{x.who}</strong> {DECIDED[String(x.value.decision)]?.toLowerCase()}, {at(x.answeredAt)}{x.value.note ? <q>{String(x.value.note)}</q> : null}</li>)}</ul> : null}
    {a.error ? <p className={css.error} role="alert">{a.error}</p> : null}
  </div>;
}

function Checklist({ block }: { block: Block }) {
  const a = useAnswer(block);
  const items = textItems(block);
  const done = new Set(((a.mine?.value.done as number[]) ?? []));
  const others = a.all.filter((x) => !x.mine);
  const toggle = (i: number) => { const next = new Set(done); if (next.has(i)) next.delete(i); else next.add(i); void a.send({ done: [...next].sort((x, y) => x - y) }); };
  return <div className={css.card} data-kind="checklist">
    {block.title ? <p className={css.title}>{block.title}<span className={css.count}>{done.size} of {items.length} done</span></p> : null}
    <ul className={css.checks}>{items.map((it, i) => <li key={i}><label>
      <input type="checkbox" checked={done.has(i)} disabled={!a.canAnswer || a.busy} onChange={() => toggle(i)} /><span data-done={done.has(i) ? "1" : undefined}>{it}</span></label></li>)}</ul>
    {others.length ? <p className={css.small}>{others.map((x) => `${x.who}: ${((x.value.done as number[]) ?? []).length} of ${items.length}`).join(" · ")}</p> : null}
    {a.error ? <p className={css.error} role="alert">{a.error}</p> : null}
  </div>;
}

function Form({ block }: { block: Block }) {
  const a = useAnswer(block);
  const fields = block.fields ?? [];
  const saved = (a.mine?.value.values ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((_, i) => [String(i), saved[String(i)] == null ? "" : String(saved[String(i)])])));
  const [open, setOpen] = useState(!a.mine);
  const others = a.all.filter((x) => !x.mine);
  return <div className={css.card} data-kind="form">
    {block.title ? <p className={css.title}>{block.title}</p> : null}
    {a.mine && !open ? <p className={css.stamp} data-state="approved"><Check size={16} aria-hidden="true" />Your answers are saved, {at(a.mine.answeredAt)}
      {a.canAnswer ? <button type="button" className={css.link} onClick={() => setOpen(true)}>Change</button> : null}</p>
      : <form className={css.form} onSubmit={(e) => { e.preventDefault(); void a.send({ values }).then(() => setOpen(false)); }}>
        {fields.map((f, i) => <label key={i} className={css.field}>{f.label}
          {f.type === "long" ? <textarea rows={3} value={values[String(i)] ?? ""} disabled={!a.canAnswer} onChange={(e) => setValues((v) => ({ ...v, [String(i)]: e.target.value }))} />
            : f.type === "choice" ? <select value={values[String(i)] ?? ""} disabled={!a.canAnswer} onChange={(e) => setValues((v) => ({ ...v, [String(i)]: e.target.value }))}>
              <option value="">Choose…</option>{(f.options ?? []).map((o) => <option key={o}>{o}</option>)}</select>
              : <input type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={values[String(i)] ?? ""} disabled={!a.canAnswer}
                onChange={(e) => setValues((v) => ({ ...v, [String(i)]: e.target.value }))} />}
        </label>)}
        {a.canAnswer ? <button type="submit" className={`${css.btn} ${css.yes}`} disabled={a.busy}>{a.busy ? "Sending…" : "Send answers"}</button> : null}
      </form>}
    {others.length ? <details className={css.answers}><summary>{others.length} other {others.length === 1 ? "answer" : "answers"}</summary>
      <div className={css.tableWrap}><table><thead><tr><th>Who</th>{fields.map((f, i) => <th key={i}>{f.label}</th>)}</tr></thead>
        <tbody>{others.map((x) => <tr key={x.personId}><td>{x.who}</td>{fields.map((_, i) => <td key={i}>{String(((x.value.values ?? {}) as Record<string, unknown>)[String(i)] ?? "")}</td>)}</tr>)}</tbody></table></div>
    </details> : null}
    {a.error ? <p className={css.error} role="alert">{a.error}</p> : null}
  </div>;
}

const MARKS = [["done", "Done", Check], ["later", "Later", Clock], ["question", "Question", CircleHelp]] as const;
function Actions({ block }: { block: Block }) {
  const a = useAnswer(block);
  const rows = rowWords(block);
  const mine = (a.mine?.value.marks ?? {}) as Record<string, string>;
  const tally = (i: number) => a.all.filter((x) => !x.mine && ((x.value.marks ?? {}) as Record<string, string>)[String(i)]).map((x) => `${x.who}: ${((x.value.marks ?? {}) as Record<string, string>)[String(i)]}`);
  return <div className={css.card} data-kind="actions">
    {block.title ? <p className={css.title}>{block.title}</p> : null}
    <ul className={css.actions}>{rows.map((r, i) => <li key={i} data-mark={mine[String(i)]}>
      <span className={css.rowText}>{r}{tally(i).length ? <small>{tally(i).join(" · ")}</small> : null}</span>
      <span className={css.row} role="group" aria-label={`Mark “${r}”`}>{MARKS.map(([k, label, I]) => <button key={k} type="button" className={`${css.btn} ${css.tiny}`} aria-pressed={mine[String(i)] === k}
        disabled={!a.canAnswer || a.busy} onClick={() => void a.send({ marks: { ...mine, [String(i)]: k } })}><I size={14} aria-hidden="true" />{label}</button>)}</span>
    </li>)}</ul>
    {a.error ? <p className={css.error} role="alert">{a.error}</p> : null}
  </div>;
}

function Timeline({ block }: { block: Block }) {
  const steps = block.steps ?? [];
  return <div className={css.card} data-kind="timeline">
    {block.title ? <p className={css.title}>{block.title}</p> : null}
    <ol className={css.timeline}>{steps.map((s, i) => <li key={i} data-done={s.done ? "1" : undefined}>
      <span className={css.dot} aria-hidden="true">{s.done ? <Check size={12} /> : null}</span>
      <span className={css.when}>{s.date}</span><span>{s.text}{s.done ? <span className={css.srOnly}> (done)</span> : null}</span></li>)}</ol>
  </div>;
}

// ------------------------------------------------------------------------------------------------ editing a block
/** Plain fields for the doc's writer: one line per item, never JSON. */
function BlockEditor({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  const lines = (v: string) => v.split("\n").map((s) => s.trim()).filter(Boolean);
  const set = (part: Partial<Block>) => onChange({ ...block, ...part });
  const title = <label className={css.field}>Title<input value={block.title ?? ""} onChange={(e) => set({ title: e.target.value })} maxLength={120} /></label>;
  switch (block.kind) {
    case "approval": return <div className={css.form}>
      <label className={css.field}>Question<input value={block.question ?? ""} onChange={(e) => set({ question: e.target.value })} maxLength={300} /></label>
      <label className={css.field}>When someone approves, make this task (leave empty for none)
        <input value={block.onApprove?.createTask ?? ""} onChange={(e) => set({ onApprove: e.target.value.trim() ? { createTask: e.target.value } : undefined })} maxLength={200} placeholder="e.g. Book the venue" /></label>
    </div>;
    case "checklist": return <div className={css.form}>{title}<label className={css.field}>One item per line
      <textarea rows={4} defaultValue={textItems(block).join("\n")} onChange={(e) => set({ items: lines(e.target.value) })} /></label></div>;
    case "actions": return <div className={css.form}>{title}<label className={css.field}>One row per line
      <textarea rows={4} defaultValue={rowWords(block).join("\n")} onChange={(e) => set({ rows: lines(e.target.value) })} /></label></div>;
    case "form": return <div className={css.form}>{title}<label className={css.field}>One question per line. End it with (number), (date) or (long answer). For a choice, add the options after a colon: Size: S / M / L
      <textarea rows={5} defaultValue={(block.fields ?? []).map((f) => f.type === "choice" ? `${f.label}: ${(f.options ?? []).join(" / ")}` : f.type === "text" ? f.label : `${f.label} (${f.type === "long" ? "long answer" : f.type})`).join("\n")}
        onChange={(e) => set({ fields: lines(e.target.value).map((l): Field => {
          const m = l.match(/^(.*?)\s*\((number|date|long answer)\)$/i);
          if (m) return { label: m[1], type: m[2].toLowerCase() === "long answer" ? "long" : m[2].toLowerCase() as Field["type"] };
          const c = l.match(/^(.*?):\s*(.+\/.+)$/);
          return c ? { label: c[1], type: "choice", options: c[2].split("/").map((o) => o.trim()).filter(Boolean) } : { label: l, type: "text" };
        }) })} /></label></div>;
    case "quote": return <div className={css.form}>
      <label className={css.field}>The words<textarea rows={3} value={block.text ?? ""} onChange={(e) => set({ text: e.target.value })} maxLength={600} /></label>
      <label className={css.field}>Who said it<input value={block.who ?? ""} onChange={(e) => set({ who: e.target.value })} maxLength={80} /></label>
      <label className={css.field}>Their role (optional)<input value={block.role ?? ""} onChange={(e) => set({ role: e.target.value })} maxLength={80} /></label></div>;
    case "chart": return <ChartEditor block={block as ChartBlock} onChange={(b) => onChange(b as Block)} />;
    case "diagram": return <DiagramEditor block={block as DiagramBlock} onChange={(b) => onChange(b as Block)} />;
    case "stat": return <StatEditor block={block as StatBlock} onChange={(b) => onChange(b as Block)} />;
    case "html": return null;
    case "timeline": return <div className={css.form}>{title}
      <label className={css.field}>One step per line: date – what happens. Start a line with * when it is done.
        <textarea rows={4} defaultValue={(block.steps ?? []).map((s) => `${s.done ? "* " : ""}${s.date} – ${s.text}`).join("\n")}
          onChange={(e) => set({ steps: lines(e.target.value).map((l) => { const done = l.startsWith("*"); const t = l.replace(/^\*\s*/, ""); const m = t.match(/^(.*?)\s+[–-]\s+(.*)$/); return { date: m ? m[1] : "", text: m ? m[2] : t, done }; }) })} /></label></div>;
  }
}

function BlockNodeView({ node, updateAttributes, deleteNode, editor, selected, getPos }: NodeViewProps) {
  const block = node.attrs.block as Block | null;
  const [editing, setEditing] = useState(() => !!block && FRESH.has(block.id) && block.kind !== "html");
  const host = useContext(BlockHost);
  const freshId = block?.id;
  useEffect(() => { if (freshId) FRESH.delete(freshId); }, [freshId]);
  if (!block) return <NodeViewWrapper />;
  // DOCS-RICH: a web page swaps to a new file (Edit code) or into the doc's own blocks (Turn into doc blocks).
  const page: PageHooks = { canEdit: editor.isEditable, docId: host.docId,
    onReplace: (fileId) => updateAttributes({ block: { ...block, fileId } }),
    onConvert: (html) => { const at = typeof getPos === "function" ? getPos() : undefined; if (typeof at === "number") editor.chain().focus().insertContentAt({ from: at, to: at + node.nodeSize }, html).run(); } };
  return <NodeViewWrapper className={css.node} data-selected={selected ? "1" : undefined} data-drag-handle="" data-block-id={block.id} data-block-kind={block.kind}>
    {editor.isEditable ? <div className={css.nodeBar} contentEditable={false} data-no-print="">
      <span>{KIND_WORD[block.kind]}</span>
      {block.kind !== "html" ? <button type="button" className={`${css.btn} ${css.tiny} ${editing ? css.yes : css.quiet}`} onClick={() => setEditing((e) => !e)} aria-pressed={editing}><Pencil size={14} aria-hidden="true" />{editing ? "Done" : "Edit"}</button> : null}
      <button type="button" className={`${css.btn} ${css.tiny} ${css.quiet}`} onClick={() => deleteNode()} aria-label={`Remove this ${KIND_WORD[block.kind].toLowerCase()}`}><Trash2 size={14} aria-hidden="true" /></button>
    </div> : null}
    <div contentEditable={false}>
      {editing ? <BlockEditor block={block} onChange={(b) => updateAttributes({ block: b })} /> : <BlockCard block={block} page={page} />}
    </div>
  </NodeViewWrapper>;
}

/** The TipTap node: `<div data-type="pulse-block" data-kind data-id data-block='{json}'>` (the API checks the JSON again). */
export const PulseBlock = Node.create({
  name: "pulseBlock", group: "block", atom: true, draggable: true, selectable: true,
  addAttributes() {
    return { block: { default: null,
      parseHTML: (el: HTMLElement) => { try { return JSON.parse(el.getAttribute("data-block") ?? "null"); } catch { return null; } },
      renderHTML: (a: { block?: Block | null }) => a.block ? { "data-block": JSON.stringify(a.block), "data-kind": a.block.kind, "data-id": a.block.id } : {} } };
  },
  parseHTML() { return [{ tag: 'div[data-type="pulse-block"]' }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { "data-type": "pulse-block" })]; },
  addNodeView() { return ReactNodeViewRenderer(BlockNodeView); },
});
