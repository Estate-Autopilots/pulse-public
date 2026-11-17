import type { FastifyInstance } from 'fastify';
import { fail, type Open } from './routes.js';
import { agentTxFor } from './agents.js';

// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.3): the company's own AI checks Review data's suggestions before a person
// does (migration 2044). It runs on the company's own server as one of its AI co-workers, with that co-worker's key
// (the /api/v0/agent/* path): tools/review-ai/score.mjs asks for the next unchecked suggestions, has the server's Claude
// give each a confidence and one plain reason, and sends them back. Scores decide nothing; people accept.
//   GET  /api/v0/agent/review-data/queue?limit=25   → { items: [{ id, kind, title, proposed, sourceConfidence, evidence }] }
//   POST /api/v0/agent/review-data/scores           { scores: [{ id, confidence, reason }] } → { scored }
export function registerReviewAi(app: FastifyInstance, { open }: { open: Open }) {
  const agentTx = agentTxFor(open);
  app.get<{ Querystring: { limit?: string } }>('/api/v0/agent/review-data/queue', (req) => agentTx(req, async (c) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
    return { items: (await c.query('select pulse.review_ai_queue($1) q', [limit])).rows[0].q };
  }));
  app.post<{ Body: { scores?: unknown } }>('/api/v0/agent/review-data/scores', { schema: { body: { type: 'object' } } }, (req) => agentTx(req, async (c) => {
    const scores = Array.isArray(req.body?.scores) && req.body.scores.length <= 50 ? req.body.scores : fail(400, 'Send up to 50 scores');
    const clean = scores.map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const id = typeof x.id === 'string' && /^[0-9a-f-]{36}$/i.test(x.id) ? x.id : fail(400, 'Each score needs a suggestion id');
      const confidence = Number(x.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail(400, 'A confidence is 0 to 1');
      const reason = typeof x.reason === 'string' ? x.reason.trim().slice(0, 300) : '';
      if (!reason) fail(400, 'Each score needs a reason');
      return { id, confidence, reason };
    });
    return { scored: (await c.query('select pulse.review_ai_score($1::jsonb) n', [JSON.stringify(clean)])).rows[0].n };
  }));
}
