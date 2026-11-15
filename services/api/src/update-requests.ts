import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance } from 'fastify';
import { withServiceKey } from './service-key.js';
import { fail, type Tx } from './routes.js';
import { UUID } from './erp-model.js';

const object = (properties: object, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const uuid = { type: 'string', pattern: UUID.source }, text = { type: 'string', minLength: 1, maxLength: 1000 };
const status = { enum: ['new','planned','started','in_progress','test_site','waiting','live','done'] };
const validator = new Ajv2020({ strict: false });
type Create = { ref: string; askedBy: string; onBehalfOf: string; source: string; text: string; askedAt?: string };
type Progress = { status?: string; progress?: number; note?: string };
export function registerUpdateRequests(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { status?: string; onBehalfOf?: string; cursor?: string; limit?: number } }>('/api/v1/service/update-requests', {
    validatorCompiler: ({ schema }) => new Ajv2020({ strict: false, coerceTypes: true }).compile(schema),
    schema: { querystring: object({ status, onBehalfOf: uuid, cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 } }) },
  }, (req, reply) => withServiceKey(req, reply, 'updates.requests.manage', async (c, key) => {
    const q = req.query;
    return (await c.query('select pulse.service_update_request_list($1,$2,$3,$4,$5) r', [key,q.status??null,q.onBehalfOf??null,q.cursor??null,q.limit??50])).rows[0].r;
  }));
  app.post<{ Body: Create }>('/api/v1/service/update-requests', {
    bodyLimit: 8192, validatorCompiler: ({ schema }) => validator.compile(schema),
    schema: { body: object({ ref: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,120}$' }, askedBy: uuid, onBehalfOf: uuid,
      source: { enum: ['task','chat','manual'] }, text, askedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?(?:Z|[+-]\\d{2}:\\d{2})$' },
    }, ['ref','askedBy','onBehalfOf','source','text']) },
  }, (req, reply) => withServiceKey(req, reply, 'updates.requests.manage', async (c, key) => {
    const b = req.body;
    if (!b.text.trim() || (b.askedAt !== undefined && !Number.isFinite(Date.parse(b.askedAt)))) fail(400, 'Check text and askedAt');
    try {
      const result = (await c.query('select pulse.service_update_request_create($1,$2,$3,$4,$5,$6,$7) r', [key,b.ref,b.askedBy,b.onBehalfOf,b.source,b.text.trim(),b.askedAt??null])).rows[0].r;
      reply.code(result.replayed ? 200 : 201); return result;
    } catch (error) { const code = (error as { code?: string }).code;
      if (code === '42501') fail(422, 'Participants must be active install staff');
      if (code === '22008' || code === '22009') fail(400, 'Check askedAt'); throw error; }
  }));
  app.post<{ Params: { id: string }; Body: Progress }>('/api/v1/service/update-requests/:id/progress', {
    bodyLimit: 8192, validatorCompiler: ({ schema }) => validator.compile(schema),
    schema: { body: { ...object({ status, progress: { type: 'integer', minimum: 0, maximum: 100 }, note: { type: 'string', maxLength: 1000 } }), minProperties: 1 } },
  }, (req, reply) => withServiceKey(req, reply, 'updates.requests.manage', async (c, key) => {
    if (!UUID.test(req.params.id)) fail(404, 'Request unavailable');
    const b = req.body;
    return { request: (await c.query('select pulse.service_update_request_set($1,$2,$3,$4,$5) r', [key,req.params.id,b.status??null,b.progress??null,b.note??null])).rows[0].r };
  }));
  app.post<{ Params: { id: string }; Body: { text: string } }>('/api/v1/updates/:id/reply', {
    bodyLimit: 8192, validatorCompiler: ({ schema }) => validator.compile(schema), schema: { body: object({ text }, ['text']) },
  }, (req, reply) => tx(req, async c => {
    if (!UUID.test(req.params.id)) fail(404, 'Update unavailable');
    if (!req.body.text.trim()) fail(400, 'Enter a request');
    const result = (await c.query('select pulse.update_reply($1,$2) r', [req.params.id,req.body.text.trim()])).rows[0].r;
    reply.code(201); return { request: result };
  }));
  app.get<{ Params: { id: string } }>('/api/v1/updates/:id/requests', req => tx(req, async c => {
    if (!UUID.test(req.params.id)) fail(404, 'Update unavailable');
    const update = (await c.query('select pulse.update_view($1,true) r', [req.params.id])).rows[0].r;
    if (!update) fail(404, 'Update unavailable');
    return { items: (await c.query(`select pulse.update_request_view(r.id) item from pulse.update_request r
      join pulse.update_post u on u.id=$1 and u.on_behalf_id=r.on_behalf_id and u.org_id=r.org_id
      where r.asked_at<u.created_at and not(r.status='done' and r.updated_at<u.created_at-interval '24 hours')
      order by r.asked_at desc,r.id desc limit 50`, [req.params.id])).rows.map(r => r.item) };
  }));
  app.get<{ Params: { id: string } }>('/api/v1/update-requests/:id', req => tx(req, async c => {
    if (!UUID.test(req.params.id)) fail(404, 'Request unavailable');
    const request = (await c.query('select pulse.update_request_view($1) r', [req.params.id])).rows[0].r;
    if (!request) fail(404, 'Request unavailable');
    return { request };
  }));
}
