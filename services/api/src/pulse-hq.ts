// PULSE-HQ (owner, 23 Oct 2026): the business of Pulse, run in Pulse. The Pulse organisation (@pulsehq, 0944) keeps
// the catalogue of every Pulse feature, an ideation board, Offer Studio (Hormozi's value equation, tiers of features,
// bonuses, guarantee, scarcity, naming, price anchors) and its positioning and brand. Its module (pulse_hq) is
// organisation-only (modules.ts ORG_ONLY): each organisation opts in, and only reads its own data. Everyone in the
// organisation reads, adds ideas and votes; its leaders (admin, leadership) change the catalogue, offers and brand.
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, normalizedOrgName, type Tx, type Viewer } from './routes.js';
import { PEOPLE } from './stack-intel.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 40 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HQ_CATEGORIES = ['home', 'work', 'flows', 'chats', 'people', 'finance', 'clients', 'creative', 'xray', 'network', 'apps', 'admin', 'platform'] as const;
export const HQ_FEATURE_STATUS = ['live', 'beta', 'building', 'idea'] as const;
export const HQ_IDEA_STATUS = ['new', 'exploring', 'planned', 'building', 'shipped', 'parked'] as const;
export const HQ_OFFER_STATUS = ['draft', 'testing', 'ready', 'retired'] as const;
const BILLING = ['month', 'year', 'once', 'seat-month'] as const;

const str = (x: unknown, max: number) => String(x ?? '').trim().slice(0, max);
const need = (x: unknown, max: number, what: string) => { const s = str(x, max); return s.length >= 2 ? s : fail(400, what); };
const pick = <T extends string>(x: unknown, list: readonly T[], fallback: T) => (list as readonly string[]).includes(String(x)) ? String(x) as T : fallback;
const score = (x: unknown, lo: number, hi: number, fallback: number) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };
const id = (x: unknown, what = 'Not found') => UUID.test(String(x)) ? String(x) : fail(404, what);
const strings = (x: unknown, max: number, each: number) => Array.isArray(x) ? x.map((s) => str(s, each)).filter(Boolean).slice(0, max) : [];
const key = (x: unknown) => { const k = str(x, 64).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''); return k.length >= 2 ? k : null; };
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const lead = (v: Viewer) => { if (!leadership(v)) fail(403, 'Only the organisation’s leaders change this.'); };
const optPerson = (x: unknown) => x === null || x === '' || x === undefined ? null : UUID.test(String(x)) ? String(x) : fail(400, 'Choose a person');
const rows = (x: unknown, max = 500) => Array.isArray(x) ? [...new Set(x.map(String).filter((s) => UUID.test(s)))].slice(0, max) : fail(400, 'Choose rows');
const person = (v: Viewer) => { if (!v.person) fail(403, 'Pulse HQ belongs to the people of this organisation.'); return v.person; };

/** Hormozi's value equation: (dream outcome × perceived likelihood) ÷ (time delay × effort and sacrifice), each 1–10. */
export const valueScore = (o: { dream: number; likelihood: number; time: number; effort: number }) =>
  Math.round((o.dream * o.likelihood) / Math.max(1, o.time * o.effort) * 100) / 100;

/** A bonus, an anchor, a tier: plain objects with bounded text, so a page can never store anything else. */
const bonuses = (x: unknown) => Array.isArray(x) ? x.slice(0, 12).map((b: Body) => ({ name: str(b?.name, 120), value: Math.max(0, Number(b?.value) || 0), why: str(b?.why, 300) })).filter((b) => b.name) : [];
const anchors = (x: unknown) => Array.isArray(x) ? x.slice(0, 8).map((a: Body) => ({ label: str(a?.label, 120), amount: Math.max(0, Number(a?.amount) || 0) })).filter((a) => a.label) : [];
const tiers = (x: unknown) => Array.isArray(x) ? x.slice(0, 5).map((t: Body, i) => ({
  key: key(t?.key) ?? `tier-${i + 1}`, name: str(t?.name, 60) || `Tier ${i + 1}`, price: t?.price === null || t?.price === '' || t?.price === undefined ? null : Math.max(0, Number(t.price) || 0),
  blurb: str(t?.blurb, 240), seats: t?.seats ? Math.max(1, Math.round(Number(t.seats)) || 1) : null, highlight: t?.highlight === true,
  features: strings(t?.features, 120, 64).map((k) => key(k)).filter((k): k is string => !!k) })) : [];
/** Problems in the way of the dream outcome, each with its solution and the Pulse features that deliver it. */
const problems = (x: unknown) => Array.isArray(x) ? x.slice(0, 12).map((p: Body) => ({ problem: str(p?.problem, 200), solution: str(p?.solution, 300),
  features: strings(p?.features, 12, 64).map((k) => key(k)).filter((k): k is string => !!k) })).filter((p) => p.problem || p.solution) : [];
const naming = (x: unknown) => { const n = (x && typeof x === 'object' ? x : {}) as Body;
  return { magnet: str(n.magnet, 80), avatar: str(n.avatar, 80), goal: str(n.goal, 80), interval: str(n.interval, 80), container: str(n.container, 80), tagline: str(n.tagline, 160) }; };
const brandBody = (x: unknown) => { const b = (x && typeof x === 'object' ? x : {}) as Body;
  return { title: str(b.title, 40), tagline: str(b.tagline, 160), oneLiner: str(b.oneLiner, 300), category: str(b.category, 120), forWho: str(b.forWho, 300), against: str(b.against, 300),
    promise: str(b.promise, 300), pillars: strings(b.pillars, 6, 160), proof: strings(b.proof, 8, 200), voice: str(b.voice, 400), pricing: str(b.pricing, 600),
    colours: strings(b.colours, 6, 7).filter((c) => /^#[0-9a-f]{6}$/i.test(c)), draft: b.draft === true }; };

/** Shared by HQ and the signed-in menu; both reads keep the tenant boundary. */
export async function readHqIdentity(c: PoolClient, org: string) {
  const row = (await c.query(`select o.name, o.handle, b.body from pulse.org o
    left join pulse.hq_brand b on b.org_id = o.id where o.id = $1`, [org])).rows[0];
  const title = typeof row?.body?.title === 'string' ? str(row.body.title, 40) : '';
  return { title: title || `${normalizedOrgName(row?.name)} HQ`, platform: row?.handle === 'pulsehq' };
}

// Same grammar as 0996: one internal path or HTTPS with a dotted DNS host, port 0..65535, no credentials/whitespace.
const HREF = /^(?:\/(?:[A-Za-z0-9?=&._-][A-Za-z0-9/?=&._-]*)?|https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::(?:[0-5]?[0-9]{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(?:[/?#][^\s\\]*)?)$/;
const featureHref = (x: unknown) => typeof x === 'string' && x.length <= 300 && !/\s/.test(x) && HREF.test(x) ? x : null;

const FEATURES = `select f.id, f.key, f.category, f.name, f.promise, f.what, f.who, f.status, f.icon, f.proof, f.href, f.screenshot, f.sort, f.draft, f.archived,
    f.owner_id "ownerId", p.display_name "owner", f.updated_at "updatedAt"
  from pulse.hq_feature f left join pulse.person p on p.id = f.owner_id order by f.category, f.sort, f.name`;
const IDEAS = `select i.id, i.title, i.problem, i.for_whom "forWhom", i.impact, i.effort, i.status, i.feature_keys "featureKeys", i.feature_id "featureId",
    i.draft, i.created_at "createdAt", p.display_name "by", i.sort, i.area, i.owner_id "ownerId", o.display_name "owner", i.details,
    i.created_by "byId", (select count(*)::int from pulse.hq_idea_vote v where v.idea_id = i.id) votes,
    exists (select 1 from pulse.hq_idea_vote v where v.idea_id = i.id and v.person_id = $1) voted
  from pulse.hq_idea i left join pulse.person p on p.id = i.created_by left join pulse.person o on o.id = i.owner_id order by i.sort, i.created_at desc`;
const OFFERS = `select id, name, status, icp, dream_outcome "dreamOutcome", v_dream dream, v_likelihood likelihood, v_time "time", v_effort effort,
    deliverables, bonuses, guarantee, scarcity, urgency, naming, anchors, currency, price::float8 price, billing, positioning, brand_notes "brandNotes",
    tiers, problems, delivery, accent, sort, draft, updated_at "updatedAt"
  from pulse.hq_offer order by sort, created_at`;

async function everything(c: PoolClient, v: Viewer) {
  const [features, ideas, offers, brand, versions, people] = await Promise.all([
    c.query(FEATURES), c.query(IDEAS, [v.person]), c.query(OFFERS),
    c.query('select body, updated_at "updatedAt" from pulse.hq_brand'),
    c.query(`select v.id, v.saved_at "savedAt", p.display_name "by", v.body from pulse.hq_brand_version v left join pulse.person p on p.id = v.saved_by
      order by v.saved_at desc limit 20`),
    c.query(PEOPLE),
  ]);
  return { ...await readHqIdentity(c, v.org), canEdit: leadership(v), features: features.rows, ideas: ideas.rows,
    offers: offers.rows.map((o) => ({ ...o, value: valueScore(o) })), brand: brand.rows[0]?.body ?? null, brandUpdatedAt: brand.rows[0]?.updatedAt ?? null, brandVersions: versions.rows, people: people.rows, me: v.person };
}

const offerFields = (b: Body) => {
  const cols: [string, unknown][] = [];
  if (has(b, 'name')) cols.push(['name', need(b.name, 80, 'Give the offer a name')]);
  if (has(b, 'status')) cols.push(['status', pick(b.status, HQ_OFFER_STATUS, 'draft')]);
  for (const [k, col, max] of [['icp', 'icp', 600], ['dreamOutcome', 'dream_outcome', 600], ['guarantee', 'guarantee', 600], ['scarcity', 'scarcity', 400],
    ['urgency', 'urgency', 400], ['positioning', 'positioning', 800], ['brandNotes', 'brand_notes', 800]] as const)
    if (has(b, k)) cols.push([col, str(b[k], max)]);
  for (const [k, col, fallback] of [['dream', 'v_dream', 7], ['likelihood', 'v_likelihood', 6], ['time', 'v_time', 4], ['effort', 'v_effort', 4]] as const)
    if (has(b, k)) cols.push([col, score(b[k], 1, 10, fallback)]);
  if (has(b, 'deliverables')) cols.push(['deliverables', JSON.stringify(strings(b.deliverables, 20, 200))]);
  if (has(b, 'problems')) cols.push(['problems', JSON.stringify(problems(b.problems))]);
  if (has(b, 'delivery')) cols.push(['delivery', JSON.stringify(strings(b.delivery, 12, 160))]);
  if (has(b, 'bonuses')) cols.push(['bonuses', JSON.stringify(bonuses(b.bonuses))]);
  if (has(b, 'anchors')) cols.push(['anchors', JSON.stringify(anchors(b.anchors))]);
  if (has(b, 'tiers')) cols.push(['tiers', JSON.stringify(tiers(b.tiers))]);
  if (has(b, 'naming')) cols.push(['naming', JSON.stringify(naming(b.naming))]);
  if (has(b, 'currency')) cols.push(['currency', /^[A-Z]{3}$/.test(String(b.currency)) ? String(b.currency) : 'INR']);
  if (has(b, 'price')) cols.push(['price', b.price === null || b.price === '' ? null : Math.max(0, Number(b.price) || 0)]);
  if (has(b, 'billing')) cols.push(['billing', pick(b.billing, BILLING, 'month')]);
  if (has(b, 'accent')) cols.push(['accent', /^#[0-9a-f]{6}$/.test(String(b.accent)) ? String(b.accent) : '#6b4cf0']);
  if (has(b, 'draft')) cols.push(['draft', b.draft === true]);
  return cols;
};

const featureFields = (b: Body) => {
  const cols: [string, unknown][] = [];
  if (has(b, 'name')) cols.push(['name', need(b.name, 80, 'Name the feature')]);
  if (has(b, 'category')) cols.push(['category', pick(b.category, HQ_CATEGORIES, 'work')]);
  if (has(b, 'status')) cols.push(['status', pick(b.status, HQ_FEATURE_STATUS, 'idea')]);
  for (const [k, max] of [['promise', 200], ['what', 600], ['who', 120], ['proof', 300]] as const) if (has(b, k)) cols.push([k, str(b[k], max)]);
  if (has(b, 'icon')) cols.push(['icon', /^[A-Z][A-Za-z0-9]{1,40}$/.test(String(b.icon)) ? String(b.icon) : 'Sparkles']);
  if (has(b, 'draft')) cols.push(['draft', b.draft === true]);
  if (has(b, 'archived')) cols.push(['archived', b.archived === true]);
  if (has(b, 'ownerId')) cols.push(['owner_id', optPerson(b.ownerId)]);
  if (has(b, 'href')) cols.push(['href', featureHref(b.href)]);
  return cols;
};

async function update(c: PoolClient, table: string, rowId: string, cols: [string, unknown][], what: string) {
  if (!cols.length) return;
  const sets = cols.map(([col], i) => `${col} = $${i + 2}`).join(', ');
  const r = await c.query(`update pulse.${table} set ${sets}, updated_at = now() where id = $1`, [rowId, ...cols.map(([, val]) => val)]);
  if (!r.rowCount) fail(404, what);
}

/** An idea's area, owner and long description (plain text; slash commands only insert text). */
const ideaExtras = (b: Body) => {
  const cols: [string, unknown][] = [];
  if (has(b, 'area')) cols.push(['area', b.area === null || b.area === '' ? null : pick(b.area, HQ_CATEGORIES, 'work')]);
  if (has(b, 'ownerId')) cols.push(['owner_id', optPerson(b.ownerId)]);
  if (has(b, 'details')) cols.push(['details', String(b.details ?? '').replace(/\r\n/g, '\n').slice(0, 8000)]);
  return cols;
};
async function addIdea(c: PoolClient, me: string | null, b: Body) {
  const extra = ideaExtras(b);
  const at = b.first === true ? 'coalesce((select min(sort) - 1 from pulse.hq_idea), 0)' : 'coalesce((select max(sort) + 1 from pulse.hq_idea), 0)';
  const r = await c.query(`insert into pulse.hq_idea(org_id, title, problem, for_whom, impact, effort, status, feature_keys, created_by, sort${extra.map(([col]) => `, ${col}`).join('')})
    values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, ${at}${extra.map((_, i) => `, $${i + 9}`).join('')}) returning id`,
    [need(b.title, 120, 'Give the idea a title'), str(b.problem, 1000), str(b.forWhom, 160), score(b.impact, 1, 5, 3), score(b.effort, 1, 5, 3),
      pick(b.status, HQ_IDEA_STATUS, 'new'), strings(b.featureKeys, 20, 64).map(key).filter(Boolean), me, ...extra.map(([, x]) => x)]);
  return r.rows[0].id as string;
}

/** The catalogue shipped with this release, for an install without the Pulse organisation (a self-hosted company). */
let bundled: unknown[] | null = null;
const bundledFeatures = () => {
  try { bundled ??= JSON.parse(readFileSync(new URL('../data/pulse-features.json', import.meta.url), 'utf8')) as unknown[]; } catch { bundled = []; }
  return bundled;
};

export function registerPulseHqRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // What Pulse can do: the catalogue for every organisation, read only (the Pulse organisation keeps it, 0947).
  app.get('/api/v0/features', (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'The catalogue is for the people of an organisation.');
    const live = (await c.query<{ f: unknown[] }>('select pulse.pulse_features() f')).rows[0].f;
    return { features: live.length ? live : bundledFeatures(), source: live.length ? 'pulse' : 'release' };
  }));
  // Everything Pulse HQ shows: the catalogue, the ideas with their votes, the offers with their value score, the brand.
  app.get('/api/v0/hq', (req) => tx(req, async (c, v) => { person(v); return everything(c, v); }));

  // The catalogue (leaders).
  app.post<{ Body: Body }>('/api/v0/hq/features', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const b = req.body;
    const name = need(b.name, 80, 'Name the feature');
    let k = key(b.key) ?? key(name) ?? fail(400, 'Name the feature');
    if ((await c.query('select 1 from pulse.hq_feature where key = $1', [k])).rowCount) k = `${k.slice(0, 56)}-${Date.now().toString(36).slice(-6)}`;
    const r = await c.query(`insert into pulse.hq_feature(org_id, key, category, name, promise, what, who, status, icon, proof, sort, draft, created_by, owner_id, href)
      values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce((select max(sort) + 1 from pulse.hq_feature where category = $2), 0), $10, $11, $12, $13) returning id`,
      [k, pick(b.category, HQ_CATEGORIES, 'work'), name, str(b.promise, 200), str(b.what, 600), str(b.who, 120), pick(b.status, HQ_FEATURE_STATUS, 'idea'),
        /^[A-Z][A-Za-z0-9]{1,40}$/.test(String(b.icon)) ? String(b.icon) : 'Sparkles', str(b.proof, 300), b.draft === true, v.person, optPerson(b.ownerId), featureHref(b.href)]);
    return { id: r.rows[0].id, key: k };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/hq/features/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); await update(c, 'hq_feature', id(req.params.id, 'Feature not found'), featureFields(req.body), 'Feature not found'); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/hq/features/:id/remove', (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query('delete from pulse.hq_feature where id = $1', [id(req.params.id, 'Feature not found')]);
    if (!r.rowCount) fail(404, 'Feature not found'); return { ok: true };
  }));

  // Fast editing (owner, 23 Oct 2026): many features at once from a pasted list, a bulk change, a new order (leaders).
  app.post<{ Body: Body }>('/api/v0/hq/features/batch', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const list = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) as Body[] : fail(400, 'Give a list of features');
    const out: string[] = [];
    for (const b of list) {
      const name = need(b.name, 80, 'Name the feature');
      let k = key(name) ?? fail(400, 'Name the feature');
      if ((await c.query('select 1 from pulse.hq_feature where key = $1', [k])).rowCount) k = `${k.slice(0, 50)}-${Math.random().toString(36).slice(2, 8)}`;
      const category = pick(b.category, HQ_CATEGORIES, 'work');
      out.push((await c.query(`insert into pulse.hq_feature(org_id, key, category, name, promise, who, status, owner_id, sort, draft, created_by)
        values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, coalesce((select max(sort) + 1 from pulse.hq_feature where category = $2), 0), true, $8) returning id`,
        [k, category, name, str(b.promise, 200), str(b.who, 120), pick(b.status, HQ_FEATURE_STATUS, 'idea'), optPerson(b.ownerId), v.person])).rows[0].id);
    }
    return { ids: out };
  }));
  app.post<{ Body: Body }>('/api/v0/hq/features/bulk', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const ids = rows(req.body.ids); const p = (req.body.patch && typeof req.body.patch === 'object' ? req.body.patch : {}) as Body;
    const cols = featureFields(Object.fromEntries(Object.entries(p).filter(([k]) => ['category', 'status', 'ownerId', 'draft', 'archived'].includes(k))));
    if (!cols.length) fail(400, 'Choose what to change');
    const r = await c.query(`update pulse.hq_feature set ${cols.map(([col], i) => `${col} = $${i + 2}`).join(', ')}, updated_at = now() where id = any($1::uuid[])`, [ids, ...cols.map(([, x]) => x)]);
    return { ok: true, n: r.rowCount };
  }));
  app.post<{ Body: Body }>('/api/v0/hq/features/reorder', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); await c.query('update pulse.hq_feature f set sort = x.n from unnest($1::uuid[]) with ordinality as x(id, n) where f.id = x.id', [rows(req.body.ids, 1000)]);
    return { ok: true };
  }));

  // Ideas: everyone adds and votes; the author or a leader changes one; a leader turns one into a feature being built.
  app.post<{ Body: Body }>('/api/v0/hq/ideas', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const b = req.body;
    return { id: await addIdea(c, me, b) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/hq/ideas/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const ideaId = id(req.params.id, 'Idea not found'); const b = req.body;
    const row = (await c.query('select created_by from pulse.hq_idea where id = $1', [ideaId])).rows[0] ?? fail(404, 'Idea not found');
    if (row.created_by !== me) lead(v);
    const cols: [string, unknown][] = [];
    if (has(b, 'title')) cols.push(['title', need(b.title, 120, 'Give the idea a title')]);
    if (has(b, 'problem')) cols.push(['problem', str(b.problem, 1000)]);
    if (has(b, 'forWhom')) cols.push(['for_whom', str(b.forWhom, 160)]);
    if (has(b, 'impact')) cols.push(['impact', score(b.impact, 1, 5, 3)]);
    if (has(b, 'effort')) cols.push(['effort', score(b.effort, 1, 5, 3)]);
    if (has(b, 'status')) cols.push(['status', pick(b.status, HQ_IDEA_STATUS, 'new')]);
    if (has(b, 'featureKeys')) cols.push(['feature_keys', strings(b.featureKeys, 20, 64).map(key).filter(Boolean)]);
    if (has(b, 'draft')) cols.push(['draft', b.draft === true]);
    cols.push(...ideaExtras(b));
    await update(c, 'hq_idea', ideaId, cols, 'Idea not found'); return { ok: true };
  }));
  // Many ideas from a pasted list; a bulk change of stage, area or owner (the author's own, or any for a leader); a new order.
  app.post<{ Body: Body }>('/api/v0/hq/ideas/batch', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const list = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) as Body[] : fail(400, 'Give a list of ideas');
    const ids: string[] = []; for (const b of list) ids.push(await addIdea(c, me, b)); return { ids };
  }));
  app.post<{ Body: Body }>('/api/v0/hq/ideas/bulk', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const ids = rows(req.body.ids);
    if (!leadership(v) && (await c.query('select 1 from pulse.hq_idea where id = any($1::uuid[]) and created_by is distinct from $2', [ids, me])).rowCount) lead(v);
    if (req.body.remove === true) { await c.query('delete from pulse.hq_idea where id = any($1::uuid[])', [ids]); return { ok: true, n: ids.length }; }
    const p = (req.body.patch && typeof req.body.patch === 'object' ? req.body.patch : {}) as Body;
    const cols: [string, unknown][] = [];
    if (has(p, 'status')) cols.push(['status', pick(p.status, HQ_IDEA_STATUS, 'new')]);
    if (has(p, 'impact')) cols.push(['impact', score(p.impact, 1, 5, 3)]);
    if (has(p, 'effort')) cols.push(['effort', score(p.effort, 1, 5, 3)]);
    cols.push(...ideaExtras(Object.fromEntries(Object.entries(p).filter(([k]) => ['area', 'ownerId'].includes(k)))));
    if (!cols.length) fail(400, 'Choose what to change');
    const r = await c.query(`update pulse.hq_idea set ${cols.map(([col], i) => `${col} = $${i + 2}`).join(', ')}, updated_at = now() where id = any($1::uuid[])`, [ids, ...cols.map(([, x]) => x)]);
    return { ok: true, n: r.rowCount };
  }));
  app.post<{ Body: Body }>('/api/v0/hq/ideas/reorder', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); await c.query('update pulse.hq_idea i set sort = x.n from unnest($1::uuid[]) with ordinality as x(id, n) where i.id = x.id', [rows(req.body.ids, 1000)]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/hq/ideas/:id/vote', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const ideaId = id(req.params.id, 'Idea not found');
    if (!(await c.query('select 1 from pulse.hq_idea where id = $1', [ideaId])).rowCount) fail(404, 'Idea not found');
    if (req.body.on === false) await c.query('delete from pulse.hq_idea_vote where idea_id = $1 and person_id = $2', [ideaId, me]);
    else await c.query('insert into pulse.hq_idea_vote(org_id, idea_id, person_id) values (pulse.current_org(), $1, $2) on conflict do nothing', [ideaId, me]);
    return (await c.query('select count(*)::int votes, bool_or(person_id = $2) is true voted from pulse.hq_idea_vote where idea_id = $1', [ideaId, me])).rows[0];
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/hq/ideas/:id/convert', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const ideaId = id(req.params.id, 'Idea not found');
    const idea = (await c.query('select title, problem, for_whom, feature_id from pulse.hq_idea where id = $1 for update', [ideaId])).rows[0] ?? fail(404, 'Idea not found');
    if (idea.feature_id) return { featureId: idea.feature_id };
    let k = key(idea.title) ?? 'idea';
    if ((await c.query('select 1 from pulse.hq_feature where key = $1', [k])).rowCount) k = `${k.slice(0, 56)}-${Date.now().toString(36).slice(-6)}`;
    const category = pick(req.body.category, HQ_CATEGORIES, 'work');
    const f = await c.query(`insert into pulse.hq_feature(org_id, key, category, name, promise, what, who, status, icon, proof, sort, created_by)
      values (pulse.current_org(), $1, $2, $3, $4, $5, $6, 'building', 'Sparkles', 'From an idea on the Pulse HQ board',
        coalesce((select max(sort) + 1 from pulse.hq_feature where category = $2), 0), $7) returning id`,
      [k, category, String(idea.title).slice(0, 80), String(idea.problem).slice(0, 200), String(idea.problem).slice(0, 600), String(idea.for_whom).slice(0, 120), v.person]);
    await c.query(`update pulse.hq_idea set feature_id = $2, status = 'building', feature_keys = array_append(array_remove(feature_keys, $3), $3), updated_at = now() where id = $1`, [ideaId, f.rows[0].id, k]);
    return { featureId: f.rows[0].id, key: k };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/hq/ideas/:id/remove', (req) => tx(req, async (c, v) => {
    const me = person(v); const ideaId = id(req.params.id, 'Idea not found');
    const row = (await c.query('select created_by from pulse.hq_idea where id = $1', [ideaId])).rows[0] ?? fail(404, 'Idea not found');
    if (row.created_by !== me) lead(v);
    await c.query('delete from pulse.hq_idea where id = $1', [ideaId]); return { ok: true };
  }));

  // Offer Studio (leaders).
  app.post<{ Body: Body }>('/api/v0/hq/offers', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const cols = offerFields({ ...req.body, name: req.body.name ?? 'Untitled offer' });
    const names = cols.map(([col]) => col);
    const r = await c.query(`insert into pulse.hq_offer(org_id, created_by, sort, ${names.join(', ')})
      values (pulse.current_org(), $1, coalesce((select max(sort) + 1 from pulse.hq_offer), 0), ${names.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
      [v.person, ...cols.map(([, val]) => val)]);
    return { id: r.rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/hq/offers/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); await update(c, 'hq_offer', id(req.params.id, 'Offer not found'), offerFields(req.body), 'Offer not found'); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/hq/offers/:id/duplicate', (req) => tx(req, async (c, v) => {
    lead(v);
    const r = await c.query(`insert into pulse.hq_offer(org_id, name, status, icp, dream_outcome, v_dream, v_likelihood, v_time, v_effort, deliverables, bonuses, guarantee,
        scarcity, urgency, naming, anchors, currency, price, billing, positioning, brand_notes, tiers, accent, sort, draft, created_by, problems, delivery)
      select org_id, left(name || ' (copy)', 80), 'draft', icp, dream_outcome, v_dream, v_likelihood, v_time, v_effort, deliverables, bonuses, guarantee,
        scarcity, urgency, naming, anchors, currency, price, billing, positioning, brand_notes, tiers, accent, (select max(sort) + 1 from pulse.hq_offer), draft, $2,
        problems, delivery
      from pulse.hq_offer where id = $1 returning id`, [id(req.params.id, 'Offer not found'), v.person]);
    return { id: r.rows[0]?.id ?? fail(404, 'Offer not found') };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/hq/offers/:id/remove', (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query('delete from pulse.hq_offer where id = $1', [id(req.params.id, 'Offer not found')]);
    if (!r.rowCount) fail(404, 'Offer not found'); return { ok: true };
  }));

  // Positioning and brand (leaders): one document.
  app.post<{ Body: Body }>('/api/v0/hq/brand', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const b = brandBody(req.body);
    await c.query(`insert into pulse.hq_brand(org_id, body, updated_by) values (pulse.current_org(), $1, $2)
      on conflict (org_id) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = now()`, [JSON.stringify(b), v.person]);
    await c.query('insert into pulse.hq_brand_version(org_id, body, saved_by) values (pulse.current_org(), $1, $2)', [JSON.stringify(b), v.person]);
    return { brand: b };
  }));
  // Put an earlier version back (it becomes the newest version, so nothing is lost).
  app.post<{ Params: { id: string } }>('/api/v0/hq/brand/versions/:id/restore', (req) => tx(req, async (c, v) => {
    lead(v);
    const body = (await c.query('select body from pulse.hq_brand_version where id = $1', [id(req.params.id, 'Version not found')])).rows[0]?.body ?? fail(404, 'Version not found');
    await c.query(`insert into pulse.hq_brand(org_id, body, updated_by) values (pulse.current_org(), $1, $2)
      on conflict (org_id) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = now()`, [JSON.stringify(body), v.person]);
    await c.query('insert into pulse.hq_brand_version(org_id, body, saved_by) values (pulse.current_org(), $1, $2)', [JSON.stringify(body), v.person]);
    return { brand: body };
  }));
}
