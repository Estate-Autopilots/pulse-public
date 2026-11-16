// DOCS-INTERACTIVE (owner, 7 Nov 2026): the interactive-block catalogue, on its own with no imports, so docs.ts (the
// sanitiser, Markdown in and out, the templates) and doc-interactive.ts (answers, requests, reading) both use it without
// an import cycle. A block is data from this fixed list of kinds, never code; every field is checked and capped here.
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (x: unknown): x is string => typeof x === 'string' && UUID.test(x);
// ------------------------------------------------------------------------------------------------ the block catalogue
// DOCS-RICH (owner, 9 Nov 2026): chart (line, bar, area, pie, scatter, table or a KPI tile, from a data table), diagram
// (Mermaid code), html (an uploaded web page, kept as a doc file and shown in a sealed frame) and stat (big numbers).
export const BLOCK_KINDS = ['approval', 'checklist', 'form', 'actions', 'quote', 'chart', 'timeline', 'diagram', 'html', 'stat'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
/** The kinds people answer (the others are read-only cards). */
export const ANSWERED: readonly BlockKind[] = ['approval', 'checklist', 'form', 'actions'];
export const line = (v: unknown, max = 200) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const listOf = <T>(v: unknown, max: number, each: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v : []).slice(0, max).map(each).filter((x): x is T => x !== null);
export const blockId = (v: unknown) => typeof v === 'string' && /^b_[A-Za-z0-9]{4,24}$/.test(v) ? v : `b_${Math.random().toString(36).slice(2, 12).padEnd(6, '0')}`;

/** A block as stored: only its kind's own fields, each trimmed and capped. Anything unknown is dropped. */
export function cleanBlock(raw: unknown): (Row & { kind: BlockKind; id: string }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Row;
  const kind = String(b.kind ?? '') as BlockKind;
  if (!(BLOCK_KINDS as readonly string[]).includes(kind)) return null;
  const id = blockId(b.id);
  switch (kind) {
    case 'approval': {
      const on = (b.onApprove && typeof b.onApprove === 'object' ? b.onApprove : {}) as Row;
      const onApprove = line(on.createTask, 200) ? { createTask: line(on.createTask, 200), ...(isId(on.assignee) ? { assignee: on.assignee } : {}) }
        : isId(on.taskId) ? { taskId: on.taskId } : null;
      return { kind, id, question: line(b.question, 300) || 'Do you approve this?', ...(onApprove ? { onApprove } : {}) };
    }
    case 'checklist': return { kind, id, title: line(b.title, 120), items: listOf(b.items, 40, (x) => line(x, 200) || null) };
    case 'form': return { kind, id, title: line(b.title, 120), fields: listOf(b.fields, 20, (x) => {
      const f = (x && typeof x === 'object' ? x : { label: x }) as Row;
      const label = line(f.label, 120);
      if (!label) return null;
      const type = ['text', 'long', 'number', 'date', 'choice'].includes(String(f.type)) ? String(f.type) : 'text';
      return { label, type, ...(type === 'choice' ? { options: listOf(f.options, 12, (o) => line(o, 60) || null) } : {}) };
    }) };
    case 'actions': return { kind, id, title: line(b.title, 120), rows: listOf(b.rows, 40, (x) => line(x, 200) || null) };
    case 'quote': return { kind, id, text: line(b.text, 600), who: line(b.who, 80), role: line(b.role, 80) };
    case 'chart': return cleanChart(b, id);
    case 'timeline': return { kind, id, title: line(b.title, 120), steps: listOf(b.steps, 30, (x) => {
      const s = (x && typeof x === 'object' ? x : {}) as Row;
      return line(s.text, 200) ? { date: line(s.date, 40), text: line(s.text, 200), done: s.done === true } : null;
    }) };
    case 'diagram': return { kind, id, title: line(b.title, 120), code: diagramCode(b.code) };
    case 'html': {
      // The page itself is a doc file (fileId), shown only in a sealed frame (doc-rich.ts). `source` is a page an agent
      // sends inline; saving turns it into that file (takePages) before the body is stored.
      const height = Number(b.height);
      return { kind, id, title: line(b.title, 120) || 'Web page', ...(isId(b.fileId) ? { fileId: b.fileId } : {}),
        ...(Number.isFinite(height) && height >= 120 ? { height: Math.min(4000, Math.round(height)) } : {}) };
    }
    case 'stat': return { kind, id, title: line(b.title, 120), items: listOf(b.items, 6, (x) => {
      const s = (x && typeof x === 'object' ? x : {}) as Row;
      const value = line(s.value, 24);
      if (!value) return null;
      const tone = ['good', 'bad', 'neutral'].includes(String(s.tone)) ? String(s.tone) : 'neutral';
      return { value, label: line(s.label, 60), delta: line(s.delta, 40), tone };
    }) };
  }
}

// ------------------------------------------------------------------------------------------------ DOCS-RICH charts
export const CHART_TYPES = ['line', 'bar', 'area', 'pie', 'scatter', 'table', 'kpi'] as const;
const MAX_ROWS = 500, MAX_COLS = 12;
/** A cell as a number: 1,234.5 / ₹ 40,000 / 12% / -3e2 read as numbers; anything else is empty. */
export const cellNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[,\s₹$€£%]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const round = (n: number) => Math.round(n * 1e6) / 1e6;
/** A chart as stored: a data table (the first column names each row, the others are the series) and how to draw it.
 *  The first DOCS-INTERACTIVE bar chart ({rows: [{label, value}]}) is read as a one-series table of horizontal bars. */
function cleanChart(b: Row, id: string) {
  let columns: string[], rows: (string | number | null)[][], type = String(b.type ?? ''), horizontal = b.horizontal === true;
  if (!Array.isArray(b.columns)) {
    columns = ['Name', line(b.unit, 16) || 'Value'];
    rows = listOf(b.rows, MAX_ROWS, (x) => {
      const r = (x && typeof x === 'object' && !Array.isArray(x) ? x : {}) as Row;
      const v = cellNumber(r.value);
      return line(r.label, 80) && v !== null ? [line(r.label, 80), round(v)] : null;
    });
    if (!type) { type = 'bar'; if (b.horizontal === undefined) horizontal = true; }
  } else {
    columns = listOf(b.columns, MAX_COLS, (x) => line(x, 60) || null);
    if (columns.length < 2) columns = [columns[0] ?? 'Name', 'Value'];
    rows = listOf(b.rows, MAX_ROWS, (x) => {
      if (!Array.isArray(x)) return null;
      const first = typeof x[0] === 'number' && Number.isFinite(x[0]) ? round(x[0]) : line(x[0], 80);
      const rest = columns.slice(1).map((_, i) => { const v = cellNumber(x[i + 1]); return v === null ? null : round(v); });
      return first === '' && rest.every((v) => v === null) ? null : [first, ...rest];
    });
  }
  if (!(CHART_TYPES as readonly string[]).includes(type)) type = 'bar';
  return { kind: 'chart' as const, id, type, title: line(b.title, 120), unit: line(b.unit, 16), columns, rows,
    ...(b.stacked === true && ['bar', 'area'].includes(type) ? { stacked: true } : {}),
    ...(horizontal && type === 'bar' ? { horizontal: true } : {}),
    ...(line(b.note, 300) ? { note: line(b.note, 300) } : {}) };
}

/** Mermaid code, kept line by line (control characters out, 20,000 characters at most). `%%{init …}%%` directives are
 *  dropped: the page sets the theme and the strict security level, and a doc may not change them. */
function diagramCode(v: unknown): string {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').replace(/%%\{[\s\S]*?\}%%/g, '').trim().slice(0, 20000);
}
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const blockHtml = (b: Row & { kind: string; id: string }) =>
  `<div data-type="pulse-block" data-kind="${b.kind}" data-id="${b.id}" data-block="${attr(JSON.stringify(b))}"></div>`;
/** Markdown's fenced ```pulse-block {json}``` becomes the block (agents write blocks this way); a bad one is dropped. */
export function blocksFromMarkdown(md: string): string {
  return md.replace(/^```pulse-block[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm, (_, json: string) => {
    try { const b = cleanBlock(JSON.parse(json)); return b ? `\n${blockHtml(b)}\n` : ''; } catch { return ''; }
  });
}
/** The sanitiser's view of a block's attributes: the checked JSON, or nothing. */
export function blockAttribs(attribs: Record<string, string>): Record<string, string> | null {
  if (attribs['data-type'] !== 'pulse-block') return null;
  try {
    const b = cleanBlock(JSON.parse(attribs['data-block'] ?? '{}'));
    return b ? { 'data-type': 'pulse-block', 'data-kind': b.kind, 'data-id': b.id, 'data-block': JSON.stringify(b) } : {};
  } catch { return {}; }
}
/** The blocks a body holds, in order. */
export function blocksIn(html: string): (Row & { kind: BlockKind; id: string })[] {
  const out: (Row & { kind: BlockKind; id: string })[] = [];
  for (const m of html.matchAll(/<div\b[^>]*data-type="pulse-block"[^>]*>/g)) {
    const raw = (m[0].match(/data-block="([^"]*)"/) ?? [])[1];
    if (!raw) continue;
    try {
      const b = cleanBlock(JSON.parse(raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')));
      if (b) out.push(b);
    } catch { /* skipped */ }
  }
  return out;
}
