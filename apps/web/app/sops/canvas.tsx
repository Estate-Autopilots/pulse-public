"use client";
// WORKFLOW BUILDER: the block canvas. Blocks sit where they were put (drag a block by its top); each has its input ports
// on the left and output ports on the right, coloured by what they carry. Drag from an output to an input to wire them
// (or tap an output, then tap an input or a block); the builder checks the types and offers an adapter block when they
// do not match. Tap a wire to remove it. The canvas pans inside its own box (drag the background, or scroll), zooms
// with the buttons or Ctrl + wheel, and draws where a test run stands on each block.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { extent, nodeHeight, outType, portPoint, snap, specOf, wirePath, SIZE } from "../lib/wf-canvas.mjs";
import { ENGINE_WORD, TYPE_SLOT, type BlockSpec, type BlockStep, type PortType } from "./board-types";
import { blockIcon, GROUP_HUE } from "./block-icons";
import css from "./blocks.module.css";

export type NodeState = { status: "waiting" | "active" | "done" | "skipped" | "cancelled"; text: string };
type Pending = { from: string; port: string; type: PortType; x: number; y: number; sx: number; sy: number; moved: boolean; armed: boolean };
const slot = (t: PortType) => css[`t${TYPE_SLOT[t]}`];

export function BlockCanvas({ steps, blocks, types, selected, onSelect, onMove, onWire, onUnwire, who, handoffName, states, label, readOnly }: {
  steps: BlockStep[]; blocks: BlockSpec[]; types: Record<PortType, string>; selected: string | null; onSelect: (id: string | null) => void;
  onMove?: (id: string, pos: { x: number; y: number }) => void; onWire?: (from: string, port: string | null, to: string, inKey: string | null) => void;
  onUnwire?: (from: string, index: number) => void; who: (s: BlockStep) => string; handoffName: (s: BlockStep) => string | null;
  states?: Record<string, NodeState>; label: string; readOnly?: boolean;
}) {
  const byModule = useMemo(() => Object.fromEntries(blocks.map((b) => [b.module, b])) as Record<string, BlockSpec>, [blocks]);
  const placed = steps.filter((s) => s.pos);
  const size = extent(placed as never, byModule);
  const box = useRef<HTMLDivElement>(null), plane = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pending, setPending] = useState<Pending | null>(null), [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [wire, setWire] = useState<{ from: string; index: number } | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const pan = useRef<{ x: number; y: number; l: number; t: number } | null>(null);

  const fitZoom = () => { const el = box.current; return el ? Math.max(0.4, Math.min(1, (el.clientWidth - 16) / size.w, (el.clientHeight - 16) / size.h)) : 1; };
  // Open readable: the whole flow when that stays at 70% or more, else 80% from the start.
  useEffect(() => { const id = requestAnimationFrame(() => { const z = fitZoom(); setZoom(z >= 0.7 ? z : 0.8); }); return () => cancelAnimationFrame(id); }, [label]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = box.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom((z) => Math.max(0.4, Math.min(1.6, z * (e.deltaY < 0 ? 1.1 : 0.9)))); };
    el.addEventListener("wheel", wheel, { passive: false }); return () => el.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPending(null); setWire(null); }
      if ((e.key === "Delete" || e.key === "Backspace") && wire && onUnwire && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { onUnwire(wire.from, wire.index); setWire(null); }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [wire, onUnwire]);

  const toPlane = (e: { clientX: number; clientY: number }) => { const r = plane.current!.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }; };
  const byId = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);

  // Blocks move by their top; a press without a move chooses the block.
  const headDown = (e: ReactPointerEvent<HTMLDivElement>, s: BlockStep) => {
    if (e.button > 0 || !s.pos) return;
    const p = toPlane(e); drag.current = { id: s.id, dx: p.x - s.pos.x, dy: p.y - s.pos.y, sx: e.clientX, sy: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const headMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || readOnly || !onMove) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
    d.moved = true; const p = toPlane(e); onMove(d.id, { x: snap(p.x - d.dx), y: snap(p.y - d.dy) });
  };
  // While an output waits for its input, a press on a block wires it (the block's own click) instead of opening it.
  const headUp = () => { const d = drag.current; drag.current = null; if (d && !d.moved && !pending?.armed) onSelect(d.id); };

  // Wiring: from an output port to an input port (or onto a block, which takes the first input that fits).
  const portDown = (e: ReactPointerEvent<HTMLButtonElement>, s: BlockStep, key: string) => {
    if (readOnly || !onWire || !s.pos) return;
    e.stopPropagation();
    const spec = specOf(s, byModule); const at = portPoint(s.pos, spec, "out", key);
    if (pending?.armed && pending.from === s.id && pending.port === key) { setPending(null); return; }
    setPending({ from: s.id, port: key, type: outType(steps as never, byModule, s.id, key), x: at.x, y: at.y, sx: e.clientX, sy: e.clientY, moved: false, armed: false });
    setCursor(at); setWire(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const portMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!pending || pending.armed) return;
    if (!pending.moved && Math.hypot(e.clientX - pending.sx, e.clientY - pending.sy) < 5) return;
    if (!pending.moved) setPending({ ...pending, moved: true });
    setCursor(toPlane(e));
  };
  const portUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!pending || pending.armed) return;
    if (!pending.moved) { setPending({ ...pending, armed: true }); return; }
    const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const input = hit?.closest<HTMLElement>("[data-in-port]"), node = hit?.closest<HTMLElement>("[data-node]");
    if (input) onWire!(pending.from, pending.port, input.dataset.step!, input.dataset.inPort!);
    else if (node && node.dataset.node !== pending.from) onWire!(pending.from, pending.port, node.dataset.node!, null);
    setPending(null); setCursor(null);
  };
  const finishArmed = (to: string, inKey: string | null) => { if (!pending?.armed) return false; onWire!(pending.from, pending.port, to, inKey); setPending(null); setCursor(null); return true; };

  // The background pans with a mouse (touch scrolls the box by itself).
  const boxDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || (e.target as HTMLElement).closest("button,[data-node],input,a")) return;
    const el = box.current!; pan.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
  };
  const boxMove = (e: ReactPointerEvent<HTMLDivElement>) => { const p = pan.current; if (!p) return; const el = box.current!; el.scrollLeft = p.l - (e.clientX - p.x); el.scrollTop = p.t - (e.clientY - p.y); };
  const boxUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current; pan.current = null;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4 && !(e.target as HTMLElement).closest("[data-node],button")) { onSelect(null); setWire(null); if (pending?.armed) setPending(null); }
  };

  const wires = useMemo(() => steps.flatMap((s) => (s.next ?? []).map((n, index) => {
    const to = byId.get(n.to); if (!s.pos || !to?.pos) return null;
    const a = specOf(s, byModule), b = specOf(to, byModule);
    const start = portPoint(s.pos, a, "out", n.port ?? a.outputs[0]?.key ?? null);
    const inKey = n.in ?? b.inputs.find((i) => i.type === "any" || i.type === outType(steps as never, byModule, s.id, n.port))?.key ?? b.inputs[0]?.key ?? null;
    const end = b.inputs.length ? portPoint(to.pos, b, "in", inKey) : { x: to.pos.x, y: to.pos.y + 30 };
    const type = outType(steps as never, byModule, s.id, n.port);
    return { from: s.id, index, d: wirePath(start, end), type, label: n.label && (s.kind === "decision" || s.kind === "approval") ? n.label : null, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
  }).filter((x): x is NonNullable<typeof x> => !!x)), [steps, byId, byModule]);
  const chosenWire = wire ? wires.find((w) => w.from === wire.from && w.index === wire.index) : null;
  const used = useMemo(() => [...new Set(steps.flatMap((s) => specOf(s, byModule).outputs.map((o) => o.type)))].filter((t) => t !== "any") as PortType[], [steps, byModule]);

  return <div className={css.canvasWrap}>
    <div className={css.canvasBar}>
      <span className={css.legend} aria-label="What the ports carry">{(used.length ? used : (["lead", "call", "quote"] as PortType[])).map((t) => <span key={t} className={slot(t)}><i />{types[t]}</span>)}</span>
      <span className={css.zoom} role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, z - 0.15))}><Minus size={14} /></button><output aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))}><Plus size={14} /></button>
        <button type="button" aria-label="Fit to the screen" onClick={() => setZoom(fitZoom())}><Maximize2 size={14} /></button></span>
    </div>
    <div ref={box} className={css.box} role="region" aria-label={label} onPointerDown={boxDown} onPointerMove={boxMove} onPointerUp={boxUp} onPointerCancel={() => { pan.current = null; }}>
      {pending?.armed && byId.has(pending.from) ? <div className={css.hint} role="status">Choose where “{specOf(byId.get(pending.from)!, byModule).outputs.find((o) => o.key === pending.port)?.label}” goes: tap an input or a block.
        <button type="button" className={css.iconBtn} aria-label="Stop wiring" onClick={() => setPending(null)}><X size={14} /></button></div> : null}
      <div className={css.sizer} style={{ width: size.w * zoom, height: size.h * zoom }}>
        <div ref={plane} className={css.plane} style={{ width: size.w, height: size.h, transform: `scale(${zoom})` }}>
          <svg className={css.wires} width={size.w} height={size.h} aria-hidden="true">
            {wires.map((w) => <path key={`${w.from}:${w.index}`} d={w.d} className={slot(w.type)} data-selected={chosenWire === w ? "" : undefined} />)}
            {readOnly ? null : wires.map((w) => <path key={`h${w.from}:${w.index}`} d={w.d} data-hit="" onClick={(e) => { e.stopPropagation(); setWire({ from: w.from, index: w.index }); }} />)}
            {pending && cursor && !pending.armed ? <path d={wirePath({ x: pending.x, y: pending.y }, cursor)} data-temp="" className={slot(pending.type)} /> : null}
          </svg>
          {wires.filter((w) => w.label).map((w) => <span key={`l${w.from}:${w.index}`} className={css.wireLabel} style={{ left: w.mid.x, top: w.mid.y }}>{w.label}</span>)}
          {chosenWire && onUnwire ? <button type="button" className={css.unwire} style={{ left: chosenWire.mid.x, top: chosenWire.mid.y }} aria-label="Remove this wire"
            onClick={(e) => { e.stopPropagation(); onUnwire(chosenWire.from, chosenWire.index); setWire(null); }}><X size={14} /></button> : null}
          {placed.map((s) => {
            const spec = specOf(s, byModule); const h = nodeHeight(spec); const st = states?.[s.id]; const to = spec.module === "handoff" ? handoffName(s) : null;
            return <div key={s.id} className={css.node} data-node={s.id} data-selected={selected === s.id ? "" : undefined} data-state={st?.status} data-engine={spec.engine}
              style={{ left: s.pos!.x, top: s.pos!.y, width: SIZE.w, height: h, ["--hue" as string]: `var(--ds-hue-${GROUP_HUE[spec.group] ?? "indigo"})` }} onClick={() => { if (pending?.armed && pending.from !== s.id) finishArmed(s.id, null); }}>
              {st ? <span className={css.state}>{st.text}</span> : null}
              <div className={css.head} onPointerDown={(e) => headDown(e, s)} onPointerMove={headMove} onPointerUp={headUp} onPointerCancel={() => { drag.current = null; }}>
                <span className={css.kicker}><span className={css.nodeIcon} aria-hidden="true">{blockIcon(spec.module, 11)}</span><span>{spec.label}</span>{spec.engine === "stub" || spec.engine === "partial" ? <em data-engine={spec.engine}>{ENGINE_WORD[spec.engine]}</em> : null}</span>
                <button type="button" className={css.title} aria-pressed={selected === s.id} onClick={() => onSelect(s.id)}
                  aria-label={`${spec.label}: ${s.title || "Untitled"}, ${who(s)}${st ? `, ${st.text}` : ""}`}>{s.title || "Untitled block"}</button>
                <span className={css.who}>{who(s)}</span>
              </div>
              <div className={css.ports}>
                {spec.inputs.map((p, i) => <span key={`i${p.key}`} className={`${css.portRow} ${slot(p.type)}`} data-side="in" style={{ top: i * SIZE.row }}>
                  <button type="button" className={css.port} data-type={p.type} data-in-port={p.key} data-step={s.id} data-target={pending ? "" : undefined} disabled={readOnly}
                    aria-label={`${s.title || spec.label}: input ${p.label} (${types[p.type]})`} onClick={(e) => { e.stopPropagation(); finishArmed(s.id, p.key); }} />
                  <span title={`${p.label} · ${types[p.type]}`}>{p.label}</span></span>)}
                {to === null ? spec.outputs.map((p, i) => { const t = p.type === "any" ? outType(steps as never, byModule, s.id, p.key) : p.type;
                  return <span key={`o${p.key}`} className={`${css.portRow} ${slot(t)}`} data-side="out" style={{ top: i * SIZE.row }}>
                    <span title={`${p.label} · ${types[t]}`}>{p.label}</span>
                    <button type="button" className={css.port} data-type={t} disabled={readOnly} data-armed={pending?.armed && pending.from === s.id && pending.port === p.key ? "" : undefined}
                      aria-label={`${s.title || spec.label}: output ${p.label} (${types[t]}). Press, then choose an input to wire it`}
                      onPointerDown={(e) => portDown(e, s, p.key)} onPointerMove={portMove} onPointerUp={portUp} onPointerCancel={() => { setPending(null); setCursor(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPending({ from: s.id, port: p.key, type: t, x: 0, y: 0, sx: 0, sy: 0, moved: false, armed: true }); } }} />
                  </span>; }) : <span className={css.handoffTo}>→ {to}</span>}
              </div>
            </div>;
          })}
        </div>
      </div>
    </div>
  </div>;
}
