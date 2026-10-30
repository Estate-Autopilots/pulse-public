// CONNECT (owner, 23 Oct 2026): client connections between organisations on this Pulse (0953). When a deal closes, the
// organisation prepares a client request with everything filled in and gets a private link (shown once, also as an
// e-mail preview: nothing is e-mailed from here). The client opens it, signs in or makes a Pulse account, sets up their
// organisation from the details (or uses one they run, or joins as an individual) and accepts: both organisations see
// the connection, each side's points of contact get a seat in the other, and groups and tasks made for the connection
// are the only things that cross (pulse_priv.connect_share). Every request still runs inside exactly one organisation.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authIp } from './account-security.js';
import { deviceLabel, passwordError } from './auth-policy.js';
import { PACK, packPayload } from './flow/packs.js';
import { fail, sessionHash, type Open, type Tx } from './routes.js';
import { companyOrigin, requestCompany } from './tenant-context.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const text = (x: unknown, max = 200) => String(x ?? '').slice(0, max);
const secret = () => randomBytes(32).toString('base64url');
const device = (req: FastifyRequest) => deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));
const id = (x: unknown, what = 'Choose a valid record') => UUID.test(String(x)) ? String(x) : fail(400, what);
const ids = (x: unknown) => Array.isArray(x) ? [...new Set(x.slice(0, 256).map((v) => id(v, 'Choose people')))] : fail(400, 'Choose people');

/** Plain sentences for the database's refusals (Postgres errors carrying our own message). */
async function plain<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const err = e as { code?: string; message?: string; statusCode?: number };
    if (err.statusCode) throw e;
    const status = ({ '42501': 403, '22023': 400, '23505': 409, P0002: 404, '28000': 401, '54000': 429 } as Record<string, number>)[err.code ?? ''];
    if (status) fail(status, String(err.message ?? 'Not possible'));
    throw e;
  }
}

/** How the client joins: a new organisation from the details (default), one they run, or as an individual. */
function joinChoice(b: Body) {
  const mode = ['new', 'existing', 'individual'].includes(String(b.mode)) ? String(b.mode) : 'new';
  const key = text(b.pack, 40);
  const pack = mode === 'new' && key ? PACK.get(key) ?? fail(400, 'Choose an industry pack') : null;
  return { mode, orgName: text(b.orgName, 80), orgHandle: text(b.orgHandle, 40), org: mode === 'existing' ? id(b.org, 'Choose one of your organisations') : null, pack: pack ? packPayload(pack) : null,
    // CLIENT-PORTAL: the client's yes to seeing past conversations with the inviting organisation (imported history).
    history: b.history === 'yes' || b.history === true ? 'yes' : 'no' };
}

/** Where the client link points: a company's own address when it has one, else the address the inviter is using (the
 *  shared Pulse, pulse-dev, a local run), so a link made on pulse-dev opens pulse-dev. */
export function linkOrigin(req: FastifyRequest) {
  const company = requestCompany();
  const raw = String(req.headers['x-pulse-host'] ?? '').trim().toLowerCase();
  // A company's own address keeps its own origin. A session switched into another organisation on the shared address
  // (company set, but the address is the install's) stays on the address the inviter is on (E2E-4P: pulse-dev links
  // pointed at production for every organisation but the install's).
  const ownAddress = !!company?.company && !!company.hostOrg && company.hostOrg !== company.installOrg;
  if (ownAddress || !/^[a-z0-9.-]{3,253}(:\d{2,5})?$/.test(raw)) return companyOrigin();
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(raw) ? `http://${raw}` : `https://${raw}`;
}

type Moved = Record<string, unknown>;
const moved = (r: Moved, token: string) => ({ org: String(r.org), name: String(r.name), handle: (r.handle as string) ?? null, kind: String(r.kind ?? 'staff'), token,
  hostOwn: requestCompany()?.hostOrg === r.org, home: typeof r.home === 'string' && r.home.startsWith('/') ? r.home : '/connections', connection: r.connection ?? null, newOrg: r.newOrg === true });

export function registerConnectRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const allow = (req: FastifyRequest, key: string, limit: number) => open(async (c) => (await c.query('select pulse.auth_allow($1,$2) ok', [sessionHash(key + ':' + authIp(req)), limit])).rows[0].ok as boolean);

  // This organisation's connections (anyone on the team), its client requests (admins, HR, leadership) and, for making
  // groups, the team to choose from.
  app.get('/api/v0/connections', (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Connections belong to a person of the organisation');
    const canInvite = (await c.query("select pulse.viewer_is('admin','leadership','hr') ok")).rows[0].ok as boolean;
    return {
      connections: (await c.query('select pulse.connect_list() l')).rows[0].l,
      requests: canInvite ? (await c.query('select pulse.connect_request_list() l')).rows[0].l : null,
      canInvite, me: v.person,
      team: (await c.query("select p.id,p.display_name name from pulse.person p where p.side='staff' and p.status='active' and p.id in (select id from pulse.work_people()) order by p.display_name limit 400")).rows,
      // SIM-CLIENTS R138: the AI employees a new group may have from the start (the project coordinator, say).
      ai: (await c.query("select p.id,p.display_name name from pulse.person p join pulse.agent_member m on m.person_id=p.id where p.status='active' and m.disabled_at is null order by p.display_name limit 50")).rows,
    };
  }));
  // Groups shared with me from other organisations, for my Chats list.
  app.get('/api/v0/connections/shared-chats', (req) => tx(req, async (c, v) => ({ chats: v.person ? (await c.query('select pulse.connect_shared_chats() l')).rows[0].l : [] })));

  // A client request: the link is shown once, with the e-mail it would send (the dev mail is a sink; nothing is sent).
  app.post<{ Body: Body }>('/api/v0/connections/requests', { schema: { body } }, (req) => tx(req, async (c) => {
    const token = secret(); const b = req.body;
    const r = await plain(async () => (await c.query('select pulse.connect_request_create($1,$2) r', [JSON.stringify({ company: text(b.company, 80), contact: text(b.contact, 120),
      email: text(b.email, 254), phone: text(b.phone, 40), project: text(b.project, 160), summary: text(b.summary, 2000), kind: text(b.kind, 10) || 'client', role: text(b.role, 80), poc: b.poc ? id(b.poc, 'Choose a point of contact') : null }), sessionHash(token)])).rows[0].r);
    const url = new URL('/invited', linkOrigin(req)); url.hash = token;
    const first = text(b.contact, 120).trim().split(/\s+/)[0] || 'there';
    return { ...r, link: url.href, warning: 'Shown once. Anyone with the link can accept for the client: send it to them privately.',
      email: { to: text(b.email, 254) || null, sent: false, why: 'Pulse mail is in sink mode here: nothing is sent. Copy the link or let the client scan the code.',
        subject: `${r.org} invites ${text(b.company, 80)} to Pulse`,
        body: `Hi ${first},\n\n${r.org} uses Pulse to work with clients. We have set up a shared space for ${text(b.project, 160) || 'our work together'}: open the link to accept, sign in or create your Pulse account, and set up ${text(b.company, 80)} in one step.\n\n${url.href}\n\nYour point of contact: ${r.poc}.` } };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/connections/requests/:id/revoke', (req) => tx(req, async (c) => {
    await plain(() => c.query('select pulse.connect_request_revoke($1)', [id(req.params.id)])); return { requests: (await c.query('select pulse.connect_request_list() l')).rows[0].l };
  }));

  // Shared work: a group with the other organisation's people, and a task for one of their contacts.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/groups', { schema: { body } }, (req) => tx(req, async (c) => plain(async () =>
    ({ id: (await c.query('select pulse.connect_group_create($1,$2,$3) id', [id(req.params.id), text(req.body.name, 60), ids(req.body.memberIds)])).rows[0].id }))));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/tasks', { schema: { body } }, (req) => tx(req, async (c) => {
    const title = text(req.body.title, 300).trim(); if (title.length < 2) fail(400, 'Name the task');
    const due = String(req.body.dueOn ?? ''); if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) fail(400, 'Choose a valid due date');
    return plain(async () => ({ id: (await c.query('select pulse.connect_task_give($1,$2) id', [id(req.params.id), JSON.stringify({ title, notes: text(req.body.notes, 4000), dueOn: due || null, assigneeId: id(req.body.assigneeId, 'Choose their contact') })])).rows[0].id }));
  }));

  // Points of contact: admins, HR and leadership add people of their own team (each gets a seat in the other
  // organisation) or remove them (the seat ends; a side keeps at least one contact).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/contacts', { schema: { body } }, (req) => tx(req, async (c) => plain(async () =>
    ({ seat: (await c.query('select pulse.connect_contact_add($1,$2) id', [id(req.params.id), id(req.body.person, 'Choose someone from your team')])).rows[0].id }))));
  app.post<{ Params: { id: string; seatId: string } }>('/api/v0/connections/:id/contacts/:seatId/remove', (req) => tx(req, async (c) => plain(async () => {
    await c.query('select pulse.connect_contact_remove($1,$2)', [id(req.params.id), id(req.params.seatId, 'Choose a contact')]); return { ok: true };
  })));
  // CONNECT 2: end a connection (admins, HR or leadership on either side): every contact's seat ends; shared groups and
  // tasks stay where they live (0986).
  app.post<{ Params: { id: string } }>('/api/v0/connections/:id/end', (req) => tx(req, async (c) => plain(async () => {
    await c.query('select pulse.connect_end($1)', [id(req.params.id)]); return { ok: true };
  })));

  // Signed in: accept a client link with this account. Answers with a session of the organisation to open next.
  app.post<{ Body: Body }>('/api/v0/account/connect-accept', { schema: { body } }, async (req) => {
    if (!await allow(req, 'connect-accept', 20)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    return tx(req, async (c, v) => {
      if (!v.person || v.nativeDevice) fail(403, 'Accept from your browser account');
      const link = text(req.body.token, 64); if (!TOKEN.test(link)) fail(400, 'This client link is unavailable');
      const token = secret();
      const r = await plain(async () => (await c.query('select pulse.connect_accept($1,$2,$3,$4) r', [sessionHash(link), JSON.stringify(joinChoice(req.body)), sessionHash(token), device(req)])).rows[0].r);
      if (!r) fail(403, 'Your place in that organisation is not active');
      return moved(r, token);
    });
  });
  // Signed out: what the link is for, then a new Pulse account that accepts it.
  app.post<{ Body: Body }>('/api/v0/auth/connect-peek', { schema: { body } }, async (req) => {
    if (!await allow(req, 'connect-peek', 30)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const link = text(req.body.token, 64); if (!TOKEN.test(link)) fail(404, 'This client link is no longer open');
    const r = await open(async (c) => (await c.query('select pulse.connect_peek($1) r', [sessionHash(link)])).rows[0].r);
    return r ?? fail(404, 'This client link is no longer open. Ask for a new one.');
  });
  app.post<{ Body: Body }>('/api/v0/auth/connect-join', { schema: { body } }, async (req) => {
    if (!await allow(req, 'connect-join', 10)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const link = text(req.body.token, 64); if (!TOKEN.test(link)) fail(404, 'This client link is no longer open');
    const password = text(req.body.password, 200); const problem = passwordError(password); if (problem) fail(400, problem);
    const token = secret();
    const r = await open(async (c) => plain(async () => (await c.query('select pulse.connect_join($1,$2,$3,$4) r', [sessionHash(link),
      JSON.stringify({ name: text(req.body.name, 120), handle: text(req.body.handle, 40), email: text(req.body.email, 254), password, ...joinChoice(req.body) }), sessionHash(token), device(req)])).rows[0].r));
    if (!r) fail(403, 'Your place in that organisation is not active');
    return { ...moved(r, token), maxAge: 2592000 };
  });
}
