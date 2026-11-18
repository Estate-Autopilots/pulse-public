// GROWTH-LOOP slice 2 (owner, 8 Nov 2026): the "What is Vitals?" funnel. A client-side person or a guest who meets
// Vitals through another company sees "Powered by <company> · Vitals" and a small card; what they do with it is
// recorded under the company that brought them (pulse.growth_event, 1894/1895) and counted in the investor numbers.
// Signed out (a quotation link) it goes through POST /api/v0/accept/:token/seen (erp.ts); signed in, through these.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authIp } from './account-security.js';
import { fail, sessionHash, type Open, type Tx } from './routes.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 8 } as const;
export const GROWTH_EVENTS = ['viewed', 'clicked', 'dismissed'] as const;
export const GROWTH_SOURCES = ['chat', 'quote', 'contract', 'portal'] as const;
const oneOf = <T extends string>(x: unknown, list: readonly T[]): T | null => (list as readonly string[]).includes(String(x)) ? String(x) as T : null;

/** A browser's anonymous visitor id (16–64 letters, digits, - or _) → its SHA-256 in hex; anything else → null. */
export const growthVisitor = (x: unknown) =>
  typeof x === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(x) ? createHash('sha256').update(`growth:${x}`).digest('hex') : null;

/** A company's @handle as the card sends it ("@ea", "EA" → "ea"); anything else → null. */
export const growthVia = (x: unknown) => {
  const h = String(x ?? '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,39}$/.test(h) ? h : null;
};

/** A per-address limit for the signed-out route (the sign-in limiter's table, pulse.auth_allow). */
export const growthAllow = (open: Open) => async (req: FastifyRequest, key: string, limit: number) =>
  (await open(async (c) => (await c.query<{ ok: boolean }>('select pulse.auth_allow($1,$2) ok', [sessionHash(`${key}:${authIp(req)}`), limit])).rows[0].ok));

export function registerGrowthRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // What a signed-in person did with the card in a company's chat or client space. Recorded only for client-side
  // people (the database decides); for staff it answers { recorded: false } and writes nothing.
  app.post<{ Body: Body }>('/api/v0/growth/seen', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person) return { recorded: false };
    const event = oneOf(req.body?.event, GROWTH_EVENTS), source = oneOf(req.body?.source, GROWTH_SOURCES);
    if (!event || !source) fail(400, 'Say what happened with the card, and where');
    return (await c.query('select pulse.growth_seen($1,$2) r', [event, source])).rows[0].r;
  }));
  // Right after "Start free for your business" opened a company: the founder's new company is counted for the company
  // that brought them (only within the hour, once, and only for another, active company: the database decides).
  app.post<{ Body: Body }>('/api/v0/growth/started', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person) return { recorded: false };
    const via = growthVia(req.body?.via), source = oneOf(req.body?.source, GROWTH_SOURCES);
    if (!via || !source) fail(400, 'Say which company brought you to Vitals');
    return (await c.query('select pulse.growth_started($1,$2) r', [via, source])).rows[0].r;
  }));
}
