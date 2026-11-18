// CONTRACTS-2 (owner, 8 Nov 2026; the 7 Nov meeting): agreements people really sign (migration 1850).
//   * Templates (one standard for everyone, variants for one client) with blanks filled from a quotation or invoice;
//     a Word file is read here (mammoth), a PDF is read in the browser (pdf.js) and arrives as text.
//   * Make an agreement from a document; change its words (after sending, a change is a new draft); send it to sign.
//   * The client's link (signed out, /accept/sign/<token>): read, comment, ask for a change, sign by typing or drawing,
//     or say no. Only a hash of the token is kept; it expires.
//   * The signed PDF with its audit page, inside Vitals OS and through the link.
//   * Contracts signed per month: the company's, and the platform's for platform admins.
// Who may do what is decided in the database (contract_manager, contract_seller, contract_runner under forced row
// security); this file shapes input, keeps the database's own plain sentences for the person, and draws the PDF.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import { AGREEMENT_BLANKS, buildContractModel, emptyFields, fieldLabel, FONT_URLS, readSource, renderContractPdf, STARTER_AGREEMENT } from '@pulse/invoice-doc';
import { fail, type Open, type Tx } from './routes.js';
import { companyLinkOrigin } from './tenant-context.js';
import { orgZone } from './org-time.js';
import { sharedAddress } from './shared-address.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = ['employment', 'retainer', 'services', 'revenue_share', 'equity'] as const;
const uuidOr404 = (x: unknown, what: string) => (UUID.test(String(x)) ? String(x) : fail(404, `${what} not found`));
const text = (v: unknown, max: number) => (v === null || v === undefined ? undefined : String(v).replace(/\r\n?/g, '\n').slice(0, max));
let fontsLoading: Promise<{ regular: Buffer; semibold: Buffer }> | null = null;
const fonts = () => (fontsLoading ??= Promise.all([readFile(FONT_URLS.regular), readFile(FONT_URLS.semibold)]).then(([regular, semibold]) => ({ regular, semibold })));

/** The database's own sentence for the person ("Tick "I agree" to sign"), not the generic text app.ts would show. Only
 *  errors our plpgsql functions raised (RAISE … USING errcode) pass through; anything else keeps the generic answer. */
export async function said<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const x = e as { code?: string; message?: string; where?: string };
    const status = x.code === '42501' ? 403 : x.code === '22023' ? 400 : x.code === 'P0002' ? 404 : 0;
    if (status && x.message && /PL\/pgSQL/.test(String(x.where ?? '')) && x.message.length <= 200) fail(status, x.message);
    throw e;
  }
}

/** A day and time as the sender's company writes it: "8 Nov 2026, 3:05 pm". */
export function stamp(iso: unknown, timeZone: string) {
  if (!iso) return '';
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone });
}

/** The words of the log, the same on the screen and on the PDF's audit page. */
export const EVENT_WORDS: Record<string, string> = {
  made: 'Agreement made', prepared: 'Agreement made by itself', sent: 'Sent to sign', opened: 'Opened the link', viewed: 'Looked at it again',
  signed: 'Signed', declined: 'Said no', commented: 'Comment', change_asked: 'Asked for a change', new_draft: 'New draft made', link_stopped: 'Link stopped',
  resolved: 'Change done', draft_proposed: 'New draft proposed',
};
const VIA_WORDS: Record<string, string> = { app: 'in Vitals OS', link: 'through the signing link', auto: 'by Vitals OS' };

/** A template's input: name, words, kind, for whom, default. */
export function templateInput(b: Row, creating: boolean): Row {
  const out: Row = {};
  const name = text(b.name, 120)?.trim();
  if (name !== undefined) out.name = name || fail(400, 'Give the template a name');
  else if (creating) fail(400, 'Give the template a name');
  const body = text(b.body, 100000);
  if (body !== undefined) out.body = body.trim() ? body : fail(400, 'Write or paste the agreement');
  else if (creating) fail(400, 'Write or paste the agreement');
  if (b.kind !== undefined) out.kind = KINDS.includes(b.kind as (typeof KINDS)[number]) ? b.kind : fail(400, 'Choose what kind of agreement it is');
  if (b.clientId !== undefined) out.clientId = b.clientId === null || b.clientId === '' ? null : UUID.test(String(b.clientId)) ? b.clientId : fail(400, 'Choose the client from the list');
  if (b.isDefault !== undefined) out.isDefault = b.isDefault === true;
  if (b.source !== undefined) out.source = ['typed', 'pasted', 'docx', 'pdf', 'starter'].includes(String(b.source)) ? b.source : 'typed';
  return out;
}

/** A company's name without its legal form, for telling two spellings of one company apart. */
export const sameCompany = (s: string) => String(s ?? '').toLowerCase().replace(/\b(private|pvt|limited|ltd|llp|inc|the)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
/**
 * POLISH-1115: our company named on both sides (a signing row for us and a "client" row or party with our name). Returns
 * the name to show, or null. Our names: the company's name and its legal name.
 */
export function ourselvesTwice(ours: string[], rows: { name: string; ours: boolean }[], facts: { name?: string }[]): string | null {
  const names = new Set(ours.map(sameCompany).filter((n) => n.length >= 3));
  if (!names.size) return null;
  const isUs = (n: string) => names.has(sameCompany(n));
  const rowUs = rows.filter((r) => r.ours || isUs(r.name));
  if (rowUs.length >= 2) return rowUs.find((r) => !r.ours)?.name ?? rowUs[0].name;
  const factUs = facts.filter((p) => p.name && isUs(p.name));
  if (factUs.length >= 2) return factUs[1].name ?? null;
  return null;
}

/** A drawn signature: a PNG data URL from the signing pad, small enough to keep. */
export function signatureInput(b: Row) {
  // CONTRACTS-PRO: 'uploaded' is a photo of a signature on paper, cleaned in the browser and kept as a small PNG.
  const kind = b.kind === 'drawn' ? 'drawn' : b.kind === 'uploaded' ? 'uploaded' : 'typed';
  const image = kind !== 'typed' ? String(b.image ?? '') : null;
  if (image !== null && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) fail(400, kind === 'uploaded' ? 'Upload the photo of your signature again' : 'Draw your signature again');
  if (image !== null && image.length > 200000) fail(400, 'That drawing is too big. Clear it and draw again');
  return { name: String(b.name ?? '').trim().slice(0, 160), kind, image, agree: b.agree === true };
}

const hashOf = (token: string) => (/^[A-Za-z0-9_-]{43}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null);
const pngOf = (dataUrl: unknown) => (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,') ? Buffer.from(dataUrl.slice(22), 'base64') : null);

/** The company's letterhead for its contracts: Billing's template design and logo, its legal name and address. */
export type Letterhead = { design: Row; company: { name: string; lines: string[] }; logo: { bytes: Uint8Array; mime: string } | null };
export async function letterheadOf(c: PoolClient): Promise<Letterhead> {
  const h = (await c.query('select pulse.contract_letterhead() h')).rows[0]?.h as Row | null;
  const co = (h?.company ?? {}) as Row;
  const lines = [...(Array.isArray(co.lines) ? (co.lines as unknown[]).map(String) : []), co.gstin ? `GSTIN ${String(co.gstin)}` : ''].filter(Boolean).slice(0, 4);
  let logo: Letterhead['logo'] = null;
  if (h?.logo) {
    const r = (await c.query('select bytes, mime from pulse.contract_letterhead_logo()')).rows[0];
    if (r?.bytes) logo = { bytes: new Uint8Array(r.bytes as Buffer), mime: String(r.mime) };
  }
  return { design: (h?.design ?? {}) as Row, company: { name: String(co.name ?? ''), lines }, logo };
}
/** "Chrome on Android" from a browser's user agent (the record keeps the full one). */
export function deviceOf(agent: string) {
  const b = /Edg\//.test(agent) ? 'Edge' : /OPR\//.test(agent) ? 'Opera' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'A browser';
  const o = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iPhone' : /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : '';
  return o ? `${b} on ${o}` : b;
}

/** The agreement as a PDF (CONTRACTS-PRO): the typeset document with the letterhead, the signatures and the certificate page. */
export async function agreementPdf(r: Row, timeZone: string, head?: Letterhead | null) {
  const events = ((r.audit as Row[]) ?? []);
  const parties = ((r.parties as Row[]) ?? []).map((p) => {
    const by = (p.signedBy ?? null) as string | null;
    const ev = by ? events.filter((e) => e.kind === 'signed' && String(e.by ?? '') === by).pop() : undefined;
    return { key: String(p.key ?? ''), name: String(p.name), role: String(p.role ?? ''), signer: (by ?? p.signer ?? null) as string | null,
      signedAt: p.signedAt ? stamp(p.signedAt, timeZone) : null, signKind: (p.kind ?? null) as string | null, image: pngOf(p.image),
      network: ev?.ip ? `${String(ev.ip)}…` : null, device: ev?.agent ? deviceOf(String(ev.agent)) : null, declinedAt: p.declinedAt ? stamp(p.declinedAt, timeZone) : null };
  });
  const audit = events.map((e) => ({ at: stamp(e.at, timeZone), what: EVENT_WORDS[String(e.kind)] ?? String(e.kind),
    who: e.by ? String(e.by) : null, via: VIA_WORDS[String(e.via)] ?? null,
    detail: [e.body ? String(e.body) : null, e.version ? `draft ${e.version}` : null, e.ip ? `network ${e.ip}…` : null, e.agent ? deviceOf(String(e.agent)) : null].filter(Boolean).join(' · ') }));
  const body = String(r.body ?? '');
  const model = buildContractModel(head?.design ?? {}, { title: String(r.title ?? 'Agreement'), body, status: String(r.status ?? ''), version: Number(r.version ?? 1),
    reference: `Ref ${String(r.key ?? '').slice(0, 8).toUpperCase()}`, company: head?.company?.name ? head.company : { name: String(r.from ?? ''), lines: [] },
    parties, audit, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), printed: stamp(new Date().toISOString(), timeZone) }, { logo: head?.logo ?? null });
  return renderContractPdf(model, { fonts: await fonts() });
}

/** The same shape as the link's pulse.contract_sign_read, for one agreement held here (inside Vitals OS). */
async function readHere(c: PoolClient, id: string) {
  const r = (await c.query(`select c.id, c.contract_key "key", c.title, c.body, c.version, c.status, c.signed_at "signedAt", (select name from pulse.org where id=pulse.current_org()) "from",
      (select coalesce(jsonb_agg(jsonb_build_object('key',p.party_key,'name',p.name,'role',p.role,'signer',p.signer_name,
        'signedAt',case when p.accepted_version=c.version then p.accepted_at end,'signedBy',case when p.accepted_version=c.version then p.accepted_by_name end,
        'kind',case when p.accepted_version=c.version then p.sign_kind end,'image',case when p.accepted_version=c.version then p.sign_image end,'declinedAt',p.declined_at) order by p.position),'[]')
        from pulse.contract_party p where p.contract_id=c.id) parties,
      (select coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'at',e.at,'by',e.actor_name,'via',e.via,'version',e.version,'ip',left(e.ip_hash,12),'agent',e.agent,
        'body',case when e.kind in ('signed','declined','sent','made','prepared','new_draft') then e.body end) order by e.at),'[]')
        from pulse.contract_event e where e.contract_id=c.id and e.kind<>'viewed') audit
    from pulse.contract c where c.id=$1`, [id])).rows[0];
  return r ?? fail(404, 'Agreement not found');
}

const zoneOf = (c: PoolClient) => orgZone(c);

/** What the screens show about one agreement beyond 1583's contract: the log, the links, open change requests. */
export async function agreementExtras(c: PoolClient, id: string) {
  const events = (await c.query(`select id, kind, party_key "party", version, clause, body, actor_name "by", via, at, resolved_at "resolvedAt"
    from pulse.contract_event where contract_id=$1 order by at desc limit 300`, [id])).rows;
  const links = (await c.query(`select party_key "party", created_at "createdAt", expires_at "expiresAt", revoked_at "revokedAt", opened_at "openedAt", seen_at "seenAt", answered_at "answeredAt"
    from pulse.contract_sign_link where contract_id=$1 order by created_at desc`, [id])).rows;
  // CONTRACTS-3: the document's money too (total, due date, where it is), for "who pays whom".
  const side = (await c.query(`select s.source_document_id "documentId", d.number "documentNumber", d.doc_type "documentType", d.total::float8 "total",
      to_char(d.due_date,'YYYY-MM-DD') "dueDate", d.status "documentStatus" from pulse.contract_side s
    left join pulse.erp_document d on d.id=s.source_document_id where s.contract_id=$1`, [id])).rows[0] ?? null;
  const run = (await c.query('select pulse.contract_runner($1) r', [id])).rows[0]?.r === true;
  return { events, links, source: side, canRun: run };
}

export function registerAgreementRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  // ------------------------------------------------------------------ templates and settings
  app.get('/api/v0/contracts/templates', (req) => tx(req, async (c) => {
    const who = (await c.query('select pulse.contract_manager() m, pulse.contract_seller() s')).rows[0];
    if (!who.m && !who.s) fail(403, 'Admins, leadership, Finance and Sales see agreement templates');
    const templates = (await c.query(`select t.id, t.name, t.body, t.kind, t.client_id "clientId", cl.display_name "client", t.is_default "isDefault", t.source, t.updated_at "updatedAt"
      from pulse.contract_template t left join pulse.client cl on cl.id=t.client_id where t.archived_at is null order by t.is_default desc, t.client_id nulls first, t.name`)).rows;
    const settings = (await c.query('select after, trigger_on "triggerOn", link_days "linkDays", steps, send_by_itself "sendByItself" from pulse.contract_settings')).rows[0]
      ?? { after: 'off', triggerOn: 'quote_accepted', linkDays: 14, steps: [], sendByItself: false };
    // Which clauses clients ask to change most (the business learns where the pushback is).
    const pushback = who.m ? (await c.query(`select coalesce(clause,'The whole agreement') clause, count(*)::int n, max(at) "lastAt" from pulse.contract_event
      where kind='change_asked' group by 1 order by 2 desc, 3 desc limit 10`)).rows : [];
    const clients = who.m ? (await c.query(`select id, display_name "name" from pulse.client where status is distinct from 'churned' order by display_name limit 500`)).rows : [];
    return { templates, settings, pushback, clients, blanks: AGREEMENT_BLANKS, starter: STARTER_AGREEMENT, canEdit: who.m === true };
  }));
  app.post<{ Body: Row }>('/api/v0/contracts/templates', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const t = templateInput(req.body ?? {}, true);
    if (!(await c.query('select pulse.contract_manager() m')).rows[0].m) fail(403, 'Admins, leadership and Finance change agreement templates');
    if (t.isDefault) await c.query('update pulse.contract_template set is_default=false where is_default and archived_at is null');
    const hasDefault = (await c.query('select 1 from pulse.contract_template where is_default and archived_at is null')).rowCount;
    const id = (await c.query(`insert into pulse.contract_template(org_id,name,body,kind,client_id,is_default,source,created_by)
      values(pulse.current_org(),$1,$2,coalesce($3,'services'),$4,$5,coalesce($6,'typed'),pulse.current_viewer()) returning id`,
      [t.name, t.body, t.kind ?? null, t.clientId ?? null, t.isDefault === true || (!hasDefault && !t.clientId), t.source ?? null])).rows[0].id;
    return { id };
  })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/templates/:id', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const id = uuidOr404(req.params.id, 'Template');
    if (!(await c.query('select pulse.contract_manager() m')).rows[0].m) fail(403, 'Admins, leadership and Finance change agreement templates');
    if (req.body?.archive === true) {
      const r = await c.query('update pulse.contract_template set archived_at=now(), is_default=false where id=$1 and archived_at is null', [id]);
      return r.rowCount ? { ok: true } : fail(404, 'Template not found');
    }
    const t = templateInput(req.body ?? {}, false);
    if (t.isDefault) await c.query('update pulse.contract_template set is_default=false where is_default and archived_at is null and id<>$1', [id]);
    const r = await c.query(`update pulse.contract_template set name=coalesce($2,name), body=coalesce($3,body), kind=coalesce($4,kind),
        client_id=case when $5::boolean then $6::uuid else client_id end, is_default=coalesce($7,is_default), source=coalesce($8,source), updated_at=now()
      where id=$1 and archived_at is null`, [id, t.name ?? null, t.body ?? null, t.kind ?? null, t.clientId !== undefined, t.clientId ?? null, t.isDefault ?? null, t.source ?? null]);
    return r.rowCount ? { ok: true } : fail(404, 'Template not found');
  })));
  // A Word file becomes plain text with its headings kept as "1. Heading" lines (nothing is saved here).
  app.post<{ Body: Row }>('/api/v0/contracts/templates-import', { schema: { body: { type: 'object' } }, bodyLimit: 12 * 1024 * 1024 }, (req) => tx(req, async (c) => {
    if (!(await c.query('select pulse.contract_manager() m')).rows[0].m) fail(403, 'Admins, leadership and Finance import agreement templates');
    const data = Buffer.from(String(req.body?.file ?? ''), 'base64');
    if (data.length < 100) fail(400, 'Choose a Word file (.docx)');
    if (data.length > 8 * 1024 * 1024) fail(400, 'The Word file is up to 8 MB');
    if (data.subarray(0, 2).toString('latin1') !== 'PK') fail(400, 'That is not a Word file. Save it as .docx and try again');
    let html = '';
    try { html = (await mammoth.convertToHtml({ buffer: data })).value; } catch { return fail(400, 'That Word file could not be read. Save it again as .docx and try again'); }
    return { text: docxHtmlToText(html) };
  }));
  app.post<{ Body: Row }>('/api/v0/contracts/settings', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => {
    if (!(await c.query('select pulse.contract_manager() m')).rows[0].m) fail(403, 'Admins, leadership and Finance change this');
    const b = req.body ?? {};
    // CONTRACTS-3: sending by e-mail by itself is built and off. It writes to real clients, so it waits on Kazuk's yes
    // (CONTRACTS-2 §6); the database refuses it too (2030's contract_settings_send_waits).
    if (b.sendByItself === true) fail(400, 'Sending by itself is not switched on yet: it e-mails real clients, so it waits for approval. Send the link from your phone for now');
    const after = b.after === undefined ? null : ['off', 'prepare'].includes(String(b.after)) ? String(b.after) : fail(400, 'Choose what happens next');
    const on = b.triggerOn === undefined ? null : ['quote_accepted', 'invoice_issued'].includes(String(b.triggerOn)) ? String(b.triggerOn) : fail(400, 'Choose when it happens');
    const days = b.linkDays === undefined ? null : Number.isInteger(Number(b.linkDays)) && Number(b.linkDays) >= 1 && Number(b.linkDays) <= 90 ? Number(b.linkDays) : fail(400, 'A link works for 1 to 90 days');
    const steps = b.steps === undefined ? null : Array.isArray(b.steps) && b.steps.length <= 20 ? JSON.stringify((b.steps as Row[]).map((s) => ({
      key: String(s?.key ?? '').slice(0, 40), label: String(s?.label ?? '').slice(0, 120), who: String(s?.who ?? '').slice(0, 40), after: String(s?.after ?? '').slice(0, 40) }))) : fail(400, 'Up to 20 steps');
    await c.query(`insert into pulse.contract_settings(org_id,after,trigger_on,link_days,steps,updated_by) values(pulse.current_org(),coalesce($1,'off'),coalesce($2,'quote_accepted'),coalesce($3,14),coalesce($4::jsonb,'[]'),pulse.current_viewer())
      on conflict (org_id) do update set after=coalesce($1,pulse.contract_settings.after), trigger_on=coalesce($2,pulse.contract_settings.trigger_on),
        link_days=coalesce($3,pulse.contract_settings.link_days), steps=coalesce($4::jsonb,pulse.contract_settings.steps), updated_by=pulse.current_viewer(), updated_at=now()`,
      [after, on, days, steps]);
    return { ok: true };
  }));

  // ------------------------------------------------------------------ making one from a document
  app.get('/api/v0/contracts/documents', (req) => tx(req, async (c) => {
    const who = (await c.query('select pulse.contract_manager() m, pulse.contract_seller() s')).rows[0];
    if (!who.m && !who.s) fail(403, 'Admins, leadership, Finance and Sales make agreements');
    const docs = (await c.query(`select d.id, d.number, d.doc_type "docType", d.status, d.issue_date "date", d.due_date::text "dueDate", d.total, d.buyer->>'name' "client", coalesce(p.title,p.name) "project",
        (select s.contract_id from pulse.contract_side s where s.source_document_id=d.id limit 1) "agreementId"
      from pulse.erp_document d left join pulse.project p on p.id=d.project_id
      where d.doc_type in ('quotation','proforma','invoice') and d.status not in ('draft','cancelled','declined')
        and ($1 or d.salesperson_id=pulse.current_viewer() or pulse.viewer_is('sales_head'))
      order by (d.status='accepted') desc, d.issue_date desc, d.created_at desc limit 40`, [who.m === true])).rows;
    return { documents: docs };
  }));
  app.get<{ Querystring: Record<string, string> }>('/api/v0/contracts/fill', (req) => tx(req, async (c) => said(async () => {
    const doc = uuidOr404(req.query.documentId, 'Document');
    const v = (await c.query('select pulse.contract_preview_values($1) v', [doc])).rows[0]?.v;
    return v ? { values: v } : fail(404, 'Document not found');
  })));
  app.post<{ Body: Row }>('/api/v0/contracts/from-document', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const doc = UUID.test(String(req.body?.documentId)) ? String(req.body?.documentId) : fail(400, 'Choose the quotation or invoice');
    const tpl = req.body?.templateId ? (UUID.test(String(req.body.templateId)) ? String(req.body.templateId) : fail(400, 'Choose a template from the list')) : null;
    return { id: (await c.query('select pulse.contract_from_document($1,$2) id', [doc, tpl])).rows[0].id as string };
  })));

  // ------------------------------------------------------------------ one agreement
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/words', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const id = uuidOr404(req.params.id, 'Agreement');
    const body = text(req.body?.body, 100000) ?? null;
    const title = text(req.body?.title, 160) ?? null;
    if (body === null && title === null) fail(400, 'Nothing to save');
    return { version: (await c.query('select pulse.contract_words_save($1,$2,$3) v', [id, title, body])).rows[0].v as number };
  })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/send-to-sign', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const id = uuidOr404(req.params.id, 'Agreement');
    const b = req.body ?? {};
    const party = b.partyKey ? (UUID.test(String(b.partyKey)) ? String(b.partyKey) : fail(400, 'Choose who signs')) : null;
    const days = b.days === undefined || b.days === null ? null : Number.isInteger(Number(b.days)) ? Number(b.days) : fail(400, 'A link works for 1 to 90 days');
    const email = b.email === undefined ? null : String(b.email ?? '').trim().slice(0, 254);
    if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) fail(400, 'Check the e-mail address');
    // CONTRACTS-PRO: nobody signs a gap: the document's own fields ({{deal.fee}}, {{client.name}}) are filled first too.
    const words = String((await c.query('select body from pulse.contract where id = $1', [id])).rows[0]?.body ?? '');
    const gaps = emptyFields(words);
    if (gaps.length) fail(400, `Fill these first: ${gaps.map((k) => fieldLabel(k, readSource(words).meta)).join(', ')}. Use Edit, then send`);
    // POLISH-1115 (owner, 14 Nov: "an org listed as its own counterparty"): our company is on one side only.
    const us = (await c.query(`select o.name, s.company->>'legalName' legal from pulse.org o left join pulse.erp_settings s on s.org_id = o.id where o.id = pulse.current_org()`)).rows[0] ?? {};
    const rows = (await c.query('select name, party_org = pulse.current_org() ours from pulse.contract_party where contract_id = $1', [id])).rows as { name: string; ours: boolean }[];
    const twice = ourselvesTwice([String(us.name ?? ''), String(us.legal ?? '')], rows, readSource(words).meta?.parties ?? []);
    if (twice) fail(400, `${twice} is your own company, and it is on both sides of this agreement. Use Edit → Parties to put the other side's legal name, then send`);
    const token = party ? randomBytes(32).toString('base64url') : null;
    const r = (await c.query('select pulse.contract_send_to_sign($1,$2,$3,$4,$5,$6) r', [id, party, token ? createHash('sha256').update(token).digest('hex') : null, days,
      email, b.signer === undefined ? null : String(b.signer ?? '').trim().slice(0, 160)])).rows[0].r as Row;
    const url = token ? `${companyLinkOrigin((await c.query('select pulse.org_public_host() h')).rows[0]?.h)}/accept/sign/${token}` : null;
    // The link is shown once, to the person who made it: Vitals OS keeps only its hash. Nothing is sent from here.
    return { ...r, url };
  })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/link-stop', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const id = uuidOr404(req.params.id, 'Agreement');
    const party = UUID.test(String(req.body?.partyKey)) ? String(req.body?.partyKey) : fail(400, 'Choose whose link to stop');
    await c.query('select pulse.contract_link_stop($1,$2)', [id, party]);
    return { ok: true };
  })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/sign', { schema: { body: { type: 'object' } }, bodyLimit: 400 * 1024 }, (req) => tx(req, async (c) => said(async () => {
    const id = uuidOr404(req.params.id, 'Agreement');
    const s = signatureInput(req.body ?? {});
    return { status: (await c.query('select pulse.contract_sign_here($1,$2) s', [id, JSON.stringify(s)])).rows[0].s as string };
  })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/note', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const id = uuidOr404(req.params.id, 'Agreement');
    return { id: (await c.query('select pulse.contract_note($1,$2,$3) id', [id, text(req.body?.clause, 200) ?? null, text(req.body?.text, 4000) ?? ''])).rows[0].id as string };
  })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/resolve', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const id = uuidOr404(req.params.id, 'Agreement');
    const ev = UUID.test(String(req.body?.eventId)) ? String(req.body?.eventId) : fail(400, 'Choose the request');
    await c.query('select pulse.contract_resolve($1,$2)', [id, ev]);
    return { ok: true };
  })));
  app.get<{ Params: { id: string } }>('/api/v0/contracts/:id/pdf', async (req, reply) => {
    const id = uuidOr404(req.params.id, 'Agreement');
    const { bytes, name } = await tx(req, async (c) => {
      const r = await readHere(c, id);
      if (!(await c.query('select pulse.contract_runner($1) r', [id])).rows[0].r) r.audit = [];
      return { bytes: (await agreementPdf(r, await zoneOf(c), await letterheadOf(c))).bytes, name: String(r.title) };
    });
    // CONTRACTS-PRO: ?inline=1 is the agreement's page showing these very bytes (what you read is what you download).
    const inline = (req.query as Row | undefined)?.inline === '1';
    reply.header('cache-control', 'private, no-store').header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60) || 'agreement'}.pdf"`);
    return reply.type('application/pdf').send(Buffer.from(bytes));
  });
  // CONTRACTS-PRO: the editor's live preview: the same document with words not saved yet (who runs the agreement only).
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/preview', { bodyLimit: 400 * 1024, schema: { body: { type: 'object' } } }, async (req, reply) => {
    const id = uuidOr404(req.params.id, 'Agreement');
    const body = text(req.body?.body, 100000) ?? '';
    const title = (text(req.body?.title, 160) ?? '').trim();
    const bytes = await tx(req, async (c) => said(async () => {
      if (!(await c.query('select pulse.contract_runner($1) r', [id])).rows[0].r) fail(403, 'Only who runs this agreement can change its words');
      const r = await readHere(c, id);
      return (await agreementPdf({ ...r, body, title: title || r.title, status: 'draft', audit: [] }, await zoneOf(c), await letterheadOf(c))).bytes;
    }));
    reply.header('cache-control', 'private, no-store');
    return reply.type('application/pdf').send(Buffer.from(bytes));
  });

  // ------------------------------------------------------------------ counts
  app.get('/api/v0/platform/contracts-signed', (req) => tx(req, async (c) => said(async () =>
    ({ months: (await c.query('select pulse.platform_contracts_signed(12) m')).rows[0].m }))));

  // ------------------------------------------------------------------ the client's link (signed out)
  // As quotation links (1625): on the shared address the link is found by its exact hash and runs in its own company.
  const openLink = <T>(run: (c: PoolClient) => Promise<T>) => open(async (c) => {
    await c.query("select set_config('pulse.contract_sign_reach',$1,true)", [sharedAddress() ? '1' : '']);
    return run(c);
  });
  const who = (req: { headers: Record<string, unknown>; ip?: string }) => ({
    ip: createHash('sha256').update(`contract-sign:${String(req.headers['x-pulse-client-ip'] ?? req.ip ?? '')}`).digest('hex'),
    agent: String(req.headers['user-agent'] ?? '').slice(0, 300) });
  app.get<{ Params: { token: string } }>('/api/v0/accept/sign/:token', async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, 'This link is not valid');
    const w = who(req);
    const r = await openLink(async (c) => (await c.query('select pulse.contract_sign_open($1,$2,$3) r', [h, w.ip, w.agent])).rows[0].r);
    return r ?? fail(404, 'This link is not valid or has expired');
  });
  app.get<{ Params: { token: string } }>('/api/v0/accept/sign/:token/pdf', async (req, reply) => {
    const h = hashOf(req.params.token) ?? fail(404, 'This link is not valid');
    const out = await openLink(async (c) => {
      const r = (await c.query('select pulse.contract_sign_audit($1) r', [h])).rows[0].r as Row | null;
      if (!r || r.expired) return null;
      return { bytes: (await agreementPdf(r, await zoneOf(c), await letterheadOf(c))).bytes, name: String(r.title) };
    });
    if (!out) fail(404, 'This link is not valid or has expired');
    const inline = (req.query as Row | undefined)?.inline === '1';
    reply.header('cache-control', 'private, no-store').header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${out!.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60) || 'agreement'}.pdf"`);
    return reply.type('application/pdf').send(Buffer.from(out!.bytes));
  });
  app.post<{ Params: { token: string }; Body: Row }>('/api/v0/accept/sign/:token', { bodyLimit: 400 * 1024 }, async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, 'This link is not valid');
    const b = (req.body ?? {}) as Row;
    const action = ['sign', 'decline', 'comment', 'change'].includes(String(b.action)) ? String(b.action) : fail(400, 'Sign, say no, or write a comment');
    const s = action === 'sign' ? signatureInput(b) : { name: String(b.name ?? '').trim().slice(0, 160) };
    const w = who(req);
    return openLink(async (c) => said(async () => (await c.query('select pulse.contract_sign_act($1,$2,$3,$4) r',
      [h, JSON.stringify({ ...s, action, clause: text(b.clause, 200) ?? null, text: text(b.text, 2000) ?? '' }), w.ip, w.agent])).rows[0].r));
  });
}

/** Word's HTML (mammoth) as the plain text agreements are kept in: headings become "1. Heading" lines, list items keep
 *  their bullet, paragraphs are separated by a blank line. Exported for its unit test. */
export function docxHtmlToText(html: string) {
  let n = 0;
  const decode = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').trim();
  const out: string[] = [];
  for (const m of String(html).matchAll(/<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = decode(m[2]);
    if (!t) continue;
    const tag = m[1].toLowerCase();
    if (tag.startsWith('h')) { out.push('', /^\d{1,2}[.)]\s/.test(t) ? t : `${++n}. ${t}`); continue; }
    out.push(tag === 'li' ? `• ${t}` : t, ...(tag === 'p' ? [''] : []));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
