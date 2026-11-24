// v1-paging/1: one ascending immutable UUID keyset; the adapter seeks under the call's RLS, fetching limit + 1.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { V1Context, V1Input } from './v1.js';
import { v1Fail } from './v1.js';
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// PM-BUILD-4 (EA #36, 23 Nov 2026): cursors were sealed with a key made at process start, so each restart (every release)
// broke every saved cursor and the Project Coordinator spent 2 of its 3 tool rounds on refusals. The key now comes from
// the database (2532, made once), read at the first page and kept; a process whose database has no key (or a unit test
// with no client) keeps the old per-process key.
const processKey = randomBytes(32);
let storedKey: Promise<Buffer | null> | null = null;
async function cursorKey(ctx: V1Context): Promise<Buffer> {
  if (!ctx.client) return processKey;
  storedKey ??= (async () => {
    try {
      await ctx.client.query('savepoint v1_cursor_key');
      const key = (await ctx.client.query('select pulse.v1_cursor_key() k')).rows[0]?.k;
      await ctx.client.query('release savepoint v1_cursor_key');
      return Buffer.isBuffer(key) && key.length === 32 ? key : null;
    } catch {
      await ctx.client.query('rollback to savepoint v1_cursor_key').catch(() => undefined);
      return null;
    }
  })();
  const key = await storedKey;
  if (!key) storedKey = null; // not there yet (an older database): try again on a later page
  return key ?? processKey;
}
/** Exported for tests: forget the loaded key, as a restarted process would. */
export function resetCursorKeyForTest() { storedKey = null; }
export const PAGE_QUERY = { cursor: { type: 'string', minLength: 1, maxLength: 256 },
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$', default: '100' } };
export const pageResponse = (items: Record<string, unknown>) => ({ type: 'object' as const, additionalProperties: false as const,
  required: ['items', 'nextCursor'], properties: { items: { type: 'array', maxItems: 100, items }, nextCursor: { type: ['string', 'null'], maxLength: 256 } } });
/** A page answer's own characters around its items: {"nextCursor":"<at most 256>","items":[…]}. */
const ANSWER_FRAME = '{"nextCursor":"","items":[]}'.length + 256;
const sorted = (v: Record<string, string>) => Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
/** fetch must use ctx.client, WHERE id > after ORDER BY id LIMIT take, with permissions/filters in SQL before LIMIT.
 * Never feed a preloaded/offset page to this helper. A restart invalidates existing cursors; restart from page one. */
export async function pageV1<T extends { id: string }>(ctx: V1Context, operation: string, input: V1Input,
  fetch: (after: string | null, take: number) => Promise<T[]>) {
  const invalid = () => v1Fail(400, 'Invalid cursor or limit');
  // A well-formed cursor this server cannot open (made before its key moved to the database, or for other filters,
  // another key or viewer): say how to go on, so an AI caller starts again instead of retrying the same cursor.
  const stale = () => v1Fail(400, 'Invalid cursor or limit: this cursor cannot be used for this list. Ask again without a cursor to start from the first page.');
  const raw = input.query.limit ?? '100', cursor = input.query.cursor;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) invalid();
  const limit = Number(raw), filters = Object.fromEntries(Object.entries(input.query).filter(([k]) => k !== 'cursor' && k !== 'limit'));
  const binding = createHash('sha256').update(JSON.stringify([ctx.tenantId, ctx.principal.tokenId, ctx.principal.id, operation,
    sorted(input.params), sorted(filters)])).digest('base64url');
  let after: string | null = null;
  const secret = await cursorKey(ctx);
  if (cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{40,256}$/.test(cursor)) return invalid();
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) return invalid();
      let bound: unknown, id: unknown;
      try {
        const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        [bound, id] = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
      } catch { return stale(); }
      if (bound !== binding) return stale();
      if (typeof id !== 'string' || !UUID.test(id)) return invalid();
      after = id;
    } catch (e) { if ((e as { status?: number }).status === 400) throw e; return invalid(); }
  }
  const rows = await fetch(after, limit + 1);
  if (rows.length > limit + 1 || rows.some((r, i) => !UUID.test(r.id) || r.id <= (i ? rows[i - 1].id : after ?? ''))) {
    return v1Fail(500, 'Invalid keyset adapter');
  }
  let items = rows.slice(0, limit), more = rows.length > limit;
  // PM-BUILD-4 (EA #35, Project Coordinator, 22 Nov 2026): an AI employee's runtime shows at most ctx.answerChars of a tool
  // answer (services/coworker: 3000). A 20-task page of list_triage_tasks is ~6,600, so the AI saw ~9 tasks while
  // nextCursor went past all 20: tasks 10-20 of every page were never seen. Over MCP with that budget, a page keeps the
  // whole items that fit (at least one) and nextCursor resumes at the first item not sent, so every item is seen once.
  if (ctx.answerChars) {
    let size = ANSWER_FRAME, keep = 0;
    for (const item of items) { size += JSON.stringify(item).length + 1; if (keep && size > ctx.answerChars) break; keep++; }
    if (keep < items.length) { items = items.slice(0, keep); more = true; }
  }
  let nextCursor: string | null = null;
  if (more) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, nonce);
    const data = Buffer.concat([cipher.update(JSON.stringify([binding, items.at(-1)!.id])), cipher.final()]);
    nextCursor = Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
  }
  return { items, nextCursor };
}
