import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';
import { suggestFor } from './work-domains.js';

/** TASKS-3: fill the pool from data. Pulse reads three sources and proposes pool tasks in batches (pulse.pool_batch,
 *  0186); leadership approves a batch in one click or dismisses it, and nothing is published by itself.
 *  - Drive: client projects of this or last month with a Drive folder and no finals delivered yet.
 *  - The usual steps: what most client packages in the team trackers went through (Onboarding, Scripting, Video shoot…),
 *    proposed for current packages that have no task for that step yet.
 *  - Tracker tasks nobody owns, from the last eight weeks: pooled as they are.
 *  The pool each goes to is the pod that usually does that kind of work (pods' typical work over twelve weeks). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const body = { type: 'object' } as const;
const lead = (v: Viewer) => leadership(v);
type Item = { title: string; notes?: string; category: string | null; projectId?: string | null; scope: string; ref: string | null; valuePoints?: number; estimateMinutes?: number; taskIds?: string[]; evidence: string[] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (d: string | null) => d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : 'recent';

/** Pure: of the steps the trackers' client packages went through, the usual ones (in at least a quarter of them), in
 *  their usual order. `rows` are (package key, step, first day it appeared). */
export function usualSteps(rows: { key: string; step: string; first: string | null }[], minShare = 0.25) {
  const keys = new Set(rows.map((r) => r.key)); const by = new Map<string, { n: number; rank: number[] }>();
  const perKey = new Map<string, { step: string; first: string | null }[]>();
  for (const r of rows) perKey.set(r.key, [...(perKey.get(r.key) ?? []), r]);
  for (const list of perKey.values()) { list.sort((a, b) => (a.first ?? '9999').localeCompare(b.first ?? '9999')); list.forEach((r, i) => { const s = by.get(r.step) ?? { n: 0, rank: [] }; s.n++; s.rank.push(i / Math.max(1, list.length - 1)); by.set(r.step, s); }); }
  return [...by.entries()].filter(([, s]) => keys.size && s.n / keys.size >= minShare && s.n >= 3)
    .map(([step, s]) => ({ step, share: s.n / keys.size, packages: s.n, order: s.rank.reduce((a, b) => a + b, 0) / s.rank.length })).sort((a, b) => a.order - b.order);
}

async function typicalPods(c: PoolClient) {
  const rows = (await c.query(`select t.category,pp.pod,count(*)::int n from pulse.task t join pulse.people_profile pp on pp.person_id=coalesce(t.assignee_person_id,t.owner_id)
   where t.status in ('done','accepted','in_review') and t.done_at>now()-interval '84 days' and t.category is not null and pp.pod is not null and pp.pod not in ('Leadership','Shared') group by 1,2`)).rows as { category: string; pod: string; n: number }[];
  return (category: string | null) => {
    const mine = rows.filter((r) => r.category === category); const total = mine.reduce((n, r) => n + r.n, 0); const top = mine.sort((a, b) => b.n - a.n)[0];
    return top && total >= 3 && top.n / total >= 0.5 ? { scope: 'pod', ref: top.pod, why: `${top.pod} did ${top.n} of the last ${total} tasks of this kind` } : { scope: 'company', ref: null, why: null };
  };
}

export async function generatePool(c: PoolClient, v: Viewer) {
  const podFor = await typicalPods(c);
  const guess = async (title: string) => (await c.query('select pulse.work_category_guess($1) k', [title])).rows[0].k as string | null;
  const valued = async (it: Item) => { const s = await suggestFor(c, v, { title: it.title, category: it.category, projectId: it.projectId ?? null }); return { ...it, estimateMinutes: s.effortMinutes }; }; // no value (INTEGRITY 0910)
  const current = (await c.query(`select pr.id,coalesce(pr.title,pr.name) title,pr.start_month::text "month",cl.display_name client,wp.pod,pr.storage_root is not null "drive",
    (select count(*)::int from pulse.delivery d where d.project_id=pr.id and d.kind='final') finals,(select count(*)::int from pulse.delivery d where d.project_id=pr.id and d.kind='draft') drafts,
    (select count(*)::int from pulse.task t where t.project_id=pr.id and t.status in ('open','in_progress','blocked','unknown')) open,
    array(select distinct lower(t.deliverable_type) from pulse.task t where t.project_id=pr.id and t.deliverable_type is not null) types,
    array(select distinct t.category from pulse.task t where t.project_id=pr.id and t.category is not null) cats,
    exists(select 1 from pulse.task t where t.project_id=pr.id and t.status not in ('cancelled') and t.title ~* 'final') "finalTask"
   from pulse.project pr join pulse.work_project wp on wp.project_id=pr.id left join pulse.client cl on cl.id=pr.client_id
   where pr.kind='client_work' and pr.status not in ('done','cancelled') and wp.status not in ('done','cancelled')
    and pr.start_month>=(date_trunc('month',now() at time zone ${ORG_TZ})-interval '1 month')::date order by pr.start_month desc,coalesce(pr.title,pr.name) limit 60`)).rows;
  const batches: { source: string; title: string; summary: string; items: Item[] }[] = [];
  // 1. Drive: no finals yet.
  const drive: Item[] = [];
  for (const p of current.filter((x) => x.drive && !x.finals && !x.finalTask).slice(0, 20)) {
    const pool = p.pod ? { scope: 'pod', ref: p.pod, why: `${p.title} is ${p.pod}'s client work` } : podFor('video_edit');
    drive.push(await valued({ title: `Edit and deliver the final videos for ${p.title}`, category: 'video_edit', projectId: p.id, scope: pool.scope, ref: pool.ref,
      notes: `Proposed from the Drive folders: ${p.title}${p.client ? ` (${p.client})` : ''} started ${month(p.month)} and no final has reached its folder yet.`,
      evidence: [`Drive folder for ${month(p.month)}`, p.drafts ? `${p.drafts} draft${p.drafts === 1 ? '' : 's'}, no finals yet` : 'No drafts or finals in the folder yet', `${p.open} open task${p.open === 1 ? '' : 's'} on it`, ...(pool.why ? [pool.why] : [])] }));
  }
  if (drive.length) batches.push({ source: 'drive', title: `From Drive: ${drive.length} client project${drive.length === 1 ? '' : 's'} without finals`, summary: 'Client projects of this or last month whose Drive folders show no final videos yet.', items: drive });
  // 2. The usual steps of a client package, from the tracker task groups.
  const stepRows = (await c.query(`select lower(btrim(project_key)) key,deliverable_type step,min(coalesce(work_on,(due_at at time zone ${ORG_TZ})::date,created_at::date))::text first
   from pulse.task where source='imported' and deliverable_type is not null and coalesce(btrim(project_key),'')<>'' group by 1,2`)).rows as { key: string; step: string; first: string | null }[];
  const usual = usualSteps(stepRows); const steps: Item[] = [];
  for (const p of current) {
    for (const s of usual) {
      if (steps.length >= 30) break;
      const cat = await guess(s.step);
      if (p.types.includes(s.step.toLowerCase()) || (cat && p.cats.includes(cat))) continue;
      const pool = p.pod ? { scope: 'pod', ref: p.pod, why: `${p.title} is ${p.pod}'s client work` } : podFor(cat);
      steps.push(await valued({ title: `${s.step} for ${p.title}`, category: cat, projectId: p.id, scope: pool.scope, ref: pool.ref,
        notes: `A usual step of a client package: ${Math.round(s.share * 100)}% of the ${new Set(stepRows.map((r) => r.key)).size} packages in the team trackers had it. ${p.title} has no ${s.step.toLowerCase()} task yet.`,
        evidence: [`${s.packages} of ${new Set(stepRows.map((r) => r.key)).size} tracker packages had “${s.step}”`, `No ${s.step.toLowerCase()} task for ${p.title} yet`, ...(pool.why ? [pool.why] : [])] }));
    }
  }
  if (steps.length) batches.push({ source: 'steps', title: `Usual steps: ${steps.length} task${steps.length === 1 ? '' : 's'} for current client packages`, summary: `The steps most client packages went through in the trackers (${usual.map((s) => s.step).join(', ')}), where a current package has no task for one yet.`, items: steps });
  // 3. Tracker tasks nobody owns, from the last eight weeks, pooled as they are.
  const loose = (await c.query(`select coalesce(deliverable_type,'Other work') type,array_agg(id) ids,count(*)::int n,min(title) sample from pulse.task
   where source='imported' and status in ('open','unknown') and assignee_person_id is null and owner_id is null and pool_scope is null and deleted_at is null
    and coalesce(work_on,(due_at at time zone ${ORG_TZ})::date,created_at::date)>=(now() at time zone ${ORG_TZ})::date-56 group by 1 order by 3 desc limit 12`)).rows;
  const tracker: Item[] = [];
  for (const g of loose) {
    const cat = await guess(g.type); const pool = podFor(cat);
    tracker.push({ title: `${g.n} unowned ${String(g.type).toLowerCase()} task${g.n === 1 ? '' : 's'} from the trackers`, category: cat, scope: pool.scope, ref: pool.ref, taskIds: g.ids,
      evidence: [`From the team trackers, nobody named on them`, `For example “${g.sample}”`, ...(pool.why ? [pool.why] : [])] });
  }
  if (tracker.length) batches.push({ source: 'tracker', title: `From the trackers: ${loose.reduce((n, g) => n + g.n, 0)} unowned tasks`, summary: 'Recent tracker tasks nobody is named on, pooled as they are.', items: tracker });
  const ids: string[] = [];
  for (const b of batches) { const r = (await c.query('select pulse.pool_batch_save($1) id', [JSON.stringify(b)])).rows[0].id; if (r) ids.push(r); }
  return { batches: ids.length, items: batches.reduce((n, b) => n + b.items.length, 0), usual: usual.map((s) => s.step) };
}

export function registerPoolProposalRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/work/pool/proposals', req => tx(req, async (c, v) => {
    if (!hr(v)) fail(403, 'Proposed pool work is for leadership and HR');
    const batches = (await c.query(`select b.id,b.source,b.title,b.summary,b.status,b.created_at "createdAt",cp.display_name "createdBy",b.decided_at "decidedAt",dp.display_name "decidedBy"
     from pulse.pool_batch b left join pulse.person cp on cp.id=b.created_by left join pulse.person dp on dp.id=b.decided_by
     where b.status='pending' or (b.status in ('approved','dismissed') and b.decided_at>now()-interval '14 days') order by b.status='pending' desc,b.created_at desc limit 12`)).rows;
    const items = batches.length ? (await c.query(`select x.id,x.batch_id "batchId",x.position,x.title,x.notes,x.category,wc.label "categoryLabel",x.project_id "projectId",coalesce(pr.title,pr.name) "projectName",
      x.scope,x.ref,x.estimate_minutes "estimateMinutes",cardinality(x.task_ids) tasks,x.evidence,x.status,x.published_task_id "taskId"
     from pulse.pool_proposal x left join pulse.project pr on pr.id=x.project_id left join pulse.work_category wc on wc.org_id=x.org_id and wc.key=x.category
     where x.batch_id=any($1) order by x.batch_id,x.position`, [batches.map((b) => b.id)])).rows : [];
    return { batches: batches.map((b) => ({ ...b, items: items.filter((x) => x.batchId === b.id) })), canDecide: lead(v) };
  }));
  app.post('/api/v0/work/pool/proposals/generate', req => tx(req, async (c, v) => { if (!lead(v)) fail(403, 'Leadership fills the pool'); return generatePool(c, v); }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/pool/proposals/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!lead(v)) fail(403, 'Leadership fills the pool');
    const p: Body = {}; if ('removed' in req.body) p.removed = req.body.removed === true; // value points are not taken (INTEGRITY 0910)
    await c.query('select pulse.pool_proposal_edit($1,$2)', [id(req.params.id), JSON.stringify(p)]); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/work/pool/batches/:id/approve', req => tx(req, async (c, v) => {
    if (!lead(v)) fail(403, 'Leadership approves what goes in the pool');
    return (await c.query('select pulse.pool_batch_approve($1) r', [id(req.params.id)])).rows[0].r;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/work/pool/batches/:id/dismiss', req => tx(req, async (c, v) => {
    if (!lead(v)) fail(403, 'Leadership approves what goes in the pool');
    await c.query('select pulse.pool_batch_dismiss($1)', [id(req.params.id)]); return { ok: true };
  }));
}
