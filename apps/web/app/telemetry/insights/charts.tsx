"use client";
// TOKENS-TELEMETRY: the Insights charts (Apache ECharts, tree-shaken: only the charts and parts used here, loaded when
// this screen opens, never on other pages). Colours: a validated categorical palette with its own dark-mode steps
// (adjacent CVD ΔE ≥ 8), text in the theme's ink, one y-axis per chart, a tooltip on every chart, a legend for two or
// more series. Each chart redraws when the theme changes and fits its box on any width.
import { useEffect, useRef } from "react";
import css from "./insights.module.css";
import { typeName } from "./words";

type Opt = Record<string, unknown>;
const SERIES = { light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"], dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"] };
type Ink = { text: string; muted: string; border: string; surface: string; series: string[]; dark: boolean };

function ink(): Ink {
  const root = document.documentElement, cs = getComputedStyle(root);
  const dark = root.dataset.theme === "dark" || (root.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
  return { dark, text: v("--theme-text", dark ? "#f0efec" : "#1e1b2e"), muted: v("--theme-text-muted", dark ? "#c3c2b7" : "#6b6880"), border: v("--theme-border", dark ? "#333" : "#e6e4ee"), surface: v("--theme-surface", dark ? "#1a1a19" : "#fff"), series: dark ? SERIES.dark : SERIES.light };
}

let loaded: Promise<typeof import("echarts/core")> | null = null;
function echarts() {
  loaded ??= Promise.all([import("echarts/core"), import("echarts/charts"), import("echarts/components"), import("echarts/renderers")]).then(([core, charts, comps, r]) => {
    core.use([charts.LineChart, charts.BarChart, charts.SankeyChart, comps.GridComponent, comps.TooltipComponent, comps.LegendComponent, comps.MarkLineComponent, r.CanvasRenderer]);
    return core;
  });
  return loaded;
}

/** One chart: `build` turns the theme's ink into an ECharts option (so tooltips and labels can be functions). */
function Chart({ build, height, label }: { build: (i: Ink, narrow: boolean) => Opt; height: number; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const draw = useRef(build);
  useEffect(() => { draw.current = build; });
  useEffect(() => {
    let dead = false, chart: import("echarts/core").ECharts | null = null, ro: ResizeObserver | null = null, mo: MutationObserver | null = null;
    void echarts().then((core) => {
      if (dead || !el.current) return;
      chart = core.init(el.current, undefined, { renderer: "canvas" });
      // Screenshots and tests wait for this: the chart has finished drawing (ECharts loads on demand and animates).
      chart.on("finished", () => { el.current?.setAttribute("data-drawn", ""); });
      const paint = () => { if (chart && el.current) chart.setOption(draw.current(ink(), el.current.clientWidth < 560), true); };
      paint();
      let w = el.current.clientWidth;
      ro = new ResizeObserver(() => { const nw = el.current?.clientWidth ?? w; if ((nw < 560) !== (w < 560)) paint(); w = nw; chart?.resize(); });
      ro.observe(el.current);
      mo = new MutationObserver(paint); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    });
    return () => { dead = true; ro?.disconnect(); mo?.disconnect(); chart?.dispose(); };
  }, []);
  return <div ref={el} className={css.chart} role="img" aria-label={label} style={{ height }} />;
}

const secs = (ms: number) => (ms === 0 ? "0 s" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
const tokens = (n: number) => (n >= 1e7 ? `${(n / 1e7).toFixed(1)} crore` : n >= 1e5 ? `${+(n / 1e5).toFixed(1)} lakh` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const short = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${d}T00:00:00Z`));
function base(i: Ink, narrow: boolean, extra: Opt = {}): Opt {
  return {
    textStyle: { color: i.text, fontFamily: "inherit" }, animationDuration: 300,
    grid: { left: narrow ? 44 : 56, right: narrow ? 12 : 24, top: 36, bottom: 28, containLabel: false },
    legend: { top: 0, left: 0, textStyle: { color: i.muted, fontSize: 13 }, itemWidth: 14, itemHeight: 8, icon: "roundRect" },
    tooltip: { trigger: "axis", backgroundColor: i.surface, borderColor: i.border, textStyle: { color: i.text, fontSize: 12 }, axisPointer: { type: "line", lineStyle: { color: i.border } } },
    ...extra,
  };
}
const xDays = (i: Ink, days: string[]) => ({ type: "category", data: days, boundaryGap: false, axisLine: { lineStyle: { color: i.border } }, axisTick: { show: false }, axisLabel: { color: i.muted, fontSize: 12, formatter: short, hideOverlap: true } });
const yAxis = (i: Ink, fmt: (n: number) => string) => ({ type: "value", splitLine: { lineStyle: { color: i.border, opacity: 0.6 } }, axisLabel: { color: i.muted, fontSize: 12, formatter: fmt } });

export type SpeedRow = { day: string; kind: string; n: number; p50: number; p90: number };
const KINDS: Record<string, { label: string; target: number }> = { "nav.route": { label: "Moving between pages", target: 1000 }, "nav.load": { label: "Opening the app", target: 3000 }, api: { label: "Waiting for data", target: 800 } };
/** p50 and the slow 1 in 10 per day for one kind, with its target as a dashed line. */
export function SpeedChart({ rows, kind }: { rows: SpeedRow[]; kind: string }) {
  const k = KINDS[kind];
  const list = rows.filter((r) => r.kind === kind);
  const days = list.map((r) => r.day);
  return <Chart height={240} label={`${k.label}: usual time and slow 1 in 10, per day`} build={(i, narrow) => base(i, narrow, {
    color: [i.series[0], i.series[1]],
    tooltip: { ...(base(i, narrow).tooltip as Opt), valueFormatter: (v: number) => secs(v) },
    xAxis: xDays(i, days), yAxis: yAxis(i, (n) => secs(n)),
    series: [
      { name: "Usual", type: "line", data: list.map((r) => r.p50), showSymbol: false, lineStyle: { width: 2 }, symbolSize: 8 },
      { name: "Slowest 1 in 10", type: "line", data: list.map((r) => r.p90), showSymbol: false, lineStyle: { width: 2 }, symbolSize: 8,
        markLine: { silent: true, symbol: "none", label: { color: i.muted, formatter: `Target ${secs(k.target)}`, position: "insideEndTop", fontSize: 12 }, lineStyle: { color: i.muted, type: "dashed", width: 1 }, data: [{ yAxis: k.target }] } },
    ],
  })} />;
}

export type PageRow = { day: string; page: string; n: number; p90: number };
export function PagesChart({ rows }: { rows: PageRow[] }) {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const pages = [...new Set(rows.map((r) => r.page))];
  return <Chart height={260} label="The five most opened pages: slow 1 in 10 per day" build={(i, narrow) => base(i, narrow, {
    color: i.series, grid: { left: narrow ? 40 : 56, right: narrow ? 92 : 110, top: 16, bottom: 28 },
    legend: { ...(base(i, narrow).legend as Opt), show: false },
    tooltip: { ...(base(i, narrow).tooltip as Opt), valueFormatter: (v: number) => (v === null || v === undefined ? "no moves" : secs(v)) },
    xAxis: xDays(i, days), yAxis: yAxis(i, secs),
    series: pages.map((p, k) => ({ name: p, type: "line", connectNulls: true, showSymbol: false, lineStyle: { width: 2 }, symbolSize: 8, endLabel: { show: true, formatter: "{a}", color: i.text, fontSize: 12, distance: 6 }, labelLayout: { moveOverlap: "shiftY" }, data: days.map((d) => rows.find((r) => r.day === d && r.page === p)?.p90 ?? null),
      ...(k === 0 ? { markLine: { silent: true, symbol: "none", label: { color: i.muted, formatter: "Target 1.0 s", position: "insideStartTop", fontSize: 12 }, lineStyle: { color: i.muted, type: "dashed", width: 1 }, data: [{ yAxis: 1000 }] } } : {}) })),
  })} />;
}

export type StruggleRow = { day: string; errors: number; rage: number; dead: number; refused: number; slowStarts: number; early: number; people: number; sessions: number };
const STRUGGLE: [keyof StruggleRow, string][] = [["dead", "No answer"], ["rage", "Clicked again"], ["refused", "Refused"], ["slowStarts", "Slow to open"], ["errors", "Errors"]];
export function StruggleChart({ rows: all }: { rows: StruggleRow[] }) {
  return <Chart height={260} label="Struggle moments per day, by kind" build={(i, narrow) => { const rows = all; return base(i, narrow, {
    color: i.series, grid: { left: narrow ? 36 : 48, right: narrow ? 8 : 24, top: narrow ? 16 : 40, bottom: 28 },
    xAxis: { ...xDays(i, rows.map((r) => r.day)), boundaryGap: true }, yAxis: yAxis(i, (n) => String(n)),
    tooltip: { ...(base(i, narrow).tooltip as Opt), axisPointer: { type: "shadow" } },
    legend: { ...(base(i, narrow).legend as Opt), show: !narrow },
    series: narrow ? [{ name: "Struggle moments", type: "bar", barMaxWidth: 12, itemStyle: { color: i.series[1], borderRadius: [3, 3, 0, 0] }, data: rows.map((r) => STRUGGLE.reduce((n, [k]) => n + Number(r[k] ?? 0), 0)) }]
      : STRUGGLE.map(([k, name]) => ({ name, type: "bar", stack: "s", barMaxWidth: 18, itemStyle: { borderColor: i.surface, borderWidth: 1 }, emphasis: { focus: "series" }, data: rows.map((r) => r[k]) })),
  }); }} />;
}

export type Journey = { nodes: { name: string; step: number; page: string; views: number }[]; links: { source: string; target: string; value: number }[]; sessions: number };
/** The journey map: sessions' first four places, step by step; grey bands are people who left there. */
const rank = (page: string) => (page === "Left" ? 2 : page === "Other" ? 1 : 0);
export function JourneyChart({ data }: { data: Journey }) {
  const pages = [...new Set(data.nodes.map((n) => n.page).filter((p) => p !== "Left" && p !== "Other"))];
  return <Chart height={420} label={`How ${data.sessions} visits moved: their first four pages, and where they left`} build={(i, narrow) => {
    const colorOf = (page: string) => page === "Left" ? (i.dark ? "#6a6862" : "#a9a6b6") : page === "Other" ? (i.dark ? "#77756f" : "#9e9cab") : i.series[pages.indexOf(page) % i.series.length];
    return {
      textStyle: { color: i.text, fontFamily: "inherit" },
      tooltip: { trigger: "item", backgroundColor: i.surface, borderColor: i.border, textStyle: { color: i.text, fontSize: 12 },
        formatter: (p: { dataType: string; data: { source?: string; target?: string; value?: number; name?: string; views?: number } }) => p.dataType === "edge"
          ? `${p.data.source?.replace(/^\d · /, "")} → ${p.data.target?.replace(/^\d · /, "")}<br/><b>${p.data.value}</b> ${p.data.value === 1 ? "visit" : "visits"}`
          : `Step ${String(p.data.name).split(" · ")[0]}: ${String(p.data.name).split(" · ")[1]}<br/><b>${p.data.views}</b> visits` },
      series: [{
        type: "sankey", left: 4, right: narrow ? 80 : 96, top: 8, bottom: 8, nodeGap: narrow ? 6 : 10, nodeWidth: narrow ? 10 : 14, draggable: false, layoutIterations: 0,
        emphasis: { focus: "adjacency" }, lineStyle: { color: "gradient", opacity: i.dark ? 0.34 : 0.5, curveness: 0.5 },
        label: { color: i.text, fontSize: narrow ? 13 : 14, backgroundColor: i.dark ? "rgba(20,20,22,0.78)" : "rgba(255,255,255,0.88)", padding: [2, 5], borderRadius: 4, formatter: (p: { name: string }) => { const t = p.name.split(" · ")[1] ?? p.name; return narrow && t.length > 14 ? `${t.slice(0, 13)}…` : t; } },
        data: [...data.nodes].sort((a, b) => a.step - b.step || rank(a.page) - rank(b.page) || b.views - a.views).map((n) => ({ name: n.name, views: n.views, depth: n.step, itemStyle: { color: colorOf(n.page), borderWidth: 0 } })),
        links: data.links.map((l) => ({ ...l, lineStyle: { opacity: / · Left$/.test(l.target) ? (i.dark ? 0.12 : 0.16) : / · Other$/.test(l.target) || / · Other$/.test(l.source) || l.value < data.sessions * 0.03 ? (i.dark ? 0.16 : 0.2) : (i.dark ? 0.5 : 0.55) } })),
      }],
    };
  }} />;
}

export type Funnel = { key: string; label: string; steps: { label: string; sessions: number; kept: number | null }[] };
export type CostDay = { day: string; type: string; runs: number; tokens: number; ruled: number; saved: number; inr: number | null };
/** AI tokens per day by kind of work (stacked bars). */
export function CostChart({ rows }: { rows: CostDay[] }) {
  const allDays = [...new Set(rows.map((r) => r.day))].sort();
  const totals = new Map<string, number>(); for (const r of rows) totals.set(r.type, (totals.get(r.type) ?? 0) + r.tokens);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const shown = ranked.slice(0, 6), other = ranked.slice(6);
  const series = [...shown.map((t) => ({ t: [t], name: typeName(t) })), ...(other.length ? [{ t: other, name: "Other work" }] : [])];
  return <Chart height={260} label="AI tokens per day, by kind of work" build={(i, narrow) => { const days = allDays; return base(i, narrow, {
    color: i.series, grid: { left: narrow ? 44 : 56, right: narrow ? 8 : 24, top: narrow ? 64 : 40, bottom: 28 },
    xAxis: { ...xDays(i, days), boundaryGap: true }, yAxis: yAxis(i, tokens),
    tooltip: { ...(base(i, narrow).tooltip as Opt), axisPointer: { type: "shadow" }, valueFormatter: (v: number) => `${tokens(v)} tokens` },
    series: series.map((s) => ({ name: s.name, type: "bar", stack: "t", barMaxWidth: 18, itemStyle: { borderColor: i.surface, borderWidth: 1 }, emphasis: { focus: "series" },
      data: days.map((d) => rows.filter((r) => r.day === d && s.t.includes(r.type)).reduce((n, r) => n + r.tokens, 0)) })),
  }); }} />;
}
/** Tokens per job, week by week: model runs plus jobs a rule did (a rule's job costs nothing). Falling is the goal. */
export function PerJobChart({ rows }: { rows: CostDay[] }) {
  const week = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
  const weeks = [...new Set(rows.map((r) => week(r.day)))].sort();
  const per = (w: string, withRules: boolean) => { const g = rows.filter((r) => week(r.day) === w); const jobs = g.reduce((n, r) => n + r.runs + (withRules ? r.ruled : 0), 0); return jobs ? Math.round(g.reduce((n, r) => n + r.tokens, 0) / jobs) : null; };
  return <Chart height={240} label="AI tokens per job, week by week" build={(i, narrow) => base(i, narrow, {
    color: [i.series[0], i.series[2]],
    xAxis: { ...xDays(i, weeks), axisLabel: { color: i.muted, fontSize: 12, formatter: (d: string) => `wk ${short(d)}`, hideOverlap: true } }, yAxis: yAxis(i, tokens),
    tooltip: { ...(base(i, narrow).tooltip as Opt), valueFormatter: (v: number) => (v === null || v === undefined ? "–" : `${tokens(v)} tokens`) },
    series: [
      { name: "Per model run", type: "line", data: weeks.map((w) => per(w, false)), symbolSize: 8, lineStyle: { width: 2 } },
      { name: "Per job, rules included", type: "line", data: weeks.map((w) => per(w, true)), symbolSize: 8, lineStyle: { width: 2 } },
    ],
  })} />;
}
