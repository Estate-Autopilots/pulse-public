import type { FastifyInstance } from 'fastify';
import { fail, type Tx } from './routes.js';
import { withServiceKey } from './service-key.js';

const schema = { params: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
} }, querystring: { type: 'object', additionalProperties: false, properties: {} } };

export function registerServiceNotice(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.post<{ Params: { id: string } }>('/api/v1/service/quotes/:id/ready-notice', { schema, bodyLimit: 1024 },
    (request, reply) => withServiceKey(request, reply, 'notify.quote_ready', async (c, key, hash) => {
      if (request.body !== undefined) fail(400, 'This operation takes no body');
      return (await c.query('select pulse.service_quote_notify($1,$2,$3) result', [key, hash, request.params.id])).rows[0].result;
    }));
  app.get<{ Params: { id: string } }>('/api/v0/quotes/:id', { schema }, request => tx(request, async c => {
    const quote = (await c.query('select pulse.salesperson_quote($1) quote', [request.params.id])).rows[0].quote;
    if (!quote) fail(404, 'Quotation unavailable');
    await c.query("select pulse.audit_write('salesperson_quote_view','erp_document',$1)", [request.params.id]);
    return quote;
  }));
}
