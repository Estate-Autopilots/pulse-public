// DOCS-RICH (owner, 9 Nov 2026: "Each time you make an HTML analysis, we should be able to upload that HTML and render it
// right there in the doc, and it should become editable"): "Turn into doc blocks". A web page (an analysis Claude made,
// usually headings, KPI cards, tables and Chart.js / Plotly / ECharts / Vega-Lite charts) becomes the doc's own editable
// blocks. Nothing on the page is ever run: the HTML is parsed (htmlparser2), and a chart's numbers are read from its
// script's literal data with a JavaScript parser (acorn): object and array literals, constants and simple sums, never a
// call. What cannot be read that way (a chart drawn by code, a drawing in SVG, buttons) is counted and left out; the
// "Keep as interactive page" mode keeps all of it. The result goes through the doc sanitiser (docs.ts cleanHtml).
import { parseDocument } from 'htmlparser2';
import { parse as parseJs } from 'acorn';
import { blockHtml, cellNumber, cleanBlock } from './doc-blocks.js';

type Row = Record<string, unknown>;
/** The parts of an htmlparser2 (domhandler) node this file reads. */
type N = { type: string; name?: string; attribs?: Record<string, string>; children?: N[]; data?: string };
type Js = { type: string; [k: string]: unknown };
export type Found = { headings: number; paragraphs: number; lists: number; tables: number; charts: number; numbers: number; images: number;
  skipped: { charts: number; drawings: number; controls: number } };
export type Converted = { title: string; html: string; found: Found };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isEl = (n: N) => n.type === 'tag' || n.type === 'script' || n.type === 'style';
const kids = (n: N) => n.children ?? [];
const textOf = (n: N): string => n.type === 'text' ? n.data ?? '' : isEl(n) && ['script', 'style', 'noscript', 'template'].includes(n.name ?? '') ? '' : kids(n).map(textOf).join('');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------------------------------------ reading script data
/** A literal value from the script, or undefined when it needs running code. */
function literal(node: Js | null | undefined, vars: Map<string, Js>, depth = 0): unknown {
  if (!node || depth > 12) return undefined;
  const at = (n: unknown) => literal(n as Js, vars, depth + 1);
  switch (node.type) {
    case 'Literal': return node.regex ? undefined : node.value;
    case 'TemplateLiteral': return (node.expressions as Js[]).length ? undefined : (node.quasis as Js[]).map((q) => (q.value as Row).cooked).join('');
    case 'ArrayExpression': {
      const out: unknown[] = [];
      for (const el of node.elements as (Js | null)[]) {
        if (el?.type === 'SpreadElement') { const v = at(el.argument); if (Array.isArray(v)) out.push(...v); else return undefined; } else out.push(el ? at(el) : null);
      }
      return out;
    }
    case 'ObjectExpression': {
      const out: Row = {};
      for (const p of node.properties as Js[]) {
        if (p.type === 'SpreadElement') { const v = at(p.argument); if (v && typeof v === 'object') Object.assign(out, v); continue; }
        const k = p.key as Js, key = p.computed ? at(k) : k.type === 'Identifier' ? k.name : k.value;
        if (typeof key !== 'string' && typeof key !== 'number') continue;
        const v = at(p.value);
        if (v !== undefined) out[String(key)] = v;
      }
      return out;
    }
    case 'UnaryExpression': { const v = at(node.argument); return typeof v === 'number' ? (node.operator === '-' ? -v : node.operator === '+' ? v : undefined) : undefined; }
    case 'BinaryExpression': {
      const a = at(node.left), b = at(node.right);
      if (typeof a === 'number' && typeof b === 'number') return node.operator === '+' ? a + b : node.operator === '-' ? a - b : node.operator === '*' ? a * b : node.operator === '/' && b ? a / b : undefined;
      return node.operator === '+' && typeof a === 'string' && (typeof b === 'string' || typeof b === 'number') ? a + b : undefined;
    }
    case 'Identifier': return vars.has(String(node.name)) ? at(vars.get(String(node.name))) : undefined;
    case 'MemberExpression': {
      const o = at(node.object), p = node.computed ? at(node.property) : (node.property as Js).name;
      return o && typeof o === 'object' && (typeof p === 'string' || typeof p === 'number') ? (o as Row)[String(p)] : undefined;
    }
    case 'CallExpression': {
      // JSON.parse('…') with a literal string, and JSON.parse(<script type="application/json" id=…>.textContent)
      const c = node.callee as Js;
      if (c.type === 'MemberExpression' && (c.object as Js).name === 'JSON' && (c.property as Js).name === 'parse') {
        const arg = (node.arguments as Js[])[0];
        const s = typeof at(arg) === 'string' ? String(at(arg)) : vars.has(`#json:${elementId(arg, vars) ?? ''}`) ? String((vars.get(`#json:${elementId(arg, vars)}`) as Js).value) : null;
        if (s !== null) { try { return JSON.parse(s); } catch { return undefined; } }
      }
      return undefined;
    }
    default: return undefined;
  }
}

/** The element an expression points at: getElementById('x'), querySelector('#x'), its .getContext(…), or a variable holding one. */
function elementId(node: Js | null | undefined, vars: Map<string, Js>, depth = 0): string | null {
  if (!node || depth > 8) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value.replace(/^#/, '');
  if (node.type === 'Identifier') return vars.has(String(node.name)) ? elementId(vars.get(String(node.name)), vars, depth + 1) : null;
  if (node.type === 'MemberExpression') return elementId(node.object as Js, vars, depth + 1);
  if (node.type === 'CallExpression') {
    const c = node.callee as Js, name = c.type === 'MemberExpression' ? (c.property as Js).name : c.name;
    const arg = (node.arguments as Js[])[0];
    if (name === 'getElementById' || name === 'querySelector') { const s = arg?.type === 'Literal' ? String(arg.value) : null; return s && /^#?[\w-]+$/.test(s) ? s.replace(/^#/, '') : null; }
    if (name === 'getContext') return elementId(c.object as Js, vars, depth + 1);
    if (name === 'init') return elementId(arg, vars, depth + 1); // echarts.init(el)
  }
  return null;
}

/** Every node of a script tree, in source order. */
function* walk(n: unknown): Generator<Js> {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const x of n) yield* walk(x); return; }
  const node = n as Js;
  if (typeof node.type === 'string') yield node;
  for (const [k, v] of Object.entries(node)) if (k !== 'loc' && k !== 'range' && v && typeof v === 'object') yield* walk(v);
}

type Clean = Row & { kind: string; id: string };
type ChartFound = { target: string | null; block: Clean };
const title = (t: unknown) => Array.isArray(t) ? t.filter((x) => typeof x === 'string').join(' ') : typeof t === 'string' ? t : t && typeof t === 'object' && typeof (t as Row).text === 'string' ? String((t as Row).text) : '';
const series = (cols: string[], rows: unknown[][]) => ({ columns: cols, rows });

/** Chart.js: new Chart(canvas, {type, data: {labels, datasets: [{label, data}]}, options}). */
function fromChartJs(cfg: Row): Row | null {
  const data = (cfg.data ?? {}) as Row, sets = (Array.isArray(data.datasets) ? data.datasets : []) as Row[];
  if (!sets.length) return null;
  const opts = (cfg.options ?? {}) as Row, plugins = (opts.plugins ?? {}) as Row, scales = (opts.scales ?? {}) as Record<string, Row>;
  let type = String(cfg.type ?? sets[0].type ?? 'bar');
  const names = sets.map((s, i) => String(s.label ?? `Series ${i + 1}`));
  const t = title(plugins.title && (plugins.title as Row).text !== undefined ? (plugins.title as Row).text : (opts.title as Row | undefined)?.text);
  if (type === 'scatter' || type === 'bubble') {
    const rows: unknown[][] = [];
    sets.forEach((s, i) => (Array.isArray(s.data) ? s.data : []).forEach((p) => { const q = (p ?? {}) as Row; rows.push([cellNumber(q.x), ...names.map((_, j) => j === i ? cellNumber(q.y) : null)]); }));
    return { type: 'scatter', title: t, ...series(['X', ...names], rows.filter((r) => r[0] !== null)) };
  }
  const labels = Array.isArray(data.labels) ? data.labels : (Array.isArray(sets[0].data) ? sets[0].data : []).map((p: unknown) => (p as Row)?.x);
  const rows = labels.map((l: unknown, i: number) => [String(l ?? ''), ...sets.map((s) => { const v = Array.isArray(s.data) ? s.data[i] : null; return cellNumber(v && typeof v === 'object' ? (v as Row).y : v); })]);
  if (type === 'doughnut' || type === 'polarArea') type = 'pie';
  if (type === 'radar') type = 'bar';
  if (type === 'line' && sets.some((s) => s.fill === true || s.fill === 'origin' || s.fill === 'start')) type = 'area';
  return { type, title: t, ...series(['Label', ...names], rows), horizontal: opts.indexAxis === 'y', stacked: !!(scales.x?.stacked || scales.y?.stacked) };
}

/** Plotly: Plotly.newPlot(div, [{x, y, type, mode, name}], layout). */
function fromPlotly(traces: Row[], layout: Row): Row | null {
  if (!traces.length) return null;
  const t = title(layout.title);
  if (traces[0].type === 'pie') {
    const l = (traces[0].labels ?? []) as unknown[], v = (traces[0].values ?? []) as unknown[];
    return { type: 'pie', title: t, ...series(['Label', String(traces[0].name ?? 'Value')], l.map((x, i) => [String(x), cellNumber(v[i])])) };
  }
  const horizontal = traces[0].orientation === 'h';
  const xOf = (tr: Row) => (horizontal ? tr.y : tr.x) as unknown[] | undefined, yOf = (tr: Row) => (horizontal ? tr.x : tr.y) as unknown[] | undefined;
  const xs: unknown[] = [];
  for (const tr of traces) for (const x of xOf(tr) ?? []) if (!xs.some((y) => String(y) === String(x))) xs.push(x);
  if (!xs.length) return null;
  const names = traces.map((tr, i) => String(tr.name ?? `Series ${i + 1}`));
  const rows = xs.map((x) => [typeof x === 'number' ? x : String(x), ...traces.map((tr) => { const i = (xOf(tr) ?? []).findIndex((y) => String(y) === String(x)); return i < 0 ? null : cellNumber((yOf(tr) ?? [])[i]); })]);
  const kind = String(traces[0].type ?? 'scatter'), mode = String(traces[0].mode ?? (kind === 'scatter' ? 'lines+markers' : ''));
  const type = kind === 'bar' ? 'bar' : kind === 'scatter' && !mode.includes('lines') ? 'scatter' : traces.some((tr) => tr.fill && tr.fill !== 'none') ? 'area' : 'line';
  return { type, title: t, ...series([String((layout.xaxis as Row | undefined)?.title ? title((layout.xaxis as Row).title) || 'Label' : 'Label'), ...names], rows), horizontal, stacked: layout.barmode === 'stack' };
}

/** ECharts: chart.setOption({xAxis: {data}, series: [{type, name, data}]}). */
function fromECharts(opt: Row): Row | null {
  const ser = (Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []) as Row[];
  if (!ser.length) return null;
  const t = title(Array.isArray(opt.title) ? opt.title[0] : opt.title);
  if (ser[0].type === 'pie') {
    const d = (Array.isArray(ser[0].data) ? ser[0].data : []) as Row[];
    return { type: 'pie', title: t, ...series(['Label', String(ser[0].name ?? 'Value')], d.map((p) => [String(p?.name ?? ''), cellNumber(p?.value)])) };
  }
  const axis = (a: unknown) => (Array.isArray(a) ? a[0] : a) as Row | undefined;
  const x = axis(opt.xAxis), y = axis(opt.yAxis), horizontal = y?.type === 'category' && Array.isArray(y.data);
  const cats = ((horizontal ? y?.data : x?.data) ?? []) as unknown[];
  const names = ser.map((s, i) => String(s.name ?? `Series ${i + 1}`));
  const val = (v: unknown) => cellNumber(v && typeof v === 'object' && !Array.isArray(v) ? (v as Row).value : Array.isArray(v) ? v[1] : v);
  const kind = String(ser[0].type ?? 'line');
  if (kind === 'scatter') {
    const rows: unknown[][] = [];
    ser.forEach((s, i) => (Array.isArray(s.data) ? s.data : []).forEach((p) => { if (Array.isArray(p)) rows.push([cellNumber(p[0]), ...names.map((_, j) => j === i ? cellNumber(p[1]) : null)]); }));
    return { type: 'scatter', title: t, ...series(['X', ...names], rows) };
  }
  if (!cats.length) return null;
  const rows = cats.map((c, i) => [String(c), ...ser.map((s) => val(Array.isArray(s.data) ? s.data[i] : null))]);
  return { type: kind === 'bar' ? 'bar' : ser.some((s) => s.areaStyle) ? 'area' : 'line', title: t, ...series(['Label', ...names], rows), horizontal, stacked: ser.some((s) => s.stack) };
}

/** Vega-Lite: vegaEmbed('#vis', {data: {values}, mark, encoding: {x, y, color}}). */
function fromVegaLite(spec: Row): Row | null {
  const values = ((spec.data as Row | undefined)?.values ?? []) as Row[];
  const enc = (spec.encoding ?? {}) as Record<string, Row>;
  const xf = enc.x?.field as string | undefined, yf = enc.y?.field as string | undefined, cf = (enc.color?.field ?? enc.theta?.field) as string | undefined;
  if (!Array.isArray(values) || !values.length || !xf && !cf) return null;
  const mark = String(typeof spec.mark === 'string' ? spec.mark : (spec.mark as Row | undefined)?.type ?? 'bar');
  if (mark === 'arc' && enc.theta?.field) return { type: 'pie', title: title(spec.title), ...series(['Label', String(enc.theta.field)], values.map((v) => [String(v[cf ?? ''] ?? ''), cellNumber(v[String(enc.theta.field)])])) };
  if (!xf || !yf) return null;
  const xs = [...new Set(values.map((v) => String(v[xf])))], groups = cf ? [...new Set(values.map((v) => String(v[cf])))] : [yf];
  const rows = xs.map((x) => [x, ...groups.map((g) => cellNumber(values.find((v) => String(v[xf]) === x && (!cf || String(v[cf]) === g))?.[yf]))]);
  return { type: mark === 'line' ? 'line' : mark === 'area' ? 'area' : mark === 'point' || mark === 'circle' ? 'scatter' : 'bar', title: title(spec.title), ...series([xf, ...groups], rows) };
}

/** The charts a page's scripts draw from literal data, each with the element it draws into. */
export function chartsInScripts(scripts: string[], jsonScripts: Map<string, string>): { charts: ChartFound[]; unread: number } {
  const charts: ChartFound[] = [];
  let unread = 0;
  const vars = new Map<string, Js>();
  for (const [id, text] of jsonScripts) vars.set(`#json:${id}`, { type: 'Literal', value: text });
  const trees: Js[] = [];
  for (const src of scripts) {
    for (const sourceType of ['script', 'module'] as const) {
      try { trees.push(parseJs(src, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }) as unknown as Js); break; } catch { /* the other way, or skipped */ }
    }
  }
  // constants first (in any script), so a chart may use data declared above or in another script
  for (const tree of trees) for (const n of walk(tree)) {
    if (n.type === 'VariableDeclarator' && (n.id as Js).type === 'Identifier' && n.init) vars.set(String((n.id as Js).name), n.init as Js);
    if (n.type === 'AssignmentExpression' && (n.left as Js).type === 'Identifier' && n.operator === '=') vars.set(String((n.left as Js).name), n.right as Js);
  }
  for (const tree of trees) for (const n of walk(tree)) {
    const args = (n.arguments ?? []) as Js[];
    const callee = n.callee as Js | undefined;
    const name = callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression' ? (callee.property as Js).name : null;
    const owner = callee?.type === 'MemberExpression' && (callee.object as Js).type === 'Identifier' ? String((callee.object as Js).name) : '';
    let block: Row | null = null, target: string | null = null, tried = false;
    if (n.type === 'NewExpression' && name === 'Chart') {
      tried = true; target = elementId(args[0], vars);
      const cfg = literal(args[1], vars); block = cfg && typeof cfg === 'object' ? fromChartJs(cfg as Row) : null;
    } else if (n.type === 'CallExpression' && owner === 'Plotly' && ['newPlot', 'plot', 'react'].includes(String(name))) {
      tried = true; target = elementId(args[0], vars);
      const traces = literal(args[1], vars), layout = literal(args[2], vars);
      block = Array.isArray(traces) ? fromPlotly(traces as Row[], (layout ?? {}) as Row) : null;
    } else if (n.type === 'CallExpression' && name === 'setOption') {
      tried = true; target = callee?.type === 'MemberExpression' ? elementId(callee.object as Js, vars) : null;
      const opt = literal(args[0], vars); block = opt && typeof opt === 'object' ? fromECharts(opt as Row) : null;
    } else if (n.type === 'CallExpression' && (name === 'vegaEmbed' || name === 'embed' && owner === 'vegaEmbed')) {
      tried = true; target = elementId(args[0], vars);
      const spec = literal(args[1], vars); block = spec && typeof spec === 'object' ? fromVegaLite(spec as Row) : null;
    }
    if (!tried) continue;
    const clean = block ? cleanBlock({ kind: 'chart', ...block }) : null;
    if (clean && (clean.rows as unknown[]).length) charts.push({ target, block: clean }); else unread++;
  }
  return { charts, unread };
}

// ------------------------------------------------------------------------------------------------ the page's words
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'track', 'map', 'dialog']);
const CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'form', 'nav']);
const INLINE = new Set(['a', 'abbr', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'code', 'kbd', 'small', 'sub', 'sup', 'span', 'time', 'label', 'q', 'cite', 'var', 'br', 'img', 'data', 'font']);
const NUMBERISH = /^[₹$€£]?\s?[-+]?\d[\d.,]*\s?(%|x|k|K|m|M|bn|B|L|Cr|cr|lakh|crore|L\b)?$/;
const DELTA = /^([▲▼↑↓+\-−]\s?\d|\d[\d.,]*\s?(%|pp)\s)|\bvs\b/i;

export function convertHtmlPage(page: string): Converted {
  const doc = parseDocument(String(page ?? '').slice(0, 6_000_000), { decodeEntities: true }) as unknown as N;
  const found: Found = { headings: 0, paragraphs: 0, lists: 0, tables: 0, charts: 0, numbers: 0, images: 0, skipped: { charts: 0, drawings: 0, controls: 0 } };
  const all: N[] = [];
  const gather = (n: N) => { all.push(n); kids(n).forEach(gather); };
  gather(doc);
  const scripts = all.filter((n) => n.type === 'script' && n.name === 'script');
  const jsonScripts = new Map<string, string>();
  const code: string[] = [];
  for (const s of scripts) {
    const type = (s.attribs?.type ?? '').toLowerCase(), text = kids(s).map((c) => c.data ?? '').join('');
    if (/json/.test(type)) { if (s.attribs?.id) jsonScripts.set(s.attribs.id, text); } else if (!s.attribs?.src && text.trim()) code.push(text);
  }
  const { charts, unread } = chartsInScripts(code, jsonScripts);
  found.skipped.charts = unread;
  const byTarget = new Map<string, Clean[]>();
  for (const c of charts) if (c.target) byTarget.set(c.target, [...(byTarget.get(c.target) ?? []), c.block]);
  const placed = new Set<Clean>();
  const pageTitle = squash(textOf(all.find((n) => n.name === 'title') ?? { type: 'text', data: '' })) || squash(textOf(all.find((n) => n.name === 'h1') ?? { type: 'text', data: '' }));

  const out: string[] = [];
  let lastHeading = '';
  const inline = (n: N): string => {
    if (n.type === 'text') return esc((n.data ?? '').replace(/\s+/g, ' '));
    if (!isEl(n) || SKIP.has(n.name ?? '')) return '';
    if (CONTROLS.has(n.name ?? '')) { found.skipped.controls++; return ''; }
    const inner = () => kids(n).map(inline).join('');
    switch (n.name) {
      case 'br': return '<br>';
      case 'strong': case 'b': return wrap('strong', inner());
      case 'em': case 'i': case 'cite': case 'var': return wrap('em', inner());
      case 'u': case 'ins': return wrap('u', inner());
      case 's': case 'del': return wrap('s', inner());
      case 'mark': return wrap('mark', inner());
      case 'code': case 'kbd': return wrap('code', inner());
      case 'sub': case 'sup': return wrap(n.name, inner());
      case 'a': { const href = n.attribs?.href ?? '', t = inner(); return /^(https?:|mailto:)/i.test(href) && t.trim() ? `<a href="${esc(href)}">${t}</a>` : t; }
      case 'img': { const src = n.attribs?.src ?? ''; if (/^https:\/\//i.test(src)) { found.images++; return `<img src="${esc(src)}" alt="${esc(n.attribs?.alt ?? '')}">`; } return ''; }
      case 'svg': found.skipped.drawings++; return '';
      default: return inner();
    }
  };
  const wrap = (tag: string, s: string) => s.trim() ? `<${tag}>${s}</${tag}>` : s;
  const para = (html: string) => { const t = html.replace(/^(\s|<br>)+|(\s|<br>)+$/g, ''); if (t.replace(/<[^>]+>/g, '').trim() || /<img /.test(t)) { out.push(`<p>${t}</p>`); found.paragraphs++; } };
  const cell = (n: N) => `<p>${kids(n).map((c) => isEl(c) && !INLINE.has(c.name ?? '') ? ` ${inline(c)} ` : inline(c)).join('').replace(/\s+/g, ' ').trim()}</p>`;
  const list = (n: N): string => {
    const tag = n.name === 'ol' ? 'ol' : 'ul';
    const items = kids(n).filter((c) => isEl(c) && c.name === 'li').map((li) => {
      const nested = kids(li).filter((c) => isEl(c) && (c.name === 'ul' || c.name === 'ol')).map(list).join('');
      const words = kids(li).filter((c) => !(isEl(c) && (c.name === 'ul' || c.name === 'ol'))).map((c) => isEl(c) && !INLINE.has(c.name ?? '') ? ` ${inline(c)} ` : inline(c)).join('').replace(/\s+/g, ' ').trim();
      return `<li><p>${words}</p>${nested}</li>`;
    });
    return items.length ? `<${tag}>${items.join('')}</${tag}>` : '';
  };
  const table = (n: N) => {
    const rows: N[] = [];
    const findRows = (x: N) => kids(x).forEach((c) => { if (isEl(c) && c.name === 'tr') rows.push(c); else if (isEl(c) && ['thead', 'tbody', 'tfoot'].includes(c.name ?? '')) findRows(c); });
    findRows(n);
    if (!rows.length) return;
    const body = rows.slice(0, 500).map((r) => `<tr>${kids(r).filter((c) => isEl(c) && (c.name === 'td' || c.name === 'th')).slice(0, 30)
      .map((c) => `<${c.name}${c.attribs?.colspan ? ` colspan="${Number(c.attribs.colspan) || 1}"` : ''}>${cell(c)}</${c.name}>`).join('')}</tr>`).join('');
    out.push(`<table><tbody>${body}</tbody></table>`); found.tables++;
  };
  const chartAt = (id: string | undefined) => {
    for (const b of id ? byTarget.get(id) ?? [] : []) {
      if (placed.has(b)) continue;
      placed.add(b);
      out.push(blockHtml({ ...b, title: String(b.title || lastHeading || 'Chart') })); found.charts++;
    }
  };
  /** KPI cards: 2–6 small boxes, each a short number and its label (and maybe a change), become one big-numbers block. */
  const stats = (n: N): boolean => {
    const cards = kids(n).filter(isEl);
    if (cards.length < 2 || cards.length > 6 || cards.some((c) => SKIP.has(c.name ?? '') || ['table', 'ul', 'ol', 'h1', 'h2', 'canvas', 'svg', 'img'].includes(c.name ?? ''))) return false;
    const items: Row[] = [];
    for (const c of cards) {
      const bits: string[] = [];
      const leaves = (x: N) => { if (x.type === 'text') { const t = squash(x.data ?? ''); if (t) bits.push(t); } else if (isEl(x) && !SKIP.has(x.name ?? '')) kids(x).forEach(leaves); };
      leaves(c);
      if (bits.length < 2 || bits.length > 4 || bits.join(' ').length > 90) return false;
      const vi = bits.findIndex((b) => NUMBERISH.test(b) && !/^[+\-−▲▼↑↓]/.test(b));
      if (vi < 0) return false;
      const rest = bits.filter((_, i) => i !== vi), di = rest.findIndex((b) => DELTA.test(b));
      const delta = di >= 0 ? rest[di] : '', label = rest.filter((_, i) => i !== di).join(' ');
      items.push({ value: bits[vi], label, delta, tone: /^(\+|▲|↑)/.test(delta) ? 'good' : /^(-|−|▼|↓)/.test(delta) ? 'bad' : 'neutral' });
    }
    const b = cleanBlock({ kind: 'stat', items });
    if (!b || (b.items as unknown[]).length < 2) return false;
    out.push(blockHtml(b)); found.numbers++;
    return true;
  };
  const block = (n: N) => {
    let buf = '';
    const flush = () => { if (buf) para(buf); buf = ''; };
    for (const c of kids(n)) {
      if (c.type === 'text') { buf += inline(c); continue; }
      if (!isEl(c) || SKIP.has(c.name ?? '')) continue;
      const name = c.name ?? '';
      if (CONTROLS.has(name)) { found.skipped.controls++; continue; }
      if (INLINE.has(name) && name !== 'img') { buf += inline(c); continue; }
      flush();
      const m = name.match(/^h([1-6])$/);
      if (m) { const t = kids(c).map(inline).join('').trim(); if (t) { out.push(`<h${Math.min(4, Number(m[1]))}>${t}</h${Math.min(4, Number(m[1]))}>`); found.headings++; lastHeading = squash(textOf(c)); } chartAt(c.attribs?.id); continue; }
      switch (name) {
        case 'p': para(kids(c).map(inline).join('')); chartAt(c.attribs?.id); break;
        case 'ul': case 'ol': { const l = list(c); if (l) { out.push(l); found.lists++; } break; }
        case 'table': table(c); break;
        case 'blockquote': { const t = squash(textOf(c)); if (t) out.push(`<blockquote><p>${esc(t)}</p></blockquote>`); break; }
        case 'pre': { const t = textOf(c); if (t.trim()) out.push(`<pre><code>${esc(t.replace(/\n+$/, ''))}</code></pre>`); break; }
        case 'hr': out.push('<hr>'); break;
        case 'img': para(inline(c)); break;
        case 'svg': found.skipped.drawings++; chartAt(c.attribs?.id); break;
        case 'canvas': if (!(c.attribs?.id && byTarget.has(c.attribs.id))) found.skipped.drawings++; chartAt(c.attribs?.id); break;
        default:
          if (c.attribs?.id && byTarget.has(c.attribs.id)) { chartAt(c.attribs.id); break; }
          if (!stats(c)) block(c);
      }
    }
    flush();
  };
  const body = all.find((n) => n.name === 'body') ?? doc;
  block(body);
  // charts whose element was not found go at the end, in the order they were drawn
  for (const c of charts) if (!placed.has(c.block)) { placed.add(c.block); out.push(blockHtml({ ...c.block, title: String(c.block.title || 'Chart') })); found.charts++; }
  return { title: pageTitle.slice(0, 200), html: out.join('\n'), found };
}
