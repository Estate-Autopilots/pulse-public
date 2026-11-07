// UI-UPGRADE (owner, 24 Oct 2026): an AI employee's run history a page at a time (what was asked, where, why a run
// stopped, which engine ran) and "Retry" for a failed run. Both are decided in the database (0990): the page follows
// agent_profile's rule (404 for anyone it is hidden from), a retry agent_manage_ok's.
import type { FastifyInstance } from 'fastify';
import { fail, type Tx } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown, what: string) => UUID.test(String(x)) ? String(x) : fail(400, `Choose a valid ${what}`);
const RETRY: Record<string, string> = { not_failed: 'Only a run that failed can be tried again', pending: 'It is already waiting to run this again' };

export function registerAgentHistoryRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>('/api/v0/agents/:id/runs', req => tx(req, async c => {
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before).toISOString() : null;
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit ?? '20', 10) || 20));
    const runs = (await c.query('select pulse.agent_runs_page($1, $2, $3) r', [id(req.params.id, 'AI employee'), before, limit])).rows[0].r;
    if (runs === null) fail(404, 'Not found');
    return { runs, more: runs.length === limit };
  }));
  app.post<{ Params: { id: string; run: string } }>('/api/v0/agents/:id/runs/:run/retry', req => tx(req, async c => {
    const state = (await c.query('select pulse.agent_run_retry($1, $2) s', [id(req.params.id, 'AI employee'), id(req.params.run, 'run')])).rows[0].s as string;
    if (state !== 'queued') fail(409, RETRY[state] ?? 'Not tried again');
    return { state };
  }));
}
