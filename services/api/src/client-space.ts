// PORTAL-2 (owner, 25 Oct 2026): what makes the client space a place to live in (db/migrations/1066_client_portal_2.sql).
// The team (any active colleague; Finance for money):
//   GET  /api/v0/clients/:id/deliverables              a client's deliverables for approval, with versions and comments
//   POST /api/v0/clients/:id/deliverables              share one (a file uploaded below, or an https link)
//   GET  /api/v0/client-deliverables/:id               one deliverable
//   POST /api/v0/client-deliverables/:id/versions      a new version (the client checks it again)
//   POST /api/v0/client-deliverables/:id/comments      a comment (pinned to a point, a moment or a page, or not)
//   POST /api/v0/client-deliverables/:id/withdraw
//   POST /api/v0/client-deliverables/comments/:id/resolve
//   POST /api/v0/client-files  ·  POST /api/v0/client-files/:id/parts/:n  ·  GET /api/v0/client-files/:id
//   GET|POST /api/v0/erp/client-payments               paying from the client space: the switch, UPI and bank details
//   GET  /api/v0/erp/documents/:id/payment-claims      what clients said they paid on a document
//   POST /api/v0/erp/payment-claims/:id                confirmed (records the payment) or not received
// The client's seat (routes.ts lets it reach /client-portal):
//   GET  /api/v0/client-portal/deliverables/:id  ·  POST …/deliverables/:id/comments  ·  POST …/deliverables/:id/answer
//   POST /api/v0/client-portal/comments/:id/resolve
//   POST /api/v0/client-portal/files  ·  POST …/files/:id/parts/:n  ·  GET …/files/:id   (a proof of payment; files shared)
//   POST /api/v0/client-portal/pay                     "I've paid": a check task for Finance
//   POST /api/v0/client-portal/prefs                   the tour seen, the daily e-mail digest on or off
// Files are kept in 1 MiB parts and stream with range requests; who may open one is decided in the database.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { parseRange } from './review-media.js';
import { fail, work, type Tx, type Viewer } from './routes.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PART = 1048576;
const id = (x: unknown, what = 'Choose a valid record') => UUID.test(String(x)) ? String(x) : fail(400, what);
const optId = (x: unknown, what: string) => x === undefined || x === null || x === '' ? null : id(x, what);
const text = (x: unknown, max: number) => String(x ?? '').slice(0, max);
const day = (x: unknown, what: string) => x === undefined || x === null || x === '' ? null : DAY.test(String(x)) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) ? String(x) : fail(400, what);
const num = (x: unknown, lo: number, hi: number, what: string) => {
  if (x === undefined || x === null || x === '') return null;
  const n = Number(x); return Number.isFinite(n) && n >= lo && n <= hi ? n : fail(400, what);
};
const INLINE = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|aac|ogg|wav|webm)|application\/pdf)$/;

async function plain<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const err = e as { code?: string; message?: string; statusCode?: number };
    if (err.statusCode) throw e;
    const status = ({ '42501': 403, '22023': 400, '23505': 409, P0002: 404, '28000': 401, '54000': 429, '23514': 400 } as Record<string, number>)[err.code ?? ''];
    if (status) fail(status, String(err.message ?? 'Not possible'));
    throw e;
  }
}

/** A version's content from a request: a finished upload, or an https link, with an optional name and note. */
function source(b: Body) {
  const fileId = optId(b.fileId, 'Upload the file again');
  const url = text(b.url, 2000).trim();
  if (!fileId && !/^https:\/\/\S+$/.test(url)) fail(400, 'Add a file, or a link that starts with https://');
  return { ...(fileId ? { fileId } : { url }), name: text(b.name, 200).trim(), versionNote: text(b.versionNote, 2000) };
}
function pin(b: Body) {
  const x = num(b.x, 0, 1, 'Pin the comment on the picture'), y = num(b.y, 0, 1, 'Pin the comment on the picture');
  if ((x === null) !== (y === null)) fail(400, 'Pin the comment on the picture');
  const whole = (n: number | null) => n === null ? null : Math.floor(n);
  return { body: text(b.body, 2000), x, y, at: num(b.at, 0, 86399, 'Choose a moment of the video'), page: whole(num(b.page, 1, 9999, 'Choose a page')),
    version: whole(num(b.version, 1, 99, 'Choose a version')) };
}

/** Stream a stored file: whole, or the range asked for (at most 8 MiB per answer, like WhatsApp files). */
async function serve(req: FastifyRequest, c: PoolClient, file: string) {
  const f = (await c.query('select pulse.cp_file_open($1) f', [file])).rows[0].f as { name: string; mime: string; size: number; parts: number } | null;
  if (!f) fail(404, 'File unavailable');
  const range = req.headers.range ? parseRange(String(req.headers.range), f!.size) : { start: 0, end: f!.size - 1, partial: false };
  if (!range) return { f: f!, range: null, bytes: Buffer.alloc(0) };
  const start = range.start, end = Math.min(range.end, range.partial ? start + 8 * PART - 1 : f!.size - 1);
  const chunks: Buffer[] = [];
  for (let p = Math.floor(start / PART); p <= Math.floor(end / PART); p += 64)
    for (const r of (await c.query('select part,data from pulse.cp_file_parts($1,$2,$3)', [file, p, Math.min(p + 63, Math.floor(end / PART))])).rows) chunks.push(r.data);
  const all = Buffer.concat(chunks), from = start - Math.floor(start / PART) * PART;
  return { f: f!, range: { ...range, end }, bytes: all.subarray(from, from + end - start + 1) };
}
function send(reply: FastifyReply, file: string, out: Awaited<ReturnType<typeof serve>>) {
  const { f, range, bytes } = out;
  const inline = INLINE.test(f.mime);
  if (f.mime !== 'application/pdf' || !inline) reply.header('content-security-policy', 'sandbox');
  reply.header('cache-control', 'private, max-age=86400').header('etag', `"${file}"`).header('accept-ranges', 'bytes').header('x-content-type-options', 'nosniff')
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name.replace(/[\r\n"]/g, ''))}`).type(inline ? f.mime : 'application/octet-stream');
  if (!range) return reply.code(416).header('content-range', `bytes */${f.size}`).send();
  if (range.partial) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${f.size}`);
  reply.header('content-length', String(bytes.length));
  return reply.send(bytes);
}

/** The client side is for a client's seat here: anyone else is refused before any record is looked up. */
async function seat(c: PoolClient) { if (!(await c.query('select pulse.cp_viewer_conn() k')).rows[0].k) fail(403, 'This is for clients of this organisation'); }
/** The team side: a staff session with work access (HR-only accounts are refused, as on every client page). */
const team = (v: Viewer) => work(v);

export function registerClientSpaceRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // ------------------------------------------------------------------------------------------- files (both sides)
  for (const side of ['team', 'client'] as const) {
    const base = side === 'team' ? '/api/v0/client-files' : '/api/v0/client-portal/files';
    const guard = async (c: PoolClient, v: Viewer) => { if (side === 'team') team(v); else await seat(c); };
    app.post<{ Body: Body }>(base, { schema: { body } }, (req) => tx(req, async (c, v) => {
      await guard(c, v);
      const size = num(req.body.size, 1, 314572800, 'A file can be up to 300 MB: share a Drive link for bigger ones') ?? fail(400, 'Choose a file');
      const file = await plain(async () => (await c.query('select pulse.cp_file_start($1,$2,$3,$4,$5) id', [side === 'team' ? id(req.body.clientId, 'Choose the client') : null,
        side === 'team' ? 'deliverable' : 'proof', text(req.body.name, 200), text(req.body.mime, 120), Math.floor(size)])).rows[0].id as string);
      return { id: file, parts: Math.ceil(size / PART), partSize: PART };
    }));
    // A part is sent as base64 in JSON (the web's proxy forwards text bodies): 1 MiB is about 1.4 MB on the wire.
    app.post<{ Params: { id: string; n: string }; Body: Body }>(`${base}/:id/parts/:n`, { schema: { body: { type: 'object', maxProperties: 2 } }, bodyLimit: 1_500_000 }, (req) => tx(req, async (c, v) => {
      await guard(c, v);
      const n = num(req.params.n, 0, 299, 'That part is not in this file') ?? fail(400, 'That part is not in this file');
      const data = typeof req.body.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(req.body.data) ? Buffer.from(req.body.data, 'base64') : fail(400, 'Send the part as base64');
      return plain(async () => (await c.query('select pulse.cp_file_put($1,$2,$3) r', [id(req.params.id, 'File not found'), Math.floor(n), data])).rows[0].r);
    }));
    app.get<{ Params: { id: string } }>(`${base}/:id`, async (req, reply) => {
      const file = id(req.params.id, 'File not found');
      const out = await tx(req, async (c, v) => { await guard(c, v); return serve(req, c, file); });
      return send(reply, file, out);
    });
  }

  // ------------------------------------------------------------------------------------------- deliverables: the team
  app.get<{ Params: { id: string } }>('/api/v0/clients/:id/deliverables', (req) => tx(req, async (c, v) => {
    team(v); return plain(async () => (await c.query('select pulse.client_deliverables($1) r', [id(req.params.id, 'Client not found')])).rows[0].r);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/clients/:id/deliverables', { schema: { body } }, (req) => tx(req, async (c, v) => {
    team(v); const b = req.body;
    const p = { title: text(b.title, 160), projectId: optId(b.projectId, 'Choose a project'), note: text(b.note, 2000), ownerId: optId(b.ownerId, 'Choose a colleague'),
      answerBy: day(b.answerBy, 'Choose a day'), ...source(b) };
    return { id: await plain(async () => (await c.query('select pulse.client_deliverable_share($1,$2) id', [id(req.params.id, 'Client not found'), JSON.stringify(p)])).rows[0].id) };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/client-deliverables/:id', (req) => tx(req, async (c, v) => {
    team(v); return plain(async () => (await c.query('select pulse.client_deliverable_get($1) r', [id(req.params.id, 'Deliverable not found')])).rows[0].r);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/client-deliverables/:id/versions', { schema: { body } }, (req) => tx(req, async (c, v) => {
    team(v);
    return { version: await plain(async () => (await c.query('select pulse.client_deliverable_version_add($1,$2) v', [id(req.params.id, 'Deliverable not found'), JSON.stringify(source(req.body))])).rows[0].v) };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/client-deliverables/:id/withdraw', (req) => tx(req, async (c, v) => {
    team(v); await plain(() => c.query('select pulse.client_deliverable_withdraw($1)', [id(req.params.id, 'Deliverable not found')])); return { ok: true };
  }));

  // ------------------------------------------------------------------------------------------- deliverables: both sides
  for (const base of ['/api/v0/client-deliverables', '/api/v0/client-portal/deliverables']) {
    app.post<{ Params: { id: string }; Body: Body }>(`${base}/:id/comments`, { schema: { body } }, (req) => tx(req, async (c, v) => {
      if (base.includes('portal')) await seat(c); else team(v);
      return { id: await plain(async () => (await c.query('select pulse.cp_deliverable_comment($1,$2) id', [id(req.params.id, 'Deliverable not found'), JSON.stringify(pin(req.body))])).rows[0].id) };
    }));
  }
  for (const path of ['/api/v0/client-deliverables/comments/:id/resolve', '/api/v0/client-portal/comments/:id/resolve']) {
    app.post<{ Params: { id: string }; Body: Body }>(path, { schema: { body } }, (req) => tx(req, async (c, v) => {
      if (path.includes('portal')) await seat(c); else team(v);
      await plain(() => c.query('select pulse.cp_deliverable_comment_resolve($1,$2)', [id(req.params.id, 'Comment not found'), req.body.done !== false])); return { ok: true };
    }));
  }

  // ------------------------------------------------------------------------------------------- deliverables: the client
  app.get<{ Params: { id: string } }>('/api/v0/client-portal/deliverables/:id', (req) => tx(req, async (c) => {
    await seat(c); return plain(async () => (await c.query('select pulse.cp_deliverable($1) r', [id(req.params.id, 'Not found')])).rows[0].r);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/client-portal/deliverables/:id/answer', { schema: { body } }, (req) => tx(req, async (c) => {
    await seat(c);
    const version = Math.floor(num(req.body.version, 1, 99, 'Choose a version') ?? fail(400, 'Choose a version'));
    return plain(async () => (await c.query('select pulse.cp_deliverable_decide($1,$2,$3,$4,$5) r', [id(req.params.id, 'Not found'), version,
      text(req.body.decision, 20), text(req.body.name, 120), text(req.body.note, 2000)])).rows[0].r);
  }));

  // ------------------------------------------------------------------------------------------- paying
  app.post<{ Body: Body }>('/api/v0/client-portal/pay', { schema: { body } }, (req) => tx(req, async (c) => {
    await seat(c); const b = req.body;
    const amount = num(b.amount, 1, 1e14, 'Type the amount you paid') ?? fail(400, 'Type the amount you paid');
    const p = { documentId: optId(b.documentId, 'Choose the invoice'), milestoneId: optId(b.milestoneId, 'Choose the instalment'), amount: Math.round(amount),
      paidOn: day(b.paidOn, 'Choose the day you paid') ?? fail(400, 'Choose the day you paid'), method: text(b.method, 20), reference: text(b.reference, 120),
      note: text(b.note, 1000), proofFileId: optId(b.proofFileId, 'Attach the proof again') };
    return { id: await plain(async () => (await c.query('select pulse.cp_pay_claim($1) id', [JSON.stringify(p)])).rows[0].id) };
  }));
  app.get('/api/v0/erp/client-payments', (req) => tx(req, async (c) => plain(async () => (await c.query('select pulse.client_pay_settings_get() s')).rows[0].s)));
  app.post<{ Body: Body }>('/api/v0/erp/client-payments', { schema: { body } }, (req) => tx(req, async (c) => {
    const b = req.body; const bank = (b.bank && typeof b.bank === 'object' ? b.bank : {}) as Body;
    const p = { enabled: b.enabled === true, gateway: text(b.gateway, 20) || 'none', payee: text(b.payee, 120), upi: text(b.upi, 330).trim(), note: text(b.note, 1000),
      bank: Object.fromEntries(['accountName', 'bankName', 'branch', 'accountNumber', 'ifsc'].map((k) => [k, text(bank[k], 120).trim()])) };
    return plain(async () => (await c.query('select pulse.client_pay_settings_save($1) s', [JSON.stringify(p)])).rows[0].s);
  }));
  app.get<{ Params: { id: string } }>('/api/v0/erp/documents/:id/payment-claims', (req) => tx(req, async (c) =>
    ({ claims: await plain(async () => (await c.query('select pulse.client_payment_claims($1) r', [id(req.params.id, 'Document not found')])).rows[0].r) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/erp/payment-claims/:id', { schema: { body } }, (req) => tx(req, async (c) => {
    const amount = num(req.body.amount, 1, 1e14, 'Type the amount received');
    const p = { note: text(req.body.note, 1000), amount: amount === null ? null : Math.round(amount), receivedOn: day(req.body.receivedOn, 'Choose the day the money arrived') };
    return plain(async () => (await c.query('select pulse.client_payment_decide($1,$2,$3) r', [id(req.params.id, 'Not found'), text(req.body.decision, 20), JSON.stringify(p)])).rows[0].r);
  }));

  // ------------------------------------------------------------------------------------------- preferences
  app.post<{ Body: Body }>('/api/v0/client-portal/prefs', { schema: { body } }, (req) => tx(req, async (c) => {
    await seat(c); const p: Body = {};
    if (typeof req.body.tourDone === 'boolean') p.tourDone = req.body.tourDone;
    if (typeof req.body.digest === 'boolean') p.digest = req.body.digest;
    return { prefs: await plain(async () => (await c.query('select pulse.cp_pref_set($1) p', [JSON.stringify(p)])).rows[0].p) };
  }));
}
