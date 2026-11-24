import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { addDays } from '@pulse/invoice-doc';
import { cleanBuyer, cleanDraft, figures, UUID } from './erp-model.js';
import { revealContact } from './acquisition-model.js';
import { withServiceKey } from './service-key.js';

const uuid = { type: 'string', pattern: UUID.source.replaceAll('a-f', 'a-fA-F'), format: 'uuid' };
const validator = new Ajv2020({ strict: false, multipleOfPrecision: 8 });
validator.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
validator.addFormat('date', value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
// QuoteDraftRequest in openapi/service.yaml, exactly. WL-PROMISES (msg 155): revisionOf makes the draft the next revision
// of that quotation (the family's latest, same client or lead).
const bodySchema = { type: 'object', additionalProperties: false, required: ['lines'], oneOf: [{ required: ['clientId'] }, { required: ['leadId'] }], properties: {
  clientId: uuid, leadId: uuid, salespersonId: uuid, notes: { type: 'string', maxLength: 2000 }, validUntil: { type: 'string', format: 'date' },
  sourceRef: { type: 'string', minLength: 1, maxLength: 100 }, revisionOf: uuid,
  lines: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['itemId','qty'], properties: {
    itemId: uuid, qty: { type: 'number', exclusiveMinimum: 0, maximum: 100000, multipleOf: 0.001 },
    rate: { type: 'integer', minimum: 0, maximum: 1e12 }, details: { type: 'string', maxLength: 1000 },
  } } },
} };
type Payload = { clientId?: string; leadId?: string; salespersonId?: string; notes?: string; validUntil?: string; sourceRef?: string; revisionOf?: string;
  lines: { itemId: string; qty: number; rate?: number; details?: string }[] };
type Context = { company: Record<string, unknown>; roundTotal: boolean; buyer: Record<string, unknown>; leadContact: Record<string, unknown> | null;
  issueDate: string; validDays?: number; items: { id: string; name: string; sac: string | null; unit: string; price: number; gstRate: number }[]; quote?: Record<string, unknown> };
// JSON object ordering and insignificant whitespace cannot change the request identity; arrays retain their order.
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical((value as Record<string, unknown>)[k]))])) : value);
// P0422 as before; P0409 (a closed or stale revision) keeps its database sentence and answers 409. Others: app.ts.
const status = (error: unknown) => {
  const code = (error as { code?: string }).code;
  if (code === 'P0422') return Object.assign(new Error((error as Error).message), { statusCode: 422 });
  if (code === 'P0409') return Object.assign(error as object, { statusCode: 409 });
  return error;
};
/** The family fields of a quotation (WL-PROMISES): number, revision, revisionGroupId, revisionOf. */
const family = async (c: PoolClient, keyId: string, id: string) =>
  (await c.query('select pulse.service_quote_revision_info($1,pulse.service_key_hash($1),$2) r', [keyId, id])).rows[0].r as Record<string, unknown> | null;
const withFamily = async (c: PoolClient, keyId: string, quote: Record<string, unknown>) => {
  const f = await family(c, keyId, String(quote.id));
  return f ? { ...quote, number: f.number ?? null, revision: f.revision, revisionGroupId: f.revisionGroupId, revisionOf: f.revisionOf ?? null } : quote;
};

export function registerServiceQuotes(app: FastifyInstance) {
  app.post<{ Body: Payload }>('/api/v1/service/quotes', {
    bodyLimit: 65536, validatorCompiler: ({ schema }) => validator.compile(schema),
    schema: { body: bodySchema, headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': uuid } },
      querystring: { type: 'object', additionalProperties: false, properties: {} } },
  }, (request, reply) => withServiceKey(request, reply, 'quotes.draft.create', async (c, keyId) => {
    // SQL re-checks the key against this transaction's authenticated actor; the credential and its digest stay in withServiceKey.
    const requestKey = (request.headers['idempotency-key'] as string).toLowerCase();
    // Hash the complete accepted body, including sourceRef and revisionOf when present.
    const requestHash = createHash('sha256').update(canonical(request.body)).digest('hex');
    try {
      // A quote-lead (POST /api/v1/billing/quote-leads) is a prospect client: its leadId drafts for that client.
      const { revisionOf, ...body } = request.body;
      let payload: Payload = body;
      if (payload.leadId) {
        const client = (await c.query('select pulse.service_quote_lead_client($1,pulse.service_key_hash($1),$2) id', [keyId, payload.leadId])).rows[0].id as string | null;
        if (client) { const { leadId: _lead, ...rest } = payload; payload = { ...rest, clientId: client }; }
      }
      const context = (await c.query('select pulse.service_quote_context($1,$2) context', [keyId, { ...payload, requestKey, requestHash }])).rows[0].context as Context;
      // A replay answers what the first call answered. The family read is live (WL-PROMISES), so the number staff gave the
      // quotation since (on issue) is not taken from it: a replay never reads staff changes or issued state.
      if (context.quote) { reply.code(200); return { ...await withFamily(c, keyId, context.quote), number: context.quote.number ?? null }; }
      let buyer = cleanBuyer(context.buyer);
      if (payload.leadId) {
        let name: unknown;
        try { name = revealContact(context.leadContact ?? {}).name; } catch { /* Unavailable identity remains unnamed, like acquisition. */ }
        buyer = cleanBuyer({ name: typeof name === 'string' && name.trim() ? name : 'Lead' });
      }
      // The same cleanDraft → figures (@pulse/invoice-doc) path as a staff saveDraft.
      const fields = cleanDraft({ issueDate: context.issueDate, validUntil: payload.validUntil ?? addDays(context.issueDate, context.validDays ?? 30), buyer,
        placeOfSupply: buyer.stateCode ?? context.company.stateCode, roundTotal: context.roundTotal,
        lines: payload.lines.map((l, i) => ({ itemId: context.items[i].id, description: context.items[i].name,
          sac: context.items[i].sac, unit: context.items[i].unit, qty: l.qty, rate: l.rate ?? context.items[i].price, gstRate: context.items[i].gstRate })),
      });
      const fig = figures(String(context.company.stateCode), fields);
      const result = (await c.query('select pulse.service_quote_create($1,$2,$3,$4) result',
        [keyId, requestKey, requestHash, { payload, context, fields, figures: fig }])).rows[0].result;
      if (revisionOf && !result.existing) {
        await c.query('select pulse.service_quote_revision_link($1,pulse.service_key_hash($1),$2,$3)', [keyId, result.quote.id, revisionOf]);
      }
      reply.code(result.existing ? 200 : 201); return await withFamily(c, keyId, result.quote);
    } catch (error) { throw status(error); }
  }));

  // WL-PROMISES (msg 155): a draft this key made is cancelled with a reason; it stays readable and is never deleted.
  app.post<{ Params: { id: string }; Body: { reason: string } }>('/api/v1/service/quotes/:id/cancel', {
    bodyLimit: 4096, validatorCompiler: ({ schema }) => validator.compile(schema),
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } },
      body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
      querystring: { type: 'object', additionalProperties: false, properties: {} } },
  }, (request, reply) => withServiceKey(request, reply, 'quotes.draft.create', async (c, keyId) => {
    try {
      return (await c.query('select pulse.service_quote_cancel($1,pulse.service_key_hash($1),$2,$3) r', [keyId, request.params.id.toLowerCase(), request.body.reason])).rows[0].r;
    } catch (error) { throw status(error); }
  }));
}
