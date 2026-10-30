import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Installation } from './installation.js';
import { hostCompany } from './tenant-context.js';
import { budget, type Budget } from './v1-limits.js';
export { budget } from './v1-limits.js';

const PREFIX = '/api/v1/service/';
const ADMIN = '/api/v1/operator/service-keys';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^Bearer psvc_(${UUID})_([A-Za-z0-9_-]{43})$`);
const CHAT = new RegExp(`^${PREFIX}chats/${UUID}/messages$`);
const REQUEST_PROGRESS = new RegExp(`^${PREFIX}update-requests/${UUID}/progress$`);
// The route validates its UUID, so malformed ids answer 400 inside this allowed operation.
const NOTICE = new RegExp(`^${PREFIX}quotes/[^/]+/ready-notice$`);
export const LEGACY_SCOPES = ['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready','chats.post','updates.post','updates.requests.manage'] as const;
/** EST-1788: the twenty API v1 area grants (pulse.v1_scopes() in 0670). Explicit only; no legacy scope stands for one. */
export const V1_SCOPES = ['tasks.read','tasks.write','projects.read','projects.write','people.read','people.write','chats.read','chats.write',
  'docs.read','docs.write','billing.read','billing.write','workflows.read','workflows.write','companies.read','companies.write',
  'search.read','search.write','events.read','events.write'] as const;
export type V1Scope = typeof V1_SCOPES[number];
export const SERVICE_SCOPES: readonly string[] = [...LEGACY_SCOPES, ...V1_SCOPES];
export type ServiceScope = typeof LEGACY_SCOPES[number];
/** chats.post or any v1 scope acts as one bound AI member (service_key_agent_check). */
export const needsAgent = (scopes: readonly string[]) => scopes.some(s => s === 'chats.post' || (V1_SCOPES as readonly string[]).includes(s));
/** EST-1611: /api/v1/<area>/… belongs to the v1 front door (v1.ts); the service hooks below stand aside there. */
const V1_PATH = new RegExp(`^/api/v1/(?:${[...new Set(V1_SCOPES.map(s => s.split('.')[0]))].join('|')})(?:[/?]|$)`);
export const isV1Path = (url: string) => V1_PATH.test(url);
declare module 'fastify' { interface FastifyInstance { serviceKeyContext: { pool: Pool; installation: Installation }; serviceBudget: { authed: Budget; failed: Budget } } }
export const isServiceKey = (authorization: string | undefined) => /^Bearer\s+psvc_/i.test(authorization ?? '');
const allowed = (method: string, path: string) => method === 'GET'
  ? ['/api/v1/catalog/items', PREFIX+'clients', PREFIX+'leads', PREFIX+'tasks/mine', PREFIX+'people', PREFIX+'update-requests'].includes(path)
  : method === 'POST' && (path === PREFIX+'quotes' || path === PREFIX+'updates' || path === PREFIX+'update-requests' || REQUEST_PROGRESS.test(path) || NOTICE.test(path) || CHAT.test(path));
const headers = (reply: FastifyReply) => reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
const limited = (reply: FastifyReply) => reply.header('retry-after','60').code(429).send({ error: 'Service rate limit' });
/** Refusals before authentication spend only the failed-auth budget, so junk credentials cannot starve valid keys. */
const refuseUnauthenticated = (request: FastifyRequest, reply: FastifyReply, status: number, error: string) =>
  request.server.serviceBudget.failed() ? limited(reply) : reply.code(status).send({ error });

/** Before all staff hooks: service credentials cannot become a browser/staff viewer. */
export function serviceScope(app: FastifyInstance) {
  // 120/min for authenticated requests; failed authentication and pre-auth refusals have their own 120/min.
  app.decorate('serviceBudget', { authed: budget(120), failed: budget(120) });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path.startsWith(PREFIX) || (path === '/api/v1/catalog/items' && isServiceKey(request.headers.authorization))) headers(reply);
    if (!isServiceKey(request.headers.authorization) || path === '/api/v1/mcp' || isV1Path(path) || isV1Path(request.routeOptions.url ?? '')) return;
    headers(reply);
    if (!allowed(request.method, request.url.split('?')[0])) {
      request.log.info({ serviceKeyId: KEY.exec(request.headers.authorization ?? '')?.[1] ?? null, scope: null, result: 'scope_refused' });
      return refuseUnauthenticated(request, reply, 403, 'Service key scope excludes this endpoint');
    }
    for (const key of Object.keys(request.headers)) if (key === 'cookie' || key === 'x-pulse-session' || key.startsWith('cf-access-') || key.startsWith('x-dev-')) delete request.headers[key];
  });
}

export function registerServiceKeys(app: FastifyInstance, pool: Pool, installation: Installation) {
  app.decorate('serviceKeyContext', { pool, installation });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith(PREFIX) && !(path === '/api/v1/catalog/items' && isServiceKey(request.headers.authorization))) return;
    headers(reply);
    if (hostCompany() && hostCompany()!.org !== await installation.readOrg()) return refuseUnauthenticated(request, reply, 403, 'Install-local service only');
    const query = new URLSearchParams(request.url.split('?')[1]);
    const pagination = path === PREFIX+'clients' || path === PREFIX+'leads';
    // Contract 1.1 (EST-1294): the clients and leads reads also take `phone` (alone; service-reads.ts refuses mixing it).
    const queryKeys = path === PREFIX+'update-requests' && request.method === 'GET' ? ['status','onBehalfOf','cursor','limit'] : pagination ? ['cursor','limit','phone'] : path === PREFIX+'people' ? ['cursor','limit'] : [];
    if ([...query.keys()].some(k => !queryKeys.includes(k))) return refuseUnauthenticated(request, reply, 400, 'Unknown query parameter');
    // No well-formed credential: answer 401 here, before body/header validation, as withServiceKey would (EST-1521:
    // a signed-out POST with an invalid body got 400 and failed the release smoke's anonymous contract).
    if (!KEY.test(request.headers.authorization ?? '')) {
      request.log.info({ serviceKeyId: null, scope: null, result: 'invalid' });
      return refuseUnauthenticated(request, reply, 401, 'Invalid service credential');
    }
  });
}

/** The sole service handler entry point: authenticate and run work on the same transaction/client. */
export async function withServiceKey<T>(request: FastifyRequest, reply: FastifyReply, scope: ServiceScope | V1Scope,
  work: (c: PoolClient, keyId: string, hash: string) => Promise<T>): Promise<T | FastifyReply> {
  headers(reply);
  const match = KEY.exec(request.headers.authorization ?? '');
  const log = (result: string) => request.log.info({ serviceKeyId: match?.[1] ?? null, scope, result });
  const { authed, failed } = request.server.serviceBudget;
  const refuse = (status: number) => { log(status === 401 ? 'invalid' : 'scope_refused');
    if (status === 401 ? failed() : authed()) return limited(reply);
    return reply.code(status).send({ error: status === 401 ? 'Invalid service credential' : 'Service key lacks required scope' }); };
  if (!match) return refuse(401);
  const { pool, installation } = request.server.serviceKeyContext;
  if (hostCompany() && hostCompany()!.org !== await installation.readOrg()) { log('scope_refused'); return failed() ? limited(reply) : reply.code(403).send({ error: 'Service key lacks required scope' }); }
  const c = await pool.connect();
  try {
    await c.query('begin');
    const hash = createHash('sha256').update(match[2]).digest();
    const stored = (await c.query('select pulse.service_key_hash($1) hash', [match[1]])).rows[0]?.hash;
    if (!timingSafeEqual(hash, Buffer.from(stored ?? '0'.repeat(64),'hex')) || !stored) {
      await c.query('rollback'); return refuse(401);
    }
    const authorized = (await c.query('select pulse.service_key_auth($1,$2,$3) ok', [match[1], hash.toString('hex'), scope])).rows[0]?.ok;
    if (!authorized) {
      const active = (await c.query('select pulse.service_key_hash($1) hash', [match[1]])).rows[0]?.hash;
      await c.query('rollback'); return refuse(active ? 403 : 401);
    }
    if (authed()) { await c.query('rollback'); log('rate_limited'); return limited(reply); }
    const result = await work(c, match[1], hash.toString('hex'));
    await c.query('commit'); log('ok'); return result;
  } catch (error) { await c.query('rollback'); log((error as { statusCode?: number }).statusCode === 429 ? 'rate_limited' : 'error'); throw error; }
  finally { c.release(); }
}

/** Called only inside the existing operator authentication boundary. */
export function registerServiceKeyOperator(app: FastifyInstance, run: <T>(work: (c: PoolClient) => Promise<T>) => Promise<T>) {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] !== ADMIN) return;
    headers(reply);
    if (request.url.includes('?')) return reply.code(400).send({ error: 'Query parameters are not supported' });
  });
  app.get(ADMIN, { exposeHeadRoute: false }, () => run(async c => ({ keys: (await c.query('select pulse.service_key_list() keys')).rows[0].keys })));
  app.post<{ Body: { action: string; id: string; hash?: string; scopes?: string[]; label?: string; agentId?: string } }>(ADMIN, {
    schema: { body: { type: 'object', additionalProperties: false, required: ['action','id'], properties: {
      action: { type: 'string', enum: ['issue','revoke'] }, id: { type: 'string', pattern: `^${UUID}$` }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      agentId: { type: 'string', pattern: `^${UUID}$` },
      scopes: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: SERVICE_SCOPES } }, label: { type: 'string', minLength: 1, maxLength: 60 },
    } } },
  }, async (request, reply) => {
    const { action, id, hash, scopes, label, agentId } = request.body;
    if (action === 'issue' ? hash === undefined || scopes === undefined || label === undefined : hash !== undefined || scopes !== undefined || label !== undefined || agentId !== undefined) return reply.code(400).send({ error: 'Issue requires digest scopes and label; revoke takes only id' });
    if (action === 'issue' && needsAgent(scopes!) !== (agentId !== undefined)) return reply.code(400).send({ error: 'Bind chats.post and v1 scopes to exactly one AI member' });
    return run(async c => { await c.query('select pulse.service_key_manage($1,$2,$3,$4,$5,$6)', [action,id,hash,scopes,label,agentId]); return { id }; });
  });
}
