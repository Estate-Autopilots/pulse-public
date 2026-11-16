// LOGIN-VITALS (owner, 13 Nov 2026: "prepare Microsoft and Apple sign-in the same way"): Continue with Microsoft and
// Continue with Apple are off unless the server switches them on; when on, each vitalsos.ai host sends its own callback
// (docs/ops/SIGN-IN-PROVIDERS.md lists them for the consoles), with state, nonce and the browser binding, PKCE for
// Microsoft and form_post for Apple; Apple's client secret is a valid ES256 token; only an e-mail the provider verified
// signs anyone in. No network, no database (a stub client answers the SQL), synthetic values only.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import * as oidc from 'openid-client';
import { normaliseHost, runWithCompany } from '../dist/tenant-context.js';
import { appleClientSecret, providerClient, providerOn, registerProviderSignIn, verifiedEmail } from '../dist/sign-in-providers.js';

// Microsoft's consumer tenant (personal accounts), as docs/ops/SIGN-IN-PROVIDERS.md sets it on the server.
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad', MSA = { PULSE_MICROSOFT_PERSONAL_TENANT: MSA_TENANT };

const HOSTS = ['app.vitalsos.ai', 'staging.vitalsos.ai', 'dev.vitalsos.ai'];
const ORG = '00000000-0000-4000-8000-00000000f001';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ON = { PULSE_MICROSOFT_SIGN_IN: '1', PULSE_MICROSOFT_CLIENT_ID: 'synthetic-ms-client', PULSE_MICROSOFT_CLIENT_SECRET: 'synthetic-ms-secret',
  PULSE_APPLE_SIGN_IN: '1', PULSE_APPLE_CLIENT_ID: 'ai.vitalsos.synthetic', PULSE_APPLE_TEAM_ID: 'TEAM000001', PULSE_APPLE_KEY_ID: 'KEY0000001', PULSE_APPLE_PRIVATE_KEY: P8 };
const saved = { ...process.env };
test.after(() => { process.env = saved; });

test('off unless switched on with a whole client', () => {
  assert.equal(providerOn('microsoft', {}), false);
  assert.equal(providerOn('apple', {}), false);
  assert.equal(providerOn('microsoft', { ...ON, PULSE_MICROSOFT_SIGN_IN: '0' }), false, 'the switch, not only the client');
  assert.equal(providerOn('microsoft', { ...ON, PULSE_MICROSOFT_CLIENT_SECRET: '' }), false);
  assert.equal(providerOn('apple', { ...ON, PULSE_APPLE_PRIVATE_KEY: 'not a key' }), false, 'a key that does not load is off, not a crash');
  assert.equal(providerOn('microsoft', ON), true);
  assert.equal(providerOn('apple', ON), true);
});

test("Apple's client secret is an ES256 token from the team's key, for one hour", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  const jwt = appleClientSecret({ teamId: 'TEAM000001', keyId: 'KEY0000001', clientId: 'ai.vitalsos.synthetic', privateKey: P8 }, now);
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY0000001' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'TEAM000001', iat: now / 1000, exp: now / 1000 + 3600, aud: 'https://appleid.apple.com', sub: 'ai.vitalsos.synthetic' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.equal(providerClient('apple', ON).secret().split('.').length, 3);
});

test('only an e-mail the provider verified counts (Microsoft work accounts need xms_edov: the nOAuth takeover)', () => {
  const email = 'Person@Example.test';
  assert.equal(verifiedEmail('microsoft', { email, tid: '11111111-1111-4111-8111-111111111111' }), null, 'a work account\'s e-mail claim alone is whatever its admin typed');
  assert.equal(verifiedEmail('microsoft', { email, tid: '11111111-1111-4111-8111-111111111111', xms_edov: true }), 'person@example.test');
  assert.equal(verifiedEmail('microsoft', { email, tid: '11111111-1111-4111-8111-111111111111', xms_edov: '1' }), 'person@example.test');
  assert.equal(verifiedEmail('microsoft', { email, tid: MSA_TENANT }, MSA), 'person@example.test', 'a personal Microsoft account');
  assert.equal(verifiedEmail('microsoft', { email, tid: MSA_TENANT }, {}), null, 'without the consumer tenant configured, only xms_edov counts');
  assert.equal(verifiedEmail('microsoft', { tid: MSA_TENANT, preferred_username: email }, MSA), null, 'no e-mail claim, no guess from the user name');
  assert.equal(verifiedEmail('apple', { email, email_verified: true }), 'person@example.test');
  assert.equal(verifiedEmail('apple', { email, email_verified: 'true' }), 'person@example.test');
  assert.equal(verifiedEmail('apple', { email, email_verified: false }), null);
  assert.equal(verifiedEmail('apple', { email: 'not-an-address', email_verified: true }), null);
});

/** A stand-in for one database connection: answers each SQL call by the function it names. */
function db(answers) {
  return { async query(sql, params = []) {
    for (const [fn, answer] of Object.entries(answers)) if (sql.includes(fn)) return { rows: await answer(params) };
    throw new Error('unexpected SQL in the stub: ' + sql.slice(0, 80));
  } };
}
function api(register) {
  const app = Fastify();
  app.addHook('onRequest', (req, _reply, done) => { const raw = req.headers['x-pulse-host']; runWithCompany({ host: normaliseHost(raw), raw, company: null, installOrg: null }, done); });
  app.setErrorHandler((e, _req, reply) => reply.status(e.statusCode ?? 500).send({ error: e.message }));
  register(app);
  return app;
}
const SERVERS = {
  microsoft: new oidc.Configuration({ issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0', authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys' }, 'synthetic-ms-client', { client_secret: 'synthetic-ms-secret' }),
  apple: new oidc.Configuration({ issuer: 'https://appleid.apple.com', authorization_endpoint: 'https://appleid.apple.com/auth/authorize', token_endpoint: 'https://appleid.apple.com/auth/token',
    jwks_uri: 'https://appleid.apple.com/auth/keys' }, 'ai.vitalsos.synthetic', { client_secret: 'synthetic-apple-secret' }),
};

test('each vitalsos.ai host sends its own callback, state, nonce and the binding; PKCE for Microsoft, form_post for Apple', async () => {
  Object.assign(process.env, ON, { PULSE_HOST_FAMILIES: JSON.stringify(HOSTS.map((app, i) => ({ name: ['vitals', 'staging', 'dev'][i], app }))), PULSE_PUBLIC_URL: 'https://pulse.example.test' });
  const begun = [];
  const conn = db({ 'pulse.auth_allow': () => [{ ok: true }], 'pulse.google_auth_attempt': (p) => { begun.push(JSON.parse(p[1])); return [{ d: { error: 'state_invalid' } }]; } });
  const app = api((a) => registerProviderSignIn(a, (run) => run(conn, ORG), () => {}, async (p) => SERVERS[p]));
  try {
    for (const host of HOSTS) for (const p of ['microsoft', 'apple']) {
      const r = await app.inject({ method: 'GET', url: `/api/v0/auth/${p}/start?mode=signin&next=%2Ftasks`, headers: { 'x-pulse-host': host, 'x-pulse-client-ip': '192.0.2.20' } });
      assert.equal(r.statusCode, 302, r.body);
      const to = new URL(r.headers.location), q = to.searchParams, attempt = begun.at(-1);
      assert.equal(to.origin + to.pathname, SERVERS[p].serverMetadata().authorization_endpoint);
      assert.equal(q.get('redirect_uri'), `https://${host}/api/v0/auth/${p}/callback`);
      assert.equal(q.get('response_type'), 'code');
      assert.equal(q.get('nonce'), attempt.nonce);
      assert.equal(attempt.stateHash, createHash('sha256').update(q.get('state')).digest('hex'), 'only the state\'s hash is stored');
      assert.deepEqual([attempt.provider, attempt.mode, attempt.next], [p, 'signin', '/tasks']);
      assert.match(r.headers['x-pulse-oidc-set'], /^[A-Za-z0-9_-]{43}$/);
      if (p === 'microsoft') {
        assert.equal(q.get('scope'), 'openid email profile');
        assert.equal(q.get('code_challenge_method'), 'S256');
        assert.equal(createHash('sha256').update(attempt.verifier).digest('base64url'), q.get('code_challenge'));
      } else {
        assert.equal(q.get('scope'), 'openid email name');
        assert.equal(q.get('response_mode'), 'form_post', 'Apple sends the e-mail only with form_post');
        assert.equal(q.get('code_challenge'), null);
      }
    }
    // A callback whose attempt is not this provider's (or is gone) goes back to the sign-in page, never signs in.
    const back = await app.inject({ method: 'GET', url: '/api/v0/auth/microsoft/callback?state=x&code=y', headers: { 'x-pulse-host': 'app.vitalsos.ai', 'x-pulse-oidc': 'z'.repeat(43) } });
    assert.equal(back.statusCode, 302);
    assert.equal(back.headers.location, '/login?next=%2F&idp=microsoft&reason=state_invalid');
    assert.equal(begun.at(-1).provider, 'microsoft', 'the callback takes only its own provider\'s attempts');
    // A host outside the families never starts them; switched off, nothing answers.
    assert.equal((await app.inject({ method: 'GET', url: '/api/v0/auth/apple/start', headers: { 'x-pulse-host': 'elsewhere.example.test' } })).statusCode, 404);
    process.env.PULSE_APPLE_SIGN_IN = '0';
    assert.equal((await app.inject({ method: 'GET', url: '/api/v0/auth/apple/start', headers: { 'x-pulse-host': 'app.vitalsos.ai' } })).statusCode, 404);
  } finally { await app.close(); }
});
