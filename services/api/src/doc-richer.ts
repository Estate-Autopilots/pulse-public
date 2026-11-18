// DOCS-POLISH (owner, 14 Nov 2026: "the rich documents with complex UI were to be coming … the goodness that needs to be
// there is not there"): "Make this doc richer". Imported docs (Markdown, Word, a zip) and docs Claude writes through MCP or
// the API arrive as plain words, while charts, big numbers, timelines and toggles sit behind Insert. This reads a doc's
// HTML and offers upgrades made only from what the doc already says:
//   chart     a table with a column of numbers gets a chart under it (the table stays)
//   stat      a table's Total row, or a "Key numbers" list ("Revenue: ₹42.6 L"), becomes big numbers
//   timeline  a list of dated steps ("Week 1: Order the kits") becomes a timeline
//   diagram   a short numbered list of steps under "Process"/"How it works" gets a flow diagram (the list stays)
//   toggle    an Appendix / Method / Background / FAQ section folds into a toggle
//   numbers   amounts in tables written 1234567 or 1,234,567 are written the Indian way (12,34,567)
// Comparison tables (words, not numbers) stay styled tables. Nothing is invented: every number in a block is read from a
// cell or a list item as written, every label is the doc's own words, and an item that would lose words is left alone.
// Edits are made on the stored HTML by position (htmlparser2 start/end indices), so everything else stays byte for byte;
// the caller saves the result as its own History version ("Made richer", reason 'enrich', migration 2096).
import { createHash } from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import { blockHtml, cellNumber, cleanBlock } from './doc-blocks.js';

type Row = Record<string, unknown>;
/** The parts of an htmlparser2 (domhandler) node this file reads, with their places in the source. */
type N = { type: string; name?: string; attribs?: Record<string, string>; children?: N[]; data?: string; startIndex: number | null; endIndex: number | null };
export type RicherKind = 'chart' | 'stat' | 'timeline' | 'diagram' | 'toggle' | 'numbers';
/** One upgrade the person may pick. `on` is whether it starts ticked; `block` is the block it adds (for the preview). */
export type Suggestion = { id: string; kind: RicherKind; title: string; detail: string; on: boolean; block?: Row; examples?: string[] };
export type RicherResult = { suggestions: Suggestion[]; kept: { tables: number } };
type Edit = { at: number; end: number; text: string; order: number };
type Found = Suggestion & { edits: Edit[] };

const isEl = (n: N) => n.type === 'tag';
const kids = (n: N) => n.children ?? [];
const els = (n: N) => kids(n).filter(isEl);
const textOf = (n: N): string => n.type === 'text' ? n.data ?? '' : isEl(n) ? (n.name === 'br' ? ' ' : kids(n).map(textOf).join('')) : '';
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const text = (n: N) => squash(textOf(n));
const wordsIn = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,%₹-]*/gu) ?? []).length;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const isBlock = (n: N | undefined, kind?: string) => !!n && n.name === 'div' && n.attribs?.['data-type'] === 'pulse-block' && (!kind || n.attribs?.['data-kind'] === kind);
const HEADING = /^h[1-4]$/;
const quoted = (s: string, max = 48) => `“${s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s}”`;

// ------------------------------------------------------------------------------------------------ numbers as written
/** A number as a person writes it: ₹1,24,500 · Rs. 40,000/- · 4.2 L · ₹1.1 Cr · 12% · -3 · 18k. Its unit is what was
 *  written around it (₹, ₹ lakh, %, k …); the value is the digits as written, never scaled. */
const NUM = /^(₹|rs\.?|inr|\$|€|£)?\s*([-+−])?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s*(%|lakhs?|lacs?|l|crores?|cr|k|mn|m|bn)?\.?\s*(?:\/-)?$/i;
const SUFFIX: Record<string, string> = { l: 'lakh', lakh: 'lakh', lakhs: 'lakh', lac: 'lakh', lacs: 'lakh', cr: 'crore', crore: 'crore', crores: 'crore', k: 'k', m: 'M', mn: 'M', bn: 'B', '%': '%' };
export function readNumber(raw: string): { value: number; unit: string } | null {
  const m = squash(raw).match(NUM);
  if (!m) return null;
  const n = cellNumber(m[3]);
  if (n === null) return null;
  const cur = m[1] ? (/^(rs|inr)/i.test(m[1]) ? '₹' : m[1]) : '';
  const suf = m[4] ? SUFFIX[m[4].toLowerCase()] ?? '' : '';
  return { value: m[2] === '-' || m[2] === '−' ? -n : n, unit: [cur, suf].filter(Boolean).join(' ') };
}
/** Digits grouped the Indian way: 1234567 → 12,34,567 (decimals kept as written). */
export function indianGroup(digits: string): string {
  const [int, dec] = digits.replace(/,/g, '').split('.');
  if (int.length <= 3) return digits.replace(/,/g, '');
  const last = int.slice(-3), rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last}${dec !== undefined ? `.${dec}` : ''}`;
}
/** An amount cell written 1234567 / 1,234,567 / ₹1234567 (in a money column, or with ₹ / Rs / INR) the Indian way, or null. */
function indianAmount(t: string, head: string): { from: string; to: string } | null {
  const m = t.match(/^(₹|rs\.?\s?|inr\s?)?\s?(\d{5,}|\d{1,3}(?:,\d{3})+)(\.\d+)?(\s?\/-)?$/i);
  if (!m || /^0/.test(m[2]) || (!m[1] && !MONEY_HEAD.test(head)) || (!m[1] && /^\d{10,}$/.test(m[2])) || ID_HEAD.test(head)) return null;
  const to = indianGroup(m[2]);
  return to === m[2] ? null : { from: m[2], to };
}
const MONEY_HEAD = /(₹|\brs\b|\binr\b|price|cost|amount|total|revenue|budget|value|spend|salary|pay|fee|sales|mrp|rate|income|profit|expense|capex|opex|subtotal)/i;
const COUNT_HEAD = /(\bqty\b|quantity|count|\bno\.? of\b|\bunits?\b|\bpcs\b|\bnos\b|pieces|people|staff|days|hours|weeks|months)/i;
const TOTAL = /^(grand\s+|sub-?)?totals?\b|^sum\b/i;
/** Columns of codes, not amounts: phones, ids, PIN codes, account numbers, years. */
const ID_HEAD = /(phone|mobile|contact|whatsapp|\bids?\b|code|\bpin\b|zip|postal|account|a\/c|ifsc|gstin?|\bpan\b|aadhaa?r|serial|ref(erence)?\b|invoice no|order no|\byear\b)/i;
const SERIAL = /^(s\.?\s?no\.?|sr\.?\s?no\.?|sl\.?\s?no\.?|#|no\.?|serial)$/i;
const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const TIME_LABEL = new RegExp(`^(${MON}(?:\\s?'?\\d{2,4})?|q[1-4](?:\\s?(?:fy)?\\s?'?\\d{2,4})?|h[12]\\s?'?\\d{2,4}|fy\\s?'?\\d{2,4}(?:-\\d{2,4})?|(?:19|20)\\d{2}|(?:week|wk|month|day|sprint)\\s?\\d{1,3}|\\d{4}-\\d{2}(?:-\\d{2})?)$`, 'i');

// ------------------------------------------------------------------------------------------------ tables
type Cell = { node: N; text: string; head: boolean };
function tableRows(t: N): Cell[][] | null {
  const rows: Cell[][] = [];
  const walk = (n: N) => { for (const c of els(n)) { if (c.name === 'tr') rows.push(els(c).filter((x) => x.name === 'td' || x.name === 'th').map((x) => ({ node: x, text: text(x), head: x.name === 'th' }))); else if (['thead', 'tbody', 'tfoot'].includes(c.name ?? '')) walk(c); } };
  walk(t);
  if (rows.length < 2 || rows.some((r) => r.some((c) => Number(c.node.attribs?.colspan ?? 1) > 1 || Number(c.node.attribs?.rowspan ?? 1) > 1))) return null;
  const width = rows[0].length;
  return width >= 2 && rows.every((r) => r.length === width) ? rows : null;
}
const gap = (s: string) => !s || /^[-–—]$|^n\/?a$/i.test(s);

type Series = { col: number; head: string; unit: string; kind: 'money' | 'count' | 'other' };
type TablePlan = { label: number; head: string[]; data: Cell[][]; totals: Cell[][]; series: Series[]; left: string[] };
function planTable(rows: Cell[][]): TablePlan | null {
  const first = rows[0], rest = rows.slice(1);
  const numericRow = (r: Cell[]) => r.slice(1).some((c) => readNumber(c.text));
  if (!(first.every((c) => c.head) || (!numericRow(first) && rest.some(numericRow)))) return null; // a header row names the columns
  const head = first.map((c) => c.text);
  const label = SERIAL.test(head[0]) && head.length > 2 ? 1 : 0;
  const body = rest.filter((r) => r.some((c) => c.text));
  const totals = body.filter((r) => TOTAL.test(r[label].text)), data = body.filter((r) => !TOTAL.test(r[label].text));
  if (data.length < 2 || data.length > 40 || data.some((r) => !r[label].text)) return null;
  const cols: Series[] = [];
  for (let j = 0; j < head.length; j++) {
    if (j === label || (label === 1 && j === 0)) continue;
    const cells = data.map((r) => r[j].text).filter((s) => !gap(s));
    if (cells.length < 2) continue;
    const parsed = cells.map(readNumber);
    if (parsed.some((p) => !p)) continue;
    if (ID_HEAD.test(head[j]) || (cells.every((c) => /^\d{7,}$/.test(c)) && !MONEY_HEAD.test(head[j]))) continue;
    const units = new Set(parsed.map((p) => p!.unit));
    if (units.size > 1) continue;
    const unit = [...units][0];
    cols.push({ col: j, head: head[j] || `Column ${j + 1}`, unit, kind: unit.startsWith('₹') || unit.startsWith('$') || MONEY_HEAD.test(head[j]) ? 'money' : COUNT_HEAD.test(head[j]) ? 'count' : 'other' });
  }
  if (!cols.length) return { label, head, data, totals, series: [], left: [] };
  // One chart compares like with like: the money columns if there are any, else those with the first column's kind and unit.
  const lead = cols.find((c) => c.kind === 'money') ?? cols[0];
  const series = cols.filter((c) => c.kind === lead.kind && c.unit === lead.unit).slice(0, 11);
  return { label, head, data, totals, series, left: cols.filter((c) => !series.includes(c)).map((c) => c.head) };
}
const unitOf = (s: Series) => s.unit === '₹' ? '₹' : s.unit || ((s.head.match(/\((₹[^)]{0,12}|%|[a-z ]{1,12})\)/i) ?? [])[1] ?? '');

// ------------------------------------------------------------------------------------------------ list items
type Item = { node: N; text: string; done: boolean; lead: string | null };
/** A list whose items are each one plain line (no nested list, picture, block or mention), or null. */
function plainItems(list: N): Item[] | null {
  const items: Item[] = [];
  for (const li of els(list)) {
    if (li.name !== 'li') return null;
    const inner = els(li).filter((x) => !(x.name === 'label' || x.name === 'input'));
    const body = inner.length === 1 && (inner[0].name === 'p' || inner[0].name === 'div') ? inner[0] : inner.length === 0 ? li : null;
    if (!body) return null;
    const bad = (n: N): boolean => isEl(n) && (['ul', 'ol', 'img', 'table', 'pre', 'blockquote'].includes(n.name ?? '') || n.attribs?.['data-type'] === 'mention' || isBlock(n) || kids(n).some(bad));
    if (kids(body).some(bad)) return null;
    const t = text(body);
    if (!t) return null;
    const firstEl = kids(body).find((x) => isEl(x) || squash(x.data ?? ''));
    const lead = firstEl && isEl(firstEl) && ['strong', 'b'].includes(firstEl.name ?? '') ? text(firstEl) : null;
    items.push({ node: li, text: t, done: li.attribs?.['data-checked'] === 'true', lead });
  }
  return items.length ? items : null;
}

const NUMTOKEN = '(?:₹|rs\\.?|inr|\\$|€|£)?\\s?[-+−]?\\d[\\d,]*(?:\\.\\d+)?\\s?(?:%|lakhs?|lacs?|l\\b|crores?|cr\\b|k\\b|mn\\b|m\\b|bn\\b|x\\b)?(?:\\s?\\/-)?';
const UNITWORD = '(?:\\s[a-z]{1,12}){0,2}';
const LABEL_VALUE = new RegExp(`^(.{1,60}?)\\s*[:–—=]\\s*(${NUMTOKEN}${UNITWORD})\\s*(?:\\((.{1,40})\\)|[,;–—-]\\s*(.{1,40}))?\\.?$`, 'i');
const VALUE_LABEL = new RegExp(`^(${NUMTOKEN})\\s+([^\\d].{0,59}?)\\s*(?:\\((.{1,40})\\))?\\.?$`, 'i');
const LABEL_TRAIL = new RegExp(`^([^\\d:].{0,59}?)\\s+(${NUMTOKEN})\\s*(?:\\((.{1,40})\\))?\\.?$`, 'i');
const hasUnit = (v: string) => /₹|rs\.?|inr|\$|€|£|%|lakh|lac|crore|\bcr\b|\bl\b|\bk\b|\bm\b|\bmn\b|\bbn\b|\d,\d/i.test(v);
/** "Revenue: ₹42.6 L (+12% vs Sep)" → value ₹42.6 L, label Revenue, note +12% vs Sep. Every word of the item is kept. */
function statItem(t: string): { value: string; label: string; delta: string } | null {
  let m = t.match(LABEL_VALUE);
  if (m) return fits({ label: m[1], value: m[2], delta: m[3] ?? m[4] ?? '' });
  m = t.match(VALUE_LABEL);
  if (m) return fits({ value: m[1], label: m[2], delta: m[3] ?? '' });
  m = t.match(LABEL_TRAIL);
  return m ? fits({ label: m[1], value: m[2], delta: m[3] ?? '' }) : null;
}
const fits = (x: { value: string; label: string; delta: string }) => {
  const s = { value: squash(x.value), label: squash(x.label).replace(/[:–—-]$/, '').trim(), delta: squash(x.delta) };
  return s.value.length <= 24 && s.label.length <= 60 && s.delta.length <= 40 && /\d/.test(s.value) && s.label ? s : null;
};
const DATE = `(?:(?:day|week|wk|month|phase|stage|sprint|step|milestone)\\s?\\d{1,3}(?:\\s?[-–]\\s?\\d{1,3})?|q[1-4](?:\\s?(?:fy)?\\s?'?\\d{2,4})?|h[12]\\s?'?\\d{2,4}|fy\\s?'?\\d{2,4}(?:-\\d{2,4})?|\\d{1,2}(?:st|nd|rd|th)?\\s${MON}(?:\\s\\d{4})?|${MON}\\s\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s\\d{4})?|${MON}(?:\\s\\d{4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?|(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|(?:19|20)\\d{2}|by\\s${MON}(?:\\s\\d{1,4})?)`;
const DATED = new RegExp(`^(${DATE}(?:\\s?[-–]\\s?${DATE})?)\\s*(?:[:–—|)]|\\s-)\\s*(.+)$`, 'i');
const DATE_ONLY = new RegExp(`^${DATE}(?:\\s?[-–]\\s?${DATE})?$`, 'i');
/** "Week 1: Order the kits" or "**15 Nov** Pilot at two sites" → { date, text }. */
function datedItem(it: Item): { date: string; text: string } | null {
  if (it.lead && DATE_ONLY.test(it.lead.replace(/[:.]$/, '')) && it.text.length > it.lead.length) {
    const rest = squash(it.text.slice(it.text.indexOf(it.lead) + it.lead.length).replace(/^\s*[:–—|.-]\s*/, ''));
    if (rest) return { date: it.lead.replace(/[:.]$/, ''), text: rest };
  }
  const m = it.text.match(DATED);
  return m && m[1].length <= 40 && m[2].trim() ? { date: squash(m[1]), text: squash(m[2]) } : null;
}

const KEY_HEAD = /\b(key (numbers|figures|metrics|facts|stats|data)|at a glance|highlights?|headlines?|snapshot|kpis?|in numbers|by the numbers|numbers|totals?|results|summary|scorecard|costs? at a glance)\b/i;
const TIME_HEAD = /\b(timeline|schedule|roadmap|milestones?|phases?|rollout|plan|dates|calendar|when)\b/i;
const FLOW_HEAD = /\b(steps?|process|how (it|this|we) works?|workflow|flow|procedure|stages?|approach|pipeline|funnel|journey|sequence|onboarding)\b/i;
const DETAIL_HEAD = /\b(appendix|appendices|annex(ure)?|background|faqs?|frequently asked|method(ology)?|references?|sources?|assumptions?|raw data|glossary|terms and conditions|fine print|full list|calculations?|working notes|how we (worked|calculated))\b/i;

/** The heading a node sits under: the nearest heading among the two siblings before it. */
function headingBefore(top: N[], i: number): string {
  for (let k = i - 1; k >= Math.max(0, i - 2); k--) if (HEADING.test(top[k].name ?? '')) return text(top[k]);
  return '';
}

// ------------------------------------------------------------------------------------------------ finding upgrades
const blockFor = (b: Row, id: string) => cleanBlock({ ...b, id: `b_${id.slice(-10)}` })!;
const typeWord: Record<string, string> = { line: 'line', bar: 'bar', pie: 'pie', area: 'area' };

function find(html: string): { found: Found[]; kept: number } {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, decodeEntities: true }) as unknown as N;
  const top = els(doc);
  const found: Found[] = [];
  const seen = new Map<string, number>();
  const idFor = (kind: string, anchor: string) => { const k = `${kind}:${anchor.slice(0, 2000)}`; const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return `${kind}_${hash(`${k}:${n}`)}`; };
  const at = (n: N) => n.startIndex ?? 0, end = (n: N) => (n.endIndex ?? 0) + 1;
  let kept = 0;
  const numberEdits: Edit[] = [], numberExamples: string[] = [];

  top.forEach((n, i) => {
    const under = headingBefore(top, i);
    // ---- tables: a chart of the numbers (and big numbers for a Total row); comparison tables stay as they are
    if (n.name === 'table') {
      const rows = tableRows(n), plan = rows ? planTable(rows) : null;
      if (!rows || !plan || !plan.series.length) { kept++; } else {
        const labelHead = plan.head[plan.label] || 'Name';
        const name = under || plan.series.map((s) => s.head).join(', ');
        if (!isBlock(top[i + 1], 'chart')) {
          const labels = plan.data.map((r) => r[plan.label].text);
          const one = plan.series.length === 1, unit = unitOf(plan.series[0]);
          const values = plan.data.map((r) => plan.series.map((s) => gap(r[s.col].text) ? null : readNumber(r[s.col].text)!.value));
          const sum = values.reduce((a, v) => a + (v[0] ?? 0), 0);
          const type = labels.length >= 3 && labels.every((l) => TIME_LABEL.test(l)) ? 'line'
            : one && unit === '%' && labels.length <= 6 && Math.abs(sum - 100) <= 1.5 ? 'pie' : 'bar';
          // names (not dates) longer than a short word read best as bars drawn sideways (Codex concept 1), and never collide
          const horizontal = type === 'bar' && (labels.length > 6 || Math.max(...labels.map((l) => l.length)) >= 8);
          const id = idFor('chart', text(n));
          // the title names what is drawn ("Bookings (₹) by city"), not the section's heading (it may be about another column)
          const by = /^[A-Z][a-z]/.test(labelHead) ? labelHead[0].toLowerCase() + labelHead.slice(1) : labelHead;
          const block = blockFor({ kind: 'chart', type, title: `${plan.series.map((s) => s.head).join(' and ')} by ${by}`.slice(0, 120), unit,
            columns: [labelHead, ...plan.series.map((s) => s.head)], rows: labels.map((l, k) => [l, ...values[k]]), horizontal }, id);
          const notes = [plan.left.length ? `The ${plan.left.map((h) => quoted(h, 24)).join(', ')} ${plan.left.length === 1 ? 'column stays' : 'columns stay'} in the table only.` : '',
            plan.totals.length ? 'The total row is left out of the chart.' : ''].filter(Boolean).join(' ');
          found.push({ id, kind: 'chart', on: true, title: `A ${typeWord[type]} chart of ${quoted(name)}`,
            detail: `The table (${labels.length} rows) gets a ${typeWord[type]} chart under it. The table stays.${notes ? ` ${notes}` : ''}`, block,
            edits: [{ at: end(n), end: end(n), text: blockHtml(block as Row & { kind: string; id: string }), order: 0 }] });
        }
        // A Total row: its amounts become big numbers above the table (1 to 6 of them, each as written).
        const total = plan.totals[plan.totals.length - 1];
        const cols = plan.series.filter((s) => total && !gap(total[s.col].text) && total[s.col].text.length <= 24);
        if (total && cols.length >= 1 && cols.length <= 6 && !isBlock(top[i - 1], 'stat')) {
          const id = idFor('stat', `total:${text(n)}`);
          // "Total bookings (₹)": the row's own word and the column's name (its first letter made small unless it is a short form)
          const named = (h: string) => `${total[plan.label].text} ${/^[A-Z][a-z]/.test(h) ? h[0].toLowerCase() + h.slice(1) : h}`.slice(0, 60);
          const block = blockFor({ kind: 'stat', title: '', items: cols.map((s) => { const t = total[s.col].text, a = indianAmount(t, s.head); return { value: a ? t.replace(a.from, a.to) : t, label: named(s.head), delta: '', tone: 'neutral' }; }) }, id);
          found.push({ id, kind: 'stat', on: true, title: `Big numbers for the ${quoted(total[plan.label].text.toLowerCase(), 24)} of ${quoted(name)}`,
            detail: `The table's ${quoted(total[plan.label].text, 24)} row is shown as ${cols.length} big ${cols.length === 1 ? 'number' : 'numbers'} above the table.`, block,
            edits: [{ at: at(n), end: at(n), text: blockHtml(block as Row & { kind: string; id: string }), order: 1 }] });
        }
      }
      // ---- amounts in the table written the Indian way
      if (rows) {
        const head = rows[0].map((c) => c.text);
        for (const r of rows.slice(1)) r.forEach((c, j) => {
          const a = indianAmount(c.text, head[j] ?? '');
          if (!a) return;
          const tn = (function first(x: N): N | null { for (const k of kids(x)) { if (k.type === 'text' && /\d/.test(k.data ?? '')) return k; const f = isEl(k) ? first(k) : null; if (f) return f; } return null; })(c.node);
          if (!tn || tn.startIndex === null) return;
          const raw = html.slice(at(tn), end(tn)), next = raw.replace(a.from, a.to);
          if (next === raw) return;
          numberEdits.push({ at: at(tn), end: end(tn), text: next, order: 0 });
          if (numberExamples.length < 3) numberExamples.push(`${a.from} → ${a.to}`);
        });
      }
      return;
    }
    // ---- lists: big numbers, a timeline, or a flow diagram
    if (n.name === 'ul' || n.name === 'ol') {
      const items = plainItems(n);
      if (!items || items.length < 2) return;
      const dated = items.map(datedItem);
      if (dated.every(Boolean) && items.length <= 30 && (items.length >= 3 || TIME_HEAD.test(under))) {
        const id = idFor('timeline', text(n));
        const block = blockFor({ kind: 'timeline', title: '', steps: dated.map((d, k) => ({ date: d!.date, text: d!.text, done: items[k].done })) }, id);
        found.push({ id, kind: 'timeline', on: true, title: `A timeline of ${under ? quoted(under) : `${items.length} dated steps`}`,
          detail: `The ${items.length} dated steps${under ? ` under ${quoted(under)}` : ''} become a timeline, each with its date and words.`, block,
          edits: [{ at: at(n), end: end(n), text: blockHtml(block as Row & { kind: string; id: string }), order: 0 }] });
        return;
      }
      const stats = items.map((it) => statItem(it.text));
      if (stats.every(Boolean) && items.length <= 6 && n.attribs?.['data-type'] !== 'taskList'
        && (KEY_HEAD.test(under) || (items.length >= 3 && stats.filter((s) => hasUnit(s!.value)).length * 2 >= items.length))) {
        const id = idFor('stat', text(n));
        const block = blockFor({ kind: 'stat', title: '', items: stats.map((s) => ({ ...s!, tone: 'neutral' })) }, id);
        found.push({ id, kind: 'stat', on: true, title: `Big numbers from ${under ? quoted(under) : 'a list of numbers'}`,
          detail: `The list${under ? ` under ${quoted(under)}` : ''} becomes ${items.length} big numbers, each with its own words.`, block,
          edits: [{ at: at(n), end: end(n), text: blockHtml(block as Row & { kind: string; id: string }), order: 0 }] });
        return;
      }
      if (n.name === 'ol' && items.length >= 3 && items.length <= 8 && items.every((it) => it.text.length <= 70) && FLOW_HEAD.test(under) && !isBlock(top[i + 1], 'diagram')) {
        const id = idFor('diagram', text(n));
        const label = (s: string) => s.replace(/["`]/g, "'").replace(/[<>{}[\]|#;]/g, ' ').replace(/\s+/g, ' ').trim();
        const dir = items.length > 4 ? 'TD' : 'LR';
        const code = `flowchart ${dir}\n${items.map((it, k) => `  s${k + 1}["${label(it.text)}"]`).join('\n')}\n  ${items.map((_, k) => `s${k + 1}`).join(' --> ')}`;
        const block = blockFor({ kind: 'diagram', title: '', code }, id);
        found.push({ id, kind: 'diagram', on: true, title: `A flow diagram of ${quoted(under)}`,
          detail: `The ${items.length} steps under ${quoted(under)} get a flow diagram under them. The list stays.`, block,
          edits: [{ at: end(n), end: end(n), text: blockHtml(block as Row & { kind: string; id: string }), order: 0 }] });
      }
    }
  });

  // ---- long detail sections fold into toggles (sections start at an h2, or at an h1 in a doc with no h2)
  const level = top.some((n) => n.name === 'h2') ? 'h2' : 'h1';
  const starts = top.map((n, i) => n.name === level ? i : -1).filter((i) => i >= 0);
  const docWords = wordsIn(top.map(text).join(' '));
  starts.forEach((s, k) => {
    const stop = (() => { for (let j = s + 1; j < top.length; j++) if (top[j].name === 'h1' || top[j].name === level) return j; return top.length; })();
    const body = top.slice(s + 1, stop);
    if (!body.length) return;
    const heading = text(top[s]), words = wordsIn(body.map(text).join(' '));
    const detail = DETAIL_HEAD.test(heading) && words >= 120;
    const long = !detail && k > 0 && starts.length >= 3 && words >= 700 && docWords >= 1500;
    if (!detail && !long) return;
    const h = top[s], inner = kids(h), first = inner[0], last = inner[inner.length - 1];
    const summary = first && last ? html.slice(at(first), end(last)) : esc(heading);
    const id = idFor('toggle', `${heading}:${words}`);
    found.push({ id, kind: 'toggle', on: detail, title: `Fold ${quoted(heading)} away`,
      detail: `${quoted(heading)} (${words} words) folds into a toggle: readers see its title and open it when they need it.`,
      edits: [{ at: at(h), end: end(h), text: `<details data-type="toggle"><summary>${summary}</summary><div data-type="toggle-content">`, order: 0 },
        { at: end(body[body.length - 1]), end: end(body[body.length - 1]), text: '</div></details>', order: 2 }] });
  });

  if (numberEdits.length) {
    found.push({ id: `numbers_${hash(numberEdits.map((e) => `${e.at}:${e.text}`).join('|'))}`, kind: 'numbers', on: true, title: 'Amounts written the Indian way',
      detail: `${numberEdits.length} ${numberEdits.length === 1 ? 'amount' : 'amounts'} in tables ${numberEdits.length === 1 ? 'is' : 'are'} written with lakh and crore commas (${numberExamples.join(', ')}). The numbers stay the same.`,
      examples: numberExamples, edits: numberEdits });
  }
  return { found, kept };
}

/** What could make this doc richer (nothing is changed). */
export function suggestRicher(html: string): RicherResult {
  const { found, kept } = find(html);
  return { suggestions: found.map(({ edits: _e, ...s }) => s), kept: { tables: kept } };
}

/** The doc with the chosen upgrades made ("all" for every one that starts ticked). Unknown ids mean the doc changed since
 *  the person looked: the caller answers 409 so they look again. */
export function applyRicher(html: string, ids: string[] | 'all'): { html: string; applied: Suggestion[]; missing: string[] } {
  const { found } = find(html);
  const pick = ids === 'all' ? found.filter((f) => f.on) : found.filter((f) => ids.includes(f.id));
  const missing = ids === 'all' ? [] : ids.filter((id) => !found.some((f) => f.id === id));
  // Later places first, so earlier ones keep their positions; at one place, the higher order is written last.
  const edits = pick.flatMap((f) => f.edits).sort((a, b) => b.at - a.at || b.order - a.order);
  let out = html;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return { html: out, applied: pick.map(({ edits: _e, ...s }) => s), missing };
}
