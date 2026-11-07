import type { FastifyInstance } from 'fastify';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
// WA-INTEL (1070): the work the imported WhatsApp groups record. Insights → "From the chats": decisions judged by what
// followed, mistakes with root cause and prevention, practices, the best and worst runs, workflows per service, the
// team's numbers, and open work as suggested tasks a leader turns into a Pulse task for a person they choose (never
// assigned by itself). A client's money and milestones from its chats; a person's own numbers on their page (leaders,
// admins and the person themself). Reads go through the database's security-definer functions.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PARTS = new Set(['summary', 'learning', 'work', 'team']);
const KINDS = new Set(['decision', 'incident', 'practice', 'case_study']);
const VERDICTS = new Set(['good', 'bad', 'neutral', 'unclear', 'low', 'medium', 'high', 'best', 'worst']);
const STATES = new Set(['suggested', 'accepted', 'dismissed', 'history']);
const lead = (v: Viewer) => { if (!v.person) fail(403, 'Insights need your individual employee account'); if (!leadership(v)) fail(403, 'Insights are for leadership and admins'); };
const uuid = (x: unknown, what: string) => typeof x === 'string' && UUID.test(x) ? x : fail(400, `Choose a valid ${what}`);

/** The filter the database reads, from the query string (unknown values are dropped, never passed on). */
export function intelFilter(q: Record<string, string | undefined>) {
  const p: Record<string, string | number | boolean> = { part: PARTS.has(q.part ?? '') ? q.part! : 'summary' };
  if (q.kind && KINDS.has(q.kind)) p.kind = q.kind;
  if (q.verdict && VERDICTS.has(q.verdict)) p.verdict = q.verdict;
  if (q.category && /^[a-z_]{1,40}$/.test(q.category)) p.category = q.category;
  if (q.client && UUID.test(q.client)) p.client = q.client;
  if (q.person && UUID.test(q.person)) p.person = q.person;
  if (q.state && STATES.has(q.state)) p.state = q.state;
  if (q.stale === 'true' || q.stale === 'false') p.stale = q.stale === 'true';
  if (q.side === 'team' || q.side === 'client') p.side = q.side;
  const limit = Number(q.limit); if (Number.isFinite(limit) && limit > 0) p.limit = Math.min(1000, Math.floor(limit));
  return p;
}

export function registerWaIntelRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/insights/work', (req) => tx(req, async (c, v) => {
    lead(v);
    const p = intelFilter(req.query as Record<string, string | undefined>);
    const r = (await c.query('select pulse.wa_intel($1) r', [JSON.stringify(p)])).rows[0].r;
    if (r === null) fail(403, 'Insights are for leadership and admins');
    return p.part === 'summary' ? r : { part: p.part, rows: r };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/insights/work/clients/:id', (req) => tx(req, async (c, v) => {
    lead(v); const id = uuid(req.params.id, 'client');
    return (await c.query('select pulse.wa_client_finance($1) r', [id])).rows[0].r ?? fail(403, 'Insights are for leadership and admins');
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/insights/work/items/:id', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    lead(v); const id = uuid(req.params.id, 'suggestion');
    const action = ['accept', 'dismiss', 'restore'].includes(String(req.body.action)) ? String(req.body.action) : fail(400, 'Accept, dismiss or restore');
    const p: Record<string, string> = {};
    if (action === 'accept') {
      p.assigneeId = uuid(req.body.assigneeId, 'person to do it');
      if (req.body.dueOn !== undefined && req.body.dueOn !== null && req.body.dueOn !== '') {
        const d = String(req.body.dueOn); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(400, 'Give the due date as YYYY-MM-DD'); p.dueOn = d;
      }
    }
    try { return (await c.query('select pulse.wa_work_decide($1,$2,$3) r', [id, action, JSON.stringify(p)])).rows[0].r; }
    catch (e) { const code = (e as { code?: string }).code; if (code === 'P0002') fail(404, 'That suggestion is gone'); if (code === '22023' || code === '42501') fail(code === '42501' ? 403 : 400, (e as Error).message); throw e; }
  }));
  // Everyone may ask; the answer is the person's numbers only for leaders, admins and the person themself.
  app.get<{ Params: { id: string } }>('/api/v0/people/:id/chat-performance', (req) => tx(req, async (c) => {
    const id = uuid(req.params.id, 'person');
    return { perf: (await c.query('select pulse.wa_person_perf_read($1) r', [id])).rows[0].r ?? null };
  }));
}
