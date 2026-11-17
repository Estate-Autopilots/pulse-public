// CONNECTIONS part B (owner, 16-17 Nov 2026; spec: reports/CONNECT-MAP.md §3): "My connections" across every company
// and the personal space of the signed-in account, a page per connection, and what is done through one: confirm it,
// draft or link its agreement, give a task (it lands in the doer's own space), share a doc (through a guest seat), end it.
//
// As My day (my-day.ts): every seat is read in its own READ ONLY transaction, inside that organisation and as the
// account's person there (pulse.connection_here / connection_get decide what that seat may see); the API only merges
// the lists by connection id. An action runs in ONE seat the account holds (`from`, else the current one), in a write
// transaction as that person, through the database's own functions (2200), which check the side, the role and the
// status and write the audit notes. No query reads two organisations.
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { inSeat, MAX_SEATS, seatsOf, type Seat } from './my-day.js';

type Json = Record<string, unknown>;
type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const body = { type: 'object', maxProperties: 20 } as const;
const uuid = (x: unknown, what: string) => UUID.test(String(x ?? '')) ? String(x) : fail(400, what);
const str = (x: unknown, max = 400) => String(x ?? '').trim().slice(0, max);
const who = (v: Viewer) => { if (!v.person) fail(403, 'Sign in with your own account to see your connections'); return v; };

/** The database's refusals in plain words (they arrive as Postgres errors with our own message). */
function plain(e: unknown): never {
  const err = e as { code?: string; message?: string; statusCode?: number };
  if (err.statusCode) throw e;
  const status = ({ '42501': 403, '22023': 400, '23514': 400, '23505': 409, P0002: 404 } as Record<string, number>)[err.code ?? ''];
  if (status) fail(status, String(err.message ?? 'Not possible'));
  throw e;
}

export type SeatTie = { person: string; name: string; account: string; handle: string; seat: string; side: string; role: string | null; agreement: string };
export type HereData = { org: { id: string; name: string; kind: string; purpose?: string }; lead: boolean; direct: Json[]; seats: SeatTie[] };

/** Merge each seat's list: one entry per connection (the seat it is acted on from is the one where the viewer has a side);
 *  seat ties per company. Pure: tested in test/connections-mine.test.mjs. */
export function mergeMine(reads: { seat: Pick<Seat, 'org' | 'name' | 'current' | 'purpose' | 'personal'>; here: HereData | null }[]) {
  const byId = new Map<string, Json & { via: { org: string; name: string; current: boolean }[]; from: string | null }>();
  const ties: { org: string; orgName: string; people: SeatTie[] }[] = [];
  for (const { seat, here } of reads) {
    if (!here) continue;
    for (const row of here.direct ?? []) {
      const id = String(row.id);
      const via = { org: seat.org, name: seat.name, current: seat.current };
      const had = byId.get(id);
      if (!had) byId.set(id, { ...row, via: [via], from: row.mySide ? seat.org : null });
      else {
        had.via.push(via);
        if (!had.from && row.mySide) { byId.set(id, { ...row, via: had.via, from: seat.org }); }
      }
    }
    if (here.seats?.length && seat.purpose === 'work' && !seat.personal) ties.push({ org: seat.org, orgName: seat.name, people: here.seats });
  }
  const direct = [...byId.values()].sort((a, b) => String(b.since ?? '').localeCompare(String(a.since ?? '')));
  return { direct, ties };
}

/** The seat to act from: the one named (`from`), else the current one; always one of the account's own seats. */
function seatFor(seats: Seat[], from: unknown): Seat {
  if (from !== undefined && from !== null && from !== '') {
    const org = uuid(from, 'Choose where to act from');
    return seats.find((s) => s.org === org) ?? fail(403, 'You are not in that space');
  }
  return seats.find((s) => s.current) ?? fail(403, 'Open one of your spaces first');
}

export function registerConnectionsMineRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool: Pool }) {
  const mine = async (req: Parameters<Tx>[0]) => tx(req, async (c, v) => { who(v); return { seats: await seatsOf(c), actor: v.email }; });
  const act = async <T>(req: Parameters<Tx>[0], from: unknown, run: (c: PoolClient) => Promise<T>) => {
    const { seats, actor } = await mine(req);
    const seat = seatFor(seats, from);
    try { return await inSeat(pool, seat, actor, true, run); } catch (e) { plain(e); }
  };

  // My connections: every seat's connections and seat ties, merged.
  app.get('/api/v0/connections/mine', async (req) => {
    const { seats, actor } = await mine(req);
    const reads: { seat: Seat; here: HereData | null }[] = [];
    const unavailable: string[] = [];
    for (const s of seats.slice(0, MAX_SEATS)) {
      try { reads.push({ seat: s, here: await inSeat(pool, s, actor, false, async (c) => (await c.query('select pulse.connection_here() h')).rows[0]?.h as HereData | null) }); }
      catch (e) { req.log.warn({ err: e, org: s.org }, 'connections seat unavailable'); unavailable.push(s.name); }
    }
    const { direct, ties } = mergeMine(reads);
    return { generatedAt: new Date().toISOString(), direct, ties, unavailable, more: Math.max(0, seats.length - MAX_SEATS),
      spaces: seats.filter((s) => s.kind === 'staff').map((s) => ({ org: s.org, name: s.name, current: s.current, personal: s.personal, purpose: s.purpose,
        lead: reads.find((r) => r.seat.org === s.org)?.here?.lead ?? false })) };
  });

  // One connection, read from the seat that may act on it (else the first that may see it).
  app.get<{ Params: { id: string } }>('/api/v0/connections/:id/detail', async (req) => {
    const id = uuid(req.params.id, 'Choose a connection');
    const { seats, actor } = await mine(req);
    let seen: { seat: Seat; d: Json } | null = null;
    for (const s of seats.slice(0, MAX_SEATS)) {
      const d = await inSeat(pool, s, actor, false, async (c) => (await c.query('select pulse.connection_get($1) d', [id])).rows[0]?.d as Json | null).catch(() => null);
      if (!d) continue;
      if (d.mySide) { seen = { seat: s, d }; break; }
      seen ??= { seat: s, d };
    }
    if (!seen) fail(404, 'Connection not found');
    const { seat, d } = seen!;
    return { ...d, from: { org: seat.org, name: seat.name, current: seat.current, personal: seat.personal } };
  });

  // Docs of a space that I may share through this connection (the picker).
  app.get<{ Params: { id: string }; Querystring: { from?: string } }>('/api/v0/connections/:id/shareable-docs', async (req) => {
    uuid(req.params.id, 'Choose a connection');
    const { seats, actor } = await mine(req);
    const seat = seatFor(seats, req.query.from);
    const docs = await inSeat(pool, seat, actor, false, async (c) => (await c.query(`select d.id, d.title, d.updated_at "updatedAt" from pulse.doc d
      where d.archived_at is null and pulse.doc_id_can_share(d.id) order by d.updated_at desc limit 80`)).rows);
    return { docs };
  });

  // Make a connection from a space of mine (side A).
  app.post<{ Body: Body }>('/api/v0/connections/new', { schema: { body } }, (req) => act(req, req.body.from, async (c) => {
    const b = req.body;
    const p = { kind: str(b.kind, 20), orgHandle: str(b.orgHandle, 80) || undefined, accountHandle: str(b.accountHandle, 80) || undefined,
      aRole: str(b.aRole, 80) || undefined, bRole: str(b.bRole, 80) || undefined, asPerson: b.asPerson === true, note: str(b.note) || undefined, source: 'manual', status: 'active' };
    return (await c.query('select pulse.connection_make($1) r', [p])).rows[0].r;
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/confirm', { schema: { body } }, (req) => act(req, req.body.from, async (c) =>
    (await c.query('select pulse.connection_confirm($1,$2) r', [uuid(req.params.id, 'Choose a connection'), str(req.body.note) || null])).rows[0].r));

  // Draft its agreement (one, never sent), or link an agreement that exists.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/agreement', { schema: { body } }, (req) => act(req, req.body.from, async (c) => {
    const id = uuid(req.params.id, 'Choose a connection');
    if (req.body.contract) return (await c.query('select pulse.connection_agreement_link($1,$2) r', [id, uuid(req.body.contract, 'Choose an agreement')])).rows[0].r;
    return (await c.query('select pulse.connection_agreement_draft($1) r', [id])).rows[0].r;
  }));

  // Give a task across: it lands in the doer's own space.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/give', { schema: { body } }, (req) => act(req, req.body.from, async (c) => {
    const due = str(req.body.dueOn, 10);
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) fail(400, 'Choose a date');
    return (await c.query('select pulse.connection_task_give($1,$2) r', [uuid(req.params.id, 'Choose a connection'),
      { title: str(req.body.title, 300), notes: str(req.body.notes, 4000), dueOn: due || null, toHandle: str(req.body.toHandle, 80) || null }])).rows[0].r;
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/share-doc', { schema: { body } }, (req) => act(req, req.body.from, async (c) =>
    (await c.query('select pulse.connection_doc_share($1,$2,$3,$4) r', [uuid(req.params.id, 'Choose a connection'), uuid(req.body.doc, 'Choose a doc'),
      str(req.body.access, 10) || 'read', str(req.body.toHandle, 80) || null])).rows[0].r));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/unshare-doc', { schema: { body } }, (req) => act(req, req.body.from, async (c) => {
    await c.query('select pulse.connection_doc_unshare($1,$2)', [uuid(req.params.id, 'Choose a connection'), uuid(req.body.doc, 'Choose a doc')]);
    return { ok: true };
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/connections/:id/close', { schema: { body } }, (req) => act(req, req.body.from, async (c) => {
    await c.query('select pulse.connection_end($1,$2)', [uuid(req.params.id, 'Choose a connection'), str(req.body.reason) || null]);
    return { ok: true };
  }));
}
