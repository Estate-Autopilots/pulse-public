// COMPANY-SEARCH (owner, 8 Nov 2026; 1891): find companies and people. Anyone signed in searches; only what a company
// shows and people who turned on "Let people find me" ever come back (the database's definer functions return an
// explicit column list from an index that holds public values only). Contracts finds the other company with it.
//   GET  /v1/directory/companies?q=&limit=&exclude_own=1     GET /v1/directory/companies/:handle
//   GET  /v1/directory/people?q=&limit=                      GET /v1/directory/people/:handle
//   GET  /api/v0/directory/companies/:handle/logo            GET /api/v0/directory/people/:handle/photo
//   GET|POST /api/v0/directory/card (company admins)         GET|POST /api/v0/directory/me (the person's own choice)
//   GET|POST /api/v0/directory/invites                       POST /api/v0/directory/invites/claim
//   GET  /api/v0/directory/browse (verified and recent companies, people of your company who chose to be found; 1906)
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, type Tx, type Viewer } from './routes.js';
import { companyOrigin } from './tenant-context.js';
import { tokenBudgets } from './v1-limits.js';

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;

/** Searches a person may make per minute, each of companies and people (a type-ahead asks once per pause). */
export const SEARCHES_PER_MINUTE = 120;
const HANDLE = /^@?[a-z0-9][a-z0-9._]{2,29}$/i;
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

export const limitOf = (value: unknown) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 8;
};
export const queryOf = (value: unknown) => (typeof value === 'string' ? value : '').trim().slice(0, 120);
export const handleOf = (value: unknown) => {
  const h = String(value ?? '').trim();
  return HANDLE.test(h) ? h.replace(/^@/, '').toLowerCase() : fail(404, 'We could not find that');
};

/** The public company card, as the API answers it (the function's columns, in the contract's names). */
export function companyCard(r: Row, withMatch = true) {
  const handle = String(r.handle);
  return {
    id: r.id as string, handle, name: r.name as string,
    legalName: (r.legal_name as string | null) ?? null, city: (r.city as string | null) ?? null,
    industry: (r.industry as string | null) ?? null, website: (r.website as string | null) ?? null,
    logo: r.logo_version == null ? null : `/api/v0/directory/companies/${encodeURIComponent(handle)}/logo?v=${Number(r.logo_version)}`,
    verified: r.verified_by === 'gstin' || r.verified_by === 'cin', verifiedBy: (r.verified_by as 'gstin' | 'cin' | null) ?? null,
    ids: Array.isArray(r.ids) ? r.ids as { kind: string; label: string; value: string }[] : [],
    ...(withMatch ? { match: r.match as string } : {}),
  };
}

export function personCard(r: Row, withMatch = true) {
  const handle = String(r.handle);
  return {
    handle, name: r.name as string, headline: (r.headline as string | null) ?? null,
    photo: r.photo_version == null ? null : `/api/v0/directory/people/${encodeURIComponent(handle)}/photo?v=${Number(r.photo_version)}`,
    company: r.company_handle ? { handle: r.company_handle as string, name: r.company_name as string } : null,
    email: (r.email as string | null) ?? null, phone: (r.phone as string | null) ?? null,
    ...(withMatch ? { match: r.match as string } : {}),
  };
}

/** An invite's body: a company name, an e-mail or a phone, the purpose and an optional note. Plain-words refusals. */
export function inviteBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Type the company name and an e-mail or phone');
  const b = body as Body;
  const text = (k: string, max: number) => {
    const v = b[k];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') fail(400, 'Type the company name and an e-mail or phone');
    const s = (v as string).trim();
    if (s.length > max) fail(400, `Keep it under ${max} letters`);
    return s || null;
  };
  const companyName = text('companyName', 160);
  if (!companyName || companyName.length < 2) fail(400, "Type the company's name");
  const email = text('email', 200), phone = text('phone', 24);
  if (!email && !phone) fail(400, 'Add an e-mail or a phone number');
  const purpose = b.purpose === 'contract' ? 'contract' : 'general';
  return { companyName: companyName as string, email, phone, purpose, note: text('note', 300) };
}

export function registerDirectoryRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const budgets = tokenBudgets();
  const spend = (reply: FastifyReply, area: string, v: Viewer) => {
    const r = budgets(area, v.person ?? `${v.org}:${v.email}`, SEARCHES_PER_MINUTE);
    if (r.limited) { reply.header('retry-after', String(r.reset)); fail(429, 'Too many searches. Wait a minute and try again.'); }
  };
  const person = (v: Viewer) => { if (!v.person) fail(403, 'Sign in with your own account to search'); };
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'private, no-store');

  app.get<{ Querystring: { q?: string; limit?: string; exclude_own?: string } }>('/v1/directory/companies', (req, reply) => tx(req, async (c, v) => {
    person(v); spend(reply, 'companies', v); noStore(reply);
    const q = queryOf(req.query.q);
    const rows = (await c.query('select * from pulse.directory_companies($1,$2,$3)',
      [q, limitOf(req.query.limit), req.query.exclude_own === '1' || req.query.exclude_own === 'true' ? v.org : null])).rows;
    return { q, companies: rows.map((r) => companyCard(r)) };
  }));

  app.get<{ Params: { handle: string } }>('/v1/directory/companies/:handle', (req, reply) => tx(req, async (c, v) => {
    person(v); noStore(reply);
    const r = (await c.query('select * from pulse.directory_company($1)', [handleOf(req.params.handle)])).rows[0];
    if (!r) fail(404, 'We could not find that company');
    return { company: companyCard(r, false) };
  }));

  app.get<{ Querystring: { q?: string; limit?: string } }>('/v1/directory/people', (req, reply) => tx(req, async (c, v) => {
    person(v); spend(reply, 'people', v); noStore(reply);
    const q = queryOf(req.query.q);
    const rows = (await c.query('select * from pulse.directory_people($1,$2)', [q, limitOf(req.query.limit)])).rows;
    return { q, people: rows.map((r) => personCard(r)) };
  }));

  app.get<{ Params: { handle: string } }>('/v1/directory/people/:handle', (req, reply) => tx(req, async (c, v) => {
    person(v); noStore(reply);
    const r = (await c.query('select * from pulse.directory_person($1)', [handleOf(req.params.handle)])).rows[0];
    if (!r) fail(404, 'We could not find that person');
    return { person: personCard(r, false) };
  }));

  // UI-SWEEP: something to browse before anything is typed: verified companies, the companies that joined most
  // recently (both without the viewer's own) and the people of the viewer's company who chose to be found (1906).
  app.get('/api/v0/directory/browse', (req, reply) => tx(req, async (c, v) => {
    person(v); noStore(reply);
    const [verified, recent, colleagues] = [
      (await c.query("select * from pulse.directory_browse_companies('verified', 4)")).rows,
      (await c.query("select * from pulse.directory_browse_companies('recent', 5)")).rows,
      (await c.query('select * from pulse.directory_browse_people(8)')).rows,
    ];
    return { verified: verified.map((r) => companyCard(r, false)), recent: recent.map((r) => companyCard(r, false)), colleagues: colleagues.map((r) => personCard(r, false)) };
  }));

  // A shown logo or photo: sandboxed, never sniffed, cached briefly by its version.
  const picture = (kind: 'company' | 'person') => async (req: FastifyRequest<{ Params: { handle: string } }>, reply: FastifyReply) => {
    const row = await tx(req, async (c, v) => {
      person(v);
      return (await c.query(kind === 'company' ? 'select * from pulse.directory_company_logo($1)' : 'select * from pulse.directory_person_photo($1)',
        [handleOf(req.params.handle)])).rows[0] as { mime?: string; bytes?: Buffer; version?: number } | undefined;
    });
    if (!row?.bytes) fail(404, kind === 'company' ? 'This company shows no logo' : 'This person shows no photo');
    const mime = ['image/svg+xml', 'image/png', 'image/webp', 'image/jpeg'].includes(String(row!.mime)) ? String(row!.mime) : 'application/octet-stream';
    const tag = `"dir-${kind}-${req.params.handle}-${row!.version ?? 0}"`;
    reply.header('cache-control', 'private, max-age=300, stale-while-revalidate=86400').header('etag', tag)
      .header('x-content-type-options', 'nosniff').header('content-security-policy', IMAGE_CSP);
    if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    return reply.type(mime).send(row!.bytes);
  };
  app.get<{ Params: { handle: string } }>('/api/v0/directory/companies/:handle/logo', picture('company'));
  app.get<{ Params: { handle: string } }>('/api/v0/directory/people/:handle/photo', picture('person'));

  // Settings → Company → Public profile (the database checks the admin).
  app.get('/api/v0/directory/card', (req, reply) => tx(req, async (c) => {
    noStore(reply);
    return { card: (await c.query('select pulse.directory_card_get() c')).rows[0].c };
  }));
  app.post<{ Body: Body }>('/api/v0/directory/card', { schema: { body: { type: 'object' } } }, (req, reply) => tx(req, async (c) => {
    noStore(reply);
    const allowed = ['listed', 'legalName', 'city', 'industry', 'website', 'gstin', 'cin', 'otherIds', 'show'];
    const body = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
    return { card: (await c.query('select pulse.directory_card_save($1::jsonb) c', [JSON.stringify(body)])).rows[0].c };
  }));

  // "Let people find me" (the person's own choice; their account, in every company).
  app.get('/api/v0/directory/me', (req, reply) => tx(req, async (c, v) => {
    person(v); noStore(reply);
    return { me: (await c.query('select pulse.directory_me() m')).rows[0].m };
  }));
  app.post<{ Body: Body }>('/api/v0/directory/me', { schema: { body: { type: 'object' } } }, (req, reply) => tx(req, async (c, v) => {
    person(v); noStore(reply);
    const b = req.body ?? {};
    const body: Body = {};
    for (const k of ['findable', 'showEmail', 'showPhone']) if (k in b) { if (typeof b[k] !== 'boolean') fail(400, 'Choose on or off'); body[k] = b[k]; }
    if ('company' in b) { if (b.company !== null && typeof b.company !== 'string') fail(400, 'Choose one of your companies'); body.company = b.company ?? ''; }
    return { me: (await c.query('select pulse.directory_me_save($1::jsonb) m', [JSON.stringify(body)])).rows[0].m };
  }));

  // "Not on Vitals? Invite them": a pending invite and a one-click join link, shown once. Nothing is sent.
  app.get('/api/v0/directory/invites', (req, reply) => tx(req, async (c, v) => {
    person(v); noStore(reply);
    return { invites: (await c.query('select pulse.directory_invites() l')).rows[0].l };
  }));
  app.post<{ Body: Body }>('/api/v0/directory/invites', { schema: { body: { type: 'object' } } }, (req, reply) => tx(req, async (c, v) => {
    person(v); noStore(reply);
    const b = inviteBody(req.body);
    const token = randomBytes(24).toString('base64url');
    const invite = (await c.query('select pulse.directory_invite_make($1,$2,$3,$4,$5,$6) i',
      [b.companyName, b.email, b.phone, b.purpose, b.note, createHash('sha256').update(token).digest('hex')])).rows[0].i;
    reply.code(201);
    return { invite: { ...invite, link: `${companyOrigin()}/signup?next=${encodeURIComponent(`/directory/join/${token}`)}` } };
  }));
  app.post<{ Body: Body }>('/api/v0/directory/invites/claim', { schema: { body: { type: 'object' } } }, (req, reply) => tx(req, async (c, v) => {
    person(v); noStore(reply);
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) fail(404, 'This invite link is not right. Ask for a new one.');
    const r = (await c.query('select pulse.directory_invite_claim($1) c', [createHash('sha256').update(token).digest('hex')])).rows[0].c;
    if (!r) fail(404, 'This invite link is not right. Ask for a new one.');
    return { invite: r };
  }));
}
