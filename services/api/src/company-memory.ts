import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
// EA-PATTERNS (2170): the company memory. One index over everything the company writes down (imported WhatsApp groups,
// Pulse conversations, tasks, meeting transcripts, docs, invoice lines), built nightly on the server by
// tools/company-memory.py (multilingual-e5-small, 384-d; no text leaves the server). pulse.memory_search ranks by words
// (BM25) and meaning (HNSW) together and returns citations only from sources the viewer may read; AI employees get
// imported WhatsApp text only redacted. The answer here is extractive: the places that answer the question, grouped,
// with their citations — an AI employee calling ask_company_memory writes the prose itself. Queries are never logged.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set(['whatsapp', 'chat', 'task', 'meeting', 'doc', 'invoice']);
const MODELS = new Set(['churn', 'late_payment', 'delivery_delay']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
type Q = Record<string, string | undefined>;

export type MemoryHit = {
  id: string; kind: string; title: string; score: number; byWords: boolean; byMeaning: boolean; where: string | null;
  channelId: string | null; messageId: string | null; link: string | null; clientId: string | null; client: string | null;
  projectId: string | null; project: string | null; from: string; to: string; speakers: string[]; events: string[];
  text: string | null; redacted: boolean;
};

/** The question's embedding as pgvector text (384 numbers) from the server's local model, or null (no embedder, slow). */
export async function embedMemoryQuery(text: string, timeoutMs = Number(process.env.PULSE_EMBED_TIMEOUT_MS) || 1500): Promise<string | null> {
  const url = process.env.PULSE_EMBED_URL;
  const q = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!url || q.length < 2) return null;
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/embed`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: [q], kind: 'query', model: 'e5-small' }), signal: ac.signal });
    if (!r.ok) return null;
    const v = ((await r.json()) as { vectors?: number[][] }).vectors?.[0];
    return Array.isArray(v) && v.length === 384 && v.every((x) => Number.isFinite(x)) ? `[${v.map((x) => +x.toFixed(6)).join(',')}]` : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** Dates a question names ("in October", "in Sept 2026", "last month"), as a [from, to) window; else none. */
export function datesOf(question: string, now = new Date()): { from: string | null; to: string | null } {
  const q = question.toLowerCase();
  const iso = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  if (/\blast month\b/.test(q)) { const y = now.getUTCFullYear(), m = now.getUTCMonth(); return { from: iso(y, m - 1), to: iso(y, m) }; }
  if (/\bthis month\b/.test(q)) { const y = now.getUTCFullYear(), m = now.getUTCMonth(); return { from: iso(y, m), to: iso(y, m + 1) }; }
  const hit = q.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:\s+(20\d\d))?/);
  if (!hit || (hit[1] === 'may' && !hit[2] && !/\b(in|of|during|since) may\b/.test(q))) return { from: null, to: null };
  const m = MONTHS.indexOf(hit[1].slice(0, 3));
  let y = hit[2] ? Number(hit[2]) : now.getUTCFullYear();
  if (!hit[2] && m > now.getUTCMonth()) y -= 1;                   // "in December" asked in November means last December
  return { from: iso(y, m), to: iso(y, m + 1) };
}

/** The event tags a question names ("complained" → complaint, "overdue" → delay): searched as tags, not only as words. */
export function eventsOf(question: string): string[] {
  const words = question.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u);
  return [...new Set(words.flatMap((w) => Object.entries(EVENT_STEMS).filter(([, re]) => re.test(w)).map(([tag]) => tag)))];
}

/** Words a question uses only to ask (they would rank every chunk): kept out of the word search, not the meaning. */
export function searchWords(question: string): string {
  const drop = new Set(['which', 'what', 'who', 'when', 'where', 'how', 'did', 'does', 'do', 'we', 'our', 'us', 'the', 'a', 'an', 'in', 'on', 'of', 'to',
    'for', 'about', 'with', 'is', 'are', 'was', 'were', 'any', 'all', 'me', 'tell', 'show', 'list', 'clients', 'client', 'last', 'this', 'month',
    ...MONTHS, 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'sept', 'october', 'november', 'december']);
  const words = question.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !drop.has(w) && !/^20\d\d$/.test(w));
  // The index tags each piece with its events (complaint, delay, approval, payment…); the word search does not stem, so a
  // question's "complained", "delays" or "approved" also looks for the tag.
  const tags = words.flatMap((w) => Object.entries(EVENT_STEMS).filter(([, re]) => re.test(w)).map(([tag]) => tag));
  return [...new Set([...words, ...tags])].join(' ');
}
const EVENT_STEMS: Record<string, RegExp> = { complaint: /^complain/, delay: /^(delay|late|overdue)/, approval: /^approv/, payment: /^(pay|paid)/,
  request: /^request/, change: /^(change|revis)/, delivery: /^deliver/, promise: /^promis/ };

/** An extractive answer: how many places answer the question, then one line per client (or source) with its dates,
 * the events seen there and the numbered citations. No model writes it, so it never says more than the sources do. */
export function answerFrom(question: string, hits: MemoryHit[]): string {
  if (!hits.length) return 'Nothing in the company memory you can see answers this. Try other words, or a client name.';
  const groups = new Map<string, { label: string; dates: string[]; events: Set<string>; refs: number[] }>();
  hits.forEach((h, i) => {
    const key = h.clientId ?? h.where ?? h.kind;
    const label = h.client ?? h.where ?? ({ task: 'Tasks', invoice: 'Invoices', doc: 'Docs', meeting: 'Meetings', chat: 'Conversations' } as Record<string, string>)[h.kind] ?? h.kind;
    const g = groups.get(key) ?? { label, dates: [], events: new Set<string>(), refs: [] };
    g.dates.push(h.from.slice(0, 10)); h.events.forEach((e) => g.events.add(e)); g.refs.push(i + 1);
    groups.set(key, g);
  });
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const lines = [...groups.values()].map((g) => {
    const ds = [...new Set(g.dates)].sort(); const when = ds.length > 1 ? `${fmt(ds[0])} – ${fmt(ds[ds.length - 1])}` : fmt(ds[0]);
    return `• ${g.label} (${when})${g.events.size ? `: ${[...g.events].join(', ')}` : ''} ${g.refs.map((r) => `[${r}]`).join('')}`;
  });
  return `${hits.length} place${hits.length === 1 ? '' : 's'} in the company memory match "${question.slice(0, 120)}", in ${groups.size} ${groups.size === 1 ? 'client or source' : 'clients or sources'}:\n${lines.join('\n')}`;
}

export type MemoryAsk = { q: string; client?: string | null; kinds?: string[] | null; from?: string | null; to?: string | null; limit?: number };

/** Search as the viewer (people) or the AI employee (its key), with dates read from the question when none are given. */
export async function memorySearch(c: PoolClient, p: MemoryAsk): Promise<{ hits: MemoryHit[]; byMeaning: boolean; from: string | null; to: string | null }> {
  const asked = datesOf(p.q);
  const from = p.from ?? asked.from, to = p.to ?? asked.to;
  const vec = await embedMemoryQuery(p.q);
  const words = searchWords(p.q) || p.q;
  const body = { q: words, vec, client: p.client ?? null, kinds: p.kinds?.length ? p.kinds : null, from, to, events: eventsOf(p.q), limit: Math.min(40, Math.max(1, p.limit ?? 10)) };
  const hits = (await c.query('select pulse.memory_search($1) r', [JSON.stringify(body)])).rows[0].r as MemoryHit[];
  return { hits, byMeaning: vec !== null, from, to };
}

const optional = (raw: unknown, what: string) => raw === undefined || raw === '' ? null : UUID.test(String(raw)) ? String(raw) : fail(400, `Choose a valid ${what}`);
const day = (raw: unknown) => raw === undefined || raw === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? String(raw) : fail(400, 'Use dates like 2026-10-01');
const kindsOf = (raw: unknown) => raw === undefined || raw === '' ? null : String(raw).split(',').map((k) => k.trim()).filter((k) => KINDS.has(k));

export function registerCompanyMemoryRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // Search everything the viewer may read: ?q=…&client=&kinds=whatsapp,task&from=&to=&limit= (≤ 40).
  app.get('/api/v0/memory/search', req => tx(req, async (c, v: Viewer) => {
    if (!v.person) fail(403, 'The company memory needs your individual employee account');
    const q = req.query as Q;
    const text = String(q.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (text.length < 2) fail(400, 'Type at least two letters');
    const r = await memorySearch(c, { q: text, client: optional(q.client, 'client'), kinds: kindsOf(q.kinds), from: day(q.from), to: day(q.to), limit: Number(q.limit) || 10 });
    return { hits: r.hits, byMeaning: r.byMeaning, from: r.from, to: r.to };
  }));
  // Ask a question: the extractive answer and its citations.
  app.get('/api/v0/memory/ask', req => tx(req, async (c, v: Viewer) => {
    if (!v.person) fail(403, 'The company memory needs your individual employee account');
    const text = String((req.query as Q).q ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (text.length < 3) fail(400, 'Ask a question of at least three letters');
    const r = await memorySearch(c, { q: text, limit: 8 });
    return { answer: answerFrom(text, r.hits), citations: r.hits, byMeaning: r.byMeaning, from: r.from, to: r.to };
  }));
  // Decision-model scores the viewer may see, highest first, with reasons and how each model did on past data.
  app.get('/api/v0/memory/risks', req => tx(req, async (c, v: Viewer) => {
    if (!v.person) fail(403, 'Risk scores need your individual employee account');
    const q = req.query as Q;
    const model = q.model && MODELS.has(q.model) ? q.model : q.model ? fail(400, 'Choose churn, late_payment or delivery_delay') : null;
    const band = q.band && ['low', 'medium', 'high'].includes(q.band) ? q.band : null;
    return (await c.query('select pulse.memory_risks($1) r', [JSON.stringify({ model, band, client: optional(q.client, 'client'), limit: Math.min(200, Number(q.limit) || 50) })])).rows[0].r;
  }));
  app.get('/api/v0/memory/status', req => tx(req, async (c, v: Viewer) => {
    if (!v.person) fail(403, 'The company memory needs your individual employee account');
    return (await c.query('select pulse.memory_status() r')).rows[0].r ?? {};
  }));
}
