"use client";
// FLOW-B: the process canvas. Stages are bands left to right; each step is a card with its module's icon, title, who and
// when it is due, its Needs on the left edge and its Makes on the right, coloured by kind. Drag a step by its card; drag
// from a Makes dot to a Needs dot (or onto a card) to join them. A wire whose kinds do not fit turns red and offers the
// converters that would. Drag the background or scroll to move around; Ctrl/⌘ + scroll or the buttons zoom; the minimap
// shows where you are. Modules dragged in from the palette land where they are dropped, in that stage.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type Ref } from "react";
import { Bell, Map as MapIcon, Maximize, Minus, Plus, Sparkles, Wand2 } from "lucide-react";
import { NODE, bandAt, bands as bandsOf, checkWire, dueDays, extent, fitView, moduleOf, nodeHeight, portPoint, snap, stepRuns, wireMid, wirePath, type Band } from "../../lib/flow-canvas.mjs";
import type { FlowDef, FlowStep, Kind, ModuleManifest } from "../flow-types";
import { ENGINE_BADGE, KIND_SLOT, KIND_WORD, ModuleIcon } from "./kinds";
import css from "./builder.module.css";

export type Sel = { kind: "step"; id: string } | { kind: "wire"; index: number } | null;
export type CanvasApi = { fit: () => void; zoomBy: (f: number) => void; center: (id: string) => void };
type View = { k: number; x: number; y: number };
type Pending = { from: { step: string; port: string }; kind: Kind; a: { x: number; y: number }; b: { x: number; y: number }; over: string | null };

/** FLOW-D: primitives that go by themselves have nobody to name. */
export const NEEDS_WHO = new Set(["task", "collect", "meet", "write", "review", "decide", "app", "repeat"]);

export function Canvas({ insets, def, byKey, modules, sel, onSelect, values, roleLabel, readOnly, onMoveStart, onMove, onMoveEnd, onConnect, onDropModule, onConvert, onTidy, api, compact = false }: {
  compact?: boolean;
  def: FlowDef; byKey: Record<string, ModuleManifest>; modules: ModuleManifest[]; sel: Sel; onSelect: (s: Sel) => void; values: Record<string, string>;
  roleLabel: (step: FlowStep) => string | null; readOnly: boolean;
  onMoveStart: () => void; onMove: (id: string, pos: { x: number; y: number }) => void; onMoveEnd: (id: string, stage: string | null) => void;
  onConnect: (from: { step: string; port: string }, to: string, port: string | null) => void; onDropModule: (key: string, at: { x: number; y: number }, stage: string | null) => void;
  onConvert: (wire: number, module: string) => void; onTidy: () => void; api?: Ref<CanvasApi>; insets: { left: number; right: number };
}) {
  // FLOW-D: without "Show what flows" a card shows only when it starts and what it hands on (the order, not the data).
  const mod = (x: FlowStep) => { const m = moduleOf(x, byKey); if (!compact) return m;
    const used = new Set(def.wires.filter((w) => w.from.step === x.id).map((w) => w.from.port));
    return { ...m, needs: m.needs.filter((p) => p.key === "in" || (!x.block && p.required !== false)).slice(0, 2),
      makes: x.block === "decide" || x.module === "decision" ? m.makes : m.makes.filter((p, i) => i === 0 || used.has(p.key)).slice(0, 2) }; };
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ k: 0.8, x: 40, y: 40 });
  const [size, setSize] = useState({ w: 1000, h: 640 });
  const [pending, setPending] = useState<Pending | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const pan = useRef<{ sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null);
  // Hold Space (or the middle button) to move the canvas from anywhere, cards included, as in Figma; the minimap can be put away.
  const space = useRef(false), [grab, setGrab] = useState(false), [map, setMap] = useState(true);
  useEffect(() => {
    const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]");
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !typing(e)) { e.preventDefault(); if (!space.current) { space.current = true; setGrab(true); } } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") { space.current = false; setGrab(false); } };
    const blur = () => { space.current = false; setGrab(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);
  const bands = useMemo(() => bandsOf(def, byKey), [def, byKey]);
  const box0 = useMemo(() => extent(def, byKey, bands), [def, byKey, bands]);
  const byId = useMemo(() => new Map(def.steps.map((s) => [s.id, s])), [def.steps]);
  const checks = useMemo(() => def.wires.map((w) => checkWire(def, byKey, modules, w)), [def, byKey, modules]);
  const anyVariant = Object.values(values).some(Boolean);

  // Fit and centre in the part of the canvas the floating panels leave free.
  const free = useMemo(() => ({ w: Math.max(200, size.w - insets.left - insets.right), h: size.h }), [size, insets.left, insets.right]);
  const fitFree = useCallback(() => { const v = fitView(box0, free); return { ...v, x: v.x + insets.left }; }, [box0, free, insets.left]);
  const fit = useCallback(() => setView(fitFree()), [fitFree]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure(); const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, []);
  // Open on the whole process, readable: fit, but never smaller than 55% (the rest is a scroll away).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || size.w < 100) return; opened.current = true;
    const v = fitFree(); setView(v.k >= 0.55 ? v : { k: 0.62, x: insets.left + 24 - box0.x * 0.62, y: 24 - box0.y * 0.62 });
  }, [size, box0, fitFree, insets.left]);
  const zoomAt = useCallback((f: number, at?: { x: number; y: number }) => setView((v) => {
    const k = Math.max(0.12, Math.min(2.2, v.k * f)), p = at ?? { x: size.w / 2, y: size.h / 2 };
    return { k, x: p.x - ((p.x - v.x) / v.k) * k, y: p.y - ((p.y - v.y) / v.k) * k };
  }), [size]);
  useImperativeHandle(api, () => ({
    fit, zoomBy: (f) => zoomAt(f),
    center: (id) => { const s = byId.get(id); if (!s) return; setView((v) => {
      // Only when the card is out of the free part of the view: a card already in sight stays where it is.
      const x0 = s.pos.x * v.k + v.x, y0 = s.pos.y * v.k + v.y, w = NODE.w * v.k;
      if (x0 >= insets.left + 8 && x0 + w <= size.w - insets.right - 8 && y0 >= 8 && y0 + 80 <= size.h - 8) return v;
      return { ...v, x: insets.left + free.w / 2 - (s.pos.x + NODE.w / 2) * v.k, y: size.h / 2 - (s.pos.y + 60) * v.k }; }); },
  }), [fit, zoomAt, byId, size, insets, free]);

  useEffect(() => {
    const el = box.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const r = el.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0022), { x: e.clientX - r.left, y: e.clientY - r.top }); }
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", wheel, { passive: false }); return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  const world = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k }; };

  // The background: drag to move around; a press without a move clears the choice.
  const bgDown = (e: RPointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.button === 1) e.preventDefault();
    if (e.button > 1 || t.closest("[data-float]") || (e.button === 0 && !space.current && t.closest("[data-card],[data-chip]"))) return;
    pan.current = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false }; e.currentTarget.setPointerCapture(e.pointerId);
  };
  const bgMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = pan.current; if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 4) return;
    p.moved = true; setView((v) => ({ ...v, x: p.x + e.clientX - p.sx, y: p.y + e.clientY - p.sy }));
  };
  const bgUp = () => { const p = pan.current; pan.current = null; if (p && !p.moved) onSelect(null); };

  // A card moves by any part that is not a port; a press without a move chooses it.
  const cardDown = (e: RPointerEvent<HTMLDivElement>, s: FlowStep) => {
    if (e.button > 0 || space.current || (e.target as HTMLElement).closest("[data-port]")) return;
    e.stopPropagation(); const p = world(e);
    drag.current = { id: s.id, dx: p.x - s.pos.x, dy: p.y - s.pos.y, sx: e.clientX, sy: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const cardMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || readOnly) return;
    if (!d.moved) { if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return; d.moved = true; onMoveStart(); }
    const p = world(e); onMove(d.id, { x: snap(p.x - d.dx), y: snap(p.y - d.dy) });
  };
  const cardUp = () => {
    const d = drag.current; drag.current = null; if (!d) return;
    if (!d.moved) { onSelect({ kind: "step", id: d.id }); return; }
    const s = byId.get(d.id); if (s) onMoveEnd(d.id, bandAt(bands, s.pos.x + NODE.w / 2));
  };

  // Wiring: from a Makes dot, onto a Needs dot or a card.
  const portDown = (e: RPointerEvent<HTMLButtonElement>, s: FlowStep, key: string, kind: Kind) => {
    if (readOnly) return;
    e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    const a = portPoint(s, mod(s), "makes", key);
    setPending({ from: { step: s.id, port: key }, kind, a, b: a, over: null });
  };
  const portMove = (e: RPointerEvent<HTMLButtonElement>) => {
    if (!pending) return;
    const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const card = target?.closest<HTMLElement>("[data-card]")?.dataset.card ?? null;
    setPending({ ...pending, b: world(e), over: card && card !== pending.from.step ? card : null });
  };
  const portUp = (e: RPointerEvent<HTMLButtonElement>) => {
    const p = pending; setPending(null); if (!p) return;
    const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const needs = target?.closest<HTMLElement>("[data-needs]"), card = target?.closest<HTMLElement>("[data-card]")?.dataset.card;
    if (needs?.dataset.step && needs.dataset.needs) onConnect(p.from, needs.dataset.step, needs.dataset.needs);
    else if (card && card !== p.from.step) onConnect(p.from, card, null);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const key = e.dataTransfer.getData("application/x-pulse-module"); if (!key || readOnly) return;
    e.preventDefault(); const p = world(e);
    onDropModule(key, { x: snap(p.x - NODE.w / 2), y: snap(p.y - 20) }, bandAt(bands, p.x));
  };

  const due = (s: FlowStep) => {
    if (!s.due) return null;
    const d = anyVariant ? dueDays(s.due, values) : null;
    const from = s.due.from === "day1" ? "Day" : s.due.from === "start" ? "Day" : null;
    if (d !== null) return from ? `${from} ${d}` : `${d} days after`;
    if (typeof s.due.days === "number") return from ? `${from} ${s.due.days}` : `${s.due.days} days after`;
    const days = Object.values(s.due.days); return days.length ? `Day ${days.join(" / ")}` : null;
  };

  const kinds = useMemo(() => [...new Set(def.steps.flatMap((s) => { const m = moduleOf(s, byKey); return [...m.needs, ...m.makes].map((p) => p.kind); }))].filter((k) => k !== "any").sort((a, z) => KIND_SLOT[a] - KIND_SLOT[z]), [def.steps, byKey]);

  return <div ref={box} className={css.canvas} onPointerDown={bgDown} onPointerMove={bgMove} onPointerUp={bgUp} onDragOver={(e) => { if (!readOnly) e.preventDefault(); }} onDrop={onDrop}
    role="application" aria-label="Process steps on a canvas" data-pending={pending ? "" : undefined} data-grab={grab ? "" : undefined}
    style={{ backgroundSize: `${24 * view.k}px ${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
    <div className={css.plane} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
      {bands.map((b, i) => <BandBox key={b.key || "none"} b={b} i={i} />)}
      <svg className={css.wires} width="1" height="1" aria-hidden="true">
        {def.wires.map((w, i) => {
          const a = byId.get(w.from.step), z = byId.get(w.to.step); if (!a || !z) return null;
          const p0 = portPoint(a, mod(a), "makes", w.from.port), p1 = portPoint(z, mod(z), "needs", w.to.port);
          const c = checks[i], off = anyVariant && (!stepRuns(a, values) || !stepRuns(z, values));
          const chosen = sel?.kind === "wire" && sel.index === i, d = wirePath(p0, p1);
          return <g key={i} data-k={KIND_SLOT[c.ok ? c.fromKind : c.fromKind]} data-bad={c.ok ? undefined : ""} data-off={off ? "" : undefined} data-chosen={chosen ? "" : undefined}>
            <path className={css.wireHit} d={d} onPointerDown={(e) => { e.stopPropagation(); onSelect({ kind: "wire", index: i }); }} />
            <path className={css.wire} d={d} />
          </g>;
        })}
        {pending ? <path className={css.wire} data-k={KIND_SLOT[pending.kind]} data-pending="" d={wirePath(pending.a, pending.b)} /> : null}
      </svg>
      {def.wires.map((w, i) => {
        const c = checks[i], a = byId.get(w.from.step), z = byId.get(w.to.step); if (!a || !z || (c.ok && !w.notify?.length)) return null;
        const m = wireMid(portPoint(a, mod(a), "makes", w.from.port), portPoint(z, mod(z), "needs", w.to.port));
        if (c.ok) return <span key={`n${i}`} className={css.notifyDot} style={{ left: m.x, top: m.y }} title={`Tells ${w.notify!.join(", ")} when it is ready`} data-chip=""><Bell size={11} aria-hidden="true" /></span>;
        const conv = c.converters[0] ? byKey[c.converters[0]] : null;
        return <div key={`c${i}`} className={css.misfit} style={{ left: m.x, top: m.y }} data-chip="">
          <span>{c.why}</span>
          {conv && !readOnly ? <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => onConvert(i, conv.key)}><Sparkles size={12} aria-hidden="true" />Add {conv.name}?</button>
            : <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => onSelect({ kind: "wire", index: i })}>Fix it</button>}
        </div>;
      })}
      {def.steps.map((s) => {
        const m = mod(s), runs = !anyVariant || stepRuns(s, values), chosen = sel?.kind === "step" && sel.id === s.id;
        const who = roleLabel(s), when = due(s), slot = KIND_SLOT[m.makes[0]?.kind ?? m.needs[0]?.kind ?? "any"];
        const wiredIn = new Set(def.wires.filter((w) => w.to.step === s.id).map((w) => w.to.port)), wiredOut = new Set(def.wires.filter((w) => w.from.step === s.id).map((w) => w.from.port));
        const typed = new Set((s.inputs ?? []).map((x) => x.port));
        return <div key={s.id} data-card={s.id} data-block={s.block ?? undefined} className={css.card} style={{ left: s.pos.x, top: s.pos.y, width: NODE.w, height: nodeHeight(m), ...(s.block ? {} : { "--k": `var(--k${slot})` }) } as CSSProperties}
          data-chosen={chosen ? "" : undefined} data-off={runs ? undefined : ""} data-over={pending?.over === s.id ? "" : undefined}
          onPointerDown={(e) => cardDown(e, s)} onPointerMove={cardMove} onPointerUp={cardUp}
          tabIndex={0} role="button" aria-pressed={chosen} aria-label={`${s.title || m.name}${who ? `, ${who}` : ""}${when ? `, due ${when}` : ""}${runs ? "" : ", skipped for this package"}`}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect({ kind: "step", id: s.id }); } }}>
          <div className={css.cardHead}>
            <span className={css.cardIcon}><ModuleIcon name={m.icon} size={16} /></span>
            <span className={css.cardText}><b>{s.title || m.kindLabel || m.name}</b><small>{[s.block ? m.name : null, who ?? (s.block && !NEEDS_WHO.has(s.block) ? null : "Nobody yet"), when].filter(Boolean).join(" · ")}</small></span>
            {m.engine !== "live" ? <em className={css.engine} data-engine={m.engine} title={ENGINE_BADGE[m.engine].title}>{m.engine === "stub" ? "Soon" : "Part"}</em> : null}
          </div>
          <div className={css.ports}>
            <ul>{m.needs.map((p) => <li key={p.key} data-k={KIND_SLOT[p.kind]} data-needs={p.key} data-step={s.id} data-port="" title={`Needs ${KIND_WORD[p.kind].toLowerCase()}${p.required ? " (required)" : ""}`}
              data-open={!wiredIn.has(p.key) && !typed.has(p.key) && p.required ? "" : undefined}>
              <i className={css.dotIn} data-filled={wiredIn.has(p.key) || typed.has(p.key) ? "" : undefined} /><span>{p.label}</span></li>)}</ul>
            <ul>{m.makes.map((p) => <li key={p.key} data-k={KIND_SLOT[p.kind]} title={`Makes ${KIND_WORD[p.kind].toLowerCase()}`}><span>{p.label}</span>
              <button type="button" data-port="" className={css.dotOut} data-filled={wiredOut.has(p.key) ? "" : undefined} aria-label={`Join “${p.label}” to another step`} disabled={readOnly}
                onPointerDown={(e) => portDown(e, s, p.key, p.kind)} onPointerMove={portMove} onPointerUp={portUp} /></li>)}</ul>
          </div>
        </div>;
      })}
    </div>
    {kinds.length ? <div className={css.legend} data-float="" aria-label="What travels on the wires">{kinds.map((k) => <span key={k} data-k={KIND_SLOT[k]}><i />{KIND_WORD[k]}</span>)}</div> : null}
    <div className={css.zoom} data-float="">
      <button type="button" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)"><Minus size={15} /></button>
      <button type="button" className={css.zoomPct} onClick={() => setView((v) => ({ ...v, k: 1 }))} title="Actual size (0)">{Math.round(view.k * 100)}%</button>
      <button type="button" onClick={() => zoomAt(1.2)} aria-label="Zoom in" title="Zoom in (+)"><Plus size={15} /></button>
      <button type="button" onClick={fit} aria-label="Fit the whole process" title="Fit (F)"><Maximize size={14} /></button>
      <button type="button" onClick={() => setMap((m) => !m)} aria-pressed={map} aria-label={map ? "Hide the minimap" : "Show the minimap"} title={map ? "Hide the minimap" : "Show the minimap"}><MapIcon size={14} /></button>
      {!readOnly ? <button type="button" onClick={onTidy} title="Lay the steps out again, stage by stage"><Wand2 size={14} /><span>Tidy up</span></button> : null}
    </div>
    {map && free.w > 620 ? <Minimap def={def} byKey={byKey} bands={bands} box0={box0} view={view} size={size} onGo={(p) => setView((v) => ({ ...v, x: insets.left + free.w / 2 - p.x * v.k, y: size.h / 2 - p.y * v.k }))} /> : null}
  </div>;
}

function BandBox({ b, i }: { b: Band; i: number }) {
  return <section className={css.band} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} data-odd={i % 2 ? "" : undefined} aria-label={b.label}>
    <header><b>{b.label}</b><small>{b.steps ? `${b.steps} ${b.steps === 1 ? "step" : "steps"}` : "Drop a step here"}</small></header>
  </section>;
}

function Minimap({ def, byKey, bands, box0, view, size, onGo }: { def: FlowDef; byKey: Record<string, ModuleManifest>; bands: Band[]; box0: { x: number; y: number; w: number; h: number };
  view: View; size: { w: number; h: number }; onGo: (p: { x: number; y: number }) => void }) {
  const W = 184, H = Math.round(Math.max(52, Math.min(112, (W * box0.h) / box0.w + 8))), k = Math.min(W / box0.w, H / box0.h);
  const go = (e: RPointerEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); onGo({ x: box0.x + (e.clientX - r.left - (W - box0.w * k) / 2) / k, y: box0.y + (e.clientY - r.top - (H - box0.h * k) / 2) / k }); };
  const vx = -view.x / view.k, vy = -view.y / view.k, vw = size.w / view.k, vh = size.h / view.k;
  return <div className={css.minimap} data-float="" aria-label="Where you are on the canvas">
    <svg width={W} height={H} viewBox={`${box0.x - (W / k - box0.w) / 2} ${box0.y - (H / k - box0.h) / 2} ${W / k} ${H / k}`} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); go(e); }}
      onPointerMove={(e) => { if (e.buttons) go(e); }}>
      {bands.map((b, i) => <rect key={b.key || i} x={b.x} y={b.y} width={b.w} height={b.h} className={css.miniBand} />)}
      {def.steps.map((s) => <rect key={s.id} x={s.pos.x} y={s.pos.y} width={NODE.w} height={nodeHeight(moduleOf(s, byKey))} rx={10} className={css.miniCard} />)}
      <rect x={vx} y={vy} width={vw} height={vh} className={css.miniView} />
    </svg>
  </div>;
}

