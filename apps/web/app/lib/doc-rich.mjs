// DOCS-RICH (owner, 9 Nov 2026): the rules of rich doc blocks with no screen, shared by the doc page, its export and the
// web proxy: the sealed frame an uploaded web page runs in, pasted data (CSV), number words, diagram starters, and what
// changed in a doc's blocks between two versions. Tests: doc-rich.test.mjs.

// ------------------------------------------------------------------------------------------------ the sealed frame
/** Where an uploaded page may load scripts, styles and fonts from; equal to services/api/src/doc-rich.ts FRAME_CDNS. */
export const FRAME_CDNS = ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://cdn.plot.ly", "https://d3js.org", "https://cdn.tailwindcss.com"];
/** The page's own policy (the proxy sets it on /api/v0/docs/frames/:id; the API sends the same): an opaque origin with
 *  scripts and nothing else (`sandbox allow-scripts`: no cookies, storage, forms, pop-ups or top navigation), no network
 *  but the CDN list, and only Pulse may frame it. */
export const FRAME_CSP = ["sandbox allow-scripts", "default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' ${FRAME_CDNS.join(" ")}`,
  `style-src 'unsafe-inline' ${FRAME_CDNS.join(" ")} https://fonts.googleapis.com`, `font-src data: ${FRAME_CDNS.join(" ")} https://fonts.gstatic.com`,
  "img-src data: blob:", "media-src data: blob:", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "child-src 'none'", "worker-src blob:",
  "object-src 'none'", "base-uri 'none'", "manifest-src 'none'", "frame-ancestors 'self'"].join("; ");
/** The iframe's own sandbox: scripts only. Never add allow-same-origin (the page would become Pulse), allow-top-navigation,
 *  allow-forms, allow-popups or allow-modals. */
export const FRAME_SANDBOX = "allow-scripts";
/** The proxy path of a page's sealed frame. */
export const framePath = (/** @type {string} */ fileId) => `/api/v0/docs/frames/${encodeURIComponent(fileId)}`;
export const isFramePath = (/** @type {string[]} */ path) => path.length === 3 && path[0] === "docs" && path[1] === "frames" && /^[0-9a-f-]{36}$/.test(path[2]);
/** A height a framed page reports (postMessage {pulseFrame: "height", height}), kept between 120 and 8000 px; else null. */
export function frameHeight(data) {
  if (!data || typeof data !== "object" || data.pulseFrame !== "height") return null;
  const h = Number(data.height);
  return Number.isFinite(h) && h > 0 ? Math.round(Math.min(8000, Math.max(120, h))) : null;
}
/** A page that keeps growing because it is as tall as its frame (100vh and a margin) stops after this many grows a second. */
export const FRAME_GROWS_PER_SECOND = 8;

// ------------------------------------------------------------------------------------------------ data
/** A cell as a number (1,234.5 · ₹ 40,000 · 12% · -3e2), else null. */
export function cellNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.replace(/[,\s₹$€£%]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Pasted data (CSV, tab-separated from a spreadsheet, or semicolons) as columns and rows; the first row names the columns. */
export function parseCsv(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").replace(/^﻿/, "").trim();
  if (!src) return { columns: [], rows: [] };
  const first = src.split("\n")[0];
  const sep = [..."\t;,|"].map((c) => [c, first.split(c).length - 1]).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  const d = Number(sep[1]) > 0 ? String(sep[0]) : ",";
  const lines = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (ch === d) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n") { row.push(cell.trim()); lines.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell.trim()); lines.push(row);
  const width = Math.min(12, Math.max(...lines.map((l) => l.length)));
  const columns = Array.from({ length: width }, (_, i) => (lines[0][i] ?? "").slice(0, 60) || (i ? `Series ${i}` : "Name"));
  const rows = lines.slice(1, 501).filter((l) => l.some((c) => c !== ""))
    .map((l) => Array.from({ length: width }, (_, i) => i === 0 ? (l[0] ?? "").slice(0, 80) : cellNumber(l[i] ?? "")));
  return { columns, rows };
}

/** Columns and rows as CSV (quotes where needed). */
export function toCsv(columns, rows) {
  const q = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns, ...rows].map((r) => r.map(q).join(",")).join("\n");
}

/** A chart's data as checked by the API (services/api/src/doc-blocks.ts cleanChart), for the editor's live preview. */
export function tidyChart(block) {
  const b = block && typeof block === "object" ? block : {};
  let columns = Array.isArray(b.columns) ? b.columns.slice(0, 12).map((c) => String(c ?? "").slice(0, 60)) : null;
  let rows;
  if (!columns) {
    columns = ["Name", String(b.unit ?? "").slice(0, 16) || "Value"];
    rows = (Array.isArray(b.rows) ? b.rows : []).filter((r) => r && typeof r === "object" && !Array.isArray(r)).map((r) => [String(r.label ?? ""), cellNumber(r.value)]);
  } else {
    if (columns.length < 2) columns = [columns[0] || "Name", "Value"];
    rows = (Array.isArray(b.rows) ? b.rows : []).filter(Array.isArray).slice(0, 500)
      .map((r) => [typeof r[0] === "number" ? r[0] : String(r[0] ?? "").slice(0, 80), ...columns.slice(1).map((_, i) => cellNumber(r[i + 1]))]);
  }
  const type = ["line", "bar", "area", "pie", "scatter", "table", "kpi"].includes(b.type) ? b.type : "bar";
  // the first DOCS-INTERACTIVE bar chart ({rows: [{label, value}]}, no type) was drawn sideways
  const horizontal = b.horizontal === true || (!Array.isArray(b.columns) && b.type === undefined && b.horizontal === undefined);
  return { ...b, type, columns, rows, horizontal };
}

// ------------------------------------------------------------------------------------------------ number words
/** A number for people: Indian grouping (12,34,567), up to 2 decimals, with the unit where it reads naturally (₹ before,
 *  % after, words after a space). */
export function formatValue(n, unit = "") {
  if (typeof n !== "number" || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n), digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const s = new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(n);
  const u = String(unit ?? "").trim();
  if (!u) return s;
  if (/^[₹$€£]/.test(u)) { const rest = u.slice(1).trim(); return `${n < 0 ? "-" : ""}${u[0]}${s.replace(/^-/, "")}${rest ? ` ${rest}` : ""}`; }
  if (u === "%") return `${s}%`;
  return `${s} ${u}`;
}
/** Axis ticks: compact once a value reaches 10,000 (10K, 2.5L, 1.2Cr in Indian style). */
export function formatTick(n) {
  const a = Math.abs(n);
  if (a >= 1e7) return `${+(n / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${+(n / 1e5).toFixed(1)}L`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(0)}K`;
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
}
/** A clean axis: from min (or 0) to max in 3–6 round steps; values below zero get their own part of the axis. */
export function axis(values, fromZero = true) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  let lo = Math.min(...v, fromZero ? 0 : Infinity), hi = Math.max(...v, fromZero ? 0 : -Infinity);
  if (!v.length) { lo = 0; hi = 1; }
  if (lo === hi) { hi = lo + (Math.abs(lo) || 1); if (!fromZero) lo -= 1; }
  const raw = (hi - lo) / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = start; t <= end + step / 2; t += step) ticks.push(Math.round(t * 1e9) / 1e9);
  return { min: start, max: end, ticks };
}
/** A KPI tile from a chart's first series: its last value, and its change from the row before. */
export function kpiOf(block) {
  const b = tidyChart(block);
  const vals = b.rows.map((r) => r[1]).filter((x) => typeof x === "number");
  if (!vals.length) return null;
  const now = vals[vals.length - 1], before = vals.length > 1 ? vals[vals.length - 2] : null;
  const change = before !== null && before !== 0 ? (now - before) / Math.abs(before) : null;
  const lastRow = [...b.rows].reverse().find((r) => typeof r[1] === "number");
  return { value: now, label: b.columns[1], at: lastRow ? String(lastRow[0]) : "", before, change, spark: vals.slice(-12) };
}

// ------------------------------------------------------------------------------------------------ diagrams
export const DIAGRAM_STARTERS = {
  flowchart: "flowchart TD\n  A[New lead] --> B{Qualified?}\n  B -- Yes --> C[Book a call]\n  B -- No --> D[Nurture list]\n  C --> E[Send proposal]",
  timeline: "timeline\n  title Launch plan\n  04 Nov : Prepare\n  11 Nov : Pilot in Pune\n  18 Nov : Launch\n  25 Nov : Review",
  gantt: "gantt\n  title Campaign\n  dateFormat YYYY-MM-DD\n  section Plan\n  Brief      :a1, 2026-11-02, 3d\n  Shoot      :a2, after a1, 4d\n  section Launch\n  Ads live   :after a2, 7d",
  mindmap: "mindmap\n  root((Q4 plan))\n    Sales\n      Pune\n      Mumbai\n    Product\n      Docs\n      Chat\n    People\n      Hiring",
};
/** What a Mermaid diagram is, from its first line (a word people know). */
export function diagramType(code) {
  const first = String(code ?? "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("%%")) ?? "";
  const w = first.split(/\s+/)[0].toLowerCase();
  return { flowchart: "Flowchart", graph: "Flowchart", timeline: "Timeline", gantt: "Gantt chart", mindmap: "Mind map", sequencediagram: "Sequence", pie: "Pie",
    classdiagram: "Class diagram", statediagram: "State diagram", "statediagram-v2": "State diagram", erdiagram: "Data diagram", journey: "Journey", quadrantchart: "Quadrant" }[w] ?? "Diagram";
}

// ------------------------------------------------------------------------------------------------ what changed
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The blocks of a stored doc body, in order (each one's checked JSON). */
export function blocksOf(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/<div\b[^>]*data-type="pulse-block"[^>]*>/g)) {
    const raw = (m[0].match(/data-block="([^"]*)"/) ?? [])[1];
    if (!raw) continue;
    try { const b = JSON.parse(unescape(raw)); if (b && typeof b === "object" && b.id) out.push(b); } catch { /* skipped */ }
  }
  return out;
}
const KIND_WORDS = { chart: "Chart", diagram: "Diagram", html: "Web page", stat: "Big numbers", approval: "Approval", checklist: "Checklist", form: "Questions",
  actions: "Action list", quote: "Quote", timeline: "Timeline" };
const name = (b) => `${KIND_WORDS[b.kind] ?? "Block"}${b.title ? ` “${b.title}”` : ""}`;
const words = (html) => String(html ?? "").replace(/<div\b[^>]*data-type="pulse-block"[^>]*><\/div>/g, "\n").replace(/<(br|\/p|\/h[1-4]|\/li|\/tr)[^>]*>/gi, "\n")
  .replace(/<[^>]+>/g, " ").split("\n").map((l) => unescape(l).replace(/\s+/g, " ").trim()).filter(Boolean);
/** What changed between two versions of a body: each block added, removed or changed (with which fields: for a chart its
 *  type, title, series and rows), and how many lines of words were added or removed. */
export function blockChanges(beforeHtml, afterHtml) {
  const a = blocksOf(beforeHtml), b = blocksOf(afterHtml);
  const before = new Map(a.map((x) => [x.id, x])), after = new Map(b.map((x) => [x.id, x]));
  const changes = [];
  for (const x of b) if (!before.has(x.id)) changes.push({ kind: "added", text: `${name(x)} added` });
  for (const x of a) if (!after.has(x.id)) changes.push({ kind: "removed", text: `${name(x)} removed` });
  for (const x of b) {
    const old = before.get(x.id);
    if (!old || JSON.stringify(old) === JSON.stringify(x)) continue;
    const parts = [];
    if (old.type !== x.type && x.type) parts.push(`type ${old.type ?? "–"} → ${x.type}`);
    if ((old.title ?? "") !== (x.title ?? "")) parts.push(`title “${old.title ?? ""}” → “${x.title ?? ""}”`);
    if (x.kind === "chart") {
      const oc = (old.columns ?? []).slice(1), nc = (x.columns ?? []).slice(1);
      const plus = nc.filter((c) => !oc.includes(c)), minus = oc.filter((c) => !nc.includes(c));
      if (plus.length) parts.push(`series added: ${plus.join(", ")}`);
      if (minus.length) parts.push(`series removed: ${minus.join(", ")}`);
      const or = old.rows ?? [], nr = x.rows ?? [];
      const keyed = (rows) => new Map(rows.map((r) => [String(r[0]), JSON.stringify(r)]));
      const ok = keyed(or), nk = keyed(nr);
      const added = [...nk.keys()].filter((k) => !ok.has(k)).length, removed = [...ok.keys()].filter((k) => !nk.has(k)).length;
      const edited = [...nk.keys()].filter((k) => ok.has(k) && ok.get(k) !== nk.get(k)).length;
      if (added) parts.push(`${added} ${added === 1 ? "row" : "rows"} added`);
      if (removed) parts.push(`${removed} ${removed === 1 ? "row" : "rows"} removed`);
      if (edited) parts.push(`${edited} ${edited === 1 ? "row" : "rows"} changed`);
      if ((old.unit ?? "") !== (x.unit ?? "")) parts.push(`unit “${old.unit ?? ""}” → “${x.unit ?? ""}”`);
    } else if (x.kind === "diagram" && old.code !== x.code) parts.push("diagram code changed");
    else if (x.kind === "html" && old.fileId !== x.fileId) parts.push("page replaced");
    if (!parts.length) parts.push("changed");
    changes.push({ kind: "changed", text: `${name(x)}: ${parts.join("; ")}` });
  }
  const wa = words(beforeHtml), wb = words(afterHtml);
  const count = (list) => list.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const ca = count(wa), cb = count(wb);
  let plus = 0, minus = 0;
  for (const [l, n] of cb) plus += Math.max(0, n - (ca.get(l) ?? 0));
  for (const [l, n] of ca) minus += Math.max(0, n - (cb.get(l) ?? 0));
  if (plus || minus) changes.push({ kind: "words", text: `Words: ${plus} ${plus === 1 ? "line" : "lines"} added, ${minus} removed` });
  return changes;
}
