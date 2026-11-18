// API-PLATFORM (owner, 5 Nov 2026: "complete control of Pulse through the API … agents can use it, and tier-wise access
// can be given"): Finance over API v1. The ledger is Finance → Entries (pulse.fin_entry: expenses, payments received,
// bills, refunds and transfers); a key reads it with finance.read and records an expense with finance.write. Every call
// runs as its principal on the v1 transaction and reuses the screen's own code (finance-entry.ts: fin_entry_open,
// createEntry), so the role rule (leadership and the Finance role; never the Accountant's read-only seat) and the approval
// limit are exactly the screen's. Money is integer paise, as everywhere in API v1.
// ARTHA-FIX (2275, owner 17 Nov 2026): an AI employee an admin gave the Finance role reads the ledger too, and also the
// Money records (bank and sheet transactions, Drive bills, Gmail receipts, payroll totals), Finance → Numbers (GST billed
// and received, revenue, expenses, still to collect) and imports a bank statement from a chat file. Recording an entry
// stays a person's (EA's AI guard); approving and budgets stay people's (the database refuses an AI session).
import { createEntry } from './finance-entry.js';
import { buildNumbers, payrollMonths, periodRange, PERIODS, type NumbersRaw } from './finance-truth-model.js';
import { STATEMENT_SOURCES, parseStatement, saveStatementRows, statementFormat, statementSummary, withMatches } from './money-statement.js';
import { orgZone, zoneDay } from './org-time.js';
import { ledgerTotals } from './payroll.js';
import { pageResponse, PAGE_QUERY, pageV1 } from './v1-paging.js';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { bool, change, confirm, confirmed, day, int, maybe, maybeNum, member, num, object, one, paise, qText, rows, str, text, uuid, type Row } from './v1-kit.js';

const KIND = { enum: ['expense', 'income', 'bill', 'refund', 'transfer'] };
const ENTRY = object({ id: uuid, kind: str, direction: str, date: str, amountPaise: int, gstPaise: int, currency: str, category: maybe, vendor: maybe, note: maybe,
  accountFrom: maybe, accountTo: maybe, clientId: maybe, client: maybe, projectId: maybe, project: maybe, status: str, source: str, createdBy: maybe, createdAt: str });
const entryOut = (r: Row) => ({ id: String(r.id), kind: String(r.kind), direction: String(r.direction), date: String(r.date), amountPaise: Number(r.amountMinor), gstPaise: Number(r.gstMinor ?? 0),
  currency: String(r.currency ?? 'INR'), category: (r.category as string) ?? null, vendor: (r.vendor as string) ?? null, note: (r.note as string) ?? null,
  accountFrom: (r.accountFrom as string) ?? null, accountTo: (r.accountTo as string) ?? null, clientId: (r.clientId as string) ?? null, client: (r.clientName as string) ?? null,
  projectId: (r.projectId as string) ?? null, project: (r.projectName as string) ?? null, status: String(r.status), source: String(r.source),
  createdBy: (r.createdBy as string) ?? null, createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt) });
const SELECT = `select e.id,e.kind,e.direction,e.entry_date::text date,e.amount_minor::bigint "amountMinor",e.gst_minor::bigint "gstMinor",e.currency,e.category,e.vendor,e.note,
    e.account_from "accountFrom",e.account_to "accountTo",e.client_id "clientId",c.display_name "clientName",e.project_id "projectId",p.name "projectName",e.status,e.source,
    cb.display_name "createdBy",e.created_at "createdAt"
  from pulse.fin_entry e left join pulse.client c on c.id=e.client_id left join pulse.project p on p.id=e.project_id left join pulse.person cb on cb.id=e.created_by
  where e.deleted_at is null`;
// v1-paging: ascending immutable id under row security, filters before the limit.
const LIST_SQL = `${SELECT} and ($1::uuid is null or e.id>$1) and ($2::text is null or e.kind=$2) and ($3::text is null or e.status=$3)
    and ($4::date is null or (e.entry_date>=$4 and e.entry_date<($4+interval '1 month'))) and ($5::text is null or e.category=$5)
    and ($6::text is null or e.vendor ilike $6 or e.note ilike $6 or e.category ilike $6)
  order by e.id limit $7`;
/** Finance → Entries is for leadership and the Finance role (fin_entry_open refuses anyone else, 403, and records the read). */
const open = async (ctx: V1Context) => { await member(ctx); await ctx.client.query('select pulse.fin_entry_open()'); };
const like = (q?: string) => q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null;
const MONTH = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' };

async function ledger(ctx: V1Context, operationId: string, input: { params: Record<string, string>; query: Record<string, string>; body: unknown }, kind: string | null) {
  await open(ctx);
  const q = input.query;
  return pageV1(ctx, operationId, input, async (after, take) => (await rows(ctx, LIST_SQL, [after, kind ?? q.kind ?? null, q.status ?? null,
    q.month ? `${q.month}-01` : null, q.category ?? null, like(q.query), take])).map(entryOut));
}

defineV1Operation({ operationId: 'listFinanceEntries', method: 'GET', path: '/api/v1/finance/entries', scope: 'finance.read',
  summary: 'The finance ledger (Finance → Entries): expenses, payments received, bills, refunds and transfers',
  query: object({ ...PAGE_QUERY, kind: KIND, status: { enum: ['pending', 'approved', 'rejected'] }, month: MONTH, category: qText(60), query: qText(80) }, []),
  response: pageResponse(ENTRY),
  mcp: { name: 'list_finance_entries', title: 'Read the finance ledger',
    description: 'Lists Finance → Entries you may see (leadership and the Finance role, an AI employee given it included): kind expense, income, bill, refund or transfer; status pending, approved or rejected; month YYYY-MM; category; query matches vendor, note or category. Amounts are paise (₹1 = 100). Pages of up to 100 with nextCursor.' },
  handler: (ctx, input) => ledger(ctx, 'listFinanceEntries', input, null),
});

defineV1Operation({ operationId: 'listExpenses', method: 'GET', path: '/api/v1/finance/expenses', scope: 'finance.read',
  summary: 'Expenses in the finance ledger',
  query: object({ ...PAGE_QUERY, status: { enum: ['pending', 'approved', 'rejected'] }, month: MONTH, category: qText(60), query: qText(80) }, []),
  response: pageResponse(ENTRY),
  mcp: { name: 'list_expenses', title: 'List expenses',
    description: 'Lists expenses in Finance → Entries (leadership and the Finance role): status pending, approved or rejected; month YYYY-MM; category; query matches vendor, note or category. Amounts are paise. Pages of up to 100 with nextCursor.' },
  handler: (ctx, input) => ledger(ctx, 'listExpenses', input, 'expense'),
});

defineV1Operation({ operationId: 'getFinanceEntry', method: 'GET', path: '/api/v1/finance/entries/{entryId}', scope: 'finance.read',
  summary: 'Read one finance entry with its history', params: object({ entryId: uuid }),
  response: object({ entry: ENTRY, history: { type: 'array', items: object({ action: str, at: str, by: maybe }) } }),
  mcp: { name: 'get_finance_entry', title: 'Read a finance entry', description: 'Reads one entry of the finance ledger by id, with who made, changed, approved or rejected it and when.' },
  handler: async (ctx, { params }) => {
    await open(ctx);
    const r = (await rows(ctx, `${SELECT} and e.id=$1`, [params.entryId]))[0] ?? v1Fail(404, 'Entry not found or not visible to you');
    const history = await rows(ctx, `select ev.action,ev.at::text at,p.display_name "by" from pulse.fin_entry_event ev left join pulse.person p on p.id=ev.actor
      where ev.entry_id=$1 order by ev.at limit 100`, [params.entryId]);
    return { entry: entryOut(r), history: history.map(h => ({ action: String(h.action), at: String(h.at), by: (h.by as string) ?? null })) };
  },
});

defineV1Operation({ operationId: 'createExpense', method: 'POST', path: '/api/v1/finance/expenses', scope: 'finance.write',
  summary: 'Record an expense in the finance ledger (it waits for approval above the company\'s limit)',
  body: object({ amountPaise: { ...paise, minimum: 1 }, gstPaise: paise, date: day, category: text(60), vendor: text(120), note: text(1000, 0), accountFrom: text(80),
    clientId: uuid, projectId: uuid, confirm }, ['amountPaise', 'date', 'confirm']),
  response: object({ entry: ENTRY, changeId: maybe }),
  authorize: async ctx => { await member(ctx); if (!(await one<boolean>(ctx, 'select pulse.fin_entry_can(true) v'))) v1Fail(403, 'Finance entries are for leadership and the Finance role'); },
  mcp: { name: 'record_expense', title: 'Record an expense',
    description: 'Records an expense in Finance → Entries as you (leadership and the Finance role): amountPaise (₹1 = 100), date YYYY-MM-DD, and optionally gstPaise, category (from the company\'s list), vendor, note, accountFrom (the account it was paid from), clientId, projectId. Above the company\'s approval limit it waits for an approver. Money: send confirm true only after the person agreed.' },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    confirmed(b, `record an expense of ₹${(Number(b.amountPaise) / 100).toFixed(2)} on ${String(b.date)}`);
    const made = await createEntry(ctx.client, { kind: 'expense', amountMinor: b.amountPaise, gstMinor: b.gstPaise ?? 0, date: b.date, category: b.category, vendor: b.vendor,
      note: b.note, accountFrom: b.accountFrom, clientId: b.clientId, projectId: b.projectId }, 'api') as unknown as Row;
    const id = String(made.id);
    const changeId = await change(ctx, 'expense.create', id, { amountPaise: b.amountPaise, date: b.date });
    return { entry: entryOut((await rows(ctx, `${SELECT} and e.id=$1`, [id]))[0]), changeId };
  },
});

// ---------------------------------------------------------------------------------------------- ARTHA-FIX (2275)
const YM = MONTH;
const N = num, NN = maybeNum, SN = maybe;
const MONTH_ROW = object({ month: str, revenue: N, invoiced: N, gstBilled: N, gstToGstAccount: N, gstToMain: N, collected: NN, collectedFrom: SN, otherIn: N,
  expenses: N, hr: N, hrFrom: SN, net: N, paidInvoices: N, payments: N, refunds: N, overpaid: N });
const TOTALS = object({ revenue: N, invoiced: N, gstBilled: N, gstToGstAccount: N, gstToMain: N, collected: NN, otherIn: N, expenses: N, hr: N, net: N, paidInvoices: N,
  payments: N, tds: N, taxes: N, inputGst: N, refunds: N, overpaid: N, gstOutstanding: N, baseOutstanding: N });
const pick = (r: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
const MONTH_KEYS = Object.keys(MONTH_ROW.properties), TOTAL_KEYS = Object.keys(TOTALS.properties);

defineV1Operation({ operationId: 'getFinanceNumbers', method: 'GET', path: '/api/v1/finance/numbers', scope: 'finance.read',
  summary: 'Finance → Numbers: revenue, GST billed and received, collections, expenses and net per month, and what is still to collect',
  query: object({ period: { enum: [...PERIODS] }, from: YM, to: YM }, []),
  response: object({ period: str, from: str, to: str, months: { type: 'array', items: MONTH_ROW }, totals: TOTALS,
    categories: { type: 'array', items: object({ category: str, net: N }) }, gstAccount: SN, bankEnd: SN, bankLines: bool, payroll: bool,
    outstanding: object({ invoices: N, base: N, gst: N, gstInvoices: N }), notes: { type: 'array', items: str }, empty: bool }),
  mcp: { name: 'get_finance_numbers', title: 'Read the finance numbers (GST, revenue, expenses)',
    description: 'Finance → Numbers for a period (period month, last, quarter, fy, lastfy; or from and to as YYYY-MM; default this financial year, April to March): each month\'s revenue net of GST, invoiced, GST billed, GST received into the GST account and into the main account, collections, other money in, expenses net of GST, HR cost and net; the totals (TDS, taxes paid, input GST, GST and base still to collect); spending by category; and notes saying where each number comes from. Amounts are paise (₹1 = 100). Leadership and the Finance role (an AI employee given it included).' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const today = zoneDay(await orgZone(ctx.client)), p = periodRange(query.period, today, query.from, query.to);
    let raw: NumbersRaw;
    try { raw = (await ctx.client.query('select pulse.finance_numbers($1,$2) n', [`${p.from}-01`, `${p.to}-01`])).rows[0].n as NumbersRaw; }
    catch (e) { if ((e as { code?: string }).code === '42501') v1Fail(403, (e as Error).message); throw e; }
    const nb = buildNumbers(raw, payrollMonths(await ledgerTotals(ctx.client, ctx.tenantId)));
    const notes = Object.values(nb.sources).map((s) => `${s.what}: ${s.from}${s.note ? ` ${s.note}` : ''}`);
    return { period: p.period, from: nb.from, to: nb.to, months: nb.months.map((m) => pick(m as unknown as Row, MONTH_KEYS)), totals: pick(nb.totals as unknown as Row, TOTAL_KEYS),
      categories: nb.categories, gstAccount: nb.gstAccount ?? null, bankEnd: nb.bankEnd ?? null, bankLines: !!nb.access.bank, payroll: !!nb.access.payroll,
      outstanding: { invoices: Number(nb.outstanding.invoices ?? 0), base: Number(nb.outstanding.base ?? 0), gst: Number(nb.outstanding.gst ?? 0), gstInvoices: Number(nb.outstanding.gstInvoices ?? 0) },
      notes, empty: !!nb.empty };
  },
});

/** The Money datasets (company.ts), in the words an AI employee and a person use. */
const MONEY_DATASETS = { bank: 'money_sheet_transactions', monthly: 'money_monthly_expenses', bills: 'money_drive_bills', receipts: 'money_gmail_receipts',
  payroll: 'money_payroll_aggregates', assumptions: 'money_cost_assumptions', subscriptions: 'subscriptions', recurring: 'recurring' } as const;
const MONEY_ROW = object({ id: str, dataset: str, approved: { type: ['boolean', 'null'] }, date: SN, vendor: SN, amount: NN, direction: SN, currency: SN, category: SN,
  status: SN, fields: str });
const moneyOut = (r: Row) => {
  const d = (r.data ?? {}) as Row, amount = Number(d.amount ?? d.last_charge_amount ?? d.planned_monthly_cost);
  const s = (k: string) => (d[k] === undefined || d[k] === null ? null : String(d[k]));
  return { id: String(r.id), dataset: String(r.dataset), approved: typeof r.approved === 'boolean' ? r.approved : null, date: s('date') ?? s('last_charge_date'),
    vendor: s('vendor') ?? s('canonical_vendor') ?? s('tool'), amount: Number.isFinite(amount) ? amount : null, direction: s('direction'), currency: s('currency'), category: s('category'),
    status: s('status'), fields: JSON.stringify(d).slice(0, 1500) };
};

defineV1Operation({ operationId: 'listMoneyRecords', method: 'GET', path: '/api/v1/finance/money', scope: 'finance.read',
  summary: 'Money records: bank and sheet transactions, monthly expenses, Drive bills, Gmail receipts, payroll totals, subscriptions',
  query: object({ dataset: { enum: Object.keys(MONEY_DATASETS) }, offset: { type: 'string', pattern: '^\\d{1,5}$' } }, ['dataset']),
  response: object({ dataset: str, total: int, offset: int, rows: { type: 'array', items: MONEY_ROW }, summary: str }),
  mcp: { name: 'list_money_records', title: 'Read Money records (bank lines, bills, receipts)',
    description: 'Reads the company\'s Money records, 50 at a time from offset: dataset bank (bank, card and UPI lines from the cash-book sheets and imported statements, with direction inflow/outflow), monthly (monthly expenses), bills (bills found in Drive), receipts (receipts found in finance mail), payroll (monthly payroll totals, never one person\'s pay), assumptions (cost assumptions), subscriptions, recurring. Each row has date, vendor, amount in rupees (not paise), direction, currency, category, status, whether a person approved it for reconciliation, and all its fields as JSON. summary counts every dataset. Leadership and the Finance role (an AI employee given it included); never put these rows in a group chat line by line: summarise.' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const dataset = MONEY_DATASETS[query.dataset as keyof typeof MONEY_DATASETS], offset = Number(query.offset ?? 0);
    let data: Row, summary: unknown;
    try {
      data = (await ctx.client.query('select pulse.money_read($1,$2) data', [dataset, offset])).rows[0].data as Row;
      summary = (await ctx.client.query('select pulse.money_summary() data')).rows[0].data;
    } catch (e) { if ((e as { code?: string }).code === '42501') v1Fail(403, 'Money records are for leadership and the Finance role'); throw e; }
    return { dataset: String(query.dataset), total: Number(data.total ?? 0), offset, rows: ((data.rows ?? []) as Row[]).map(moneyOut), summary: JSON.stringify(summary ?? null).slice(0, 4000) };
  },
});

const STATEMENT_ROW = object({ date: SN, vendor: SN, amount: NN, direction: SN, currency: SN, category: SN, matchStatus: SN });
defineV1Operation({ operationId: 'importBankStatement', method: 'POST', path: '/api/v1/finance/statements', scope: 'finance.write',
  summary: 'Read a bank, card, UPI or gateway statement someone sent in a chat (CSV, Excel or PDF) and, once confirmed, add its lines to Money',
  body: object({ fileId: { ...uuid, description: 'The chat file (from the message\'s attachments) holding the statement.' }, sourceType: { enum: [...STATEMENT_SOURCES] },
    accountAlias: text(80, 0), accountLast4: { type: 'string', pattern: '^\\d{4}$' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    amountUnit: { enum: ['rupees', 'paise'] }, defaultDirection: { enum: ['inflow', 'outflow'] }, preview: bool, confirm }, ['fileId', 'sourceType']),
  response: object({ saved: int, duplicates: int, previewed: bool, summary: object({ rows: int, from: SN, to: SN, inflowPaise: int, outflowPaise: int, possibleDuplicates: int }),
    sample: { type: 'array', items: STATEMENT_ROW }, warnings: { type: 'array', items: str }, skipped: int }),
  authorize: async (ctx) => { await member(ctx); if (!(await one<boolean>(ctx, "select pulse.money_can('money.plan.write') and pulse.money_can('money.amount.read') v"))) v1Fail(403, 'Importing statements is for leadership and the Finance role'); },
  mcp: { name: 'import_bank_statement', title: 'Import a bank statement from a chat file',
    description: 'Reads a statement someone attached in a chat with you (fileId from the message\'s attachments; CSV, Excel .xlsx/.xls or PDF; the standard bank exports first) with Pulse\'s statement parser, as Money → Import does. preview true (or no confirm) only reads it: how many lines, first and last day, money in and out, possible repeats of lines Pulse already has, the parser\'s warnings and the first lines. confirm true adds the new lines to Money (repeats are skipped by their reference). sourceType bank, card, upi or gateway; accountAlias names the account (e.g. "HDFC current"); accountLast4 its last four digits; currency (default INR). Leadership and the Finance role (an AI employee given it included).', idempotent: true },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    const f = ((await ctx.client.query('select name,mime,bytes from pulse.chat_file_read($1)', [b.fileId])).rows[0] as { name: string; mime: string | null; bytes: Buffer } | undefined)
      ?? v1Fail(404, 'That chat file is not one you can open: it must be in a chat you are in');
    const format = statementFormat(f.name, f.mime) ?? v1Fail(400, `${f.name} is not a CSV, Excel or PDF statement`);
    if (f.bytes.length > 5 * 1024 * 1024) v1Fail(400, 'Statements up to 5 MB: split it by month');
    let parsed: Row;
    try {
      parsed = await parseStatement({ content: f.bytes.toString('base64'), format, sourceScope: ctx.tenantId, sourceType: b.sourceType, accountAlias: b.accountAlias ?? '',
        currency: b.currency ?? 'INR', amountUnit: b.amountUnit ?? 'rupees', defaultDirection: b.defaultDirection ?? '', accountLast4: b.accountLast4 ?? '', mapping: {} });
    } catch (e) { v1Fail(503, (e as Error).message); }
    if (parsed!.error) v1Fail(400, String(parsed!.error).slice(0, 250));
    const lines = await withMatches(ctx.client, ((parsed!.rows ?? []) as Row[]));
    const out = { summary: statementSummary(lines), sample: lines.slice(0, 15).map((r) => ({ date: (r.date as string) ?? null, vendor: (r.vendor as string) ?? null,
      amount: Number.isFinite(Number(r.amount)) ? Number(r.amount) : null, direction: (r.direction as string) ?? null, currency: (r.currency as string) ?? null,
      category: (r.category as string) ?? null, matchStatus: (r.matchStatus as string) ?? null })), warnings: ((parsed!.warnings ?? []) as unknown[]).map(String).slice(0, 20), skipped: Number(parsed!.skipped ?? 0) };
    if (b.preview === true || b.confirm !== true) {
      await ctx.client.query("select pulse.audit_write('restricted_read','money.statement.preview')");
      return { saved: 0, duplicates: 0, previewed: true, ...out };
    }
    confirmed(b, `add ${lines.length} statement lines from ${f.name} to Money`);
    if (!lines.length) v1Fail(400, 'No transactions were recognised in this statement');
    const r = await saveStatementRows(ctx.client, lines.filter((l) => !(Array.isArray(l.matches) && l.matches.length)), String(b.sourceType));
    // The rows carry who imported them (money_statement_save); the import is on the audit trail.
    await ctx.client.query("select pulse.audit_write('import','money.statement',$1)", [String(b.fileId)]);
    return { saved: r.saved, duplicates: r.duplicates + (lines.length - lines.filter((l) => !(Array.isArray(l.matches) && l.matches.length)).length), previewed: false, ...out };
  },
});
