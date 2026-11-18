"use client";
// DOCS-RICH (owner, 9 Nov 2026: "The documents editor needs graphs ... extremely precise graphs and lines"): a chart block.
// Drawn as SVG at the width it gets, in the colours and marks of the Insights chart system (insights/viz: its validated
// series order and light/dark steps, thin 2px lines, ringed dots, hairline grids, one tip on hover or focus, a legend for
// two or more series). Unlike Insights' own charts these take values below zero, side-by-side bars, and an axis that
// starts at the data for a line. Every chart can be shown as its table (identity is never colour alone). The spec is
// plain data (columns + rows), edited as a table, pasted CSV or JSON, with the chart redrawn as you type.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AreaChart, BarChart3, ChartPie, ChartScatter, Hash, LineChart, Plus, Table2, X } from "lucide-react";
import { Legend, SERIES_ORDER, vizStyles as v, type Series } from "../../insights/viz";
import { axis, cellNumber, formatTick, formatValue, kpiOf, parseCsv, tidyChart, toCsv, type Cell, type ChartSpec, type ChartType } from "../../lib/doc-rich.mjs";
import r from "./rich.module.css";

export type ChartBlock = ChartSpec & { kind: "chart"; id: string };
export const CHART_TYPES: { type: ChartType; label: string; icon: typeof LineChart }[] = [
  { type: "line", label: "Line", icon: LineChart }, { type: "bar", label: "Bar", icon: BarChart3 }, { type: "area", label: "Area", icon: AreaChart },
  { type: "pie", label: "Pie", icon: ChartPie }, { type: "scatter", label: "Scatter", icon: ChartScatter }, { type: "table", label: "Table", icon: Table2 },
  { type: "kpi", label: "Number", icon: Hash },
];
const MAX_SERIES = SERIES_ORDER.length;
const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;
function useWidth() {
  const ref = useRef<HTMLDivElement>(null), [w, setW] = useState(560);
  useIso(() => {
    const el = ref.current; if (!el) return;
    const read = () => setW(Math.max(240, Math.round(el.clientWidth)));
    read(); const ro = new ResizeObserver(read); ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
type Tip = { x: number; y: number; title: string; lines: { label: string; value: string; s?: Series }[] } | null;
function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const show = (e: { clientX?: number; clientY?: number; currentTarget: Element }, t: Omit<NonNullable<Tip>, "x" | "y">) => {
    const box = e.currentTarget.closest("[data-tipbox]")?.getBoundingClientRect(); if (!box) return;
    const m = e.currentTarget.getBoundingClientRect();
    const x = e.clientX ? e.clientX - box.left : m.left + m.width / 2 - box.left, y = e.clientY ? e.clientY - box.top : m.top - box.top;
    setTip({ ...t, x: Math.max(70, Math.min(box.width - 70, x)), y: Math.max(30, y) });
  };
  return { tip, show, hide: () => setTip(null) };
}
const TipView = ({ tip }: { tip: Tip }) => tip ? <div className={v.tip} style={{ left: tip.x, top: tip.y }} role="status">
  <b>{tip.title}</b>{tip.lines.map((l, i) => <span key={i}>{l.s ? <i className={v.sw} data-s={l.s} /> : null}{l.label}<em>{l.value}</em></span>)}</div> : null;
const cut = (s: string, px: number, size = 11.5) => { const max = Math.max(3, Math.floor(px / (size * 0.56))); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

/** A chart block, drawn. `bare` leaves out the title (the editor's preview shows it already). */
export function DocChart({ block, bare }: { block: ChartSpec; bare?: boolean }) {
  const c = useMemo(() => tidyChart(block), [block]);
  const [asTable, setAsTable] = useState(false);
  const series = c.columns.slice(1, 1 + MAX_SERIES).map((name, i) => ({ name: name || `Series ${i + 1}`, i: i + 1, s: SERIES_ORDER[i] }));
  const hidden = c.columns.length - 1 - series.length;
  const empty = !c.rows.some((row) => row.slice(1).some((x) => typeof x === "number"));
  const summary = `${c.title || "Chart"}: ${series.map((se) => `${se.name} ${c.rows.slice(0, 24).map((row) => `${row[0]} ${formatValue(row[se.i] as number, c.unit)}`).join(", ")}`).join("; ")}`;
  const body = empty ? <p className={v.empty}>Add numbers to the table to draw the chart.</p>
    : asTable || c.type === "table" ? <DataTable columns={c.columns} rows={c.rows} unit={c.unit} />
    : c.type === "kpi" ? <Kpi block={c} />
    : c.type === "pie" ? <Donut columns={c.columns} rows={c.rows} unit={c.unit} label={summary} />
    : c.type === "scatter" ? <XY columns={c.columns} rows={c.rows} series={series} unit={c.unit} label={summary} />
    : <Cartesian type={c.type} rows={c.rows} series={series} unit={c.unit} stacked={!!c.stacked} horizontal={!!c.horizontal} label={summary} />;
  return <figure className={r.chart} data-chart-type={c.type}>
    {!bare && (c.title || c.type !== "kpi") ? <figcaption className={r.chartHead}><span className={r.chartTitle}>{c.title}</span>
      {c.type !== "table" && c.type !== "kpi" && !empty ? <button type="button" className={r.linkBtn} aria-pressed={asTable} onClick={() => setAsTable((x) => !x)}>
        {asTable ? "Show the chart" : "Show the numbers"}</button> : null}</figcaption> : null}
    {body}
    {hidden > 0 && !asTable && c.type !== "table" ? <p className={v.note}>The chart draws the first {MAX_SERIES} series; “Show the numbers” has all {c.columns.length - 1}.</p> : null}
    {c.note ? <p className={v.note}>{c.note}</p> : null}
  </figure>;
}

function DataTable({ columns, rows, unit }: { columns: string[]; rows: Cell[][]; unit?: string }) {
  return <div className={r.tableWrap}><table className={r.table}>
    <thead><tr>{columns.map((col, i) => <th key={i} scope="col" style={i ? { textAlign: "right" } : undefined}>{col}</th>)}</tr></thead>
    <tbody>{rows.map((row, j) => <tr key={j}>{columns.map((_, i) => i === 0 ? <th key={i} scope="row">{String(row[0] ?? "")}</th>
      : <td key={i}>{typeof row[i] === "number" ? formatValue(row[i] as number, unit) : ""}</td>)}</tr>)}</tbody>
  </table></div>;
}

function Kpi({ block }: { block: ReturnType<typeof tidyChart> }) {
  const k = kpiOf(block);
  if (!k) return <p className={v.empty}>Add numbers to the table.</p>;
  const pct = k.change === null ? null : Math.round(k.change * 1000) / 10;
  const [lo, hi] = [Math.min(...k.spark), Math.max(...k.spark)], W = 120, H = 32;
  const d = k.spark.map((n, i) => `${i ? "L" : "M"}${(k.spark.length > 1 ? (i / (k.spark.length - 1)) * W : W / 2).toFixed(1)},${(H - 3 - ((n - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1)}`).join("");
  return <div className={r.kpi}>
    <span className={r.kpiLabel}>{block.title || k.label}{k.at ? <small> · {k.at}</small> : null}</span>
    <span className={r.kpiValue}>{formatValue(k.value, block.unit)}</span>
    {pct !== null ? <span className={r.delta} data-tone={pct > 0 ? "up" : pct < 0 ? "down" : "flat"}>{pct > 0 ? "▲" : pct < 0 ? "▼" : "■"} {pct > 0 ? "+" : ""}{pct}%
      <small> vs {String(block.rows[block.rows.length - 2]?.[0] ?? "before")}</small></span> : null}
    {k.spark.length > 2 ? <svg className={v.svg} width={W} height={H} aria-hidden="true"><path className={v.line} data-s="accent" d={d} /></svg> : null}
  </div>;
}

type SeriesInfo = { name: string; i: number; s: Series };
/** Lines, areas and bars over the rows (stacked, side by side, or sideways), values below zero included. */
function Cartesian({ type, rows, series, unit, stacked, horizontal, label }: { type: ChartType; rows: Cell[][]; series: SeriesInfo[]; unit?: string; stacked: boolean; horizontal: boolean; label: string }) {
  const [ref, w] = useWidth(), t = useTip(), [hx, setHx] = useState<number | null>(null);
  const bar = type === "bar", side = bar && horizontal;
  const cats = rows.map((row) => String(row[0] ?? ""));
  const num = (row: Cell[], i: number) => typeof row[i] === "number" ? row[i] as number : null;
  const sums = (row: Cell[]) => { let p = 0, n = 0; for (const se of series) { const x = num(row, se.i) ?? 0; if (x >= 0) p += x; else n += x; } return [n, p]; };
  const all = stacked && (bar || type === "area") ? rows.flatMap(sums) : rows.flatMap((row) => series.map((se) => num(row, se.i)));
  const vals = all.filter((x): x is number => x !== null);
  const fromZero = bar || type === "area" || Math.min(...vals) <= 0 || Math.min(...vals) < Math.max(...vals) * 0.4;
  const ax = axis(vals, fromZero);
  const H = side ? Math.max(120, cats.length * (stacked || series.length === 1 ? 30 : 14 * series.length + 12) + 30) : w < 480 ? 210 : 260;
  const tickW = Math.max(...ax.ticks.map((n) => formatTick(n).length)) * 7 + 10;
  const catW = side ? Math.min(Math.round(w * 0.32), Math.max(...cats.map((c) => c.length)) * 7 + 10) : 0;
  const L = side ? catW : tickW, R = side ? 12 : 12, T = 10, B = 24, iw = w - L - R, ih = H - T - B;
  const V = (n: number) => side ? L + ((n - ax.min) / (ax.max - ax.min)) * iw : T + ih - ((n - ax.min) / (ax.max - ax.min)) * ih;
  const band = (side ? ih : iw) / Math.max(1, cats.length);
  const C = (i: number) => (side ? T : L) + band * i + band / 2;
  const P = (i: number) => bar ? C(i) : L + (cats.length > 1 ? (i / (cats.length - 1)) * iw : iw / 2);
  const every = Math.max(1, Math.ceil(cats.length / Math.max(2, Math.floor(iw / (bar ? 46 : 64)))));
  const zero = V(Math.max(ax.min, Math.min(ax.max, 0)));
  const tipFor = (i: number) => ({ title: cats[i], lines: series.map((se) => ({ label: se.name, value: formatValue(num(rows[i], se.i), unit), s: series.length > 1 ? se.s : undefined })) });
  const thick = Math.max(2, Math.min(24, (stacked || series.length === 1 ? band * 0.62 : (band * 0.78) / series.length)));
  const marks: ReactNode[] = [];
  if (bar) {
    rows.forEach((row, i) => {
      let up = 0, down = 0;
      series.forEach((se, k) => {
        const x = num(row, se.i); if (x === null) return;
        let a: number, b: number;
        if (stacked) { if (x >= 0) { a = up; up += x; b = up; } else { a = down; down += x; b = down; } } else { a = 0; b = x; }
        const p0 = V(a), p1 = V(b), at = stacked || series.length === 1 ? C(i) - thick / 2 : C(i) - (thick * series.length + 2 * (series.length - 1)) / 2 + k * (thick + 2);
        const lo = Math.min(p0, p1), len = Math.max(1, Math.abs(p1 - p0) - (stacked && k < series.length - 1 ? 2 : 0));
        marks.push(side ? <rect key={`${i}-${k}`} data-s={se.s} x={lo} y={at} width={len} height={thick} rx={Math.min(4, thick / 2)} />
          : <rect key={`${i}-${k}`} data-s={se.s} x={at} y={lo} width={thick} height={len} rx={Math.min(4, thick / 2)} />);
      });
    });
  } else {
    let below: number[] = rows.map(() => 0);
    series.forEach((se) => {
      const pts = rows.map((row, i) => { const x = num(row, se.i); if (x === null) return null; const base = stacked ? below[i] : 0; return [P(i), V(x + base), base] as const; });
      const runs: (readonly [number, number, number])[][] = [[]];
      pts.forEach((p) => { if (p) runs[runs.length - 1].push(p); else if (runs[runs.length - 1].length) runs.push([]); });
      runs.filter((run) => run.length).forEach((run, k) => {
        const d = run.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
        if (type === "area") {
          const floor = run.slice().reverse().map((p) => `L${p[0].toFixed(1)},${(stacked ? V(p[2]) : zero).toFixed(1)}`).join("");
          marks.push(<path key={`a${se.i}-${k}`} className={v.area} data-s={se.s} d={`${d}${floor}Z`} />);
        }
        marks.push(<path key={`l${se.i}-${k}`} className={v.line} data-s={se.s} d={d} />);
      });
      if (rows.length <= 24) pts.forEach((p, i) => { if (p) marks.push(<circle key={`d${se.i}-${i}`} className={v.ring} data-s={se.s} cx={p[0]} cy={p[1]} r={hx === i ? 5 : 3.5} />); });
      if (stacked) below = rows.map((row, i) => below[i] + (num(row, se.i) ?? 0));
    });
  }
  // a direct label where it helps: the value at each bar's end for one short series, the last value of each line
  const labels: ReactNode[] = [];
  if (bar && series.length === 1 && rows.length <= 12) rows.forEach((row, i) => {
    const x = num(row, 1); if (x === null) return;
    labels.push(side ? <text key={`v${i}`} x={V(x) + (x < 0 ? -4 : 4)} y={C(i) + 4} textAnchor={x < 0 ? "end" : "start"} className={v.strong}>{formatTick(x)}</text>
      : <text key={`v${i}`} x={C(i)} y={V(x) + (x < 0 ? 13 : -5)} textAnchor="middle" className={v.strong}>{formatTick(x)}</text>);
  });
  if (!bar && series.length === 1 && rows.length > 1) { const last = rows.length - 1, x = num(rows[last], 1); if (x !== null) labels.push(<text key="end" x={P(last)} y={V(x) - 9} textAnchor="end" className={v.strong}>{formatValue(x, unit)}</text>); }
  const move = (e: ReactPointerEvent<SVGRectElement>) => {
    const b = e.currentTarget.getBoundingClientRect(), pos = side ? e.clientY - b.top : e.clientX - b.left;
    const i = bar ? Math.floor(pos / band) : Math.round((pos / (side ? ih : iw)) * Math.max(1, cats.length - 1));
    const k = Math.max(0, Math.min(cats.length - 1, i)); setHx(k); t.show(e, tipFor(k));
  };
  return <div className={v.viz} ref={ref}>
    {series.length > 1 ? <Legend items={series.map((se) => ({ label: se.name, s: se.s, line: !bar }))} /> : null}
    <div data-tipbox="" style={{ position: "relative" }}>
      <svg className={v.svg} width={w} height={H} role="img" aria-label={label}>
        {ax.ticks.map((n) => side
          ? <g key={n}><line className={v.grid} x1={V(n)} x2={V(n)} y1={T} y2={T + ih} /><text x={V(n)} y={H - 6} textAnchor="middle">{formatTick(n)}</text></g>
          : <g key={n}><line className={v.grid} x1={L} x2={w - R} y1={V(n)} y2={V(n)} /><text x={L - 6} y={V(n) + 4} textAnchor="end">{formatTick(n)}</text></g>)}
        {cats.map((cat, i) => i % every === 0 || (!bar && i === cats.length - 1) ? side
          ? <text key={`c${i}`} x={L - 6} y={C(i) + 4} textAnchor="end" className={v.ink}>{cut(cat, catW - 8)}</text>
          // DOCS-POLISH: a bar's name that does not fit is drawn a little smaller before it is cut ("Bengaluru" on a phone)
          : <text key={`c${i}`} x={P(i)} y={H - 6} textAnchor={!bar && i === 0 && cats.length > 1 ? "start" : !bar && i === cats.length - 1 && cats.length > 1 ? "end" : "middle"}
            fontSize={bar && cat.length > Math.floor((band * every - 4) / (11.5 * 0.56)) ? 9.5 : undefined}>{cut(cat, bar ? band * every - 4 : 90, bar && cat.length > Math.floor((band * every - 4) / (11.5 * 0.56)) ? 9.5 : 11.5)}</text> : null)}
        {marks}{labels}
        {hx !== null && !bar ? <line className={v.base} x1={P(hx)} x2={P(hx)} y1={T} y2={T + ih} /> : null}
        {side ? <line className={v.base} x1={zero} x2={zero} y1={T} y2={T + ih} /> : <line className={v.base} x1={L} x2={w - R} y1={zero} y2={zero} />}
        <rect className={v.hit} x={side ? L : L - (bar ? 0 : 10)} y={T} width={side ? iw : iw + (bar ? 0 : 20)} height={ih} tabIndex={0} aria-label={label}
          onPointerMove={move} onPointerLeave={() => { setHx(null); t.hide(); }}
          onFocus={(e) => { const k = cats.length - 1; setHx(k); t.show({ currentTarget: e.currentTarget }, tipFor(k)); }}
          onKeyDown={(e) => { if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return; e.preventDefault();
            const k = Math.max(0, Math.min(cats.length - 1, (hx ?? cats.length - 1) + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1))); setHx(k); t.show({ currentTarget: e.currentTarget }, tipFor(k)); }}
          onBlur={() => { setHx(null); t.hide(); }} />
      </svg><TipView tip={t.tip} /></div></div>;
}

/** Points: the first column is x, each other column a group of y values. */
function XY({ columns, rows, series, unit, label }: { columns: string[]; rows: Cell[][]; series: SeriesInfo[]; unit?: string; label: string }) {
  const [ref, w] = useWidth(), t = useTip();
  const pts = rows.flatMap((row) => { const x = cellNumber(row[0]); return x === null ? [] : series.flatMap((se) => typeof row[se.i] === "number" ? [{ x, y: row[se.i] as number, se }] : []); });
  if (!pts.length) return <p className={v.empty}>Scatter needs numbers in the first column (x) and the others (y).</p>;
  const ax = axis(pts.map((p) => p.x), false), ay = axis(pts.map((p) => p.y), false), H = w < 480 ? 220 : 280;
  const tickW = Math.max(...ay.ticks.map((n) => formatTick(n).length)) * 7 + 10, L = tickW, R = 12, T = 10, B = 40, iw = w - L - R, ih = H - T - B;
  const X = (n: number) => L + ((n - ax.min) / (ax.max - ax.min)) * iw, Y = (n: number) => T + ih - ((n - ay.min) / (ay.max - ay.min)) * ih;
  return <div className={v.viz} ref={ref}>
    {series.length > 1 ? <Legend items={series.map((se) => ({ label: se.name, s: se.s }))} /> : null}
    <div data-tipbox="" style={{ position: "relative" }}>
      <svg className={v.svg} width={w} height={H} role="img" aria-label={label}>
        {ay.ticks.map((n) => <g key={`y${n}`}><line className={v.grid} x1={L} x2={w - R} y1={Y(n)} y2={Y(n)} /><text x={L - 6} y={Y(n) + 4} textAnchor="end">{formatTick(n)}</text></g>)}
        {ax.ticks.map((n) => <text key={`x${n}`} x={X(n)} y={T + ih + 16} textAnchor="middle">{formatTick(n)}</text>)}
        <text x={L + iw / 2} y={H - 4} textAnchor="middle" className={v.ink}>{columns[0]}</text>
        <line className={v.base} x1={L} x2={w - R} y1={T + ih} y2={T + ih} />
        {pts.map((p, i) => <circle key={i} className={`${v.mark} ${v.ring}`} data-s={p.se.s} cx={X(p.x)} cy={Y(p.y)} r={4.5} tabIndex={0} fillOpacity={0.85}
          aria-label={`${p.se.name}: ${columns[0]} ${formatTick(p.x)}, ${formatValue(p.y, unit)}`}
          onPointerMove={(e) => t.show(e, { title: p.se.name, lines: [{ label: columns[0], value: formatTick(p.x) }, { label: "Value", value: formatValue(p.y, unit) }] })}
          onFocus={(e) => t.show({ currentTarget: e.currentTarget }, { title: p.se.name, lines: [{ label: columns[0], value: formatTick(p.x) }, { label: "Value", value: formatValue(p.y, unit) }] })}
          onPointerLeave={t.hide} onBlur={t.hide} />)}
      </svg><TipView tip={t.tip} /></div></div>;
}

/** A pie as a ring: the first series' parts, five at most (the rest is "Other"), each named with its share underneath. */
function Donut({ columns, rows, unit, label }: { columns: string[]; rows: Cell[][]; unit?: string; label: string }) {
  const t = useTip();
  const parts0 = rows.map((row) => ({ name: String(row[0] ?? ""), value: typeof row[1] === "number" && (row[1] as number) > 0 ? row[1] as number : 0 })).filter((p) => p.value > 0);
  const top = [...parts0].sort((a, b) => b.value - a.value);
  const parts = top.length > MAX_SERIES ? [...top.slice(0, MAX_SERIES - 1), { name: "Other", value: top.slice(MAX_SERIES - 1).reduce((a, p) => a + p.value, 0) }] : top;
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <p className={v.empty}>A pie needs numbers above zero in the second column.</p>;
  const S = 200, R0 = 92, R1 = 58, cx = S / 2, cy = S / 2;
  const starts = parts.map((_, i) => -Math.PI / 2 + (parts.slice(0, i).reduce((a, q) => a + q.value, 0) / total) * Math.PI * 2);
  const arcs = parts.map((p, i) => {
    const a0 = starts[i], a1 = a0 + (p.value / total) * Math.PI * 2, gap = parts.length > 1 ? 0.012 : 0;
    const pt = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
    const big = a1 - a0 > Math.PI ? 1 : 0, s = a0 + gap, e = Math.max(s + 0.001, a1 - gap);
    const d = parts.length === 1 ? `M${cx},${cy - R0}A${R0},${R0} 0 1 1 ${cx - 0.01},${cy - R0}L${cx - 0.01},${cy - R1}A${R1},${R1} 0 1 0 ${cx},${cy - R1}Z`
      : `M${pt(R0, s)}A${R0},${R0} 0 ${big} 1 ${pt(R0, e)}L${pt(R1, e)}A${R1},${R1} 0 ${big} 0 ${pt(R1, s)}Z`;
    return { ...p, d, s: (p.name === "Other" ? "muted" : SERIES_ORDER[i]) as Series };
  });
  const share = (n: number) => `${Math.round((n / total) * 1000) / 10}%`;
  return <div className={`${v.viz} ${r.pie}`}><div data-tipbox="" style={{ position: "relative" }}>
    <svg className={v.svg} viewBox={`0 0 ${S} ${S}`} width={S} height={S} role="img" aria-label={label} style={{ width: S, maxWidth: "100%" }}>
      {arcs.map((p) => <path key={p.name} className={v.mark} data-s={p.s} d={p.d} tabIndex={0} aria-label={`${p.name} ${formatValue(p.value, unit)}, ${share(p.value)}`}
        onPointerMove={(e) => t.show(e, { title: p.name, lines: [{ label: columns[1] || "Value", value: formatValue(p.value, unit) }, { label: "Share", value: share(p.value) }] })}
        onFocus={(e) => t.show({ currentTarget: e.currentTarget }, { title: p.name, lines: [{ label: columns[1] || "Value", value: formatValue(p.value, unit) }, { label: "Share", value: share(p.value) }] })}
        onPointerLeave={t.hide} onBlur={t.hide} />)}
      <text x={cx} y={cy - 2} textAnchor="middle" className={v.strong} style={{ fontSize: 16 }}>{formatTick(total)}</text>
      <text x={cx} y={cy + 15} textAnchor="middle">{cut(columns[1] || "Total", 100)}</text>
    </svg><TipView tip={t.tip} /></div>
    <Legend items={arcs.map((p) => ({ label: <>{p.name} <b style={{ color: "var(--theme-text)" }}>{share(p.value)}</b></>, s: p.s }))} />
  </div>;
}

// ------------------------------------------------------------------------------------------------ editing
type Tab = "table" | "csv" | "json";
/** The chart's editor: its type, title and unit, its data (a table, pasted CSV or JSON), and the chart redrawn beside it. */
export function ChartEditor({ block, onChange }: { block: ChartBlock; onChange: (b: ChartBlock) => void }) {
  const c = tidyChart(block);
  const [tab, setTab] = useState<Tab>("table");
  const [gen, setGen] = useState(0); // a new table draft after CSV or JSON replaced the data
  const set = (part: Partial<ChartBlock>) => onChange({ ...block, ...part });
  return <div className={r.chartEdit}>
    <div className={r.preview} aria-label="Preview"><DocChart block={c} /></div>
    <div className={r.panel}>
      <div className={r.chips} role="radiogroup" aria-label="Chart type">{CHART_TYPES.map((x) => { const I = x.icon; return <button key={x.type} type="button" role="radio" aria-checked={c.type === x.type}
        className={r.chip} onClick={() => set({ type: x.type })}><I size={15} aria-hidden="true" />{x.label}</button>; })}</div>
      <div className={r.twoFields}>
        <label className={r.field}>Title<input value={block.title ?? ""} maxLength={120} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Revenue vs cost" /></label>
        <label className={r.field}>Unit<input value={block.unit ?? ""} maxLength={16} onChange={(e) => set({ unit: e.target.value })} placeholder="₹ lakh, %, hours" /></label>
      </div>
      {c.type === "bar" || c.type === "area" ? <div className={r.checks}>
        <label><input type="checkbox" checked={!!block.stacked} onChange={(e) => set({ stacked: e.target.checked })} />Stack the series</label>
        {c.type === "bar" ? <label><input type="checkbox" checked={!!block.horizontal} onChange={(e) => set({ horizontal: e.target.checked })} />Bars sideways</label> : null}
      </div> : null}
      <div className={r.tabs} role="tablist" aria-label="The data">{(["table", "csv", "json"] as const).map((x) => <button key={x} type="button" role="tab" aria-selected={tab === x} className={r.tab}
        onClick={() => setTab(x)}>{x === "table" ? "Table" : x === "csv" ? "Paste CSV" : "JSON"}</button>)}</div>
      {tab === "table" ? <Grid key={gen} columns={c.columns} rows={c.rows} scatter={c.type === "scatter"} onChange={(columns, rows) => set({ columns, rows })} />
        : tab === "csv" ? <CsvBox columns={c.columns} rows={c.rows} onUse={(columns, rows) => { set({ columns, rows }); setGen((g) => g + 1); setTab("table"); }} />
        : <JsonBox block={c} onUse={(b) => { onChange({ ...b, kind: "chart", id: block.id }); setGen((g) => g + 1); setTab("table"); }} />}
      <label className={r.field}>Note under the chart (optional)<input value={block.note ?? ""} maxLength={300} onChange={(e) => set({ note: e.target.value })} placeholder="Source: CRM, October" /></label>
    </div>
  </div>;
}

/** The data as a table to type in: names in the first column, numbers in the others. */
function Grid({ columns, rows, scatter, onChange }: { columns: string[]; rows: Cell[][]; scatter: boolean; onChange: (columns: string[], rows: Cell[][]) => void }) {
  const [draft, setDraft] = useState(() => rows.map((row) => columns.map((_, i) => row[i] === null || row[i] === undefined ? "" : String(row[i]))));
  const [cols, setCols] = useState(columns);
  const commit = (cs: string[], d: string[][]) => { setCols(cs); setDraft(d); onChange(cs, d.map((row) => cs.map((_, i) => i === 0 ? (scatter && cellNumber(row[0]) !== null ? cellNumber(row[0]) : row[0]) : cellNumber(row[i] ?? "")))); };
  const cell = (j: number, i: number, val: string) => commit(cols, draft.map((row, y) => y === j ? row.map((x, k) => k === i ? val : x) : row));
  return <div className={r.gridWrap}>
    <table className={r.grid}>
      <thead><tr>{cols.map((col, i) => <th key={i}><span className={r.headCell}>
        <input value={col} maxLength={60} aria-label={i === 0 ? "Name of the first column" : `Name of series ${i}`} onChange={(e) => commit(cols.map((x, k) => k === i ? e.target.value : x), draft)} />
        {i > 0 && cols.length > 2 ? <button type="button" className={r.iconBtn} aria-label={`Remove the column “${col}”`} onClick={() => commit(cols.filter((_, k) => k !== i), draft.map((row) => row.filter((_, k) => k !== i)))}><X size={13} aria-hidden="true" /></button> : null}
      </span></th>)}<th aria-hidden="true" /></tr></thead>
      <tbody>{draft.map((row, j) => <tr key={j}>{cols.map((_, i) => <td key={i}>
        <input value={row[i] ?? ""} inputMode={i === 0 && !scatter ? "text" : "decimal"} aria-label={`${cols[i] || "Cell"}, row ${j + 1}`} data-num={i > 0 ? "" : undefined}
          onChange={(e) => cell(j, i, e.target.value)}
          onPaste={(e) => { const text = e.clipboardData.getData("text"); if (!/[\t\n]/.test(text)) return; e.preventDefault();
            const p = parseCsv(`${cols.join("\t")}\n${text}`); const next = draft.slice(0, j).concat(p.rows.map((r2) => cols.map((_, k) => r2[k] === null || r2[k] === undefined ? "" : String(r2[k]))));
            commit(cols, next.concat(draft.slice(j + p.rows.length)).slice(0, 500)); }} /></td>)}
        <td><button type="button" className={r.iconBtn} aria-label={`Remove row ${j + 1}`} onClick={() => commit(cols, draft.filter((_, y) => y !== j))}><X size={13} aria-hidden="true" /></button></td></tr>)}</tbody>
    </table>
    <div className={r.rowBtns}>
      <button type="button" className={r.btn} disabled={draft.length >= 500} onClick={() => commit(cols, [...draft, cols.map(() => "")])}><Plus size={15} aria-hidden="true" />Row</button>
      <button type="button" className={r.btn} disabled={cols.length >= 12} onClick={() => commit([...cols, `Series ${cols.length}`], draft.map((row) => [...row, ""]))}><Plus size={15} aria-hidden="true" />Column</button>
      <span className={r.hint}>Paste rows from a spreadsheet into any cell.</span>
    </div>
  </div>;
}

function CsvBox({ columns, rows, onUse }: { columns: string[]; rows: Cell[][]; onUse: (c: string[], r: Cell[][]) => void }) {
  const [text, setText] = useState(() => toCsv(columns, rows));
  const parsed = parseCsv(text);
  return <div className={r.form}>
    <label className={r.field}>Paste CSV or rows from a spreadsheet. The first row names the columns.
      <textarea className={r.code} rows={8} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></label>
    <p className={r.hint}>{parsed.columns.length ? `${parsed.rows.length} rows, ${parsed.columns.length} columns: ${parsed.columns.join(", ")}` : "Nothing pasted yet."}</p>
    <button type="button" className={`${r.btn} ${r.primary}`} disabled={!parsed.rows.length} onClick={() => onUse(parsed.columns, parsed.rows)}>Use this data</button>
  </div>;
}

function JsonBox({ block, onUse }: { block: ChartSpec; onUse: (b: ChartSpec) => void }) {
  const { type, title, unit, columns, rows, stacked, horizontal, note } = block;
  const [text, setText] = useState(() => JSON.stringify({ type, title, unit, columns, rows, stacked, horizontal, note }, null, 1));
  const [error, setError] = useState<string | null>(null);
  return <div className={r.form}>
    <label className={r.field}>The chart as JSON: type, title, unit, columns, rows (and stacked, horizontal, note)
      <textarea className={r.code} rows={10} value={text} onChange={(e) => { setText(e.target.value); setError(null); }} spellCheck={false} /></label>
    {error ? <p className={r.error} role="alert">{error}</p> : null}
    <button type="button" className={`${r.btn} ${r.primary}`} onClick={() => {
      try { const b = JSON.parse(text); if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("x"); onUse(tidyChart(b)); }
      catch { setError("That is not JSON yet. Check the commas and quotes."); }
    }}>Use this JSON</button>
  </div>;
}
