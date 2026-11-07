// TASKUX (owner, 2 Nov 2026): My day across every organisation of a Pulse account, and the task-planning upgrades
// (start date, Waiting for response / Revision required / On hold, repeating by rule, time targets).
//
// Every request still runs in one organisation. My day reads each of the account's seats (pulse.account_seats, from the
// signed-in person's own account) in its own READ ONLY transaction, inside that organisation and as the account's person
// there (pulse.my_day_seat is SECURITY INVOKER: that organisation's row-level security decides every row). A seat that
// fails to read is reported as unavailable, never filled from another. A quick action on an item (Done, Start, Pause)
// runs inside the item's own organisation as that person, through the same database functions as the task's page.
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const id = (x: unknown, what = 'Choose a valid record') => UUID.test(String(x)) ? String(x) : fail(400, what);
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
/** Most seats a My day reads (one transaction each). */
export const MAX_SEATS = 12;

export type Seat = { org: string; person: string; name: string; handle: string | null; kind: string; current: boolean };

/** The signed-in account's seats, the current organisation first (decided in the database from the viewer's account). */
export async function seatsOf(c: PoolClient): Promise<Seat[]> {
  return (await c.query(`select seat_org org,seat_person person,org_name name,org_handle handle,seat_kind kind,is_current current from pulse.account_seats()`)).rows as Seat[];
}

/** One transaction inside one organisation as the account's person there. Read-only unless `write`. */
export async function inSeat<T>(pool: Pool, seat: Seat, actor: string, write: boolean, run: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(write ? 'begin' : 'begin transaction read only');
    await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true),set_config('pulse.actor_account',$3,true)", [seat.org, seat.person, actor]);
    const out = await run(c);
    await c.query('commit');
    return out;
  } catch (e) { await c.query('rollback').catch(() => undefined); throw e; } finally { c.release(); }
}

/** COMPANY-MARKS: where the browser loads the seat's square logo (its version in the address, so a new one shows at
 *  once), or null when it has none. Called inside the seat's own organisation. */
export async function markOf(c: PoolClient, org: string): Promise<string | null> {
  const r = (await c.query('select version from pulse.org_brand where org_id=pulse.current_org() and mark is not null')).rows[0];
  return r ? `/api/v0/tasks/my-day/mark/${org}?v=${Number(r.version) || 1}` : null;
}

const who = (v: Viewer) => { if (!v.person) fail(403, 'Sign in with your own account to see your day'); return v; };
/** Plain words for the database's refusals (they arrive as Postgres errors with our own message). */
function plain(e: unknown): never {
  const err = e as { code?: string; message?: string; statusCode?: number };
  if (err.statusCode) throw e;
  const status = ({ '42501': 403, '22023': 400, '23514': 400, '23505': 409, P0002: 404 } as Record<string, number>)[err.code ?? ''];
  if (status) fail(status, String(err.message ?? 'Not possible'));
  throw e;
}

export function registerMyDayRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool: Pool }) {
  // My day: every seat of the account, each read inside its own organisation.
  app.get('/api/v0/tasks/my-day', async (req) => {
    const { seats, actor } = await tx(req, async (c, v) => { who(v); return { seats: await seatsOf(c), actor: v.email }; });
    const out = [];
    for (const s of seats.slice(0, MAX_SEATS)) {
      const base = { org: s.org, name: s.name, handle: s.handle, kind: s.kind, current: s.current };
      try {
        const { day, mark } = await inSeat(pool, s, actor, false, async (c) => ({ day: (await c.query('select pulse.my_day_seat() d')).rows[0].d, mark: await markOf(c, s.org) }));
        out.push(day ? { ...base, ok: true, ...day, mark } : { ...base, ok: false, mark });
      } catch (e) {
        req.log.warn({ err: e, org: s.org }, 'my-day seat unavailable');
        out.push({ ...base, ok: false });
      }
    }
    return { generatedAt: new Date().toISOString(), more: Math.max(0, seats.length - MAX_SEATS), seats: out };
  });

  // COMPANY-MARKS: a seat's own square logo (Settings → Organisation), read inside that organisation (pulse.org_brand
  // row security), for My day's company marks. Only for one of the signed-in account's own seats.
  app.get<{ Params: { org: string } }>('/api/v0/tasks/my-day/mark/:org', async (req, reply) => {
    const { seats, actor } = await tx(req, async (c, v) => { who(v); return { seats: await seatsOf(c), actor: v.email }; });
    const org = id(req.params.org, 'Choose an organisation');
    const seat = seats.find((s) => s.org === org) ?? fail(404, 'You are not in that organisation');
    const row = await inSeat(pool, seat, actor, false, async (c) => (await c.query('select mark bytes,mark_mime mime,version from pulse.org_brand where org_id=pulse.current_org() and mark is not null')).rows[0]);
    if (!row?.bytes) fail(404, 'No logo is set');
    const tag = `"mark-${org}-${row.version}"`;
    reply.header('cache-control', 'private, max-age=300, stale-while-revalidate=86400').header('etag', tag)
      .header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    return reply.type(String(row.mime ?? 'image/png')).send(row.bytes);
  });

  // A quick action on an item of My day, inside the item's organisation: Done, Start / Pause its clock.
  app.post<{ Body: Body }>('/api/v0/tasks/my-day/act', { schema: { body } }, async (req) => {
    // Signed in first: an anonymous call is refused before its body is read.
    const { seats, actor } = await tx(req, async (c, v) => { who(v); return { seats: await seatsOf(c), actor: v.email }; });
    const org = id(req.body.org, 'Choose an organisation'); const task = id(req.body.task, 'Choose a task'); const action = str(req.body.action, 12);
    if (!['done', 'start', 'pause'].includes(action)) fail(400, 'Choose Done, Start or Pause');
    const seat = seats.find((s) => s.org === org) ?? fail(404, 'You are not in that organisation');
    return inSeat(pool, seat, actor, true, async (c) => {
      try {
        if (action === 'done') return { org, ...(await c.query("select pulse.task_move($1,'done',null) r", [task])).rows[0].r };
        return { org, ...(await c.query('select pulse.task_timer_set($1,$2) r', [task, action === 'start'])).rows[0].r };
      } catch (e) { return plain(e); }
    });
  });

  // The person's own time targets in this organisation (minutes a day and a week; empty clears).
  app.post<{ Body: Body }>('/api/v0/tasks/targets', { schema: { body } }, (req) => tx(req, async (c, v) => {
    who(v);
    try { return (await c.query('select pulse.time_target_set($1) r', [JSON.stringify({ dailyMinutes: req.body.dailyMinutes ?? null, weeklyMinutes: req.body.weeklyMinutes ?? null })])).rows[0].r; }
    catch (e) { return plain(e); }
  }));

  // A task's plan: start date, finer state, the repeat rule.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/schedule', (req) => tx(req, async (c, v) => {
    who(v); const tid = id(req.params.id);
    const t = (await c.query(`select t.starts_on::text "startsOn",t.stage,t.status,(t.due_at at time zone pulse.org_time_zone())::date::text "dueOn",pulse.task_can_edit(t.id) "canEdit"
      from pulse.task t where t.id=$1`, [tid])).rows[0] ?? fail(404, 'Task not found');
    return { ...t, repeat: (await c.query('select pulse.task_repeat_get($1) r', [tid])).rows[0].r };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/schedule', { schema: { body } }, (req) => tx(req, async (c, v) => {
    who(v); const tid = id(req.params.id); const b = req.body;
    try {
      if ('startsOn' in b) await c.query('select pulse.task_plan_set($1,$2)', [tid, JSON.stringify({ startsOn: b.startsOn ? str(b.startsOn, 10) : null })]);
      if ('stage' in b) await c.query('select pulse.task_stage_set($1,$2,$3)', [tid, b.stage ? str(b.stage, 12) : null, str(b.note, 1000) || null]);
      if ('repeat' in b) {
        const r = (b.repeat ?? {}) as Body;
        await c.query('select pulse.task_repeat_rule_set($1,$2)', [tid, JSON.stringify(b.repeat === null ? { every: null } : {
          every: r.every ? str(r.every, 8) : null, interval: Number(r.interval) || 1,
          weekdays: Array.isArray(r.weekdays) ? r.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).slice(0, 7) : null,
          skipWeekends: r.skipWeekends === true, until: r.until ? str(r.until, 10) : null })]);
      }
    } catch (e) { return plain(e); }
    const t = (await c.query(`select t.starts_on::text "startsOn",t.stage,t.status from pulse.task t where t.id=$1`, [tid])).rows[0] ?? fail(404, 'Task not found');
    return { ...t, repeat: (await c.query('select pulse.task_repeat_get($1) r', [tid])).rows[0].r };
  }));
}
