// PULSE-HQ (owner, 23 Oct 2026): Stack Intelligence, for any organisation (0973). The tools, services, infrastructure
// and AI models a company weighs: category, use case, plan, monthly cost in USD and INR, free tier and limits, pros and
// cons, best for, a tech-radar verdict (adopt / trial / assess / hold), a status (idea → evaluating → trial → adopted →
// dropped), owner, sources with the date checked and benchmarks. Named stacks hold a set of tools with the plan and cost
// each has in that stack; a stack is shared by a private link or published to the Pulse stack directory, read only for
// everyone else, who copy it with "Use this stack". Everyone in the organisation reads, adds and edits; its leaders
// remove and share. AI employees read it through /api/v0/agent/stack (agents.ts) to recommend tools.
// Also each person's saved sheet views (filters, sorts, group-by), for Pulse HQ's sheets and this one.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 40 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
export const STACK_CATEGORIES = ['compute', 'hosting', 'ci', 'monitoring', 'llm-observability', 'device-testing', 'video-voice', 'ai-models', 'storage', 'credits', 'dev-tools', 'other'] as const;
export const STACK_VERDICTS = ['adopt', 'trial', 'assess', 'hold'] as const;
export const STACK_STATUS = ['idea', 'evaluating', 'trial', 'adopted', 'dropped'] as const;

const str = (x: unknown, max: number) => String(x ?? '').trim().slice(0, max);
const text = (x: unknown, max: number) => String(x ?? '').replace(/\r\n/g, '\n').slice(0, max);
const need = (x: unknown, max: number, what: string) => { const s = str(x, max); return s.length >= 2 ? s : fail(400, what); };
const pick = <T extends string>(x: unknown, list: readonly T[], fallback: T) => (list as readonly string[]).includes(String(x)) ? String(x) as T : fallback;
const id = (x: unknown, what = 'Not found') => UUID.test(String(x)) ? String(x) : fail(404, what);
const optPerson = (x: unknown) => x === null || x === '' || x === undefined ? null : UUID.test(String(x)) ? String(x) : fail(400, 'Choose a person');
const money = (x: unknown) => { if (x === null || x === undefined || x === '') return null; const n = Number(String(x).replace(/[,₹$\s]/g, '')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fail(400, 'Give a cost of zero or more'); };
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const person = (v: Viewer) => { if (!v.person) fail(403, 'Stack Intelligence belongs to the people of an organisation.'); return v.person; };
const lead = (v: Viewer) => { if (!leadership(v)) fail(403, 'Only the organisation’s leaders remove or share this.'); };
const ids = (x: unknown, max = 500) => Array.isArray(x) ? [...new Set(x.map(String).filter((s) => UUID.test(s)))].slice(0, max) : fail(400, 'Choose rows');
const sources = (x: unknown) => Array.isArray(x) ? x.slice(0, 12).map((s: Body) => ({ url: str(s?.url, 300), label: str(s?.label, 120), checked: /^\d{4}-\d{2}-\d{2}$/.test(String(s?.checked)) ? String(s.checked) : '' }))
  .filter((s) => /^https?:\/\/\S+$/.test(s.url)) : [];
const metrics = (x: unknown) => Array.isArray(x) ? x.slice(0, 20).map((m: Body) => ({ label: str(m?.label, 80), value: str(m?.value, 60), unit: str(m?.unit, 20) })).filter((m) => m.label) : [];
const items = (x: unknown) => Array.isArray(x) ? x.slice(0, 120).map((i: Body) => ({ toolId: UUID.test(String(i?.toolId)) ? String(i.toolId) : '', plan: str(i?.plan, 200),
  usd: money(i?.usd), inr: money(i?.inr), note: str(i?.note, 200), existing: i?.existing === true, ...(str(i?.paidBy, 120) ? { paidBy: str(i?.paidBy, 120) } : {}) })).filter((i) => i.toolId) : [];

const TOOL_COLS: Record<string, string> = { name: 'name', category: 'category', useCase: 'use_case', plan: 'plan', costUsd: 'cost_usd', costInr: 'cost_inr', freeTier: 'free_tier',
  limits: 'limits', pros: 'pros', cons: 'cons', bestFor: 'best_for', verdict: 'verdict', verdictNote: 'verdict_note', status: 'status', ownerId: 'owner_id',
  sources: 'sources', benchmark: 'benchmark', metrics: 'metrics', url: 'url' };
function toolFields(b: Body) {
  const cols: [string, unknown][] = [];
  const put = (k: string, v: unknown) => cols.push([TOOL_COLS[k], v]);
  if (has(b, 'name')) put('name', need(b.name, 80, 'Name the tool'));
  if (has(b, 'category')) put('category', pick(b.category, STACK_CATEGORIES, 'other'));
  for (const [k, max] of [['useCase', 600], ['plan', 300], ['bestFor', 300], ['verdictNote', 400]] as const) if (has(b, k)) put(k, str(b[k], max));
  for (const [k, max] of [['freeTier', 1000], ['limits', 2000], ['pros', 2000], ['cons', 2000], ['benchmark', 4000]] as const) if (has(b, k)) put(k, text(b[k], max));
  if (has(b, 'costUsd')) put('costUsd', money(b.costUsd));
  if (has(b, 'costInr')) put('costInr', money(b.costInr));
  if (has(b, 'verdict')) put('verdict', pick(b.verdict, STACK_VERDICTS, 'assess'));
  if (has(b, 'status')) put('status', pick(b.status, STACK_STATUS, 'idea'));
  if (has(b, 'ownerId')) put('ownerId', optPerson(b.ownerId));
  if (has(b, 'sources')) put('sources', JSON.stringify(sources(b.sources)));
  if (has(b, 'metrics')) put('metrics', JSON.stringify(metrics(b.metrics)));
  if (has(b, 'url')) { const u = str(b.url, 290); put('url', /^https:\/\/\S{3,}$/.test(u) ? u : null); }
  return cols;
}

const TOOLS = `select t.id, t.name, t.category, t.use_case "useCase", t.plan, t.cost_usd::float8 "costUsd", t.cost_inr::float8 "costInr", t.free_tier "freeTier", t.limits,
    t.pros, t.cons, t.best_for "bestFor", t.verdict, t.verdict_note "verdictNote", t.status, t.owner_id "ownerId", p.display_name "owner", t.sources, t.benchmark,
    t.metrics, t.url, t.sort, t.created_at "createdAt", t.updated_at "updatedAt"
  from pulse.stack_tool t left join pulse.person p on p.id = t.owner_id order by t.sort, lower(t.name)`;
const STACKS = `select s.id, s.name, s.blurb, s.items, s.sort, s.share_token "shareToken", s.shared_public "sharedPublic", s.copied_from "copiedFrom",
    s.updated_at "updatedAt", p.display_name "by" from pulse.stack_set s left join pulse.person p on p.id = s.created_by order by s.sort, s.created_at`;
export const PEOPLE = `select p.id, p.display_name "name" from pulse.person p where p.status = 'active' order by lower(p.display_name) limit 500`;

async function update(c: PoolClient, table: string, rowId: string, cols: [string, unknown][], what: string) {
  if (!cols.length) return;
  const sets = cols.map(([col], i) => `${col} = $${i + 2}`).join(', ');
  const r = await c.query(`update pulse.${table} set ${sets}, updated_at = now() where id = $1`, [rowId, ...cols.map(([, val]) => val)]);
  if (!r.rowCount) fail(404, what);
}

/** Insert a tool, or with `upsert` change the one of the same name (case-insensitive). */
async function saveTool(c: PoolClient, v: Viewer, b: Body, upsert: boolean) {
  const cols = toolFields({ ...b, name: b.name });
  if (!cols.some(([col]) => col === 'name')) fail(400, 'Name the tool');
  const names = cols.map(([col]) => col), vals = cols.map(([, val]) => val);
  const updates = cols.filter(([col]) => col !== 'name').map(([col]) => `${col} = excluded.${col}`);
  const r = await c.query(`insert into pulse.stack_tool(org_id, created_by, sort, ${names.join(', ')})
    values (pulse.current_org(), $1, coalesce((select max(sort) + 1 from pulse.stack_tool), 0), ${names.map((_, i) => `$${i + 2}`).join(', ')})
    on conflict (org_id, lower(name)) do ${upsert && updates.length ? `update set ${updates.join(', ')}, updated_at = now()` : 'nothing'}
    returning id, (xmax = 0) inserted`, [v.person, ...vals]);
  if (!r.rows[0]) fail(409, 'A tool with that name is already on the list');
  return r.rows[0] as { id: string; inserted: boolean };
}

async function reshare(c: PoolClient, v: Viewer, stackId: string) {
  const s = (await c.query('select share_token, shared_public from pulse.stack_set where id = $1', [stackId])).rows[0];
  if (s?.share_token) await c.query('select pulse.stack_share($1, $2, $3)', [stackId, s.shared_public, await viewerName(c, v)]);
}
const viewerName = async (c: PoolClient, v: Viewer) => String((await c.query('select display_name from pulse.person where id = $1', [v.person])).rows[0]?.display_name ?? '');
const orgName = async (c: PoolClient) => String((await c.query('select name from pulse.org where id = pulse.current_org()')).rows[0]?.name ?? '');
/** What this organisation already pays for (owner, 24 Oct 2026: licences are per company, so only this organisation's
 *  own spend covers a tool): its tools with status Adopted, or marked paid in any of its stacks. */
async function paidTools(c: PoolClient) {
  return (await c.query(`select t.id, lower(t.name) n from pulse.stack_tool t where t.status = 'adopted' or exists (select 1 from pulse.stack_set s,
      jsonb_array_elements(s.items) e(i) where e.i->>'toolId' = t.id::text and coalesce((e.i->>'existing')::boolean, false))`)).rows as { id: string; n: string }[];
}
/** The viewing organisation's name and the tools it already pays for (by lower-case name), for shared stacks. */
const viewerSpend = async (c: PoolClient) => ({ org: await orgName(c), covered: (await paidTools(c)).map((t) => t.n) });

/** What an AI employee reads to recommend tools: every tool not dropped, compact, and the stacks with their totals. */
export async function stackForAgent(c: PoolClient) {
  const tools = (await c.query(`select name, category, use_case "useCase", plan, cost_usd::float8 "costUsd", cost_inr::float8 "costInr", free_tier "freeTier", limits,
      pros, cons, best_for "bestFor", verdict, verdict_note "verdictNote", status, benchmark, sources from pulse.stack_tool where status <> 'dropped' order by category, sort, name`)).rows;
  const stacks = (await c.query(`select s.name, s.blurb, coalesce((select jsonb_agg(jsonb_build_object('tool', t.name, 'plan', coalesce(nullif(i->>'plan', ''), t.plan),
      'inr', coalesce((i->>'inr')::numeric, t.cost_inr), 'usd', coalesce((i->>'usd')::numeric, t.cost_usd), 'existing', coalesce((i->>'existing')::boolean, false))
      order by e.o) from jsonb_array_elements(s.items) with ordinality e(i, o) join pulse.stack_tool t on t.id::text = e.i->>'toolId'), '[]'::jsonb) tools
    from pulse.stack_set s order by s.sort, s.created_at`)).rows;
  return { about: 'Stack Intelligence: the tools this organisation weighs. verdict is a tech-radar ring (adopt, trial, assess, hold); status is where it stands (idea, evaluating, trial, adopted, dropped). Costs are per month.', tools, stacks };
}

export function registerStackRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/stack', (req) => tx(req, async (c, v) => {
    person(v);
    const [tools, stacks, people] = await Promise.all([c.query(TOOLS), c.query(STACKS), c.query(PEOPLE)]);
    return { canEdit: leadership(v), me: v.person, org: await orgName(c), tools: tools.rows, stacks: stacks.rows, people: people.rows };
  }));

  // Tools: everyone adds and edits; leaders remove.
  app.post<{ Body: Body }>('/api/v0/stack/tools', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); return saveTool(c, v, req.body, req.body.upsert === true);
  }));
  // Many at once: a pasted list or an import (upsert by name).
  app.post<{ Body: Body }>('/api/v0/stack/tools/batch', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v);
    const list = Array.isArray(req.body.items) ? req.body.items.slice(0, 300) as Body[] : fail(400, 'Give a list of tools');
    let created = 0, updated = 0; const out: string[] = [];
    for (const b of list) { const r = await saveTool(c, v, b, req.body.upsert === true); out.push(r.id); if (r.inserted) created += 1; else updated += 1; }
    return { ids: out, created, updated };
  }));
  app.post<{ Body: Body }>('/api/v0/stack/tools/bulk', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const rows = ids(req.body.ids);
    if (req.body.remove === true) { lead(v); await c.query('delete from pulse.stack_tool where id = any($1::uuid[])', [rows]); return { ok: true, n: rows.length }; }
    const patch = (req.body.patch && typeof req.body.patch === 'object' ? req.body.patch : {}) as Body;
    const cols = toolFields(Object.fromEntries(Object.entries(patch).filter(([k]) => ['category', 'verdict', 'status', 'ownerId'].includes(k))));
    if (!cols.length) fail(400, 'Choose what to change');
    const r = await c.query(`update pulse.stack_tool set ${cols.map(([col], i) => `${col} = $${i + 2}`).join(', ')}, updated_at = now() where id = any($1::uuid[])`, [rows, ...cols.map(([, x]) => x)]);
    return { ok: true, n: r.rowCount };
  }));
  app.post<{ Body: Body }>('/api/v0/stack/tools/reorder', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const rows = ids(req.body.ids, 2000);
    await c.query('update pulse.stack_tool t set sort = x.n from unnest($1::uuid[]) with ordinality as x(id, n) where t.id = x.id', [rows]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/stack/tools/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v);
    try { await update(c, 'stack_tool', id(req.params.id, 'Tool not found'), toolFields(req.body), 'Tool not found'); }
    catch (e) { if ((e as { code?: string }).code === '23505') fail(409, 'A tool with that name is already on the list'); throw e; }
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/stack/tools/:id/remove', (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query('delete from pulse.stack_tool where id = $1', [id(req.params.id, 'Tool not found')]);
    if (!r.rowCount) fail(404, 'Tool not found'); return { ok: true };
  }));

  // Stacks.
  app.post<{ Body: Body }>('/api/v0/stack/stacks', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v);
    const list = items(Array.isArray(req.body.items) ? req.body.items : Array.isArray(req.body.toolIds) ? (req.body.toolIds as unknown[]).map((t) => ({ toolId: t })) : []);
    const r = await c.query(`insert into pulse.stack_set(org_id, name, blurb, items, sort, created_by)
      values (pulse.current_org(), $1, $2, $3, coalesce((select max(sort) + 1 from pulse.stack_set), 0), $4) returning id`,
      [need(req.body.name, 80, 'Name the stack'), str(req.body.blurb, 600), JSON.stringify(list), v.person]);
    return { id: r.rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/stack/stacks/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const stackId = id(req.params.id, 'Stack not found'); const b = req.body;
    const cols: [string, unknown][] = [];
    if (has(b, 'name')) cols.push(['name', need(b.name, 80, 'Name the stack')]);
    if (has(b, 'blurb')) cols.push(['blurb', str(b.blurb, 600)]);
    if (has(b, 'items')) cols.push(['items', JSON.stringify(items(b.items))]);
    await update(c, 'stack_set', stackId, cols, 'Stack not found');
    await reshare(c, v, stackId);
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/stack/stacks/:id/remove', (req) => tx(req, async (c, v) => {
    lead(v); const stackId = id(req.params.id, 'Stack not found');
    await c.query('select pulse.stack_unshare($1)', [stackId]);
    const r = await c.query('delete from pulse.stack_set where id = $1', [stackId]);
    if (!r.rowCount) fail(404, 'Stack not found'); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/stack/stacks/:id/share', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const stackId = id(req.params.id, 'Stack not found');
    if (!(await c.query('select 1 from pulse.stack_set where id = $1', [stackId])).rowCount) fail(404, 'Stack not found');
    return (await c.query('select pulse.stack_share($1, $2, $3) r', [stackId, req.body.public === true, await viewerName(c, v)])).rows[0].r;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/stack/stacks/:id/unshare', (req) => tx(req, async (c, v) => {
    lead(v); await c.query('select pulse.stack_unshare($1)', [id(req.params.id, 'Stack not found')]); return { ok: true };
  }));

  // The Pulse stack directory and shared stacks, for anyone signed in to an organisation.
  app.get('/api/v0/stack/directory', (req) => tx(req, async (c, v) => {
    person(v); return { stacks: (await c.query('select pulse.stack_directory() d')).rows[0].d, viewer: await viewerSpend(c) };
  }));
  app.get<{ Params: { token: string } }>('/api/v0/stack/shared/:token', (req) => tx(req, async (c, v) => {
    person(v); if (!TOKEN.test(req.params.token)) fail(404, 'This stack is not shared');
    const stack = (await c.query('select pulse.stack_shared($1) s', [req.params.token])).rows[0].s ?? fail(404, 'This stack is not shared');
    return { stack, viewer: await viewerSpend(c) };
  }));
  // "Use this stack": the tools this organisation does not have yet are added (by name), and the stack is created.
  // New spend is this organisation's (owner, 24 Oct 2026): a tool it already pays for (matched by its own tool id) is
  // marked paid; one the source organisation pays for is new spend here, noted "Paid by <source>".
  app.post<{ Params: { token: string }; Body: Body }>('/api/v0/stack/shared/:token/use', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); if (!TOKEN.test(req.params.token)) fail(404, 'This stack is not shared');
    type Shared = { name: string; blurb: string; orgName: string; mine: boolean; body: Body[] };
    const s: Shared = ((await c.query('select pulse.stack_shared($1) s', [req.params.token])).rows[0].s as Shared | null) ?? fail(404, 'This stack is not shared');
    const paid = new Set((await paidTools(c)).map((t) => t.id));
    const out: { toolId: string; plan: string; usd: unknown; inr: unknown; note: string; existing: boolean; paidBy?: string }[] = [];
    let added = 0, covered = 0;
    for (const t of s.body.slice(0, 120)) {
      const r = await saveTool(c, v, { name: t.name, category: t.category, useCase: t.useCase, plan: t.toolPlan ?? t.plan, costUsd: t.costUsd, costInr: t.costInr, freeTier: t.freeTier,
        limits: t.limits, pros: t.pros, cons: t.cons, bestFor: t.bestFor, verdict: t.verdict, verdictNote: t.verdictNote, status: 'evaluating', sources: t.sources,
        benchmark: t.benchmark, metrics: t.metrics, url: t.url ?? '' }, false).catch(() => null);
      const toolId = r?.id ?? (await c.query('select id from pulse.stack_tool where lower(name) = lower($1)', [String(t.name)])).rows[0]?.id;
      if (r) added += 1;
      if (!toolId) continue;
      const ours = paid.has(String(toolId)); if (ours) covered += 1;
      out.push({ toolId, plan: str(t.plan, 200), usd: t.usd ?? null, inr: t.inr ?? null, note: str(t.note, 200), existing: ours,
        ...(!ours && t.existing === true && !s.mine ? { paidBy: s.orgName } : {}) });
    }
    const name = str(req.body.name, 80) || s.name;
    const r = await c.query(`insert into pulse.stack_set(org_id, name, blurb, items, sort, copied_from, created_by)
      values (pulse.current_org(), $1, $2, $3, coalesce((select max(sort) + 1 from pulse.stack_set), 0), $4, $5) returning id`,
      [name, s.blurb, JSON.stringify(items(out)), `${s.orgName}: ${s.name}`.slice(0, 200), v.person]);
    if (!s.mine) await c.query('select pulse.stack_share_used($1)', [req.params.token]);
    return { id: r.rows[0].id, added, covered, tools: out.length };
  }));

  // Each person's saved views of a sheet (Pulse HQ's ideas and catalogue, Stack Intelligence).
  const SCOPE = /^[a-z][a-z0-9_-]{1,40}$/;
  app.get<{ Querystring: { scope?: string } }>('/api/v0/sheet-views', (req) => tx(req, async (c, v) => {
    const me = person(v); const scope = SCOPE.test(String(req.query.scope)) ? String(req.query.scope) : fail(400, 'Choose a sheet');
    return { views: (await c.query(`select id, name, body, sort from pulse.sheet_view where person_id = $1 and scope = $2 order by sort, created_at`, [me, scope])).rows };
  }));
  app.post<{ Body: Body }>('/api/v0/sheet-views', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const scope = SCOPE.test(String(req.body.scope)) ? String(req.body.scope) : fail(400, 'Choose a sheet');
    const viewBody = req.body.body && typeof req.body.body === 'object' && !Array.isArray(req.body.body) ? JSON.stringify(req.body.body) : '{}';
    if (viewBody.length > 20000) fail(400, 'That view is too large');
    const r = await c.query(`insert into pulse.sheet_view(org_id, person_id, scope, name, body, sort) values (pulse.current_org(), $1, $2, $3, $4,
      coalesce((select max(sort) + 1 from pulse.sheet_view where person_id = $1 and scope = $2), 0)) returning id`, [me, scope, str(req.body.name, 60) || 'My view', viewBody]);
    return { id: r.rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/sheet-views/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const viewId = id(req.params.id, 'View not found');
    const cols: [string, unknown][] = [];
    if (has(req.body, 'name')) cols.push(['name', str(req.body.name, 60) || 'My view']);
    if (has(req.body, 'body')) { const s = JSON.stringify(req.body.body && typeof req.body.body === 'object' ? req.body.body : {}); if (s.length > 20000) fail(400, 'That view is too large'); cols.push(['body', s]); }
    if (!cols.length) return { ok: true };
    const r = await c.query(`update pulse.sheet_view set ${cols.map(([col], i) => `${col} = $${i + 3}`).join(', ')}, updated_at = now() where id = $1 and person_id = $2`,
      [viewId, me, ...cols.map(([, x]) => x)]);
    if (!r.rowCount) fail(404, 'View not found'); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/sheet-views/:id/remove', (req) => tx(req, async (c, v) => {
    const me = person(v); const r = await c.query('delete from pulse.sheet_view where id = $1 and person_id = $2', [id(req.params.id, 'View not found'), me]);
    if (!r.rowCount) fail(404, 'View not found'); return { ok: true };
  }));
}
