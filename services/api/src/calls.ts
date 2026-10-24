// CHAT-VOICE: calls from Chats. Pulse keeps each call's state (db/migrations/0896_chat_calls.sql) and carries the
// browsers' WebRTC connection messages between the people in it; the media itself goes browser to browser or through
// the company's TURN relay (coturn on the VPS's public address: Cloudflare's tunnel carries no media).
//
// Live events: GET /api/v0/calls/events is a stream per open Pulse. Every write that concerns someone adds a row for
// them and NOTIFY pulse_call wakes their streams at once (one LISTEN connection per API process); a 3-second tick
// covers anything missed. Each event has an id, so a stream that reconnects (EventSource sends Last-Event-ID) loses
// no signal.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown) => UUID.test(String(raw)) ? String(raw) : fail(400, 'Choose a valid call or conversation');
const ids = (raw: unknown, max = 8) => { if (raw === undefined || raw === null) return null; if (!Array.isArray(raw) || raw.length > max) fail(400, `Choose up to ${max} people`); return [...new Set((raw as unknown[]).map(id))]; };
const member = (v: Viewer) => { if (!v.person) fail(403, 'Calls need your individual employee account'); };
type Body = Record<string, unknown>;

// ---- ICE servers: STUN, and TURN with short-lived credentials (coturn use-auth-secret: HMAC-SHA1 of "expiry:person"). ----
let secretRead: { at: number; value: string | null } | null = null;
function turnSecret() {
  if (secretRead && Date.now() - secretRead.at < 60_000) return secretRead.value;
  let value = process.env.PULSE_TURN_SECRET?.trim() || null;
  const file = process.env.PULSE_TURN_SECRET_FILE;
  if (!value && file) { try { value = readFileSync(file, 'utf8').trim() || null; } catch { value = null; } }
  secretRead = { at: Date.now(), value };
  return value;
}
const urls = (raw?: string) => (raw ?? '').split(',').map(x => x.trim()).filter(x => /^(stun|turns?):[^\s,]+$/.test(x));
export function iceServers(person: string, now = Date.now()) {
  const turn = urls(process.env.PULSE_TURN_URLS), stun = urls(process.env.PULSE_STUN_URLS), secret = turnSecret();
  const servers: { urls: string[]; username?: string; credential?: string }[] = [];
  if (stun.length) servers.push({ urls: stun });
  if (turn.length && secret) {
    const username = `${Math.floor(now / 1000) + 12 * 3600}:${person}`;
    servers.push({ urls: turn, username, credential: createHmac('sha1', secret).update(username).digest('base64') });
  }
  // Without the company's own servers, a public STUN server still connects most calls on ordinary networks.
  if (!servers.length) servers.push({ urls: ['stun:stun.l.google.com:19302'] });
  return { iceServers: servers, relay: turn.length > 0 && !!secret };
}

// ---- One LISTEN connection per API process wakes the streams of the person an event is for. ----
class CallHub {
  private subs = new Map<string, Set<() => void>>();
  private client: PoolClient | null = null;
  private starting = false; private closed = false;
  constructor(private pool?: Pool) {}
  /** The API is closing: give the LISTEN connection back (a pool cannot end while it is out). */
  close() { this.closed = true; const c = this.client; this.client = null; if (c) { try { c.release(true); } catch { /* gone */ } } }
  private async listen() {
    if (!this.pool || this.client || this.starting || this.closed) return;
    this.starting = true;
    try {
      const c = await this.pool.connect();
      c.on('notification', m => { if (m.channel === 'pulse_call' && m.payload) this.wake(m.payload); });
      c.on('error', () => this.drop(c));
      await c.query('listen pulse_call');
      if (this.closed) { c.release(true); return; }
      this.client = c;
    } catch { if (!this.closed) setTimeout(() => void this.listen(), 5000).unref(); }
    finally { this.starting = false; }
  }
  private drop(c: PoolClient) {
    if (this.client !== c) return;
    this.client = null; try { c.release(true); } catch { /* already gone */ }
    if (!this.closed) setTimeout(() => void this.listen(), 2000).unref();
  }
  wake(key: string) { this.subs.get(key)?.forEach(f => f()); }
  on(key: string, f: () => void) {
    void this.listen();
    let s = this.subs.get(key); if (!s) { s = new Set(); this.subs.set(key, s); } s.add(f);
    return () => { s!.delete(f); if (!s!.size) this.subs.delete(key); };
  }
}

export function registerCallRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool?: Pool }) {
  const hub = new CallHub(pool);
  app.addHook('onClose', async () => { hub.close(); });
  // Unanswered rings and people who went quiet: at most every 4 s per company, whoever's Pulse is open.
  const expired = new Map<string, number>();
  const expire = async (c: PoolClient, org: string, force = false) => {
    if (!force && Date.now() - (expired.get(org) ?? 0) < 4000) return;
    expired.set(org, Date.now()); await c.query('select pulse.chat_call_expire()');
  };
  const view = async (c: PoolClient, call: string) => (await c.query('select pulse.chat_call_view($1) v', [call])).rows[0]?.v ?? null;
  const body = { type: 'object' } as const;

  app.get('/api/v0/calls/config', req => tx(req, async (_c, v) => { member(v); return iceServers(v.person!); }));
  // Calls ringing me or with me in them, and my recent calls.
  app.get('/api/v0/calls', req => tx(req, async (c, v) => {
    member(v); await expire(c, v.org);
    return { calls: (await c.query('select pulse.chat_call_mine() j')).rows[0].j, recent: (await c.query('select pulse.chat_call_recent(40) j')).rows[0].j };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/calls/:id', req => tx(req, async (c, v) => {
    member(v); await expire(c, v.org); const call = await view(c, id(req.params.id)); if (!call) fail(404, 'Call unavailable'); return { call };
  }));
  app.post<{ Body: Body }>('/api/v0/calls', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v); const b = req.body;
    const cid = (await c.query('select pulse.chat_call_start($1,$2,$3) id', [id(b.channelId), b.video === true, ids(b.invite)])).rows[0].id as string;
    return { call: await view(c, cid), ...iceServers(v.person!) };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/calls/:id/answer', req => tx(req, async (c, v) => {
    member(v); const cid = id(req.params.id); await c.query('select pulse.chat_call_answer($1)', [cid]);
    return { call: await view(c, cid), ...iceServers(v.person!) };
  }));
  for (const action of ['decline', 'leave'] as const) app.post<{ Params: { id: string } }>(`/api/v0/calls/:id/${action}`, req => tx(req, async (c, v) => {
    member(v); const cid = id(req.params.id); await c.query(`select pulse.chat_call_${action}($1)`, [cid]); return { call: await view(c, cid) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/calls/:id/invite', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v); const cid = id(req.params.id); await c.query('select pulse.chat_call_invite($1,$2)', [cid, ids(req.body.personIds) ?? []]); return { call: await view(c, cid) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/calls/:id/beat', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v); const b = req.body; await expire(c, v.org);
    const inCall = (await c.query('select pulse.chat_call_beat($1,$2,$3) ok', [id(req.params.id), typeof b.muted === 'boolean' ? b.muted : null, typeof b.video === 'boolean' ? b.video : null])).rows[0].ok as boolean;
    return { inCall };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/calls/:id/signal', { schema: { body }, bodyLimit: 400_000 }, req => tx(req, async (c, v) => {
    member(v); const list = req.body.signals;
    if (!Array.isArray(list) || !list.length || list.length > 60) fail(400, 'Send between 1 and 60 signals');
    const clean = (list as Body[]).map(s => ({ to: id(s.to), kind: s.kind === 'description' || s.kind === 'candidate' ? s.kind : fail(400, 'Unknown signal'), body: s.body ?? null }));
    await c.query('select pulse.chat_call_signal($1,$2::jsonb)', [id(req.params.id), JSON.stringify(clean)]);
    return { ok: true };
  }));

  app.get('/api/v0/calls/events', async (req, reply) => {
    const raw = req.headers['last-event-id'] ?? (req.query as { after?: string }).after;
    const after = raw !== undefined && /^\d{1,18}$/.test(String(raw)) ? Number(raw) : null;
    const first = await tx(req, async (c, v) => {
      member(v); await expire(c, v.org);
      return { key: `${v.org}:${v.person}`, cursor: after ?? Number((await c.query('select pulse.chat_call_cursor() s')).rows[0].s),
        calls: (await c.query('select pulse.chat_call_mine() j')).rows[0].j };
    });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'private, no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write(`retry: 1000\nevent: calls\ndata: ${JSON.stringify({ calls: first.calls })}\n\n`);
    let cursor = first.cursor, busy = false, again = false, closed = false;
    const close = () => { if (closed) return; closed = true; reply.raw.end(); };
    const pump = async () => {
      if (closed) return; if (busy) { again = true; return; }
      busy = true;
      try {
        const rows = await tx(req, async (c, v) => { member(v); await expire(c, v.org); return (await c.query('select * from pulse.chat_call_events($1)', [cursor])).rows as { seq: string; call_id: string; kind: 'state' | 'signal'; from_id: string | null; body: Record<string, unknown> | null }[]; });
        if (closed) return;
        const newest = new Map<string, number>(); rows.forEach((r, i) => { if (r.kind === 'state') newest.set(r.call_id, i); });
        let out = '';
        rows.forEach((r, i) => {
          cursor = Math.max(cursor, Number(r.seq));
          if (r.kind === 'state' && (newest.get(r.call_id) !== i || !r.body)) return;
          out += `id: ${r.seq}\nevent: ${r.kind === 'state' ? 'call' : 'signal'}\ndata: ${JSON.stringify(r.kind === 'state' ? r.body : { callId: r.call_id, from: r.from_id, ...r.body })}\n\n`;
        });
        reply.raw.write(out || ': ping\n\n');
        if (rows.length >= 300) again = true;
      } catch { close(); }
      finally { busy = false; if (again && !closed) { again = false; void pump(); } }
    };
    const off = hub.on(first.key, () => void pump());
    const tick = setInterval(() => void pump(), 3000);
    // Reconnect every 45 s, as Chats does (identity and membership are re-checked on every pump anyway).
    const end = setTimeout(close, 45_000);
    reply.raw.on('close', () => { closed = true; off(); clearInterval(tick); clearTimeout(end); });
    void pump();
  });
}
