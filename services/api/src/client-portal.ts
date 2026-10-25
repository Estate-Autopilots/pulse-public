// CLIENT-PORTAL (owner, 25 Oct 2026): client login and the client's space (db/migrations/1020_client_portal_access.sql).
//
// The serving organisation's side (admins, HR, leadership; Finance for documents):
//   GET  /api/v0/client-access                   every client record with its access to Pulse (none, invited, on Pulse)
//   POST /api/v0/client-access/invite            invite one or many client records (links shown; e-mailed only when asked)
//   POST /api/v0/client-access/requests/:id/revoke
//   GET  /api/v0/clients/:id/access              one client's access, people, onboarding steps
//   POST /api/v0/clients/:id/access/person       one more person at a client already on Pulse (their own link)
//   POST /api/v0/clients/:id/onboarding          tick or untick an onboarding step
//   POST /api/v0/clients/:id/kickoff             send the kickoff checklist (tasks for the client, in their space)
//   GET|POST /api/v0/erp/documents/:id/share     share an issued quotation/proforma/invoice into the client's space
// The client's side (their seat in the serving organisation; routes.ts lets a client seat reach /client-portal):
//   GET  /api/v0/client-portal                   their space in one read (pulse.cp_home)
//   GET  /api/v0/client-portal/documents/:id/pdf
//   POST /api/v0/client-portal/documents/:id/answer   accept (typed name), ask for changes (what), decline
//   POST /api/v0/client-portal/requests          ask for something: a task for their point of contact
//   POST /api/v0/client-portal/chat              their group with the team (made on first use)
//   POST /api/v0/client-portal/history           yes or no to past conversations
//   POST /api/v0/client-portal/colleagues        a link for a colleague
// Nothing reaches a real client unless a person presses Invite and asks for the e-mail; links are shown once.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { authMail, authMailAvailable } from './auth-mail.js';
import { linkOrigin } from './connect.js';
import { fail, sessionHash, type Tx } from './routes.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown, what = 'Choose a valid record') => UUID.test(String(x)) ? String(x) : fail(400, what);
const text = (x: unknown, max = 200) => String(x ?? '').slice(0, max);
const secret = () => randomBytes(32).toString('base64url');
const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The default kickoff checklist for a marketing client (the team edits it before sending). */
export const KICKOFF = [
  { title: 'Share your logo and brand files', notes: 'Logo (vector or high resolution), brand colours and fonts, any brand guide.' },
  { title: 'Share the project details', notes: 'Project name, location, configurations, price range, amenities, RERA number, brochure and floor plans.' },
  { title: 'Give access to your ad accounts and pages', notes: 'Meta Business Manager, Google Ads, Instagram and Facebook pages, website or landing page logins.' },
  { title: 'Tell us who approves creatives', notes: 'Name and phone of the person who approves designs and videos, and how fast they can reply.' },
  { title: 'Pick a time for the kickoff call', notes: 'A 30-minute call with your team: goals, timeline and how we will work together.' },
];

/** Plain sentences for the database's refusals (Postgres errors carrying our own message), like connect.ts. */
async function plain<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const err = e as { code?: string; message?: string; statusCode?: number };
    if (err.statusCode) throw e;
    const status = ({ '42501': 403, '22023': 400, '23505': 409, P0002: 404, '28000': 401, '54000': 429 } as Record<string, number>)[err.code ?? ''];
    if (status) fail(status, String(err.message ?? 'Not possible'));
    throw e;
  }
}

/** The invitation e-mail, in the client's words. */
export function inviteMail(r: { org: string; contact: string; company: string; poc?: string | null }, link: string, message?: string) {
  const first = r.contact.trim().split(/\s+/)[0] || 'there';
  return {
    subject: `${r.org} has set up your Pulse account`,
    body: `Hi ${first},\n\n${r.org} now works with ${r.company} on Pulse: one place for your projects, approvals, invoices, chats and calls with the team.`
      + (message ? `\n\n${message}` : '')
      + `\n\nOpen this link to make your account (it takes a minute):\n${link}\n\nThe link is only for you and works for 30 days.`
      + (r.poc ? ` Your contact at ${r.org}: ${r.poc}.` : ''),
  };
}

async function send(to: string | null, mail: { subject: string; body: string }) {
  if (!to || !MAIL.test(to)) return { sent: false, why: 'No e-mail address on this client. Copy the link or share it on WhatsApp.' };
  if (!authMailAvailable()) return { sent: false, why: 'E-mail is not switched on here: nothing was sent. Copy the link or share it on WhatsApp.' };
  const sent = await authMail(to, mail.subject, mail.body, '');
  return { sent, why: sent ? null : 'The e-mail could not be delivered. Copy the link or share it on WhatsApp.' };
}

const linkFor = (req: FastifyRequest, token: string) => { const url = new URL('/invited', linkOrigin(req)); url.hash = token; return url.href; };
const share = (link: string, r: { org: string; contact: string }) =>
  `Hi ${r.contact.trim().split(/\s+/)[0] || ''}, ${r.org} has set up your Pulse account for our work together. Open this link to start: ${link}`;

async function staff(c: PoolClient) { await plain(() => c.query('select pulse.cp_admin()')); }

export function registerClientPortalRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // ------------------------------------------------------------------------------------------- serving organisation
  app.get('/api/v0/client-access', (req) => tx(req, async (c, v) => {
    await staff(c);
    const [list, team, org] = await Promise.all([
      c.query('select pulse.client_access_list() l'),
      c.query("select p.id,p.display_name name from pulse.person p where p.side='staff' and p.status='active' and p.id in (select id from pulse.work_people()) order by p.display_name limit 400"),
      c.query('select name from pulse.org where id=pulse.current_org()'),
    ]);
    return { clients: list.rows[0].l, team: team.rows, me: v.person, org: org.rows[0]?.name ?? 'Pulse', mail: authMailAvailable() };
  }));

  app.post<{ Body: Body }>('/api/v0/client-access/invite', { schema: { body } }, (req) => tx(req, async (c) => {
    await staff(c);
    const b = req.body;
    const ids = Array.isArray(b.clientIds) ? [...new Set(b.clientIds.slice(0, 200).map((x) => id(x, 'Choose clients')))] : fail(400, 'Choose clients');
    if (!ids.length) fail(400, 'Choose at least one client');
    const one = ids.length === 1;
    const email = b.email === true; const message = text(b.message, 1000).trim();
    const results = [];
    for (const clientId of ids) {
      const token = secret();
      await c.query('savepoint invite');
      try {
        const r = (await c.query('select pulse.client_invite($1,$2,$3) r', [clientId, JSON.stringify({
          poc: b.poc ? id(b.poc, 'Choose a point of contact') : null, message, role: text(b.role, 80),
          ...(one ? { contactId: b.contactId ? id(b.contactId, 'Choose a contact') : null, contact: text(b.contact, 120), email: text(b.emailTo, 254), phone: text(b.phone, 40) } : {}),
        }), sessionHash(token)])).rows[0].r;
        await c.query('release savepoint invite');
        const link = linkFor(req, token);
        const mail = inviteMail(r, link, message);
        const delivery = email ? await send(r.email, mail) : { sent: false, why: null };
        if (delivery.sent) await c.query('select pulse.client_invite_emailed($1,$2)', [r.id, r.email]);
        results.push({ clientId, ok: true, id: r.id, name: r.client, contact: r.contact, email: r.email, phone: r.phone, poc: r.poc, link,
          whatsapp: share(link, r), mail: { to: r.email, subject: mail.subject, body: mail.body, ...delivery } });
      } catch (e) {
        await c.query('rollback to savepoint invite');
        const err = e as { message?: string; code?: string };
        if (!['42501', '22023', '23505', 'P0002'].includes(err.code ?? '')) throw e;
        results.push({ clientId, ok: false, error: String(err.message ?? 'Not possible') });
      }
    }
    return { results, warning: 'Each link is shown once. Anyone with a link can accept for that client: send it to them privately.' };
  }));

  app.post<{ Params: { id: string } }>('/api/v0/client-access/requests/:id/revoke', (req) => tx(req, async (c) => {
    await plain(() => c.query('select pulse.client_invite_revoke($1)', [id(req.params.id)])); return { ok: true };
  }));

  app.get<{ Params: { id: string } }>('/api/v0/clients/:id/access', (req) => tx(req, async (c) => {
    const clientId = id(req.params.id, 'Client not found');
    const manage = (await c.query("select pulse.viewer_is('admin','leadership','hr') ok")).rows[0].ok as boolean;
    if (!manage) return { canManage: false };
    const row = (await c.query(`select pulse.client_access_state($1) a, pulse.client_onboarding_state($1) o, pulse.client_access_contacts($1) contacts,
      (select name from pulse.org where id=pulse.current_org()) org,
      (select jsonb_build_object('id',p.id,'name',p.display_name) from pulse.client cl join pulse.person p on p.id=cl.relationship_owner_id where cl.id=$1) owner`, [clientId])).rows[0];
    const team = (await c.query("select p.id,p.display_name name from pulse.person p where p.side='staff' and p.status='active' and p.id in (select id from pulse.work_people()) order by p.display_name limit 400")).rows;
    return { canManage: true, access: row.a, onboarding: row.o, contacts: row.contacts ?? [], org: row.org, owner: row.owner, team, mail: authMailAvailable(), kickoff: KICKOFF };
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/clients/:id/access/person', { schema: { body } }, (req) => tx(req, async (c) => {
    await staff(c);
    const clientId = id(req.params.id, 'Client not found');
    const conn = (await c.query("select (pulse.client_access_state($1))->>'connectionId' c", [clientId])).rows[0].c as string | null;
    if (!conn) fail(400, 'Invite the client first');
    const token = secret(); const b = req.body;
    const r = await plain(async () => (await c.query('select pulse.client_person_invite($1,$2,$3,false) r', [conn, JSON.stringify({
      name: text(b.name, 120), email: text(b.email, 254), phone: text(b.phone, 40), message: text(b.message, 1000), contactId: b.contactId ? id(b.contactId, 'Choose a contact') : null,
    }), sessionHash(token)])).rows[0].r);
    const link = linkFor(req, token);
    const mail = inviteMail(r, link, text(b.message, 1000).trim());
    const delivery = b.sendEmail === true ? await send(r.email, mail) : { sent: false, why: null };
    if (delivery.sent) await c.query('select pulse.client_invite_emailed($1,$2)', [r.id, r.email]);
    return { id: r.id, link, whatsapp: share(link, r), mail: { to: r.email, subject: mail.subject, body: mail.body, ...delivery },
      warning: 'Shown once. Send it to the person privately.' };
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/clients/:id/onboarding', { schema: { body } }, (req) => tx(req, async (c) =>
    ({ onboarding: await plain(async () => (await c.query('select pulse.client_onboarding_tick($1,$2,$3) o', [id(req.params.id, 'Client not found'), text(req.body.step, 20), req.body.done !== false])).rows[0].o) })));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/clients/:id/kickoff', { schema: { body } }, (req) => tx(req, async (c) => {
    const items = Array.isArray(req.body.items) ? (req.body.items as Body[]).slice(0, 20).map((x) => ({ title: text(x?.title, 300), notes: text(x?.notes, 4000) })) : KICKOFF;
    const sent = await plain(async () => (await c.query('select pulse.client_kickoff_send($1,$2) n', [id(req.params.id, 'Client not found'), JSON.stringify(items)])).rows[0].n as number);
    return { sent, onboarding: (await c.query('select pulse.client_onboarding_state($1) o', [req.params.id])).rows[0].o };
  }));

  // Like every ERP read (erp.ts reader): only people who may read invoicing see whether a document is shared.
  app.get<{ Params: { id: string } }>('/api/v0/erp/documents/:id/share', (req) => tx(req, async (c) => {
    await c.query('select pulse.erp_require(false)');
    return { share: (await c.query('select pulse.client_share_state($1) s', [id(req.params.id, 'Document not found')])).rows[0].s };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/erp/documents/:id/share', { schema: { body } }, (req) => tx(req, async (c) => {
    const doc = id(req.params.id, 'Document not found');
    if (req.body.withdraw === true) await plain(() => c.query('select pulse.client_share_withdraw($1)', [doc]));
    else await plain(() => c.query('select pulse.client_share_document($1,$2)', [doc, text(req.body.note, 1000)]));
    return { share: (await c.query('select pulse.client_share_state($1) s', [doc])).rows[0].s };
  }));

  // ------------------------------------------------------------------------------------------- the client's space
  app.get('/api/v0/client-portal', (req) => tx(req, async (c) => plain(async () => (await c.query('select pulse.cp_home() h')).rows[0].h)));

  app.get<{ Params: { id: string } }>('/api/v0/client-portal/documents/:id/pdf', async (req, reply) => {
    const bytes = await tx(req, async (c) => plain(async () => (await c.query('select pulse.cp_document_file($1) b', [id(req.params.id, 'Document not found')])).rows[0].b as Buffer));
    reply.header('cache-control', 'private, no-store').header('content-disposition', 'inline; filename="document.pdf"');
    return reply.type('application/pdf').send(bytes);
  });

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/client-portal/documents/:id/answer', { schema: { body } }, (req) => tx(req, async (c) =>
    plain(async () => (await c.query('select pulse.cp_decide($1,$2,$3,$4) r', [id(req.params.id, 'Document not found'), text(req.body.decision, 20),
      text(req.body.name, 120), text(req.body.note, 2000)])).rows[0].r)));

  app.post<{ Body: Body }>('/api/v0/client-portal/requests', { schema: { body } }, (req) => tx(req, async (c) =>
    ({ id: await plain(async () => (await c.query('select pulse.cp_request($1) id', [JSON.stringify({ kind: text(req.body.kind, 20) || 'request', title: text(req.body.title, 200), body: text(req.body.body, 4000) })])).rows[0].id) })));

  app.post('/api/v0/client-portal/chat', (req) => tx(req, async (c) => ({ id: await plain(async () => (await c.query('select pulse.cp_group() id')).rows[0].id) })));

  app.post<{ Body: Body }>('/api/v0/client-portal/history', { schema: { body } }, (req) => tx(req, async (c) =>
    ({ historyOptIn: await plain(async () => (await c.query('select pulse.cp_history_opt_in($1) t', [req.body.yes === true])).rows[0].t) })));

  app.post<{ Body: Body }>('/api/v0/client-portal/colleagues', { schema: { body } }, (req) => tx(req, async (c) => {
    const conn = (await c.query('select pulse.cp_viewer_conn() c')).rows[0].c as string | null;
    if (!conn) fail(403, 'This is for clients of this organisation');
    const token = secret();
    const r = await plain(async () => (await c.query('select pulse.client_person_invite($1,$2,$3,true) r', [conn, JSON.stringify({
      name: text(req.body.name, 120), email: text(req.body.email, 254), phone: text(req.body.phone, 40) }), sessionHash(token)])).rows[0].r);
    const link = linkFor(req, token);
    return { id: r.id, link, whatsapp: `Hi ${r.contact.split(/\s+/)[0]}, I have added you to our space with ${r.org} on Pulse. Open this link to make your account: ${link}`,
      joinsOrg: r.joinsOrg === true, warning: 'Shown once. Send it to your colleague privately.' };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/client-portal/colleagues/:id/revoke', (req) => tx(req, async (c) => {
    await plain(() => c.query('select pulse.client_invite_revoke($1)', [id(req.params.id)])); return { ok: true };
  }));
}
