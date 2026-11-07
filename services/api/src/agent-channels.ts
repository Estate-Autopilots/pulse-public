// AGENT-CHANNELS (6 Nov 2026): every AI employee reachable on more channels, and an always-on listening mode (1685).
// * Company settings: the shared Vitals OS Telegram bot or the company's own, the company's WhatsApp Business number,
//   listening opt-in and how long transcripts are kept (admins change them; everyone reads them).
// * WhatsApp (Meta's official Cloud API only): a person attaches their WhatsApp to an AI employee with a one-time code
//   sent to the company's business number (a wa.me link fills it in). Meta's webhook comes in here, signed with the
//   app secret; what the person writes goes into their direct chat with the AI employee and its replies go back through
//   the channel worker (services/workers/src/pulse_workers/agent_channels.py), the only holder of the access token.
// * Listening: start (consent confirmed, company opted in), short audio pieces in, live transcript and the AI
//   employee's reactions out, stop, delete; the hook's events (listen.started / listen.window / listen.stopped).
// Nothing here sends a message to anyone, and no token or secret is ever logged or returned.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { chatAdapter } from './chat-adapters.js';
import { fail, type Tx } from './routes.js';
import { codeHash, linkCode } from './telegram-link.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSES = ['general', 'quotation', 'requirements', 'meeting'] as const;
const MIMES = /^audio\/(webm|ogg|mp4|wav|x-wav|mpeg)(;[ a-z0-9=.,-]*)?$/i;
const MAX_AUDIO = 3 * 1024 * 1024; // one piece (about 10 seconds of speech is 20 to 60 KB)

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const uuidOf = (raw: unknown, what: string): string => (typeof raw === 'string' && UUID.test(raw) ? raw : fail(400, what));

/** KEY=VALUE lines (or one bare token) from a root-owned key file; {} when it is missing or unreadable. */
export function keyFile(path: string, bareKey: string): Record<string, string> {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    else if (!out[bareKey]) out[bareKey] = t;
  }
  return out;
}

export type WhatsAppAccount = { org: string; phoneNumberId: string; appSecret: string; verifyToken: string; number: string | null };

/** The WhatsApp Business numbers this server answers for: VITALS_WHATSAPP_ACCOUNTS (a JSON list, one per company), or one
 *  account from VITALS_WHATSAPP_* (env or /etc/estate-autopilots/apps/whatsapp-cloud.key). Incomplete ones are left out. */
export function whatsappAccounts(env: NodeJS.ProcessEnv = process.env): WhatsAppAccount[] {
  const file = keyFile(env.VITALS_WHATSAPP_KEY_FILE ?? '/etc/estate-autopilots/apps/whatsapp-cloud.key', 'VITALS_WHATSAPP_ACCESS_TOKEN');
  const get = (k: string) => String(env[k] ?? file[k] ?? '').trim();
  let list: Obj[] = [];
  const raw = get('VITALS_WHATSAPP_ACCOUNTS');
  if (raw) { try { const parsed: unknown = JSON.parse(raw); list = Array.isArray(parsed) ? parsed.map(obj) : []; } catch { list = []; } }
  else list = [{ org: get('VITALS_WHATSAPP_ORG'), phoneNumberId: get('VITALS_WHATSAPP_PHONE_NUMBER_ID'), appSecret: get('VITALS_WHATSAPP_APP_SECRET'),
    verifyToken: get('VITALS_WHATSAPP_VERIFY_TOKEN'), number: get('VITALS_WHATSAPP_NUMBER') }];
  return list.map((a) => ({ org: String(a.org ?? ''), phoneNumberId: String(a.phoneNumberId ?? ''), appSecret: String(a.appSecret ?? ''),
    verifyToken: String(a.verifyToken ?? ''), number: /^[1-9][0-9]{6,15}$/.test(String(a.number ?? '')) ? String(a.number) : null }))
    .filter((a) => UUID.test(a.org) && /^[0-9]{5,32}$/.test(a.phoneNumberId) && a.appSecret.length >= 8 && a.verifyToken.length >= 8);
}

/** "link ABCD234567", "/start ABCD234567" or the code alone -> the code (upper case), else null. */
export function codeIn(text: string): string | null {
  const m = /^(?:\/?(?:link|start)\s+)?([A-HJ-NP-Za-hj-np-z2-9]{10})$/i.exec(String(text ?? '').trim());
  return m ? m[1].toUpperCase() : null;
}
/** WhatsApp codes are hashed in their own domain, so a WhatsApp code never links a Telegram chat (and back). */
export const waCodeHash = (code: string) => codeHash(`WA${code}`);

export function registerAgentChannelRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool: Pool }) {
  // ----- company settings ---------------------------------------------------------------------------------------------
  const settings = async (c: Parameters<Parameters<Tx>[1]>[0]) => {
    const s = (await c.query('select pulse.agent_channels_settings() s')).rows[0].s as Obj;
    const shared = String(process.env.VITALS_TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '') || null;
    return { ...s, server: { telegramSharedBot: shared, whatsappWebhook: whatsappAccounts().length > 0 } };
  };
  app.get('/api/v0/agent-channels', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your own Vitals account');
    return settings(c);
  }));
  app.put<{ Body: Obj }>('/api/v0/agent-channels', req => tx(req, async (c, v) => {
    if (!v.person || v.role !== 'admin') fail(403, 'Admins set how AI employees are reached');
    const b = obj(req.body), p: Obj = {};
    if (b.listenOn !== undefined) p.listenOn = b.listenOn === true;
    if (b.whatsappOn !== undefined) p.whatsappOn = b.whatsappOn === true;
    if (b.listenRetentionDays !== undefined) {
      const d = Number(b.listenRetentionDays);
      if (!Number.isInteger(d) || d < 1 || d > 365) fail(400, 'Keep transcripts between 1 and 365 days');
      p.listenRetentionDays = d;
    }
    if (b.telegramBot !== undefined) { if (b.telegramBot !== 'shared' && b.telegramBot !== 'own') fail(400, 'Choose the shared bot or your own'); p.telegramBot = b.telegramBot; }
    if (b.telegramOwnUsername !== undefined) {
      const u = String(b.telegramOwnUsername ?? '').trim().replace(/^@/, '');
      if (u && !/^[A-Za-z][A-Za-z0-9_]{3,31}bot$/i.test(u)) fail(400, 'A Telegram bot username ends in "bot"');
      p.telegramOwnUsername = u;
    }
    await c.query('select pulse.agent_channels_settings_set($1::jsonb)', [JSON.stringify(p)]);
    return settings(c);
  }));

  // ----- WhatsApp: attach a person's WhatsApp to an AI employee ----------------------------------------------------------
  app.get('/api/v0/whatsapp/link', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your own Vitals account');
    const s = (await c.query('select pulse.agent_channels_settings() s')).rows[0].s as { whatsapp: { on: boolean; running: boolean; number: string | null } };
    const mine = (await c.query('select pulse.whatsapp_link_status() s')).rows[0].s as Obj;
    const number = s.whatsapp.number ?? whatsappAccounts().find((a) => a.org === v.org)?.number ?? null;
    return { on: s.whatsapp.on, running: s.whatsapp.running, number: number ? `+${number}` : null,
      ready: s.whatsapp.on && !!number && whatsappAccounts().some((a) => a.org === v.org), ...mine };
  }));
  app.post<{ Body: Obj }>('/api/v0/whatsapp/link', req => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Use your own Vitals account');
    const s = (await c.query('select pulse.agent_channels_settings() s')).rows[0].s as { whatsapp: { on: boolean; number: string | null } };
    const account = whatsappAccounts().find((a) => a.org === v.org);
    const number = s.whatsapp.number ?? account?.number ?? null;
    if (!s.whatsapp.on || !account || !number) fail(409, 'WhatsApp is not connected for this company yet.');
    const agent = uuidOf(obj(req.body).agentId, 'Choose an AI employee');
    const code = linkCode();
    const made = (await c.query('select pulse.whatsapp_link_begin($1,$2) r', [waCodeHash(code), agent])).rows[0].r as { expiresAt: string };
    return { code, url: `https://wa.me/${number}?text=${encodeURIComponent(`link ${code}`)}`, number: `+${number}`, expiresAt: made.expiresAt };
  }));
  app.post<{ Body: Obj }>('/api/v0/whatsapp/unlink', req => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Use your own Vitals account');
    const raw = obj(req.body).agentId;
    await c.query('select pulse.whatsapp_unlink($1)', [raw == null || raw === '' ? null : uuidOf(raw, 'Choose an AI employee')]);
    return { ok: true };
  }));

  // ----- Meta's webhook (WhatsApp Cloud API): the verification handshake and signed incoming messages ----------------
  app.get<{ Querystring: Obj }>('/api/v0/channels/whatsapp/hook', async (req, reply) => {
    const accounts = whatsappAccounts();
    if (!accounts.length) return reply.code(404).send({ error: 'WhatsApp is not connected on this server' });
    const q = obj(req.query);
    const ok = q['hub.mode'] === 'subscribe' && accounts.some((a) => a.verifyToken === String(q['hub.verify_token'] ?? ''));
    if (!ok || !/^[A-Za-z0-9_-]{1,128}$/.test(String(q['hub.challenge'] ?? ''))) return reply.code(403).send({ error: 'Verification failed' });
    return reply.type('text/plain').send(String(q['hub.challenge']));
  });
  app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 262144 }, (_req, raw, done) => done(null, raw));
    hook.post('/api/v0/channels/whatsapp/hook', async (req, reply) => {
      const accounts = whatsappAccounts();
      if (!accounts.length) return reply.code(404).send({ error: 'WhatsApp is not connected on this server' });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let payload: Obj;
      try { payload = obj(JSON.parse(raw.toString('utf8'))); } catch { return reply.code(400).send({ error: 'Invalid payload' }); }
      const numbers = new Set<string>();
      for (const e of Array.isArray(payload.entry) ? payload.entry : []) for (const ch of Array.isArray(obj(e).changes) ? obj(e).changes as unknown[] : [])
        numbers.add(String(obj(obj(obj(ch).value).metadata).phone_number_id ?? ''));
      const account = numbers.size === 1 ? accounts.find((a) => numbers.has(a.phoneNumberId)) : undefined;
      if (!account) return reply.code(404).send({ error: 'Unknown business number' });
      const adapter = chatAdapter('whatsapp', { PULSE_WHATSAPP_CHAT_ENABLED: '1', PULSE_WHATSAPP_APP_SECRET: account.appSecret })!;
      if (!adapter.verify(raw, String(req.headers['x-hub-signature-256'] ?? ''))) return reply.code(401).send({ error: 'Signature verification failed' });
      const messages = adapter.messages(payload);
      if (messages.length > 50) return reply.code(413).send({ error: 'Too many messages in one delivery' });
      const c = await pool.connect();
      let handled = 0;
      try {
        await c.query('begin');
        await c.query("select set_config('pulse.org_id',$1,true)", [account.org]);
        for (const m of messages) {
          if (m.kind !== 'text' || !/^[1-9][0-9]{6,15}$/.test(m.senderRef)) continue;
          const code = codeIn(m.text);
          await c.query('select pulse.whatsapp_inbound($1,$2,$3)', [m.senderRef, m.text, code ? waCodeHash(code) : null]);
          handled++;
        }
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => {});
        req.log.warn({ reason: (e as Error).message?.slice(0, 120) }, 'WhatsApp delivery not stored');
        return reply.code(503).send({ error: 'Try again' }); // Meta retries a delivery that was not accepted
      } finally { c.release(); }
      return { ok: true, handled };
    });
  });

  // ----- listening ----------------------------------------------------------------------------------------------------
  app.get('/api/v0/listen', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your own Vitals account');
    const s = (await c.query('select pulse.agent_channels_settings() s')).rows[0].s as { canEdit: boolean; listen: Obj };
    const sessions = (await c.query('select pulse.listen_sessions() s')).rows[0].s;
    const agents = (await c.query('select pulse.listen_agents() a')).rows[0].a;
    return { ...s.listen, canEdit: s.canEdit, sessions, agents };
  }));
  app.post<{ Body: Obj }>('/api/v0/listen/sessions', req => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Use your own Vitals account');
    const s = (await c.query('select pulse.agent_channels_settings() s')).rows[0].s as { listen: { on: boolean } };
    if (!s.listen.on) fail(409, 'Listening is off for this company. An admin can switch it on.');
    const b = obj(req.body);
    if (b.consent !== true) fail(400, 'Tell everyone on the call that it is being recorded, then confirm.');
    const title = String(b.title ?? '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
    if (!title) fail(400, 'Give the session a short name');
    const purpose = PURPOSES.includes(b.purpose as typeof PURPOSES[number]) ? b.purpose as string : 'general';
    const agent = b.agentId == null || b.agentId === '' ? null : uuidOf(b.agentId, 'Choose an AI employee');
    return (await c.query('select pulse.listen_start($1,$2,$3,true) r', [agent, title, purpose])).rows[0].r;
  }));
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/v0/listen/sessions/:id', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your own Vitals account');
    const after = Number.parseInt(String(req.query.after ?? '-1'), 10);
    return (await c.query('select pulse.listen_view($1,$2) r', [uuidOf(req.params.id, 'Choose a listening session'), Number.isFinite(after) ? Math.max(-1, Math.min(after, 100000)) : -1])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Obj }>('/api/v0/listen/sessions/:id/audio', { bodyLimit: Math.ceil(MAX_AUDIO * 1.4) + 4096 }, req => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Use your own Vitals account');
    const id = uuidOf(req.params.id, 'Choose a listening session'), b = obj(req.body);
    const seq = Number(b.seq), ms = Number(b.ms), mime = String(b.mime ?? '');
    if (!Number.isInteger(seq) || seq < 0 || seq > 100000) fail(400, 'Send the pieces in order');
    if (!MIMES.test(mime)) fail(400, 'Send audio (webm, ogg, mp4 or wav)');
    const audio = Buffer.from(String(b.audio ?? ''), 'base64');
    if (audio.length > MAX_AUDIO) fail(413, 'Send shorter pieces');
    return (await c.query('select pulse.listen_chunk_add($1,$2,$3,$4,$5) r', [id, seq, mime.toLowerCase(), Number.isFinite(ms) ? Math.round(ms) : 0, audio])).rows[0].r;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/listen/sessions/:id/stop', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your own Vitals account');
    return (await c.query('select pulse.listen_stop($1) r', [uuidOf(req.params.id, 'Choose a listening session')])).rows[0].r;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/listen/sessions/:id/delete', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your own Vitals account');
    await c.query('select pulse.listen_delete($1)', [uuidOf(req.params.id, 'Choose a listening session')]);
    return { ok: true };
  }));
  // The hook for other flows (e.g. a quotation flow): listening events after a sequence number, admins only.
  app.get<{ Querystring: { after?: string } }>('/api/v0/listen/events', req => tx(req, async (c, v) => {
    if (!v.person || v.role !== 'admin') fail(403, 'Admins read the listening hook');
    const after = Number.parseInt(String(req.query.after ?? '0'), 10);
    return { events: (await c.query('select pulse.listen_events($1,200) e', [Number.isFinite(after) && after > 0 ? after : 0])).rows[0].e };
  }));
}
