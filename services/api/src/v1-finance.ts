// API-PLATFORM (owner, 5 Nov 2026: "complete control of Pulse through the API … agents can use it, and tier-wise access
// can be given"): Finance over API v1. The ledger is Finance → Entries (pulse.fin_entry: expenses, payments received,
// bills, refunds and transfers); a key reads it with finance.read and records an expense with finance.write. Every call
// runs as its principal on the v1 transaction and reuses the screen's own code (finance-entry.ts: fin_entry_open,
// createEntry), so the role rule (leadership and the Finance role; never the Accountant's read-only seat, never an AI
// member) and the approval limit are exactly the screen's. Money is integer paise, as everywhere in API v1.
import { createEntry } from './finance-entry.js';
import { pageResponse, PAGE_QUERY, pageV1 } from './v1-paging.js';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { change, confirm, confirmed, day, int, maybe, member, object, one, paise, qText, rows, str, text, uuid, type Row } from './v1-kit.js';

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
    description: 'Lists Finance → Entries you may see (leadership and the Finance role): kind expense, income, bill, refund or transfer; status pending, approved or rejected; month YYYY-MM; category; query matches vendor, note or category. Amounts are paise (₹1 = 100). Pages of up to 100 with nextCursor.' },
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
