"use client";
// BLOCKERS-MAP (7 Nov 2026): the dependency map. Tasks, projects and goals as cards; what blocks sits on the left and
// what it unlocks to the right (a layered left-to-right layout from dagre, drawn with React Flow; both MIT, see
// THIRD_PARTY.md). Patterns borrowed: GitLab's pipeline graph (hover a card to light its whole chain, dim the rest),
// Nx's project graph (focus one item: "what's blocking it"), Dagster/Airflow (status rail on each card), the React Flow
// dagre example (lay out, then render). The critical path, the longest chain of unfinished work, glows.
import { EmptyState } from "../../kit/game";
import "@xyflow/react/dist/base.css";
import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import { Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeProps } from "@xyflow/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Check, Crosshair, Flame, FolderKanban, Hourglass, ListChecks, Play, Target, X } from "lucide-react";
import { Combobox } from "../../kit";
import { useWords } from "../../org-code";
import { post } from "../../orgs/client";
import { criticalPath, focusSet, readyNow, waitingCounts } from "../../lib/dep-graph.mjs";
import css from "./graph.module.css";

export type DepKind = "task" | "project" | "goal";
export type DepState = "done" | "active" | "blocked" | "open";
export type DepNode = { key: string; kind: DepKind; id: string; title: string; status: string; state: DepState; personName: string | null;
  dueOn: string | null; late: boolean; href: string; context: string | null; minutes: number };
export type DepEdge = { id: string; from: string; to: string; type: "blocks" | "feeds"; table: "task" | "work" | "goal"; done: boolean; note: string | null };
export type DepGraphData = { nodes: DepNode[]; edges: DepEdge[]; today: string; me: string | null; scope: string; id: string | null; title: string;
  projects: { id: string; title: string; links: number }[]; goals: { id: string; title: string }[] };
type Mode = "up" | "down" | "both";
type CardData = DepNode & { critical: boolean; dim: boolean; lit: boolean; focus: boolean; waits: number; ready: boolean; kindWord: string; onFocus: (k: string) => void };

const W = 252, H = 104;
const PALETTE = ["open", "active", "blocked", "done", "critical", "feeds"] as const;
/** SVG arrowheads take a plain colour, not a CSS variable: read the theme's values off the map (again when the theme changes). */
function usePalette(ref: RefObject<HTMLDivElement | null>) {
  const [pal, setPal] = useState<Record<string, string>>({ open: "#9a9cb3", active: "#5b45d6", blocked: "#c24848", done: "#2f8a64", critical: "#c026d3", feeds: "#a99cff" });
  useEffect(() => {
    const read = () => { const el = ref.current; if (!el) return; const cs = getComputedStyle(el); const next: Record<string, string> = {};
      for (const k of PALETTE) next[k] = cs.getPropertyValue(`--dep-${k}`).trim() || "#9a9cb3"; setPal(next); };
    const raf = window.requestAnimationFrame(read);
    const mo = new MutationObserver(read); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)"); mq.addEventListener("change", read);
    return () => { window.cancelAnimationFrame(raf); mo.disconnect(); mq.removeEventListener("change", read); };
  }, [ref]);
  return pal;
}
const STATE_WORD: Record<DepState, string> = { done: "Done", active: "In progress", blocked: "Blocked", open: "Not started" };
const MODE_WORD: Record<Mode, string> = { up: "What’s blocking it", down: "What it unblocks", both: "Both ways" };

/** Left-to-right layers (dagre's network-simplex ranking and crossing reduction). */
function layout(nodes: DepNode[], edges: DepEdge[]) {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 26, ranksep: 92, edgesep: 14, marginx: 24, marginy: 24, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.key, { width: W, height: H });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagreLayout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) { const p = g.node(n.key); pos.set(n.key, { x: (p?.x ?? 0) - W / 2, y: (p?.y ?? 0) - H / 2 }); }
  return pos;
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
const shortDate = (d: string) => { const [y, m, day] = d.split("-").map(Number); return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }); };

const KindIcon = ({ kind }: { kind: DepKind }) => kind === "goal" ? <Target size={13} aria-hidden="true" /> : kind === "project" ? <FolderKanban size={13} aria-hidden="true" /> : <ListChecks size={13} aria-hidden="true" />;
const StateIcon = ({ state }: { state: DepState }) => state === "done" ? <Check size={11} aria-hidden="true" /> : state === "blocked" ? <Hourglass size={11} aria-hidden="true" /> : state === "active" ? <Play size={10} aria-hidden="true" /> : null;

const Card = memo(function Card({ data }: NodeProps<Node<CardData>>) {
  const d = data;
  return <div className={css.card} data-state={d.state} data-kind={d.kind} data-critical={d.critical ? "" : undefined} data-dim={d.dim ? "" : undefined}
    data-lit={d.lit ? "" : undefined} data-focus={d.focus ? "" : undefined} title={d.title}>
    <Handle type="target" position={Position.Left} className={css.handle} isConnectable={false} />
    <div className={css.top}>
      <span className={css.kind}><KindIcon kind={d.kind} />{d.kindWord}</span>
      {d.critical ? <span className={css.crit} title="On the critical path"><Flame size={11} aria-hidden="true" />Critical</span> : null}
      <span className={css.pill} data-state={d.state}><StateIcon state={d.state} />{d.ready ? "Ready" : STATE_WORD[d.state]}</span>
    </div>
    <Link className={css.title} href={d.href} prefetch={false} aria-label={`${d.title}: ${STATE_WORD[d.state]}. Open`}>{d.title}</Link>
    <div className={css.meta}>
      {d.personName ? <span className={css.who}><i aria-hidden="true">{initials(d.personName)}</i>{d.personName.split(" ")[0]}</span> : <span className={css.who} data-none="">No owner</span>}
      {d.waits ? <span className={css.waits}>waits on {d.waits}</span> : d.context ? <span className={css.ctx}>{d.context}</span> : null}
      {d.dueOn ? <span className={css.due} data-late={d.late ? "" : undefined} data-done={d.state === "done" ? "" : undefined}>{shortDate(d.dueOn)}</span> : null}
      <button type="button" className={`${css.focusBtn} nodrag nopan`} aria-label={`What’s blocking “${d.title}”`} title="What’s blocking this"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); d.onFocus(d.key); }}><Crosshair size={13} aria-hidden="true" /></button>
    </div>
    <Handle type="source" position={Position.Right} className={css.handle} isConnectable={false} />
  </div>;
});
const nodeTypes = { card: Card };

const PHONE = "(max-width: 639px)";
const phoneSubscribe = (cb: () => void) => { const m = matchMedia(PHONE); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };

function Graph({ data, initialFocus, initialMode }: { data: DepGraphData; initialFocus: string | null; initialMode: Mode }) {
  const phone = useSyncExternalStore(phoneSubscribe, () => matchMedia(PHONE).matches, () => false);
  const words = useWords();
  const router = useRouter();
  const flow = useReactFlow();
  const [focus, setFocus] = useState<string | null>(initialFocus && data.nodes.some((n) => n.key === initialFocus) ? initialFocus : null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [hideDone, setHideDone] = useState(false);
  const [showCritical, setShowCritical] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<DepEdge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const pal = usePalette(shell);
  const kindWord = useCallback((k: DepKind) => k === "goal" ? "Goal" : k === "project" ? words.project : "Task", [words.project]);

  // Keep the address in step with the focus, so "what's blocking X" can be shared as a link.
  useEffect(() => {
    const u = new URL(window.location.href);
    if (focus) { u.searchParams.set("focus", focus); u.searchParams.set("mode", mode); } else { u.searchParams.delete("focus"); u.searchParams.delete("mode"); }
    window.history.replaceState(null, "", u.toString());
  }, [focus, mode]);

  const visible = useMemo(() => {
    const keep = focus ? focusSet(data.edges, focus, mode) : null;
    const nodes = data.nodes.filter((n) => (!keep || keep.has(n.key)) && (!hideDone || n.state !== "done" || n.key === focus));
    const ids = new Set(nodes.map((n) => n.key));
    return { nodes, edges: data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [data, focus, mode, hideDone]);
  const pos = useMemo(() => layout(visible.nodes, visible.edges), [visible]);
  const crit = useMemo(() => criticalPath(visible.nodes, visible.edges), [visible]);
  const ready = useMemo(() => new Set(readyNow(visible.nodes, visible.edges)), [visible]);
  const waits = useMemo(() => waitingCounts(data.edges), [data.edges]);
  const lit = useMemo(() => hover ? focusSet(visible.edges, hover, "both") : null, [hover, visible.edges]);
  const critNodes = useMemo(() => new Set(showCritical ? crit.nodes : []), [crit, showCritical]);
  const critEdges = useMemo(() => new Set(showCritical ? crit.edges : []), [crit, showCritical]);
  const onFocus = useCallback((k: string) => { setFocus(k); setPicked(null); }, []);

  const nodes: Node<CardData>[] = useMemo(() => visible.nodes.map((n) => ({
    id: n.key, type: "card", position: pos.get(n.key) ?? { x: 0, y: 0 }, width: W, height: H, draggable: false, connectable: false,
    data: { ...n, critical: critNodes.has(n.key), dim: !!lit && !lit.has(n.key), lit: !!lit && lit.has(n.key), focus: n.key === focus,
      waits: waits.get(n.key) ?? 0, ready: ready.has(n.key), kindWord: kindWord(n.kind), onFocus },
  })), [visible.nodes, pos, critNodes, lit, focus, waits, ready, kindWord, onFocus]);
  const edges: Edge[] = useMemo(() => visible.edges.map((e) => {
    const critical = critEdges.has(e.id), dim = !!lit && !(lit.has(e.from) && lit.has(e.to));
    const k = critical ? "critical" : e.type === "feeds" ? "feeds" : e.done ? "done" : "open";
    return { id: `${e.table}:${e.id}`, source: e.from, target: e.to, type: "smoothstep", animated: critical, className: `${css.edge} ${dim ? css.edgeDim : ""}`,
      data: { k }, pathOptions: { borderRadius: 14, offset: 18 }, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: pal[k] },
      style: { stroke: `var(--dep-${k})` }, zIndex: critical ? 2 : 1, ariaLabel: e.type === "feeds" ? "Counts towards" : "Blocks" } as Edge;
  }), [visible.edges, critEdges, lit, pal]);

  // Fit the view whenever the set of cards changes (focus, filters), after React Flow has measured them.
  // A big map fitted whole is too small to read: then start readable, at the head of the critical path (else the first card).
  useEffect(() => {
    const t = window.setTimeout(() => void flow.fitView({ padding: 0.14, maxZoom: 1.5 }).then(() => {
      if (flow.getZoom() >= 0.55) return;
      const head = pos.get(crit.nodes[0] ?? visible.nodes[0]?.key ?? "");
      if (head) void flow.setCenter(head.x + W * 1.6, head.y + H / 2, { zoom: 0.72, duration: 350 });
    }), 40);
    return () => window.clearTimeout(t);
  }, [visible, flow, pos, crit]);
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setFocus(null); setPicked(null); } }; window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, []);

  const counts = useMemo(() => { const c: Record<DepState, number> = { done: 0, active: 0, blocked: 0, open: 0 }; for (const n of data.nodes) c[n.state]++; return c; }, [data.nodes]);
  const byKey = useMemo(() => new Map(data.nodes.map((n) => [n.key, n])), [data.nodes]);
  const options = useMemo(() => data.nodes.map((n) => ({ value: n.key, label: n.title, detail: `${kindWord(n.kind)} · ${STATE_WORD[n.state]}`, group: n.state === "done" ? "Done" : "Open" }))
    .sort((a, b) => a.group.localeCompare(b.group) * -1 || a.label.localeCompare(b.label)), [data.nodes, kindWord]);
  const focused = focus ? byKey.get(focus) : null;
  const upCount = focused ? focusSet(data.edges, focused.key, "up").size - 1 : 0;

  async function removeLink(e: DepEdge) {
    setError(null);
    try { await post(`dependencies/${e.id}/remove`, { table: e.table }); setPicked(null); router.refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "That did not work. Try again."); }
  }

  return <div className={css.shell} ref={shell}>
    <div className={css.toolbar}>
      <div className={css.focusBox}>
        <Combobox label="What’s blocking…" placeholder="What’s blocking…" options={options} value={focus} size="sm" searchable searchPlaceholder="Find a task, project or goal"
          icon={<Crosshair size={14} aria-hidden="true" />} onChange={(v) => { setFocus(v); setPicked(null); }} />
        {focus ? <div className={css.seg} role="group" aria-label="Which way">
          {(["up", "down", "both"] as Mode[]).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{MODE_WORD[m]}</button>)}
          <button type="button" className={css.clear} onClick={() => setFocus(null)} aria-label="Show everything"><X size={13} aria-hidden="true" />Clear</button>
        </div> : null}
      </div>
      <div className={css.toggles}>
        <label className={css.toggle}><input type="checkbox" checked={showCritical} onChange={(e) => setShowCritical(e.target.checked)} /><span>Critical path</span></label>
        <label className={css.toggle}><input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /><span>Hide done</span></label>
      </div>
    </div>
    <div className={css.legend} aria-label="Key">
      {(["blocked", "active", "open", "done"] as DepState[]).map((s) => <span key={s} className={css.key} data-state={s}><i aria-hidden="true" />{STATE_WORD[s]} <b>{counts[s]}</b></span>)}
      <span className={css.key} data-k="critical"><i aria-hidden="true" />Critical path{crit.nodes.length ? <b>{crit.nodes.length}</b> : null}</span>
      <span className={css.key} data-k="feeds"><i aria-hidden="true" />Counts towards a goal</span>
    </div>
    {focused ? <p className={css.focusLine} role="status"><Crosshair size={14} aria-hidden="true" />
      {mode === "down" ? <>Showing what <b>“{focused.title}”</b> unblocks.</> : upCount ? <>{upCount === 1 ? "1 piece of work stands" : `${upCount} pieces of work stand`} in front of <b>“{focused.title}”</b>.</>
        : <>Nothing is blocking <b>“{focused.title}”</b>.</>}
      <Link href={focused.href}>Open it</Link></p> : null}
    <div className={css.canvas}>
      {visible.nodes.length ? <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.14, maxZoom: 1.5 }} minZoom={0.12} maxZoom={1.8}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable edgesFocusable={false} panOnScroll={false} zoomOnPinch panOnDrag proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={(_, n) => setHover(n.id)} onNodeMouseLeave={() => setHover(null)}
        onNodeClick={(ev, n) => { if ((ev.target as HTMLElement).closest("button")) return; ev.preventDefault(); const d = byKey.get(n.id); if (d) router.push(d.href); }}
        onEdgeClick={(_, e) => { const d = data.edges.find((x) => `${x.table}:${x.id}` === e.id); setPicked(d && d.type === "blocks" ? d : null); }}
        onPaneClick={() => setPicked(null)} aria-label="Dependency map">
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} className={css.bg} />
        <Controls showInteractive={false} position="bottom-left" className={css.controls} />
        <MiniMap pannable zoomable position="bottom-right" className={css.minimap} nodeBorderRadius={8} maskColor="var(--dep-mask)"
          nodeColor={(n) => pal[(n.data as CardData).critical ? "critical" : (n.data as CardData).state === "active" ? "active" : (n.data as CardData).state] ?? pal.open} />
      </ReactFlow> : <div className={css.empty}><EmptyState art={data.nodes.length ? "done" : "connect"} title={data.nodes.length ? "Everything here is done" : "No links yet"}
        text={data.nodes.length ? "Untick “Hide done” to see the finished work." : "Press Link work at the top to make one piece of work wait on another. The map then draws itself: what blocks on the left, what it unlocks on the right."} /></div>}
      {picked ? <div className={css.edgeBar} role="dialog" aria-label="Link">
        <span><b>“{byKey.get(picked.to)?.title}”</b> waits on <b>“{byKey.get(picked.from)?.title}”</b>{picked.note ? <> · {picked.note}</> : null}</span>
        <button type="button" onClick={() => void removeLink(picked)}>Take this link off</button>
        <button type="button" className={css.quiet} onClick={() => setPicked(null)} aria-label="Close"><X size={14} aria-hidden="true" /></button>
        {error ? <em role="alert">{error}</em> : null}
      </div> : null}
    </div>
    {/* UX-GAMIFY: on a phone the list opens by itself (the map's cards are too small to read there). */}
    <details className={css.list} open={phone || undefined}>
      <summary>The same as a list</summary>
      <ul>{data.edges.filter((e) => e.type === "blocks").map((e) => <li key={`${e.table}:${e.id}`}><Link href={byKey.get(e.to)?.href ?? "#"} prefetch={false}>{byKey.get(e.to)?.title}</Link> waits on <Link href={byKey.get(e.from)?.href ?? "#"} prefetch={false}>{byKey.get(e.from)?.title}</Link>{e.done ? " (finished)" : ""}</li>)}</ul>
    </details>
  </div>;
}

export function DependencyGraph(p: { data: DepGraphData; initialFocus: string | null; initialMode: Mode }) {
  return <ReactFlowProvider><Graph {...p} /></ReactFlowProvider>;
}

/** Link work: make one task, project or goal wait on another. */
export function LinkWork({ data }: { data: DepGraphData }) {
  const words = useWords();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [waiter, setWaiter] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => {
    const seen = new Set<string>(); const out: { value: string; label: string; detail?: string; group: string }[] = [];
    const add = (value: string, label: string, group: string, detail?: string) => { if (!seen.has(value)) { seen.add(value); out.push({ value, label, group, detail }); } };
    for (const n of data.nodes) if (n.state !== "done") add(n.key, n.title, "On this map", n.kind === "task" ? "Task" : n.kind === "goal" ? "Goal" : words.project);
    for (const p of data.projects) add(`project:${p.id}`, p.title, words.projects);
    for (const g of data.goals) add(`goal:${g.id}`, g.title, "Goals");
    return out;
  }, [data, words.project, words.projects]);
  async function save() {
    if (!waiter || !blocker) return;
    const [wk, wid] = waiter.split(":"), [bk, bid] = blocker.split(":");
    setBusy(true); setError(null);
    try { await post("dependencies", { waiterKind: wk, waiterId: wid, blockerKind: bk, blockerId: bid }); setOpen(false); setWaiter(null); setBlocker(null); router.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); } finally { setBusy(false); }
  }
  if (!data.me) return null;
  if (!open) return <button type="button" className={css.linkBtn} onClick={() => setOpen(true)}>Link work</button>;
  return <div className={css.linkPanel} role="group" aria-label="Link work">
    <Combobox label="This" placeholder="This work…" options={options} value={waiter} size="sm" searchable searchPlaceholder="Find work" onChange={(v) => setWaiter(v)} />
    <span className={css.linkWord}>waits on</span>
    <Combobox label="Waits on" placeholder="…this work" options={options.filter((o) => o.value !== waiter)} value={blocker} size="sm" searchable searchPlaceholder="Find work" onChange={(v) => setBlocker(v)} />
    <button type="button" className={css.linkSave} disabled={!waiter || !blocker || busy} onClick={() => void save()}>{busy ? "Linking…" : "Link"}</button>
    <button type="button" className={css.quiet} onClick={() => setOpen(false)}>Cancel</button>
    {error ? <em role="alert" className={css.linkError}>{error}</em> : null}
  </div>;
}
