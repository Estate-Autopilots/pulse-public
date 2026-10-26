// v1-limits/1: process-local fixed windows; no timers or eviction of an unexpired token's budget.
import type { FastifyReply } from 'fastify';
export type LimitState = { limit: number; remaining: number; reset: number };
export type Budget = (() => boolean) & { state: () => LimitState };
export function budget(limit: number, now = Date.now): Budget {
  let start = now(), count = 0;
  const state = () => {
    const time = now();
    if (time - start >= 60_000) { start = time; count = 0; }
    return { limit, remaining: Math.max(0, limit - count), reset: Math.max(1, Math.ceil((start + 60_000 - time) / 1000)) };
  };
  return Object.assign(() => { state(); count = Math.min(count + 1, limit + 1); return count > limit; }, { state });
}
export const limitHeaders = (reply: FastifyReply, s: LimitState) => reply.header('ratelimit-limit', s.limit)
  .header('ratelimit-remaining', s.remaining).header('ratelimit-reset', s.reset);
export function tokenBudgets(now = Date.now, capacity = 4096) {
  const tokens = new Map<string, { expires: number; spend: Budget }>();
  return (tenant: string, token: string) => {
    const time = now(), key = `${tenant}:${token}`;
    let entry = tokens.get(key);
    if (!entry || entry.expires <= time) {
      // At most capacity entries scanned, only on admission. Live entries are never evicted to reset a budget.
      for (const [id, value] of tokens) if (value.expires <= time) tokens.delete(id);
      if (tokens.size >= capacity) return { limited: true, limit: 120, remaining: 0,
        reset: Math.max(1, Math.ceil((Math.min(...[...tokens.values()].map(v => v.expires)) - time) / 1000)) };
      entry = { expires: time + 60_000, spend: budget(120, now) }; tokens.set(key, entry);
    }
    const limited = entry.spend();
    return { limited, ...entry.spend.state() };
  };
}
