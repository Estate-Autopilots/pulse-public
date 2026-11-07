import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fail, sessionHash, type Open, type Tx } from './routes.js';
import { deviceLabel } from './auth-policy.js';
import { companyOrigin } from './tenant-context.js';

// MOBILE-READY (owner, 27 Oct 2026): "Sign in this device" (migration 1260). An admin makes a one-time code in Settings →
// Devices → Add a test device: a 6-digit code and a QR link (/login/device#<token>, the token never reaches a server
// log). The phone types the code, or opens the QR link (App Links open it in the Pulse app), and signs in as that admin
// within 10 minutes, once. Typed codes are limited per address and per company, so 6 digits cannot be guessed in time.
//   POST /api/v0/auth/device-code            (admin)  → { id, code, url, expiresAt }
//   GET  /api/v0/auth/device-code            (admin)  → the live code's { id, expiresAt } or null (never the code)
//   POST /api/v0/auth/device-code/:id/cancel (admin)
//   POST /api/v0/auth/device-sign-in         (public) { code | token, otp? } → a session, or { twoStep }
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const signInBody = { type: 'object', additionalProperties: false, properties: {
  code: { type: 'string', maxLength: 12 }, token: { type: 'string', maxLength: 64 }, otp: { type: 'string', maxLength: 40 } } } as const;
const UNAVAILABLE = 'That code didn’t work: it was used, it expired (codes last 10 minutes), or it was cancelled. Make a new one on the signed-in device.';
const codeHash = (code: string) => sessionHash('device-code:' + code);
const tokenHash = (token: string) => sessionHash('device-token:' + token);
const ip = (req: FastifyRequest) => String(req.headers['x-pulse-client-ip'] ?? req.ip);
const device = (req: FastifyRequest) => deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));

export function registerDeviceSignIn(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  app.post('/api/v0/auth/device-code', async (req) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0'), token = randomBytes(32).toString('base64url');
      const r = await tx(req, async (c) => (await c.query('select pulse.device_code_create($1,$2,$3) d', [codeHash(code), tokenHash(token), device(req)])).rows[0].d);
      if (r.error) fail(400, r.error);
      if (r.retry) continue;
      return { id: r.id, code, url: new URL('/login/device#' + token, companyOrigin()).href, expiresAt: r.expiresAt,
        warning: 'Anyone with this code can sign in as you for the next 10 minutes. Use it only on a phone you hold.' };
    }
    fail(503, 'Pulse could not make a code just now. Try again.');
  });
  app.get('/api/v0/auth/device-code', (req) => tx(req, async (c) => {
    if (!(await c.query("select pulse.viewer_is('admin') ok")).rows[0].ok) fail(403, 'Admin required');
    return (await c.query('select pulse.device_code_live() d')).rows[0].d;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/auth/device-code/:id/cancel', { schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID } } } } },
    (req) => tx(req, async (c) => (await c.query('select pulse.device_code_cancel($1) d', [req.params.id])).rows[0].d));
  app.post<{ Body: { code?: string; token?: string; otp?: string } }>('/api/v0/auth/device-sign-in', { schema: { body: signInBody } }, async (req) => {
    const code = String(req.body.code ?? '').replace(/\D/g, ''), token = String(req.body.token ?? '');
    if (!/^\d{6}$/.test(code) && !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(400, 'Type the 6-digit code shown on the signed-in device.');
    // 10 tries per address and 60 per company in 15 minutes: a 6-digit code cannot be guessed within its 10 minutes.
    const allowed = await open(async (c) => (await c.query('select pulse.auth_allow($1,10) a, pulse.auth_allow($2,60) b',
      [sessionHash('device-code-ip:' + ip(req)), sessionHash('device-code-org')])).rows[0]);
    if (!allowed.a || !allowed.b) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const session = randomBytes(32).toString('base64url');
    const r = await open(async (c) => (await c.query('select pulse.device_code_sign_in($1,$2,$3,$4,$5) d',
      [code ? codeHash(code) : null, token ? tokenHash(token) : null, String(req.body.otp ?? ''), sessionHash(session), device(req)])).rows[0].d);
    if (!r) fail(400, UNAVAILABLE);
    if (r.twoStep) return { twoStep: true, failed: r.failed === true };
    return { ...r, token: session };
  });
}
