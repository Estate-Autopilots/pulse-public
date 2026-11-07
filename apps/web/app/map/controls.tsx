"use client";

import { Banknote, Building2, Clapperboard, Clock, Flame, Hexagon, IndianRupee, Layers, Lock, MapPin, Mountain, Pause, Play, Radar, Route, Ruler, Satellite, Shapes, Sun, Moon, Undo2, Users, X, CircleDot, Box, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AREA_METRICS, AREA_KM, distance, HEX_KM, monthLabel, monthShort, pathKm, type AreaMetric, type Filters } from "./geo";
import { breaks, SATELLITE, type Base, type Mode } from "./canvas";
import { How, Seg } from "./parts";
import css from "./map.module.css";

export const DATA_LAYERS: { key: Mode; label: string; hint: string; icon: typeof MapPin }[] = [
  { key: "points", label: "Projects", hint: "Every development; groups split as you zoom", icon: MapPin },
  { key: "heat", label: "Heatmap", hint: "Where the work concentrates", icon: Flame },
  { key: "hex", label: "Hexagons", hint: "Projects per H3 cell, flat or 3D", icon: Hexagon },
  { key: "areas", label: "Market areas", hint: "Micro-markets shaded by projects, repeat clients or deliveries", icon: Shapes },
  { key: "markets", label: "Market centres", hint: "One circle per micro-market, sized by projects", icon: Layers },
  { key: "money", label: "Money", hint: "Invoiced by place; colour shows collections", icon: Banknote },
  { key: "clients", label: "Clients", hint: "Developers and channel partners where they build", icon: Building2 },
  { key: "shoots", label: "Shoots", hint: "Where model shoots took place", icon: Clapperboard },
  { key: "prices", label: "Prices", hint: "₹ per sq ft written in project documents", icon: IndianRupee },
];
export const BASES: { key: Base; label: string; hint: string; icon: typeof Sun }[] = [
  { key: "light", label: "Streets light", hint: "OpenFreeMap", icon: Sun },
  { key: "dark", label: "Streets dark", hint: "OpenFreeMap", icon: Moon },
  { key: "relief", label: "Relief", hint: "Terrain shading", icon: Mountain },
  { key: "satellite", label: "Satellite", hint: SATELLITE ? "Imagery" : "Connect a provider", icon: Satellite },
];
const SATELLITE_WHY = "No imagery provider allows commercial use without an account: EOX Sentinel-2 cloudless needs a commercial licence, Esri World Imagery an ArcGIS account. Connect a licensed provider to turn this on.";
const ROUTING_WHY = "Pulse has no routing service (openrouteservice and GraphHopper need an account key, the OSRM demo is non-commercial). Travel time is estimated: the straight line times 1.35 for roads, 22 km/h for the first 15 km and 40 km/h beyond. Plan with it; check the real route before a shoot.";

/** Closes a popover on a click outside it or Escape. */
function useAway(open: boolean, close: () => void, ...keep: { current: HTMLElement | null }[]) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !keep.some((k) => k.current?.contains(t))) close(); };
    document.addEventListener("pointerdown", away); return () => document.removeEventListener("pointerdown", away);
  });
  return box;
}

export function LayersMenu({ open, anchor, close, base, setBase, mode, setMode, metric, setMetric, extrude, setExtrude, repeat, setRepeat, rings, setRings, hasProject, available, travel, setTravel, gaps, setGaps, travelFrom }: {
  open: boolean; anchor: { current: HTMLElement | null }; close: () => void; base: Base; setBase: (b: Base) => void; mode: Mode; setMode: (m: Mode) => void; metric: AreaMetric; setMetric: (m: AreaMetric) => void;
  extrude: boolean; setExtrude: (on: boolean) => void; repeat: boolean; setRepeat: (on: boolean) => void; rings: boolean; setRings: (on: boolean) => void; hasProject: boolean;
  available: Mode[]; travel: boolean; setTravel: (on: boolean) => void; gaps: boolean; setGaps: (on: boolean) => void; travelFrom: string | null;
}) {
  const box = useAway(open, close, anchor);
  if (!open) return null;
  return (
    <div ref={box} className={css.layers} role="dialog" aria-label="Map layers">
      <section>
        <h3>Show on the map</h3>
        <div role="radiogroup" aria-label="Data layer" className={css.options}>
          {DATA_LAYERS.filter((l) => available.includes(l.key)).map(({ key, label, hint, icon: Icon }) => <button key={key} type="button" role="radio" aria-checked={mode === key} aria-label={label} onClick={() => setMode(key)}>
            <Icon size={20} strokeWidth={1.8} aria-hidden="true" /><span><b>{label}</b><small>{hint}</small></span></button>)}
        </div>
        {mode === "areas" ? <Seg label="Shade market areas by" value={metric} onChange={setMetric} items={AREA_METRICS.map((m) => ({ key: m.key, label: m.label }))} /> : null}
        {mode === "hex" ? <Toggle icon={Box} label="3D towers" hint="Height and colour follow the projects in each cell" on={extrude} set={setExtrude} /> : null}
      </section>
      <section>
        <h3>Base map</h3>
        <div role="radiogroup" aria-label="Base map" className={css.bases}>
          {BASES.map(({ key, label, hint, icon: Icon }) => { const off = key === "satellite" && !SATELLITE; return (
            <button key={key} type="button" role="radio" aria-checked={base === key} aria-label={label} data-base={key} disabled={off} title={off ? SATELLITE_WHY : hint} onClick={() => setBase(key)}>
              <i aria-hidden="true">{off ? <Lock size={18} /> : <Icon size={18} />}</i><b>{label}</b><small>{hint}</small></button>); })}
        </div>
        {SATELLITE ? null : <div className={css.why}><span>Satellite needs a licensed imagery provider.</span><How>{SATELLITE_WHY}</How></div>}
        <h3>Overlays</h3>
        <Toggle icon={Users} label="Repeat clients" hint="Ring projects whose client came back" on={repeat} set={setRepeat} />
        <Toggle icon={CircleDot} label="Catchment rings" hint={hasProject ? "2, 5 and 10 km around the chosen project" : "Choose a project to draw 2, 5 and 10 km rings"} on={rings} set={setRings} />
        <div className={css.toggleRow}><Toggle icon={Route} label="Travel time" hint={travelFrom ? `30, 60 and 90 minutes from ${travelFrom}, estimated` : "Choose a project or add the office to draw it"} on={travel} set={setTravel} /><How>{ROUTING_WHY}</How></div>
        <Toggle icon={Radar} label="White space" hint="Markets with demand nearby but no paying client this year" on={gaps} set={setGaps} />
      </section>
    </div>
  );
}

function Toggle({ icon: Icon, label, hint, on, set }: { icon: typeof MapPin; label: string; hint: string; on: boolean; set: (on: boolean) => void }) {
  return <label className={css.toggle}><Icon size={20} aria-hidden="true" /><span><b>{label}</b><small>{hint}</small></span><input type="checkbox" role="switch" checked={on} onChange={(e) => set(e.target.checked)} aria-label={label} /></label>;
}

/** The legend explains only what is drawn now. */
export function Legend({ mode, repeat, rings, ringName, resolution, extrude, metric, setMetric, values, hidden, folded, overlays }: {
  mode: Mode; repeat: boolean; rings: boolean; ringName?: string; resolution: number; extrude: boolean; metric: AreaMetric; setMetric: (m: AreaMetric) => void; values: number[]; hidden?: boolean; folded?: boolean;
  overlays?: { travel?: string | null; gaps?: boolean; route?: string | null };
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  if (hidden) return null;
  const shown = open ?? !folded;
  const m = AREA_METRICS.find((x) => x.key === metric)!;
  const steps = breaks(values), empty = !values.some((v) => v > 0);
  let body: ReactNode;
  if (mode === "points") body = <div className={css.keys}><span><i data-dot="exact" />Exact or building</span><span><i data-ring="street" />Street</span><span><i data-ring="locality" />Locality</span><span><i data-ring="city" />City</span><span><i data-dot="group" />Group</span>{repeat ? <span><i data-ring="repeat" />Repeat client</span> : null}</div>;
  else if (mode === "heat") body = <div className={css.ramp}><span>Fewer</span><i data-ramp="heat" /><span>More projects</span></div>;
  else if (mode === "hex") body = <><div className={css.ramp}><span>1</span><i data-ramp="seq" /><span>Most per cell</span></div><small>H3 cells about {HEX_KM[resolution]} across{extrude ? "; height follows projects" : ""}</small></>;
  else if (mode === "markets") body = <div className={css.keys}><span><i data-dot="small" />Few</span><span><i data-dot="big" />Many projects</span><span>Click a circle to open the market</span></div>;
  else if (mode === "money") body = <><div className={css.keys}><span><i data-dot="overdue" />Overdue</span><span><i data-dot="open" />Not yet confirmed paid</span><span><i data-dot="paid" />Paid</span><span><i data-ring="pipeline" />Active, not invoiced</span></div><small>Circle area follows the amount invoiced before GST</small></>;
  else if (mode === "clients") body = <div className={css.keys}><span><i data-dot="developer" />Developer</span><span><i data-dot="partner" />Channel partner</span><span><i data-dot="otherClient" />Other or not set</span></div>;
  else if (mode === "shoots") body = <div className={css.keys}><span><i data-dot="shoot" />A shoot day</span><span>Placed at the shoot’s locality, else at its project</span></div>;
  else if (mode === "prices") body = <><div className={css.ramp}><span>Lower</span><i data-ramp="seq" /><span>Higher ₹/sq ft</span></div><small>Median apartment price written in the market’s project documents</small></>;
  else body = <>
    <Seg label="Shade market areas by" value={metric} onChange={setMetric} items={AREA_METRICS.map((x) => ({ key: x.key, label: x.label }))} />
    {empty ? <small className={css.legendEmpty}>No {m.many} recorded for the markets in view{metric === "deliveries" ? ": most research projects are not linked to delivery folders yet" : ""}.</small>
      : <div className={css.bins}>{steps.map((s, i) => { const next = steps[i + 1]; return <span key={s}><i data-bin={5 - steps.length + i} />{next ? (next - 1 > s ? `${s}–${next - 1}` : `${s}`) : `${s}+`}</span>; })}<span><i data-bin="none" />None</span></div>}
    <small>Nearest-centre areas within {AREA_KM} km on a hex grid: a guide, not a boundary</small>
  </>;
  const title = mode === "areas" ? `Market areas · ${m.label.toLowerCase()}` : mode === "hex" ? "Projects per hexagon" : mode === "heat" ? "Heatmap" : mode === "markets" ? "Market centres"
    : mode === "money" ? "Money by place" : mode === "clients" ? "Clients by kind" : mode === "shoots" ? "Shoots" : mode === "prices" ? "Prices per sq ft" : "Projects by pin precision";
  return (
    <div className={css.legend} aria-label="Legend">
      <button type="button" className={css.legendHead} aria-expanded={shown} onClick={() => setOpen(!shown)}>{shown ? title : "Legend"}<ChevronDown size={18} aria-hidden="true" /></button>
      {shown ? body : null}
      {shown && rings ? <div className={css.keys}><span><i data-ring="catchment" />2, 5 and 10 km{ringName ? ` around ${ringName}` : ""}</span></div> : null}
      {shown && overlays?.travel ? <div className={css.keys}><span><i data-ring="catchment" />{overlays.travel}</span></div> : null}
      {shown && overlays?.gaps ? <div className={css.keys}><span><i data-ring="gap" />White space: demand, no paying client</span></div> : null}
      {shown && overlays?.route ? <div className={css.keys}><span><i data-dot="route" />{overlays.route}</span></div> : null}
    </div>
  );
}

/** Start-month range. Folded into a small control until it is wanted. */
export function TimeControl({ months, filters, perMonth, open, setOpen, playing, play, setRange, hidden }: {
  months: string[]; filters: Filters; perMonth: number[]; open: boolean; setOpen: (open: boolean) => void; playing: boolean; play: () => void; setRange: (from: number, to: number) => void; hidden?: boolean;
}) {
  if (hidden) return null;
  const full = filters.from === 0 && filters.to >= months.length - 1;
  const range = months.length ? full ? "All months" : `${monthShort(months[filters.from])} – ${monthShort(months[filters.to])}` : "No dates";
  const most = Math.max(1, ...perMonth);
  if (!open) return (
    <div className={css.timePill} data-active={full ? undefined : ""}>
      <button type="button" className={css.timeOpen} aria-label="Open the timeline" aria-expanded={false} onClick={() => setOpen(true)}><Clock size={18} aria-hidden="true" /><span>Time</span><b>{range}</b></button>
      {!full ? <button type="button" className={css.timeClear} aria-label="Show all months" title="Show all months" onClick={() => setRange(0, months.length - 1)}><X size={16} aria-hidden="true" /></button> : null}
    </div>
  );
  const last = Math.max(0, months.length - 1);
  return (
    <div className={css.timeline} role="group" aria-label="Timeline">
      <div className={css.timeHead}>
        <button type="button" className={css.play} aria-label={playing ? "Pause timeline" : "Play timeline"} disabled={months.length < 2} onClick={play}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
        <span><b>Start month</b><small>{months.length ? `${monthLabel(months[filters.from])} — ${monthLabel(months[filters.to])}` : "No dates connected"} · an engagement must start in this range</small></span>
        {!full ? <button type="button" className={css.textButton} onClick={() => setRange(0, last)}>All months</button> : null}
        <button type="button" className={css.iconButton} aria-label="Close the timeline" onClick={() => setOpen(false)}><X size={18} /></button>
      </div>
      <div className={css.histogram} aria-hidden="true">{perMonth.map((v, i) => <i key={months[i]} data-on={i >= filters.from && i <= filters.to ? "" : undefined} style={{ height: `${Math.max(v ? 6 : 2, (v / most) * 100)}%` }} />)}</div>
      <div className={css.ranges}>
        <input type="range" aria-label="From start month" min={0} max={last} value={filters.from} disabled={!months.length} onChange={(e) => setRange(Math.min(Number(e.target.value), filters.to), filters.to)} />
        <input type="range" aria-label="To start month" min={0} max={last} value={filters.to} disabled={!months.length} onChange={(e) => setRange(filters.from, Math.max(Number(e.target.value), filters.from))} />
      </div>
      <div className={css.ticks} aria-hidden="true">{months.map((m, i) => <span key={m}>{m.endsWith("-01") ? m.slice(0, 4) : i === 0 && Number(m.slice(5, 7)) <= 9 ? monthShort(m) : ""}</span>)}</div>
    </div>
  );
}

export function MeasureBar({ points, undo, clear, done }: { points: [number, number][]; undo: () => void; clear: () => void; done: () => void }) {
  const total = pathKm(points);
  return (
    <div className={css.measureBar} role="status" aria-label="Measure distance">
      <Ruler size={20} aria-hidden="true" />
      <span>{points.length < 2 ? <><b>Measure distance</b><small>{points.length ? "Click the next point" : "Click the map to place the first point"}</small></> : <><b>{distance(total)}</b><small>{points.length} points · straight lines</small></>}</span>
      <button type="button" className={css.iconButton} aria-label="Undo last point" title="Undo last point" disabled={!points.length} onClick={undo}><Undo2 size={18} /></button>
      <button type="button" className={css.textButton} disabled={!points.length} onClick={clear}>Clear</button>
      <button type="button" className={css.primary} onClick={done}>Done</button>
    </div>
  );
}
