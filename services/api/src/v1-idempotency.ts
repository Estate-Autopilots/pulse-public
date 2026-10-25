// v1-call-safety/1: the quote replay recipe (canonical JSON + transaction advisory lock), shared by registry writes.
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { V1Context, V1Input, V1Operation } from './v1.js';
import { v1Fail } from './v1.js';
export const requestKey = (value: unknown): string | null => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
type Pending = { key: string; hash: string; result: { status: number; body: string } | null };
const pending = new WeakMap<V1Context, Pending>();
export async function replayBefore(ctx: V1Context, op: V1Operation, input: V1Input, req: FastifyRequest, reply: FastifyReply) {
  if (op.method === 'GET') return;
  const key = requestKey(req.headers['idempotency-key']) ?? v1Fail(400, 'Send a UUID Idempotency-Key for every write');
  const hash = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
  const result = (await ctx.client.query('select pulse.v1_replay($1,$2,$3,$4) v', [ctx.principal.tokenId, op.operationId, key, hash])).rows[0].v;
  pending.set(ctx, { key, hash, result });
  if (result !== null) { reply.code(result.status); return JSON.parse(result.body); }
}
// Called after every transformation and final schema check. The business write and its receipt commit together.
export async function replayAfter(ctx: V1Context, op: V1Operation, answer: unknown, reply: FastifyReply) {
  const p = pending.get(ctx);
  if (!p) return answer;
  if (p.result) { reply.code(p.result.status); return JSON.parse(p.result.body); }
  if (reply.statusCode < 200 || reply.statusCode >= 300) v1Fail(500, 'A write must succeed or throw before commit');
  await ctx.client.query('select pulse.v1_replay($1,$2,$3,$4,$5)', [ctx.principal.tokenId, op.operationId, p.key, p.hash,
    { status: reply.statusCode, body: JSON.stringify(answer) }]);
  return answer;
}
