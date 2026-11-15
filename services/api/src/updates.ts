import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance } from 'fastify';
import { withServiceKey } from './service-key.js';
import { fail, type Tx } from './routes.js';
import { UUID } from './erp-model.js';

const validator = new Ajv2020({ strict: false }); // Reject unknown keys; Fastify's default strips them.
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: object, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const items = (properties: object, required = ['title']) => ({ type: 'array', maxItems: 12, items: object(properties, required) });
const card = { title: text(160), note: text(2000), tag: text(40) };
const uuid = { type: 'string', pattern: UUID.source };
type Payload = { slot: string; headline: string; sections: object; audience: string[]; onBehalfOf: string };
export function registerUpdates(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.post<{ Body: Payload }>('/api/v1/service/updates', {
    bodyLimit: 65536, validatorCompiler: ({ schema }) => validator.compile(schema),
    schema: { body: object({ slot: text(13), headline: text(160), audience: { type: 'array', minItems: 1, maxItems: 50, items: uuid }, onBehalfOf: uuid,
      sections: object({ live: items(card), readyToTry: items(card), ideas: items(card),
        requests: items({ title: text(160), status: text(60), progress: { type: 'integer', minimum: 0, maximum: 100 }, note: text(2000) }, ['title','status','progress']),
        needsYou: items({ text: text(1000) }, ['text']), plan: object({ label: { enum: ['Today','Tomorrow'] }, items: items({ title: text(160), note: text(2000) }) }, ['label','items']),
      }),
    }, ['slot','headline','sections','audience','onBehalfOf']) },
  }, (req, reply) => withServiceKey(req, reply, 'updates.post', async (c, keyId) => {
    const b = req.body, date = b.slot.slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}-(am|pm)$/.test(b.slot) || date.startsWith('0000') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || !b.headline.trim()) fail(400, 'Use a real date slot and a nonempty headline');
    try {
      const result = (await c.query('select pulse.service_update_post($1,$2,$3,$4,$5,$6) r', [keyId,b.slot,b.headline,b.sections,b.audience,b.onBehalfOf])).rows[0].r;
      reply.code(result.replayed ? 200 : 201); return result;
    } catch (error) { if ((error as { code?: string }).code === '42501') fail(422, 'Audience and sender must be active install staff'); throw error; }
  }));
  app.get<{ Querystring: { cursor?: string; limit?: number } }>('/api/v1/updates', {
    validatorCompiler: ({ schema }) => new Ajv2020({ strict: false, coerceTypes: true }).compile(schema),
    schema: { querystring: object({ cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 50 } }) },
  }, req => tx(req, async c => {
    const { cursor, limit = 20 } = req.query;
    const rows = (await c.query(`select id,pulse.update_view(id,false) item from pulse.update_post
      where ($1::uuid is null or (created_at,id)<(select created_at,id from pulse.update_post where id=$1))
      order by created_at desc,id desc limit $2`, [cursor ?? null,limit+1])).rows;
    return { items: rows.slice(0,limit).map(r => r.item), nextCursor: rows.length > limit ? rows[limit-1].id : null };
  }));
  app.post<{ Params: { id: string } }>('/api/v1/updates/:id/open', req => tx(req, async c => {
    if (!UUID.test(req.params.id)) fail(404, 'Update unavailable');
    return (await c.query('select pulse.update_open($1) r', [req.params.id])).rows[0].r;
  }));
}
