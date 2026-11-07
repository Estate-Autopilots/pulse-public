// INSIGHTS-2 (1082): the chart system behind Insights, as plain functions the renderer (app/insights/viz.tsx) and the
// tests share: one vocabulary of chart kinds (with the aliases PATTERNS writes), rows normalised from a spec's field
// mapping, the shared filters applied to rows that carry them, percentiles read from binned counts, a nice scale, the
// clients' active window, CSV export and the units Insights writes. No React, no DOM.

/** The kinds the renderer draws, and the names other producers use for them. */
export const KINDS = ["kpis", "bars", "columns", "stacked", "line", "heatmap", "distribution", "flow", "funnel", "scatter", "split", "multiples", "forest", "sankey", "table"];
const ALIAS = { kpi: "kpis", bar: "bars", hbar: "bars", column: "columns", stacked_bar: "stacked", area: "line", curve: "line", histogram: "distribution", matrix: "heatmap", swimlane: "flow" };

/** The kind a spec asks for, or null when the renderer has no such chart (the card then shows its numbers only). */
export function kindOf(spec) {
  const k = String(spec?.kind ?? "").toLowerCase();
  const kind = ALIAS[k] ?? k;
  return KINDS.includes(kind) ? kind : null;
}

const fieldOf = (axis) => typeof axis === "string" ? axis : axis && typeof axis === "object" && typeof axis.field === "string" ? axis.field : null;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => isNum(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

/** Rows in the renderer's own field names. A spec may map fields (`x: {field}`, `y: {field}`, `series: {field}`,
 *  `size`, `label`); otherwise the rows already use the kind's names (label/value, x/value, row/col/value, ...). */
export function normalize(spec, data) {
  const kind = kindOf(spec);
  const rows = Array.isArray(data) ? data.filter((r) => r && typeof r === "object") : [];
  if (!kind) return { kind: null, rows: [] };
  const fx = fieldOf(spec?.x), fy = fieldOf(spec?.y), fs = fieldOf(spec?.series), fc = fieldOf(spec?.color), fz = fieldOf(spec?.size), fl = fieldOf(spec?.label);
  const out = rows.map((r) => {
    const o = { ...r };
    if (kind === "bars" || kind === "funnel" || kind === "split" || kind === "forest") {
      // the category is whichever mapped field holds words, the value the one holding numbers
      const cand = [fx, fy].filter(Boolean);
      const vf = cand.find((f) => num(r[f]) !== null && typeof r[f] !== "string") ?? cand.find((f) => num(r[f]) !== null);
      const lf = cand.find((f) => f !== vf);
      if (lf && o.label === undefined) o.label = r[lf];
      if (vf && o.value === undefined) o.value = r[vf];
      if (kind === "funnel" && o.step === undefined) o.step = o.label;
    } else if (kind === "heatmap") {
      if (fx && o.col === undefined) o.col = r[fx];
      if (fy && o.row === undefined) o.row = r[fy];
      const vf = fieldOf(spec?.value) ?? fc;
      if (vf && o.value === undefined) o.value = r[vf];
    } else if (kind === "scatter") {
      if (fx && o.x === undefined) o.x = r[fx];
      if (fy && o.y === undefined) o.y = r[fy];
      if (fz && o.size === undefined) o.size = r[fz];
      if (fl && o.label === undefined) o.label = r[fl];
      if (fc && o.group === undefined) o.group = r[fc];
    } else {
      if (fx && o.x === undefined) o.x = r[fx];
      if (fy && o.value === undefined) o.value = r[fy];
      if (fs && o.series === undefined) o.series = r[fs];
      if (kind === "distribution" && o.bin === undefined) o.bin = o.x;
    }
    if (kind === "funnel" && o.step === undefined) o.step = o.label ?? o.x;
    if (o.value !== undefined) o.value = num(o.value);
    if (kind === "scatter") { o.x = num(o.x); o.y = num(o.y); o.size = num(o.size); }
    return o;
  });
  return { kind, rows: kind === "scatter" ? out.filter((r) => r.x !== null && r.y !== null) : out };
}

export const FACETS = ["pod", "segment", "service", "client"];

/** The shared filters applied to a card's rows: rows that carry a filtered field keep only the chosen value; `agg: "sum"`
 *  then adds up rows that land on the same key (`keys`), `agg: "pick"` keeps the rows made for that value ("*" = all).
 *  A filter the rows do not carry is reported, so the card can say it shows everything for that one. */
export function applyFilters(rows, spec, filters = {}, keys = ["label", "x", "row", "col", "series", "bin", "step", "stage"]) {
  const facets = (Array.isArray(spec?.facets) ? spec.facets : FACETS).filter((f) => rows.some((r) => r[f] !== undefined && r[f] !== null));
  const pick = spec?.agg === "pick";
  let out = rows, ignored = [];
  for (const f of FACETS) {
    const want = filters[f];
    if (!facets.includes(f)) { if (want) ignored.push(f); continue; }
    if (want) out = out.filter((r) => r[f] === undefined || r[f] === null ? !pick : String(r[f]) === String(want));
    else if (pick) out = out.filter((r) => r[f] === undefined || r[f] === null || r[f] === "*");
  }
  if (filters.since && rows.some((r) => typeof r.month === "string")) out = out.filter((r) => typeof r.month !== "string" || r.month >= String(filters.since).slice(0, 7));
  if (!pick && facets.length) {
    const m = new Map();
    for (const r of out) {
      const k = keys.map((x) => r[x] ?? "").join("\u0001");
      const prev = m.get(k);
      if (prev) prev.value = (prev.value ?? 0) + (num(r.value) ?? 0);
      else { const o = { ...r, value: num(r.value) }; for (const f of facets) delete o[f]; m.set(k, o); }
    }
    out = [...m.values()];
  }
  return { rows: out, ignored };
}

/** The q-th quantile (0..1) of binned counts [{lo, hi, n}], interpolated inside the bin; an open last bin reads as its lo. */
export function quantileFromBins(bins, q) {
  const total = bins.reduce((s, b) => s + (b.n ?? 0), 0);
  if (!total) return null;
  const target = q * total;
  let seen = 0;
  for (const b of bins) {
    const n = b.n ?? 0;
    if (seen + n >= target && n > 0) {
      if (b.hi === null || b.hi === undefined) return b.lo;
      return b.lo + ((target - seen) / n) * (b.hi - b.lo);
    }
    seen += n;
  }
  return bins[bins.length - 1]?.lo ?? null;
}

/** A round top for a scale: 1, 2, 2.5, 5 x 10^n at or above the largest value. */
export function niceTop(max) {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/** A round step (1, 2, 5 x 10^n) at or above x: tick spacing that never needs decimals for whole data. */
export function niceStep(x) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

/** Evenly spaced ticks from 0 to a nice top. */
export function ticks(max, n = 4) {
  const top = niceTop(max);
  return Array.from({ length: n + 1 }, (_, i) => Math.round((top / n) * i * 1000) / 1000);
}

/** A heat step 0..6 for a cell (0 = nothing), on a square-root scale so quiet hours stay visible next to busy ones. */
export function heatStep(v, max) {
  if (!(v > 0) || !(max > 0)) return 0;
  return Math.max(1, Math.min(6, Math.ceil(Math.sqrt(v / max) * 6)));
}

/** The busiest run of `width` consecutive hours (24 counts): where the clients are, to highlight on the heatmap. */
export function activeWindow(hours, width = 6) {
  const h = Array.from({ length: 24 }, (_, i) => num(hours?.[i]) ?? 0);
  const total = h.reduce((s, x) => s + x, 0);
  if (!total) return null;
  let best = 0, start = 0;
  for (let s = 0; s + width <= 24; s++) {
    const sum = h.slice(s, s + width).reduce((a, x) => a + x, 0);
    if (sum > best) { best = sum; start = s; }
  }
  return { start, end: start + width, share: best / total };
}

/** Rows as CSV (a header from every key seen; quotes where needed; objects as JSON). */
export function toCsv(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

/** Minutes of working time in words: 8 min, 1.5 h, 2.3 days (a working day is 9 hours). */
export function minutes(m) {
  if (!isNum(m)) return "–";
  if (m < 1) return "<1 min";
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 540) return `${Math.round(m / 6) / 10} h`;
  return `${Math.round(m / 54) / 10} days`;
}

/** Days in words: 0.4 days -> "10 h", 7.7 -> "7.7 days". */
export function days(d) {
  if (!isNum(d)) return "–";
  if (d < 1) return `${Math.round(d * 24)} h`;
  return `${Math.round(d * 10) / 10} day${Math.round(d * 10) === 10 ? "" : "s"}`;
}

/** A count for a label: 1,234 (Indian grouping), 12.3k, 1.2L only where room is short (`short`). */
export function count(n, short = false) {
  if (!isNum(n)) return "–";
  if (short && Math.abs(n) >= 1e5) return `${Math.round(n / 1e4) / 10}L`;
  if (short && Math.abs(n) >= 1e4) return `${Math.round(n / 100) / 10}k`;
  return n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

/** A share 0..1 as a whole percent. */
export const pct = (x) => isNum(x) ? `${Math.round(x * 100)}%` : "–";

/** Rupees, short: ₹4.2L, ₹1.3Cr, ₹85,000. */
export function rupees(x) {
  if (!isNum(x)) return "–";
  const a = Math.abs(x);
  if (a >= 1e7) return `₹${Math.round(x / 1e5) / 100}Cr`;
  if (a >= 1e5) return `₹${Math.round(x / 1e4) / 10}L`;
  return `₹${Math.round(x).toLocaleString("en-IN")}`;
}

/** The signed change from `before` to `now` as a share, or null. `better` says which way is good. */
export function delta(now, before, better = "up") {
  if (!isNum(now) || !isNum(before) || before === 0) return null;
  const d = (now - before) / Math.abs(before);
  return { d, good: better === "down" ? d < 0 : d > 0, text: `${d > 0 ? "+" : ""}${Math.round(d * 100)}%` };
}

/** The quarters of a trend before the last one, as a baseline for the last (median of the earlier values). */
export function baseline(values) {
  const v = values.filter(isNum).slice(0, -1).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
