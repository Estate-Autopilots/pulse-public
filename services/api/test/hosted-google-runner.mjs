import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import * as oidc from 'openid-client';
import { createApp } from '../dist/app.js';
import { googleClient } from '../dist/google-client.js';

const folder = process.env.PULSE_CONNECTOR_SECRETS_DIR + '/' + process.env.TEST_HOSTED_ORG;
mkdirSync(folder, { mode: 0o700 });
writeFileSync(folder + '/google-sign-in.json', JSON.stringify({ client_id: 'hosted-client', client_secret: 'synthetic-hosted-secret' }), { mode: 0o600 });
Object.assign(process.env, { PULSE_GOOGLE_CLIENT_ID: 'install-client', PULSE_PUBLIC_URL: 'https://install.example.test', PULSE_GOOGLE_CLIENT_SECRET_FILE: folder + '/install-secret' });
writeFileSync(folder + '/install-secret', 'synthetic-install-secret');
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), routes = [];
const app = createApp(pool, pool, r => { if (String(r.url).includes('google')) routes.push([r.method, r.url].join(' ')); }, undefined, async () => {
 const c = googleClient();
 return new oidc.Configuration({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth' }, c.clientId, { client_secret: c.clientSecret });
});
const call = (host, url, method = 'GET', payload, token) => app.inject({ method, url, payload,
 headers: { 'x-pulse-host': host, ...(token ? { 'x-pulse-session': token } : {}) } });
try {
 await app.ready(); assert.equal(new Set(routes).size, routes.length, 'one registration per Google route');
 for (const [host, configured] of [['hosted-0.example.test', true], ['hosted-1.example.test', false], ['install.example.test', true]]) {
  assert.equal((await call(host, '/api/v0/auth/branding')).json().google, configured);
  const login = await call(host, '/api/v0/auth/sign-in', 'POST', { username: host.startsWith('hosted') ? 'hosted.admin' : 'auth.admin', password: 'Synthetic-account-2026!' });
  assert.equal(login.statusCode, 200, login.body); const token = login.json().token;
  assert.equal((await call(host, '/api/v0/admin/sign-in/google', 'GET', undefined, token)).json().configured, configured);
  const enabled = await call(host, '/api/v0/admin/sign-in/google', 'PUT', { enabled: true, allowedDomains: ['example.test'], trustGoogle2Step: false, passwordSignIn: 'on' }, token);
  assert.equal(enabled.statusCode, configured ? 200 : 409, enabled.body);
  const start = await call(host, '/api/v0/auth/google/start?mode=signin&next=%2Ftasks');
  assert.equal(start.statusCode, configured ? 302 : 404, start.body);
  if (!configured) continue;
  const url = new URL(start.headers.location);
  assert.equal(url.searchParams.get('client_id'), host.startsWith('hosted') ? 'hosted-client' : 'install-client');
  assert.equal(url.searchParams.get('redirect_uri'), `https://${host}/api/v0/auth/google/callback`);
  if (host.startsWith('hosted')) {
   const callback = await app.inject({ url: '/api/v0/auth/google/callback?state=' + url.searchParams.get('state') + '&code=synthetic',
    headers: { 'x-pulse-host': 'hosted-1.example.test', 'x-pulse-oidc': start.headers['x-pulse-oidc-set'] } });
   assert.equal(callback.statusCode, 302); assert.match(callback.headers.location, /google=state_invalid/);
  }
 }
} finally { await app.close(); await pool.end(); }
