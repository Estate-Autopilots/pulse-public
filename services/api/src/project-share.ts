import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { fail, work, type Open, type Tx, type Viewer } from './routes.js';

/** KAZUK (28 Oct 2026): Kazuk's screen 3 and the client timeline link (migration 1388).
 *  - The doer of a task given in a chat answers "When will you start and finish?" (Start today, Pick dates, Can't by
 *    then); a task finished late asks its doer for one reason.
 *  - A project's client timeline: a signed, revocable link to a read-only page (stages and planned steps with dates and
 *    state; no people, notes, money or chats). Pulse never sends it; the lead copies it into the client group. */
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Work');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const uid = (x: unknown) => typeof x === 'string' && UUID.test(x) ? x : fail(400, 'Choose a valid record');
const day = (x: unknown) => x === null || x === undefined || x === '' ? null : typeof x === 'string' && DAY.test(x) ? x : fail(400, 'Enter the date as a date');
const hashOf = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null;

export function registerProjectShareRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/tasks/:id/commit', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const b = req.body ?? {};
    return (await c.query('select pulse.task_commit_set($1,$2,$3,$4,$5) r', [uid(req.params.id), day(b.start), day(b.finish), b.cant === true, b.note === undefined || b.note === null ? null : String(b.note).slice(0, 400)])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/tasks/:id/late-reason', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const b = req.body ?? {};
    return (await c.query('select pulse.task_late_reason_set($1,$2,$3) r', [uid(req.params.id), String(b.reason ?? '').slice(0, 20), b.note === undefined || b.note === null ? null : String(b.note).slice(0, 400)])).rows[0].r;
  }));
  // The client timeline link: its state (for the lead), a new one (the token is shown once), or revoke.
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/share', req => tx(req, async (c, v) => {
    work(v); person(v); return (await c.query('select pulse.project_share_state($1) r', [uid(req.params.id)])).rows[0].r ?? { active: false, createdAt: null, canShare: false };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/share', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = uid(req.params.id);
    if (!(await c.query('select 1 from pulse.project where id=$1 and deleted_at is null', [id])).rows[0]) fail(404, 'Project not found');
    if (req.body?.revoke === true) { await c.query('select pulse.project_share_set($1,null)', [id]); return { active: false }; }
    const token = randomBytes(32).toString('base64url');
    await c.query('select pulse.project_share_set($1,$2)', [id, hashOf(token)]);
    return { active: true, path: `/accept/timeline/${token}` };
  }));
  // Signed out: what the client sees through the link.
  app.get<{ Params: { token: string } }>('/api/v0/share/project/:token', async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, 'This link is not valid');
    const r = await open(async (c) => (await c.query('select pulse.project_share_open($1) r', [h])).rows[0].r);
    return r ?? fail(404, 'This link is not valid or has been replaced');
  });
}
