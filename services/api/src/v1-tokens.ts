// AGENT-API (owner, 4 Nov 2026): personal access tokens (ppt_) and organisation bot keys (pbk_) for API v1, MCP and the
// CLI, made, rotated and revoked in Settings → API keys (migration 1510). A personal token acts as its person; a bot key
// acts as one AI member (Willow Lane's Bhrata) with that member's roles, in this organisation only. The secret is shown
// once; only its SHA-256 is stored. Registered as API v1's one personal-token resolver (EST-1617's extension point).
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { fail, type Tx } from './routes.js';
import { OAUTH_SCOPES } from './oauth.js';
import { registerPersonalResolver } from './v1.js';
import { V1_SCOPES } from './service-key.js';

export const TOKEN = /^(ppt|pbk)_[A-Za-z0-9_-]{43}$/;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

registerPersonalResolver({
  pattern: TOKEN,
  kind: token => token.startsWith('pbk_') ? 'ai' : 'person',
  resolve: async (c, token, scope) => (await c.query('select pulse.v1_token_principal($1,$2) v', [tokenHash(token), scope])).rows[0]?.v ?? null,
  live: async (c, token) => (await c.query('select pulse.v1_token_live($1) v', [tokenHash(token)])).rows[0]?.v === true,
});

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 10 } as const;
const mint = (kind: 'personal' | 'bot') => `${kind === 'bot' ? 'pbk' : 'ppt'}_${randomBytes(32).toString('base64url')}`;
/** What each area lets a token do, in the consent screen's words (areas without a sentence are named plainly). */
export const TOKEN_SCOPES = V1_SCOPES.map(key => ({ key, label: OAUTH_SCOPES[key] ?? key }));

export function registerApiTokenRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const staff = (v: { person: string | null; side?: string; nativeDevice?: string }) => {
    if (!v.person || v.nativeDevice || (v.side && v.side !== 'staff')) fail(403, 'Staff make API keys in the browser');
  };
  const listOf = async (c: Parameters<Parameters<Tx>[1]>[0]) => (await c.query('select pulse.api_token_list() v')).rows[0].v;
  app.get('/api/v0/api-tokens', req => tx(req, async (c, v) => {
    staff(v);
    const admin = (await c.query("select pulse.viewer_is('admin') v")).rows[0].v === true;
    const agents = admin ? (await c.query(`select p.id,p.display_name name,a.title from pulse.agent_member a join pulse.person p on p.id=a.person_id
      where a.disabled_at is null and p.status='active' and p.side='agent' order by p.display_name`)).rows : [];
    // API-PLATFORM (1564): the company's API tier; Settings shows the areas outside it greyed out.
    const plan = (await c.query('select pulse.api_plan() v')).rows[0].v;
    return { tokens: await listOf(c), scopes: TOKEN_SCOPES, admin, agents, plan };
  }));
  app.post<{ Body: Body }>('/api/v0/api-tokens', { schema: { body } }, async (req, reply) => {
    const result = await tx(req, async (c, v) => {
      staff(v);
      const b = req.body ?? {}, kind = b.kind === 'bot' ? 'bot' : 'personal';
      if (Object.keys(b).some(k => !['kind', 'name', 'scopes', 'days', 'agentId'].includes(k)) || typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 60
        || !Number.isInteger(b.days) || (b.days as number) < 1 || (b.days as number) > 365 || !Array.isArray(b.scopes) || !b.scopes.length
        || b.scopes.some(s => !(V1_SCOPES as readonly unknown[]).includes(s)) || (kind === 'bot' && !(typeof b.agentId === 'string' && UUID.test(b.agentId))))
        fail(400, 'Choose a name, the areas it may use and an expiry from 1 to 365 days');
      const token = mint(kind);
      const id = (await c.query('select pulse.api_token_issue($1,$2,$3,$4,$5,$6) v', [kind, String(b.name).trim(), [...new Set(b.scopes as string[])], b.days, kind === 'bot' ? b.agentId : null, tokenHash(token)])).rows[0].v as string;
      return { id, token, tokens: await listOf(c) };
    });
    return reply.header('cache-control', 'no-store').code(201).send(result);
  });
  app.post<{ Params: { id: string } }>('/api/v0/api-tokens/:id/rotate', async (req, reply) => {
    if (!UUID.test(req.params.id)) fail(400, 'Choose a token');
    const result = await tx(req, async (c, v) => {
      staff(v);
      // A personal token is rotated by its own person only (an admin revokes a member's); bot keys by admins (1510).
      const t = (await listOf(c) as { id: string; kind: string; canRotate?: boolean }[]).find(x => x.id === req.params.id && x.canRotate) ?? fail(404, 'No such token of yours');
      const token = mint(t.kind === 'bot' ? 'bot' : 'personal');
      const id = (await c.query('select pulse.api_token_rotate($1,$2) v', [req.params.id, tokenHash(token)])).rows[0].v as string;
      return { id, token, tokens: await listOf(c) };
    });
    return reply.header('cache-control', 'no-store').send(result);
  });
  app.post<{ Params: { id: string } }>('/api/v0/api-tokens/:id/revoke', req => tx(req, async (c, v) => {
    staff(v);
    if (!UUID.test(req.params.id)) fail(400, 'Choose a token');
    await c.query('select pulse.api_token_revoke($1)', [req.params.id]);
    return { ok: true, tokens: await listOf(c) };
  }));
}
