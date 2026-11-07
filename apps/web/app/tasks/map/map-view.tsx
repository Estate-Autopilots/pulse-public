"use client";
// TASKS-P0: the unlock map. Who waits on whom, as a graph: what blocks sits on the left, what it unlocks to the right.
// The critical path (the longest chain of open work) is drawn bold; finished links turn green. Zoom with the buttons
// (or Ctrl + wheel, or a pinch on a phone); the page scrolls to pan. A list beside it says the same for screen readers.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Avatar } from "../../ui";
import { urgency } from "../../lib/task-sense.mjs";
import css from "./map.module.css";

export type MapNode = { id: string; title: string; status: string; priority: string; personId: string | null; personName: string | null; photoAt: string | null; dueOn: string | null; dueAt: string | null;
  value: number; minutes: number; projectId: string | null; projectName: string | null; depth: number; unlockedAt: string | null };
export type MapData = { nodes: MapNode[]; edges: { from: string; to: string }[]; critical: string[] };
const W = 232, H = 84, GX = 76, GY = 18, PAD = 24;
const DONE = new Set(["done", "accepted", "in_review"]);

/** Columns by depth; within a column, nodes sit near what they wait on (one barycentre pass), open work first. */
function layout(d: MapData) {
  const cols = new Map<number, MapNode[]>();
  for (const n of d.nodes) cols.set(n.depth, [...(cols.get(n.depth) ?? []), n]);
  const pos = new Map<string, { x: number; y: number }>();
  const waitsOn = new Map<string, string[]>(); for (const e of d.edges) waitsOn.set(e.from, [...(waitsOn.get(e.from) ?? []), e.to]);
  const depths = [...cols.keys()].sort((a, b) => a - b);
  for (const depth of depths) {
    const list = cols.get(depth)!;
    const score = (n: MapNode) => { const ys = (waitsOn.get(n.id) ?? []).map((b) => pos.get(b)?.y).filter((y): y is number => y !== undefined); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity; };
    list.sort((a, b) => (score(a) - score(b)) || (Number(DONE.has(a.status)) - Number(DONE.has(b.status))) || String(a.dueOn ?? "9").localeCompare(String(b.dueOn ?? "9")));
    list.forEach((n, i) => pos.set(n.id, { x: PAD + depth * (W + GX), y: PAD + i * (H + GY) }));
  }
  const width = PAD * 2 + (Math.max(0, ...depths) + 1) * (W + GX) - GX;
  const height = PAD * 2 + Math.max(1, ...[...cols.values()].map((l) => l.length)) * (H + GY) - GY;
  return { pos, width, height };
}

export function UnlockMap({ data, now }: { data: MapData; now: number }) {
  const { pos, width, height } = useMemo(() => layout(data), [data]);
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes]);
  const critical = useMemo(() => new Set(data.critical), [data.critical]);
  const onPath = (e: { from: string; to: string }) => critical.has(e.from) && critical.has(e.to) && Math.abs(data.critical.indexOf(e.from) - data.critical.indexOf(e.to)) === 1;
  const frame = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const fit = () => { const el = frame.current; if (!el) return; setZoom(Math.max(0.35, Math.min(1.25, (el.clientWidth - 8) / width))); };
  useEffect(() => { fit(); }, [width]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = frame.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom((z) => Math.max(0.35, Math.min(2, z * (e.deltaY < 0 ? 1.1 : 0.9)))); };
    el.addEventListener("wheel", wheel, { passive: false }); return () => el.removeEventListener("wheel", wheel);
  }, []);
  if (!data.nodes.length) return <p className={css.empty}><b>Nothing waits on anything here yet</b>When a task waits on another (“Waiting on…” on the task page), the chain shows here.</p>;
  return <div className={css.wrap}>
    <div className={css.tools} role="group" aria-label="Zoom">
      <button type="button" onClick={() => setZoom((z) => Math.max(0.35, z - 0.15))} aria-label="Zoom out"><Minus size={14} /></button>
      <output aria-live="polite">{Math.round(zoom * 100)}%</output>
      <button type="button" onClick={() => setZoom((z) => Math.min(2, z + 0.15))} aria-label="Zoom in"><Plus size={14} /></button>
      <button type="button" onClick={fit} aria-label="Fit to the screen"><Maximize2 size={14} /></button>
      <span className={css.legend}><i data-k="critical" />Critical path<i data-k="done" />Done<i data-k="open" />Waiting</span>
    </div>
    <div className={css.frame} ref={frame}>
      <div className={css.canvas} style={{ width: width * zoom, height: height * zoom }}>
        <div className={css.inner} style={{ width, height, transform: `scale(${zoom})` }}>
          <svg className={css.edges} width={width} height={height} aria-hidden="true">
            <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L8 4L0 8z" /></marker></defs>
            {data.edges.map((e) => { const a = pos.get(e.to), b = pos.get(e.from); if (!a || !b) return null;
              const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mid = (x1 + x2) / 2;
              const done = DONE.has(byId.get(e.to)?.status ?? "");
              return <path key={`${e.from}:${e.to}`} d={`M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2 - 2} ${y2}`} data-k={done ? "done" : onPath(e) ? "critical" : "open"} markerEnd="url(#arrow)" />; })}
          </svg>
          {data.nodes.map((n) => { const p = pos.get(n.id)!; const u = urgency(n, now); const done = DONE.has(n.status);
            return <Link key={n.id} href={`/tasks/${n.id}`} className={css.node} style={{ left: p.x, top: p.y, width: W, height: H }} data-status={n.status} data-done={done ? "" : undefined}
              data-critical={critical.has(n.id) && !done ? "" : undefined} data-unlocked={n.unlockedAt && now - Date.parse(n.unlockedAt) < 86400000 && !done ? "" : undefined}
              aria-label={`${n.title}. ${n.personName ?? "Nobody"}. ${done ? "Done" : u.text}`}>
              <span className={css.title} title={n.title}>{n.title}</span>
              <span className={css.meta}>{n.personName ? <Avatar name={n.personName} id={n.personId ?? undefined} photoAt={n.photoAt} size={20} /> : null}<span>{n.personName ? n.personName.split(" ")[0] : "Nobody"}</span>
                {done ? <span className={css.due} data-tone="done">Done</span> : u.key !== "none" ? <span className={css.due} data-tone={u.tone}>{u.short}</span> : null}
</span>
            </Link>; })}
        </div>
      </div>
    </div>
    <details className={css.list}><summary>The same as a list</summary>
      <ul>{data.edges.map((e) => <li key={`${e.from}:${e.to}`}><Link href={`/tasks/${e.from}`}>{byId.get(e.from)?.title}</Link> waits on <Link href={`/tasks/${e.to}`}>{byId.get(e.to)?.title}</Link>{DONE.has(byId.get(e.to)?.status ?? "") ? " (done)" : ""}</li>)}</ul>
      {data.critical.length ? <p>Critical path: {data.critical.map((id) => byId.get(id)?.title).join(" → ")}</p> : null}
    </details>
  </div>;
}
