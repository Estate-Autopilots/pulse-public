// EST-1611 (CTO ruling on this card, 19 Oct 2026): API v1's one front door. A call carries one bearer key and nothing
// else: psvc_ (a connected app), pak_ (an AI employee) or a personal token through the resolver EST-1617 registers. The
// key becomes a principal only inside a security-definer function on the call's own `open` transaction (0670): it checks
// the operation's area scope and the tenant and makes the AI member (or the person) the viewer, so row security and the
// chat checks decide what the call reaches, exactly as on the screens. This code never sets a viewer. A cookie, session
// or Access identity beside the key is refused (401), never stripped or used. Operations are declared once
// (defineV1Operation): their Fastify routes and the OpenAPI document (openapi/v1.yaml, compared by test/v1.test.mjs in
// the API's test run) both come from that registry.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { load } from 'js-yaml';
import type { Pool, PoolClient } from 'pg';
import { limitHeaders, tokenBudgets } from './v1-limits.js';
import { PAGE_QUERY } from './v1-paging.js';
import { auditV1 } from './v1-audit.js';
import { replayBefore, replayAfter, requestKey } from './v1-idempotency.js';
import type { Open } from './routes.js';
import { isV1Path, V1_SCOPES, type V1Scope } from './service-key.js';

type Schema = { [keyword: string]: unknown };
/** Every object in a v1 schema is closed (additionalProperties: false): an unknown field is a 400, never ignored. */
export type Closed = Schema & { type: 'object'; additionalProperties: false; properties: Record<string, Schema>; required?: string[] };
export type Principal = { kind: 'app' | 'ai' | 'person'; /** the person row security sees */ id: string; /** Actual token row UUID, for every key kind. */ tokenId: string; actor: string };
export type V1Context = { client: PoolClient; principal: Principal; requestId: string; tenantId: string };
/** Path and query values arrive as strings: declare them as strings with a pattern. */
export type V1Input = { params: Record<string, string>; query: Record<string, string>; body: unknown };
export type V1Operation = { operationId: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; scope: V1Scope; summary: string;
  params?: Closed; query?: Closed; body?: Closed; response: Closed;
  /** Resource permission/membership checks, repeated on every attempt including replays. Required for writes. */
  authorize?: (ctx: V1Context, input: V1Input) => Promise<void>;
  /** Runs as the principal on its transaction. Resource access checks belong in authorize. It may only refuse more (v1Fail(403 | 404, …)), never widen. */
  handler: (ctx: V1Context, input: V1Input) => Promise<unknown> };

/** EST-1617's extension point. `resolve` calls one SQL principal function shaped like v1_agent_principal on this
 *  transaction (the database sets the viewer and actor_account and the token's id comes back, or null with nothing set);
 *  `live` says whether the token is valid at all, so a live token without the scope answers 403 and anything else 401. */
export type PersonalResolver = { pattern: RegExp; resolve: (c: PoolClient, token: string, scope: V1Scope) => Promise<string | null>;
  live: (c: PoolClient, token: string) => Promise<boolean> };
let personal: PersonalResolver | undefined;
export function registerPersonalResolver(resolver: PersonalResolver) {
  if (personal) throw Error('API v1 takes one personal-token resolver');
  personal = resolver;
}

export type V1Call = { requestId: string; operationId: string | null; principal: Omit<Principal, 'actor'> | null; status: number; ms: number; tenantId: string | null; routeTemplate: string | null; idempotencyKey: string | null };
/** EST-1612 (audit, idempotency) and EST-1613 (paging, limits) attach here and never touch authentication.
 *  before:  on the call's transaction, after the principal and the input are checked; reply carries limit headers. Throw v1Fail to refuse (limits),
 *           or propose a replay. All before hooks run in attachment order; the first defined replay skips only the handler.
 *  after:   on the same transaction, before commit, for handler AND replay answers: record or shape the answer; returns it.
 *           Answers are schema-checked before after hooks and again after all transformations, before commit/send.
 *  settled: once the response is sent, refusals before any transaction included; ids and numbers only. */
export type V1Seam = {
  before?: (ctx: V1Context, op: V1Operation, input: V1Input, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  after?: (ctx: V1Context, op: V1Operation, input: V1Input, answer: unknown, reply: FastifyReply) => Promise<unknown>;
  settled?: (call: V1Call) => void;
};
const seams: V1Seam[] = [];
export const attachV1Seam = (seam: V1Seam) => { seams.push(seam); };

export class V1Problem extends Error { constructor(readonly status: number, detail: string) { super(detail); } }
export const v1Fail = (status: number, detail: string): never => { throw new V1Problem(status, detail); };
/** Every refusal or failure: application/problem+json with the call's request id (also in X-Request-Id). */
export const PROBLEM: Closed = { type: 'object', additionalProperties: false, required: ['type', 'title', 'status', 'detail', 'requestId'], properties: {
  type: { const: 'about:blank' }, title: { type: 'string' }, status: { type: 'integer', minimum: 400, maximum: 599 }, detail: { type: 'string' },
  requestId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } };
const TITLE: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  413: 'Content Too Large', 415: 'Unsupported Media Type', 429: 'Too Many Requests', 503: 'Service Unavailable' };
const PG: Record<string, number> = { '42501': 403, '22023': 400, '22P02': 400, '22007': 400, '23514': 400, P0002: 404, '23505': 409, '23503': 409, '40001': 409, '54000': 409 };
const calls = new WeakMap<FastifyRequest, { requestId: string; start: number; operationId: string | null; principal: Principal | null; tenantId: string | null; routeTemplate: string | null; idempotencyKey: string | null }>();
const problem = (request: FastifyRequest, reply: FastifyReply, status: number, detail: string) => {
  // All 401s, including resolver refusals, spend this separate budget exactly once; valid keys never spend it.
  if (status === 401) {
    const failed = request.server.serviceBudget.failed, limited = failed();
    const state = failed.state(); limitHeaders(reply, state);
    if (limited) { status = 429; detail = 'API authentication rate limit'; reply.header('retry-after', state.reset); }
  }
  if (status === 429 && !reply.hasHeader('retry-after')) reply.header('retry-after', reply.getHeader('ratelimit-reset') ?? 60);
  const requestId = calls.get(request)?.requestId ?? randomUUID();
  return reply.header('cache-control', 'no-store').header('x-request-id', requestId).code(status).type('application/problem+json')
    .send({ type: 'about:blank', title: TITLE[status] ?? (status < 500 ? 'Bad Request' : 'Internal Server Error'), status, detail, requestId });
};
/** Setup/company hooks keep legacy errors; only requests initialized by the v1 front door use its wire contract. */
export const isV1Call = (request: FastifyRequest) => calls.has(request);
export const v1Refusal = (request: FastifyRequest, reply: FastifyReply, status: number, detail: string) =>
  isV1Call(request) ? problem(request, reply, status, detail) : reply.code(status).send({ error: detail });

function onError(error: FastifyError & { where?: string }, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof V1Problem) return problem(request, reply, error.status, error.message);
  const status = error.statusCode ?? PG[error.code] ?? 500;
  // Fastify's own refusals (body, media type, size) and sentences Pulse's database functions raise for people keep their words.
  const said = status < 500 && (error.statusCode !== undefined || (/PL\/pgSQL function /.test(error.where ?? '') && /\s/.test(error.message) && !/[{}()"]/.test(error.message)));
  if (status >= 500) request.log.error({ code: error.code ?? 'unknown', requestId: calls.get(request)?.requestId }, 'API v1 call failed');
  return problem(request, reply, status, said ? error.message : status < 500 ? 'The request was refused' : 'Pulse data is temporarily unavailable');
}

const SERVICE = /^Bearer psvc_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const AGENT = /^Bearer (pak_([0-9a-f]{8})_[0-9a-f]{64})$/;
const TOKEN = /^Bearer ([\x21-\x7e]{16,512})$/;
const keyed = (auth: unknown) => typeof auth === 'string' && (SERVICE.test(auth) || AGENT.test(auth) || !!personal?.pattern.test(TOKEN.exec(auth)?.[1] ?? ''));
// Anything that names a person beside the key: refused, never stripped or used.
const beside = (h: string) => ['cookie', 'x-pulse-session', 'x-pulse-client-session', 'x-pulse-agent-key', 'x-pulse-access-id'].includes(h)
  || h.startsWith('cf-access-') || h.startsWith('x-dev-');
const REFUSED = 'This key is unknown here, revoked or expired, or its member is switched off';

async function resolve(c: PoolClient, auth: string, scope: V1Scope): Promise<Principal> {
  const app = SERVICE.exec(auth), ai = AGENT.exec(auth), token = TOKEN.exec(auth)?.[1] ?? '';
  const one = async (sql: string, args: unknown[]) => (await c.query(sql, args)).rows[0]?.v ?? null;
  let tokenId: string | null = null, live: () => Promise<boolean>;
  if (app) {
    const hash = createHash('sha256').update(app[2]).digest('hex');
    if (await one('select pulse.v1_service_principal($1,$2,$3) v', [app[1], hash, scope])) tokenId = app[1];
    live = async () => { const stored: string | null = await one('select pulse.service_key_hash($1) v', [app[1]]);
      return stored !== null && timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(hash, 'hex')); };
  } else if (ai) {
    if (await one('select pulse.v1_agent_principal($1,$2) v', [ai[1], scope])) tokenId = await one('select pulse.v1_agent_token_id($1,$2) v', [ai[2], scope]);
    live = async () => await one('select pulse.agent_key_resolve($1) v', [ai[1]]) !== null;
  } else {
    tokenId = await personal!.resolve(c, token, scope);
    live = () => personal!.live(c, token);
  }
  if (!tokenId) { const status = await live() ? 403 : 401; v1Fail(status, status === 403 ? `This key may not use ${scope} here` : REFUSED); }
  // The principal is whoever the database function made the viewer; it is never taken from the request.
  const row = (await c.query("select pulse.current_viewer() id, nullif(current_setting('pulse.actor_account',true),'') actor")).rows[0];
  if (!row?.id || !row.actor) v1Fail(401, REFUSED);
  await c.query("select set_config('pulse.v1_token_id',$1,true)", [tokenId]);
  return { kind: app ? 'app' : ai ? 'ai' : 'person', id: row.id, tokenId: tokenId!, actor: row.actor };
}

const operations: V1Operation[] = [];
const ajv = new Ajv2020({ allErrors: false, strict: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
const closed = (s: unknown): boolean => typeof s !== 'object' || s === null
  || (((s as Schema).type !== 'object' || (s as Schema).additionalProperties === false) && Object.values(s).every(closed));
const pathParams = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
/** The one way to add an API v1 operation; its route and its OpenAPI entry follow from it. */
export function defineV1Operation(op: V1Operation) {
  if ((op.method !== 'GET' && typeof op.authorize !== 'function') || !isV1Path(op.path) || !/^[a-z][A-Za-z0-9]*$/.test(op.operationId) || !V1_SCOPES.includes(op.scope) || ![op.params, op.query, op.body, op.response].every(closed)
      || pathParams(op.path) !== Object.keys(op.params?.properties ?? {}).sort().join()
      || operations.some(o => o.operationId === op.operationId || (o.method === op.method && o.path === op.path))) {
    throw Error(`API v1 operation ${op.operationId} is malformed, duplicated or not closed`);
  }
  operations.push(op);
}
export const v1Operations = (): readonly V1Operation[] => operations;

function route(open: Open, op: V1Operation, spend: ReturnType<typeof tokenBudgets>) {
  const empty = (x: unknown) => x === undefined || (typeof x === 'object' && x !== null && Object.keys(x).length === 0);
  const check = { params: op.params ? ajv.compile(op.params) : empty, query: op.query ? ajv.compile(op.query) : empty,
    body: op.body ? ajv.compile(op.body) : (x: unknown) => x === undefined };
  const answers = ajv.compile(op.response);
  const checked = (answer: unknown) => {
    if (!answers(answer)) throw Object.assign(Error('API v1 answer outside its schema'), { code: 'v1_response' });
    return answer;
  };
  return (request: FastifyRequest, reply: FastifyReply) => {
    const call = calls.get(request);
    if (!call) return problem(request, reply, 404, 'No such API v1 operation');
    return open(async (c, org) => {
      call.tenantId = org;
      call.operationId = op.operationId;
      const principal = call.principal = await resolve(c, request.headers.authorization!, op.scope);
      const state = spend(org, principal.tokenId); limitHeaders(reply, state);
      if (state.limited) { reply.header('retry-after', state.reset); v1Fail(429, 'API token rate limit'); }
      const input = { params: request.params, query: request.query, body: request.body } as V1Input;
      for (const part of ['params', 'query', 'body'] as const) {
        const valid = check[part];
        if (valid(input[part])) continue;
        const why = 'errors' in valid ? valid.errors?.[0] : undefined;
        v1Fail(400, `Unknown or invalid ${part}${why ? `: ${why.instancePath || '/'} ${why.message}` : ''}`);
      }
      const ctx: V1Context = { client: c, principal, requestId: call.requestId, tenantId: org };
      let answer: unknown = await replayBefore(ctx, op, input, request, reply), replay = answer !== undefined;
      await op.authorize?.(ctx, input);
      for (const seam of seams) {
        const stored = await seam.before?.(ctx, op, input, request, reply);
        if (stored !== undefined && !replay) { answer = stored; replay = true; }
      }
      if (!replay) answer = await op.handler(ctx, input);
      checked(answer);
      for (const seam of seams) if (seam.after) answer = await seam.after(ctx, op, input, answer, reply);
      checked(answer);
      return checked(await replayAfter(ctx, op, answer, reply));
    });
  };
}

/** Called first in createApp, before the catalogue, service and tenant hooks see (or strip) a header. */
export function v1Scope(app: FastifyInstance, pool?: Pick<Pool, 'query'>) {
  app.addHook('onRequest', async (request, reply) => {
    if (!isV1Path(request.url) && !isV1Path(request.routeOptions.url ?? '')) return;
    limitHeaders(reply, { limit: 120, remaining: 120, reset: 60 });
    const requestId = randomUUID();
    const op = operations.find(o => o.method === request.method && o.path.replace(/\{(\w+)\}/g, ':$1') === request.routeOptions.url);
    calls.set(request, { requestId, start: performance.now(), operationId: op?.operationId ?? null, routeTemplate: op?.path ?? null,
      idempotencyKey: requestKey(request.headers['idempotency-key']), tenantId: null, principal: null });
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-request-id', requestId);
    // 401 first, before the route, method, query or body is looked at (as the service paths answer, EST-1521).
    if (!keyed(request.headers.authorization) || Object.keys(request.headers).some(beside)) {
      return problem(request, reply, 401, 'Send one API key as Authorization: Bearer, with no sign-in beside it');
    }
    if (!request.routeOptions.url) return problem(request, reply, 404, 'No such API v1 operation');
  });
  app.addHook('onResponse', async (request, reply) => {
    const call = calls.get(request);
    if (!call) return;
    const { start, ...safe } = call;
    const receipt: V1Call = { ...safe, principal: call.principal && { id: call.principal.id, kind: call.principal.kind, tokenId: call.principal.tokenId },
      status: reply.statusCode, ms: Math.round(performance.now() - start) };
    if (pool) {
      try { await auditV1(pool, receipt); }
      catch { app.log.error({ requestId: call.requestId }, 'API v1 audit persistence failed'); }
    }
    for (const seam of seams) seam.settled?.(receipt);
  });
}

/** Called inside registerRoutes, so each operation runs on the same `open` transaction as the rest of the API. */
export function registerV1(app: FastifyInstance, { open }: { open: Open }) {
  const spend = tokenBudgets();
  for (const op of operations) {
    app.route({ method: op.method, url: op.path.replace(/\{(\w+)\}/g, ':$1'), exposeHeadRoute: false, errorHandler: onError, handler: route(open, op, spend) });
  }
  // The reference: the same document as openapi/v1.yaml. A description only, so it needs no key and holds no data.
  app.get('/api/v1/openapi.json', { exposeHeadRoute: false }, async () => v1OpenApi());
}

// The existing install-local service paths and the service-key scope each needs, unchanged. EST-2290: openapi/service.yaml
// stays their one contract; the reference inlines their path items from it with every `#/components/…` reference resolved,
// so the public document is self-contained, and each operation names its `serviceKey` scope (never the area `bearer`).
const LEGACY: Record<string, string> = { '/api/v1/catalog/items': 'catalog.read', '/api/v1/service/clients': 'clients.read',
  '/api/v1/service/leads': 'leads.read', '/api/v1/service/quotes': 'quotes.draft.create', '/api/v1/service/tasks/mine': 'tasks.read',
  '/api/v1/service/people': 'people.read', '/api/v1/service/quotes/{id}/ready-notice': 'notify.quote_ready',
  '/api/v1/service/chats/{chatId}/messages': 'chats.post' };
const serviceDoc = load(readFileSync(new URL('../openapi/service.yaml', import.meta.url), 'utf8')) as Schema;
const inline = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(inline);
  if (typeof value !== 'object' || value === null) return value;
  const { $ref, ...rest } = value as Schema;
  if ($ref === undefined) return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, inline(v)]));
  const target = typeof $ref === 'string' && $ref.startsWith('#/components/')
    ? $ref.slice(2).split('/').reduce<unknown>((at, key) => (at as Schema | undefined)?.[key], serviceDoc) : undefined;
  if (typeof target !== 'object' || target === null) throw Error(`service.yaml reference ${String($ref)} does not resolve`);
  return inline({ ...target, ...rest });
};
const legacyPaths: Record<string, Record<string, Schema>> = Object.fromEntries(Object.entries(LEGACY).map(([path, scope]) => {
  const item = inline((serviceDoc.paths as Schema)[path]) as Record<string, Schema>;
  return [path, Object.fromEntries(Object.entries(item).map(([method, op]) => [method, { ...op, security: [{ serviceKey: [scope] }] }]))];
}));
const rateHeaders = Object.fromEntries(['Limit', 'Remaining', 'Reset'].map(name => [`RateLimit-${name}`, { schema: { type: 'integer', minimum: 0 },
  description: name === 'Reset' ? 'Seconds until the process-local window resets' : `Requests ${name.toLowerCase()} in this budget` }]));
export function v1OpenApi() {
  const paths: Record<string, Schema> = structuredClone(legacyPaths);
  const parameters = (s: Closed | undefined, where: 'path' | 'query') =>
    Object.entries(s?.properties ?? {}).map(([name, schema]) => ({ name, in: where, required: where === 'path' || !!s?.required?.includes(name), schema }));
  for (const op of operations) (paths[op.path] ??= {})[op.method.toLowerCase()] = {
    operationId: op.operationId, summary: op.summary, security: [{ bearer: [op.scope] }],
    ...(op.params || op.query || op.method !== 'GET' ? { parameters: [...parameters(op.params, 'path'), ...parameters(op.query, 'query'),
      ...(op.method !== 'GET' ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } }] : [])] } : {}),
    ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } } : {}),
    responses: { 200: { description: 'OK', headers: rateHeaders, content: { 'application/json': { schema: op.response } } }, default: { $ref: '#/components/responses/Problem' } },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Pulse API v1', version: '1.0.0', description: 'One bearer key per call and nothing else: `psvc_` (a connected app, acting as the '
      + 'AI member it is bound to), `pak_` (an AI employee) or a personal token. Access is the key\'s area scopes (`<area>.read|write` for '
      + `${[...new Set(V1_SCOPES.map(s => s.split('.')[0]))].join(', ')}; granted explicitly, none by default) ∩ what its principal may see `
      + 'on the screens ∩ the company whose address is called. A cookie, session or Access identity beside the key: 401. Refusals are '
      + '`application/problem+json` with the request id (also `X-Request-Id`); every response is `Cache-Control: no-store`; unknown path, '
      + 'query or body fields: 400. Lists use items + nextCursor with limit 1..100 and a token/company/filter-bound opaque cursor; adapters seek by ascending immutable id under row security, never offsets. Authenticated tokens have independent process-local 120/min budgets (4096 active windows); failed auth uses its separate service budget. RateLimit-Limit/Remaining/Reset describe the budget (Reset is seconds); 429 includes Retry-After. Writes require a UUID Idempotency-Key; identical input replays the committed status/body for 24 hours, changed input returns 409. '
      + 'The install-local service paths (`/api/v1/service/…`, `/api/v1/catalog/items`) keep their own contract, inlined here from service.yaml: '
      + 'a `psvc_` key holding the `serviceKey` scope each operation names, and `{ "error" }` refusals.' },
    servers: [{ url: 'https://{installHost}', variables: { installHost: { default: 'pulse.example.com' } } }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: '`psvc_<key id>_<secret>`, `pak_<prefix>_<secret>` or a personal token; scopes are the area grants.' },
        serviceKey: ((serviceDoc.components as Schema).securitySchemes as Record<string, Schema>).serviceKey },
      parameters: Object.fromEntries(Object.entries(PAGE_QUERY).map(([name, schema]) => [name, { name, in: 'query', schema }])),
      headers: { ...rateHeaders, 'Retry-After': { description: 'Seconds before retrying a 429', schema: { type: 'integer', minimum: 1 } } },
      responses: { Problem: { description: 'A refusal or failure; 429 includes Retry-After', headers: { ...rateHeaders, 'Retry-After': { $ref: '#/components/headers/Retry-After' } }, content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } } },
      schemas: { Problem: PROBLEM },
    },
  };
}
