// FEATURES-1024 (owner, 23 Oct 2026): Product Story, for any organisation (story_product, story_version). A product's
// story from the first idea to now: each version with its stage, date, summary, what changed (new / improved / fixed /
// removed), media (screenshots, videos, tutorials, docs, demos as links), how its tests went and the release it is.
// Everyone in the organisation reads, adds and edits; its leaders remove.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 30 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const STORY_STAGES = ['idea', 'prototype', 'beta', 'live', 'retired'] as const;
export const CHANGE_KINDS = ['new', 'improved', 'fixed', 'removed'] as const;
export const MEDIA_KINDS = ['screenshot', 'video', 'tutorial', 'doc', 'demo'] as const;

const str = (x: unknown, max: number) => String(x ?? '').trim().slice(0, max);
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const id = (x: unknown, what: string) => UUID.test(String(x)) ? String(x) : fail(404, what);
const person = (v: Viewer) => { if (!v.person) fail(403, 'Product Story belongs to the people of an organisation.'); return v.person; };
const lead = (v: Viewer) => { if (!leadership(v)) fail(403, 'Only the organisation’s leaders remove this.'); };
const pick = <T extends string>(x: unknown, list: readonly T[], fallback: T) => (list as readonly string[]).includes(String(x)) ? String(x) as T : fallback;
const https = (x: unknown) => { const u = str(x, 290); return /^https:\/\/\S{3,}$/.test(u) ? u : null; };
const date = (x: unknown) => { if (x === null || x === undefined || x === '') return null; const s = String(x); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : fail(400, 'Choose a valid date'); };
const changes = (x: unknown) => Array.isArray(x) ? x.slice(0, 200).map((c: Body) => ({ kind: pick(c?.kind, CHANGE_KINDS, 'new'), text: str(c?.text, 300) })).filter((c) => c.text) : fail(400, 'Give the changes as a list');
const media = (x: unknown) => Array.isArray(x) ? x.slice(0, 60).map((m: Body) => ({ kind: pick(m?.kind, MEDIA_KINDS, 'doc'), url: https(m?.url), label: str(m?.label, 120) }))
  .filter((m) => m.url) : fail(400, 'Give the media as a list');
const tests = (x: unknown) => { const t = (x && typeof x === 'object' && !Array.isArray(x) ? x : {}) as Body; const n = (v: unknown) => v === '' || v === null || v === undefined ? null : Math.max(0, Math.min(1e6, Math.round(Number(v) || 0)));
  return { passed: n(t.passed), failed: n(t.failed), note: str(t.note, 300), url: https(t.url) }; };

const PRODUCTS = `select p.id, p.name, p.blurb, p.repo_url "repoUrl", p.sort, p.created_at "createdAt", p.updated_at "updatedAt"
  from pulse.story_product p order by p.sort, lower(p.name)`;
const VERSIONS = `select v.id, v.product_id "productId", v.label, v.title, v.stage, v.released_on::text "releasedOn", v.summary, v.changes, v.media, v.tests,
    v.release_ref "releaseRef", v.created_at "createdAt", v.updated_at "updatedAt", p.display_name "by"
  from pulse.story_version v left join pulse.person p on p.id = v.created_by order by v.released_on desc nulls first, v.created_at desc`;

async function update(c: PoolClient, table: string, rowId: string, cols: [string, unknown][], what: string) {
  if (!cols.length) return;
  try {
    const r = await c.query(`update pulse.${table} set ${cols.map(([col], i) => `${col} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [rowId, ...cols.map(([, x]) => x)]);
    if (!r.rowCount) fail(404, what);
  } catch (e) { if ((e as { code?: string }).code === '23505') fail(409, table === 'story_product' ? 'A product with that name is already here' : 'That version label is already in this story'); throw e; }
}
function versionCols(b: Body) {
  const cols: [string, unknown][] = [];
  if (has(b, 'label')) { const l = str(b.label, 40); if (!l) fail(400, 'Give the version a label, such as v1.2 or Idea'); cols.push(['label', l]); }
  if (has(b, 'title')) cols.push(['title', str(b.title, 120)]);
  if (has(b, 'stage')) cols.push(['stage', pick(b.stage, STORY_STAGES, 'live')]);
  if (has(b, 'releasedOn')) cols.push(['released_on', date(b.releasedOn)]);
  if (has(b, 'summary')) cols.push(['summary', String(b.summary ?? '').replace(/\r\n/g, '\n').slice(0, 4000)]);
  if (has(b, 'changes')) cols.push(['changes', JSON.stringify(changes(b.changes))]);
  if (has(b, 'media')) cols.push(['media', JSON.stringify(media(b.media))]);
  if (has(b, 'tests')) cols.push(['tests', JSON.stringify(tests(b.tests))]);
  if (has(b, 'releaseRef')) cols.push(['release_ref', str(b.releaseRef, 120)]);
  return cols;
}

export function registerStoryRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/story', (req) => tx(req, async (c, v) => {
    person(v);
    const [products, versions] = await Promise.all([c.query(PRODUCTS), c.query(VERSIONS)]);
    return { canRemove: leadership(v), products: products.rows, versions: versions.rows };
  }));
  app.post<{ Body: Body }>('/api/v0/story/products', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const name = str(req.body.name, 80); if (name.length < 2) fail(400, 'Name the product');
    try {
      const r = await c.query(`insert into pulse.story_product(org_id, name, blurb, repo_url, sort, created_by)
        values (pulse.current_org(), $1, $2, $3, coalesce((select max(sort) + 1 from pulse.story_product), 0), $4) returning id`, [name, str(req.body.blurb, 600), https(req.body.repoUrl), me]);
      return { id: r.rows[0].id };
    } catch (e) { if ((e as { code?: string }).code === '23505') fail(409, 'A product with that name is already here'); throw e; }
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/story/products/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const b = req.body; const cols: [string, unknown][] = [];
    if (has(b, 'name')) { const n = str(b.name, 80); if (n.length < 2) fail(400, 'Name the product'); cols.push(['name', n]); }
    if (has(b, 'blurb')) cols.push(['blurb', str(b.blurb, 600)]);
    if (has(b, 'repoUrl')) cols.push(['repo_url', https(b.repoUrl)]);
    await update(c, 'story_product', id(req.params.id, 'Product not found'), cols, 'Product not found');
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/story/products/:id/remove', (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query('delete from pulse.story_product where id = $1', [id(req.params.id, 'Product not found')]);
    if (!r.rowCount) fail(404, 'Product not found'); return { ok: true };
  }));
  app.post<{ Body: Body }>('/api/v0/story/versions', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const productId = id(req.body.productId, 'Product not found');
    if (!(await c.query('select 1 from pulse.story_product where id = $1', [productId])).rowCount) fail(404, 'Product not found');
    const cols = versionCols({ stage: 'live', ...req.body, label: req.body.label ?? '' });
    try {
      const r = await c.query(`insert into pulse.story_version(org_id, product_id, created_by, ${cols.map(([col]) => col).join(', ')})
        values (pulse.current_org(), $1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) returning id`, [productId, me, ...cols.map(([, x]) => x)]);
      return { id: r.rows[0].id };
    } catch (e) { if ((e as { code?: string }).code === '23505') fail(409, 'That version label is already in this story'); throw e; }
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/story/versions/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); await update(c, 'story_version', id(req.params.id, 'Version not found'), versionCols(req.body), 'Version not found'); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/story/versions/:id/remove', (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query('delete from pulse.story_version where id = $1', [id(req.params.id, 'Version not found')]);
    if (!r.rowCount) fail(404, 'Version not found'); return { ok: true };
  }));
}
