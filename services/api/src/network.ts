// PULSE-NETWORK (owner, 16 Oct 2026; EST-1038, EST-1026, EST-1027): Pulse Network inside every Pulse. The network is a
// separate app where companies, their leaders and their AI agents post, message and hand work to each other; only what
// someone posts there leaves the company. This Pulse holds one connector key for its company (a mode-600 file named by
// PULSE_NETWORK_CONNECTOR_KEY_FILE) and the network's address (PULSE_NETWORK_URL); without both, nothing shows.
// Leaders only, for now. The key never leaves this process: it is not logged, returned or put in a page. The one-time
// sign-in link is returned to the signed-in leader alone and lives 60 seconds.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Installation } from './installation.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';

type Row = Record<string, any>;
export type NetworkConfig = { org: string; url: string; key: string };

const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/, HANDLE = /^[a-z0-9][a-z0-9._-]{1,30}$/, TOPICS = new Set(['capacity', 'releases', 'hiring', 'general']);
const MOVES = new Set(['accepted', 'declined', 'done', 'cancelled']);
const handles = new Map<string, { handle: string; at: number }>();

/** Only the authoritative install organisation may use the install connector. No credential cache: revocation fails closed. */
export async function networkConfig(database: Pick<PoolClient, 'query'>, viewer: Pick<Viewer, 'org'>, env: NodeJS.ProcessEnv = process.env): Promise<NetworkConfig | null> {
  try {
    const installed = await new Installation(database).readOrg();
    if (!installed || viewer.org !== installed) return null;
    const url = String(env.PULSE_NETWORK_URL ?? '').trim().replace(/\/+$/, '');
    const file = String(env.PULSE_NETWORK_CONNECTOR_KEY_FILE ?? '').trim();
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== url || !file) return null;
    const key = (await readFile(file, 'utf8')).trim();
    return /^pnc_[0-9a-f]{8}_\S{20,}$/.test(key) ? { org: viewer.org, url, key } : null;
  } catch { return null; }
}

/** Only leaders open the network from Pulse for now (owner order: CEOs and leaders first). */
export const networkAllowed = (v: Viewer) => leadership(v);

/** One call to the network as this company, optionally acting for one of its members. Errors come back as plain text. */
export async function networkCall(cfg: NetworkConfig, method: 'GET' | 'POST', path: string, body?: unknown, as?: string, fetcher: typeof fetch = fetch): Promise<Row> {
  let r: Response;
  try {
    r = await fetcher(cfg.url + path, { method, headers: { authorization: `Bearer ${cfg.key}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'pulse-connector/1', ...(as ? { 'x-pulse-network-as': as } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  } catch { return fail(502, 'Pulse Network is not reachable right now. Try again in a minute.'); }
  const data = await r.json().catch(() => ({})) as Row;
  if (!r.ok) fail(r.status === 401 || r.status >= 500 ? 502 : r.status, typeof data.error === 'string' ? data.error.replaceAll(cfg.key, '[redacted]') : 'Pulse Network did not answer.');
  return data;
}

/** The leader as the network knows them: name, email and title from their Pulse profile. */
async function profile(c: PoolClient, v: Viewer) {
  const r = v.person ? (await c.query(`select coalesce(pp.email,$2) email,coalesce(p.display_name,$3) name,coalesce(pp.role,'') title from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1`, [v.person, v.email, v.name])).rows[0] : null;
  return { email: String(r?.email ?? v.email ?? '').trim().toLowerCase(), name: String(r?.name ?? v.name ?? '').trim(), title: String(r?.title ?? ''), pulseRef: v.person ?? '' };
}

/** The leader's network handle (made on first use), kept for ten minutes. */
export async function memberHandle(cfg: NetworkConfig, who: { email: string; name: string; title: string; pulseRef: string }, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const cacheKey = JSON.stringify([cfg.org, cfg.url, createHash('sha256').update(cfg.key).digest('hex'), who.email]);
  const hit = handles.get(cacheKey);
  if (hit && now - hit.at < 600_000) return hit.handle;
  const r = await networkCall(cfg, 'POST', '/api/v1/connector/member', { email: who.email, name: who.name, title: who.title, role: 'leader', pulse_ref: who.pulseRef }, undefined, fetcher);
  if (!HANDLE.test(String(r.handle ?? ''))) fail(502, 'Pulse Network did not answer.');
  handles.set(cacheKey, { handle: String(r.handle), at: now });
  return String(r.handle);
}

const text = (value: unknown, max: number) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const nextPath = (value: unknown) => { const s = String(value ?? '/'); return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') && s.length <= 200 ? s : '/'; };

/** Leaders only, checked first: a non-leader gets 403 before anything they send is read. */
const gate = (v: Viewer) => { if (!networkAllowed(v)) fail(403, 'Pulse Network is open to leaders first.'); };

export function registerNetworkRoutes(app: FastifyInstance, { tx, env = process.env, fetcher = fetch }: { tx: Tx; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch }) {
  const call = (cfg: NetworkConfig, method: 'GET' | 'POST', path: string, body?: unknown, as?: string) => networkCall(cfg, method, path, body, as, fetcher);
  const member = (cfg: NetworkConfig, who: Awaited<ReturnType<typeof profile>>) => memberHandle(cfg, who, fetcher);
  /** Ready for this viewer? The web hides the entry and the page otherwise. */
  app.get('/api/v0/network/status', (req) => tx(req, async (c, v) => ({ on: networkAllowed(v) && !!(await networkConfig(c, v, env)), allowed: networkAllowed(v) })));

  /** Who is asking, with the network ready: the leader's profile and the network config. */
  const ready = async (c: PoolClient, v: Viewer) => {
    if (!networkAllowed(v)) fail(403, 'Pulse Network is open to leaders first.');
    const cfg = await networkConfig(c, v, env);
    if (!cfg) fail(403, 'Pulse Network is not available for this company. Sign in directly on Pulse Network.');
    const who = await profile(c, v);
    if (!who.email || !who.name) fail(409, 'Your Pulse profile needs a name and an email before you can join Pulse Network.');
    return { cfg: cfg!, who };
  };

  /** EST-1038: a one-time link (60 s) that opens the network signed in as this leader. Never logged. */
  app.get('/api/v0/network/sign-in', (req) => tx(req, async (c, v) => {
    gate(v);
    const { cfg, who } = await ready(c, v);
    const r = await call(cfg, 'POST', '/api/v1/connector/sign-in', { email: who.email, name: who.name, title: who.title, role: 'leader', pulse_ref: who.pulseRef, next: nextPath((req.query as Row).next) });
    if (typeof r.url !== 'string' || !r.url.startsWith(cfg.url + '/connect/') || r.url.includes(cfg.key)) fail(502, 'Pulse Network did not answer.');
    return { url: r.url };
  }));

  /** EST-1027: the panel's first view: the feed, the leader's conversations and the open hand-offs. */
  app.get('/api/v0/network/home', (req) => tx(req, async (c, v) => {
    gate(v);
    const { cfg, who } = await ready(c, v);
    const as = await member(cfg, who);
    const topic = String((req.query as Row).topic ?? '');
    const [me, feed, channels, handoffs, members] = await Promise.all([
      call(cfg, 'GET', '/api/v1/me', undefined, as),
      call(cfg, 'GET', `/api/v1/feed?limit=25&sort=active${TOPICS.has(topic) ? `&topic=${topic}` : ''}`, undefined, as),
      call(cfg, 'GET', '/api/v1/channels', undefined, as),
      call(cfg, 'GET', '/api/v1/handoffs?status=open', undefined, as),
      call(cfg, 'GET', '/api/v1/members', undefined, as)]);
    const everyone = (members.members ?? []).filter((m: Row) => m.handle !== me.handle)
      .map((m: Row) => ({ handle: String(m.handle), name: String(m.display_name), kind: String(m.kind), org: String(m.orgs?.[0]?.short ?? ''), title: String(m.orgs?.[0]?.title ?? '') }));
    return { url: cfg.url, me: { handle: me.handle, name: me.display_name }, posts: feed.posts ?? [], channels: channels.channels ?? [], handoffs: handoffs.handoffs ?? [],
      agents: everyone.filter((m: Row) => m.kind === 'agent'), people: everyone.filter((m: Row) => m.kind !== 'agent') };
  }));

  /** A conversation (channel or direct message) and its latest messages. */
  app.get('/api/v0/network/conversations/:slug', (req) => tx(req, async (c, v) => {
    gate(v);
    const slug = String((req.params as Row).slug);
    if (!SLUG.test(slug)) fail(404, 'No such conversation.');
    const { cfg, who } = await ready(c, v);
    const after = Number((req.query as Row).after ?? 0) || 0;
    return call(cfg, 'GET', `/api/v1/channels/${slug}/messages?limit=50&after=${Math.max(0, Math.floor(after))}`, undefined, await member(cfg, who));
  }));

  /** Say something in a conversation; a message to an AI agent gets its answer in seconds. */
  app.post<{ Body: Row }>('/api/v0/network/conversations/:slug', (req) => tx(req, async (c, v) => {
    gate(v);
    const slug = String((req.params as Row).slug), body = text(req.body?.body, 20_000);
    if (!SLUG.test(slug)) fail(404, 'No such conversation.');
    if (!body) fail(400, 'Write something first.');
    const { cfg, who } = await ready(c, v);
    return call(cfg, 'POST', `/api/v1/channels/${slug}/messages`, { body }, await member(cfg, who));
  }));

  /** Start (or continue) a direct message with a member, person or AI agent. */
  app.post<{ Body: Row }>('/api/v0/network/dm/:handle', (req) => tx(req, async (c, v) => {
    gate(v);
    const handle = String((req.params as Row).handle), body = text(req.body?.body, 20_000);
    if (!HANDLE.test(handle)) fail(404, 'No such member.');
    if (!body) fail(400, 'Write something first.');
    const { cfg, who } = await ready(c, v);
    return call(cfg, 'POST', `/api/v1/dm/${handle}`, { body }, await member(cfg, who));
  }));

  /** Post to the shared feed: every company on the network sees it. */
  app.post<{ Body: Row }>('/api/v0/network/posts', (req) => tx(req, async (c, v) => {
    gate(v);
    const body = text(req.body?.body, 40_000), topic = TOPICS.has(String(req.body?.topic)) ? String(req.body?.topic) : 'general';
    let title = text(req.body?.title, 200);
    if (!title && body) { const first = body.split(/(?<=[.!?])\s|\n/)[0].trim(); title = first.length <= 120 ? first : first.slice(0, 117).replace(/\s+\S*$/, '') + '…'; }
    if (title.length < 3) fail(400, 'Write a little more: at least a short sentence.');
    const { cfg, who } = await ready(c, v);
    return call(cfg, 'POST', '/api/v1/posts', { topic, title, body }, await member(cfg, who));
  }));

  /** A feed thread with its replies (and who is answering right now), read inside Pulse. */
  app.get('/api/v0/network/threads/:num', (req) => tx(req, async (c, v) => {
    gate(v);
    const num = Number((req.params as Row).num);
    if (!Number.isInteger(num) || num < 1) fail(404, 'No such thread.');
    const { cfg, who } = await ready(c, v);
    return call(cfg, 'GET', `/api/v1/posts/${num}`, undefined, await member(cfg, who));
  }));

  /** Reply in a feed thread, to the post or to one reply; mentioning an AI agent brings its answer in seconds. */
  app.post<{ Body: Row }>('/api/v0/network/threads/:num/replies', (req) => tx(req, async (c, v) => {
    gate(v);
    const num = Number((req.params as Row).num), body = text(req.body?.body, 40_000), parent = Number(req.body?.parent ?? 0);
    if (!Number.isInteger(num) || num < 1) fail(404, 'No such thread.');
    if (!body) fail(400, 'Write something first.');
    const { cfg, who } = await ready(c, v);
    return call(cfg, 'POST', `/api/v1/posts/${num}/replies`, { body, ...(Number.isInteger(parent) && parent > 0 ? { parent } : {}) }, await member(cfg, who));
  }));

  /** Ask a person or an AI agent, in this company or another, to do something: a hand-off they accept and finish. */
  app.post<{ Body: Row }>('/api/v0/network/handoffs', (req) => tx(req, async (c, v) => {
    gate(v);
    const to = String(req.body?.to ?? '').replace(/^@/, ''), title = text(req.body?.title, 200), details = text(req.body?.details, 20_000);
    if (!HANDLE.test(to)) fail(400, 'Pick who you are asking.');
    if (title.length < 3) fail(400, 'Say in a few words what you are asking for.');
    const { cfg, who } = await ready(c, v);
    return call(cfg, 'POST', '/api/v1/handoffs', { to, title, details }, await member(cfg, who));
  }));

  /** Accept, finish, decline or cancel a hand-off; the network checks who may. */
  app.post<{ Body: Row }>('/api/v0/network/handoffs/:num', (req) => tx(req, async (c, v) => {
    gate(v);
    const num = Number((req.params as Row).num), status = String(req.body?.status ?? '');
    if (!Number.isInteger(num) || num < 1) fail(404, 'No such hand-off.');
    if (!MOVES.has(status)) fail(400, 'A hand-off can be accepted, declined, done or cancelled.');
    const { cfg, who } = await ready(c, v);
    return call(cfg, 'POST', `/api/v1/handoffs/${num}`, { status, result: text(req.body?.result, 20_000) }, await member(cfg, who));
  }));
}
