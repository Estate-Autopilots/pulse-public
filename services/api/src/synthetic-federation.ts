import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { readOrgTasks, syntheticTaskSchema, type SyntheticTask } from './synthetic-my-tasks.js';

// Server-owned install config: links are private, revocable per-install grants; nothing here comes from HTTP.
export type SyntheticLink = { org: string; person: string; secretSha256: Buffer; revoked: boolean };
export type SyntheticInstallConfig = { installId: string; key: Buffer; orgs: ReadonlySet<string>;
  links: Map<string, SyntheticLink>; now?: () => number };
const MAX_TTL = 300; // seconds
const closed = { type: 'object', additionalProperties: false, properties: {} } as const;
const error = { type: 'object', additionalProperties: false, required: ['error'],
  properties: { error: { type: 'string' } } } as const;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** EST-2087 acceptance harness for one install. Never registered by createApp/server.ts. The install alone owns its
 * tasks: a link credential mints a short-lived context (no DB), and every context read rechecks the link and person.
 */
export function createSyntheticInstall(pool: Pool, cfg: SyntheticInstallConfig) {
  if (!cfg.installId.startsWith('synthetic:') || cfg.key.length !== 32) throw new Error('Invalid synthetic install');
  for (const link of cfg.links.values()) {
    if (!cfg.orgs.has(link.org) || link.secretSha256.length !== 32) throw new Error('Link outside this install');
  }
  const now = () => Math.floor((cfg.now ?? Date.now)() / 1000);
  const live = (id: string) => {
    const link = cfg.links.get(id);
    return link && !link.revoked && cfg.orgs.has(link.org) ? link : undefined;
  };
  const sign = (payload: string) => createHmac('sha256', cfg.key).update('v1.' + payload).digest('base64url');
  const verify = (bearer = '') => {
    const [, payload, sig] = /^Bearer v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(bearer) ?? [];
    if (!payload || !sig || !same(sig, sign(payload))) return undefined;
    try {
      const { iss, lnk, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()), t = now();
      const link = iss === cfg.installId && typeof lnk === 'string' && Number.isInteger(exp) && t < exp
        && exp <= t + MAX_TTL ? live(lnk) : undefined;
      return link && { id: lnk as string, link };
    } catch { return undefined; }
  };
  const app = Fastify({ logger: false, exposeHeadRoutes: false, ajv: { customOptions: { removeAdditional: false } } });
  app.post('/synthetic/federation/context', { schema: { body: closed, querystring: closed, response: {
    200: { type: 'object', additionalProperties: false, required: ['context', 'expiresAt'],
      properties: { context: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' } } },
    400: error, 401: error } } }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const [, id, secret] = /^Bearer ([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '') ?? [];
    const link = id && live(id);
    if (!link || !secret || !timingSafeEqual(createHash('sha256').update(secret).digest(), link.secretSha256)) {
      return reply.code(401).send({ error: 'Synthetic link required' });
    }
    const exp = now() + MAX_TTL;
    const payload = Buffer.from(JSON.stringify({ iss: cfg.installId, lnk: id, exp,
      jti: randomBytes(16).toString('base64url') })).toString('base64url');
    return { context: `v1.${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
  });
  app.get('/synthetic/federation/tasks', { schema: { querystring: closed,
    response: { 200: syntheticTaskSchema, 400: error, 401: error, 403: error } } }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const bound = verify(request.headers.authorization);
    if (!bound) return reply.code(401).send({ error: 'Synthetic context required' });
    const { id, link } = bound, { org, person } = link;
    return readOrgTasks(pool, org, person, () => live(id) === link && link.org === org && link.person === person);
  });
  app.setErrorHandler((err, _request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: status === 400 ? 'No request selectors allowed' : 'Synthetic read denied' });
  });
  return app;
}

/** A source refused this reader (401/403). Any other failure makes the source `unavailable`. */
export class TaskSourceDenied extends Error {}
// Only another Pulse install today; organization, freelance or personal sources would be future kinds.
export type TaskSource = { kind: 'pulse_install'; label: string; read(signal: AbortSignal): Promise<unknown> };
export type SourceState = 'ok' | 'denied' | 'unavailable';

export function pulseInstallSource({ label, baseUrl, linkCredential }:
  { label: string; baseUrl: string; linkCredential: string }): TaskSource {
  const call = async (path: string, bearer: string, signal: AbortSignal, post = false) => {
    const response = await fetch(new URL(path, baseUrl), { method: post ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { authorization: 'Bearer ' + bearer, ...(post ? { 'content-type': 'application/json' } : {}) },
      body: post ? '{}' : undefined });
    if (response.status === 401 || response.status === 403) throw new TaskSourceDenied(label);
    if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  return { kind: 'pulse_install', label, async read(signal) {
    // A fresh context on every read, never cached: the install re-authorizes each one.
    const minted = await call('/synthetic/federation/context', linkCredential, signal, true) as { context?: unknown };
    if (typeof minted?.context !== 'string') throw new Error(label);
    return call('/synthetic/federation/tasks', minted.context, signal);
  } };
}

const isTask = (row: unknown): row is SyntheticTask => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const { organization, title, status, dueAt, ...rest } = row as Record<string, unknown>;
  return !Object.keys(rest).length && typeof organization === 'string'
    && typeof title === 'string' && typeof status === 'string'
    && (dueAt === null || typeof dueAt === 'string' && !Number.isNaN(Date.parse(dueAt)));
};
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** The hub: sources only (no pool, cache or store), so it can neither keep nor import anyone's tasks. */
export async function readFederatedMyTasks(sources: TaskSource[]) {
  const results = await Promise.all(sources.map(async source => {
    const result = (state: SourceState, tasks: SyntheticTask[] = []) => ({ label: source.label, state, tasks });
    try {
      const rows = await source.read(AbortSignal.timeout(5000));
      // Fail closed: one malformed row drops the whole source.
      if (!Array.isArray(rows) || !rows.every(isTask)) return result('unavailable');
      return result('ok', rows.map(({ organization, title, status, dueAt }) => ({ organization, title, status, dueAt })));
    } catch (err) { return result(err instanceof TaskSourceDenied ? 'denied' : 'unavailable'); }
  }));
  const due = (t: SyntheticTask) => t.dueAt === null ? Infinity : Date.parse(t.dueAt);
  const tasks = results.flatMap(r => r.tasks).sort((a, b) => due(a) - due(b)
    || order(a.organization, b.organization) || order(a.title, b.title));
  return { tasks, sources: results.map(({ label, state }) => ({ label, state })) };
}
