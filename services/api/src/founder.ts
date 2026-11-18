// GAP-FOUNDER-VIEW (9 Nov 2026; MASTER-BACKLOG PW-06, PM-07): "All my companies", one founder view of every company a
// person runs, in their own personal workspace.
//
// Every request still runs in one organisation. Like My day (my-day.ts), this reads each of the signed-in account's
// seats (pulse.account_seats) in its own READ ONLY transaction, inside that organisation and as the account's person
// there: pulse.founder_today() is SECURITY INVOKER, so that organisation's row security decides every row, and it is
// null unless the person is an admin there. No query reads two organisations. The API then puts the cards together:
//  * the order is the Focus weights kept in the person's personal workspace (read there, as them), else by name;
//  * the people line names people who hold seats in two of the founder's companies, with their role in each
//    ("Head of sales here, adviser at Kite Studio"), matched by their one Pulse @handle (IDENTITY-UNIFY);
//  * a seat that fails to read is reported as unavailable, never filled from another.
// Read only: opening a company is the organisation switcher's own switch (POST /api/v0/account/switch), in the browser.
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { inSeat, markOf, MAX_SEATS, realSeat, seatsOf, type Seat } from './my-day.js';

type Json = Record<string, unknown>;
export type FocusWeight = { key: string; name: string; weight: number; sort: number };
export type SeatPerson = { handle: string; id: string; name: string; role: string | null; kind: string };
export type Elsewhere = { company: string; role: string | null; kind: string };
export type SharedPerson = { id: string; handle: string; name: string; role: string | null; kind: string; elsewhere: Elsewhere[] };
export type Card = { org: string; name: string; handle: string | null; current: boolean; mark: string | null; accent: string | null;
  weight: number | null; today: Json; people: SharedPerson[] };

/** Lower case words only, for matching a Focus company's name with an organisation's. */
export const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

/** The Focus company that names this organisation: by key = @handle, or a name that is the organisation's name or the
 *  start of it ("Vitals" → "Vitals Technologies"; "Atlas Crest / Sales X-Ray" → "Atlas Crest"). */
export function focusFor(seat: { name: string; handle: string | null }, companies: readonly FocusWeight[]): FocusWeight | null {
  const name = norm(seat.name), handle = norm(seat.handle).replace(/ /g, '');
  if (!name) return null;
  for (const c of companies) {
    if (handle && (c.key.replace(/-/g, '') === handle)) return c;
    for (const part of String(c.name).split('/').map(norm).filter(Boolean)) {
      if (part === name || name.startsWith(part + ' ') || part.startsWith(name + ' ')) return c;
    }
  }
  return null;
}

/** Cards in the founder's order: Focus weight (higher first), then Focus's own order, then the rest by name. */
export function orderCards<T extends { name: string; handle: string | null }>(cards: readonly T[], companies: readonly FocusWeight[]): (T & { weight: number | null })[] {
  const scored = cards.map((card) => { const f = focusFor(card, companies); return { card, weight: f ? f.weight : null, sort: f ? f.sort : Number.MAX_SAFE_INTEGER }; });
  scored.sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1) || a.sort - b.sort || a.card.name.localeCompare(b.card.name));
  return scored.map((s) => ({ ...s.card, weight: s.weight }));
}

/** People who hold seats in two or more of these companies, per company, with their role in each other one.
 *  The input is each company's own list (read inside it); nothing else is joined. At most `max` per company. */
export function sharedPeople(perOrg: ReadonlyMap<string, { company: string; people: readonly SeatPerson[] }>, max = 3): Map<string, SharedPerson[]> {
  const byHandle = new Map<string, { org: string; company: string; person: SeatPerson }[]>();
  for (const [org, { company, people }] of perOrg) for (const p of people) {
    if (!p.handle) continue;
    const list = byHandle.get(p.handle) ?? []; list.push({ org, company, person: p }); byHandle.set(p.handle, list);
  }
  const out = new Map<string, SharedPerson[]>();
  for (const [org] of perOrg) {
    const here: SharedPerson[] = [];
    for (const seats of byHandle.values()) {
      const mine = seats.find((s) => s.org === org);
      if (!mine || seats.length < 2) continue;
      here.push({ id: mine.person.id, handle: mine.person.handle, name: mine.person.name, role: mine.person.role, kind: mine.person.kind,
        elsewhere: seats.filter((s) => s.org !== org).map((s) => ({ company: s.company, role: s.person.role, kind: s.person.kind })) });
    }
    here.sort((a, b) => b.elsewhere.length - a.elsewhere.length || a.name.localeCompare(b.name));
    out.set(org, here.slice(0, max));
  }
  return out;
}

const who = (v: Viewer) => { if (!v.person) fail(403, 'Sign in with your own account to see your companies'); return v; };

/** One seat, read inside its own organisation as the account's person there. */
async function readSeat(c: PoolClient, s: Seat) {
  const r = (await c.query('select pulse.founder_today() d, pulse.org_kind() k')).rows[0] as { d: Json | null; k: string };
  if (r.k === 'personal') {
    // The founder's own weights, if Focus is kept here (forced row security: admins of this workspace only).
    await c.query('savepoint focus');
    try {
      const w = (await c.query('select key,name,weight,sort from pulse.focus_company order by sort, name')).rows as FocusWeight[];
      await c.query('release savepoint focus');
      return { kind: 'personal' as const, weights: w };
    } catch { await c.query('rollback to savepoint focus'); return { kind: 'personal' as const, weights: [] as FocusWeight[] }; }
  }
  if (!r.d) return { kind: 'company' as const, today: null };
  const people = ((await c.query('select pulse.founder_people() p')).rows[0].p ?? []) as SeatPerson[];
  const accent = ((await c.query('select accent from pulse.org_brand where org_id=pulse.current_org()')).rows[0]?.accent ?? null) as string | null;
  return { kind: 'company' as const, today: r.d, people, mark: await markOf(c, s.org), accent };
}

export function registerFounderRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool: Pool }) {
  app.get('/api/v0/founder', async (req) => {
    const { seats, actor } = await tx(req, async (c, v) => { who(v); return { seats: await seatsOf(c), actor: v.email }; });
    let personal: { org: string; name: string; current: boolean } | null = null;
    let weights: FocusWeight[] = [];
    const cards: Omit<Card, 'weight' | 'people'>[] = [];
    const people = new Map<string, { company: string; people: SeatPerson[] }>();
    const unavailable: string[] = [];
    for (const s of seats.slice(0, MAX_SEATS)) {
      // CONNECTIONS (2199): a test or demo company is not one of the companies this person runs.
      if (s.kind !== 'staff' || (!s.personal && !realSeat(s))) continue;
      try {
        const r = await inSeat(pool, s, actor, false, (c) => readSeat(c, s));
        if (r.kind === 'personal') { personal = { org: s.org, name: s.name, current: s.current }; weights = r.weights; continue; }
        if (!r.today) continue;
        cards.push({ org: s.org, name: s.name, handle: s.handle, current: s.current, mark: r.mark ?? null, accent: r.accent ?? null, today: r.today });
        people.set(s.org, { company: s.name, people: r.people ?? [] });
      } catch (e) {
        req.log.warn({ err: e, org: s.org }, 'founder seat unavailable');
        unavailable.push(s.name);
      }
    }
    const shared = sharedPeople(people);
    const ordered = orderCards(cards, weights).map((c) => ({ ...c, people: shared.get(c.org) ?? [] }));
    return { generatedAt: new Date().toISOString(), eligible: ordered.length >= 2, personal, weighted: weights.length > 0,
      cards: ordered, unavailable, more: Math.max(0, seats.length - MAX_SEATS) };
  });

  // PM-07: the signed-in person's own role in each company, for their profile ("Head PGS at EA · Adviser at Vitals").
  app.get('/api/v0/account/roles', (req) => tx(req, async (c, v) => {
    who(v);
    // The seat's access (owner, admin, leadership …, read inside each company by account_seat_looks, 1601) names a seat
    // that has no job title, as the cards and the switcher do.
    const r = (await c.query('select pulse.account_roles() r, pulse.account_seat_looks() l')).rows[0] as { r: Json[] | null; l: { id: string; access: string }[] | null };
    const access = new Map((r.l ?? []).map((x) => [x.id, x.access]));
    return { roles: (r.r ?? []).map((x) => ({ ...x, access: access.get(String(x.org)) ?? null })) };
  }));
}
