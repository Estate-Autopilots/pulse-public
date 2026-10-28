import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';

const id = (x: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x) ? x : fail(400, 'Choose a valid record');
/** Shared by screen routes and the v1 operations; all visibility and write rules remain in the database. */
export async function chain(c: PoolClient, taskId: string) {
  return (await c.query('select pulse.task_chain($1) r', [id(taskId)])).rows[0].r;
}
export async function blockedOn(c: PoolClient, personId: string) {
  return (await c.query('select pulse.task_blocked_on($1) r', [id(personId)])).rows[0].r;
}
export async function link(c: PoolClient, taskId: string, blockerId: string, note: string | null = null) {
  return { linkId: (await c.query('select pulse.task_block($1,$2,$3) id', [id(taskId), id(blockerId), note])).rows[0].id, blockerId };
}
export async function unlink(c: PoolClient, taskId: string, blockerId: string | null = null) {
  return { cleared: (await c.query('select pulse.task_unblock($1,$2) n', [id(taskId), blockerId === null ? null : id(blockerId)])).rows[0].n };
}
export function registerWaitingRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/waiting', async req => {
    try { return await tx(req, c => chain(c, req.params.id)); }
    catch (e) { if ((e as { statusCode?: number }).statusCode === 403) fail(404, 'Task not found'); throw e; }
  });
  app.get('/api/v0/me/blocked-on', req => tx(req, (c, v) => blockedOn(c, v.person ?? fail(403, 'Sign in as a team member'))));
  app.get<{ Params: { id: string } }>('/api/v0/agents/:id/blocked-on', req => tx(req, c => blockedOn(c, req.params.id)));
}
