import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { hostCompany } from './tenant-context.js';
import type { Installation } from './installation.js';
import { isServiceKey, withServiceKey } from './service-key.js';

const PATH = '/api/v1/catalog/';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^Bearer pcat_(${UUID})_([A-Za-z0-9_-]{43})$`);
export type CatalogItem = { id: string; kind: string; name: string; description: string; price: number; currency: 'INR'; taxRate: number; publicLink: string | null };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const STYLE = `:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:light-dark(#f6f7f9,#11151c);color:light-dark(#18202e,#edf0f5)}
body{margin:0;padding:32px 16px}main{box-sizing:border-box;max-width:720px;margin:auto;padding:clamp(20px,5vw,40px);background:light-dark(#fff,#1b2330);border:1px solid light-dark(#dde2ea,#364256);border-radius:16px}h1{font-size:clamp(24px,5vw,36px);line-height:1.2;margin:0 0 28px;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:20px 16px;margin:0}dt{font-size:14px;color:light-dark(#526078,#aebbd0)}dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}dd:empty:after{content:'—'}`;

/** Runs before staff/operator/public routes: a catalogue credential never falls back to a browser session. */
export function catalogScope(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (/^Bearer\s+pcat_/i.test(request.headers.authorization ?? '') &&
        (request.method !== 'GET' || request.url.split('?')[0] !== PATH + 'items')) {
      request.log.info({ catalogKeyId: KEY.exec(request.headers.authorization ?? '')?.[1] ?? null, result: 'scope_refused' }, 'Catalogue access');
      return reply.code(403).send({ error: 'catalog.read scope excludes this endpoint' });
    }
  });
}

export function registerCatalog(app: FastifyInstance, pool: Pool, installation: Installation) {
  let start = Date.now(), count = 0;
  const run = async <T>(work: (c: import('pg').PoolClient) => Promise<T>) => {
    const c = await pool.connect();
    try { await c.query('begin'); const result = await work(c); await c.query('commit'); return result; }
    catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  };
  void app.register(async scope => {
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      // A fixed per-process install budget: no per-token maps, timers or unbounded attacker-controlled keys.
      // psvc_ reads spend the service-key budgets instead (authenticated and failed-auth counted apart).
      if (Date.now() - start >= 60_000) { start = Date.now(); count = 0; }
      if (!isServiceKey(request.headers.authorization) && ++count > 120) return reply.header('retry-after', '60').code(429).send({ error: 'Catalogue rate limit' });
      if (request.method !== 'GET') return reply.code(405).send({ error: 'GET required' });
      if (hostCompany() && hostCompany()!.org !== await installation.readOrg()) return reply.code(403).send({ error: 'Install-local catalogue only' });
      if (request.url.includes('?')) return reply.code(400).send({ error: 'Query parameters are not supported' });
    });
    scope.get(PATH + 'items', { exposeHeadRoute: false }, async (request, reply) => {
      if (isServiceKey(request.headers.authorization)) return withServiceKey(request, reply, 'catalog.read', async (c, id) => ({
        items: (await c.query('select pulse.service_key_catalog($1) items', [id])).rows[0].items as CatalogItem[],
      }));
      const match = KEY.exec(request.headers.authorization ?? '');
      const result = match ? await run(async c => {
        const hash = createHash('sha256').update(match[2]).digest();
        const stored = (await c.query('select pulse.catalog_key_hash($1) hash', [match[1]])).rows[0]?.hash;
        if (!timingSafeEqual(hash, Buffer.from(stored ?? '0'.repeat(64), 'hex')) || !stored) return null;
        return (await c.query('select pulse.catalog_read($1,$2) items', [match[1], hash.toString('hex')])).rows[0].items as CatalogItem[] | null;
      }) : null;
      request.log.info({ catalogKeyId: match?.[1] ?? null, result: result ? 'read' : 'refused' }, 'Catalogue access');
      return result ? { items: result } : reply.code(401).send({ error: 'Invalid catalogue credential' });
    });
    scope.get<{ Params: { token: string } }>(PATH + 'offers/:token', { exposeHeadRoute: false }, async (request, reply) => {
      const item = await run(async c => (await c.query('select pulse.catalog_public($1) item', [request.params.token])).rows[0].item as CatalogItem | null);
      if (!item) return reply.code(404).send({ error: 'Offer unavailable' });
      reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'").header('x-content-type-options', 'nosniff');
      const labels: Record<string,string> = { id:'Offer ID', kind:'Type', name:'Name', description:'Description', price:'Price before GST (INR)', currency:'Currency', taxRate:'GST (%)', publicLink:'Public link' };
      const fields = Object.entries(item).map(([key, value]) => `<dt>${labels[key]}</dt><dd>${escape(key === 'price' ? (item.price / 100).toFixed(2) : String(value ?? ''))}</dd>`).join('');
      return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(item.name)}</title><style>${STYLE}</style><main><h1>${escape(item.name)}</h1><dl>${fields}</dl></main></html>`);
    });
  });
}

/** Registered inside the existing operator authentication boundary; never accepts or returns a raw service key. */
export function registerCatalogOperator(scope: FastifyInstance, run: <T>(work: (c: import('pg').PoolClient) => Promise<T>) => Promise<T>) {
  scope.post<{ Body: { action: string; id: string; hash?: string } }>('/api/v1/operator/catalog', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['action','id'], properties: {
      action: { type: 'string', enum: ['issue','revoke','share','unshare'] }, id: { type: 'string', pattern: `^${UUID}$` }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    } } },
  }, request => run(async c => {
    const { action, id, hash } = request.body;
    if ((action === 'issue') !== !!hash) throw Object.assign(new Error('A digest is required only for issue'), { statusCode: 400 });
    const token = action === 'share' ? randomBytes(32).toString('base64url') : null;
    await c.query('select pulse.catalog_manage($1,$2,$3)', [action, id, hash ?? token]);
    return { id, ...(token ? { publicLink: PATH + 'offers/' + token } : {}) };
  }));
}
