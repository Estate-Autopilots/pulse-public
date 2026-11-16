import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { authMail } from './auth-mail.js';
import { fail, sessionHash, type Tx, type Open } from './routes.js';
import { registerGoogleSignInFlow, type GoogleConfiguration, type GoogleNotice } from './google-sign-in-flow.js';
import { googleConfigured } from './google-client.js';
export { googleConfigured } from './google-client.js';

const properties = {
 enabled: { type: 'boolean', default: false },
 allowedDomains: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', maxLength: 253, pattern: '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$' } },
 trustGoogle2Step: { type: 'boolean', default: false },
 passwordSignIn: { type: 'string', enum: ['on', 'off_for_linked'], default: 'on' },
} as const;
const settings = { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } as const;
const response = { ...settings, required: [...settings.required, 'configured'], properties: { ...properties, configured: { type: 'boolean' } } } as const;
const validator = new Ajv2020({ coerceTypes: false, removeAdditional: false, useDefaults: false });
const strict = { validatorCompiler: ({ schema }: { schema: unknown }) => validator.compile(schema as object), onRequest: async (_req: FastifyRequest, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store'); } };
// EST-1397's openid-client verifier produces this nominal type after signature/audience/nonce/time checks.
// There is deliberately no HTTP handler or JSON-to-proof constructor here.
declare const verifiedGoogle: unique symbol;
export type VerifiedGoogleClaims = Readonly<{ iss: string; sub: string; email: string; email_verified: true; hd: string; auth_time: number; [verifiedGoogle]: true }>;
export const readGooglePolicy = async (c: PoolClient) => (await c.query('select pulse.google_policy() d')).rows[0].d;
export const resolveVerifiedGoogle = async (c: PoolClient, proof: VerifiedGoogleClaims, used = false) => (await c.query('select pulse.google_identity_resolve($1,$2,$3) d', [proof.iss, proof.sub, used])).rows[0].d;
const attempt = async (c: PoolClient, op: string, b: object) => (await c.query('select pulse.google_link_attempt($1,$2) d', [op, JSON.stringify(b)])).rows[0].d;
export async function beginGoogleLink(c: PoolClient, session: string, cookie: string, nonce: string, verifier: string) {
 if (!googleConfigured()) return { error: 'provider_error' };
 const state = randomBytes(32).toString('base64url');
 const result = await attempt(c, 'begin', { stateHash: sessionHash(state), cookieHash: sessionHash(cookie), sessionHash: sessionHash(session), nonce, verifier });
 return result.error ? result : { state };
}
export const readGoogleLink = (c: PoolClient, state: string, cookie: string) => attempt(c, 'read', { stateHash: sessionHash(state), cookieHash: sessionHash(cookie) });
// Return failures, do not throw inside the transaction: a failed finish must commit its consumed attempt.
export const linkVerifiedGoogle = (c: PoolClient, state: string, cookie: string, proof: VerifiedGoogleClaims) => attempt(c, 'finish', { stateHash: sessionHash(state), cookieHash: sessionHash(cookie), proof });
export function registerGoogleSignIn(app: FastifyInstance, tx: Tx, open: Open, notice: GoogleNotice, configure?: GoogleConfiguration) {
 registerGoogleSignInFlow(app, tx, open, notice, configure);
 const path = '/api/v0/admin/sign-in/google';
 app.get(path, { ...strict, schema: { querystring: { type: 'object', additionalProperties: false }, response: { 200: response } } }, req => tx(req, async c => {
  const { notices: _notices, ...result } = (await c.query('select pulse.google_settings() d')).rows[0].d;
  return { ...result, configured: googleConfigured() };
 }));
 app.put(path, { ...strict, schema: { body: settings, querystring: { type: 'object', additionalProperties: false }, response: { 200: response } } }, async req => {
  if (!await open(async c => (await c.query('select pulse.auth_allow($1,10) ok', [sessionHash('google-policy:' + String(req.headers['x-pulse-client-ip'] ?? req.ip))])).rows[0].ok)) fail(429, 'Too many attempts. Try again in 15 minutes.');
  if ((req.body as { enabled: boolean }).enabled && !googleConfigured()) fail(409, 'Google sign-in is not configured');
  const { notices, ...result } = await tx(req, async c => (await c.query('select pulse.google_settings($1,$2) d', [JSON.stringify(req.body), String(req.headers['x-pulse-two-step'] ?? '')])).rows[0].d);
  for (const notice of notices) void authMail(notice.delivery, 'Pulse Google two-step policy changed', 'An admin changed Trust Google 2-step. Review Settings → Sign-in. Only switch this on if 2-step verification is enforced for every user of these domains in Google Workspace.').then(ok => tx(req, c => c.query("select pulse.auth_mail_event('staff',$1,$2)", [notice.actor, ok]))).catch(() => {});
  return { ...result, configured: googleConfigured() };
 });
 app.post('/api/v0/auth/google/unlink', { ...strict, schema: { body: { type: 'object', additionalProperties: false }, querystring: { type: 'object', additionalProperties: false } } }, req => tx(req, async (c, v) => {
  if (v.nativeDevice || v.via !== 'password') fail(403, 'Use your browser account session');
  return (await c.query('select pulse.google_unlink() d')).rows[0].d;
 }));
}
