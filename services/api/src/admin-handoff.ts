import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fail, sessionHash, type Open, type Tx } from './routes.js';
import { deviceLabel } from './auth-policy.js';

// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.4: "if I have to log in again, that's a very hectic job ... you should be
// directly on the admin console, with no problem message"). A platform admin signed in to Pulse, in any company, opens
// the admin console (apps/admin, its own address) already signed in: Pulse makes a one-time hand-off, the admin site
// redeems it for its own session (migration 2042). The token goes in the address's #fragment, so no server log sees it.
//   POST /api/v0/auth/admin-handoff         (signed in; platform admins only)  → { token }
//   POST /api/v0/auth/admin-handoff/redeem  (public; the admin site)           { token } → { token: <session> }
export const NOT_PLATFORM = 'Only Pulse’s platform admins use the admin console.';
export const HANDOFF_GONE = 'That link to the admin console was used or is more than two minutes old. Open the admin console from Pulse again.';
const handoffHash = (token: string) => sessionHash('admin-handoff:' + token);
const ip = (req: FastifyRequest) => String(req.headers['x-pulse-client-ip'] ?? req.ip);

export function registerAdminHandoff(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  app.post('/api/v0/auth/admin-handoff', (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice || v.mustChange) fail(403, NOT_PLATFORM);
    const token = randomBytes(32).toString('base64url');
    const r = (await c.query('select pulse.admin_handoff_create($1) r', [handoffHash(token)])).rows[0]?.r;
    if (!r) fail(403, NOT_PLATFORM);
    return { token };
  }));
  app.post<{ Body: { token?: string } }>('/api/v0/auth/admin-handoff/redeem', { schema: { body: { type: 'object', additionalProperties: false, properties: { token: { type: 'string', maxLength: 64 } } } } }, async (req) => {
    const token = String(req.body?.token ?? '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(400, HANDOFF_GONE);
    const allowed = await open(async (c) => (await c.query('select pulse.auth_allow($1,20) a', [sessionHash('admin-handoff-ip:' + ip(req))])).rows[0].a);
    if (!allowed) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const session = randomBytes(32).toString('base64url');
    const device = deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? '')) || 'Admin console';
    const r = await open(async (c) => (await c.query('select pulse.admin_handoff_redeem($1,$2,$3) r', [handoffHash(token), sessionHash(session), `Admin console · ${device}`])).rows[0]?.r);
    if (!r) fail(400, HANDOFF_GONE);
    return { token: session };
  });
}
