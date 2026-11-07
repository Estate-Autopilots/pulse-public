// v1-paging/1: one ascending immutable UUID keyset; the adapter seeks under the call's RLS, fetching limit + 1.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { V1Context, V1Input } from './v1.js';
import { v1Fail } from './v1.js';
const secret = randomBytes(32), UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const PAGE_QUERY = { cursor: { type: 'string', minLength: 1, maxLength: 256 },
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$', default: '100' } };
export const pageResponse = (items: Record<string, unknown>) => ({ type: 'object' as const, additionalProperties: false as const,
  required: ['items', 'nextCursor'], properties: { items: { type: 'array', maxItems: 100, items }, nextCursor: { type: ['string', 'null'], maxLength: 256 } } });
const sorted = (v: Record<string, string>) => Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
/** fetch must use ctx.client, WHERE id > after ORDER BY id LIMIT take, with permissions/filters in SQL before LIMIT.
 * Never feed a preloaded/offset page to this helper. A restart invalidates existing cursors; restart from page one. */
export async function pageV1<T extends { id: string }>(ctx: V1Context, operation: string, input: V1Input,
  fetch: (after: string | null, take: number) => Promise<T[]>) {
  const invalid = () => v1Fail(400, 'Invalid cursor or limit');
  const raw = input.query.limit ?? '100', cursor = input.query.cursor;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) invalid();
  const limit = Number(raw), filters = Object.fromEntries(Object.entries(input.query).filter(([k]) => k !== 'cursor' && k !== 'limit'));
  const binding = createHash('sha256').update(JSON.stringify([ctx.tenantId, ctx.principal.tokenId, ctx.principal.id, operation,
    sorted(input.params), sorted(filters)])).digest('base64url');
  let after: string | null = null;
  if (cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{40,256}$/.test(cursor)) return invalid();
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) return invalid();
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const [bound, id] = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
      if (bound !== binding || typeof id !== 'string' || !UUID.test(id)) return invalid();
      after = id;
    } catch { return invalid(); }
  }
  const rows = await fetch(after, limit + 1);
  if (rows.length > limit + 1 || rows.some((r, i) => !UUID.test(r.id) || r.id <= (i ? rows[i - 1].id : after ?? ''))) {
    return v1Fail(500, 'Invalid keyset adapter');
  }
  const items = rows.slice(0, limit);
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, nonce);
    const data = Buffer.concat([cipher.update(JSON.stringify([binding, items.at(-1)!.id])), cipher.final()]);
    nextCursor = Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
  }
  return { items, nextCursor };
}
