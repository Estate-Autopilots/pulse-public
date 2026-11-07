// ONBOARD-CHECKIN-TG (6 Nov 2026): link your own Telegram to the Vitals OS bot (Settings -> Notifications), or attach it
// to an AI employee you can message. The code is made here, shown once, and only its sha256 is kept (1606); the person
// sends /start <code> to the bot (services/workers/src/pulse_workers/vitals_bot.py), which redeems it. The bot is the
// platform's (VITALS_TELEGRAM_BOT_TOKEN / VITALS_TELEGRAM_BOT_USERNAME, docs/ops/TELEGRAM-BOT.md); without both set the
// routes say so and make no code.
import type { FastifyInstance } from 'fastify';
import { createHash, randomInt } from 'node:crypto';
import { fail, type Tx } from './routes.js';

// No look-alike characters (0/O, 1/I/L), as the team codes (ONBOARD).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bot's public username (without @), or null while the bot is not set up on this server. */
export function vitalsBot(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = String(env.VITALS_TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
  return env.VITALS_TELEGRAM_BOT_TOKEN?.trim() && /^[A-Za-z][A-Za-z0-9_]{3,31}bot$/i.test(name) ? name : null;
}

/** A one-time code: 10 characters, about 49 bits, spent on first use and gone after 15 minutes. */
export function linkCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** As the bot hashes what follows /start (upper-cased, spaces and dashes dropped). */
export const codeHash = (code: string) => createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, '')).digest('hex');

const agentOf = (body: unknown): string | null => {
  const raw = (body as { agentId?: unknown } | null)?.agentId;
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !UUID.test(raw)) fail(400, 'Choose an AI employee');
  return raw as string;
};

type Client = Parameters<Parameters<Tx>[1]>[0];
type TelegramSettings = { bot: 'shared' | 'own'; ownUsername: string | null; running: boolean; runningBot: string | null };

/** AGENT-CHANNELS (1603): which bot this company uses, and why there is none yet. The shared Vitals OS bot is ready when
 *  the API has its username and token, or when its worker (which alone reads /etc/estate-autopilots/apps/telegram-vitals.key)
 *  said it is running in the last 10 minutes; a company's own bot is ready once its worker runs. */
export async function companyBot(c: Client, env: NodeJS.ProcessEnv = process.env): Promise<{ bot: string | null; waiting: 'token' | 'own_bot' | null }> {
  const t = ((await c.query('select pulse.agent_channels_settings() s')).rows[0].s as { telegram: TelegramSettings }).telegram;
  if (t.bot === 'own') {
    const name = t.running ? (t.runningBot ?? t.ownUsername) : null;
    return { bot: name, waiting: name ? null : 'own_bot' };
  }
  const name = vitalsBot(env) ?? (t.running ? t.runningBot : null);
  return { bot: name, waiting: name ? null : 'token' };
}

export function registerTelegramLinkRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/telegram/link', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Use your own Vitals account');
    const status = (await c.query('select pulse.telegram_link_status() s')).rows[0].s;
    return { ...(await companyBot(c)), ...status };
  }));
  app.post<{ Body: { agentId?: unknown } }>('/api/v0/telegram/link', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Use your own Vitals account');
    const { bot } = await companyBot(c);
    if (!bot) fail(409, 'Telegram is not set up on this server yet.');
    const agent = agentOf(req.body);
    const code = linkCode();
    const made = (await c.query('select pulse.telegram_link_begin($1,$2) r', [codeHash(code), agent])).rows[0].r as { expiresAt: string };
    return { code, bot, url: `https://t.me/${bot}?start=${code}`, expiresAt: made.expiresAt };
  }));
  app.post<{ Body: { agentId?: unknown } }>('/api/v0/telegram/unlink', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Use your own Vitals account');
    await c.query('select pulse.telegram_unlink($1)', [agentOf(req.body)]);
    return { ok: true };
  }));
}
