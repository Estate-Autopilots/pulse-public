// PR-STUDIO-2 (owner, 7 Nov 2026; migration 1680): one path through PR Studio, per brand: Strategy -> Calendar -> Board ->
// Library -> Post kit -> Insights. A brand's strategy (pillars, channels and their cadence, the month -> week -> day ->
// hour plan), its creative library (files kept in Pulse), and its posts (one card on the board, one slot on the calendar).
// Who sees and changes which brand is decided in the database (pulse.pr_brand_see / pr_brand_edit under forced row
// security; stage moves, OKs and the brand switch through pulse.pr_post_move, pr_asset_ok and pr_brand_switch), so these
// routes only shape and check what is sent. Nothing is posted or sent from here: people download, copy and post.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';
import { ORG_TZ } from './org-time.js';

type Row = Record<string, unknown>;
type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const id = (v: unknown, what: string) => UUID.test(String(v)) ? String(v) : fail(404, `${what} not found`);
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const line = (v: unknown, max: number) => v === null || v === undefined ? '' : String(v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v: unknown, max: number) => v === null || v === undefined ? '' : String(v).replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '').trim().slice(0, max);
export const CHANNELS = ['linkedin', 'x', 'instagram', 'whatsapp_status', 'newsletter'] as const;
export const STAGES = ['idea', 'draft', 'design', 'review', 'approved', 'scheduled', 'posted', 'measured'] as const;
const channelOf = (v: unknown) => (CHANNELS as readonly string[]).includes(String(v)) ? String(v) : fail(400, `Choose a channel: ${CHANNELS.join(', ')}`);

async function gate(c: PoolClient) {
  const r = (await c.query(`select pulse.pr_can() or exists(select 1 from pulse.pr_brand_member m where m.person_id=pulse.current_viewer()) v`)).rows[0];
  if (r?.v !== true) fail(403, 'PR Studio is for the company\'s admins, leadership and the people on a brand');
}
async function db<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === '42501') fail(403, err.message ?? 'Not allowed');
    if (err.code === '22023' || err.code === '23514' || err.code === '22P02' || err.code === '22007' || err.code === '22008') fail(400, err.message ?? 'Check what was sent');
    if (err.code === 'P0002') fail(404, err.message ?? 'Not found');
    if (err.code === '23505') fail(409, 'That exists already');
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ reading
// A brand's own zone when its strategy names one, else the company's (R51: no fixed zone in API sources).
const TZ = `coalesce((select s.time_zone from pulse.pr_strategy s where s.brand_id=$1),${ORG_TZ})`;
const POST = `select p.id,p.brand_id "brandId",p.asset_id "assetId",p.title,p.stage,p.channel,p.pillar,p.format,p.slot_at::text "slotAt",
  to_char(p.slot_at at time zone t.tz,'YYYY-MM-DD') as day,to_char(p.slot_at at time zone t.tz,'HH24:MI') as time,p.caption,p.note,
  p.posted_at::text "postedAt",to_char(p.posted_at at time zone t.tz,'YYYY-MM-DD') "postedDay",p.posted_url "postedUrl",p.metrics,p.measured_at::text "measuredAt",p.updated_at::text "updatedAt"
  from pulse.pr_post p cross join (select ${TZ} tz) t where p.brand_id=$1`;
const ASSET = `select a.id,a.source_key "key",a.title,a.collection,a.kind,a.size,a.pillar,a.channel,a.format,a.caption,a.caption_safe "captionSafe",a.hashtags,a.why,a.hooks,a.brief,
  a.slides,a.pdf_file_id "pdfFileId",a.pdf_safe_file_id "pdfSafeFileId",a.ok_state "okState",a.ok_who "okWho",a.ok_note "okNote",a.ok_given_at::text "okGivenAt",
  a.ok_given_note "okGivenNote",a.archived from pulse.pr_asset a where a.brand_id=$1`;

/** Insights for a brand: posts a week against the plan (8 weeks back, 4 ahead), weeks in a row on plan, the top posts
 *  by engagement, and the strategy's KPIs against what was logged. Goals themselves live in Goals. */
async function insights(c: PoolClient, brand: string, strategy: Row | null) {
  const plan = Array.isArray(strategy?.channels) ? (strategy!.channels as Row[]).reduce((n, ch) => n + Math.max(0, Number(ch.perWeek) || 0), 0) : 0;
  const weeks = (await c.query(`with t as (select ${TZ} tz),
    s as (select date_trunc('week', now() at time zone t.tz)::date d0, (now() at time zone t.tz)::date today, t.tz from t),
    w as (select s.d0 + 7 * i - 56 as wk, s.today, s.tz from s, generate_series(0, 12) i)
    select w.wk::text as week,
      (select count(*)::int from pulse.pr_post p where p.brand_id=$1 and p.slot_at is not null and (p.slot_at at time zone w.tz)::date between w.wk and w.wk + 6) planned,
      (select count(*)::int from pulse.pr_post p where p.brand_id=$1 and p.posted_at is not null and (p.posted_at at time zone w.tz)::date between w.wk and w.wk + 6) posted,
      w.wk <= w.today as started
    from w order by w.wk`, [brand])).rows as { week: string; planned: number; posted: number; started: boolean }[];
  // Weeks in a row on plan: the finished weeks back from last week (this week counts once it is on plan).
  const target = plan || 1;
  let streak = 0;
  const done = weeks.filter((w) => w.started);
  const cur = done[done.length - 1];
  if (cur && cur.posted >= target) streak++;
  for (let i = done.length - 2; i >= 0; i--) { if (done[i].posted >= target) streak++; else break; }
  const top = (await c.query(`select p.id,p.title,p.channel,p.pillar,p.posted_at::text "postedAt",p.posted_url "postedUrl",p.metrics,p.asset_id "assetId",
      coalesce((p.metrics->>'reactions')::bigint,0)+2*coalesce((p.metrics->>'comments')::bigint,0)+3*coalesce((p.metrics->>'shares')::bigint,0)+2*coalesce((p.metrics->>'saves')::bigint,0) engagement
    from pulse.pr_post p where p.brand_id=$1 and p.stage in ('posted','measured') order by engagement desc, p.posted_at desc limit 5`, [brand])).rows;
  const sums = (await c.query(`select count(*)::int posted,count(*) filter (where stage='measured')::int measured,
      coalesce(sum((metrics->>'impressions')::bigint),0)::float impressions,coalesce(sum((metrics->>'reactions')::bigint),0)::float reactions,
      coalesce(sum((metrics->>'comments')::bigint),0)::float comments,coalesce(sum((metrics->>'shares')::bigint),0)::float shares,
      coalesce(sum((metrics->>'saves')::bigint),0)::float saves,coalesce(sum((metrics->>'clicks')::bigint),0)::float clicks,
      coalesce(max((metrics->>'followers')::bigint),0)::float followers
    from pulse.pr_post where brand_id=$1 and stage in ('posted','measured') and posted_at>now()-interval '28 days'`, [brand])).rows[0] as Record<string, number>;
  const actual: Record<string, number> = { posts_per_week: Math.round((sums.posted / 4) * 10) / 10, impressions: sums.impressions, reactions: sums.reactions, comments: sums.comments,
    shares: sums.shares, saves: sums.saves, clicks: sums.clicks, followers: sums.followers,
    avg_impressions: sums.measured ? Math.round(sums.impressions / sums.measured) : 0 };
  const kpis = (Array.isArray(strategy?.kpis) ? strategy!.kpis as Row[] : []).map((k) => ({ ...k, actual: actual[String(k.metric)] ?? null }));
  const byChannel = (await c.query(`select channel,count(*) filter (where slot_at is not null)::int planned,count(*) filter (where stage in ('posted','measured'))::int posted
    from pulse.pr_post where brand_id=$1 group by channel order by channel`, [brand])).rows;
  return { plan, weeks, streak, top, kpis, byChannel, last28: sums };
}

export async function flow(c: PoolClient, q: Record<string, string>) {
  await gate(c);
  const brands = (await c.query(`select b.id,b.kind,b.name,b.byline,b.archived,pulse.pr_brand_role(b.id) as role,coalesce(s.status,'draft') status,
      (select count(*)::int from pulse.pr_asset a where a.brand_id=b.id and not a.archived) assets,(select count(*)::int from pulse.pr_post p where p.brand_id=b.id) posts
    from pulse.pr_brand b left join pulse.pr_strategy s on s.brand_id=b.id where not b.archived order by (coalesce(s.status,'draft')='on') desc,b.kind='personal' desc,lower(b.name)`)).rows;
  const pick = brands.find((b) => b.id === q.brand) ?? brands.find((b) => b.status === 'on') ?? brands[0] ?? null;
  const me = (await c.query(`select pulse.current_viewer() v,(select side from pulse.person where id=pulse.current_viewer()) side`)).rows[0];
  if (!pick) return { brands, brand: null, strategy: null, assets: [], posts: [], insights: null, today: null, now: null, me: me.v, side: me.side };
  const b = String(pick.id);
  const clock = (await c.query(`select to_char(now() at time zone ${TZ},'YYYY-MM-DD') today,to_char(now() at time zone ${TZ},'HH24:MI') now,${TZ} tz`, [b])).rows[0];
  const strategy = (await c.query(`select status,positioning,audiences,pillars,channels,kpis,months,weeks,rules,coalesce(time_zone,${ORG_TZ}) "timeZone",switched_at::text "switchedAt",updated_at::text "updatedAt"
    from pulse.pr_strategy where brand_id=$1`, [b])).rows[0] ?? null;
  const assets = (await c.query(`${ASSET} and not a.archived order by a.collection,a.source_key nulls last,a.created_at`, [b])).rows;
  const posts = (await c.query(`${POST} order by p.slot_at nulls last,p.created_at limit 2000`, [b])).rows;
  return { brands, brand: pick, strategy, assets, posts, insights: await insights(c, b, strategy), today: clock.today, now: clock.now, tz: clock.tz, me: me.v, side: me.side };
}

// ------------------------------------------------------------------------------------------------ strategy
const str = (v: unknown, max: number) => line(v, max);
function rows(v: unknown, max: number, shape: (r: Row) => Row | null): Row[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(400, 'Send a list');
  return (v as Row[]).map((r) => (r && typeof r === 'object' ? shape(r) : null)).filter((r): r is Row => r !== null).slice(0, max);
}
const times = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/)).map((x) => String(x).trim()).filter((x) => TIME.test(x)).slice(0, 6);
const days = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort().slice(0, 7);
const METRICS = ['posts_per_week', 'impressions', 'avg_impressions', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'followers'];
export function strategyOf(b: Body): Row {
  const out: Row = {};
  if (has(b, 'positioning')) out.positioning = block(b.positioning, 1200);
  if (has(b, 'audiences')) out.audiences = rows(b.audiences, 8, (r) => { const name = str(r.name, 80); return name ? { name, need: str(r.need, 240) } : null; });
  if (has(b, 'pillars')) {
    out.pillars = rows(b.pillars, 5, (r) => { const name = str(r.name, 40); return name ? { key: str(r.key, 40) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40), name, about: str(r.about, 240),
      share: Math.min(100, Math.max(0, Math.round(Number(r.share) || 0))) } : null; });
  }
  if (has(b, 'channels')) {
    out.channels = rows(b.channels, 5, (r) => { if (!(CHANNELS as readonly string[]).includes(String(r.key))) return null;
      return { key: String(r.key), perWeek: Math.min(21, Math.max(0, Math.round(Number(r.perWeek) || 0))), days: days(r.days), times: times(r.times), note: str(r.note, 200) }; });
    const keys = (out.channels as Row[]).map((r) => r.key);
    if (new Set(keys).size !== keys.length) fail(400, 'Each channel once');
  }
  if (has(b, 'kpis')) out.kpis = rows(b.kpis, 8, (r) => { const label = str(r.label, 80); if (!label) return null;
    const t = Number(r.target); return { label, metric: METRICS.includes(String(r.metric)) ? String(r.metric) : 'posts_per_week', target: Number.isFinite(t) && t >= 0 ? t : 0 }; });
  if (has(b, 'months')) out.months = rows(b.months, 12, (r) => /^\d{4}-\d{2}$/.test(String(r.month)) ? { month: String(r.month), theme: str(r.theme, 120), focus: str(r.focus, 240) } : null);
  if (has(b, 'weeks')) out.weeks = rows(b.weeks, 26, (r) => DAY.test(String(r.start)) ? { start: String(r.start), theme: str(r.theme, 120), note: str(r.note, 240) } : null);
  if (has(b, 'rules')) out.rules = (Array.isArray(b.rules) ? b.rules : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 12);
  if (has(b, 'timeZone')) { const tz = str(b.timeZone, 60); if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(tz)) fail(400, 'A time zone is a region and city, like Europe/London'); out.timeZone = tz; }
  return out;
}
export async function saveStrategy(c: PoolClient, brandId: string, b: Body) {
  await gate(c);
  const brand = id(brandId, 'Brand');
  const s = strategyOf(b);
  if ('timeZone' in s) {
    const ok = (await c.query('select exists(select 1 from pg_timezone_names where name=$1) v', [s.timeZone])).rows[0].v;
    if (!ok) fail(400, 'That time zone is not known');
  }
  const cols = ['positioning', 'audiences', 'pillars', 'channels', 'kpis', 'months', 'weeks', 'rules', 'timeZone'].filter((k) => k in s);
  const col = (k: string) => k === 'timeZone' ? 'time_zone' : k;
  const val = (k: string) => typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k]);
  await db(() => c.query(`insert into pulse.pr_strategy(org_id,brand_id,updated_by) select pulse.current_org(),b.id,pulse.current_viewer() from pulse.pr_brand b where b.id=$1
    on conflict (brand_id) do nothing`, [brand]));
  if (cols.length) {
    const r = await db(() => c.query(`update pulse.pr_strategy set ${cols.map((k, i) => `${col(k)}=$${i + 2}`).join(',')},updated_by=pulse.current_viewer() where brand_id=$1 returning brand_id`,
      [brand, ...cols.map(val)]));
    if (!r.rowCount) fail(403, 'Only the people who work on the brand change its strategy');
  }
  return flow(c, { brand });
}

// ------------------------------------------------------------------------------------------------ posts
async function slotFrom(c: PoolClient, brand: string, b: Body): Promise<string | null | undefined> {
  if (has(b, 'slotAt') && (b.slotAt === null || b.slotAt === '')) return null;
  if (!has(b, 'day') && !has(b, 'time')) return undefined;
  const day = String(b.day ?? ''), time = String(b.time ?? '09:00');
  if (!DAY.test(day) || !TIME.test(time)) fail(400, 'Pick a day (YYYY-MM-DD) and a time (HH:MM)');
  return (await db(() => c.query(`select ((($2::text||' '||$3::text)::timestamp) at time zone ${TZ})::text v`, [brand, day, time]))).rows[0].v as string;
}
export async function createPost(c: PoolClient, b: Body) {
  await gate(c);
  const brand = id(b.brandId, 'Brand');
  const asset = b.assetId ? (await c.query(`select id,title,caption,pillar,channel,format,kind from pulse.pr_asset where id=$1 and brand_id=$2`, [id(b.assetId, 'Creative'), brand])).rows[0] ?? fail(404, 'Creative not found') : null;
  const title = line(b.title, 200) || (asset?.title as string) || fail(400, 'Name the post');
  const stage = (STAGES as readonly string[]).includes(String(b.stage ?? '')) ? String(b.stage) : 'idea';
  if (['posted', 'measured'].includes(stage)) fail(400, 'Add it first, then mark it posted from its post kit');
  const slot = await slotFrom(c, brand, b);
  const r = await db(() => c.query(`insert into pulse.pr_post(org_id,brand_id,asset_id,title,stage,channel,pillar,format,slot_at,caption,note,created_by)
      values (pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,pulse.current_viewer()) returning id`,
  [brand, asset?.id ?? null, title, stage, b.channel ? channelOf(b.channel) : (asset?.channel as string) ?? 'linkedin', line(b.pillar, 40) || (asset?.pillar as string) || '',
    line(b.format, 60) || (asset?.format as string) || '', slot ?? null, block(b.caption, 6000) || (asset?.caption as string) || '', block(b.note, 1000)]));
  return { post: (await c.query(`${POST} and p.id=$2`, [brand, r.rows[0].id])).rows[0] };
}
export async function updatePost(c: PoolClient, postId: string, b: Body) {
  await gate(c);
  const old = (await c.query('select id,brand_id from pulse.pr_post where id=$1', [id(postId, 'Post')])).rows[0] ?? fail(404, 'Post not found');
  const brand = String(old.brand_id);
  const set: string[] = []; const vals: unknown[] = [old.id];
  const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col}=$${vals.length}`); };
  if (has(b, 'title')) add('title', line(b.title, 200) || fail(400, 'Name the post'));
  if (has(b, 'channel')) add('channel', channelOf(b.channel));
  if (has(b, 'pillar')) add('pillar', line(b.pillar, 40));
  if (has(b, 'format')) add('format', line(b.format, 60));
  if (has(b, 'caption')) add('caption', block(b.caption, 6000));
  if (has(b, 'note')) add('note', block(b.note, 1000));
  if (has(b, 'assetId')) add('asset_id', b.assetId ? id(b.assetId, 'Creative') : null);
  const slot = await slotFrom(c, brand, b);
  if (slot !== undefined) add('slot_at', slot);
  if (!set.length) fail(400, 'Nothing to change');
  const r = await db(() => c.query(`update pulse.pr_post set ${set.join(',')} where id=$1 returning id`, vals));
  if (!r.rowCount) fail(403, 'Only the people who work on the brand change its posts');
  return { post: (await c.query(`${POST} and p.id=$2`, [brand, old.id])).rows[0] };
}
export async function movePost(c: PoolClient, postId: string, b: Body) {
  await gate(c);
  const to = (STAGES as readonly string[]).includes(String(b.to)) ? String(b.to) : fail(400, `Move it to one of: ${STAGES.join(', ')}`);
  const url = b.url ? String(b.url).trim() : null;
  if (url && (!/^https:\/\/\S+$/.test(url) || url.length > 500)) fail(400, 'The post link starts with https://');
  let metrics: Row | null = null;
  if (to === 'measured') {
    const m = (b.metrics && typeof b.metrics === 'object' ? b.metrics : {}) as Row;
    metrics = {};
    for (const k of ['impressions', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'followers']) {
      if (m[k] === undefined || m[k] === null || m[k] === '') continue;
      const n = Number(m[k]);
      if (!Number.isInteger(n) || n < 0 || n > 9_999_999_999) fail(400, 'Numbers are whole numbers');
      metrics[k] = n;
    }
  }
  const post = id(postId, 'Post');
  const stage = (await db(() => c.query('select pulse.pr_post_move($1,$2,$3,$4) s', [post, to, url, metrics ? JSON.stringify(metrics) : null]))).rows[0].s;
  const brand = (await c.query('select brand_id from pulse.pr_post where id=$1', [post])).rows[0]?.brand_id;
  return { stage, post: brand ? (await c.query(`${POST} and p.id=$2`, [brand, post])).rows[0] : null };
}

// ------------------------------------------------------------------------------------------------ the library
export async function updateAsset(c: PoolClient, assetId: string, b: Body) {
  await gate(c);
  const a = (await c.query(`select id,slides from pulse.pr_asset where id=$1`, [id(assetId, 'Creative')])).rows[0] ?? fail(404, 'Creative not found');
  const set: string[] = []; const vals: unknown[] = [a.id];
  const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col}=$${vals.length}`); };
  if (has(b, 'caption')) add('caption', block(b.caption, 6000));
  if (has(b, 'pillar')) add('pillar', line(b.pillar, 40));
  if (has(b, 'channel')) add('channel', b.channel ? channelOf(b.channel) : null);
  if (has(b, 'hashtags')) add('hashtags', (Array.isArray(b.hashtags) ? b.hashtags : String(b.hashtags ?? '').split(/[\s,]+/)).map((t) => line(t, 60).replace(/^#?/, '#')).filter((t) => t.length > 1).slice(0, 30));
  if (has(b, 'alt') && b.alt && typeof b.alt === 'object') {
    const alt = b.alt as Row;
    add('slides', JSON.stringify((a.slides as Row[]).map((s) => alt[String(s.name)] !== undefined ? { ...s, alt: block(alt[String(s.name)], 1200) } : s)));
  }
  if (has(b, 'archived')) add('archived', b.archived === true);
  if (!set.length) fail(400, 'Nothing to change');
  const r = await db(() => c.query(`update pulse.pr_asset set ${set.join(',')} where id=$1 returning brand_id`, vals));
  if (!r.rowCount) fail(403, 'Only the people who work on the brand change its creatives');
  return { asset: (await c.query(`${ASSET} and a.id=$2`, [r.rows[0].brand_id, a.id])).rows[0] };
}

// ------------------------------------------------------------------------------------------------ routes
export function registerPrFlowRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: 'object' } as const;
  app.get<{ Querystring: Record<string, string> }>('/api/v0/pr/flow', (req) => tx(req, (c) => flow(c, req.query ?? {})));
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/v0/pr/flow/files/:id', async (req, reply) => {
    const name = String(req.params.id).replace(/\.(png|jpe?g|webp|pdf)$/i, '');
    const f = await tx(req, async (c) => {
      await gate(c);
      return (await c.query('select name,mime,bytes from pulse.pr_file where id=$1', [id(name, 'File')])).rows[0] as { name: string; mime: string; bytes: Buffer } | undefined;
    });
    if (!f) return fail(404, 'File not found');
    const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120) || 'file';
    reply.header('cache-control', 'private, max-age=86400, immutable').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${req.query?.download === '1' ? 'attachment' : 'inline'}; filename="${safe}"`);
    return reply.type(f.mime).send(f.bytes);
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/flow/brands/:id/strategy', { schema: { body } }, (req) => tx(req, (c) => saveStrategy(c, req.params.id, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/flow/brands/:id/switch', { schema: { body } }, (req) => tx(req, async (c) => {
    await gate(c);
    const status = (await db(() => c.query('select pulse.pr_brand_switch($1,$2) s', [id(req.params.id, 'Brand'), req.body?.on !== false]))).rows[0].s;
    return { status };
  }));
  app.post<{ Body: Body }>('/api/v0/pr/flow/posts', { schema: { body } }, (req) => tx(req, (c) => createPost(c, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/flow/posts/:id', { schema: { body } }, (req) => tx(req, (c) => updatePost(c, req.params.id, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/flow/posts/:id/move', { schema: { body } }, (req) => tx(req, (c) => movePost(c, req.params.id, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/flow/posts/:id/delete', { schema: { body } }, (req) => tx(req, async (c) => {
    await gate(c);
    const r = await db(() => c.query('delete from pulse.pr_post where id=$1 returning id', [id(req.params.id, 'Post')]));
    if (!r.rowCount) fail(403, 'A posted item stays; only the people who work on the brand remove the others');
    return { deleted: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/flow/assets/:id', { schema: { body } }, (req) => tx(req, (c) => updateAsset(c, req.params.id, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/flow/assets/:id/ok', { schema: { body } }, (req) => tx(req, async (c) => {
    await gate(c);
    const at = (await db(() => c.query('select pulse.pr_asset_ok($1,$2) at', [id(req.params.id, 'Creative'), block(req.body?.note, 500)]))).rows[0].at;
    return { okGivenAt: at };
  }));
}
