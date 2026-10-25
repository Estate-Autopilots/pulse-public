import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';

/** Register only inside registerOperatorRoutes' authenticated scope. No staff session is assumed. */
export function registerAgentOperator(app: FastifyInstance, run: <T>(work: (c: PoolClient) => Promise<T>) => Promise<T>) {
  const path = '/api/v1/operator/agent-chat';
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] !== path) return;
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    if (request.url.includes('?')) return reply.code(400).send({ error: 'Query parameters are not supported' });
  });
  app.post<{ Body: { name: string; username: string; chat: string; members: string[] } }>(path, {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name','username','chat','members'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      username: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{2,39}$' },
      chat: { type: 'string', minLength: 2, maxLength: 60 },
      members: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: { type: 'string', minLength: 3, maxLength: 120, pattern: '^[^\\s@]+@[^\\s@]+$' } },
    } } },
  }, request => run(async c => {
    const b = request.body;
    return (await c.query('select pulse.operator_agent_chat($1,$2,$3,$4) result', [b.name,b.username,b.chat,b.members])).rows[0].result;
  }));
}
