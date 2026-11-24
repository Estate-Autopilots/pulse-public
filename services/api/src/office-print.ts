// OFFICE-PRINT (owner at the Willow Lane office, 21 Nov 2026: "this needs to be directly inside Vitals OS"; spec: the Mac's
// ~/orch/office-setup/print-agent/QUEUE-API.md; migration 2503). Print a numbered quotation, proforma, tax invoice or
// credit note on the office printer:
//   people   GET  /api/v0/office-print                       the queue and history, the printers, the agents (admins)
//            POST /api/v0/office-print/jobs                  {documentId, copies 1–20, sides, confirmLarge}: queue it
//            POST /api/v0/office-print/agents                {name}: an admin connects an office print agent (token once)
//            POST /api/v0/office-print/agents/:id/revoke
//   agent    POST /api/v0/office-print/agent/next            {agent, printer}: claim the oldest job (204: none)
//   (Bearer  GET  /api/v0/office-print/jobs/:id/file          the filed PDF of a job it claimed
//    vpa_…)  POST /api/v0/office-print/jobs/:id/update       {status printing|done|failed, detail, printer_job}
//            POST /api/v0/office-print/agent/status          the printer's state, warnings, ink and pages (every 15 min)
//   bhrātā   print_document (API v1 POST /api/v1/billing/documents/{documentId}/print): only when a person asked in the
//            chat (the runtime's askedById) and confirmed; the job is theirs.
// The web exposes the agent routes at /api/office-print/* (apps/web/app/api/office-print). The token is per company and
// per agent; only its sha-256 is kept. Limits (database): 1–20 copies a job, 200 pages a day a company; above 20 pages a
// person confirms twice.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { pdfPageCount } from '@pulse/invoice-doc';
import { fail, type Open, type Tx } from './routes.js';
import { companyLinkOrigin } from './tenant-context.js';
import { defineV1Operation, v1Fail } from './v1.js';
import { bool, int, member, object, one, text, uuid } from './v1-kit.js';
import { readModules } from './modules.js';
import type { V1Context } from './v1.js';

// Billing's own checks, as v1-money's billingReader / seesBilling (not imported: v1-money loads erp.ts, which loads this).
const canBill = (ctx: V1Context) => one<boolean>(ctx, 'select pulse.erp_can(false) v');
const moneyOff = async (ctx: V1Context) => (await readModules(ctx.client, ctx.tenantId)).off.includes('money');
const seesBilling = async (ctx: V1Context) => !(await moneyOff(ctx)) && await canBill(ctx);
const billingReader = async (ctx: V1Context) => {
  await member(ctx);
  if (await moneyOff(ctx)) v1Fail(404, 'Billing is switched off for this company');
  if (!(await canBill(ctx))) v1Fail(403, 'Printing is for people who use Billing');
};
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TOKEN = /^Bearer (vpa_[A-Za-z0-9_-]{43})$/;
export const LARGE_PAGES = 20;
const SIDES = ['one-sided', 'two-sided-long-edge'];
type Body = Record<string, unknown>;

/** The token's sha-256, or null for a header that is not an office print agent's token. */
export const agentHash = (authorization: unknown) => {
  const m = typeof authorization === 'string' ? TOKEN.exec(authorization) : null;
  return m ? createHash('sha256').update(m[1]).digest('hex') : null;
};
/** A new token: "vpa_" and 43 url-safe characters (256 random bits). */
export const newAgentToken = () => `vpa_${randomBytes(32).toString('base64url')}`;

/** The filed PDF of a document this person sees (row security), and its pages. */
async function filedPages(c: PoolClient, documentId: string) {
  const d = (await c.query('select d.id,d.status,(select f.bytes from pulse.erp_document_file f where f.document_id=d.id and f.kind=\'pdf\') bytes from pulse.erp_document d where d.id=$1', [documentId])).rows[0];
  if (!d) return null;
  return { status: d.status as string, pages: d.bytes ? await pdfPageCount(new Uint8Array(d.bytes)) : null };
}
/** The words a person or bhrātā reads before printing: how many pages, and whether this needs a second yes. */
export function printPlan(pages: number, copies: number, confirmLarge: boolean) {
  const sheets = pages * copies;
  return { pages, copies, sheets, needConfirm: pages > LARGE_PAGES && !confirmLarge,
    ask: pages > LARGE_PAGES && !confirmLarge ? `It is ${pages} pages${copies > 1 ? ` × ${copies} copies (${sheets} pages)` : ''}. Print it anyway?` : null };
}
const copiesOf = (x: unknown) => (Number.isInteger(x) && Number(x) >= 1 && Number(x) <= 20 ? Number(x) : x === undefined ? 1 : fail(400, 'Print 1 to 20 copies'));
const sidesOf = (x: unknown) => (x === undefined || x === null ? 'one-sided' : SIDES.includes(String(x)) ? String(x) : fail(400, 'One-sided or two-sided'));

export function registerOfficePrint(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  // ---------------------------------------------------------------- people
  app.get('/api/v0/office-print', (req) => tx(req, async (c) =>
    (await c.query('select pulse.office_print_overview() v')).rows[0].v ?? fail(403, 'Printing is for people who use Billing')));
  app.post<{ Body: Body }>('/api/v0/office-print/jobs', (req) => tx(req, async (c) => {
    // Who prints at all is Billing's people (the database checks again when it queues): before any shape is looked at.
    if (!(await c.query('select pulse.erp_can(false) v')).rows[0].v) fail(403, 'Printing is for people who use Billing');
    const b = req.body ?? {};
    const documentId = typeof b.documentId === 'string' && UUID.test(b.documentId) ? b.documentId : fail(400, 'Choose the document to print');
    const copies = copiesOf(b.copies), sides = sidesOf(b.sides);
    const doc = (await filedPages(c, documentId)) ?? fail(404, 'Document not found');
    if (doc.pages === null) fail(400, 'This document has no filed copy to print yet');
    const plan = printPlan(doc.pages!, copies, b.confirmLarge === true);
    if (plan.needConfirm) return { queued: false, ...plan };
    const job = (await c.query('select pulse.office_print_queue($1,$2,$3,$4) v', [documentId, copies, sides, doc.pages])).rows[0].v;
    return { queued: true, ...plan, job };
  }));
  app.post<{ Body: Body }>('/api/v0/office-print/agents', (req) => tx(req, async (c) => {
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : 'Office print agent';
    const token = newAgentToken();
    const id = (await c.query('select pulse.office_print_agent_create($1,$2) v', [name, createHash('sha256').update(token).digest('hex')])).rows[0].v as string;
    const base = `${companyLinkOrigin((await c.query('select pulse.org_public_host() h')).rows[0]?.h)}/api/office-print`;
    // Shown once: the admin puts it in a file on the office computer (VITALS_PRINT_TOKEN_FILE); only its hash is kept.
    return { id, name, token, base };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/office-print/agents/:id/revoke', (req) => tx(req, async (c) => {
    if (!UUID.test(req.params.id)) fail(404, 'Agent not found');
    return { revoked: (await c.query('select pulse.office_print_agent_revoke($1) v', [req.params.id])).rows[0].v === true };
  }));

  // ---------------------------------------------------------------- the office print agent (no person, its token)
  const agent = (req: FastifyRequest) => agentHash(req.headers.authorization) ?? fail(401, 'Invalid print agent token');
  const words = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : x === null || x === undefined ? '' : String(x).slice(0, max));
  app.post<{ Body: Body }>('/api/v0/office-print/agent/next', async (req, reply) => {
    const hash = agent(req);
    const r = await open(async (c) => (await c.query('select pulse.office_print_next($1,$2,$3) v', [hash, words(req.body?.agent, 120), words(req.body?.printer, 300)])).rows[0].v);
    if (!r?.known) fail(401, 'Invalid print agent token');
    if (!r.job) return reply.code(204).send();
    return r.job;
  });
  app.get<{ Params: { id: string } }>('/api/v0/office-print/jobs/:id/file', async (req, reply) => {
    const hash = agent(req);
    if (!UUID.test(req.params.id)) fail(404, 'Not a job this agent claimed');
    const r = await open(async (c) => {
      const known = (await c.query('select pulse.office_print_known($1) v', [hash])).rows[0]?.v === true;
      return { known, bytes: known ? (await c.query('select pulse.office_print_file($1,$2) v', [hash, req.params.id])).rows[0].v as Buffer | null : null };
    });
    if (!r.known) fail(401, 'Invalid print agent token');
    if (!r.bytes) fail(404, 'Not a job this agent claimed');
    return reply.type('application/pdf').header('cache-control', 'private, no-store').send(Buffer.from(r.bytes!));
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/office-print/jobs/:id/update', async (req) => {
    const hash = agent(req);
    if (!UUID.test(req.params.id)) fail(404, 'Not a job this agent claimed');
    const status = ['printing', 'done', 'failed'].includes(String(req.body?.status)) ? String(req.body?.status) : fail(400, 'Say printing, done or failed');
    const r = await open(async (c) => (await c.query('select pulse.office_print_update($1,$2,$3,$4,$5) v',
      [hash, req.params.id, status, words(req.body?.detail, 300) || null, words(req.body?.printer_job, 60) || null])).rows[0].v);
    if (r === null) fail(401, 'Invalid print agent token');
    return { status: r };
  });
  app.post<{ Body: Body }>('/api/v0/office-print/agent/status', async (req) => {
    const hash = agent(req);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const ink = Array.isArray(b.ink) ? b.ink.slice(0, 12).map((i) => ({ name: words((i as Body)?.name, 60) || 'toner',
      percent: Number.isFinite((i as Body)?.percent) ? Math.max(0, Math.min(100, Math.round(Number((i as Body).percent)))) : null })) : [];
    const payload = { agent: words(b.agent, 120), printer: words(b.printer, 300), model: words(b.model, 200) || null, state: words(b.state, 40) || null,
      warnings: Array.isArray(b.warnings) ? b.warnings.slice(0, 20).map((w) => words(w, 80)) : [], ink,
      pages: Number.isInteger(b.pages) ? b.pages : null, accepts_pdf: typeof b.accepts_pdf === 'boolean' ? b.accepts_pdf : null };
    const r = await open(async (c) => (await c.query('select pulse.office_print_status($1,$2) v', [hash, JSON.stringify(payload)])).rows[0].v);
    if (!r?.known) fail(401, 'Invalid print agent token');
    return { ok: true, alert: r.alert === true };
  });
}

// ---------------------------------------------------------------- bhrātā: print_document (API v1)
const JOB = object({ id: uuid, title: { type: 'string' }, copies: int, pages: int, sides: { type: 'string' }, usedToday: int, limit: int });
defineV1Operation({ operationId: 'printDocument', method: 'POST', path: '/api/v1/billing/documents/{documentId}/print', scope: 'billing.write',
  summary: 'Print a numbered quotation, proforma or invoice on the office printer, only when a person asked; send confirm true',
  params: object({ documentId: uuid }),
  body: object({ copies: { type: 'integer', minimum: 1, maximum: 20 }, sides: { type: 'string', enum: SIDES }, confirm: bool, confirmLarge: bool,
    askedById: { ...uuid, description: 'Filled in by an AI employee\'s runtime: who asked in that chat.' }, chatId: { ...uuid, description: 'Filled in by an AI employee\'s runtime: the chat it answers in.' },
    note: text(200, 0) }, ['confirm']),
  response: object({ job: JOB }), available: seesBilling, authorize: billingReader,
  mcp: { name: 'print_document', title: 'Print a document on the office printer',
    description: 'Prints a numbered quotation, proforma or tax invoice (documentId from find_documents or get_billing_document) on the company\'s office printer. ONLY when a person in the chat asked to print it: never on your own. First say back which document and how many copies (1 to 20; sides "two-sided-long-edge" for both sides) and wait for their yes, then send confirm true. Above 20 pages Pulse answers 409 with the page count: ask once more and send confirmLarge true. The job is the person\'s, in the document\'s log; the company prints at most 200 pages a day. Answer with the job title and copies and say it prints in a few seconds.' },
  handler: async (ctx, { params, body }) => {
    const b = (body ?? {}) as Body;
    if (b.confirm !== true) v1Fail(400, 'Ask the person first: which document and how many copies; then send confirm true');
    const side = await one<string>(ctx, 'select side v from pulse.person where id=pulse.current_viewer()');
    const asked = typeof b.askedById === 'string' ? b.askedById : null;
    if (side === 'agent' && !asked) v1Fail(403, 'An AI employee prints only when a person asks in the chat');
    const doc = (await filedPages(ctx.client, params.documentId)) ?? v1Fail(404, 'Document not found');
    if (doc.pages === null) v1Fail(409, 'This document has no filed copy to print yet: it prints once it is numbered');
    const copies = Number.isInteger(b.copies) ? Number(b.copies) : 1;
    const plan = printPlan(doc.pages!, copies, b.confirmLarge === true);
    if (plan.needConfirm) v1Fail(409, `${plan.ask} Ask the person once more, then send confirmLarge true`);
    const job = await one<Body>(ctx, 'select pulse.office_print_queue($1,$2,$3,$4,$5) v',
      [params.documentId, copies, typeof b.sides === 'string' ? b.sides : 'one-sided', doc.pages, side === 'agent' ? asked : null]);
    return { job };
  },
});
