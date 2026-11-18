// ARTHA-FIX (owner, 17 Nov 2026: the Finance AI employee needs "access to all finance endpoints and everything related to
// money"): a bank, card, UPI or gateway statement read by Pulse's own parser (tools/statement-parse.py, the same one Money
// → Import uses: CSV, Excel or PDF, base64 in) and kept with money_statement_save (repeated rows skipped by their
// reference hash). The screen's route (company.ts /api/v0/money/import) and API v1 (v1-finance.ts) share the parser.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';

type Row = Record<string, unknown>;
export const STATEMENT_SOURCES = ['bank', 'card', 'upi', 'gateway'] as const;
export const STATEMENT_FORMATS = ['csv', 'xlsx', 'xls', 'pdf'] as const;
/** The fields money_statement_save keeps of a parsed row (the preview's matches and labels are not stored). */
const KEEP = ['date', 'vendor', 'amount', 'direction', 'currency', 'category', 'reference_hash', 'account_digest', 'source_file_digest', 'file_replay_key', 'date_basis',
  'minor_unit_scale', 'original_amount_unit', 'reference_kind', 'parser_issues'];

/** The statement's format from its name or type: csv, xlsx, xls or pdf (null: not a statement Pulse reads). */
export function statementFormat(name: string, mime: string | null): typeof STATEMENT_FORMATS[number] | null {
  const ext = String(name ?? '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] ?? '';
  if ((STATEMENT_FORMATS as readonly string[]).includes(ext)) return ext as typeof STATEMENT_FORMATS[number];
  const m = String(mime ?? '').toLowerCase();
  return m === 'text/csv' ? 'csv' : m === 'application/pdf' ? 'pdf' : m.includes('spreadsheetml') ? 'xlsx' : m === 'application/vnd.ms-excel' ? 'xls' : null;
}

/** Runs the parser (30 s at most); its own error words come back as { error }. */
export function parseStatement(input: Row & { content: string; format: string; sourceScope: string }): Promise<Row> {
  return new Promise<Row>((done, reject) => {
    const child = execFile(process.env.PULSE_WORKER_PYTHON ?? resolve('.venv/bin/python'), [resolve('tools/statement-parse.py')], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
      (err, out) => { if (err) { reject(new Error('Statement parser unavailable')); return; } try { done(JSON.parse(out) as Row); } catch { reject(new Error('Statement parser unavailable')); } });
    child.stdin?.end(JSON.stringify(input));
  });
}

/** Each parsed row with the Money records it may repeat (same day, amount, direction and currency). */
export async function withMatches(c: PoolClient, rows: Row[]): Promise<Row[]> {
  const known = (await c.query('select pulse.money_workspace() data')).rows[0].data as { id: string; dataset: string; data: Row; projectId?: string; projectName?: string }[] | null;
  return rows.map((r) => {
    const matches = (known ?? []).filter((k) => k.dataset === 'money_sheet_transactions' && k.data.date === r.date && k.data.currency === r.currency && k.data.direction === r.direction && Number(k.data.amount) === Number(r.amount));
    return { ...r, matches: matches.map((k) => ({ id: k.id, projectId: k.projectId, projectName: k.projectName })), matchStatus: matches.length ? 'Possible duplicate — review' : 'New observation' };
  });
}

/** Keeps the rows (money_statement_save checks the grants and each row); repeated rows are skipped. */
export async function saveStatementRows(c: PoolClient, rows: Row[], sourceType: string) {
  const clean = rows.map((r) => Object.fromEntries([...KEEP, ...(r.account_last4 ? ['account_last4'] : [])].filter((k) => r[k] !== undefined).map((k) => [k, r[k]])));
  const saved = Number((await c.query('select pulse.money_statement_save($1,$2) saved', [JSON.stringify(clean), sourceType])).rows[0].saved);
  return { saved, duplicates: clean.length - saved };
}

/** A statement's totals in paise (inflow, outflow), its first and last day and its parser warnings, for a short answer. */
export function statementSummary(rows: Row[]) {
  const paise = (r: Row) => Math.round(Number(r.amount ?? 0) * 100);
  const days = rows.map((r) => String(r.date ?? '')).filter(Boolean).sort();
  return { rows: rows.length, from: days[0] ?? null, to: days.at(-1) ?? null,
    inflowPaise: rows.filter((r) => r.direction === 'inflow').reduce((n, r) => n + paise(r), 0),
    outflowPaise: rows.filter((r) => r.direction === 'outflow').reduce((n, r) => n + paise(r), 0),
    possibleDuplicates: rows.filter((r) => Array.isArray(r.matches) && r.matches.length).length };
}
