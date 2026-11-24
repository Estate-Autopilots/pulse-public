import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { Pool } from 'pg';

// Server-owned synthetic directory: no membership, principal or person comes from HTTP.
export type SyntheticMembership = { org: string; person: string; active: boolean };
export type SyntheticPrincipal = {
  id: string; tokenSha256: Buffer; active: boolean; memberships: Map<string, SyntheticMembership>;
};
export const syntheticTaskSchema = {
  type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['organization', 'title', 'status', 'dueAt'], properties: {
      organization: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' },
      dueAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    } },
} as const;
export type SyntheticTask = { organization: string; title: string; status: string; dueAt: string | null };
const denied = () => Object.assign(new Error('Membership denied'), { statusCode: 403 });

/** One org's read for the EST-1016 and EST-2087 harnesses: scratch-DB guard, read-only pulse_api transaction, tenant
 * org/viewer, active staff person in an active org, the four-field select, and stillValid() after every await (403). */
export async function readOrgTasks(pool: Pool, org: string, person: string,
  stillValid: () => boolean): Promise<SyntheticTask[]> {
  const step = async <T>(work: Promise<T>) => { const value = await work; if (!stillValid()) throw denied(); return value; };
  const c = await pool.connect();
  try {
    if (!stillValid()) throw denied();
    await step(c.query('begin read only'));
    const db = (await step(c.query('select current_database() db'))).rows[0].db as string;
    if (!/^pulse_ci(?:_[a-z0-9_]+)?$/.test(db)) throw denied();
    await step(c.query('set local role pulse_api'));
    await step(c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [org, person]));
    const member = await step(c.query(`select p.id from pulse.person p join pulse.org o on o.id=p.org_id
      where p.org_id=$1 and p.id=$2 and p.side='staff' and p.status='active' and o.status='active'
      and (p.active_from is null or p.active_from<=current_date)
      and (p.active_to is null or p.active_to>=current_date)`, [org, person]));
    if (!member.rowCount) throw denied();
    const rows = await step(c.query(`select o.name organization,t.title,t.status,t.due_at "dueAt"
      from pulse.task t join pulse.org o on o.id=t.org_id
      where t.org_id=$1 and coalesce(t.assignee_person_id,t.owner_id)=$2
      order by t.due_at nulls last,t.title,t.id`, [org, person]));
    await step(c.query('commit'));
    return rows.rows.map(r => ({ organization: r.organization, title: r.title,
      status: r.status, dueAt: r.dueAt === null ? null : new Date(r.dueAt).toISOString() }));
  } catch (error) { await c.query('rollback'); throw error; } finally { c.release(); }
}

/** Isolated, non-listening acceptance harness. Never registered by createApp/server.ts.
 * The random credential is provisioned out of band; only its digest belongs in this directory.
 * A scratch-database guard makes even an accidental production pool fail closed.
 */
export function createSyntheticMyTasks(pool: Pool, principal: SyntheticPrincipal) {
  if (!principal.id.startsWith('synthetic:') || principal.tokenSha256.length !== 32) throw denied();
  const app = Fastify({ logger: false, exposeHeadRoutes: false,
    ajv: { customOptions: { removeAdditional: false } } });
  const active = (m: SyntheticMembership) => principal.active && m.active
    && principal.memberships.get(m.org) === m;
  app.get('/synthetic/my-tasks', { schema: {
    querystring: { type: 'object', additionalProperties: false, properties: {} },
    response: { 200: syntheticTaskSchema,
      401: { type: 'object', additionalProperties: false, required: ['error'],
        properties: { error: { type: 'string' } } },
    },
  } }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const bearer = request.headers.authorization;
    if (!principal.active || typeof bearer !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer)
      || !timingSafeEqual(createHash('sha256').update(bearer.slice(7)).digest(), principal.tokenSha256)) {
      return reply.code(401).send({ error: 'Synthetic credential required' });
    }
    const memberships = [...principal.memberships.values()].filter(active)
      .map(membership => ({ membership, org: membership.org, person: membership.person }));
    if (!memberships.length) throw denied();
    const stillActive = ({ membership, org, person }: typeof memberships[number]) => active(membership)
      && membership.org === org && membership.person === person;
    const tasks: SyntheticTask[] = [];
    for (const binding of memberships) {
      // Snapshot immutable identity fields across pool/SQL waits; regrant/remap needs another request.
      tasks.push(...await readOrgTasks(pool, binding.org, binding.person, () => stillActive(binding)));
    }
    // Revocation while another organization's read was pending also discards the whole response.
    if (memberships.some(m => !stillActive(m))) throw denied();
    return tasks;
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: status === 400 ? 'No request selectors allowed' : 'Synthetic read denied' });
  });
  return app;
}
