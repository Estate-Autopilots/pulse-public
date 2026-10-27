"use client";
// INSIGHTS-2 (1082): the chart system Insights draws with. Every chart is SVG drawn at the width it gets (text stays its
// size on a phone), on one zero-based scale, thin marks, a legend whenever two series share a chart, a hover / focus
// tip on every mark, and a click through to the evidence where a mark has one. `ChartFor` draws any card's chart from its
// spec (the fixed vocabulary in lib/insight-viz.mjs); `Figure` adds PNG and CSV export.
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { ArrowDownRight, ArrowUpRight, Download, ImageDown } from "lucide-react";
import { activeWindow, applyFilters, count, heatStep, kindOf, niceStep, niceTop, normalize, toCsv } from "../lib/insight-viz.mjs";
import v from "./viz.module.css";

export type Series = "team" | "client" | "accent" | "s3" | "s4" | "bad" | "warn" | "good" | "muted";
export const SERIES_ORDER: Series[] = ["accent", "team", "client", "s3", "s4"];
type Row = Record<string, unknown>;
type Tip = { x: number; y: number; title: ReactNode; lines?: { label: ReactNode; value: ReactNode; s?: Series }[] } | null;
export type Filters = { pod?: string; segment?: string; service?: string; client?: string; since?: string };

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;
/** The width a chart gets, followed as the layout changes. */
function useWidth(initial = 360) {
  const ref = useRef<HTMLDivElement>(null), [w, setW] = useState(initial);
  useIso(() => {
    const el = ref.current; if (!el) return;
    const read = () => setW(Math.max(240, Math.round(el.clientWidth)));
    read(); const ro = new ResizeObserver(read); ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** The one tip a chart shows, placed at the mark (its box is the nearest [data-tipbox] around the mark). */
function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const at = (e: { clientX?: number; clientY?: number; currentTarget: EventTarget | null }, t: Omit<NonNullable<Tip>, "x" | "y">) => {
    const el = e.currentTarget instanceof Element ? e.currentTarget : null, box = el?.closest("[data-tipbox]");
    if (!el || !box) return;
    const b = box.getBoundingClientRect();
    let x: number, y: number;
    if (typeof e.clientX === "number" && typeof e.clientY === "number" && (e.clientX || e.clientY)) { x = e.clientX - b.left; y = e.clientY - b.top; }
    else { const r = el.getBoundingClientRect(); x = r.left + r.width / 2 - b.left; y = r.top - b.top; }
    setTip({ ...t, x: Math.max(70, Math.min(b.width - 70, x)), y: Math.max(28, y) });
  };
  return { tip, at, hide: () => setTip(null), on: !!tip };
}
function TipView({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return <div className={v.tip} style={{ left: tip.x, top: tip.y }} role="status">
    <b>{tip.title}</b>{(tip.lines ?? []).map((l, i) => <span key={i}>{l.s ? <i className={v.sw} data-s={l.s} /> : null}{l.label}<em>{l.value}</em></span>)}
  </div>;
}

/** Props that make a mark answer the pointer and the keyboard alike. */
function hover(t: ReturnType<typeof useTip>, content: Omit<NonNullable<Tip>, "x" | "y">, go?: () => void) {
  return {
    tabIndex: 0, role: go ? "link" : "img", "aria-label": `${typeof content.title === "string" ? content.title : ""}${(content.lines ?? []).map((l) => `, ${typeof l.label === "string" ? l.label : ""} ${typeof l.value === "string" || typeof l.value === "number" ? l.value : ""}`).join("")}`,
    onPointerMove: (e: ReactPointerEvent) => t.at(e, content), onPointerLeave: t.hide, onFocus: (e: { currentTarget: EventTarget | null }) => t.at({ currentTarget: e.currentTarget }, content), onBlur: t.hide,
    onClick: go, onKeyDown: go ? (e: { key: string }) => { if (e.key === "Enter") go(); } : undefined,
    style: go ? { cursor: "pointer" } : undefined,
  };
}

const fmt = (x: number, unit = "") => `${count(Math.round(x * 10) / 10)}${unit}`;
const trunc = (s: string, px: number, size = 12) => { const max = Math.max(3, Math.floor(px / (size * 0.56))); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

export function Legend({ items }: { items: { label: ReactNode; s: Series; line?: boolean; heat?: "team" | "client" }[] }) {
  return <ul className={v.legend}>{items.map((it, i) => <li key={i}><i className={v.sw} data-s={it.s} data-line={it.line ? "" : undefined} data-heat={it.heat} />{it.label}</li>)}</ul>;
}

// ---------------------------------------------------------------------------------------------------------------- bars
export type BarRow = { label: string; value: number; sub?: string; bench?: number | null; href?: string; s?: Series; note?: string };
/** Ranked horizontal bars: the label, a bar on one zero-based scale, the value (and its share) at the end. */
export function Bars({ rows, unit = "", total, benchLabel, s = "accent", max: fixedMax, label = "Bars", valueText, labelShare = 0.36, empty = "Nothing to show yet." }: { empty?: string; rows: BarRow[]; unit?: string; total?: number; benchLabel?: string; s?: Series; max?: number; label?: string; valueText?: (r: BarRow) => string; labelShare?: number }) {
  const [ref, w] = useWidth(), t = useTip(), router = useRouter();
  if (!rows.length) return <p className={v.empty}>{empty}</p>;
  const H = rows.some((r) => r.sub) ? 34 : 28, top = benchLabel ? 18 : 2, lw = Math.min(labelShare > 0.36 ? 340 : 220, Math.round(w * labelShare)), vw = total ? 96 : 64;
  const max = fixedMax ?? niceTop(Math.max(...rows.map((r) => Math.max(r.value, r.bench ?? 0))));
  const x = (n: number) => lw + 8 + (n / max) * (w - lw - vw - 16);
  return <div className={v.viz} ref={ref}><div data-tipbox="" style={{ position: "relative" }}>
    <svg className={v.svg} width={w} height={top + rows.length * H} role="group" aria-label={label} data-hover={t.on ? "" : undefined}>
      {benchLabel ? <text x={w - vw - 8} y={11} textAnchor="end">┊ {benchLabel}</text> : null}
      {rows.map((r, i) => {
        const y = top + i * H, go = r.href ? () => router.push(r.href!) : undefined;
        const share = total ? ` · ${Math.round((r.value / total) * 100)}%` : "";
        return <g key={`${r.label}-${i}`} className={v.mark}>
          <text x={0} y={y + 13} className={v.ink} style={{ fontSize: 12.5 }}>{trunc(r.label, lw, 12.5)}</text>
          {r.sub ? <text x={0} y={y + 25} style={{ fontSize: 10.5 }}>{trunc(r.sub, lw, 10.5)}</text> : null}
          <rect className={v.track} x={lw + 8} y={y + 7} width={Math.max(0, w - lw - vw - 16)} height={12} rx={4} />
          <rect data-s={r.s ?? s} x={lw + 8} y={y + 7} width={Math.max(r.value > 0 ? 2 : 0, x(r.value) - lw - 8)} height={12} rx={4} />
          {typeof r.bench === "number" ? <line className={v.base} x1={x(r.bench)} x2={x(r.bench)} y1={y + 3} y2={y + 23} style={{ strokeWidth: 2, strokeOpacity: .9 }} /> : null}
          <text x={w - 2} y={y + 17} textAnchor="end" className={v.strong}>{valueText ? valueText(r) : `${fmt(r.value, unit)}`}<tspan style={{ fontWeight: 400 }}>{total ? ` ${Math.round((r.value / total) * 100)}%` : ""}</tspan></text>
          <rect className={v.hit} x={0} y={y} width={w} height={H} {...hover(t, { title: r.label, lines: [{ label: r.sub ?? "Value", value: `${fmt(r.value, unit)}${share}` }, ...(typeof r.bench === "number" ? [{ label: benchLabel ?? "Benchmark", value: fmt(r.bench, unit) }] : []), ...(r.note ? [{ label: r.note, value: "" }] : [])] }, go)} />
        </g>;
      })}
    </svg><TipView tip={t.tip} /></div></div>;
}

// ------------------------------------------------------------------------------------------------------------- columns
export type ColRow = { x: string; value: number; series?: string; href?: string; label?: string };
/** Columns on a zero-based scale (stacked when rows carry a series), gridlines, the axis thinned to fit. */
export function Columns({ rows, unit = "", height = 180, s = "accent", highlight, band, seriesOrder, label = "Columns", yLabel }: { rows: ColRow[]; unit?: string; height?: number; s?: Series; highlight?: (x: string) => boolean; band?: { from: number; to: number; label: string }; seriesOrder?: { key: string; label: string; s: Series }[]; label?: string; yLabel?: string }) {
  const [ref, w] = useWidth(), t = useTip(), router = useRouter();
  const xs = useMemo(() => [...new Set(rows.map((r) => r.x))], [rows]);
  if (!rows.length) return <p className={v.empty}>Nothing to show yet.</p>;
  const ser = seriesOrder ?? [{ key: "", label: "", s }];
  const stack = (x: string) => ser.map((se) => ({ ...se, value: rows.filter((r) => r.x === x && (se.key === "" || r.series === se.key)).reduce((a, r) => a + r.value, 0) }));
  const tot = xs.map((x) => stack(x).reduce((a, p) => a + p.value, 0));
  const cs = niceStep(Math.max(1, ...tot) / 3), max = Math.max(cs, Math.ceil(Math.max(1, ...tot) / cs) * cs), L = 40, B = 22, T = yLabel ? 22 : 8, ih = height - B - T, cw = (w - L) / xs.length, bw = Math.max(2, Math.min(36, cw - 4));
  const every = Math.ceil(xs.length / Math.max(2, Math.floor((w - L) / 34)));
  const y = (n: number) => T + ih - (n / max) * ih;
  return <div className={v.viz} ref={ref}>
    {seriesOrder && seriesOrder.length > 1 ? <Legend items={seriesOrder.map((x) => ({ label: x.label, s: x.s }))} /> : null}
    <div data-tipbox="" style={{ position: "relative" }}>
      <svg className={v.svg} width={w} height={height} role="group" aria-label={label} data-hover={t.on ? "" : undefined}>
        {yLabel ? <text x={0} y={10} style={{ fontSize: 10.5 }}>{yLabel}</text> : null}
        {Array.from({ length: Math.round(max / cs) }, (_, i) => (i + 1) * cs).map((g) => <g key={g}><line className={v.grid} x1={L} x2={w} y1={y(g)} y2={y(g)} /><text x={L - 6} y={y(g) + 4} textAnchor="end">{fmt(g, unit)}</text></g>)}
        {band ? (() => { const x0 = L + band.from * cw, x1 = L + band.to * cw; return <g><rect className={v.band} x={x0} y={T} width={x1 - x0} height={ih} /><text x={(x0 + x1) / 2} y={T + 10} textAnchor="middle" style={{ fontSize: 10.5 }}>{band.label}</text></g>; })() : null}
        {xs.map((x, i) => {
          const parts = stack(x); let acc = 0; const cx = L + i * cw + (cw - bw) / 2, on = highlight ? highlight(x) : true;
          const href = rows.find((r) => r.x === x && r.href)?.href, go = href ? () => router.push(href) : undefined;
          return <g key={x} className={v.mark} data-on={on ? "" : undefined} opacity={highlight && !on ? 0.42 : 1}>
            {parts.map((p, j) => { const h = (p.value / max) * ih; const r = <rect key={j} data-s={p.s} x={cx} y={T + ih - acc - h} width={bw} height={Math.max(0, h - (j < parts.length - 1 && h > 2 ? 2 : 0))} rx={j === parts.length - 1 ? 3 : 0} />; acc += h; return r; })}
            {i % every === 0 ? <text x={cx + bw / 2} y={height - 6} textAnchor="middle">{rows.find((r) => r.x === x)?.label ?? x}</text> : null}
            <rect className={v.hit} x={L + i * cw} y={T} width={cw} height={ih} {...hover(t, { title: rows.find((r) => r.x === x)?.label ?? x, lines: parts.filter((p) => p.value || parts.length === 1).map((p) => ({ label: p.label || "Value", value: fmt(p.value, unit), s: parts.length > 1 ? p.s : undefined })) }, go)} />
          </g>;
        })}
        <line className={v.base} x1={L} x2={w} y1={T + ih} y2={T + ih} />
      </svg><TipView tip={t.tip} /></div></div>;
}

// ---------------------------------------------------------------------------------------------------------------- line
export type LineRow = { x: string; value: number | null; series?: string };
/** Lines over an ordered x (≤ 4 series, each named at its end), annotations as labelled rules, a crosshair tip. */
export function Line({ rows, unit = "", height = 200, series: seriesIn, annotations = [], label = "Trend", area, refLine }: { rows: LineRow[]; unit?: string; height?: number; series?: { key: string; label: string; s: Series }[]; annotations?: { x: string; label: string }[]; label?: string; area?: boolean; refLine?: { value: number; label: string } }) {
  const [ref, w] = useWidth(), t = useTip(), [hx, setHx] = useState<number | null>(null);
  const xs = useMemo(() => [...new Set(rows.map((r) => r.x))], [rows]);
  if (!rows.length) return <p className={v.empty}>Nothing to show yet.</p>;
  const series = seriesIn ?? [...new Set(rows.map((r) => r.series ?? ""))].slice(0, 4).map((k, i) => ({ key: k, label: k || "Value", s: SERIES_ORDER[i] }));
  const vals = rows.map((r) => r.value).filter((n): n is number => typeof n === "number");
  const ls = niceStep(Math.max(1, ...vals, refLine?.value ?? 0) / 3), max = Math.max(ls, Math.ceil(Math.max(1, ...vals, refLine?.value ?? 0) / ls) * ls), L = 40, R = series.length > 1 ? 86 : 16, B = 22, T = annotations.length ? 22 : 10, ih = height - B - T;
  const step = xs.length > 1 ? (w - L - R) / (xs.length - 1) : 0, X = (i: number) => L + (xs.length > 1 ? i * step : (w - L - R) / 2), Y = (n: number) => T + ih - (n / max) * ih;
  const every = Math.ceil(xs.length / Math.max(2, Math.floor((w - L - R) / 56)));
  const pts = (k: string) => xs.map((x, i) => { const r = rows.find((q) => q.x === x && (q.series ?? "") === k); return typeof r?.value === "number" ? [X(i), Y(r.value), r.value] as const : null; });
  // where each series' name sits at the line's end, pushed apart so two names never overlap
  const ends = series.map((se) => { const p = pts(se.key).filter(Boolean) as (readonly [number, number, number])[]; return p.length ? { key: se.key, x: p[p.length - 1][0], y: p[p.length - 1][1] } : null; })
    .filter((e): e is { key: string; x: number; y: number } => !!e).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i] = { ...ends[i], y: ends[i - 1].y + 13 };
  const endY = (k: string) => ends.find((e) => e.key === k)?.y ?? 0;
  const move = (e: ReactPointerEvent<SVGRectElement>) => {
    const b = (e.currentTarget as SVGRectElement).getBoundingClientRect(); const i = Math.max(0, Math.min(xs.length - 1, Math.round((e.clientX - b.left - (X(0) - L)) / (step || 1))));
    setHx(i); t.at(e, { title: xs[i], lines: series.map((se) => { const r = rows.find((q) => q.x === xs[i] && (q.series ?? "") === se.key); return { label: se.label, value: typeof r?.value === "number" ? fmt(r.value, unit) : "–", s: series.length > 1 ? se.s : undefined }; }) });
  };
  return <div className={v.viz} ref={ref}>
    {series.length > 1 ? <Legend items={series.map((x) => ({ label: x.label, s: x.s, line: true }))} /> : null}
    <div data-tipbox="" style={{ position: "relative" }}>
      <svg className={v.svg} width={w} height={height} role="img" aria-label={`${label}: ${series.map((se) => `${se.label} ${xs.map((x) => { const r = rows.find((q) => q.x === x && (q.series ?? "") === se.key); return `${x} ${r?.value ?? "–"}`; }).join(", ")}`).join("; ")}`}>
        {Array.from({ length: Math.round(max / ls) }, (_, i) => (i + 1) * ls).map((g) => <g key={g}><line className={v.grid} x1={L} x2={w - R} y1={Y(g)} y2={Y(g)} /><text x={L - 6} y={Y(g) + 4} textAnchor="end">{fmt(g, unit)}</text></g>)}
        {refLine ? <g><line className={v.marker} data-s="muted" x1={L} x2={w - R} y1={Y(refLine.value)} y2={Y(refLine.value)} /><text x={w - R} y={Y(refLine.value) - 4} textAnchor="end" style={{ fontSize: 10.5 }}>{refLine.label}</text></g> : null}
        {annotations.map((a) => { const i = xs.indexOf(a.x); if (i < 0) return null; return <g key={a.x + a.label}><line className={v.marker} data-s="muted" x1={X(i)} x2={X(i)} y1={T - 4} y2={T + ih} /><text x={X(i)} y={T - 8} textAnchor={i > xs.length / 2 ? "end" : "start"} style={{ fontSize: 10.5 }} className={v.ink}>{a.label}</text></g>; })}
        {series.map((se) => { const p = pts(se.key).filter(Boolean) as (readonly [number, number, number])[]; if (!p.length) return null;
          const d = p.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join("");
          const last = p[p.length - 1];
          return <g key={se.key}>
            {area ? <path className={v.area} data-s={se.s} d={`${d}L${last[0]},${T + ih}L${p[0][0]},${T + ih}Z`} /> : null}
            <path className={v.line} data-s={se.s} d={d} />
            {p.length <= 16 ? p.map((q, i) => <circle key={i} data-s={se.s} className={v.ring} cx={q[0]} cy={q[1]} r={hx !== null && Math.abs(q[0] - X(hx)) < 1 ? 5 : 3.5} />) : null}
            {series.length > 1 ? <text x={last[0] + 8} y={endY(se.key) + 4} className={v.ink} style={{ fontSize: 11.5 }}>{trunc(se.label, R - 10, 11.5)}</text> : null}
          </g>; })}
        {xs.map((x, i) => i % every === 0 || i === xs.length - 1 ? <text key={x} x={X(i)} y={height - 6} textAnchor={i === 0 && xs.length > 1 ? "start" : i === xs.length - 1 && xs.length > 1 ? "end" : "middle"}>{x}</text> : null)}
        {hx !== null ? <line className={v.base} x1={X(hx)} x2={X(hx)} y1={T} y2={T + ih} /> : null}
        <line className={v.base} x1={L} x2={w - R} y1={T + ih} y2={T + ih} />
        <rect className={v.hit} x={L - 10} y={T} width={w - L - R + 20} height={ih} onPointerMove={move} onPointerLeave={() => { setHx(null); t.hide(); }} tabIndex={0}
          onFocus={(e) => { setHx(xs.length - 1); t.at({ currentTarget: e.currentTarget }, { title: xs[xs.length - 1], lines: series.map((se) => ({ label: se.label, value: fmt(rows.find((q) => q.x === xs[xs.length - 1] && (q.series ?? "") === se.key)?.value ?? 0, unit), s: series.length > 1 ? se.s : undefined })) }); }}
          onBlur={() => { setHx(null); t.hide(); }} aria-label={label} />
      </svg><TipView tip={t.tip} /></div></div>;
}

// ------------------------------------------------------------------------------------------------------------- heatmap
/** A matrix of counts (rows x columns) on one sequential hue; an optional band marks the columns that matter. */
export function Heatmap({ rows, rowKeys, colKeys, rowLabel = (k: string) => k, colLabel = (k: string) => k, hue = "team", unit = "", band, label = "Heatmap", colEvery, rowTotals, unitWord = "Count" }: { rows: { row: string; col: string; value: number }[]; rowKeys: string[]; colKeys: string[]; rowLabel?: (k: string) => string; colLabel?: (k: string) => string; hue?: "team" | "client" | "accent"; unit?: string; band?: { from: string; to: string; label: string }; label?: string; colEvery?: number; rowTotals?: boolean; unitWord?: string }) {
  const [ref, w] = useWidth(), t = useTip();
  const m = useMemo(() => { const x = new Map<string, number>(); for (const r of rows) x.set(`${r.row}\u0001${r.col}`, (x.get(`${r.row}\u0001${r.col}`) ?? 0) + r.value); return x; }, [rows]);
  const max = Math.max(0, ...m.values()), L = 44, R = rowTotals ? 46 : 0, T = band ? 16 : 2, B = 20;
  const cw = (w - L - R) / colKeys.length, ch = Math.max(16, Math.min(28, cw * 1.1)), every = colEvery ?? Math.ceil(colKeys.length / Math.max(4, Math.floor((w - L - R) / 30)));
  const op = [0, 0.1, 0.22, 0.38, 0.56, 0.76, 1];
  if (!rows.length) return <p className={v.empty}>Nothing to show yet.</p>;
  const totals = rowKeys.map((rk) => colKeys.reduce((a, ck) => a + (m.get(`${rk}\u0001${ck}`) ?? 0), 0)), all = totals.reduce((a, n) => a + n, 0);
  return <div className={v.viz} ref={ref}><div data-tipbox="" style={{ position: "relative" }}>
    <svg className={v.svg} width={w} height={T + rowKeys.length * ch + B} role="group" aria-label={label}>
      {band ? (() => { const a = colKeys.indexOf(band.from), b = colKeys.indexOf(band.to); if (a < 0 || b < 0) return null; const x0 = L + a * cw, x1 = L + (b + 1) * cw;
        return <g><rect className={v.band} x={x0 - 1} y={T - 2} width={x1 - x0 + 2} height={rowKeys.length * ch + 4} rx={4} /><line className={v.bandLine} x1={x0 - 1} x2={x0 - 1} y1={T - 2} y2={T + rowKeys.length * ch + 2} /><line className={v.bandLine} x1={x1 + 1} x2={x1 + 1} y1={T - 2} y2={T + rowKeys.length * ch + 2} /><text x={(x0 + x1) / 2} y={10} textAnchor="middle" style={{ fontSize: 10.5 }} className={v.ink}>{band.label}</text></g>; })() : null}
      {rowKeys.map((rk, i) => <g key={rk}>
        <text x={L - 8} y={T + i * ch + ch / 2 + 4} textAnchor="end">{rowLabel(rk)}</text>
        {colKeys.map((ck, j) => { const val = m.get(`${rk}\u0001${ck}`) ?? 0, st = heatStep(val, max);
          return <rect key={ck} data-s={hue} x={L + j * cw + 1} y={T + i * ch + 1} width={Math.max(1, cw - 2)} height={ch - 2} rx={3} fillOpacity={st ? op[st] : 0.04}
            className={v.cell} {...hover(t, { title: `${rowLabel(rk)} · ${colLabel(ck)}`, lines: [{ label: unitWord, value: `${fmt(val, unit)}` }, { label: "Share of all", value: all ? `${(val / all * 100).toFixed(1)}%` : "–" }] })} />; })}
        {rowTotals ? <text x={w - 2} y={T + i * ch + ch / 2 + 4} textAnchor="end">{all ? `${Math.round(totals[i] / all * 100)}%` : ""}</text> : null}
      </g>)}
      {colKeys.map((ck, j) => j % every === 0 ? <text key={ck} x={L + j * cw + cw / 2} y={T + rowKeys.length * ch + 14} textAnchor="middle">{colLabel(ck)}</text> : null)}
    </svg><TipView tip={t.tip} /></div></div>;
}

// -------------------------------------------------------------------------------------------------------- distribution
/** How answers spread, as the share of each side per bin (sides compared on one scale), with p50 / p90 markers. */
export function Distribution({ bins, series, markers = [], height = 190, label = "Distribution" }: { bins: string[]; series: { key: string; label: string; s: Series; counts: number[] }[]; markers?: { s: Series; at: number; label: string }[]; height?: number; label?: string }) {
  const [ref, w] = useWidth(), t = useTip();
  const shares = series.map((se) => { const tot = se.counts.reduce((a, n) => a + n, 0) || 1; return se.counts.map((n) => n / tot); });
  const max = niceTop(Math.max(0.01, ...shares.flat())), L = 36, B = 22, T = markers.length ? 26 : 8, ih = height - B - T, gw = (w - L) / bins.length;
  const bw = Math.max(3, Math.min(22, (gw - 6) / series.length));
  const Y = (n: number) => T + ih - (n / max) * ih, X = (at: number) => L + at * gw;
  return <div className={v.viz} ref={ref}>
    <Legend items={series.map((se) => ({ label: se.label, s: se.s }))} />
    <div data-tipbox="" style={{ position: "relative" }}>
      <svg className={v.svg} width={w} height={height} role="group" aria-label={label} data-hover={t.on ? "" : undefined}>
        {[0.5, 1].map((f) => <g key={f}><line className={v.grid} x1={L} x2={w} y1={Y(max * f)} y2={Y(max * f)} /><text x={L - 6} y={Y(max * f) + 4} textAnchor="end">{Math.round(max * f * 100)}%</text></g>)}
        {bins.map((b, i) => <g key={b} className={v.mark}>
          {series.map((se, k) => { const h = (shares[k][i] / max) * ih, x = L + i * gw + (gw - bw * series.length - 2 * (series.length - 1)) / 2 + k * (bw + 2);
            return <rect key={se.key} data-s={se.s} x={x} y={T + ih - h} width={bw} height={Math.max(0, h)} rx={3} />; })}
          {gw >= 44 || i % 2 === 0 ? <text x={L + i * gw + gw / 2} y={height - 6} textAnchor="middle" style={{ fontSize: w < 480 ? 10 : 11.5 }}>{b}</text> : null}
          <rect className={v.hit} x={L + i * gw} y={T} width={gw} height={ih} {...hover(t, { title: b, lines: series.map((se, k) => ({ label: se.label, value: `${Math.round(shares[k][i] * 100)}% · ${count(se.counts[i])}`, s: se.s })) })} />
        </g>)}
        {markers.map((mk, i) => <g key={i}><line className={v.marker} data-s={mk.s} x1={X(mk.at)} x2={X(mk.at)} y1={T - 2 - (i % 2) * 10} y2={T + ih} />
          <text x={X(mk.at) > w - 110 ? X(mk.at) - 3 : X(mk.at) + 3} textAnchor={X(mk.at) > w - 110 ? "end" : "start"} y={T - 6 - (i % 2) * 10} style={{ fontSize: 10.5 }} className={v.ink}>{mk.label}</text></g>)}
        <line className={v.base} x1={L} x2={w} y1={T + ih} y2={T + ih} />
      </svg><TipView tip={t.tip} /></div></div>;
}

// ---------------------------------------------------------------------------------------------------------------- flow
export type FlowRow = { stage: string; start: number; p50: number; p90?: number | null; reached?: number | null; s?: Series; note?: string };
/** A swimlane of the service: each step a bar from when it usually starts for its median length, a whisker to the
 *  90th percentile, and the share of groups that got there; the step that holds things up is marked. */
export function Flow({ rows, total, unit = "days", label = "Service path", stall }: { rows: FlowRow[]; total?: number; unit?: string; label?: string; stall?: string }) {
  const [ref, w] = useWidth(), t = useTip();
  if (!rows.length) return <p className={v.empty}>Nothing to show yet.</p>;
  const narrow = w < 560, lw = narrow ? 0 : Math.min(240, w * 0.34), rw = total ? 64 : 6, H = narrow ? 46 : 34, T = 18;
  const far = Math.max(...rows.map((r) => r.start + Math.max(r.p50, r.p90 ?? 0))), sd = niceStep(far / 4), end = Math.max(sd, Math.ceil(far / sd) * sd);
  const X = (d: number) => lw + 6 + (d / end) * (w - lw - rw - 12);
  const tk = Array.from({ length: Math.round(end / sd) + 1 }, (_, i) => i * sd);
  return <div className={v.viz} ref={ref}><div data-tipbox="" style={{ position: "relative" }}>
    <svg className={v.svg} width={w} height={T + rows.length * H + 4} role="group" aria-label={label} data-hover={t.on ? "" : undefined}>
      {tk.map((d) => <g key={d}><line className={v.grid} x1={X(d)} x2={X(d)} y1={T - 4} y2={T + rows.length * H} /><text x={X(d)} y={10} textAnchor="middle">{d === 0 ? "day 0" : `${fmt(d)}d`}</text></g>)}
      {total ? <text x={w - 2} y={10} textAnchor="end">got there</text> : null}
      {rows.map((r, i) => { const y = T + i * H + (narrow ? 16 : 0), worst = r.stage === stall;
        return <g key={r.stage} className={v.mark}>
          <text x={narrow ? X(0) : 0} y={narrow ? y - 4 : y + 16} className={worst ? v.strong : v.ink} style={{ fontSize: 12.5 }}>{trunc(r.stage, narrow ? w - rw : lw, 12.5)}</text>
          {typeof r.p90 === "number" && r.p90 > r.p50 ? <line className={v.whisker} data-s={r.s ?? (worst ? "client" : "accent")} x1={X(r.start + r.p50)} x2={X(r.start + r.p90)} y1={y + 11} y2={y + 11} strokeOpacity={0.45} /> : null}
          <rect data-s={r.s ?? (worst ? "client" : "accent")} x={X(r.start)} y={y + 4} width={Math.max(3, X(r.start + r.p50) - X(r.start))} height={14} rx={4} />
          {typeof r.p90 === "number" && r.p90 > r.p50 ? <line className={v.whisker} data-s={r.s ?? (worst ? "client" : "accent")} x1={X(r.start + r.p90)} x2={X(r.start + r.p90)} y1={y + 6} y2={y + 16} strokeOpacity={0.6} /> : null}
          {total && typeof r.reached === "number" ? <text x={w - 2} y={y + 15} textAnchor="end" className={v.ink}>{Math.round(r.reached / total * 100)}%</text> : null}
          <rect className={v.hit} x={0} y={y - (narrow ? 16 : 0)} width={w} height={H} {...hover(t, { title: r.stage, lines: [{ label: "Starts, median", value: `day ${fmt(r.start)}` }, { label: "Takes, median", value: `${fmt(r.p50)} ${unit}` },
            ...(typeof r.p90 === "number" ? [{ label: "1 in 10 take over", value: `${fmt(r.p90)} ${unit}` }] : []), ...(total && typeof r.reached === "number" ? [{ label: "Groups that got here", value: `${count(r.reached)} of ${count(total)}` }] : []), ...(r.note ? [{ label: r.note, value: "" }] : [])] })} />
        </g>; })}
    </svg><TipView tip={t.tip} /></div></div>;
}

// -------------------------------------------------------------------------------------------------------------- funnel
/** Steps as bars against the whole (the first bar = all), the share written out; a step most groups skip is flagged. */
export function Funnel({ rows, total, low = 0.35, label = "Funnel", lowLabel = "rarely shows", noteFor }: { rows: { step: string; value: number; note?: string; href?: string }[]; total?: number; low?: number; label?: string; lowLabel?: string; noteFor?: (r: { step: string; value: number; note?: string }) => string | undefined }) {
  const all = total ?? Math.max(1, ...rows.map((r) => r.value));
  return <Bars label={label} labelShare={0.42} rows={rows.map((r) => ({ label: r.step, value: r.value, href: r.href, sub: noteFor?.(r) ?? r.note, s: r.value / all < low ? "warn" : "accent", note: r.value / all < low ? lowLabel : undefined }))}
    max={all} valueText={(r) => `${Math.round(r.value / all * 100)}%${r.value / all < low ? " ⚠" : ""}`} />;
}

// ------------------------------------------------------------------------------------------------------------- scatter
export type Point = { x: number; y: number; label: string; size?: number | null; group?: string; href?: string; s?: Series };
/** Points on two labelled axes with median reference lines; a click opens the point's page. */
export function Scatter({ points, xLabel, yLabel, xUnit = "", yUnit = "", xRef, yRef, height = 260, label = "Scatter", groups, logY }: { points: Point[]; xLabel: string; yLabel: string; xUnit?: string; yUnit?: string; xRef?: { value: number; label: string }; yRef?: { value: number; label: string }; height?: number; label?: string; groups?: { key: string; label: string; s: Series }[]; logY?: boolean }) {
  const [ref, w] = useWidth(), t = useTip(), router = useRouter();
  if (!points.length) return <p className={v.empty}>Nothing to show yet.</p>;
  const L = 44, B = 34, T = 10, R = 12, iw = w - L - R, ih = height - B - T;
  const xmax = niceTop(Math.max(...points.map((p) => p.x))), ymaxRaw = Math.max(...points.map((p) => p.y)), log = !!logY && ymaxRaw > 120, ymax = log ? ymaxRaw : niceTop(ymaxRaw);
  const ly = (n: number) => log ? Math.log10(1 + n) / Math.log10(1 + ymax) : n / ymax;
  const X = (n: number) => L + (n / xmax) * iw, Y = (n: number) => T + ih - ly(n) * ih;
  const smax = Math.max(1, ...points.map((p) => p.size ?? 0));
  const yt = log ? [0, 10, 60, 240, 540, 1620].filter((n) => n <= ymax * 1.05) : [0, ymax / 2, ymax];
  return <div className={v.viz} ref={ref}>
    {groups && groups.length > 1 ? <Legend items={groups.map((g) => ({ label: g.label, s: g.s }))} /> : null}
    <div data-tipbox="" style={{ position: "relative" }}>
      <svg className={v.svg} width={w} height={height} role="group" aria-label={label} data-hover={t.on ? "" : undefined}>
        {yt.map((n) => <g key={n}><line className={v.grid} x1={L} x2={w - R} y1={Y(n)} y2={Y(n)} /><text x={L - 6} y={Y(n) + 4} textAnchor="end">{fmt(n, yUnit)}</text></g>)}
        {[0.5, 1].map((f) => <text key={f} x={X(xmax * f)} y={T + ih + 14} textAnchor={f === 1 ? "end" : "middle"}>{fmt(xmax * f, xUnit)}</text>)}
        <text x={L + iw / 2} y={height - 4} textAnchor="middle" className={v.ink}>{xLabel}</text>
        <text x={L} y={T - 1} className={v.ink} style={{ fontSize: 10.5 }}>{yLabel}</text>
        {xRef ? <g><line className={v.marker} data-s="muted" x1={X(xRef.value)} x2={X(xRef.value)} y1={T} y2={T + ih} /><text x={X(xRef.value) + 4} y={T + 10} style={{ fontSize: 10.5 }}>{xRef.label}</text></g> : null}
        {yRef ? <g><line className={v.marker} data-s="muted" x1={L} x2={w - R} y1={Y(yRef.value)} y2={Y(yRef.value)} /><text x={w - R} y={Y(yRef.value) - 4} textAnchor="end" style={{ fontSize: 10.5 }}>{yRef.label}</text></g> : null}
        {points.map((p, i) => { const go = p.href ? () => router.push(p.href!) : undefined, r = 4 + (p.size ? Math.sqrt(p.size / smax) * 7 : 1.5);
          const s = p.s ?? groups?.find((g) => g.key === p.group)?.s ?? "accent";
          return <circle key={i} className={`${v.mark} ${v.ring}`} data-s={s} cx={X(p.x)} cy={Y(p.y)} r={r} fillOpacity={0.8}
            {...hover(t, { title: p.label, lines: [{ label: xLabel, value: fmt(p.x, xUnit) }, { label: yLabel, value: fmt(p.y, yUnit) }, ...(p.group ? [{ label: "Group", value: p.group }] : [])] }, go)} />; })}
        <line className={v.base} x1={L} x2={w - R} y1={T + ih} y2={T + ih} />
      </svg><TipView tip={t.tip} /></div></div>;
}

// --------------------------------------------------------------------------------------------------------------- split
/** One bar split into named parts, each written out underneath (never told apart by colour alone). */
export function Split({ parts, unit = "", label = "Split" }: { parts: { label: string; value: number; s: Series }[]; unit?: string; label?: string }) {
  const [ref, w] = useWidth(), t = useTip();
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <p className={v.empty}>Nothing to show yet.</p>;
  const shown = parts.filter((p) => p.value > 0), starts = shown.map((_, i) => shown.slice(0, i).reduce((a, p) => a + (p.value / total) * w, 0));
  return <div className={v.viz} ref={ref}><div data-tipbox="" style={{ position: "relative" }}>
    <svg className={v.svg} width={w} height={20} role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${Math.round(p.value / total * 100)}%`).join(", ")}`}>
      {shown.map((p, i) => <rect key={p.label} data-s={p.s} x={starts[i]} y={2} width={Math.max(1, (p.value / total) * w - (i < shown.length - 1 ? 2 : 0))} height={16} rx={4}
        {...hover(t, { title: p.label, lines: [{ label: "Share", value: `${Math.round(p.value / total * 100)}%` }, { label: "Count", value: fmt(p.value, unit) }] })} />)}
    </svg><TipView tip={t.tip} /></div>
    <Legend items={parts.map((p) => ({ label: <>{p.label} <b style={{ color: "var(--theme-text)" }}>{Math.round(p.value / total * 100)}%</b></>, s: p.s }))} />
  </div>;
}

// -------------------------------------------------------------------------------------------------------------- forest
/** Effects with their intervals around zero: a dot and a whisker per row. */
export function Forest({ rows, unit = "", label = "Effects" }: { rows: { label: string; value: number; lo?: number | null; hi?: number | null; href?: string }[]; unit?: string; label?: string }) {
  const [ref, w] = useWidth(), t = useTip(), router = useRouter();
  if (!rows.length) return <p className={v.empty}>Nothing to show yet.</p>;
  const lw = Math.min(260, w * 0.42), H = 28, ext = niceTop(Math.max(...rows.flatMap((r) => [Math.abs(r.value), Math.abs(r.lo ?? 0), Math.abs(r.hi ?? 0)])));
  const X = (n: number) => lw + 10 + ((n + ext) / (2 * ext)) * (w - lw - 20);
  return <div className={v.viz} ref={ref}><div data-tipbox="" style={{ position: "relative" }}>
    <svg className={v.svg} width={w} height={rows.length * H + 22} role="group" aria-label={label}>
      <line className={v.base} x1={X(0)} x2={X(0)} y1={0} y2={rows.length * H} />
      {[-ext, 0, ext].map((n) => <text key={n} x={X(n)} y={rows.length * H + 16} textAnchor="middle">{fmt(n, unit)}</text>)}
      {rows.map((r, i) => { const y = i * H + 14, s: Series = r.value < 0 ? "team" : "client", go = r.href ? () => router.push(r.href!) : undefined;
        return <g key={i} className={v.mark}>
          <text x={0} y={y + 4} className={v.ink}>{trunc(r.label, lw)}</text>
          {typeof r.lo === "number" && typeof r.hi === "number" ? <line className={v.whisker} data-s={s} x1={X(r.lo)} x2={X(r.hi)} y1={y} y2={y} /> : null}
          <circle data-s={s} className={v.ring} cx={X(r.value)} cy={y} r={5} />
          <rect className={v.hit} x={0} y={y - 12} width={w} height={H} {...hover(t, { title: r.label, lines: [{ label: "Effect", value: fmt(r.value, unit) }, ...(typeof r.lo === "number" ? [{ label: "Interval", value: `${fmt(r.lo, unit)} to ${fmt(r.hi ?? 0, unit)}` }] : [])] }, go)} />
        </g>; })}
    </svg><TipView tip={t.tip} /></div></div>;
}

// -------------------------------------------------------------------------------------------------------------- sankey
/** Flows between stages: nodes in columns by how far they are from a start, links as bands as wide as their count. */
export function Sankey({ rows, label = "Flows" }: { rows: { source: string; target: string; value: number }[]; label?: string }) {
  const [ref, w] = useWidth(), t = useTip();
  const links = rows.filter((r) => r.value > 0 && r.source !== r.target);
  const nodes = [...new Set(links.flatMap((l) => [l.source, l.target]))];
  if (!links.length) return <p className={v.empty}>Nothing to show yet.</p>;
  const level = new Map<string, number>(); nodes.forEach((n) => level.set(n, 0));
  for (let k = 0; k < nodes.length; k++) for (const l of links) if ((level.get(l.target) ?? 0) < (level.get(l.source) ?? 0) + 1 && (level.get(l.source) ?? 0) < nodes.length) level.set(l.target, Math.min(nodes.length, (level.get(l.source) ?? 0) + 1));
  const cols = Math.max(...level.values()) + 1, nw = 10, H = Math.max(160, Math.min(420, nodes.length * 34));
  const size = (n: string) => Math.max(links.filter((l) => l.target === n).reduce((a, l) => a + l.value, 0), links.filter((l) => l.source === n).reduce((a, l) => a + l.value, 0));
  const per = Array.from({ length: cols }, (_, c) => nodes.filter((n) => level.get(n) === c));
  const tot = Math.max(...per.map((ns) => ns.reduce((a, n) => a + size(n), 0))), gap = 10, k = (H - gap * Math.max(...per.map((p) => p.length))) / tot;
  const pos = new Map<string, { x: number; y: number; h: number; inY: number; outY: number }>();
  per.forEach((ns, c) => { let y = 0; for (const n of ns) { const h = Math.max(3, size(n) * k); pos.set(n, { x: (c / Math.max(1, cols - 1)) * (w - nw - 120), y, h, inY: y, outY: y }); y += h + gap; } });
  const geo = links.map((l) => { const a = pos.get(l.source)!, b = pos.get(l.target)!, h = Math.max(1, l.value * k), y0 = a.outY + h / 2, y1 = b.inY + h / 2; a.outY += h; b.inY += h;
    const x0 = a.x + nw, x1 = b.x, mx = (x0 + x1) / 2; return { l, h, d: `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}` }; });
  return <div className={v.viz} ref={ref}><div data-tipbox="" style={{ position: "relative" }}>
    <svg className={v.svg} width={w} height={H + 4} role="group" aria-label={label} data-hover={t.on ? "" : undefined}>
      {geo.map(({ l, h, d }, i) => <path key={i} className={`${v.link} ${v.mark}`} data-s="accent" d={d} strokeWidth={h}
          {...hover(t, { title: `${l.source} → ${l.target}`, lines: [{ label: "Count", value: count(l.value) }] })} />)}
      {nodes.map((n) => { const p = pos.get(n)!; return <g key={n}><rect data-s="accent" x={p.x} y={p.y} width={nw} height={p.h} rx={2} />
        <text x={p.x + nw + 4} y={p.y + Math.min(p.h, 24) / 2 + 4} className={v.ink}>{trunc(n, 116)}</text></g>; })}
    </svg><TipView tip={t.tip} /></div></div>;
}

// --------------------------------------------------------------------------------------------------------------- table
export function Table({ rows, max = 50 }: { rows: Row[]; max?: number }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !["href", "pod", "segment", "service", "client", "month"].includes(c)).slice(0, 8);
  if (!rows.length) return <p className={v.empty}>Nothing to show yet.</p>;
  return <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
    <thead><tr>{cols.map((c) => <th key={c} scope="col" style={{ textAlign: "left", padding: "6px 8px", color: "var(--theme-text-muted)", fontWeight: 600, borderBottom: "1px solid var(--theme-border)" }}>{c.replace(/_/g, " ")}</th>)}</tr></thead>
    <tbody>{rows.slice(0, max).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} style={{ padding: "6px 8px", borderBottom: "1px solid var(--theme-border)", fontVariantNumeric: "tabular-nums" }}>{typeof r[c] === "number" ? count(r[c] as number) : String(r[c] ?? "")}</td>)}</tr>)}</tbody>
  </table></div>;
}

// ---------------------------------------------------------------------------------------------------------------- kpis
export type KpiItem = { label: string; value: ReactNode; unit?: string; delta?: { text: string; good: boolean } | null; note?: ReactNode; href?: string; s?: Series };
/** Key numbers: the figure, its unit, the change with an arrow and a sign (never colour alone), one line of context. */
export function Kpis({ items }: { items: KpiItem[] }) {
  return <section className={`${v.viz} ${v.kpis}`} aria-label="Key numbers">{items.map((k) => {
    const body = <>
      <span className={v.kpiLabel}>{k.s ? <i className={v.sw} data-s={k.s} /> : null}{k.label}</span>
      <span className={v.kpiValue}>{k.value}{k.unit ? <small>{k.unit}</small> : null}
        {k.delta ? <span className={v.kpiDelta} data-good={k.delta.good ? "" : undefined} data-bad={k.delta.good ? undefined : ""}>{k.delta.text.startsWith("-") ? <ArrowDownRight size={13} aria-hidden="true" /> : <ArrowUpRight size={13} aria-hidden="true" />}{k.delta.text.replace(/^[-+]/, "")}<span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{k.delta.good ? " better" : " worse"}</span></span> : null}</span>
      {k.note ? <span className={v.kpiNote}>{k.note}</span> : null}
    </>;
    return k.href ? <a key={k.label} className={v.kpi} href={k.href}>{body}</a> : <div key={k.label} className={v.kpi}>{body}</div>;
  })}</section>;
}

// -------------------------------------------------------------------------------------------------------------- export
/** Save a chart as PNG: the SVG with its resolved colours inlined, drawn at twice its size under its title. */
export async function savePng(root: HTMLElement | null, name: string, title: string) {
  const svg = root?.querySelector("svg"); if (!svg) return;
  const clone = svg.cloneNode(true) as SVGSVGElement, src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
  src.forEach((el, i) => { const cs = getComputedStyle(el), d = dst[i] as SVGElement;
    for (const p of ["fill", "stroke", "stroke-width", "stroke-opacity", "fill-opacity", "opacity", "font-size", "font-weight", "stroke-dasharray"]) d.style.setProperty(p, cs.getPropertyValue(p)); });
  const w = svg.clientWidth || Number(svg.getAttribute("width")), h = svg.clientHeight || Number(svg.getAttribute("height"));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg"); clone.setAttribute("width", String(w)); clone.setAttribute("height", String(h));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  const img = new Image(); await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
  const pad = 16, head = 34, c = document.createElement("canvas"); c.width = (w + pad * 2) * 2; c.height = (h + pad * 2 + head) * 2;
  const g = c.getContext("2d")!; g.scale(2, 2); const bs = getComputedStyle(document.body);
  g.fillStyle = getComputedStyle(root!).getPropertyValue("--theme-surface") || bs.backgroundColor || "#fff"; g.fillRect(0, 0, w + pad * 2, h + pad * 2 + head);
  g.fillStyle = bs.color || "#111"; g.font = `600 14px ${bs.fontFamily}`; g.fillText(title, pad, pad + 14);
  g.drawImage(img, pad, pad + head - 6, w, h); URL.revokeObjectURL(url);
  download(c.toDataURL("image/png"), `${name}.png`);
}
export function saveCsv(rows: Row[], name: string) {
  download(URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" })), `${name}.csv`);
}
function download(href: string, file: string) { const a = document.createElement("a"); a.href = href; a.download = file; document.body.appendChild(a); a.click(); a.remove(); }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "chart";

/** A chart with its export buttons (PNG, CSV) in the corner. */
export function ExportTools({ target, rows, title }: { target: RefObject<HTMLElement | null>; rows?: Row[]; title: string }) {
  return <span className={v.tools}>
    <button type="button" className={v.tool} title="Save as PNG" aria-label={`Save “${title}” as PNG`} onClick={() => void savePng(target.current, slug(title), title)}><ImageDown size={15} aria-hidden="true" /></button>
    {rows?.length ? <button type="button" className={v.tool} title="Download the numbers (CSV)" aria-label={`Download the numbers of “${title}” as CSV`} onClick={() => saveCsv(rows, slug(title))}><Download size={15} aria-hidden="true" /></button> : null}
  </span>;
}

// ------------------------------------------------------------------------------------------------------- spec → chart
/** Any card's chart from its spec: the rows normalised, the shared filters applied, the kind's component drawn. */
export function ChartFor({ chart, data, filters = {} }: { chart: Record<string, unknown> | null | undefined; data: unknown; filters?: Filters }) {
  const kind = kindOf(chart);
  const norm = useMemo(() => normalize(chart, data), [chart, data]);
  const { rows, ignored } = useMemo(() => applyFilters(norm.rows as Row[], chart, filters), [norm, chart, filters]);
  if (!kind || kind === "kpis") return null;
  const c = (chart ?? {}) as Record<string, any>; // a loaded spec, read defensively
  const unit = String(c.unit ?? c.y?.unit ?? "");
  const str = (x: unknown) => String(x ?? "");
  const n = (x: unknown) => typeof x === "number" ? x : Number(x) || 0;
  const seriesKeys = [...new Set(rows.map((r) => str(r.series)).filter(Boolean))].slice(0, 4);
  const ser = seriesKeys.map((k, i) => ({ key: k, label: k, s: SERIES_ORDER[i] }));
  let body: ReactNode = null;
  if (kind === "bars") body = <Bars rows={rows.map((r) => ({ label: str(r.label), value: n(r.value), sub: r.sub ? str(r.sub) : undefined, bench: typeof r.bench === "number" ? r.bench : null, href: typeof r.href === "string" ? r.href : undefined }))
    .sort((a, b) => c.sort === "none" ? 0 : b.value - a.value)} unit={unit} total={typeof c.total === "number" ? c.total : undefined} benchLabel={c.benchLabel} />;
  else if (kind === "columns" || kind === "stacked") body = <Columns rows={rows.map((r) => ({ x: str(r.x), value: n(r.value), series: r.series ? str(r.series) : undefined }))} unit={unit} yLabel={c.yLabel ?? c.y?.label}
    seriesOrder={seriesKeys.length > 1 ? ser : undefined} highlight={Array.isArray(c.highlight) ? (x) => (c.highlight as unknown[]).map(String).includes(x) : undefined} />;
  else if (kind === "line") body = <Line rows={rows.map((r) => ({ x: str(r.x), value: typeof r.value === "number" ? r.value : null, series: r.series ? str(r.series) : undefined }))} unit={unit} area={c.kind === "area"}
    series={ser.length ? ser : undefined} annotations={(Array.isArray(c.annotations) ? c.annotations : Array.isArray(c.marks) ? c.marks : []).map((a: Record<string, unknown>) => ({ x: str(a.x), label: str(a.label) }))} />;
  else if (kind === "heatmap") {
    const rk = Array.isArray(c.rows) ? c.rows.map(str) : [...new Set(rows.map((r) => str(r.row)))], ck = Array.isArray(c.cols) ? c.cols.map(str) : [...new Set(rows.map((r) => str(r.col)))];
    body = <Heatmap rows={rows.map((r) => ({ row: str(r.row), col: str(r.col), value: n(r.value) }))} rowKeys={rk} colKeys={ck} unit={unit} hue={c.hue === "client" ? "client" : c.hue === "team" ? "team" : "accent"}
      band={c.highlight?.cols?.length ? { from: str(c.highlight.cols[0]), to: str(c.highlight.cols[c.highlight.cols.length - 1]), label: str(c.highlight.label) } : undefined} />;
  } else if (kind === "distribution") {
    const bins = [...new Set(rows.map((r) => str(r.bin ?? r.x)))], keys = seriesKeys.length ? seriesKeys : [""];
    const series = keys.map((k, i) => ({ key: k, label: k || str(c.y?.label ?? "Share"), s: SERIES_ORDER[i], counts: bins.map((b) => rows.filter((r) => str(r.bin ?? r.x) === b && (k === "" || str(r.series) === k)).reduce((a, r) => a + n(r.value), 0)) }));
    const markers = (Array.isArray(c.markers) ? c.markers : []).map((m: Record<string, unknown>) => ({ s: series.find((x) => x.key === str(m.series))?.s ?? series[0].s, at: typeof m.at === "number" ? m.at : Math.max(0, bins.indexOf(str(m.bin))) + 0.5, label: str(m.label) }));
    body = <Distribution bins={bins} series={series} markers={markers} />;
  } else if (kind === "flow") body = <Flow rows={rows.map((r) => ({ stage: str(r.stage), start: n(r.start), p50: n(r.p50), p90: typeof r.p90 === "number" ? r.p90 : null, reached: typeof r.reached === "number" ? r.reached : null }))} total={typeof c.total === "number" ? c.total : undefined} unit={unit || "days"} stall={c.stall} />;
  else if (kind === "funnel") body = <Funnel rows={rows.map((r) => ({ step: str(r.step), value: n(r.value), note: r.note ? str(r.note) : undefined }))} total={typeof c.total === "number" ? c.total : undefined} />;
  else if (kind === "scatter") {
    const gk = [...new Set(rows.map((r) => str(r.group)).filter(Boolean))].slice(0, 3);
    body = <Scatter points={rows.map((r) => ({ x: n(r.x), y: n(r.y), label: str(r.label), size: typeof r.size === "number" ? r.size : null, group: r.group ? str(r.group) : undefined, href: typeof r.href === "string" ? r.href : undefined }))}
      groups={gk.length > 1 ? gk.map((k, i) => ({ key: k, label: k, s: SERIES_ORDER[i] })) : undefined} xLabel={str(c.xLabel ?? c.x?.label ?? "x")} yLabel={str(c.yLabel ?? c.y?.label ?? "y")} xUnit={str(c.xUnit ?? c.x?.unit ?? "")} yUnit={str(c.yUnit ?? c.y?.unit ?? "")}
      xRef={typeof c.xRef === "number" ? { value: c.xRef, label: "median" } : undefined} yRef={typeof c.yRef === "number" ? { value: c.yRef, label: "median" } : undefined} />;
  } else if (kind === "split") body = <Split parts={rows.slice(0, 5).map((r, i) => ({ label: str(r.label), value: n(r.value), s: SERIES_ORDER[i] }))} unit={unit} />;
  else if (kind === "multiples") {
    const panels = [...new Set(rows.map((r) => str(r.panel)))].slice(0, 12);
    body = <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>{panels.map((p) => <div key={p}><b style={{ fontSize: 12.5 }}>{p}</b>
      <Columns rows={rows.filter((r) => str(r.panel) === p).map((r) => ({ x: str(r.x), value: n(r.value) }))} unit={unit} height={110} label={p} /></div>)}</div>;
  } else if (kind === "forest") body = <Forest rows={rows.map((r) => ({ label: str(r.label), value: n(r.value), lo: typeof (r.lo ?? r.ci_low) === "number" ? n(r.lo ?? r.ci_low) : null, hi: typeof (r.hi ?? r.ci_high) === "number" ? n(r.hi ?? r.ci_high) : null }))} unit={unit} />;
  else if (kind === "sankey") body = <Sankey rows={rows.map((r) => ({ source: str(r.source), target: str(r.target), value: n(r.value) }))} />;
  else if (kind === "table") body = <Table rows={rows} />;
  return <>{body}{ignored.length ? <p className={v.note}>Shows every {ignored.join(" and ")}: these numbers are not split that way.</p> : null}</>;
}

export { v as vizStyles, activeWindow };
