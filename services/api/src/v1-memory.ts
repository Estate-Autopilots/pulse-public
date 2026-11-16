// EA-PATTERNS (2170): the company memory for apps and AI employees (MCP tools ask_company_memory, get_risk_scores).
// Both read as the caller: a person's key sees what that person may read; an AI employee's key gets imported WhatsApp
// text only redacted (pulse.memory_search decides). No writes.
import { answerFrom, memorySearch } from './company-memory.js';
import { defineV1Operation } from './v1.js';
import { maybe, maybeNum, num, object, one, qText, str } from './v1-kit.js';

const strs = { type: 'array', items: str };
const CITATION = object({
  n: num, kind: str, title: str, where: maybe, client: maybe, project: maybe, from: str, to: str, link: maybe,
  speakers: strs, events: strs, text: maybe, redacted: { type: 'boolean' },
});
const REASON = object({ text: str, weight: num });
const SCORE = object({
  model: str, subject: str, key: str, label: str, client: maybe, owner: maybe, score: num, band: str,
  reasons: { type: 'array', items: REASON }, asOf: str,
});
const CARD = object({ model: str, version: str, builtAt: str, method: str, auc: maybeNum, baseRate: maybeNum, testedOn: maybeNum, split: maybe });

defineV1Operation({ operationId: 'askCompanyMemory', method: 'GET', path: '/api/v1/search/memory', scope: 'search.read',
  summary: 'Ask the company memory: client chats, conversations, tasks, meetings, docs and invoices, with citations',
  query: object({ question: qText(300), kinds: { type: 'string', pattern: '^[a-z,]{1,80}$' } }, ['question']),
  response: object({ answer: str, citations: { type: 'array', items: CITATION }, from: maybe, to: maybe, byMeaning: { type: 'boolean' } }),
  mcp: { name: 'ask_company_memory', title: 'Ask the company memory',
    description: 'Searches everything the company wrote down that you may read — imported WhatsApp client groups, Pulse conversations, tasks, ' +
      'meeting transcripts, docs and invoice lines — by words and meaning together (Hindi, Marathi and English). A month in the question ' +
      '("in October") limits the dates. Returns a short answer that lists the matching clients with numbered citations (group, date, link). ' +
      'Quote the citations; never claim more than they say. WhatsApp text comes redacted for AI employees.' },
  handler: async (ctx, { query }) => {
    const kinds = query.kinds ? String(query.kinds).split(',').filter(Boolean) : null;
    const r = await memorySearch(ctx.client, { q: String(query.question), kinds, limit: 8 });
    return {
      answer: answerFrom(String(query.question), r.hits), from: r.from, to: r.to, byMeaning: r.byMeaning,
      citations: r.hits.map((h, i) => ({ n: i + 1, kind: h.kind, title: h.title, where: h.where, client: h.client, project: h.project,
        from: String(h.from), to: String(h.to), link: h.link, speakers: h.speakers ?? [], events: h.events ?? [], text: h.text, redacted: !!h.redacted })),
    };
  },
});

defineV1Operation({ operationId: 'getRiskScores', method: 'GET', path: '/api/v1/search/risks', scope: 'search.read',
  summary: 'Client churn, late-payment and deliverable-delay risk scores you may see, with their reasons',
  query: object({ model: { enum: ['churn', 'late_payment', 'delivery_delay'] }, band: { enum: ['low', 'medium', 'high'] } }, []),
  response: object({ scores: { type: 'array', items: SCORE }, models: { type: 'array', items: CARD } }),
  mcp: { name: 'get_risk_scores', title: 'Risk scores with reasons',
    description: 'Lists the decision-model scores you may see, highest first: churn (a client may leave within 60 days), late_payment ' +
      '(a client\'s next money ask may go unpaid for 7+ days) and delivery_delay (an open task may finish late). Each has a band and up to three ' +
      'reasons in plain words; models carries how each model did on past data it did not learn from (auc 0.5 = chance). Explain the reasons, ' +
      'and treat a score as a reason to check, not a fact.' },
  handler: async (ctx, { query }) => {
    const r = await one<{ scores: Record<string, unknown>[]; models: Record<string, unknown>[] }>(ctx, 'select pulse.memory_risks($1) v',
      [JSON.stringify({ model: query.model ?? null, band: query.band ?? null, limit: 50 })]);
    return {
      scores: (r?.scores ?? []).map((s) => ({ model: String(s.model), subject: String(s.subject), key: String(s.key), label: String(s.label),
        client: (s.client as string | null) ?? null, owner: (s.owner as string | null) ?? null, score: Number(s.score), band: String(s.band),
        reasons: ((s.reasons as { text: string; weight: number }[]) ?? []).map((x) => ({ text: String(x.text), weight: Number(x.weight) })), asOf: String(s.asOf) })),
      models: (r?.models ?? []).map((m) => {
        const e = (m.evaluation ?? {}) as Record<string, unknown>;
        return { model: String(m.model), version: String(m.version), builtAt: String(m.builtAt), method: String(m.method),
          auc: typeof e.auc === 'number' ? e.auc : null, baseRate: typeof e.base_rate === 'number' ? e.base_rate : null,
          testedOn: typeof e.n === 'number' ? e.n : null, split: typeof e.split === 'string' ? e.split : null };
      }),
    };
  },
});
