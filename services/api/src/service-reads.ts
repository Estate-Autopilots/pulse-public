import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Installation } from './installation.js';
import { readModules } from './modules.js';
import { withServiceKey } from './service-key.js';
import { lookupPhone, phoneAliases, phoneBudgetSpent } from './service-phone.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function pagination(url: string) {
  const query = new URL(url, 'http://service.local').searchParams;
  const invalid = () => { throw Object.assign(new Error('Invalid cursor or limit'), { statusCode: 400 }); };
  for (const key of query.keys()) if (!['cursor', 'limit'].includes(key) || query.getAll(key).length !== 1) invalid();
  const raw = query.get('limit');
  if (raw !== null && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(raw)) invalid();
  const cursor = query.get('cursor');
  let after: string | null = null;
  if (cursor !== null) {
    if (!/^[A-Za-z0-9_-]{48}$/.test(cursor)) invalid();
    after = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!UUID.test(after) || Buffer.from(after).toString('base64url') !== cursor) invalid();
  }
  return { after, limit: raw === null ? 100 : Number(raw) };
}

/** `?phone=` alone (contract 1.1: not combinable with cursor/limit), normalised to E.164; a 10-digit number is +91. */
function phoneQuery(url: string, query: URLSearchParams) {
  const invalid = () => { throw Object.assign(new Error('Invalid phone lookup'), { statusCode: 400 }); };
  if ([...query.keys()].some((k) => k !== 'phone') || query.getAll('phone').length !== 1) invalid();
  // URLSearchParams decodes a literal '+' as space. Decode the raw value instead, preserving both '+' and '%2B'.
  const raw = url.slice(url.indexOf('?') + 1);
  let value: string;
  try { value = decodeURIComponent(raw.slice(raw.indexOf('=') + 1)); } catch { return invalid(); }
  return lookupPhone(value) ?? invalid();
}

// The contract's Cursor/Limit parameters; the raw parser above still refuses duplicates and non-canonical numbers.
const QUERY = { type: 'object', additionalProperties: false, properties: {
  cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
  phone: { type: 'string', maxLength: 40 },
} } as const;

/** The shared guard owns credentials, transaction, host and request budget. */
export function registerServiceReads(app: FastifyInstance, _pool: Pool, installation: Installation) {
  for (const resource of ['clients', 'leads'] as const) {
    app.get(`/api/v1/service/${resource}`, { exposeHeadRoute: false, schema: { querystring: QUERY } }, (request, reply) =>
      withServiceKey(request, reply, `${resource}.read`, async (c, keyId) => {
        const query = new URL(request.url, 'http://service.local').searchParams;
        const phone = query.has('phone') ? phoneQuery(request.url, query) : null;
        const { after, limit } = phone ? { after: null, limit: 5 } : pagination(request.url);
        if (resource === 'leads' && (await readModules(c, (await installation.readOrg())!)).off.includes('acquisition')) {
          throw Object.assign(new Error('Not found'), { statusCode: 404 });
        }
        if (phone) {
          // Contract 1.1 (EST-1294): at most 5 exact matches; 30 lookups a minute per key; audit holds key id + match count.
          if (phoneBudgetSpent(keyId)) { reply.header('retry-after', '60'); throw Object.assign(new Error('Too many phone lookups'), { statusCode: 429 }); }
          if (resource === 'clients') return (await c.query('select pulse.service_clients_by_phone($1,pulse.service_key_hash($1),$2) page', [keyId, phone])).rows[0].page;
          const scopes = (await c.query('select pulse.service_lead_scopes($1,pulse.service_key_hash($1)) s', [keyId])).rows[0].s as { controller: string; path: string }[];
          const aliases = phoneAliases(phone, scopes);
          // Fail explicitly rather than silently dropping configured versions/scopes. Empty aliases still audit zero matches.
          if (aliases.length > 64) throw Object.assign(new Error('Phone lookup unavailable'), { statusCode: 503 });
          return (await c.query('select pulse.service_leads_by_phone($1,pulse.service_key_hash($1),$2::jsonb) page', [keyId, JSON.stringify(aliases)])).rows[0].page;
        }
        return (await c.query(`select pulse.service_${resource}($1,pulse.service_key_hash($1),$2,$3) page`, [keyId, after, limit])).rows[0].page;
      }));
  }
}
