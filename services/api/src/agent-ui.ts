// AGENT-UI-CONTROL (7 Nov 2026): the browser's side of AI employees driving the screen (migration 1745). The person's
// browser keeps one live stream (/api/v0/screen/events, the same LISTEN-and-stream pattern as Chats: NOTIFY pulse_ui
// "org:person[:ask]" wakes it at once, a 10-second check is the safety net) that carries what to do now and the prompts
// this person may answer. The first open tab takes each action (claim), does it, and says how it went (done). Prompts are
// answered here (Allow once / Always / No); levels and kept allows are set on the AI employee's profile; cards in the chat
// are filled in or closed here. The database decides every rule.
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { fileAgentProblem } from './bug-reports.js';
import { readFileSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const idOf = (raw: unknown, what: string): string => (typeof raw === 'string' && UUID.test(raw) ? raw : fail(400, `Choose ${what}`));
const person = (v: Viewer) => { if (!v.person) fail(403, 'Use your own Pulse account'); return v.person!; };
const leads = (v: Viewer) => v.role === 'admin' || v.role === 'leadership' || v.lead === true;
/** One value from a database function; "already done" / "has ended" (55000) is a conflict (409) said in its own words. */
const value = async (c: PoolClient, sql: string, args: unknown[] = []) => {
  try { return (await c.query(sql, args)).rows[0]?.v; }
  catch (e) { const err = e as { code?: string; message?: string }; if (err.code === '55000') fail(409, String(err.message ?? 'This has already ended')); throw e; }
};

/** One LISTEN connection per API process for pulse_ui; each stream hears only its own person (and asks, for leaders). */
class UiHub {
  private subs = new Map<string, Set<(who: string, ask: boolean) => void>>(); private client: PoolClient | null = null; private starting = false; private closed = false;
  constructor(private pool?: Pool) {}
  close() { this.closed = true; const c = this.client; this.client = null; if (c) { try { c.release(true); } catch { /* gone */ } } }
  private async listen() {
    if (!this.pool || this.client || this.starting || this.closed) return; this.starting = true;
    try {
      const c = await this.pool.connect();
      c.on('notification', (m) => { const [org, who, ask] = String(m.payload ?? '').split(':'); if (org && who) this.subs.get(org)?.forEach((f) => f(who, ask === 'ask')); });
      c.on('error', () => this.drop(c));
      await c.query('listen pulse_ui');
      if (this.closed) { c.release(true); return; } this.client = c;
    } catch { if (!this.closed) setTimeout(() => void this.listen(), 5000).unref(); } finally { this.starting = false; }
  }
  private drop(c: PoolClient) { if (this.client !== c) return; this.client = null; try { c.release(true); } catch { /* gone */ } if (!this.closed) setTimeout(() => void this.listen(), 2000).unref(); }
  on(org: string, f: (who: string, ask: boolean) => void) {
    void this.listen(); let s = this.subs.get(org); if (!s) { s = new Set(); this.subs.set(org, s); } s.add(f);
    return () => { s!.delete(f); if (!s!.size) this.subs.delete(org); };
  }
}

/** What a step was doing, in the catalogue's words ("click “Approve”"). */
const WORDS = (JSON.parse(readFileSync(new URL('../data/agent-ui-actions.json', import.meta.url), 'utf8')) as { actions: { name: string; asks: string }[] }).actions;
function doing(name: string, args: Obj): string {
  const a = WORDS.find((x) => x.name === name);
  return a ? a.asks.replace(/\{(\w+)(?::[^}]*)?\}/g, (_, k: string) => String(args[k] ?? '').slice(0, 60)).replace(/\s+/g, ' ').trim() : name;
}

/** A short fingerprint of what the browser holds, so the stream writes only when something changed. */
const stamp = (p: Obj) => JSON.stringify([...(p.actions as Obj[] ?? []).map((a) => `${a.id}:${a.state}`), '|', ...(p.asks as Obj[] ?? []).map((a) => `${a.id}:${a.state}`)]);

export function registerAgentUiRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool?: Pool }) {
  const hub = new UiHub(pool);
  app.addHook('onClose', async () => hub.close());
  const pending = (c: PoolClient) => value(c, 'select pulse.agent_ui_pending() v') as Promise<Obj>;

  app.get('/api/v0/screen/pending', (req) => tx(req, async (c, v) => { person(v); return pending(c); }));

  // The live stream: what to do now and the prompts to answer, written whenever they change.
  app.get('/api/v0/screen/events', async (req, reply) => {
    let me = '', org = '', manager = false;
    const read = () => tx(req, async (c, v) => { me = person(v); org = v.org; const p = await pending(c); manager = p.manager === true; return p; });
    let last = await read(), sig = stamp(last), busy = false, again = false;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'private, no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write(`retry: 2000\nevent: screen\ndata: ${JSON.stringify(last)}\n\n`);
    const check = async (beat: boolean) => {
      if (reply.raw.destroyed) return; if (busy) { again = true; return; } busy = true;
      try {
        last = await read(); const next = stamp(last);
        if (next !== sig) { sig = next; reply.raw.write(`event: screen\ndata: ${JSON.stringify(last)}\n\n`); } else if (beat) reply.raw.write(': heartbeat\n\n');
      } catch { reply.raw.end(); } finally { busy = false; if (again) { again = false; void check(false); } }
    };
    const off = hub.on(org, (who, ask) => { if (who === me || (ask && manager)) void check(false); });
    const tick = setInterval(() => void check(true), 10000);
    const end = setTimeout(() => reply.raw.end(), 40000);
    reply.raw.on('close', () => { off(); clearInterval(tick); clearTimeout(end); });
  });

  app.post<{ Params: { id: string } }>('/api/v0/screen/actions/:id/claim', (req) => tx(req, async (c, v) => {
    person(v); return { action: (await value(c, 'select pulse.agent_ui_claim($1) v', [idOf(req.params.id, 'the action')])) ?? null };
  }));
  // AGENT-OPERATOR (2080): a step that did not work may carry `problem` (the page's address and a picture of it): it is
  // filed as a bug by the AI employee that sent the step (bug-reports.ts fileAgentProblem); the answer says its number.
  app.post<{ Params: { id: string }; Body: Obj }>('/api/v0/screen/actions/:id/done', { bodyLimit: 6 * 1024 * 1024 }, (req) => tx(req, async (c, v) => {
    person(v);
    const b = obj(req.body), result = b.result === undefined || b.result === null ? null : obj(b.result);
    if (result && JSON.stringify(result).length > 4000) fail(400, 'The result is too long');
    const action = await value(c, 'select pulse.agent_ui_done($1,$2,$3::jsonb,$4) v', [idOf(req.params.id, 'the action'), b.ok === true, result ? JSON.stringify(result) : null,
      typeof b.error === 'string' ? b.error.slice(0, 300) : null]) as Obj;
    const agent = obj(action?.agent), problem = obj(b.problem);
    const bug = b.ok !== true && typeof agent.id === 'string' && b.problem
      ? await fileAgentProblem(c, { id: String(action.id), action: String(action.action), agentId: agent.id, agentName: String(agent.name ?? 'The AI employee'),
          doing: doing(String(action.action), obj(action.args)), error: String(action.error ?? 'It did not work') }, { route: problem.route, screenshot: problem.screenshot })
      : null;
    return { action, bug };
  }));
  app.post<{ Params: { id: string }; Body: Obj }>('/api/v0/screen/actions/:id/decide', (req) => tx(req, async (c, v) => {
    person(v);
    const d = obj(req.body).decision;
    if (d !== 'once' && d !== 'always' && d !== 'no') fail(400, 'Choose Allow once, Always or No');
    return { action: await value(c, 'select pulse.agent_ui_decide($1,$2) v', [idOf(req.params.id, 'the request'), d]) };
  }));

  // An AI employee's screen control (its profile → AI → Capabilities): its manager reads it; admins and leadership change it.
  app.get<{ Params: { id: string } }>('/api/v0/screen/agents/:id', (req) => tx(req, async (c, v) => {
    person(v); return value(c, 'select pulse.agent_ui_settings($1) v', [idOf(req.params.id, 'the AI employee')]);
  }));
  app.put<{ Params: { id: string }; Body: Obj }>('/api/v0/screen/agents/:id', (req) => tx(req, async (c, v) => {
    person(v); if (!leads(v)) fail(403, 'Admins and leadership set how far an AI employee drives the screen');
    const level = obj(req.body).level;
    if (!['off', 'view', 'act', 'admin'].includes(String(level))) fail(400, 'Choose Off, View, Act or Admin');
    return value(c, 'select pulse.agent_ui_level_set($1,$2) v', [idOf(req.params.id, 'the AI employee'), level]);
  }));
  app.post<{ Params: { id: string }; Body: Obj }>('/api/v0/screen/agents/:id/allows/remove', (req) => tx(req, async (c, v) => {
    person(v); if (!leads(v)) fail(403, 'Admins and leadership change what an AI employee may always do');
    const action = String(obj(req.body).action ?? '');
    if (!/^[a-z]+\.[a-z]+$/.test(action)) fail(400, 'Choose the action');
    return value(c, 'select pulse.agent_ui_allow_remove($1,$2) v', [idOf(req.params.id, 'the AI employee'), action]);
  }));

  // Cards in the chat: filled in (as the person: their own permissions decide) or closed.
  app.post<{ Params: { id: string }; Body: Obj }>('/api/v0/screen/cards/:id/submit', (req) => tx(req, async (c, v) => {
    person(v);
    const raw = obj(obj(req.body).values), values: Obj = {};
    for (const k of ['name', 'title', 'company', 'phone', 'email', 'city', 'notes', 'summary', 'dueOn', 'choice']) {
      const x = raw[k]; if (typeof x === 'string' && x.trim()) values[k] = x.trim().slice(0, k === 'notes' || k === 'summary' ? 2000 : 200);
    }
    if (values.dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(String(values.dueOn))) fail(400, 'Choose a valid date');
    return value(c, 'select pulse.agent_ui_card_submit($1,$2::jsonb) v', [idOf(req.params.id, 'the card'), JSON.stringify(values)]);
  }));
  app.post<{ Params: { id: string } }>('/api/v0/screen/cards/:id/dismiss', (req) => tx(req, async (c, v) => {
    person(v); return value(c, 'select pulse.agent_ui_card_dismiss($1) v', [idOf(req.params.id, 'the card')]);
  }));
}
