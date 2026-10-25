// CHAT-SHELL v2: Pip's intent engine on the server. The chat runs its rules first (apps/web/app/lib/chat-intent.mjs);
// when they are not sure, it asks here. The model behind this seam is the runtime AI employees use on this server
// (PULSE_INTENT_MODEL_URL: the local runtime's intent endpoint), asked with a 2.5 s budget; when it is not set up,
// out of quota or slow, the stub answers: plain rules over the names this person may see (clients, client projects,
// work projects, people). Either way the answer is { intent, target, confidence, why } and only ever opens or suggests
// a place: nothing here changes data. Every decision the chat takes (opened, offered, nothing) is logged for tuning.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';

export type IntentAnswer = { intent: 'open'; target: { href: string; label: string }; confidence: number; why: string };
export interface IntentModel { readonly name: string; answer(c: PoolClient, text: string): Promise<IntentAnswer[]> }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const GENERIC = new Set(['test', 'team', 'office', 'home', 'work', 'pulse', 'internal', 'general', 'misc', 'admin']);
const ASK = /\b(open|show|see|check|update|add|review|look at|go to|fill)\b/i;

/** The stub: names said whole in the message, of what this person can see (the database's row security decides). */
export const stubModel: IntentModel = {
  name: 'stub-names-v1',
  async answer(c, text) {
    const t = ` ${norm(text)} `; if (t.trim().length < 3) return [];
    const rows = (await c.query(`
      select 'client' kind, id::text, display_name name from pulse.client where display_name is not null
      union all select 'project', id::text, coalesce(title, name) from pulse.project where coalesce(title, name) is not null
      union all select 'work', wp.project_id::text, coalesce(pr.title, pr.name) from pulse.work_project wp join pulse.project pr on pr.id = wp.project_id
      limit 4000`)).rows as { kind: string; id: string; name: string }[];
    const out: IntentAnswer[] = []; const ask = ASK.test(text);
    for (const r of rows) {
      const n = norm(r.name); if (n.length < 4 || GENERIC.has(n) || (!n.includes(' ') && n.length < 6)) continue;
      if (!t.includes(` ${n} `)) continue;
      const href = r.kind === 'client' ? `/clients/${r.id}` : r.kind === 'project' ? `/projects/${r.id}` : `/tasks/projects/${r.id}`;
      const what = r.kind === 'client' ? 'client' : r.kind === 'project' ? 'client project' : 'work project';
      out.push({ intent: 'open', target: { href, label: r.name }, confidence: Math.min(0.8, 0.58 + (ask ? 0.12 : 0) + Math.min(0.08, n.split(' ').length * 0.02)), why: `names the ${what} “${r.name}”` });
    }
    const seen = new Set<string>();
    return out.sort((a, b) => b.confidence - a.confidence).filter((a) => !seen.has(a.target.href) && seen.add(a.target.href)).slice(0, 3);
  },
};

/** The runtime on this server, when it is set up; the stub when it is not, out of quota, slow or wrong. */
async function ask(c: PoolClient, text: string): Promise<{ model: string; answers: IntentAnswer[] }> {
  const url = process.env.PULSE_INTENT_MODEL_URL;
  if (url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 2000), task: 'pulse-place' }), signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const d = await r.json() as { answers?: IntentAnswer[]; model?: string };
        const answers = (d.answers ?? []).filter((a) => a?.intent === 'open' && typeof a.target?.href === 'string' && a.target.href.startsWith('/') && !a.target.href.startsWith('//'))
          .map((a) => ({ ...a, confidence: Math.max(0, Math.min(0.8, Number(a.confidence) || 0)), why: String(a.why ?? '').slice(0, 200) })).slice(0, 3);
        return { model: String(d.model ?? 'runtime').slice(0, 80), answers };
      }
    } catch { /* out of quota, slow or down: the stub answers */ }
  }
  return { model: stubModel.name, answers: await stubModel.answer(c, text) };
}

type Body = { text?: string; source?: string; channelId?: string; messageId?: string; decided?: { action?: string; href?: string; confidence?: number; by?: string } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registerChatIntentRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The model's guesses for a text the rules were not sure of.
  app.post<{ Body: Body }>('/api/v0/chats/intent', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Chats requires your individual employee account');
    const text = String(req.body.text ?? '').slice(0, 2000); if (!text.trim()) return { model: stubModel.name, answers: [] };
    return ask(c, text);
  }));
  // What the chat did with a message: opened a place, offered a chip or nothing. Only for tuning: never read back to act.
  app.post<{ Body: Body }>('/api/v0/chats/intent/decision', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Chats requires your individual employee account');
    const b = req.body, d = b.decided ?? {};
    const action = ['auto', 'chip', 'none', 'taken'].includes(String(d.action)) ? String(d.action) : 'none';
    const source = ['typed', 'message', 'voice', 'task', 'home'].includes(String(b.source)) ? String(b.source) : 'message';
    await c.query(`insert into pulse.chat_intent_decision(org_id, person_id, source, channel_id, message_id, text_len, action, href, confidence, decided_by)
      values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [v.person, source, UUID.test(String(b.channelId)) ? b.channelId : null, UUID.test(String(b.messageId)) ? b.messageId : null, String(b.text ?? '').length,
        action, typeof d.href === 'string' ? d.href.slice(0, 300) : null, Number.isFinite(Number(d.confidence)) ? Number(d.confidence) : null, String(d.by ?? 'rules').slice(0, 40)]);
    return { ok: true };
  }));
}
