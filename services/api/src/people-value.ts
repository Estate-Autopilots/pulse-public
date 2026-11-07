import type { FastifyInstance } from 'fastify';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';

/** LIFECYCLE parts 2–4: value against cost (founders and HR with the salary permission; the database decides and logs),
 *  one's own value, role seats and their holders (leadership), best-fit people for a task or project, staffing gaps. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const optId = (x: unknown) => x === undefined || x === null || x === '' ? null : id(x);
const body = { type: 'object' } as const;
const own = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account');
const month = (x: unknown) => typeof x === 'string' && /^\d{4}-\d{2}$/.test(x) ? `${x}-01` : null;
const day = (x: unknown) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;

export function registerPeopleValueRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/value', req => tx(req, async (c, v) => {
    own(v); if (!hr(v)) fail(403, 'Value and cost are for founders and HR');
    return (await c.query('select pulse.value_view($1::date) v', [month((req.query as { month?: string }).month)])).rows[0].v;
  }));
  app.get('/api/v0/value/mine', req => tx(req, async (c, v) => {
    own(v);
    return { months: ((await c.query('select pulse.value_mine(6) m')).rows[0].m as Record<string, unknown>[]).map(({ points: _p, ...m }) => { void _p; return m; }) };
  }));
  app.get('/api/v0/seats', req => tx(req, async (c, v) => {
    own(v); if (!leadership(v)) fail(403, 'Seats and holders are for leadership');
    return { seats: (await c.query('select pulse.seat_list() s')).rows[0].s };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/seats/:id', req => tx(req, async (c, v) => {
    own(v); if (!leadership(v)) fail(403, 'Seats and holders are for leadership');
    const out = (await c.query('select pulse.seat_compare($1) c', [id(req.params.id)])).rows[0].c;
    const people = (await c.query(`select p.id,p.display_name name,pp.role,p.status from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' order by p.display_name`)).rows;
    return { ...out, people };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/seats/:id/holders', { schema: { body } }, req => tx(req, async (c, v) => {
    own(v); if (!leadership(v)) fail(403, 'Leadership places people in seats');
    const b = req.body ?? {};
    return { id: (await c.query('select pulse.seat_holder_add($1,$2,$3,$4,$5) id', [id(req.params.id), id(b.personId), day(b.from), day(b.to), typeof b.note === 'string' ? b.note : null])).rows[0].id };
  }));
  // Best-fit people for a task, a project or a title being typed, each with one line of reasons.
  app.get('/api/v0/fit', req => tx(req, async (c, v) => {
    own(v);
    const q = req.query as Record<string, string | undefined>;
    const input = { task: optId(q.task), project: optId(q.project), category: q.category && /^[a-z][a-z0-9_]{1,39}$/.test(q.category) ? q.category : null,
      title: typeof q.title === 'string' ? q.title.slice(0, 200) : null, limit: Math.min(10, Math.max(1, Number(q.limit) || 5)), exclude: q.exclude ? [id(q.exclude)] : [] };
    return (await c.query('select pulse.fit_people($1) f', [input])).rows[0].f;
  }));
  app.get('/api/v0/staffing-gaps', req => tx(req, async (c, v) => {
    own(v); if (!hr(v)) fail(403, 'Staffing gaps are for leadership and HR');
    return (await c.query('select pulse.staffing_gaps() g')).rows[0].g;
  }));
}
