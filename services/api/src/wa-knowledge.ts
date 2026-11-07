import type { FastifyInstance } from 'fastify';
import { fail, type Tx, type Viewer } from './routes.js';
// WA-DATASETS (1099): the imported WhatsApp history as a retrieval corpus (pulse_priv.wa_chunk: topic-coherent pieces of
// each chat with their client, project, stage, dates, redacted text and a multilingual embedding). People search the
// chats they may read by meaning and words (pulse.wa_history_search shows them the original messages); AI employees get
// the redacted text of their conversation's client only (pulse.agent_wa_knowledge). A query is embedded by the server's
// local model when PULSE_EMBED_URL points at one (tools/wa-embed.py: multilingual-e5, no text leaves the server);
// without it, or when it is slow, the search ranks by words alone. Queries are never logged.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const optional = (raw: unknown) => raw === undefined || raw === '' ? null : UUID.test(String(raw)) ? String(raw) : fail(400, 'Choose a valid client, project or conversation');
type Q = Record<string, string | undefined>;

/** The query's embedding as pgvector text ("[x,y,…]", 768 numbers), or null (no embedder, an error, or too slow). */
export async function embedQuery(text: string, timeoutMs = Number(process.env.PULSE_EMBED_TIMEOUT_MS) || 1500): Promise<string | null> {
  const url = process.env.PULSE_EMBED_URL;
  const q = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!url || q.length < 2) return null;
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/embed`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: [q], kind: 'query' }), signal: ac.signal });
    if (!r.ok) return null;
    const v = ((await r.json()) as { vectors?: number[][] }).vectors?.[0];
    return Array.isArray(v) && v.length === 768 && v.every((x) => Number.isFinite(x)) ? `[${v.map((x) => +x.toFixed(6)).join(',')}]` : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

export function registerWaKnowledgeRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // Search the WhatsApp history the viewer may read: ?q=…&client=&project=&channel=&limit= (≤ 20).
  app.get('/api/v0/chats/history/search', req => tx(req, async (c, v: Viewer) => {
    if (!v.person) fail(403, 'Chats requires your individual employee account');
    const q = req.query as Q;
    const text = String(q.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (text.length < 2) fail(400, 'Type at least two letters');
    const vec = await embedQuery(text);
    const p = { q: text, vec, client: optional(q.client), project: optional(q.project), channel: optional(q.channel), limit: Math.min(20, Math.max(1, Number(q.limit) || 8)) };
    return { hits: (await c.query('select pulse.wa_history_search($1) r', [JSON.stringify(p)])).rows[0].r, byMeaning: vec !== null };
  }));
}
