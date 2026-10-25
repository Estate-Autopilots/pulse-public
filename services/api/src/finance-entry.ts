import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { fail, type Tx } from './routes.js';
import { orgZone, zoneDay } from './org-time.js';
import { cleanEntry, parseQuick, suggestFromScreen, withManual, type Entry } from './finance-entry-model.js';

/* FIN-ENTRY: Finance → Entries. Leadership and the Finance role add expenses, payments received, bills, refunds and
   transfers (form, one-line quick add, /expense from Chats, or a WhatsApp payment screenshot confirmed as an entry).
   The database keeps the approval rule and the history (db/migrations/0880_finance_entry.sql). */
type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const FILE_MAX = 8 * 1024 * 1024;
const uuid = (x: unknown, what = 'entry') => /^[0-9a-f-]{36}$/.test(String(x ?? '')) ? String(x) : fail(400, `Choose a valid ${what}`);
const sha = (x: unknown) => /^[0-9a-f]{64}$/.test(String(x ?? '')) ? String(x) : fail(400, 'Choose a screenshot');
const sniff = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png'
 : b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : b.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : null;
/** The entry checks answer 400 with their own words. */
const clean = (b: Body, today: string) => { try { return cleanEntry(b, today); } catch (e) { return fail(400, e instanceof Error ? e.message : 'Check the entry'); } };
/** Today in the company's own time zone (R51: no fixed India offset). */
const todayIn = async (c: Pick<PoolClient, 'query'>) => zoneDay(await orgZone(c));
const COLUMNS = `e.id,e.kind,e.direction,e.entry_date::text date,e.amount_minor::bigint "amountMinor",e.gst_minor::bigint "gstMinor",e.currency,e.category,
 e.account_from "accountFrom",e.account_to "accountTo",e.client_id "clientId",c.display_name "clientName",e.project_id "projectId",p.name "projectName",
 e.vendor,e.note,e.bill_status "billStatus",e.due_date::text "dueDate",e.status,e.source,e.source_ref "sourceRef",e.quick_text "quickText",
 e.created_at "createdAt",e.updated_at "updatedAt",e.deleted_at is not null deleted,e.delete_reason "deleteReason",e.decision_note "decisionNote",
 cb.display_name "createdBy",db.display_name "decidedBy",e.decided_at "decidedAt",
 coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'mime',f.mime,'size',f.size) order by f.created_at) from pulse.fin_entry_file f where f.entry_id=e.id and f.removed_at is null),'[]') files`;
const FROM = `from pulse.fin_entry e left join pulse.client c on c.id=e.client_id left join pulse.project p on p.id=e.project_id
 left join pulse.person cb on cb.id=e.created_by left join pulse.person db on db.id=e.decided_by`;
const shape = (r: Row) => ({ ...r, amountMinor: Number(r.amountMinor), gstMinor: Number(r.gstMinor) }) as unknown as Entry & Row;

export async function settings(c: PoolClient) {
 const r = (await c.query('select approval_minor::bigint "approvalMinor",categories,accounts from pulse.fin_entry_settings')).rows[0];
 return r ? { ...r, approvalMinor: Number(r.approvalMinor) } as { approvalMinor: number; categories: string[]; accounts: string[] }
  : { approvalMinor: 5000000, categories: ['Ad spend', 'Software & tools', 'Rent & office', 'Salaries', 'Travel', 'Food & office supplies', 'Utilities', 'Professional fees', 'Equipment', 'Taxes & GST', 'Bank charges', 'Client payment', 'Other income', 'Other'], accounts: ['HDFC current', 'ICICI current', 'Company card', 'Cash', 'UPI'] };
}
const can = async (c: PoolClient) => (await c.query('select pulse.fin_entry_can(false) r,pulse.fin_entry_can(true) w,pulse.fin_entry_approver() a')).rows[0] as { r: boolean; w: boolean; a: boolean };
/** Who may write comes before what was typed: anyone else is refused, never told which field is wrong (role matrix). */
const writer = async (c: PoolClient) => { if (!(await can(c)).w) fail(403, 'Finance entries are for leadership and the Finance role'); };
const clients = async (c: PoolClient) => (await c.query("select id,display_name name from pulse.client where coalesce(status,'active')<>'churned' order by display_name limit 2000")).rows as { id: string; name: string }[];

/** Approved entries for the live model (only called where the viewer may already read the live figures). */
export async function manualEntries(c: PoolClient): Promise<Entry[]> {
 if (!(await c.query('select pulse.fin_entry_can(false) ok')).rows[0].ok) return [];
 return (await c.query(`select ${COLUMNS} ${FROM} where e.deleted_at is null and e.status<>'rejected'`)).rows.map(shape);
}
/** The live finance state with hand entries in its totals. */
export async function liveWithManual<T extends { model?: unknown }>(c: PoolClient, live: T | null): Promise<T | null> {
 if (!live?.model) return live;
 return { ...live, model: withManual(live.model as Record<string, unknown>, await manualEntries(c)) };
}

async function saveFiles(c: PoolClient, entry: string, files: unknown) {
 if (files === undefined || files === null) return;
 if (!Array.isArray(files) || files.length > 4) fail(400, 'Add up to four receipts');
 for (const f of files as Row[]) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(f?.data ?? ''));
  if (!m) fail(400, 'The receipt must be a photo or a PDF');
  const bytes = Buffer.from(m![2], 'base64'), mime = sniff(bytes);
  if (!mime) fail(400, 'The receipt must be a photo (JPEG, PNG or WebP) or a PDF');
  if (bytes.length > FILE_MAX) fail(400, 'The receipt is larger than 8 MB: take the photo again at a lower size');
  const name = String(f.name ?? '').trim().slice(0, 200) || (mime === 'application/pdf' ? 'receipt.pdf' : 'receipt.jpg');
  await c.query('insert into pulse.fin_entry_file(org_id,entry_id,name,mime,size,sha256,bytes) values(pulse.current_org(),$1,$2,$3,$4,$5,$6)',
   [entry, name, mime, bytes.length, createHash('sha256').update(bytes).digest('hex'), bytes]);
 }
}
async function checkLinks(c: PoolClient, e: { clientId: string | null; projectId: string | null }) {
 if (e.clientId && !(await c.query('select 1 from pulse.client where id=$1', [e.clientId])).rowCount) fail(400, 'Choose a client from the list');
 if (e.projectId && !(await c.query('select 1 from pulse.project where id=$1', [e.projectId])).rowCount) fail(400, 'Choose a project from the list');
}
const one = async (c: PoolClient, id: string) => { const r = (await c.query(`select ${COLUMNS} ${FROM} where e.id=$1`, [id])).rows[0]; return r ? shape(r) : fail(404, 'Entry not found'); };

/** Create an entry (the form, quick add, Chats or a confirmed screenshot). */
export async function createEntry(c: PoolClient, b: Body, source: 'manual' | 'quick' | 'whatsapp' | 'chat') {
 await writer(c);
 const e = clean(b, await todayIn(c));
 await checkLinks(c, e);
 const ref = source === 'whatsapp' ? sha(b.whatsapp) : null;
 if (ref && (await c.query("select 1 from pulse.fin_entry where source='whatsapp' and source_ref=$1 and deleted_at is null", [ref])).rowCount) fail(409, 'This screenshot is already an entry');
 const id = (await c.query(`insert into pulse.fin_entry(org_id,kind,direction,entry_date,amount_minor,gst_minor,category,account_from,account_to,client_id,project_id,vendor,note,bill_status,due_date,source,source_ref,quick_text)
  values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
  [e.kind, e.direction, e.date, e.amountMinor, e.gstMinor, e.category, e.accountFrom, e.accountTo, e.clientId, e.projectId, e.vendor, e.note, e.billStatus, e.dueDate, source, ref, String(b.quickText ?? '').slice(0, 300) || null])).rows[0].id as string;
 await saveFiles(c, id, b.files);
 if (ref) await c.query("insert into pulse.fin_wa_decision(org_id,sha256,decision,entry_id,actor) values(pulse.current_org(),$1,'confirmed',$2,pulse.current_viewer()) on conflict(org_id,sha256) do update set decision='confirmed',entry_id=excluded.entry_id,actor=excluded.actor,at=now()", [ref, id]);
 return one(c, id);
}

export function registerFinanceEntryRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
 const body = { type: 'object' } as const;
 app.get('/api/v0/finance/entries', (req) => tx(req, async (c) => {
  const approver = (await c.query('select pulse.fin_entry_open() a')).rows[0].a as boolean, rights = await can(c), q = req.query as Record<string, string>;
  const month = /^\d{4}-\d{2}$/.test(q.month ?? '') ? q.month : null, kind = ['expense', 'income', 'bill', 'refund', 'transfer'].includes(q.kind) ? q.kind : null;
  const status = ['pending', 'approved', 'rejected', 'deleted'].includes(q.status) ? q.status : null, search = String(q.q ?? '').trim().slice(0, 80);
  const where = ['true'], args: unknown[] = [];
  if (status === 'deleted') where.push('e.deleted_at is not null'); else { where.push('e.deleted_at is null'); if (status) { args.push(status); where.push(`e.status=$${args.length}`); } }
  if (month) { args.push(month + '-01'); where.push(`e.entry_date>=$${args.length}::date and e.entry_date<($${args.length}::date+interval '1 month')`); }
  if (kind) { args.push(kind); where.push(`e.kind=$${args.length}`); }
  if (search) { args.push(`%${search.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(e.vendor ilike $${args.length} or e.note ilike $${args.length} or e.category ilike $${args.length} or c.display_name ilike $${args.length} or p.name ilike $${args.length})`); }
  const rows = (await c.query(`select ${COLUMNS} ${FROM} where ${where.join(' and ')} order by e.entry_date desc,e.created_at desc limit 300`, args)).rows.map(shape);
  const all = (await c.query(`select to_char(entry_date,'YYYY-MM') as month,direction,status,sum(amount_minor)::bigint minor,count(*)::int n from pulse.fin_entry where deleted_at is null group by 1,2,3 order by 1 desc`)).rows;
  const totals = { moneyIn: 0, moneyOut: 0, count: 0, pending: 0, pendingMinor: 0 };
  for (const r of all) { if (month && r.month !== month) continue; if (r.status === 'approved') { totals.count += r.n; if (r.direction === 'in') totals.moneyIn += Number(r.minor); if (r.direction === 'out') totals.moneyOut += Number(r.minor); if (r.direction === 'neutral') totals.count += 0; } else if (r.status === 'pending') { totals.pending += r.n; totals.pendingMinor += Number(r.minor); } }
  const waPending = rights.r ? Number((await c.query("select count(*) n from pulse.fin_wa_screen s where s.amount is not null and not exists(select 1 from pulse.fin_wa_decision d where d.sha256=s.sha256)")).rows[0].n) : 0;
  return { canWrite: rights.w, canApprove: approver, settings: await settings(c), entries: rows, totals, months: [...new Set(all.map((r) => r.month as string))],
   clients: await clients(c), projects: (await c.query("select id,name,client_id \"clientId\" from pulse.project where status in ('onboarding','active','paused') order by name limit 2000")).rows, whatsapp: waPending };
 }));
 // What the Add entry drawer needs on any Finance page (no figures).
 app.get('/api/v0/finance/entries/options', (req) => tx(req, async (c) => {
  const rights = await can(c);
  if (!rights.r) fail(403, 'Finance entries are for leadership and the Finance role');
  return { canWrite: rights.w, canApprove: rights.a, settings: await settings(c), clients: await clients(c),
   projects: (await c.query("select id,name,client_id \"clientId\" from pulse.project where status in ('onboarding','active','paused') order by name limit 2000")).rows };
 }));
 app.get<{ Params: { id: string } }>('/api/v0/finance/entries/:id', (req) => tx(req, async (c) => {
  await c.query('select pulse.fin_entry_open()');
  const id = uuid(req.params.id), entry = await one(c, id);
  const history = (await c.query(`select ev.action,ev.at,p.display_name "by",ev.before,ev.after from pulse.fin_entry_event ev left join pulse.person p on p.id=ev.actor where ev.entry_id=$1 order by ev.at`, [id])).rows;
  const fields: [string, string][] = [['kind', 'Type'], ['entry_date', 'Date'], ['amount_minor', 'Amount'], ['gst_minor', 'GST'], ['category', 'Category'], ['account_from', 'Paid from'], ['account_to', 'Paid into'], ['vendor', 'Vendor / payer'], ['note', 'Note'], ['client_id', 'Client'], ['project_id', 'Project'], ['bill_status', 'Bill status'], ['due_date', 'Due'], ['status', 'Status']];
  return { entry, history: history.map((h) => ({ action: h.action, at: h.at, by: h.by, changes: h.before ? fields.filter(([k]) => JSON.stringify(h.before[k]) !== JSON.stringify(h.after[k])).map(([k, label]) => ({ field: label, from: h.before[k], to: h.after[k] })) : [] })) };
 }));
 app.post<{ Body: Body }>('/api/v0/finance/entries', { schema: { body }, bodyLimit: Math.ceil(FILE_MAX * 4 * 1.37) + 16384 }, (req) => tx(req, async (c) => {
  const b = req.body ?? {}, source = b.whatsapp ? 'whatsapp' : b.quickText ? 'quick' : 'manual';
  return createEntry(c, b, source);
 }));
 app.post<{ Params: { id: string }; Body: Body }>('/api/v0/finance/entries/:id', { schema: { body }, bodyLimit: Math.ceil(FILE_MAX * 4 * 1.37) + 16384 }, (req) => tx(req, async (c) => {
  await writer(c);
  const id = uuid(req.params.id), before = await one(c, id);
  if (before.deleted) fail(409, 'This entry was deleted; restore it first');
  const e = clean({ ...req.body, kind: req.body.kind ?? before.kind }, await todayIn(c));
  await checkLinks(c, e);
  await c.query(`update pulse.fin_entry set kind=$2,direction=$3,entry_date=$4,amount_minor=$5,gst_minor=$6,category=$7,account_from=$8,account_to=$9,client_id=$10,project_id=$11,vendor=$12,note=$13,bill_status=$14,due_date=$15 where id=$1`,
   [id, e.kind, e.direction, e.date, e.amountMinor, e.gstMinor, e.category, e.accountFrom, e.accountTo, e.clientId, e.projectId, e.vendor, e.note, e.billStatus, e.dueDate]);
  await saveFiles(c, id, req.body.files);
  return one(c, id);
 }));
 app.post<{ Params: { id: string }; Body: Body }>('/api/v0/finance/entries/:id/delete', { schema: { body } }, (req) => tx(req, async (c) => {
  await writer(c);
  const reason = String(req.body?.reason ?? '').trim().slice(0, 300) || fail(400, 'Say why it is deleted (a typo, a duplicate, not company money)');
  const r = await c.query('update pulse.fin_entry set deleted_at=now(),deleted_by=pulse.current_viewer(),delete_reason=$2 where id=$1 and deleted_at is null', [uuid(req.params.id), reason]);
  if (!r.rowCount) fail(404, 'Entry not found or already deleted');
  await c.query('delete from pulse.fin_wa_decision where entry_id=$1', [req.params.id]);
  return { ok: true };
 }));
 app.post<{ Params: { id: string } }>('/api/v0/finance/entries/:id/restore', (req) => tx(req, async (c) => {
  await writer(c);
  const r = await c.query('update pulse.fin_entry set deleted_at=null,deleted_by=null,delete_reason=null where id=$1 and deleted_at is not null', [uuid(req.params.id)]);
  if (!r.rowCount) fail(404, 'Entry not found');
  return one(c, req.params.id);
 }));
 app.post<{ Params: { id: string }; Body: Body }>('/api/v0/finance/entries/:id/decide', { schema: { body } }, (req) => tx(req, async (c) => {
  if (!(await c.query('select pulse.fin_entry_approver() a')).rows[0].a) fail(403, 'Only leadership approves entries above the limit');
  const status = req.body?.decision === 'approve' ? 'approved' : req.body?.decision === 'reject' ? 'rejected' : fail(400, 'Approve or reject');
  const r = await c.query('update pulse.fin_entry set status=$2,decision_note=$3 where id=$1 and deleted_at is null', [uuid(req.params.id), status, String(req.body?.note ?? '').trim().slice(0, 300) || null]);
  if (!r.rowCount) fail(404, 'Entry not found');
  return one(c, req.params.id);
 }));
 app.post<{ Params: { id: string } }>('/api/v0/finance/entries/files/:id/remove', (req) => tx(req, async (c) => {
  await writer(c);
  const r = await c.query('update pulse.fin_entry_file set removed_at=now() where id=$1 and removed_at is null returning entry_id', [uuid(req.params.id, 'receipt')]);
  if (!r.rowCount) fail(404, 'Receipt not found');
  if (r.rows[0].entry_id) await c.query('update pulse.fin_entry set updated_at=now() where id=$1', [r.rows[0].entry_id]);
  return { ok: true };
 }));
 app.get<{ Params: { id: string } }>('/api/v0/finance/entries/files/:id', async (req, reply) => {
  const f = await tx(req, async (c) => { await c.query('select pulse.fin_entry_open()'); return (await c.query('select name,mime,bytes from pulse.fin_entry_file where id=$1', [uuid(req.params.id, 'receipt')])).rows[0] ?? fail(404, 'Receipt not found'); });
  reply.header('cache-control', 'private, no-store').header('content-security-policy', 'sandbox').header('content-disposition', `inline; filename="${String(f.name).replace(/[^\w.-]+/g, '_')}"`);
  return reply.type(f.mime).send(f.bytes);
 });
 // One line → the form. `save` (Chats' /expense) also saves it when the amount was understood.
 app.post<{ Body: Body }>('/api/v0/finance/entries/parse', { schema: { body } }, (req) => tx(req, async (c) => {
  if (!(await c.query('select pulse.fin_entry_can(false) ok')).rows[0].ok) fail(403, 'Finance entries are for leadership and the Finance role');
  const s = await settings(c), text = String(req.body?.text ?? '').slice(0, 300);
  return parseQuick(text, await todayIn(c), { categories: s.categories, accounts: s.accounts, clients: await clients(c) });
 }));
 app.post<{ Body: Body }>('/api/v0/finance/entries/quick', { schema: { body } }, (req) => tx(req, async (c) => {
  if (!(await c.query('select pulse.fin_entry_can(true) ok')).rows[0].ok) fail(403, 'Adding finance entries is for leadership and the Finance role');
  const s = await settings(c), text = String(req.body?.text ?? '').trim().slice(0, 300);
  const q = parseQuick(text, await todayIn(c), { categories: s.categories, accounts: s.accounts, clients: await clients(c) });
  const href = `/finance?tab=entries&quick=${encodeURIComponent(text.replace(/^\/\w+\s*/, ''))}`;
  if (req.body?.save !== true || q.missing.includes('amount')) return { parsed: q, saved: null, href };
  const entry = await createEntry(c, { ...q, amountMinor: q.amountMinor, gstMinor: q.gstMinor, quickText: text }, req.body?.from === 'chat' ? 'chat' : 'quick');
  return { parsed: q, saved: entry, href: `/finance?tab=entries&entry=${entry.id}` };
 }));
 app.post<{ Body: Body }>('/api/v0/finance/entries/settings', { schema: { body } }, (req) => tx(req, async (c) => {
  if (!(await c.query('select pulse.fin_entry_approver() a')).rows[0].a) fail(403, 'Leadership sets the approval limit, categories and accounts');
  const cur = await settings(c), b = req.body ?? {};
  const list = (x: unknown, max: number, label: string) => { if (x === undefined) return undefined; const items = [...new Set((Array.isArray(x) ? x : String(x).split(/\n|,/)).map((s) => String(s).trim().slice(0, 60)).filter(Boolean))]; if (!items.length || items.length > max) fail(400, `Keep between 1 and ${max} ${label}`); return items; };
  const limit = b.approvalMinor === undefined ? cur.approvalMinor : Number(b.approvalMinor);
  if (!Number.isSafeInteger(limit) || limit < 0) fail(400, 'Give the approval limit in rupees');
  const categories = list(b.categories, 80, 'categories') ?? cur.categories, accounts = list(b.accounts, 40, 'accounts') ?? cur.accounts;
  await c.query(`insert into pulse.fin_entry_settings(org_id,approval_minor,categories,accounts,updated_by) values(pulse.current_org(),$1,$2,$3,pulse.current_viewer())
   on conflict(org_id) do update set approval_minor=excluded.approval_minor,categories=excluded.categories,accounts=excluded.accounts,updated_by=excluded.updated_by,updated_at=now()`, [limit, categories, accounts]);
  return settings(c);
 }));
 // Found in WhatsApp: payment screenshots not yet confirmed or set aside, newest first, with a suggested entry each.
 app.get('/api/v0/finance/entries/whatsapp', (req) => tx(req, async (c) => {
  await c.query('select pulse.fin_entry_open()');
  const q = req.query as Record<string, string>, offset = Math.max(0, Math.min(1e5, Number(q.offset) || 0)), s = await settings(c), today = await todayIn(c);
  const show = q.show === 'dismissed' ? "d.decision='dismissed'" : q.show === 'confirmed' ? "d.decision='confirmed'" : 'd.sha256 is null';
  const total = Number((await c.query(`select count(*) n from pulse.fin_wa_screen w left join pulse.fin_wa_decision d on d.sha256=w.sha256 where w.amount is not null and ${show}`)).rows[0].n);
  const rows = (await c.query(`select w.sha256,w.amount::float8 amount,w.amounts::float8[] amounts,w.transaction_ids "transactionIds",w.dates_in_text "datesInText",w.payee,w.sent_at "sentAt",w.sender,w.sender_role "senderRole",
   w.message_text "messageText",w.group_title "groupTitle",w.client_hint "clientHint",w.drive_file_id "driveFileId",w.thumb is not null "hasImage",d.decision,d.entry_id "entryId"
   from pulse.fin_wa_screen w left join pulse.fin_wa_decision d on d.sha256=w.sha256 where w.amount is not null and ${show} order by w.sent_at desc nulls last limit 24 offset $1`, [offset])).rows;
  const cl = await clients(c);
  const out = [];
  for (const r of rows) {
   const sug = suggestFromScreen({ amount: r.amount, payee: r.payee, sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null, senderRole: r.senderRole, messageText: r.messageText, groupTitle: r.groupTitle, clientHint: r.clientHint, datesInText: r.datesInText ?? [] }, today, s.categories);
   const hint = String(sug.client ?? '').toLowerCase().replace(/^(mr|mrs|ms)\.?\s+/, '');
   const client = hint.length >= 4 ? cl.find((x) => x.name.toLowerCase() === hint) ?? cl.find((x) => x.name.toLowerCase().includes(hint) || hint.includes(x.name.toLowerCase()) && x.name.length >= 5) : undefined;
   const same = sug.amountMinor ? (await c.query("select id,entry_date::text date from pulse.fin_entry where deleted_at is null and amount_minor=$1 and entry_date between $2::date-3 and $2::date+3 limit 1", [sug.amountMinor, sug.date])).rows[0] : null;
   out.push({ ...r, suggestion: { ...sug, clientId: client?.id ?? null, clientName: client?.name ?? null }, maybeDuplicate: same ?? null });
  }
  return { total, offset, rows: out };
 }));
 app.get<{ Params: { sha: string } }>('/api/v0/finance/entries/whatsapp/:sha/image', async (req, reply) => {
  const f = await tx(req, async (c) => { await c.query('select pulse.fin_entry_open()'); return (await c.query('select thumb,thumb_mime from pulse.fin_wa_screen where sha256=$1 and thumb is not null', [sha(req.params.sha)])).rows[0] ?? fail(404, 'No picture for this screenshot'); });
  reply.header('cache-control', 'private, max-age=3600').header('content-security-policy', 'sandbox').header('content-disposition', 'inline; filename="screenshot"');
  return reply.type(f.thumb_mime).send(f.thumb);
 });
 app.post<{ Params: { sha: string } }>('/api/v0/finance/entries/whatsapp/:sha/dismiss', (req) => tx(req, async (c) => {
  await writer(c);
  await c.query("insert into pulse.fin_wa_decision(org_id,sha256,decision,actor) values(pulse.current_org(),$1,'dismissed',pulse.current_viewer()) on conflict(org_id,sha256) do update set decision='dismissed',entry_id=null,actor=excluded.actor,at=now()", [sha(req.params.sha)]);
  return { ok: true };
 }));
 app.post<{ Params: { sha: string } }>('/api/v0/finance/entries/whatsapp/:sha/undo', (req) => tx(req, async (c) => {
  await writer(c);
  await c.query("delete from pulse.fin_wa_decision where sha256=$1 and decision='dismissed'", [sha(req.params.sha)]);
  return { ok: true };
 }));
}
