// Readable output by default (tables for lists, aligned fields for one record); --json prints Pulse's answer as is.
import { redact } from './errors.js';

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length ? value.map(cell).join(', ') : '-';
  if (isRow(value)) return Object.entries(value).map(([k, v]) => `${k}=${cell(v)}`).join(' ');
  return String(value).replace(/\s+/g, ' ');
}

const clip = (text: string, width: number) => text.length <= width ? text : text.slice(0, Math.max(1, width - 1)) + '…';

/** A plain table; long cells are cut so a row fits the terminal (full values: --json). */
export function table(rows: Row[], columns?: string[], width = process.stdout.columns || 160): string {
  if (!rows.length) return 'No results.';
  const cols = columns?.length ? columns : autoColumns(rows);
  const text = rows.map(r => cols.map(c => cell(r[c])));
  const widths = cols.map((c, i) => Math.min(48, Math.max(c.length, ...text.map(r => r[i].length))));
  // Shrink the widest columns until the row fits (never below 8).
  const total = () => widths.reduce((a, b) => a + b, 0) + 2 * (cols.length - 1);
  while (total() > width) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 8) break;
    widths[i]--;
  }
  const line = (cells: string[]) => cells.map((c, i) => clip(c, widths[i]).padEnd(widths[i])).join('  ').trimEnd();
  return [line(cols.map(c => c.toUpperCase())), ...text.map(line)].join('\n');
}

function autoColumns(rows: Row[]): string[] {
  const keys: string[] = [];
  for (const r of rows.slice(0, 20)) for (const [k, v] of Object.entries(r)) if (!keys.includes(k) && (scalar(v) || (Array.isArray(v) && v.every(scalar)))) keys.push(k);
  return keys.slice(0, 8);
}

/** One record: scalar fields aligned, then nested records and lists as their own blocks. */
export function record(value: Row, indent = ''): string {
  const flat = Object.entries(value).filter(([, v]) => scalar(v) || v === undefined || (Array.isArray(v) && v.every(scalar)));
  const nested = Object.entries(value).filter(([k]) => !flat.some(([f]) => f === k));
  const pad = Math.max(0, ...flat.map(([k]) => k.length));
  const out = flat.map(([k, v]) => `${indent}${k.padEnd(pad)}  ${cell(v)}`);
  for (const [k, v] of nested) {
    if (out.length) out.push('');
    out.push(`${indent}${k}:`);
    if (Array.isArray(v)) out.push(v.length ? table(v.filter(isRow)).split('\n').map(l => indent + '  ' + l).join('\n') : `${indent}  (none)`);
    else if (isRow(v)) out.push(record(v, indent + '  '));
  }
  return out.join('\n');
}

/** A list answer ({items|results, nextCursor}) as a table, anything else as a record. */
export function human(value: unknown, columns?: string[]): string {
  if (Array.isArray(value)) return value.every(isRow) ? table(value, columns) : value.map(cell).join('\n');
  if (!isRow(value)) return cell(value);
  const listKey = ['items', 'results'].find(k => Array.isArray(value[k]));
  if (listKey) {
    const rows = (value[listKey] as unknown[]).filter(isRow);
    const rest = Object.entries(value).filter(([k, v]) => k !== listKey && k !== 'nextCursor' && v !== undefined);
    const parts = [table(rows, columns)];
    if (rest.length) parts.unshift(record(Object.fromEntries(rest)), '');
    if (typeof value.nextCursor === 'string' && value.nextCursor) parts.push('', `More results: add --cursor ${value.nextCursor}`);
    return parts.join('\n');
  }
  return record(value);
}

export const print = (text: string) => process.stdout.write(redact(text) + '\n');
export const printJson = (value: unknown) => print(JSON.stringify(value, null, 2));
