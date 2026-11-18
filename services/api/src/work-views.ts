import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';
import { FROM, TASK } from './tasks.js';
import { markDomains, workSettings } from './work-domains.js';

/** TASKS-4A: views everywhere. One list of tasks for a scope (me, a pod, the company, a person, a project, the pool)
 *  that every view draws from (list, board, table, calendar, timeline, gallery; grouping, sorting and filtering happen
 *  in the browser), and each person's view preferences: the last view per place, a default, how much each view is
 *  used (to ask once "make it your default here?") and saved views. Preferences are the person's own rows (0290). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
const body = { type: 'object' } as const;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Work');
const PHOTO = (alias: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${alias}.id)`;
export const LAYOUTS = ['list', 'board', 'table', 'calendar', 'timeline', 'gallery'] as const;
export type Layout = typeof LAYOUTS[number];
export const SCOPES = ['me', 'pod', 'company', 'person', 'project', 'pool'] as const;
/** What a place opens with before anyone chose. */
export const DEFAULT_LAYOUT: Record<string, Layout> = { me: 'list', pod: 'board', company: 'table', person: 'list', project: 'list', pool: 'gallery' };
const place = (x: unknown) => { const p = str(x, 41); return /^[a-z][a-z0-9_-]{0,40}$/.test(p) ? p : fail(400, 'Choose a place'); };
const layout = (x: unknown): Layout => (LAYOUTS as readonly string[]).includes(String(x)) ? x as Layout : fail(400, 'Choose a view');
const object = (x: unknown, max = 4000) => { if (!x || typeof x !== 'object' || Array.isArray(x)) fail(400, 'Describe the view'); if (JSON.stringify(x).length > max) fail(400, 'That view is too big to keep'); return x as Body; };

type Use = { n?: number; ms?: number; d?: string; dn?: number };
/** Ask once, per view and place: when someone keeps switching to a view (on three different days) or spends most of
 *  their time in it (60% of at least ten minutes), and it is not already their default. */
export function shouldAsk(uses: Record<string, Use>, asked: Record<string, unknown>, current: Layout): Layout | null {
  const total = Object.values(uses).reduce((n, u) => n + (u.ms ?? 0), 0);
  for (const l of LAYOUTS) {
    if (l === current || asked[l]) continue;
    const u = uses[l]; if (!u) continue;
    if ((u.dn ?? 0) >= 3 || (total >= 600000 && (u.ms ?? 0) / total >= 0.6)) return l;
  }
  return null;
}

async function today(c: PoolClient) {
  return (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d,date_trunc('week',now() at time zone ${ORG_TZ})::date::text w`)).rows[0] as { d: string; w: string };
}

export function registerWorkViewRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The tasks of one scope, open ones and what finished in the last three weeks, for every view.
  app.get('/api/v0/work/list', req => tx(req, async (c, v) => {
    const q = req.query as Record<string, string | undefined>;
    const me = v.person; const day = await today(c);
    await c.query('select pulse.project_category_ensure()');
    const scope = (SCOPES as readonly string[]).includes(String(q.scope)) ? String(q.scope) : me ? 'me' : 'company';
    const pods = (await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map((r) => r.name as string);
    const myPod = me ? (await c.query('select pod from pulse.people_profile where person_id=$1', [me])).rows[0]?.pod ?? null : null;
    const pod = q.pod && pods.includes(q.pod) ? q.pod : myPod;
    const who = scope === 'me' ? me : scope === 'person' ? id(q.person) : null;
    const project = scope === 'project' ? id(q.project) : null;
    if (scope === 'me' && !me) fail(403, 'Sign in with your own staff account to see your tasks');
    const filter = who ? 'coalesce(t.assignee_person_id,t.owner_id)=$1::uuid'
      : scope === 'pod' ? `(exists(select 1 from pulse.people_profile pp where pp.person_id=coalesce(t.assignee_person_id,t.owner_id) and pp.pod=$2)
          or (coalesce(t.assignee_person_id,t.owner_id) is null and exists(select 1 from pulse.people_profile pp where pp.person_id=t.created_by and pp.pod=$2)))`
      : scope === 'project' ? 't.project_id=$3::uuid'
      : scope === 'pool' ? 't.pool_scope is not null and t.assignee_person_id is null and t.owner_id is null and pulse.work_pool_eligible(t.pool_scope,t.pool_ref)' : 'true';
    const args = [who, pod, project];
    const typed = `($1::uuid is null or true) and ($2::text is null or true) and ($3::uuid is null or true)`;
    const open = (await c.query(`select ${TASK} from ${FROM} where ${filter} and ${typed} and t.status in ('open','in_progress','blocked','unknown')
      order by t.due_at nulls last,t.priority='urgent' desc,t.priority='high' desc,t.updated_at desc nulls last limit 700`, args)).rows;
    const finished = (await c.query(`select ${TASK} from ${FROM} where ${filter} and ${typed} and t.status in ('done','in_review','accepted')
      and coalesce(t.done_at,t.updated_at,t.work_on::timestamptz)>=now()-interval '21 days' order by coalesce(t.done_at,t.updated_at) desc nulls last limit 250`, args)).rows;
    const counts = (await c.query(`select count(*) filter(where t.status in ('open','in_progress','blocked','unknown'))::int open from ${FROM} where ${filter} and ${typed}`, args)).rows[0];
    const subject = who && scope === 'person' ? (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,${PHOTO('p')} "photoAt" from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1`, [who])).rows[0] ?? fail(404, 'Person not found') : null;
    const proj = project ? (await c.query('select pr.id,coalesce(pr.title,pr.name) name,(select wp.kind from pulse.work_project wp where wp.project_id=pr.id) kind from pulse.project pr where pr.id=$1', [project])).rows[0] ?? fail(404, 'Project not found') : null;
    const settings = await workSettings(c);
    return { scope, pod, pods, myPod, me, today: day.d, week: day.w, canAll: leadership(v) || hr(v), person: subject, project: proj, openCount: counts.open,
      truncated: open.length >= 700, rows: await markDomains(c, scope === 'me' ? me : null, [...open, ...finished]), labels: settings.labels };
  }));

  // One place's preferences, saved views and whether to ask about a default.
  app.get('/api/v0/work/views', req => tx(req, async (c, v) => {
    const me = person(v); const where = place((req.query as Body).place);
    const pref = (await c.query('select layout,default_layout "defaultLayout",config,uses,asked from pulse.work_view_pref where person_id=$1 and place=$2', [me, where])).rows[0] ?? null;
    const saved = (await c.query('select id,name,config,position from pulse.work_saved_view where person_id=$1 and place=$2 order by position,created_at', [me, where])).rows;
    const current = (pref?.defaultLayout ?? DEFAULT_LAYOUT[where] ?? 'list') as Layout;
    return { place: where, layout: pref?.layout ?? null, defaultLayout: pref?.defaultLayout ?? null, config: pref?.config ?? {}, saved, ask: pref ? shouldAsk(pref.uses, pref.asked, current) : null };
  }));
  // Remember the view (and its grouping, sorting and filters) chosen here; answer "make it your default?".
  app.post<{ Body: Body }>('/api/v0/work/views/pref', { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v); const b = req.body; const where = place(b.place);
    const l = b.layout === undefined ? null : layout(b.layout);
    const config = b.config === undefined ? null : object(b.config);
    let def: Layout | null | undefined; let asked: Body | null = null;
    if (b.answer && typeof b.answer === 'object') { const a = b.answer as Body; const al = layout(a.layout); asked = { [al]: a.yes === true ? 'yes' : 'no' }; if (a.yes === true) def = al; }
    if ('defaultLayout' in b) def = b.defaultLayout === null ? null : layout(b.defaultLayout);
    await c.query(`insert into pulse.work_view_pref(org_id,person_id,place,layout,default_layout,config,asked) values(pulse.current_org(),$1,$2,$3,$4,coalesce($5::jsonb,'{}'),coalesce($6::jsonb,'{}'))
      on conflict(org_id,person_id,place) do update set layout=coalesce($3,pulse.work_view_pref.layout),default_layout=case when $7 then $4 else pulse.work_view_pref.default_layout end,
       config=coalesce($5::jsonb,pulse.work_view_pref.config),asked=pulse.work_view_pref.asked||coalesce($6::jsonb,'{}'),updated_at=now()`,
      [me, where, l, def ?? null, config ? JSON.stringify(config) : null, asked ? JSON.stringify(asked) : null, def !== undefined]);
    return { ok: true, defaultLayout: def ?? null };
  }));
  // Time spent in a view and switches to it, so Pulse can ask once whether it should be the default here.
  app.post<{ Body: Body }>('/api/v0/work/views/use', { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v); const b = req.body; const where = place(b.place); const l = layout(b.layout);
    const ms = Math.max(0, Math.min(3600000, Math.round(Number(b.ms) || 0))), switched = b.switched === true;
    const day = (await today(c)).d;
    const row = (await c.query('select default_layout,uses,asked from pulse.work_view_pref where person_id=$1 and place=$2 for update', [me, where])).rows[0];
    const uses: Record<string, Use> = row?.uses ?? {};
    const u = uses[l] ?? {}; uses[l] = { n: (u.n ?? 0) + (switched ? 1 : 0), ms: (u.ms ?? 0) + ms, d: switched ? day : u.d, dn: (u.dn ?? 0) + (switched && u.d !== day ? 1 : 0) };
    // Only a view the person switched to becomes their last view; one opened from a link is just counted.
    await c.query(`insert into pulse.work_view_pref(org_id,person_id,place,layout,uses) values(pulse.current_org(),$1,$2,case when $5 then $3 end,$4)
      on conflict(org_id,person_id,place) do update set layout=case when $5 then $3 else pulse.work_view_pref.layout end,uses=$4,updated_at=now()`, [me, where, l, JSON.stringify(uses), switched]);
    const current = (row?.default_layout ?? DEFAULT_LAYOUT[where] ?? 'list') as Layout;
    return { ask: shouldAsk(uses, row?.asked ?? {}, current) };
  }));
  app.post<{ Body: Body }>('/api/v0/work/views/saved', { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v); const b = req.body; const where = place(b.place);
    const name = str(b.name, 60); if (!name) fail(400, 'Name the view');
    if ((await c.query('select count(*)::int n from pulse.work_saved_view where person_id=$1', [me])).rows[0].n >= 40) fail(400, 'Forty saved views is the limit: remove one first');
    return (await c.query(`insert into pulse.work_saved_view(org_id,person_id,place,name,config,position) values(pulse.current_org(),$1,$2,$3,$4,
      coalesce((select max(position)+1 from pulse.work_saved_view where person_id=$1 and place=$2),100)) returning id,name,config,position`, [me, where, name, JSON.stringify(object(b.config))])).rows[0];
  }));
  app.post<{ Params: { id: string } }>('/api/v0/work/views/saved/:id/remove', req => tx(req, async (c, v) => {
    const me = person(v);
    const n = (await c.query('delete from pulse.work_saved_view where id=$1 and person_id=$2', [id(req.params.id), me])).rowCount;
    if (!n) fail(404, 'That saved view is not yours or no longer exists');
    return { ok: true };
  }));
}
