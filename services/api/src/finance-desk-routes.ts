import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { googleBridge } from './google.js';
import { ledgerTotals } from './payroll.js';
import { ACCOUNT_LABEL, type Account } from './payroll-model.js';
import { fail, type Tx } from './routes.js';

type DeskRecord = { kind: string; key: string; body: Record<string, unknown> };
type DeskState = { records: DeskRecord[]; files: { key: string; name: string; mime: string }[]; sends: { key: string; status: string }[]; checks?: { key: string; status: string }[] };
type CloseDraft = { to: string; subject: string; emailBody: string; packKey: string; synthetic: boolean };
/** COMP-B: once payroll runs in Pulse, a month's payroll register is the locked runs' totals by ledger account (no names);
 *  the workbook and salary-register totals of those months stay, marked as history. Founders, HR and the Accountant. */
async function withPulsePayroll(c: PoolClient, org: string, state: DeskState) {
  const totals = await ledgerTotals(c, org);
  if (!totals?.length) return state;
  const sums = new Map<string, { month: string; account: string; amount: number; people: number; kinds: Set<string> }>();
  for (const t of totals) {
    const k = `${t.month}|${t.account}`, x = sums.get(k) ?? { month: t.month, account: t.account, amount: 0, people: 0, kinds: new Set<string>() };
    x.amount += t.amount; x.people = Math.max(x.people, t.people); x.kinds.add(t.kind); sums.set(k, x);
  }
  const months = new Set([...sums.values()].map((x) => x.month));
  const old = state.records.map((r) => r.kind === 'payroll' && months.has(String(r.body.month ?? '').slice(0, 7))
    ? { ...r, body: { ...r.body, source: 'Workbook (history)', history: true, basis: `History, replaced by Pulse payroll: ${String(r.body.basis ?? '')}`.trim() } }
    : r.kind === 'payroll' ? { ...r, body: { ...r.body, source: r.body.source ?? 'Workbook' } } : r);
  const pulse = [...sums.values()].filter((x) => x.amount).map((x) => ({ kind: 'payroll', key: `pulse-payroll:${x.month}:${x.account}`, body: {
    month: x.month, name: 'All staff (monthly total)', kind: ACCOUNT_LABEL[x.account as Account] ?? x.account, amount: Math.round(x.amount) / 100, currency: 'INR',
    components: `${x.people} ${x.people === 1 ? 'person' : 'people'}`, source: 'Pulse payroll', basis: `Locked Pulse payroll${x.kinds.has('correction') ? ', with corrections' : ''}; individual pay stays with HR` } }));
  return { ...state, records: [...old, ...pulse] };
}

/** The GST register: one row per sales invoice and purchase bill of the month (YYYY-MM; empty = every month), dated
 *  oldest first, with the GSTINs, the tax split and the CA's check. */
export function gstRegister(state: DeskState, month: string, cell: (x: unknown) => string) {
  const status = new Map((state.checks ?? []).map((k) => [k.key, k.status]));
  const head = ['Type', 'Date', 'Invoice no', 'Party', 'Party GSTIN', 'Our GSTIN on bill', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total GST', 'Invoice total', 'Currency', 'CA check'];
  const rows = [...new Map(state.records.filter((r) => ['sales', 'purchase'].includes(r.kind)).map((r) => [String(r.body.purchaseKey ?? r.key), r])).values()]
    .filter((r) => !/^\d{4}-\d{2}$/.test(month) || String(r.body.date ?? '').startsWith(month))
    .sort((a, b) => String(a.body.date ?? '').localeCompare(String(b.body.date ?? '')) || a.kind.localeCompare(b.kind));
  const line = (r: DeskRecord) => [r.kind === 'sales' ? 'Sales (GSTR-1)' : 'Purchase (GSTR-3B input)', String(r.body.date ?? '').slice(0, 10), r.body.invoiceNo, r.body.vendor,
    r.kind === 'sales' ? r.body.clientGSTIN : r.body.vendorGSTIN, r.kind === 'purchase' ? r.body.ourGSTINPresent : '', r.body.taxable, r.body.cgst, r.body.sgst, r.body.igst, r.body.gst, r.body.total,
    r.body.currency ?? 'INR', status.get(r.key) === 'verified' ? 'Verified' : status.get(r.key) === 'asked' ? 'Asked' : 'Not checked'];
  return [head.join(','), ...rows.map((r) => line(r).map(cell).join(','))].join('\r\n') + '\r\n';
}

export function registerFinanceDeskRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/finance/desk', req => tx(req, async (c, v) => {
    const synthetic = (req.query as { pilot?: string }).pilot === 'synthetic';
    const raw: DeskState & { org?: string } = (await c.query('select pulse.finance_desk_state($1) data', [synthetic])).rows[0].data;
    const state = synthetic ? raw : await withPulsePayroll(c, v.org, raw);
    // CA-ACCESS: the company's own name; the owner also gets who holds CA access (the Access card: salaries tick, end).
    return { ...state, synthetic, accountant: v.role === 'accountant',
      canManage: v.role === 'admin', canApprove: v.role !== 'accountant' && (await c.query('select pulse.hr_is_cofounder() approve')).rows[0].approve,
      intakeMode: synthetic ? 'fixtures' : 'live', company: raw.org ?? 'Your company',
      cas: v.role === 'admin' ? (await c.query('select pulse.finance_ca_people() p')).rows[0].p : [],
      people: v.role === 'admin' ? (await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows : [],
    };
  }));
  // CA-ACCESS (1892): the CA marks a bill Verified, Asks about it (with the question) or reopens it; anyone who reads the
  // desk comments; the CA (or a founder / Finance writer) ticks a month-close step. Authorised before the body is read.
  const KEY = /^[A-Za-z0-9:._@#/+-]{1,200}$/;
  app.post<{ Body: { key?: string; status?: string | null; note?: string; synthetic?: boolean } }>('/api/v0/finance/desk/check', req => tx(req, async (c, v) => {
    if (v.role !== 'accountant') fail(403, 'Only your CA marks a bill verified or asks about it');
    await c.query('select pulse.finance_desk_authorize(false)');
    const key = String(req.body?.key ?? ''); const status = req.body?.status ?? null;
    if (!KEY.test(key)) fail(400, 'Choose a bill or invoice');
    if (status !== null && status !== 'verified' && status !== 'asked') fail(400, 'Choose Verified or Ask');
    return (await c.query('select pulse.finance_doc_mark($1,$2,$3,$4) t', [key, status, String(req.body?.note ?? '').slice(0, 2000), req.body?.synthetic === true])).rows[0].t;
  }));
  app.post<{ Body: { key?: string; body?: string; synthetic?: boolean } }>('/api/v0/finance/desk/note', req => tx(req, async c => {
    await c.query('select pulse.finance_desk_authorize(false)');
    const key = String(req.body?.key ?? '');
    if (!KEY.test(key)) fail(400, 'Choose a bill or invoice');
    return (await c.query('select pulse.finance_doc_note_add($1,$2,$3) t', [key, String(req.body?.body ?? '').slice(0, 2000), req.body?.synthetic === true])).rows[0].t;
  }));
  app.post<{ Body: { month?: string; item?: string; done?: boolean; synthetic?: boolean } }>('/api/v0/finance/desk/close', req => tx(req, async c => {
    await c.query('select pulse.finance_desk_authorize(false)');
    const month = String(req.body?.month ?? '');
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'Choose a month');
    return { ticks: (await c.query('select pulse.finance_close_mark($1,$2,$3,$4) t', [month + '-01', String(req.body?.item ?? ''), req.body?.done !== false, req.body?.synthetic === true])).rows[0].t };
  }));
  app.post<{ Body: { personId?: string; salaries?: boolean; end?: boolean } }>('/api/v0/finance/desk/ca', req => tx(req, async (c, v) => {
    if (v.role !== 'admin') fail(403, 'Only an admin changes what the CA sees');
    if (!/^[0-9a-f-]{36}$/.test(String(req.body?.personId ?? ''))) fail(400, 'Choose your CA');
    return { cas: (await c.query('select pulse.finance_ca_set($1,$2,$3) p', [req.body.personId, typeof req.body.salaries === 'boolean' ? req.body.salaries : null, req.body.end === true])).rows[0].p };
  }));
  app.get<{ Params: { format: string } }>('/api/v0/finance/desk/exports/:format', async (req, reply) => {
    const synthetic = (req.query as { pilot?: string }).pilot === 'synthetic';
    const state: DeskState = await tx(req, async (c, v) => {
      await c.query('select pulse.finance_desk_authorize(false)');
      if (!['tally','zoho-books','gst'].includes(req.params.format)) fail(400, 'Choose the GST register, Tally or Zoho Books CSV');
      const raw: DeskState = (await c.query('select pulse.finance_desk_state($1) data', [synthetic])).rows[0].data;
      return synthetic ? raw : withPulsePayroll(c, v.org, raw);
    });
    const fields = ['kind','date','month','name','vendor','vendorGSTIN','invoiceNo','taxable','cgst','sgst','igst','total','amount','currency','inr','ourGSTINPresent','components'];
    const cell = (x: unknown) => {
      let text = x === null || x === undefined ? '' : typeof x === 'boolean' ? (x ? 'yes' : 'no') : typeof x === 'object' ? JSON.stringify(x) : String(x);
      if (/^[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"','""') + '"';
    };
    const rows = [...new Map(state.records.filter(r => ['purchase','sales','payroll','reimbursement'].includes(r.kind)).map(r => [String(r.body.purchaseKey ?? r.key),r])).values()];
    // CA-ACCESS: the GST register (one month, or all): sales for GSTR-1 and purchases for GSTR-3B input credit, with
    // what the CA verified or asked. Plain CSV, so Excel opens it and TallyPrime's Excel import can map it.
    const csv = req.params.format === 'gst' ? gstRegister(state, String((req.query as { month?: string }).month ?? ''), cell)
      : [fields.join(','), ...rows.map(r => fields.map(f => cell(f === 'kind' ? r.kind : r.body[f])).join(','))].join('\r\n') + '\r\n';
    const month = String((req.query as { month?: string }).month ?? '');
    reply.header('cache-control','private, no-store').header('content-disposition',`attachment; filename="${req.params.format}-register${/^\d{4}-\d{2}$/.test(month) ? '-' + month : ''}.csv"`);
    return reply.type('text/csv; charset=utf-8').send(csv);
  });
  app.get<{ Params: { key: string } }>('/api/v0/finance/desk/files/:key', async (req, reply) => {
    const synthetic = (req.query as { pilot?: string }).pilot === 'synthetic';
    const file = await tx(req, async c => (await c.query('select pulse.finance_desk_file_get($1,$2) data', [req.params.key, synthetic])).rows[0].data);
    if (!file) fail(404, 'Finance evidence unavailable');
    reply.header('cache-control', 'private, no-store');
    // CA-ACCESS: ?inline=1 shows a PDF inside the CA's panel (a preview); anything else is a download.
    const inline = (req.query as { inline?: string }).inline === '1' && file.mime === 'application/pdf';
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(file.name).replace(/[^a-zA-Z0-9_.-]/g,'_')}"`);
    if (inline) reply.header('x-content-type-options', 'nosniff');
    return reply.type(file.mime).send(Buffer.from(file.data, 'base64'));
  });
  app.post<{ Body: { personId: string; expiresOn: string; revoke?: boolean } }>('/api/v0/finance/desk/accountants', req => tx(req, async (c, v) => {
    if (v.role !== 'admin') fail(403, 'Admin required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresOn ?? '') || !/^[0-9a-f-]{36}$/.test(req.body.personId ?? '')) fail(400, 'Choose a person and expiry date');
    await c.query('select pulse.accountant_grant($1,$2,$3)', [req.body.personId, req.body.expiresOn, req.body.revoke === true]);
    return { ok: true, invitation: 'Use the existing per-person Account access invitation. Two-step enrollment and a fresh two-step login are required.' };
  }));
  // Approval is a durable, single-use claim committed BEFORE any provider operation.
  // Provider uncertainty is retained for founder review; repeated taps never resend.
  app.post<{ Body: { key: string; synthetic?: boolean } }>('/api/v0/finance/desk/approve-send', async req => {
    const key = String(req.body.key ?? '');
    const synthetic = req.body.synthetic === true;
    const draft: CloseDraft = await tx(req, async c => {
      await c.query('select pulse.finance_desk_authorize(true)');
      if (!/^close:\d{4}-\d{2}$/.test(key)) fail(400, 'Choose a monthly close draft');
      if (!synthetic && (process.env.PULSE_FINANCE_SEND_ENABLED !== '1' || process.env.PULSE_FINANCE_MAILBOX !== 'finance-bot@estateautopilots.com')) fail(409, 'Finance-bot and founder-approved mail delivery must be configured first');
      return (await c.query('select pulse.finance_desk_send_claim($1,$2) data', [key, synthetic])).rows[0].data;
    });
    let status = 'sink';
    if (!draft.synthetic) {
      try {
        const file = await tx(req, async c => (await c.query('select pulse.finance_desk_file_get($1,$2) data', [draft.packKey, false])).rows[0].data);
        if (!file || draft.to !== 'user-7b81126a@gmail.com') throw new Error('Draft recipient or evidence unavailable');
        const delivery = await googleBridge('send', { subject: process.env.PULSE_FINANCE_MAILBOX, to: draft.to,
          title: draft.subject, body: draft.emailBody, attachment: { name: file.name, mime: file.mime, bytes: file.data } });
        status = delivery.id === 'test-sink' ? 'sink' : 'sent';
      } catch { status = 'uncertain'; }
    }
    await tx(req, async c => c.query('select pulse.finance_desk_send_finish($1,$2,$3)', [key, status, synthetic]));
    return { status };
  });
}
