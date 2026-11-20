// SELF-SERVE (owner, 4 Nov 2026): the routes around a space set up by type (db/migrations/1520_self_serve_setup.sql;
// the sign-up itself is /auth/signup-confirm with a setup, personal-accounts.ts; another space is /account/start with a
// setup, accounts.ts):
//   GET|POST /api/v0/account/about          Settings → About you: which describes you (the account's types), this space
//   POST     /api/v0/practice/clients       a professional adds a client: the record, its invitation and the e-mail
//                                           with the one-click link to their own space (nothing is sent unless asked;
//                                           the one-click key is in the e-mail only, never in the reply)
//   GET      /api/v0/appointments           upcoming and past, with the clients to book for (?client= one client)
//   POST     /api/v0/appointments           book one; POST /api/v0/appointments/:id moves it; …/:id/cancel
// The client's side: GET /api/v0/client-portal carries their appointments (client-portal.ts), and the invitation page's
// one click is /auth/connect-join with oneClick (connect.ts).
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pulseMail, pulseMailAvailable } from './auth-mail.js';
import { linkOrigin } from './connect.js';
import { fail, sessionHash, type Tx } from './routes.js';
import { practiceInviteMail, setupPlan } from './self-serve-setup.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (x: unknown, max = 200) => String(x ?? '').slice(0, max);
const id = (x: unknown, what = 'Not found') => UUID.test(String(x)) ? String(x) : fail(400, what);

/** Plain sentences for the database's refusals (as client-portal.ts). */
async function plain<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const err = e as { code?: string; message?: string; statusCode?: number };
    if (err.statusCode) throw e;
    const status = ({ '42501': 403, '22023': 400, '23505': 409, P0002: 404, '54000': 429 } as Record<string, number>)[err.code ?? ''];
    if (status) fail(status, String(err.message ?? 'Not possible'));
    throw e;
  }
}

/** The setup for a new space from the request, or a 400 (the sign-up and Start another space both use it). */
export function planFrom(raw: unknown, personName: string) {
  const plan = setupPlan((raw && typeof raw === 'object' ? raw : {}) as Body, personName);
  if ('error' in plan) fail(400, plan.error);
  return plan as Exclude<ReturnType<typeof setupPlan>, { error: string }>;
}

const inviteLink = (req: FastifyRequest, token: string) => { const url = new URL('/invited', linkOrigin(req)); url.hash = token; return url.href; };

export function registerSelfServeSpace(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/account/about', (req) => tx(req, async (c) => plain(async () => (await c.query('select pulse.account_about() a')).rows[0].a)));
  app.post<{ Body: Body }>('/api/v0/account/about', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Change this from your browser account');
    if (!Array.isArray(req.body.profiles)) fail(400, 'Choose what describes you: one or more');
    return plain(async () => (await c.query('select pulse.account_about_save($1) a', [JSON.stringify({ profiles: req.body.profiles })])).rows[0].a);
  }));

  // A professional adds a client and, when asked, e-mails them the link to their own space (the link is also shown once,
  // to share another way). The client record gets the space's first client type unless one is chosen.
  app.post<{ Body: Body }>('/api/v0/practice/clients', { schema: { body } }, async (req) => {
    const b = req.body;
    // Who may add clients is decided first (admins, HR and leadership: pulse.cp_admin), then what was sent.
    await tx(req, async (c, v) => { if (!v.person) fail(403, 'A shared login cannot add clients'); await plain(() => c.query('select pulse.cp_admin()')); });
    const name = text(b.name, 120).trim().replace(/\s+/g, ' ');
    if (name.length < 2) fail(400, 'Give the client’s name');
    const email = text(b.email, 254).trim().toLowerCase();
    if (email && !MAIL.test(email)) fail(400, 'Give a valid e-mail or leave it empty');
    const phone = text(b.phone, 40).trim();
    if (phone && !/^\+?[0-9][0-9 -]{5,20}$/.test(phone)) fail(400, 'Give a phone number such as +91 98200 00000, or leave it empty');
    const send = b.send !== false && !!email;
    const token = randomBytes(32).toString('base64url');
    const made = await tx(req, async (c, v) => {
      if (!v.person) fail(403, 'A shared login cannot add clients');
      await plain(() => c.query('select pulse.cp_admin()'));
      const type = text(b.clientType, 40) || (await c.query(`select key from pulse.record_type where entity='client' and archived_at is null and not system order by sort, label limit 1`)).rows[0]?.key || 'other';
      const clientId = (await c.query(`insert into pulse.client(org_id,display_name,client_type,email,phone,relationship_owner_id,type_basis,source,locked)
        values ($1,$2,$3,nullif($4,''),nullif($5,''),$6,'manual','manual','{display_name,client_type}') returning id`, [v.org, name, type, email, phone, v.person])).rows[0].id as string;
      await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,new_value,changed_by) values ($1,'client',$2,'created',$3,$4)`, [v.org, clientId, name, v.person]);
      const r = (await plain(async () => (await c.query('select pulse.client_invite($1,$2,$3) r', [clientId, JSON.stringify({ contact: name, email, phone, message: text(b.message, 1000) }), sessionHash(token)])).rows[0].r));
      const words = (await c.query('select words from pulse.org_pack where org_id=pulse.current_org()')).rows[0]?.words ?? {};
      return { clientId, invite: r, by: v.name ?? r.poc ?? r.org, word: String(words.client ?? 'Client') };
    });
    // The link to share (shown here, copied, put on WhatsApp) asks the client for their details. Only the e-mailed link
    // carries the key that proves the address and opens their space with one click (review, 5 Nov 2026): the key is
    // never in this reply, so the person who added the client, or anyone the shared link reaches, cannot use it.
    const link = inviteLink(req, token);
    const key = randomBytes(32).toString('base64url');
    const mail = practiceInviteMail({ org: made.invite.org, by: made.by, contact: name, link: inviteLink(req, `${token}.${key}`), message: text(b.message, 1000).trim() });
    let sent = false, why: string | null = null;
    if (send) {
      if (!pulseMailAvailable()) why = 'E-mail is not switched on here: nothing was sent. Copy the link and share it with them.';
      else { sent = await pulseMail(email, mail.subject, mail.body); if (!sent) why = 'The e-mail could not be delivered. Copy the link and share it with them.'; }
      if (sent) await tx(req, async (c) => { await c.query('select pulse.client_invite_emailed($1,$2)', [made.invite.id, email]); await c.query('select pulse.client_invite_quick_key($1,$2)', [made.invite.id, sessionHash(key)]); });
    }
    return { id: made.clientId, name, email: email || null, word: made.word, link, sent, why,
      whatsapp: `Hi ${name.split(' ')[0]}, I have set up your space on Pulse for our appointments, files, invoices and messages. Open it here: ${link}` };
  });

  app.get<{ Querystring: { client?: string } }>('/api/v0/appointments', (req) => tx(req, async (c) => plain(async () =>
    (await c.query('select pulse.appointment_list($1) l', [req.query.client ? id(req.query.client, 'Client not found') : null])).rows[0].l)));
  const save = (req: FastifyRequest<{ Body: Body; Params: { id?: string } }>) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'A shared login cannot book appointments');
    const b = req.body;
    return plain(async () => (await c.query('select pulse.appointment_save($1) a', [JSON.stringify({ id: req.params.id ? id(req.params.id, 'Appointment not found') : null,
      clientId: b.clientId ? id(b.clientId, 'Choose a client') : null, startsAt: text(b.startsAt, 40), minutes: b.minutes, place: text(b.place, 300), note: text(b.note, 1000) })])).rows[0].a);
  });
  app.post<{ Body: Body }>('/api/v0/appointments', { schema: { body } }, (req) => save(req as FastifyRequest<{ Body: Body; Params: { id?: string } }>));
  app.post<{ Body: Body; Params: { id: string } }>('/api/v0/appointments/:id', { schema: { body } }, (req) => save(req));
  app.post<{ Params: { id: string } }>('/api/v0/appointments/:id/cancel', (req) => tx(req, async (c) => plain(async () =>
    (await c.query('select pulse.appointment_cancel($1) a', [id(req.params.id, 'Appointment not found')])).rows[0].a)));
}
