// API-PLATFORM-2: delivers API v1 webhooks (migration 1594). Each company in its own short transaction: claim due
// deliveries (a 60-second lease each), read what to send, then send with no transaction or connection held, then record
// the outcome. Signed like Pulse's install events: X-Pulse-Signature t=<unix seconds>,v1=<HMAC-SHA256 hex of
// "<t>.<body>">. safeOutbound resolves the host on every attempt, refuses private, loopback, link-local (cloud metadata)
// and reserved addresses, pins the checked address, follows no redirect and reads at most 16 KB of the answer.
// Nothing here logs a URL, a body, a secret or an answer.
import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OutboundError, safeOutbound } from './safe-outbound.js';

export type Send = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ status: number }>;
type Dispatch = { url: string; secret: string; attempt: number; deliveryId: string; event: { id: string; type: string; createdAt: string; data: Record<string, unknown> } };

export function signature(secret: string, timestamp: string, body: string) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
export function webhookHeaders(d: Pick<Dispatch, 'secret' | 'attempt' | 'deliveryId' | 'event'>, body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return { 'User-Agent': 'Pulse-Webhooks/1', 'X-Pulse-Event-Id': d.event.id, 'X-Pulse-Event-Type': d.event.type, 'X-Pulse-Delivery-Id': d.deliveryId,
    'X-Pulse-Delivery-Attempt': String(d.attempt), 'X-Pulse-Timestamp': timestamp, 'X-Pulse-Signature': signature(d.secret, timestamp, body) };
}
/** The body is the event as stored, so a retry or a redelivery sends the same bytes. */
export const webhookBody = (d: Pick<Dispatch, 'event'>) => JSON.stringify({ id: d.event.id, type: d.event.type, createdAt: d.event.createdAt, data: d.event.data });

async function tenant<T>(pool: Pool, org: string, run: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [org]);
    const out = await run(c); await c.query('commit'); return out;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

let pruned = 0;
export async function deliverWebhooks(pool: Pool, send: Send = safeOutbound, now = () => performance.now(), orgs?: string[]) {
  let sent = 0, failed = 0;
  const companies = orgs ?? (await pool.query('select pulse.list_active_orgs() org')).rows.map(r => String(r.org));
  const prune = Date.now() - pruned > 3_600_000; if (prune) pruned = Date.now();
  for (const org of companies) {
    if (prune) await tenant(pool, org, c => c.query('select pulse.v1_event_prune()'));
    const jobs = await tenant(pool, org, async c => (await c.query('select pulse.v1_webhook_due(20) v')).rows[0].v as { id: string; lease: string }[]);
    for (const job of jobs) {
      const d = await tenant(pool, org, async c => (await c.query('select pulse.v1_webhook_dispatch($1,$2) v', [job.id, job.lease])).rows[0].v as Dispatch | null);
      if (!d) continue;
      const body = webhookBody(d), start = now();
      let status: number | null = null, error: string | null = null;
      try {
        status = (await send(d.url, body, webhookHeaders(d, body), 3000)).status;
        if (status < 200 || status >= 300) error = 'http';
      } catch (e) { error = e instanceof OutboundError ? e.kind : 'network'; }
      await tenant(pool, org, c => c.query('select pulse.v1_webhook_attempt($1,$2,$3,$4,$5)', [job.id, job.lease, status, Math.round(now() - start), error]));
      if (error) failed++; else sent++;
    }
  }
  return { sent, failed };
}

/** The API process's loop (server.ts): one pass at a time, every few seconds; PULSE_V1_WEBHOOKS=0 turns it off. */
export function startWebhookDelivery(pool: Pool, warn: (msg: string) => void, everyMs = 5000) {
  if (process.env.PULSE_V1_WEBHOOKS === '0') return () => {};
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return; busy = true;
    void deliverWebhooks(pool).catch(() => warn('Webhook delivery unavailable')).finally(() => { busy = false; });
  }, everyMs);
  return () => clearInterval(timer);
}
