"use client";
// TASK-MERGE: the merge story's moving parts. The originals slide in on the left, their lines draw into the merged task,
// which lands last (about a second in all, once; nothing moves for people who ask for reduced motion). The lineage is a
// small left-to-right graph: earlier merges, the originals, the merged task, and a later merge if there is one.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";
import { Undo2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../../../records";
import { styles } from "../../../ui";
import { STATUS } from "../../parts";
import css from "../../merge/merge.module.css";

type Node = { key: string; id: string; title: string; status: string; role: "source" | "target" | "earlier" | "later"; mergeId: string | null };
type Edge = { from: string; to: string; mergeId: string };
export type Story = {
  merge: { id: string; title: string; reason: string | null; shape: "task" | "brief"; method: string; createdAt: string; createdBy: string | null; undoneAt: string | null; undoneBy: string | null;
    canUndo: boolean; suggestedReason: string | null; targetId: string };
  target: { id: string; title: string; status: string; personName: string | null; projectName: string | null; dueOn: string | null } | null;
  sources: { id: string; position: number; title: string; statusBefore: string; statusNow: string | null; dueOn: string | null; personName: string | null; projectName: string | null }[];
  moved: Record<string, number>;
  graph: { nodes: Node[]; edges: Edge[] };
};
const label = (s: string | null | undefined) => s === "merged" ? "Merged" : STATUS[s ?? ""]?.label ?? s ?? "";
const vars = (x: Record<string, number>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [`--${k}`, v])) as CSSProperties;

export function MergeFlow({ d, fresh }: { d: Story; fresh: boolean }) {
  const n = d.sources.length, t = d.target;
  // Curves from each original's middle into the merged task's middle (percent of the flow column's box).
  return <div className={css.story} data-fresh={fresh ? "" : undefined} aria-label={`${n} tasks merged into one`}>
    <ol className={css.sources}>{d.sources.map((s, i) => <li key={s.id} className={css.source} style={vars({ i })}>
      <Link href={`/tasks/${s.id}`}>{s.title}</Link>
      <small>{[label(s.statusBefore), s.personName, s.projectName, s.dueOn ? `due ${s.dueOn}` : null].filter(Boolean).join(" · ")}</small></li>)}</ol>
    <div className={css.flow} aria-hidden="true"><svg viewBox="0 0 64 100" preserveAspectRatio="none">
      {d.sources.map((s, i) => { const y = ((i + 0.5) / n) * 100; return <path key={s.id} className={css.flowPath} style={vars({ i })} d={`M0 ${y} C 32 ${y}, 32 50, 64 50`} vectorEffect="non-scaling-stroke" />; })}
    </svg></div>
    <div className={css.target} style={vars({ n })}>
      <small className={css.kind}>{d.merge.shape === "brief" ? "Brief" : "Merged task"}</small>
      <h2>{t ? <Link href={`/tasks/${t.id}`}>{t.title}</Link> : d.merge.title}</h2>
      {t ? <p>{[label(t.status), t.personName, t.projectName, t.dueOn ? `due ${t.dueOn}` : null].filter(Boolean).join(" · ")}</p> : null}
    </div>
  </div>;
}

const W = 210, H = 46, GX = 56, GY = 12, PAD = 8;
export function Lineage({ graph }: { graph: Story["graph"] }) {
  // Columns: the merged task on the right of its originals, each earlier merge's originals one column further left.
  const into = new Map<string, string[]>(); for (const e of graph.edges) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  const target = graph.nodes.find((x) => x.role === "target"); if (!target) return null;
  const col = new Map<string, number>([[target.key, 0]]); let frontier = [target.key];
  while (frontier.length) { const next: string[] = []; for (const k of frontier) for (const f of into.get(k) ?? []) if (!col.has(f)) { col.set(f, col.get(k)! - 1); next.push(f); } frontier = next; }
  for (const x of graph.nodes) if (x.role === "later") col.set(x.key, 1);
  const min = Math.min(...col.values()), max = Math.max(...col.values());
  const byCol = new Map<number, Node[]>(); for (const x of graph.nodes) if (col.has(x.key)) byCol.set(col.get(x.key)!, [...(byCol.get(col.get(x.key)!) ?? []), x]);
  const rows = Math.max(...[...byCol.values()].map((c) => c.length));
  const height = rows * (H + GY) - GY + PAD * 2, width = (max - min + 1) * (W + GX) - GX + PAD * 2;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [c, xs] of byCol) { const top = (height - (xs.length * (H + GY) - GY)) / 2; xs.forEach((x, i) => pos.set(x.key, { x: PAD + (c - min) * (W + GX), y: top + i * (H + GY) })); }
  const cut = (s: string) => s.length > 30 ? `${s.slice(0, 29)}…` : s;
  return <div className={css.lineage}><svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Lineage of ${graph.nodes.length} tasks`}>
    {graph.edges.map((e) => { const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return null;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
      return <path key={`${e.from}-${e.to}`} className={css.lnEdge} d={`M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} />; })}
    {graph.nodes.map((x) => { const p = pos.get(x.key); if (!p) return null;
      const href = x.role === "earlier" || x.role === "later" ? `/tasks/merges/${x.mergeId}` : `/tasks/${x.id}`;
      return <a key={x.key} href={href} className={css.lnLink}><title>{x.title}</title>
        <rect className={x.role === "target" ? css.lnTarget : css.lnNode} x={p.x} y={p.y} width={W} height={H} rx={10} />
        <text className={css.lnText} x={p.x + 10} y={p.y + 19}>{cut(x.title)}</text>
        <text className={css.lnMuted} x={p.x + 10} y={p.y + 35}>{x.role === "target" ? "Merged task" : x.role === "later" ? "Merged again later" : x.role === "earlier" ? "From an earlier merge" : label(x.status)}</text>
      </a>; })}
  </svg></div>;
}

export function UndoMerge({ id, count }: { id: string; count: number }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  async function undo() {
    setBusy(true);
    try { const r = await post<{ reopened: number }>(`merges/${id}/undo`); notify({ id: "merge-undo", tone: "success", title: `${r.reopened} opened again`, timeout: 3500 }); setOpen(false); router.refresh(); }
    catch (e) { notify({ id: "merge-undo", tone: "error", title: "Not undone", message: e instanceof Error ? e.message : "Try again" }); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={styles.btn} onClick={() => setOpen(true)}><Undo2 size={14} aria-hidden="true" />Undo merge</button>
    {open ? <Modal title="Undo this merge?" sub={`The ${count} originals open again in the status they had. Links, proof and ticked steps stay on the merged task.`} onClose={() => setOpen(false)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Keep it</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void undo()}>Undo merge</button></div>}><span /></Modal> : null}
  </>;
}
