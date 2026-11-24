// SX-QUOTES (Sales X-Ray's list for the Pulse team, 22 Nov 2026, §4; migration 2525): quotations through the org link, at
// {issuer}/api/v1/connect/orgs/{org_id}/… with the link's access token (connect-api.ts's bearer):
//   GET  catalogue/items?q=&cursor=                 pulse.catalogue.read   active items, prices in paise
//   PUT  contacts/by-ref/sx:lead:{uuid}            pulse.contacts.write   the lead as Pulse knows it (the same as PUT leads/{id})
//   GET  quotes?lead_ref=|external_ref=|status=    pulse.quotes.read
//   POST quotes                                    pulse.quotes.write     made, priced, taxed and approved under the company's rules
//   GET  quotes/{id}                                pulse.quotes.read
//   GET  quotes/{id}/pdf                            pulse.quotes.read      the bytes, ETag = sha-256, If-None-Match → 304
//   PUT  quotes/{id}/delivery-owner {owner}        pulse.quotes.write     sales_xray: Pulse offers no Send of its own
//   POST quotes/{id}/deliveries                     pulse.quotes.write     a send the app made; its touch id makes a repeat a no-op
// Every quote call names the seller (X-Pulse-Acting-Sub: their Pulse sub) and runs as that person, with their rights and
// approval rules (a seller reads the quotations they may see in Pulse; the catalogue needs no seller); creates take an Idempotency-Key (the same key and body: the first answer again; another body: 409).
// The token's own refusals keep the connect API's words; these routes answer {"error":{code,message,field?,latest_id?}}.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { pdfPageCount } from '@pulse/invoice-doc';
import { createDraft, DOC_COLS, issueDocument, quotationPdf, saveDraft } from './erp.js';
import type { Principal } from './connect-api.js';
import type { Viewer } from './routes.js';

type Bearer = <T>(req: FastifyRequest, reply: FastifyReply, op: string, scope: string, write: boolean, run: (c: PoolClient, p: Principal) => Promise<T>) => Promise<T | FastifyReply>;
type Helpers = { bearer: Bearer; personOf: (c: PoolClient, p: Principal, who: unknown) => Promise<string | null>; viewerOf: (p: Principal, c: PoolClient) => Promise<Viewer> };
type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEAD_REF = /^sx:lead:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const REF = /^[A-Za-z0-9:._-]{1,100}$/;
const KEY = /^[A-Za-z0-9:._-]{8,100}$/;
const CHANNELS = ['whatsapp', 'whatsapp_phone', 'email', 'sms', 'link', 'other'];
export class SxError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Row = {}) { super(message); }
}
const no = (status: number, code: string, message: string, extra: Row = {}): never => { throw new SxError(status, code, message, extra); };

/** A quotation's state in the app's words (§4.4 item 11). */
export function quoteStatus(d: { status: string; approvalTo?: unknown; supersededBy?: unknown; validUntil?: string | null }, today: string): string {
  if (d.supersededBy) return 'superseded';
  if (d.status === 'draft') return d.approvalTo ? 'pending_approval' : 'draft';
  if (['issued', 'sent'].includes(d.status) && d.validUntil && d.validUntil < today) return 'expired';
  return ({ issued: 'ready', sent: 'sent', accepted: 'accepted', converted: 'accepted', declined: 'declined', cancelled: 'void' } as Record<string, string>)[d.status] ?? d.status;
}
/** The stable hash of a request body for idempotency (keys sorted, so the same body in another order is the same). */
export function bodyHash(body: unknown): string {
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as Row).sort().map((k) => [k, sort((x as Row)[k])])) : x;
  return createHash('sha256').update(JSON.stringify(sort(body ?? null))).digest('hex');
}

export function registerConnectQuotes(app: FastifyInstance, { bearer, personOf, viewerOf }: Helpers) {
  const base = '/api/v1/connect/orgs/:org_id';
  const PARAMS = { type: 'object', properties: { org_id: { type: 'string', pattern: UUID.source }, id: { type: 'string', pattern: UUID.source } } } as const;

  /** Runs one of these routes on the bearer's transaction: refusals in the app's error shape, nothing written on one. */
  const sx = <T>(req: FastifyRequest, reply: FastifyReply, op: string, scope: string, write: boolean, run: (c: PoolClient, p: Principal) => Promise<T>) =>
    bearer(req, reply, op, scope, write, async (c, p) => {
      await c.query('savepoint sx');
      try { return await run(c, p); } catch (e) {
        await c.query('rollback to savepoint sx');
        if (e instanceof SxError) {
          if (e.extra.retry_after) reply.header('retry-after', String(e.extra.retry_after));
          return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...e.extra } });
        }
        const pg = (e as { code?: string; message?: string; statusCode?: number }).code, status = (e as { statusCode?: number }).statusCode;
        if (status && status < 500) return reply.code(status === 400 ? 422 : status).send({ error: { code: status === 404 ? 'not_found' : status === 403 ? 'member_not_allowed' : status === 409 ? 'conflict' : 'validation', message: (e as Error).message } });
        if (pg === '42501') return reply.code(403).send({ error: { code: 'member_not_allowed', message: (e as Error).message } });
        if (pg === '22023' || pg === '23514') return reply.code(422).send({ error: { code: 'validation', message: (e as Error).message } });
        throw e;
      }
    });
  /** The seller this write is for: their Pulse sub, a member of this organisation who may make quotations. */
  async function acting(c: PoolClient, p: Principal, req: FastifyRequest, write = true) {
    const sub = req.headers['x-pulse-acting-sub'];
    if (typeof sub !== 'string' || !sub) return no(403, 'member_not_allowed', 'Name the seller: X-Pulse-Acting-Sub with their Pulse sub');
    const person = await personOf(c, p, { sub });
    if (!person) return no(403, 'member_not_allowed', 'That sub is not a member of this organisation');
    await c.query("select set_config('pulse.viewer_id',$1,true)", [person]);
    const ok = (await c.query("select p.status='active' and p.side='staff' and pulse.erp_can($2) v from pulse.person p where p.id=$1", [person, write])).rows[0]?.v === true;
    if (!ok) return no(403, 'member_not_allowed', 'This person may not make quotations in Pulse');
    return { person, viewer: { ...(await viewerOf(p, c)), person } as Viewer };
  }
  /** The first answer to an Idempotency-Key, or null to go on (and remember the answer with `keep`). */
  async function idem(c: PoolClient, p: Principal, req: FastifyRequest, op: string) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY.test(key)) return no(422, 'validation', 'Send an Idempotency-Key (a UUID)', { field: 'Idempotency-Key' });
    const hash = bodyHash(req.body);
    const seen = (await c.query('select op,body_hash,status,answer from pulse.connect_idem where grant_id=$1 and key=$2', [p.grant, key])).rows[0];
    if (seen && (seen.op !== op || seen.body_hash !== hash)) return no(409, 'idempotency_mismatch', 'This Idempotency-Key was used with another request');
    return { seen: seen ? { status: seen.status as number, answer: seen.answer } : null,
      keep: (status: number, answer: unknown) => c.query('insert into pulse.connect_idem(org_id,grant_id,key,op,body_hash,status,answer) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing',
        [p.org, p.grant, key, op, hash, status, JSON.stringify(answer)]) };
  }
  const subOf = (c: PoolClient, p: Principal, person: unknown) => person ? c.query('select pulse.oidc_sub($1,$2) s', [p.app, person]).then((r) => r.rows[0]?.s as string ?? null).catch(() => null) : Promise.resolve(null);

  /** A quotation in the app's shape (§4.4 item 11). */
  async function quoteOut(c: PoolClient, p: Principal, id: string, withPages = false) {
    const d = (await c.query(`select ${DOC_COLS},d.delivery_owner "deliveryOwner",d.external_ref "externalRef",d.sx_lead_id "sxLeadId",d.created_by "createdBy",
        to_jsonb(d)->>'superseded_by' "supersededBy",d.approval_to "approvalTo",d.issued_by "issuedBy",d.issued_at "issuedAt",d.updated_at "updatedAt",
        (select octet_length(f.bytes) from pulse.erp_document_file f where f.document_id=d.id and f.kind='pdf') "pdfBytes",
        (select f.sha256 from pulse.erp_document_file f where f.document_id=d.id and f.kind='pdf') "pdfSha",
        (now() at time zone pulse.org_time_zone())::date::text today
      from pulse.erp_document d where d.id=$1 and d.doc_type='quotation'`, [id])).rows[0];
    if (!d) return no(404, 'quote_not_found', 'No such quotation here');
    let pages: number | null = null;
    if (withPages && d.pdfBytes) pages = await quotationPdf(c, id).then((x) => pdfPageCount(x.bytes)).catch(() => null);
    const tax = Number(d.cgst ?? 0) + Number(d.sgst ?? 0) + Number(d.igst ?? 0);
    return { id: d.id, number: d.number ?? null, version: Number(d.revision ?? 0) + 1, status: quoteStatus(d, d.today), latest_id: d.supersededBy ?? null,
      approval: d.status === 'draft' ? { state: d.approvalTo ? 'pending' : 'none', by_sub: null, at: null } : { state: 'approved', by_sub: await subOf(c, p, d.issuedBy), at: d.issuedAt ?? null },
      lead_ref: d.sxLeadId ? `sx:lead:${d.sxLeadId}` : null, client_id: d.clientId ?? null, external_ref: d.externalRef ?? null, created_by_sub: await subOf(c, p, d.createdBy),
      buyer: { name: d.buyer?.name ?? '' },
      totals: { subtotal_minor: Number(d.taxable ?? 0), tax_minor: tax, estimate_minor: Number(d.estimate ?? 0), total_minor: Number(d.total ?? 0), currency: 'INR',
        gst: String(d.seller?.gstin ?? '').trim() ? 'registered' : 'unregistered' },
      valid_until: d.validUntil ?? null, pdf: { ready: !!d.pdfBytes, sha256: d.pdfSha ?? null, bytes: d.pdfBytes ? Number(d.pdfBytes) : null, ...(withPages ? { pages } : {}) },
      delivery_owner: d.deliveryOwner, updated_at: d.updatedAt };
  }

  // ----- catalogue --------------------------------------------------------------------------------------------------
  app.get<{ Params: { org_id: string }; Querystring: Record<string, string> }>(`${base}/catalogue/items`, { schema: { params: PARAMS } }, (req, reply) =>
    sx(req, reply, 'catalogue.list', 'pulse.catalogue.read', false, async (c) => {
      const q = String(req.query.q ?? '').trim().slice(0, 100), after = String(req.query.cursor ?? '');
      if (after && !UUID.test(after)) no(422, 'validation', 'cursor is not one Pulse gave', { field: 'cursor' });
      const rows = (await c.query('select pulse.connect_catalogue($1,$2) v', [q, after || null])).rows[0].v as Row[];
      const items = rows.slice(0, 100).map((i) => ({ id: i.id, name: i.name, unit: i.unit ?? null, unit_price_minor: i.price === null ? null : Math.round(Number(i.price)),
        currency: 'INR', tax: { gst_rate: Number(i.gst ?? 0), hsn_sac: i.sac ?? null }, active: true })) as Row[];
      return { items, next_cursor: rows.length > 100 ? items[99].id : null };
    }));

  // ----- contacts: the lead as Pulse knows it (Sales X-Ray pushes leads already: PUT leads/{id}) ---------------------
  app.put<{ Params: { org_id: string; ref: string }; Body: Row }>(`${base}/contacts/by-ref/:ref`, (req, reply) =>
    sx(req, reply, 'contacts.put', 'pulse.contacts.write', true, async (c, p) => {
      await acting(c, p, req);
      const m = LEAD_REF.exec(req.params.ref) ?? no(422, 'validation', 'external_ref is sx:lead:<uuid>', { field: 'external_ref' });
      const lead = (await c.query(`select sx_lead_id id,name,phone,email,company,city,updated_at from pulse.sales_xray_lead where sx_lead_id=$1`, [m[1]])).rows[0];
      if (!lead) return no(404, 'contact_not_found', 'Push the lead first (PUT leads/{lead_id}); then it is a contact here');
      return { id: `sx:lead:${lead.id}`, external_ref: req.params.ref, name: lead.name, phone_e164: lead.phone ?? null, email: lead.email ?? null, updated_at: lead.updated_at };
    }));

  // ----- quotes -----------------------------------------------------------------------------------------------------
  app.get<{ Params: { org_id: string }; Querystring: Record<string, string> }>(`${base}/quotes`, { schema: { params: PARAMS } }, (req, reply) =>
    sx(req, reply, 'quotes.list', 'pulse.quotes.read', false, async (c, p) => {
      await acting(c, p, req, false);
      const lead = req.query.lead_ref ? (LEAD_REF.exec(req.query.lead_ref) ?? no(422, 'validation', 'lead_ref is sx:lead:<uuid>', { field: 'lead_ref' }))[1] : null;
      const ext = req.query.external_ref ? (REF.test(req.query.external_ref) ? req.query.external_ref : no(422, 'validation', 'external_ref is letters, digits and : . _ -', { field: 'external_ref' })) : null;
      const after = String(req.query.cursor ?? '');
      if (after && !UUID.test(after)) no(422, 'validation', 'cursor is not one Pulse gave', { field: 'cursor' });
      const ids = (await c.query(`select d.id from pulse.erp_document d where d.doc_type='quotation' and ($1::uuid is null or d.sx_lead_id=$1) and ($2::text is null or d.external_ref=$2)
        and ($3='' or d.id>$3::uuid) order by d.id limit 51`, [lead, ext, after])).rows.map((r) => r.id as string);
      const items = [];
      for (const id of ids.slice(0, 50)) items.push(await quoteOut(c, p, id));
      const status = req.query.status;
      return { items: status ? items.filter((q) => q.status === status) : items, next_cursor: ids.length > 50 ? ids[49] : null };
    }));
  app.get<{ Params: { org_id: string; id: string } }>(`${base}/quotes/:id`, { schema: { params: PARAMS } }, (req, reply) =>
    sx(req, reply, 'quotes.get', 'pulse.quotes.read', false, async (c, p) => { await acting(c, p, req, false); return quoteOut(c, p, req.params.id, true); }));

  const LINES_MAX = 100;
  app.post<{ Params: { org_id: string }; Body: Row }>(`${base}/quotes`, { schema: { params: PARAMS } }, (req, reply) =>
    sx(req, reply, 'quotes.create', 'pulse.quotes.write', true, async (c, p) => {
      const me = await acting(c, p, req);
      const once = await idem(c, p, req, 'quotes.create');
      if (once.seen) return reply.code(once.seen.status).send(once.seen.answer);
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const leadRef = String(b.lead_ref ?? b.contact_id ?? '');
      const lead = (LEAD_REF.exec(leadRef) ?? no(422, 'validation', 'lead_ref is sx:lead:<uuid> (push the lead first)', { field: 'lead_ref' }))[1];
      if (!(await c.query('select 1 from pulse.sales_xray_lead where sx_lead_id=$1', [lead])).rowCount) no(404, 'contact_not_found', 'Push the lead first (PUT leads/{lead_id})');
      const ext = b.external_ref === undefined || b.external_ref === null ? null : REF.test(String(b.external_ref)) ? String(b.external_ref) : no(422, 'validation', 'external_ref is letters, digits and : . _ -', { field: 'external_ref' });
      const items = Array.isArray(b.lines) ? b.lines : [], custom = Array.isArray(b.custom_lines) ? b.custom_lines : [];
      if (!items.length && !custom.length) no(422, 'validation', 'Add at least one line', { field: 'lines' });
      if (items.length + custom.length > LINES_MAX) no(422, 'validation', `At most ${LINES_MAX} lines`, { field: 'lines' });
      const lines: Row[] = [];
      for (const [i, raw] of items.entries()) {
        const l = (raw ?? {}) as Row, at = `lines[${i}]`;
        const itemId = typeof l.item_id === 'string' && UUID.test(l.item_id) ? l.item_id : no(422, 'validation', 'item_id is a catalogue item id', { field: `${at}.item_id` });
        const it = (await c.query("select id,name,description,sac,unit,price::float8 price,gst_rate::float8 gst from pulse.erp_item where id=$1 and status='active'", [itemId])).rows[0]
          ?? no(404, 'item_not_found', 'No active catalogue item with that id', { field: `${at}.item_id` });
        const qty = Number(l.qty ?? 1);
        if (!(qty > 0 && qty <= 1e6)) no(422, 'validation', 'qty is more than 0', { field: `${at}.qty` });
        const rate = l.unit_price_minor === undefined || l.unit_price_minor === null ? it.price : Number(l.unit_price_minor);
        if (!(Number.isInteger(rate) && rate >= 0)) no(422, 'validation', 'unit_price_minor is whole paise', { field: `${at}.unit_price_minor` });
        const pct = l.discount_pct === undefined || l.discount_pct === null ? null : Number(l.discount_pct);
        if (pct !== null && !(pct >= 0 && pct <= 100)) no(422, 'validation', 'discount_pct is 0 to 100', { field: `${at}.discount_pct` });
        lines.push({ itemId: it.id, description: it.name, details: it.description ?? '', sac: it.sac, unit: it.unit ?? 'nos', qty, rate, discount: 0, discountPercent: pct, gstRate: Number(it.gst ?? 18) });
      }
      for (const [i, raw] of custom.entries()) {
        const l = (raw ?? {}) as Row, at = `custom_lines[${i}]`;
        const label = typeof l.label === 'string' && l.label.trim() ? l.label.trim().slice(0, 300) : no(422, 'validation', 'label is the line\'s words', { field: `${at}.label` });
        const amount = Number(l.amount_minor);
        if (!(Number.isInteger(amount) && amount >= 0)) no(422, 'validation', 'amount_minor is whole paise', { field: `${at}.amount_minor` });
        const gst = l.gst_rate === undefined ? 18 : Number(l.gst_rate);
        lines.push({ itemId: null, description: label, details: '', sac: null, unit: 'nos', qty: 1, rate: amount, discount: 0, discountPercent: null, gstRate: gst });
      }
      const created = await createDraft(c, me.viewer, { docType: 'quotation', sxLeadId: lead });
      const doc = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [created.id])).rows[0];
      const days = b.valid_days === undefined ? null : Number(b.valid_days);
      if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 365)) no(422, 'validation', 'valid_days is 1 to 365', { field: 'valid_days' });
      const validUntil = days ? new Date(Date.parse(`${doc.issueDate}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10) : doc.validUntil;
      await saveDraft(c, me.viewer, created.id, { ...doc, validUntil, notes: typeof b.note === 'string' ? b.note.slice(0, 2000) : doc.notes ?? '', lines });
      const owner = b.delivery_owner === 'sales_xray' ? 'sales_xray' : 'pulse';
      await c.query('update pulse.erp_document set external_ref=$2,delivery_owner=$3 where id=$1', [created.id, ext, owner]);
      // The company's own rule: no approval step → numbered now; else it waits for one of Billing's approvers.
      const rule = (await c.query('select quote_approval from pulse.erp_settings')).rows[0]?.quote_approval === true;
      if (!rule) await issueDocument(c, me.viewer, created.id);
      else {
        const approver = (await c.query('select id from pulse.erp_approvers() where id<>$1 limit 1', [me.person])).rows[0]?.id;
        if (approver) await c.query('select pulse.erp_approval_ask($1,$2,$3)', [created.id, approver, 'Made from Sales X-Ray']);
      }
      await c.query('select pulse.erp_log($1,$2,$3,$4)', ['document', created.id, 'made_by_app', { app: p.appName, externalRef: ext }]);
      const answer = await quoteOut(c, p, created.id);
      await once.keep(201, answer);
      return reply.code(201).send(answer);
    }));

  app.get<{ Params: { org_id: string; id: string } }>(`${base}/quotes/:id/pdf`, { schema: { params: PARAMS } }, (req, reply) =>
    sx(req, reply, 'quotes.pdf', 'pulse.quotes.read', false, async (c, p) => {
      await acting(c, p, req, false);
      if (!(await c.query("select 1 from pulse.erp_document where id=$1 and doc_type='quotation'", [req.params.id])).rowCount) no(404, 'quote_not_found', 'No such quotation here');
      const pdf = await quotationPdf(c, req.params.id);
      const etag = `"${createHash('sha256').update(pdf.bytes).digest('hex')}"`;
      reply.header('etag', etag).header('content-disposition', `inline; filename="${pdf.fileName}"`);
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.type('application/pdf').send(Buffer.from(pdf.bytes));
    }));

  app.put<{ Params: { org_id: string; id: string }; Body: Row }>(`${base}/quotes/:id/delivery-owner`, { schema: { params: PARAMS } }, (req, reply) =>
    sx(req, reply, 'quotes.owner', 'pulse.quotes.write', true, async (c, p) => {
      await acting(c, p, req);
      const owner = ['pulse', 'sales_xray'].includes(String(req.body?.owner)) ? String(req.body?.owner) : no(422, 'validation', 'owner is pulse or sales_xray', { field: 'owner' });
      const r = await c.query("update pulse.erp_document set delivery_owner=$2 where id=$1 and doc_type='quotation' returning id", [req.params.id, owner]);
      if (!r.rowCount) no(404, 'quote_not_found', 'No such quotation here');
      await c.query('select pulse.erp_log($1,$2,$3,$4)', ['document', req.params.id, 'delivery_owner', { owner, app: p.appName }]);
      return quoteOut(c, p, req.params.id);
    }));

  app.post<{ Params: { org_id: string; id: string }; Body: Row }>(`${base}/quotes/:id/deliveries`, { schema: { params: PARAMS } }, (req, reply) =>
    sx(req, reply, 'quotes.delivery', 'pulse.quotes.write', true, async (c, p) => {
      const me = await acting(c, p, req);
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const touch = typeof b.sx_touch_id === 'string' && REF.test(b.sx_touch_id) ? b.sx_touch_id : no(422, 'validation', 'sx_touch_id is the send\'s own id', { field: 'sx_touch_id' });
      const channel = CHANNELS.includes(String(b.channel)) ? String(b.channel) : no(422, 'validation', `channel is one of ${CHANNELS.join(', ')}`, { field: 'channel' });
      const at = typeof b.sent_at === 'string' && Number.isFinite(Date.parse(b.sent_at)) ? new Date(b.sent_at).toISOString() : no(422, 'validation', 'sent_at is an ISO time', { field: 'sent_at' });
      const seen = (await c.query('select id from pulse.erp_delivery where external_ref=$1', [touch])).rows[0];
      if (seen) return reply.code(200).send({ id: seen.id, repeated: true });
      const d = (await c.query("select id,status,delivery_owner from pulse.erp_document where id=$1 and doc_type='quotation'", [req.params.id])).rows[0] ?? no(404, 'quote_not_found', 'No such quotation here');
      if (d.status === 'draft') no(409, 'approval_required', 'This quotation is not approved yet');
      if (d.delivery_owner !== 'sales_xray') await c.query("update pulse.erp_document set delivery_owner='sales_xray' where id=$1", [d.id]);
      const host = typeof b.link_host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(b.link_host) ? b.link_host.toLowerCase() : null;
      const id = (await c.query('insert into pulse.erp_delivery(org_id,document_id,channel,sent_at,by_person,app,external_ref,link_host) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7) returning id',
        [d.id, channel, at, me.person, p.appName.slice(0, 80), touch, host])).rows[0].id;
      if (d.status === 'issued') await c.query("select pulse.erp_document_mark($1,'sent',$2)", [d.id, `Sent from ${p.appName} (${channel})`.slice(0, 500)]);
      await c.query('select pulse.erp_log($1,$2,$3,$4)', ['document', d.id, 'delivered_by_app', { app: p.appName, channel, at, touch, revision: null }]);
      return reply.code(201).send({ id, repeated: false });
    }));
}
