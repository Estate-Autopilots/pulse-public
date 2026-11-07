import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { withServiceKey } from './service-key.js';
import { pagination } from './service-reads.js';
/** EST-1879's Google ID-token check (JWKS, iss, aud, exp + 60 s, email_verified, allowed hd): the verified (iss, sub) or null. */
export type PersonTokenVerifier = (token: string, c: PoolClient) => Promise<{ iss: string; sub: string } | null>;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const refuse = (statusCode: number, error: string) => Object.assign(new Error(error), { statusCode });
const QUERY = { type: 'object', additionalProperties: false, properties: {
  cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
} } as const;
// Validate before returning: unexpected fields fail closed, including nested directory/team properties.
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const string = { type: 'string' }, nullable = { type: ['string', 'null'] }, boolean = { type: 'boolean' };
const array = (items: unknown) => ({ type: 'array', items, maxItems: 200 });
const ajv = new Ajv2020();
const taskResponse = ajv.compile(object({ personId: string, generatedAt: string, items: array(object({ id: string, title: string,
  status: { enum: ['open','in_progress','blocked','in_review'] }, dueAt: nullable,
  bucket: { enum: ['overdue','due_today','upcoming','no_due_date'] }, dueSoon: boolean, link: string })) }));
const peopleResponse = ajv.compile(object({ items: array(object({ id: string, name: string, workEmail: nullable,
  roles: { type: 'array', items: { enum: ['admin','hr','leadership','finance','manager','pgs','head_pgs'] } },
  teams: { type: 'array', items: object({ id: string, name: string }) }, active: boolean, link: string })), nextCursor: nullable }));
const checked = (validate: typeof taskResponse, value: unknown) => { if (!validate(value)) throw refuse(500, 'Invalid service response'); return value; };
/** EST-1406 / EST-1392 1.0.2 §6. The definer reads (0685) re-check key, scope and person; callers never name a person or company. */
export function registerServiceTasksPeople(app: FastifyInstance, verify: PersonTokenVerifier) {
  app.get('/api/v1/service/tasks/mine', { exposeHeadRoute: false }, (request, reply) =>
    withServiceKey(request, reply, 'tasks.read', async (c, keyId) => {
      const token = request.headers['pulse-person-token'];
      const who = typeof token === 'string' && token.length <= 8192 && JWT.test(token) ? await verify(token, c).catch(() => null) : null;
      if (!who) { request.log.warn({ code: 'person_token_invalid' }); throw refuse(401, 'person_token_invalid'); }
      const mine = (await c.query('select pulse.service_my_tasks($1,pulse.service_key_hash($1),$2,$3) r', [keyId, who.iss, who.sub])).rows[0].r;
      if (mine.error) throw refuse(403, 'person_not_linked');
      return checked(taskResponse, mine);
    }));
  app.get('/api/v1/service/people', { exposeHeadRoute: false, schema: { querystring: QUERY } }, (request, reply) =>
    withServiceKey(request, reply, 'people.read', async (c, keyId) => {
      const { after, limit } = pagination(request.url);
      return checked(peopleResponse, (await c.query('select pulse.service_people($1,pulse.service_key_hash($1),$2,$3) page', [keyId, after, limit])).rows[0].page);
    }));
}
