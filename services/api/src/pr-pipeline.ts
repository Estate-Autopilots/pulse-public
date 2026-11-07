// PR-PIPELINE (owner, 6 Nov 2026; migration 1620): the continuous PR pipeline on top of PR Studio, for any company.
// Work as it happens (pulse.pr_work_event) -> milestones -> ideas (PR Studio briefs of kind 'idea') -> drafts on each
// brand's calendar with designed creatives -> approvals (draft, review, approved, posted; the client's OK when a client is
// named) -> a performance log; a proof-of-work score; and each person's weekly "what I did" report, shared only by hand.
// Brands are workspaces (company, personal, client); who sees which is decided in the database (pulse.pr_brand_see under
// forced row security), so these routes only shape and check what is sent. Nothing is posted or sent from here.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';

type Row = Record<string, unknown>;
type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (v: unknown, what: string) => UUID.test(String(v)) ? String(v) : fail(404, `${what} not found`);
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const line = (v: unknown, max: number) => v === null || v === undefined ? '' : String(v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v: unknown, max: number) => v === null || v === undefined ? '' : String(v).replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '').trim().slice(0, max);
const count = (v: unknown) => v === null || v === undefined || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 2_000_000_000 ? Number(v) : fail(400, 'Counts are whole numbers');
const KINDS = ['company', 'personal', 'client'] as const;
const INDUSTRIES = ['software', 'real_estate', 'agency', 'consulting', 'ecommerce', 'education', 'creator', 'other'] as const;
const MOVES = ['draft', 'review', 'approved', 'client_ok', 'posted'] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** PR Studio's users, or a person who works on at least one brand (a colleague on a client brand, a client approver). */
async function pipeGate(c: PoolClient) {
  const r = (await c.query(`select pulse.pr_can() or exists(select 1 from pulse.pr_brand_member m where m.person_id=pulse.current_viewer()) v`)).rows[0];
  if (r?.v !== true) fail(403, 'PR is for the company\'s admins, leadership and the people on a brand');
}
async function studioGate(c: PoolClient) {
  if ((await c.query('select pulse.pr_can() v')).rows[0]?.v !== true) fail(403, 'Only the company\'s admins and leadership change this');
}
async function savepoint<T>(c: PoolClient, f: () => Promise<T>): Promise<T | null> {
  await c.query('savepoint pr_pipe');
  try { const v = await f(); await c.query('release savepoint pr_pipe'); return v; }
  catch { await c.query('rollback to savepoint pr_pipe'); return null; }
}
/** The database's own refusals (the plan's limit, approvals out of order) come back as plain 4xx messages. */
async function db<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === '42501') fail(403, err.message ?? 'Not allowed');
    if (err.code === '53400') fail(402, err.message ?? 'Your plan does not include this');
    if (err.code === '22023' || err.code === '23514' || err.code === '22P02') fail(400, err.message ?? 'Check what was sent');
    if (err.code === 'P0002') fail(404, err.message ?? 'Not found');
    if (err.code === '23505') fail(409, 'That exists already');
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ the overview
const BRAND = `select b.id,b.kind,b.name,b.byline,b.industry,b.owner_person_id "ownerPersonId",b.client_id "clientId",b.kit,b.goals,b.sources,b.posts_per_week "postsPerWeek",
  b.client_ok "clientOk",b.archived,pulse.pr_brand_role(b.id) as role,(select count(*)::int from pulse.pr_draft d where d.brand_id=b.id and d.pipeline and d.approval='review') "inReview"
  from pulse.pr_brand b`;
export async function overview(c: PoolClient) {
  await pipeGate(c);
  const studio = (await c.query('select pulse.pr_can() v')).rows[0]?.v === true;
  const settings = (await c.query(`select enabled,ai_assist "aiAssist",report_person_id "reportPersonId",hourly_value::float "hourlyValue",currency,
      last_collect_at::text "lastCollectAt",last_tick_at::text "lastTickAt" from pulse.pr_pipeline`)).rows[0] ?? null;
  const brands = (await c.query(`${BRAND} order by b.archived,b.kind,lower(b.name)`)).rows;
  // The newest score per scope, with the one from 7 days before it for the trend.
  const scores = (await c.query(`select distinct on (s.brand_id,s.person_id) s.brand_id "brandId",s.person_id "personId",p.display_name person,s.day::text as day,s.score,s.events_7d "events7d",
      s.velocity::float velocity,s.shipped_7d "shipped7d",s.hours_30d::float "hours30d",s.value_30d::float "value30d",s.streak,
      (select x.score from pulse.pr_pow_score x where x.brand_id is not distinct from s.brand_id and x.person_id is not distinct from s.person_id and x.day<=s.day-7 order by x.day desc limit 1) "scoreBefore"
    from pulse.pr_pow_score s left join pulse.person p on p.id=s.person_id order by s.brand_id,s.person_id,s.day desc`)).rows;
  const trend = (await c.query(`select day::text as day,score from pulse.pr_pow_score where brand_id is null and person_id is null and day>current_date-60 order by day`)).rows;
  const events = (await c.query(`select e.id,e.source,e.happened_at::text "happenedAt",e.title,e.detail,e.proof_url "proofUrl",e.repo,e.topic,e.hours::float as hours,e.value::float as value,
      b.name as brand,coalesce(p.display_name,nullif(e.actor,'')) person
    from pulse.pr_work_event e left join pulse.pr_brand b on b.id=e.brand_id left join pulse.person p on p.id=e.person_id order by e.happened_at desc limit 100`)).rows;
  const milestones = (await c.query(`select m.id,m.brand_id "brandId",b.name as brand,m.kind,m.title,m.started_on::text "startedOn",m.ended_on::text "endedOn",m.events,m.people,
      m.hours::float as hours,m.value::float as value,m.proof,m.shipped,m.status,m.client_named "clientNamed"
    from pulse.pr_milestone m join pulse.pr_brand b on b.id=m.brand_id order by m.updated_at desc limit 60`)).rows;
  const people = studio ? (await c.query(`select id,display_name as name from pulse.person where side='staff' and status='active' order by display_name limit 500`)).rows : [];
  const limits = studio ? (await c.query('select pulse.pr_limits() l')).rows[0].l : null;
  return { studio, settings, limits, brands, scores, trend, events, milestones, people,
    currency: settings?.currency ?? 'INR', me: (await c.query('select pulse.current_viewer() v')).rows[0].v as string | null };
}

/** For the calendar: the brand and approval state of every draft on a brand. */
export async function draftMeta(c: PoolClient) {
  await pipeGate(c);
  return (await c.query(`select d.id,d.brand_id "brandId",b.name as brand,d.approval,d.pipeline,d.needs_client_ok "needsClientOk",d.client_ok_at is not null "clientOk"
    from pulse.pr_draft d join pulse.pr_brand b on b.id=d.brand_id`)).rows;
}

// ------------------------------------------------------------------------------------------------ brands and the setup wizard
export async function wizardData(c: PoolClient, industry: string) {
  await studioGate(c);
  const ind = (INDUSTRIES as readonly string[]).includes(industry) ? industry : 'other';
  return {
    industry: ind, template: (await c.query('select pulse.pr_industry_template($1) t', [ind])).rows[0].t,
    limits: (await c.query('select pulse.pr_limits() l')).rows[0].l,
    clients: await savepoint(c, async () => (await c.query(`select id,display_name as name from pulse.client where coalesce(status,'active')<>'archived' order by display_name limit 300`)).rows) ?? [],
    projects: await savepoint(c, async () => (await c.query(`select id,coalesce(title,name) as name from pulse.project where deleted_at is null order by coalesce(title,name) limit 300`)).rows) ?? [],
    people: (await c.query(`select id,display_name as name,side from pulse.person where status='active' and side in ('staff','client','freelancer') order by side,display_name limit 500`)).rows,
  };
}
function kitOf(v: unknown): Row {
  const k = (v && typeof v === 'object' ? v : {}) as Row;
  const out: Row = {};
  for (const key of ['bg', 'fg', 'accent']) if (k[key] !== undefined) { if (!HEX.test(String(k[key]))) fail(400, 'Colours are written like #1A2B3C'); out[key] = String(k[key]).toUpperCase(); }
  if (k.font !== undefined) out.font = line(k.font, 60);
  if (k.useCompanyMark !== undefined) out.useCompanyMark = k.useCompanyMark === true;
  if (k.logoSvg !== undefined && k.logoSvg !== null && k.logoSvg !== '') {
    const svg = String(k.logoSvg);
    if (svg.length > 60000 || !/^\s*<svg[\s>]/i.test(svg) || /<script|on[a-z]+\s*=|javascript:|<foreignObject/i.test(svg)) fail(400, 'The logo is an SVG without scripts, up to 60 KB');
    out.logoSvg = svg;
  }
  return out;
}
const strings = (v: unknown, max: number, len: number) => Array.isArray(v) ? v.map((x) => line(x, len)).filter(Boolean).slice(0, max) : [];
function sourcesOf(v: unknown): Row {
  const s = (v && typeof v === 'object' ? v : {}) as Row;
  return { projects: (Array.isArray(s.projects) ? s.projects : []).filter((x) => UUID.test(String(x))).slice(0, 100).map(String),
    repos: strings(s.repos, 20, 200), reportFolders: strings(s.reportFolders, 10, 200) };
}
export async function setupBrand(c: PoolClient, b: Body) {
  await studioGate(c);
  const name = line(b.name, 80) || fail(400, 'Name the brand');
  const kind = (KINDS as readonly string[]).includes(String(b.kind)) ? String(b.kind) : 'company';
  if (kind === 'client' && !UUID.test(String(b.clientId ?? ''))) fail(400, 'Choose the client this brand is for');
  const audiences = Array.isArray(b.audiences) ? b.audiences.slice(0, 6).map((a: Row) => ({ name: line(a.name, 60), tone: String(a.tone ?? 'warm'), channel: String(a.channel ?? 'linkedin'), ratio: String(a.ratio ?? '4:5') })).filter((a) => a.name) : undefined;
  const p = { name, kind, industry: (INDUSTRIES as readonly string[]).includes(String(b.industry)) ? b.industry : 'other', byline: line(b.byline, 120),
    ownerPersonId: kind === 'personal' && UUID.test(String(b.ownerPersonId ?? '')) ? b.ownerPersonId : undefined, clientId: kind === 'client' ? b.clientId : undefined,
    kit: kitOf(b.kit), goals: strings(b.goals, 12, 200), audiences, postsPerWeek: Math.min(7, Math.max(1, Number(b.postsPerWeek) || 3)), sources: sourcesOf(b.sources),
    approvers: (Array.isArray(b.approvers) ? b.approvers : []).filter((x) => UUID.test(String(x))).slice(0, 20) };
  const brandId = (await db(() => c.query('select pulse.pr_brand_setup($1) id', [JSON.stringify(p)]))).rows[0].id as string;
  return (await c.query(`${BRAND} where b.id=$1`, [brandId])).rows[0];
}
export async function updateBrand(c: PoolClient, brandId: string, b: Body) {
  await pipeGate(c);
  const old = (await c.query(`${BRAND} where b.id=$1`, [id(brandId, 'Brand')])).rows[0] ?? fail(404, 'Brand not found');
  if (old.role !== 'manager') fail(403, 'Only a person who manages the brand changes it');
  const r = await db(() => c.query(`update pulse.pr_brand set name=$2,byline=$3,kit=$4,goals=$5,sources=$6,posts_per_week=$7,archived=$8 where id=$1 returning id`, [old.id,
    has(b, 'name') ? line(b.name, 80) || fail(400, 'Name the brand') : old.name, has(b, 'byline') ? line(b.byline, 120) : old.byline,
    JSON.stringify(has(b, 'kit') ? { ...(old.kit as Row), ...kitOf(b.kit) } : old.kit), JSON.stringify(has(b, 'goals') ? strings(b.goals, 12, 200) : old.goals),
    JSON.stringify(has(b, 'sources') ? sourcesOf(b.sources) : old.sources), has(b, 'postsPerWeek') ? Math.min(7, Math.max(1, Number(b.postsPerWeek) || 3)) : old.postsPerWeek,
    has(b, 'archived') ? b.archived === true : old.archived]));
  if (!r.rowCount) fail(403, 'Only a person who manages the brand changes it');
  return (await c.query(`${BRAND} where b.id=$1`, [old.id])).rows[0];
}
/** Add a person to a brand (manager, editor, approver) or take them off (role null). */
export async function setMember(c: PoolClient, brandId: string, b: Body) {
  await pipeGate(c);
  const brand = id(brandId, 'Brand'), person = id(b.personId, 'Person');
  if (b.role === null || b.role === '') { await c.query('delete from pulse.pr_brand_member where brand_id=$1 and person_id=$2', [brand, person]); }
  else {
    const role = ['manager', 'editor', 'approver'].includes(String(b.role)) ? String(b.role) : fail(400, 'Choose manager, editor or approver');
    await db(() => c.query(`insert into pulse.pr_brand_member(org_id,brand_id,person_id,role,added_by) select pulse.current_org(),$1,p.id,$3,pulse.current_viewer()
        from pulse.person p where p.id=$2 and p.status='active' on conflict (brand_id,person_id) do update set role=excluded.role`, [brand, person, role]));
  }
  return { members: (await c.query(`select m.person_id "personId",p.display_name as name,p.side,m.role from pulse.pr_brand_member m join pulse.person p on p.id=m.person_id where m.brand_id=$1 order by p.display_name`, [brand])).rows };
}

// ------------------------------------------------------------------------------------------------ ideas, creatives, approvals
export async function ideas(c: PoolClient, brandId?: string) {
  await pipeGate(c);
  const rows = (await c.query(`select i.id,i.day::text as day,i.title,i.body,i.hook,i.angle,i.format,i.proof,i.needs_client_ok "needsClientOk",i.brand_id "brandId",b.name as brand,
      i.milestone_id "milestoneId",i.written_by "writtenBy",i.created_at::text "createdAt"
    from pulse.pr_brief i join pulse.pr_brand b on b.id=i.brand_id where i.kind='idea' and ($1::uuid is null or i.brand_id=$1) order by i.created_at desc limit 60`,
  [brandId && UUID.test(brandId) ? brandId : null])).rows;
  const briefIds = rows.map((r) => r.id);
  const drafts = briefIds.length ? (await c.query(`select d.id,d.brief_id "briefId",d.headline,d.copy,d.long_post "longPost",d.status,d.approval,d.plan_on::text "planOn",d.format,
      d.needs_client_ok "needsClientOk",d.client_named "clientNamed",d.client_ok_at::text "clientOkAt",d.client_ok_note "clientOkNote",d.posted_at::text "postedAt",d.posted_url "postedUrl",
      (select coalesce(jsonb_agg(jsonb_build_object('recordedOn',m.recorded_on,'impressions',m.impressions,'reactions',m.reactions,'comments',m.comments,'shares',m.shares,'clicks',m.clicks) order by m.recorded_on desc),'[]')
        from pulse.pr_post_metric m where m.draft_id=d.id) metrics
    from pulse.pr_draft d where d.brief_id=any($1::uuid[])`, [briefIds])).rows : [];
  const creatives = briefIds.length ? (await c.query(`select id,brief_id "briefId",draft_id "draftId",template,slide,slides,size,theme,status,checks,checks_ok "checksOk",error,png is not null "hasImage"
    from pulse.pr_creative where brief_id=any($1::uuid[]) order by slide`, [briefIds])).rows : [];
  return { ideas: rows.map((r) => ({ ...r, draft: drafts.find((d) => d.briefId === r.id) ?? null, creatives: creatives.filter((x) => x.briefId === r.id) })) };
}
export async function moveDraft(c: PoolClient, draftId: string, b: Body) {
  await pipeGate(c);
  const to = (MOVES as readonly string[]).includes(String(b.to)) ? String(b.to) : fail(400, `Move it to one of: ${MOVES.join(', ')}`);
  const url = b.url ? String(b.url).trim() : null;
  if (url && (!/^https:\/\/\S+$/.test(url) || url.length > 500)) fail(400, 'The post link starts with https://');
  const approval = (await db(() => c.query('select pulse.pr_draft_move($1,$2,$3,$4) a', [id(draftId, 'Draft'), to, block(b.note, 500), url]))).rows[0].a;
  return { approval };
}
export async function addMetric(c: PoolClient, draftId: string, b: Body) {
  await pipeGate(c);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.recordedOn ?? '')) ? String(b.recordedOn) : (await c.query(`select (now() at time zone pulse.org_time_zone())::date::text d`)).rows[0].d;
  const r = await db(() => c.query(`insert into pulse.pr_post_metric(org_id,draft_id,recorded_on,impressions,reactions,comments,shares,clicks,followers,note,recorded_by)
      select pulse.current_org(),d.id,$2,$3,$4,$5,$6,$7,$8,$9,pulse.current_viewer() from pulse.pr_draft d where d.id=$1 and d.status='posted' returning id`,
  [id(draftId, 'Draft'), day, count(b.impressions), count(b.reactions), count(b.comments), count(b.shares), count(b.clicks), count(b.followers), line(b.note, 500)]));
  if (!r.rowCount) fail(400, 'Log numbers once the post is posted');
  return metrics(c, draftId);
}
export async function metrics(c: PoolClient, draftId: string) {
  await pipeGate(c);
  return { metrics: (await c.query(`select recorded_on::text "recordedOn",source,impressions,reactions,comments,shares,clicks,followers,note from pulse.pr_post_metric where draft_id=$1 order by recorded_on desc,created_at desc`,
    [id(draftId, 'Draft')])).rows };
}

// ------------------------------------------------------------------------------------------------ the weekly report
export async function reports(c: PoolClient) {
  await pipeGate(c);
  return { reports: (await c.query(`select r.id,r.person_id "personId",p.display_name person,r.week_start::text "weekStart",r.title,r.body,r.numbers,r.proof,r.next,r.status,r.shared,
      r.person_id=pulse.current_viewer() mine,(select c.id from pulse.pr_creative c where c.report_id=r.id and c.png is not null order by c.created_at desc limit 1) "cardId"
    from pulse.pr_work_report r join pulse.person p on p.id=r.person_id order by r.week_start desc,r.created_at desc limit 20`)).rows };
}
export async function saveReport(c: PoolClient, reportId: string, b: Body) {
  await pipeGate(c);
  const r = await c.query(`update pulse.pr_work_report set title=coalesce($2,title),body=coalesce($3,body),next=coalesce($4,next) where id=$1 and person_id=pulse.current_viewer() returning id`,
    [id(reportId, 'Report'), has(b, 'title') ? line(b.title, 160) || fail(400, 'Give the report a title') : null, has(b, 'body') ? block(b.body, 12000) || fail(400, 'The report needs words') : null,
      has(b, 'next') ? block(b.next, 4000) : null]);
  if (!r.rowCount) fail(403, 'Only the person whose report it is changes it');
  return reports(c);
}

// ------------------------------------------------------------------------------------------------ the client's side
/** A client approver's drafts: their brands' drafts waiting for review or the client's OK (pulse.pr_brand_see decides). */
export async function clientDrafts(c: PoolClient) {
  return { drafts: (await c.query(`select d.id,b.name as brand,d.headline,d.copy,d.long_post "longPost",d.approval,d.plan_on::text "planOn",d.needs_client_ok "needsClientOk",
      d.client_ok_at::text "clientOkAt",(select coalesce(jsonb_agg(x.id order by x.slide),'[]') from pulse.pr_creative x where x.draft_id=d.id and x.png is not null) images
    from pulse.pr_draft d join pulse.pr_brand b on b.id=d.brand_id where d.approval in ('review','approved') order by d.plan_on nulls last limit 100`)).rows };
}

// ------------------------------------------------------------------------------------------------ routes
export function registerPrPipelineRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: 'object' } as const;
  app.get('/api/v0/pr/pipeline', (req) => tx(req, (c) => overview(c)));
  app.get('/api/v0/pr/pipeline/drafts', (req) => tx(req, async (c) => ({ drafts: await draftMeta(c) })));
  app.post<{ Body: Body }>('/api/v0/pr/pipeline/settings', { schema: { body } }, (req) => tx(req, async (c) => {
    await studioGate(c);
    const b = req.body ?? {};
    const p: Body = {};
    if (has(b, 'enabled')) p.enabled = b.enabled === true;
    if (has(b, 'aiAssist')) p.aiAssist = b.aiAssist === true;
    if (has(b, 'reportPersonId')) p.reportPersonId = b.reportPersonId && UUID.test(String(b.reportPersonId)) ? b.reportPersonId : '';
    if (has(b, 'hourlyValue')) { const n = Number(b.hourlyValue); if (!(n > 0 && n <= 100000)) fail(400, 'The hourly value is between 1 and 100,000'); p.hourlyValue = n; }
    if (has(b, 'currency')) { if (!/^[A-Z]{3}$/.test(String(b.currency))) fail(400, 'A currency is three letters, like INR'); p.currency = b.currency; }
    return { settings: (await db(() => c.query('select pulse.pr_pipeline_set($1) s', [JSON.stringify(p)]))).rows[0].s };
  }));
  app.post<{ Body: Body }>('/api/v0/pr/pipeline/run', { schema: { body } }, (req) => tx(req, async (c) => {
    await studioGate(c);
    return { run: (await db(() => c.query('select pulse.pr_pipeline_tick(true) r'))).rows[0].r };
  }));
  app.get<{ Querystring: Record<string, string> }>('/api/v0/pr/pipeline/setup', (req) => tx(req, (c) => wizardData(c, String(req.query.industry ?? 'other'))));
  app.post<{ Body: Body }>('/api/v0/pr/pipeline/brands', { schema: { body } }, (req) => tx(req, async (c) => ({ brand: await setupBrand(c, req.body ?? {}) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/pipeline/brands/:id', { schema: { body } }, (req) => tx(req, async (c) => ({ brand: await updateBrand(c, req.params.id, req.body ?? {}) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/pipeline/brands/:id/members', { schema: { body } }, (req) => tx(req, (c) => setMember(c, req.params.id, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/pipeline/brands/:id/career', { schema: { body } }, (req) => tx(req, async (c) => {
    await pipeGate(c);
    return { added: (await db(() => c.query('select pulse.pr_career_import($1) n', [id(req.params.id, 'Brand')]))).rows[0].n };
  }));
  app.get<{ Querystring: Record<string, string> }>('/api/v0/pr/pipeline/ideas', (req) => tx(req, (c) => ideas(c, req.query.brand)));
  app.get<{ Params: { id: string } }>('/api/v0/pr/pipeline/creatives/:id', async (req, reply) => {
    const name = String(req.params.id).replace(/\.png$/, '');
    const png = await tx(req, async (c) => {
      await pipeGate(c);
      return (await c.query('select png from pulse.pr_creative where id=$1', [id(name, 'Image')])).rows[0]?.png as Buffer | undefined;
    });
    if (!png) fail(404, 'The image is not made yet');
    reply.header('cache-control', 'private, max-age=300').header('x-content-type-options', 'nosniff').header('content-disposition', `inline; filename="creative-${name.slice(0, 8)}.png"`);
    return reply.type('image/png').send(png);
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/pipeline/drafts/:id/move', { schema: { body } }, (req) => tx(req, (c) => moveDraft(c, req.params.id, req.body ?? {})));
  app.get<{ Params: { id: string } }>('/api/v0/pr/pipeline/drafts/:id/metrics', (req) => tx(req, (c) => metrics(c, req.params.id)));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/pipeline/drafts/:id/metrics', { schema: { body } }, (req) => tx(req, (c) => addMetric(c, req.params.id, req.body ?? {})));
  app.get('/api/v0/pr/pipeline/reports', (req) => tx(req, (c) => reports(c)));
  app.get('/api/v0/pr/pipeline/reports/share-targets', (req) => tx(req, async (c) => {
    await pipeGate(c);
    return { targets: (await c.query('select pulse.pr_report_share_targets() t')).rows[0].t };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/pipeline/reports/:id', { schema: { body } }, (req) => tx(req, (c) => saveReport(c, req.params.id, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/pipeline/reports/:id/share', { schema: { body } }, (req) => tx(req, async (c) => {
    await pipeGate(c);
    const b = req.body ?? {};
    const people = (Array.isArray(b.people) ? b.people : []).filter((x) => UUID.test(String(x))).slice(0, 20);
    if (!people.length) fail(400, 'Choose who to share it with');
    return { share: (await db(() => c.query('select pulse.pr_report_share($1,$2,$3::uuid[]) r', [id(req.params.id, 'Report'), id(b.orgId, 'Company'), people]))).rows[0].r };
  }));
  // The client's side: a client approver sees their brands' drafts and approves or asks for changes, inside Pulse.
  const clientOnly = <T>(req: Parameters<Tx>[0], f: (c: PoolClient) => Promise<T>) => tx(req, async (c, v) => {
    if (v.side !== 'client') fail(403, 'This is the client\'s side');
    return f(c);
  });
  app.get('/api/v0/client-portal/pr', (req) => clientOnly(req, (c) => clientDrafts(c)));
  app.get<{ Params: { id: string } }>('/api/v0/client-portal/pr/images/:id', async (req, reply) => {
    const png = await clientOnly(req, async (c) => (await c.query('select png from pulse.pr_creative where id=$1 and draft_id is not null', [id(String(req.params.id).replace(/\.png$/, ''), 'Image')])).rows[0]?.png as Buffer | undefined);
    if (!png) fail(404, 'The image is not made yet');
    reply.header('cache-control', 'private, max-age=300').header('x-content-type-options', 'nosniff');
    return reply.type('image/png').send(png);
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/client-portal/pr/:id/approve', { schema: { body } }, (req) => clientOnly(req, async (c) => {
    const draft = id(req.params.id, 'Draft');
    const cur = (await c.query('select approval,needs_client_ok n from pulse.pr_draft where id=$1', [draft])).rows[0] ?? fail(404, 'Draft not found');
    const note = block(req.body?.note, 500) || 'Approved in Pulse by the client';
    if (cur.approval === 'review') await db(() => c.query('select pulse.pr_draft_move($1,$2,$3)', [draft, 'approved', note]));
    else if (cur.n) await db(() => c.query('select pulse.pr_draft_move($1,$2,$3)', [draft, 'client_ok', note]));
    return clientDrafts(c);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/client-portal/pr/:id/changes', { schema: { body } }, (req) => clientOnly(req, async (c) => {
    await db(() => c.query('select pulse.pr_draft_move($1,$2,$3)', [id(req.params.id, 'Draft'), 'draft', block(req.body?.note, 500)]));
    return clientDrafts(c);
  }));
}
