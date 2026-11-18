// AGREEMENTS (owner, 13 Nov 2026, P1.2): policy acceptance, the first part of the Agreements module (migration 2081).
//   GET  /api/v0/agreements/policies[?due=1]         the person's policies: the current published versions they have not
//                                                     accepted yet (each with its key terms, for the acceptance view the
//                                                     app opens on their next visit) and every version they accepted
//   POST /api/v0/agreements/policies/:id/accept {terms}   accept that exact version: the keys of every key term, ticked in
//                                                     order; refused when a newer version is published meanwhile
//   GET  /api/v0/agreements/team                     who has not accepted the current versions: a manager's own people,
//                                                     everyone for HR, leadership and admins (pulse.policy_team_status)
// AGREEMENTS round 14 Nov (migration 2091): offers from People & pay come the same way.
//   The due list also holds the offers sent to the person (their letter's words as key terms, comp.ts offersToAccept).
//   POST /api/v0/agreements/offers/:id/accept {terms}     accept the offer term by term in Pulse; the letter is drawn again
//                                                     with the acceptance and filed for the person (acceptOfferInPulse)
//   GET  /api/v0/agreements/people                   People → Agreements: every offer and where it stands, for pay
//                                                     readers, HR and founders (pulse.agreements_offers; no amounts)
// The terms are split by @pulse/invoice-doc policyTerms, the same split the screens show (T1.2.3: the pay policy HR-PEOPLE
// writes, HR's other policies). Acceptances are pulse.policy_ack rows, so HR desk's and People & pay's counts include them.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { policyTerms } from '@pulse/invoice-doc';
import { fail, type Tx, type Viewer } from './routes.js';
import { acceptOfferInPulse, offersToAccept } from './comp.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The order people meet them: pay first (the owner's example), then conduct, then the everyday ones. */
const ORDER = ['pay', 'conduct', 'leave', 'wfh', 'attendance', 'expenses', 'travel'];
const staff = (v: Viewer) => !!v.person && (v.side === undefined || v.side === 'staff');

type Due = { id: string; kind: string; title: string; version: number; body: string; publishedAt: string | null; publishedBy: string | null };

/** The ticks a person sends: the version's own term keys, every one, in order. */
export function checkTicks(sent: unknown, keys: string[], what = 'policy'): void {
  if (!Array.isArray(sent) || sent.length > 60 || sent.some((k) => typeof k !== 'string')) fail(400, 'Tick every term, then accept');
  const ticks = sent as string[];
  if (ticks.length !== keys.length || ticks.some((k, i) => k !== keys[i])) fail(409, `This ${what} changed while you were reading. Read it again, then accept.`);
}
/** The offers waiting for the viewer, as the acceptance view shows them (the letter itself stays on the server). */
const offersDue = async (c: PoolClient, v: Viewer) => (await offersToAccept(c, v)).map((o) => { const { letter, ...shown } = o; void letter; return shown; });

export function registerPolicyAcceptanceRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/agreements/policies', (req) => tx(req, async (c, v) => {
    if (!staff(v)) return { due: [], accepted: [], team: false };
    // ?due=1: only what waits (the app asks this on every visit; the Agreements page asks for everything).
    const light = (req.query as { due?: string }).due === '1';
    const active = (await c.query("select exists(select 1 from pulse.person where id = $1 and side = 'staff' and status = 'active') ok", [v.person])).rows[0].ok as boolean;
    const due = active ? (await c.query<Due>(`select d.id, d.kind, d.title, d.version, d.body, d.published_at "publishedAt", p.display_name "publishedBy"
        from pulse.policy_document d left join pulse.person p on p.id = coalesce(d.published_by, d.created_by)
        where d.status = 'published' and pulse.policy_is_current(d.id)
          and not exists (select 1 from pulse.policy_ack a where a.document_id = d.id and a.person_id = $1)
        order by array_position($2::text[], d.kind), d.kind`, [v.person, ORDER])).rows : [];
    const terms = due.map(({ body, ...d }) => ({ ...d, ...policyTerms(body) }));
    const offers = await offersDue(c, v);
    if (light) return { due: [...offers, ...terms], accepted: [], team: false };
    // Row security (0029) shows a person only their own acceptances.
    const accepted = (await c.query(`select a.document_id "documentId", d.kind, d.title, d.version, a.at, a.via, jsonb_array_length(a.terms) "terms",
        pulse.policy_is_current(d.id) "current" from pulse.policy_ack a join pulse.policy_document d on d.id = a.document_id
        where a.person_id = $1 order by a.at desc limit 100`, [v.person])).rows;
    const team = (await c.query("select pulse.viewer_is('admin','hr','leadership') or exists(select 1 from pulse.person p where p.side = 'staff' and p.status = 'active' and pulse.manages(p.id)) ok")).rows[0].ok as boolean;
    return { due: [...offers, ...terms], accepted, team };
  }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/agreements/offers/:id/accept', { schema: { body: { type: 'object', maxProperties: 4 } } }, (req) => tx(req, async (c, v) => {
    if (!staff(v)) fail(403, 'Sign in as the person the offer is for');
    if (!UUID.test(req.params.id)) fail(400, 'Choose an offer');
    const offer = (await offersToAccept(c, v)).find((o) => o.id === req.params.id) ?? fail(404, 'This offer is not waiting for your answer');
    checkTicks(req.body?.terms, offer.terms.map((t) => t.key), 'offer');
    try {
      return await acceptOfferInPulse(c, v, offer);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === '22023') fail(400, String(err.message || 'This offer can no longer be answered'));
      if (err.code === 'P0002') fail(404, 'This offer is not waiting for your answer');
      throw e;
    }
  }));

  // AGREEMENTS (owner, 14 Nov: "signed PDF in their HR documents"): the letters made in Pulse for one person (the offer,
  // its signed copy, the appointment letter, pay letters), as People & pay lists them (pulse.comp_person: pay readers and
  // the person; one access-log line). Names and dates only; each opens through /api/v0/comp/letters/:id/pdf, which seals.
  app.get<{ Params: { id: string } }>('/api/v0/agreements/people/:id/letters', (req) => tx(req, async (c) => {
    if (!UUID.test(req.params.id)) fail(404, 'Person not found');
    await c.query('savepoint letters');
    try {
      const p = (await c.query('select pulse.comp_person($1) p', [req.params.id])).rows[0].p as { letters?: { id: string; kind: string; title: string; issuedAt: string }[] | null };
      return { letters: (p.letters ?? []).map((l) => ({ id: l.id, kind: l.kind, title: l.title, issuedAt: l.issuedAt })) };
    } catch (e) {
      const code = (e as { code?: string }).code;
      // Not theirs to read, or not a staff member: nothing to list (the same page shows the rest of the documents).
      if (code === '42501' || code === 'P0002') { await c.query('rollback to savepoint letters'); return { letters: [] }; }
      throw e;
    }
  }));

  app.get('/api/v0/agreements/people', (req) => tx(req, async (c, v) => {
    if (!staff(v)) fail(403, 'HR and founders see offers');
    try {
      return (await c.query('select pulse.agreements_offers() d')).rows[0].d;
    } catch (e) {
      if ((e as { code?: string }).code === '42501') fail(403, 'HR and founders see offers');
      throw e;
    }
  }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/agreements/policies/:id/accept', { schema: { body: { type: 'object', maxProperties: 4 } } }, (req) => tx(req, async (c, v) => {
    if (!staff(v)) fail(403, 'Policies are accepted by employees');
    if (!UUID.test(req.params.id)) fail(400, 'Choose a policy');
    const d = (await c.query<{ body: string; current: boolean }>("select body, pulse.policy_is_current(id) current from pulse.policy_document where id = $1 and status = 'published'", [req.params.id])).rows[0];
    if (!d) fail(404, 'This policy is not published');
    if (!d.current) fail(409, 'HR published a newer version of this policy. Read that one.');
    const terms = policyTerms(d.body).terms;
    checkTicks(req.body?.terms, terms.map((t) => t.key));
    try {
      return (await c.query('select pulse.policy_accept($1, $2) r', [req.params.id, JSON.stringify(terms.map((t) => ({ key: t.key, title: t.title })))])).rows[0].r;
    } catch (e) {
      // Every refusal ends the request (the transaction rolls back), in plain words.
      const code = (e as { code?: string }).code;
      if (code === '40001') fail(409, 'HR published a newer version of this policy. Read that one.');
      if (code === '42501') fail(403, 'Only active employees accept policies');
      if (code === 'P0002') fail(404, 'This policy is not published');
      if (code === '22023') fail(400, 'Tick every term, then accept');
      throw e;
    }
  }));

  app.get('/api/v0/agreements/team', (req) => tx(req, async (c, v) => {
    if (!staff(v)) fail(403, 'Teams are for employees');
    return (await c.query('select pulse.policy_team_status() s')).rows[0].s;
  }));
}
