import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { Installation } from './installation.js';
import { admin, fail, type Tx, type Viewer } from './routes.js';
import { V1_SCOPES } from './service-key.js';

const PATH = '/api/v0/integrations/keys';
// Match 0700's admin allowlist; new operator grants must not become selectable here.
const SCOPES = ['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready','chats.post', ...V1_SCOPES];
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
type Key = { id: string };
type Input = { name: string; scopes: string[]; days: number; agentId?: string | null };
const allowed = async (req: FastifyRequest, v: Viewer, installation: Installation) => {
  if (req.headers.authorization !== undefined || req.headers['x-pulse-agent-key'] !== undefined || !admin(v) || !v.person)
    fail(403, 'Company admins manage integration keys');
  if (v.org !== await installation.readOrg()) fail(403, 'Integration keys are not available for this company yet');
  if (req.url.includes('?')) fail(400, 'Query parameters are not supported');
};

/** Uses the existing staff transaction; the web proxy enforces same-origin CSRF before forwarding mutations. */
export function registerIntegrationKeys(app: FastifyInstance, { tx }: { tx: Tx }, installation: Installation) {
  const list = async (c: PoolClient) =>
    (await c.query('select pulse.integration_key_list() keys')).rows[0].keys as Key[];
  app.get(PATH, { exposeHeadRoute: false }, req => tx(req, async (c, v) => {
    await allowed(req, v, installation); return { keys: await list(c), scopes: SCOPES };
  }));
  app.post<{ Body: Input }>(PATH, { schema: { body: { type: 'object' } } }, async (req, reply) => {
    const result = await tx(req, async (c, v) => {
      await allowed(req, v, installation);
      const b = req.body;
      if (Object.keys(b).some(k => !['name','scopes','days','agentId'].includes(k)) || typeof b.name !== 'string'
        || !b.name.trim() || b.name.trim().length > 60 || !Number.isInteger(b.days) || b.days < 1 || b.days > 365
        || !Array.isArray(b.scopes) || !b.scopes.length || new Set(b.scopes).size !== b.scopes.length
        || b.scopes.some(s => !SCOPES.includes(s)) || (b.agentId != null && !new RegExp(UUID).test(b.agentId)))
        fail(400, 'Choose a name, explicit scopes and an expiry from 1 to 365 days');
      const secret = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(secret).digest('hex');
      const id = (await c.query('select pulse.integration_key_issue($1,$2,$3,$4,$5) id',
        [b.name.trim(), b.scopes, b.days, b.agentId ?? null, hash])).rows[0].id as string;
      return { key: (await list(c)).find(k => k.id === id)!, token: `psvc_${id}_${secret}` };
    });
    return reply.header('cache-control', 'no-store').code(201).send(result);
  });
  app.post<{ Params: { id: string } }>(PATH + '/:id/revoke', { schema: {
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
  } }, req => tx(req, async (c, v) => {
    await allowed(req, v, installation);
    if (req.body !== undefined && (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) fail(400, 'No fields are accepted for revocation');
    await c.query('select pulse.integration_key_revoke($1)', [req.params.id]); return { ok: true };
  }));
}
