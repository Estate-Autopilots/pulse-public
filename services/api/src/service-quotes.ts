import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance } from 'fastify';
import { addDays } from '@pulse/invoice-doc';
import { cleanBuyer, cleanDraft, figures, UUID } from './erp-model.js';
import { revealContact } from './acquisition-model.js';
import { withServiceKey } from './service-key.js';

const uuid = { type: 'string', pattern: UUID.source.replaceAll('a-f', 'a-fA-F'), format: 'uuid' };
const validator = new Ajv2020({ strict: false, multipleOfPrecision: 8 });
validator.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
validator.addFormat('date', value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
// QuoteDraftRequest in openapi/service.yaml, exactly.
const bodySchema = { type: 'object', additionalProperties: false, required: ['lines'], oneOf: [{ required: ['clientId'] }, { required: ['leadId'] }], properties: {
  clientId: uuid, leadId: uuid, salespersonId: uuid, notes: { type: 'string', maxLength: 2000 }, validUntil: { type: 'string', format: 'date' },
  sourceRef: { type: 'string', minLength: 1, maxLength: 100 },
  lines: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['itemId','qty'], properties: {
    itemId: uuid, qty: { type: 'number', exclusiveMinimum: 0, maximum: 100000, multipleOf: 0.001 },
    rate: { type: 'integer', minimum: 0, maximum: 1e12 }, details: { type: 'string', maxLength: 1000 },
  } } },
} };
type Payload = { clientId?: string; leadId?: string; salespersonId?: string; notes?: string; validUntil?: string; sourceRef?: string; lines: { itemId: string; qty: number; rate?: number; details?: string }[] };
type Context = { company: Record<string, unknown>; roundTotal: boolean; buyer: Record<string, unknown>; leadContact: Record<string, unknown> | null;
  issueDate: string; items: { id: string; name: string; sac: string | null; unit: string; price: number; gstRate: number }[]; quote?: Record<string, unknown> };
// JSON object ordering and insignificant whitespace cannot change the request identity; arrays retain their order.
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical((value as Record<string, unknown>)[k]))])) : value);

export function registerServiceQuotes(app: FastifyInstance) {
  app.post<{ Body: Payload }>('/api/v1/service/quotes', {
    bodyLimit: 65536, validatorCompiler: ({ schema }) => validator.compile(schema),
    schema: { body: bodySchema, headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': uuid } },
      querystring: { type: 'object', additionalProperties: false, properties: {} } },
  }, (request, reply) => withServiceKey(request, reply, 'quotes.draft.create', async (c, keyId) => {
    // SQL re-checks the key against this transaction's authenticated actor; the credential and its digest stay in withServiceKey.
    const payload = request.body, requestKey = (request.headers['idempotency-key'] as string).toLowerCase();
    // Hash the complete accepted body, including sourceRef when present.
    const requestHash = createHash('sha256').update(canonical(payload)).digest('hex');
    try {
      const context = (await c.query('select pulse.service_quote_context($1,$2) context', [keyId, { ...payload, requestKey, requestHash }])).rows[0].context as Context;
      if (context.quote) { reply.code(200); return context.quote; }
      let buyer = cleanBuyer(context.buyer);
      if (payload.leadId) {
        let name: unknown;
        try { name = revealContact(context.leadContact ?? {}).name; } catch { /* Unavailable identity remains unnamed, like acquisition. */ }
        buyer = cleanBuyer({ name: typeof name === 'string' && name.trim() ? name : 'Lead' });
      }
      // The same cleanDraft → figures (@pulse/invoice-doc) path as a staff saveDraft.
      const fields = cleanDraft({ issueDate: context.issueDate, validUntil: payload.validUntil ?? addDays(context.issueDate, 30), buyer,
        placeOfSupply: buyer.stateCode ?? context.company.stateCode, roundTotal: context.roundTotal,
        lines: payload.lines.map((l, i) => ({ itemId: context.items[i].id, description: context.items[i].name,
          sac: context.items[i].sac, unit: context.items[i].unit, qty: l.qty, rate: l.rate ?? context.items[i].price, gstRate: context.items[i].gstRate })),
      });
      const fig = figures(String(context.company.stateCode), fields);
      const result = (await c.query('select pulse.service_quote_create($1,$2,$3,$4) result',
        [keyId, requestKey, requestHash, { payload, context, fields, figures: fig }])).rows[0].result;
      reply.code(result.existing ? 200 : 201); return result.quote;
    } catch (error) {
      if ((error as { code?: string }).code === 'P0422') throw Object.assign(new Error((error as Error).message), { statusCode: 422 });
      throw error;
    }
  }));
}
