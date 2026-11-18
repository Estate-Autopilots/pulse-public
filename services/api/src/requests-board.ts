// AI-AUTONOMY (owner, 27 Oct 2026): the bug and feature board (BUG-REPORT's reports, 1201, with kinds, votes and a
// discussion: 1233) and the dev agents' queue.
//   GET  /api/v0/board?kind=&status=&sort=     the board: tool requests and ideas for everyone; bugs for the person who
//                                              sent them and leadership. sort=top (votes) or new
//   GET  /api/v0/board/:id                     one item and its discussion
//   POST /api/v0/board/:id/vote {up}           an upvote, or taking it back
//   POST /api/v0/board/:id/comments {body}     a comment
//   POST /api/v0/board/:id/queue {on}          leadership: on or off the dev agents' queue
// Server-side dev agents (Claude on the server) use a service token in x-pulse-dev-token, against the API directly
// (127.0.0.1, never through the web), across every organisation's queued items:
//   GET  /api/v0/dev-queue/items?status=open|all|new|triaged|fixing|fixed|wontfix&limit=50
//   GET  /api/v0/dev-queue/items/:id           the words, screen, scrubbed errors, failed calls and steps, discussion
//   POST /api/v0/dev-queue/items/:id/comments {body}
//   POST /api/v0/dev-queue/items/:id/status {status: fixing|fixed|wontfix|triaged, note?, ref?}   (fixed = shipped; ref
//                                              names what shipped it, e.g. a commit)
// Tokens are issued by the server's operator only (tools/dev-queue-token.sh); the database keeps a hash.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fail, type Open, type Tx, leadership } from './routes.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 10 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemId = (raw: string) => (UUID.test(raw) ? raw : fail(404, 'Not found'));
const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const KINDS = ['all', 'bug', 'tool_needed', 'feature'];
const STATUSES = ['open', 'all', 'new', 'triaged', 'fixing', 'fixed', 'wontfix'];
export const DEV_TOKEN = /^pdq_[0-9a-f]{8}_[0-9a-f]{64}$/;
// A person's credential never travels with a dev token, and a dev token is never a person's.
const PERSON_HEADERS = ['authorization', 'cookie', 'x-pulse-session', 'x-pulse-client-session', 'x-pulse-agent-key', 'cf-access-authenticated-user-email', 'cf-access-jwt-assertion'];

function devToken(req: FastifyRequest) {
  const t = req.headers['x-pulse-dev-token'];
  if (typeof t !== 'string' || !DEV_TOKEN.test(t)) fail(401, 'A dev queue token is required');
  if (PERSON_HEADERS.some((h) => req.headers[h] !== undefined)) fail(401, 'Send the dev queue token alone');
  return t as string;
}

export function registerRequestsBoardRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  app.get('/api/v0/board', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in to see the board');
    const q = req.query as Record<string, string | undefined>;
    const kind = KINDS.includes(q.kind ?? '') ? q.kind! : 'all', status = STATUSES.includes(q.status ?? '') ? q.status! : 'open', sort = q.sort === 'new' ? 'new' : 'top';
    return { kind, status, sort, items: (await c.query('select pulse.board_list($1,$2,$3) b', [kind, status, sort])).rows[0].b };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/board/:id', req => tx(req, async c =>
    (await c.query('select pulse.board_item($1) b', [itemId(req.params.id)])).rows[0].b ?? fail(404, 'Not found')));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/board/:id/vote', { schema: { body } }, req => tx(req, async c => {
    if (typeof req.body.up !== 'boolean') fail(400, 'Vote up or take it back');
    return { votes: (await c.query('select pulse.board_vote($1,$2) n', [itemId(req.params.id), req.body.up])).rows[0].n };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/board/:id/comments', { schema: { body } }, req => tx(req, async c => {
    const text = str(req.body.body, 2001);
    if (!text || text.length > 2000) fail(400, 'Write the comment in up to 2,000 characters');
    return { id: String((await c.query('select pulse.board_comment($1,$2) id', [itemId(req.params.id), text])).rows[0].id) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/board/:id/queue', { schema: { body } }, req => tx(req, async (c, v) => {
    // Refused before the body is read (pulse.board_queue checks again): leadership and admins only.
    if (!leadership(v)) fail(403, 'Leadership decides what the dev agents pick up');
    if (typeof req.body.on !== 'boolean') fail(400, 'Put it on the queue or take it off');
    return { devQueue: (await c.query('select pulse.board_queue($1,$2) q', [itemId(req.params.id), req.body.on])).rows[0].q };
  }));

  // The dev agents' queue (service token).
  app.get('/api/v0/dev-queue/items', async (req, reply) => {
    const token = devToken(req), q = req.query as Record<string, string | undefined>;
    const status = STATUSES.includes(q.status ?? '') ? q.status! : 'open', limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    return reply.header('cache-control', 'no-store').send({ items: await open(async c => (await c.query('select pulse.dev_queue_list($1,$2,$3) l', [token, status, limit])).rows[0].l) });
  });
  app.get<{ Params: { id: string } }>('/api/v0/dev-queue/items/:id', async (req, reply) => {
    const token = devToken(req), id = itemId(req.params.id);
    return reply.header('cache-control', 'no-store').send(await open(async c => (await c.query('select pulse.dev_queue_item($1,$2) i', [token, id])).rows[0].i));
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/dev-queue/items/:id/comments', { schema: { body } }, async req => {
    const token = devToken(req), id = itemId(req.params.id), text = str(req.body.body, 2001);
    if (!text || text.length > 2000) fail(400, 'Write the comment in up to 2,000 characters');
    return { id: String(await open(async c => (await c.query('select pulse.dev_queue_comment($1,$2,$3) id', [token, id, text])).rows[0].id)) };
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/dev-queue/items/:id/status', { schema: { body } }, async req => {
    const token = devToken(req), id = itemId(req.params.id), status = str(req.body.status, 10);
    if (!['triaged', 'fixing', 'fixed', 'wontfix'].includes(status)) fail(400, 'Choose triaged, fixing, fixed or wontfix');
    return open(async c => (await c.query('select pulse.dev_queue_status($1,$2,$3,$4,$5) s', [token, id, status, str(req.body.note, 2000) || null, str(req.body.ref, 200) || null])).rows[0].s);
  });
}
