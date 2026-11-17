import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { proposal } from './ops-insights.js';
import { normalizeDoc, type SopStep } from './sop-model.js';
// INSIGHTS-2 (1082): what the redesigned Insights draws. The live client-operations facts, filtered by period, pod,
// segment and client (pulse.insight_ops, leadership and admins); the data-driven cards a loader writes straight into the
// database (a tab's cards, or a colleague's / client's own); the pattern library PATTERNS mines, with search and
// filters; the mining rounds behind "How we know"; and one click from a pattern or a card to a task or an SOP step.
// The database decides who reads what (pulse.insight_can): leaders everything, a colleague what is about them.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,79}$/;
const AREA = /^[a-z_]{2,30}$/;
const SORTS = new Set(['value', 'support', 'effect', 'recent']);
const STATUSES = new Set(['confirmed', 'candidate']);
type Q = Record<string, string | undefined>;
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the database's jsonb read

const lead = (v: Viewer) => { if (!v.person) fail(403, 'Insights need your individual employee account'); if (!leadership(v)) fail(403, 'Insights are for leadership and admins'); };
const person = (v: Viewer) => { if (!v.person) fail(403, 'Insights need your individual employee account'); };

/** The period a filter names, as the first day it covers (relative to `today`): 30d, 90d, 6m, 12m, a year (2025), or all. */
export function since(period: string | undefined, today = new Date()): string | null {
  if (!period || period === 'all') return null;
  if (/^20\d\d$/.test(period)) return `${period}-01-01`;
  const m = /^(\d{1,3})(d|m)$/.exec(period);
  if (!m) return null;
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (m[2] === 'd') d.setUTCDate(d.getUTCDate() - Math.min(Number(m[1]), 3650)); else d.setUTCMonth(d.getUTCMonth() - Math.min(Number(m[1]), 120));
  return d.toISOString().slice(0, 10);
}

/** The filters the live facts read, from the query string (unknown values are dropped, never passed on). */
export function opsFilter(q: Q, today = new Date()) {
  const p: Record<string, string> = {};
  const s = since(q.period, today); if (s) p.since = s;
  if (q.pod && /^[\p{L}\p{N} &._-]{1,40}$/u.test(q.pod)) p.pod = q.pod;
  if (q.segment && /^[\p{L}\p{N} +&._-]{1,30}$/u.test(q.segment)) p.segment = q.segment;
  if (q.client && UUID.test(q.client)) p.client = q.client;
  if (q.fresh === '1') p.fresh = '1';
  return p;
}

/** The scope a card or pattern list is about: a colleague, a client, a project or a pod. */
export function scopeOf(q: Q) {
  if (q.person && UUID.test(q.person)) return { person_id: q.person };
  if (q.client && UUID.test(q.client)) return { client_id: q.client };
  if (q.project && UUID.test(q.project)) return { project_id: q.project };
  if (q.pod && /^[\p{L}\p{N} &._-]{1,40}$/u.test(q.pod)) return { pod: q.pod };
  return null;
}

/** The pattern library's filters, from the query string. */
export function libraryFilter(q: Q) {
  const p: Record<string, unknown> = {};
  if (q.q) p.q = q.q.slice(0, 120);
  if (q.family && /^[a-z0-9_]{2,40}$/.test(q.family)) p.family = q.family;
  if (q.area && AREA.test(q.area)) p.area = q.area;
  if (q.status && STATUSES.has(q.status)) p.status = q.status;
  if (q.sort && SORTS.has(q.sort)) p.sort = q.sort;
  const min = Number(q.minValue); if (q.minValue && Number.isFinite(min) && min > 0) p.minValue = min;
  const limit = Number(q.limit); if (q.limit && Number.isFinite(limit) && limit > 0) p.limit = Math.min(200, Math.floor(limit));
  const offset = Number(q.offset); if (q.offset && Number.isFinite(offset) && offset > 0) p.offset = Math.floor(offset);
  const scope = scopeOf(q); if (scope) p.scope = scope;
  return p;
}

/** The key a pattern's or card's action is kept under (pulse.wa_insight_action's rec: [a-z0-9_-]{2,40}). */
export const actionKey = (kind: 'pattern' | 'card', id: string) => `${kind === 'pattern' ? 'p' : 'c'}-${createHash('md5').update(id).digest('hex')}`;

export function registerInsightCardRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/insights/ops', (req) => tx(req, async (c, v) => {
    lead(v); const d = (await c.query('select pulse.insight_ops($1) r', [JSON.stringify(opsFilter(req.query as Q))])).rows[0].r;
    if (!d) fail(403, 'Insights are for leadership and admins');
    return d;
  }));
  // A tab's cards (?area=) or a subject's (?person= | ?client= | ?project= | ?pod=), with what was done with each.
  app.get('/api/v0/insights/library/cards', (req) => tx(req, async (c, v) => {
    person(v); const q = req.query as Q; const p: Record<string, unknown> = {};
    const areas = (q.area ?? '').split(',').filter((a) => AREA.test(a)).slice(0, 4); if (areas.length) p.areas = areas;
    const scope = scopeOf(q); if (scope) p.scope = scope;
    const cards = (await c.query('select pulse.insight_cards($1) r', [JSON.stringify(p)])).rows[0].r as Data[];
    return { cards, actions: leadership(v) ? await actions(c, cards.map((x) => [actionKey('card', x.id), x.id] as [string, string])) : [] };
  }));
  app.get('/api/v0/insights/library/patterns', (req) => tx(req, async (c, v) => {
    person(v); const r = (await c.query('select pulse.insight_patterns($1) r', [JSON.stringify(libraryFilter(req.query as Q))])).rows[0].r as Data;
    const keys = ((r.items ?? []) as Data[]).map((x) => [actionKey('pattern', x.id), x.id] as [string, string]);
    return { ...r, actions: leadership(v) ? await actions(c, keys) : [] };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/insights/library/patterns/:id', (req) => tx(req, async (c, v) => {
    person(v); const id = ID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid pattern');
    const p = (await c.query('select pulse.insight_pattern($1) r', [id])).rows[0].r;
    if (!p) fail(404, 'This pattern is not there, or not yours to read');
    return { pattern: p, actions: leadership(v) ? await actions(c, [[actionKey('pattern', id), id]]) : [] };
  }));
  // INSIGHTS-2 (1086): a colleague's own answer times and hours (leaders anyone's; a colleague their own; else null).
  app.get<{ Params: { id: string } }>('/api/v0/insights/people/:id/answers', (req) => tx(req, async (c, v) => {
    person(v); const id = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid colleague');
    return { answers: (await c.query('select pulse.insight_person($1) r', [id])).rows[0].r };
  }));
  app.get('/api/v0/insights/library/runs', (req) => tx(req, async (c, v) => {
    lead(v); return (await c.query('select pulse.insight_runs() r')).rows[0].r;
  }));
  // One click: a pattern or a card becomes a task (mine, due in a week) or a step proposed in the onboarding SOP draft.
  app.post<{ Params: { kind: string; id: string }; Body: Record<string, unknown> }>('/api/v0/insights/library/:kind/:id/act', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    lead(v);
    const kind = req.params.kind === 'patterns' ? 'pattern' : req.params.kind === 'cards' ? 'card' : fail(404, 'Not found');
    const id = ID.test(req.params.id) ? req.params.id : fail(400, `Choose a valid ${kind}`);
    const what = req.body.kind === 'sop' ? 'sop' : req.body.kind === 'task' ? 'task' : fail(400, 'Make a task or propose an SOP step');
    let item: Data | null;
    if (kind === 'pattern') item = (await c.query('select pulse.insight_pattern($1) r', [id])).rows[0].r;
    else item = ((await c.query('select pulse.insight_cards($1) r', ['{}'])).rows[0].r as Data[]).find((x) => x.id === id) ?? null;
    if (!item) fail(404, `This ${kind} is not there`);
    const title = String(kind === 'pattern' ? (item!.action || item!.statement) : (item!.action || item!.title)).slice(0, 200);
    const why = String(kind === 'pattern' ? item!.statement : (item!.so_what ?? item!.soWhat ?? item!.title));
    const basis = kind === 'pattern' && item!.value_basis ? `\n\nValue: ${item!.value_basis}` : '';
    const rec = actionKey(kind, id);
    let ref: string;
    if (what === 'task') {
      const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      ref = (await c.query('select pulse.task_save(null,$1) id', [JSON.stringify({ title, notes: `From Insights (${kind === 'pattern' ? 'a pattern in the chats' : 'an insight card'}).\n\nWhy: ${why}${basis}`, assigneeId: v.person, dueOn: due })])).rows[0].id;
    } else {
      const d = (await c.query('select pulse.wa_company_insights(false) r')).rows[0].r as Data | null;
      if (!d) fail(403, 'Insights are for leadership and admins');
      const s = await proposal(c, d!);
      const stepId = `wa-${rec}`;
      const steps = ((s.doc?.steps ?? []) as SopStep[]).filter((x) => x.id !== stepId);
      const add = { id: stepId, kind: 'task', title: title.slice(0, 120), detail: `${title}\n\nWhy: ${why}${basis}`, phase: 'Proposed from Insights', slaHours: null, involves: [], inputs: [], outputs: [], kpis: [], links: [], next: null };
      const doc = normalizeDoc({ ...s.doc, steps: [...steps, add] });
      if ('error' in doc) fail(400, doc.error);
      await c.query('select pulse.sop_save($1,$2)', [s.id, JSON.stringify({ ...s, status: 'draft', doc: (doc as { doc: unknown }).doc, note: `Proposed: ${title}`.slice(0, 300) })]);
      ref = s.id;
    }
    await c.query('select pulse.wa_insight_action_add($1,$2,$3)', [rec, what, ref]);
    return { ok: true, kind: what, ref };
  }));
}

/** What leaders already did with these items (a task made, an SOP step proposed), each with its item's id. */
async function actions(c: { query: (q: string, v?: unknown[]) => Promise<{ rows: Data[] }> }, keys: [string, string][]) {
  if (!keys.length) return [];
  const all = ((await c.query('select pulse.wa_insight_actions() r')).rows[0].r ?? []) as Data[];
  const want = new Map(keys);
  return all.filter((a) => want.has(a.rec)).map((a) => ({ ...a, id: want.get(a.rec) }));
}
