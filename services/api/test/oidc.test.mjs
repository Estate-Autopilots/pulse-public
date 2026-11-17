// PULSE-ID: the parts of Sign in with Pulse that need no database (tests/core/test_oidc.py runs the rest against the real
// one): PKCE, the authorize checks and return addresses, client authentication, the signing keys, the ID token (checked
// with jose against the published JWKS), picture signatures, webhook signatures and addresses, cursors.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { checkAuthorize, clientCredentials, discovery, idToken, newClientId, newClientSecret, returnTo, s256, scopeList } from '../dist/oidc.js';
import { forgetSigningKeys, halfHash, parseSigningKeys, pictureSignature, pictureSignatureOk, pictureUrl, signingKeys } from '../dist/oidc-keys.js';
import { cursorIn, cursorOut, hookUrlOk, paged, webhookSignature } from '../dist/connect-api.js';

const pem = (bits = 2048) => generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const APP = { id: 'a', clientId: 'papp_abcdefghij0123456789', name: 'Sales X-Ray (test)', maker: 'Fictional Closers', homeUrl: null, verified: true, development: false,
  status: 'active', redirectUris: ['https://sx.example.test/v1/auth/pulse/callback'], scopes: ['openid', 'profile', 'email', 'pulse.orgs', 'pulse.org.read', 'pulse.org.webhooks'], logo: null };
const Q = { client_id: APP.clientId, redirect_uri: APP.redirectUris[0], response_type: 'code', scope: 'openid profile email pulse.orgs', state: 'state-1234567890',
  nonce: 'n-1', code_challenge: s256('v'.repeat(43)), code_challenge_method: 'S256' };

test('PKCE S256 matches RFC 7636 appendix B', () => {
  assert.equal(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('authorize: unknown apps and unregistered return addresses never redirect', () => {
  assert.deepEqual(checkAuthorize(Q, null), { fatal: 'unknown_app' });
  assert.equal(checkAuthorize(Q, { ...APP, status: 'off' }).fatal, 'unknown_app');
  assert.equal(checkAuthorize({ ...Q, redirect_uri: 'https://sx.example.test/v1/auth/pulse/callback?x=1' }, APP).fatal, 'bad_redirect');
  assert.equal(checkAuthorize({ ...Q, redirect_uri: 'https://evil.example.test/v1/auth/pulse/callback' }, APP).fatal, 'bad_redirect');
});

test('authorize: the request is checked and goes back with the error', () => {
  const err = (q) => checkAuthorize({ ...Q, ...q }, APP).error;
  assert.equal(err({ code_challenge_method: 'plain' }), 'invalid_request');
  assert.equal(err({ code_challenge: undefined }), 'invalid_request');
  assert.equal(err({ state: undefined }), 'invalid_request');
  assert.equal(err({ nonce: undefined }), 'invalid_request');
  assert.equal(err({ scope: 'profile email' }), 'invalid_scope');
  assert.equal(err({ response_type: 'token' }), 'unsupported_response_type');
  const ok = checkAuthorize(Q, APP);
  assert.deepEqual([ok.kind, ok.scopes], ['personal', ['openid', 'profile', 'email', 'pulse.orgs']]);
  // An org scope makes it an org link; scopes the app is not registered for are dropped.
  const org = checkAuthorize({ ...Q, scope: 'openid pulse.org.read pulse.org.webhooks pulse.money.read', pulse_org_hint: 'estateautopilots' }, APP);
  assert.deepEqual([org.kind, org.scopes, org.orgHint], ['org', ['openid', 'pulse.org.read', 'pulse.org.webhooks'], 'estateautopilots']);
});

test('the return address keeps its own query and adds iss', () => {
  const url = new URL(returnTo('https://sx.example.test/cb?keep=1', { code: 'c', state: 's', error: undefined }, 'https://pulse.example.test'));
  assert.deepEqual(Object.fromEntries(url.searchParams), { keep: '1', code: 'c', state: 's', iss: 'https://pulse.example.test' });
});

test('client authentication: Basic or the body, never both', () => {
  const basic = 'Basic ' + Buffer.from(`${APP.clientId}:psec_x%2By`).toString('base64');
  assert.deepEqual(clientCredentials(basic, {}), { id: APP.clientId, secret: 'psec_x+y' });
  assert.deepEqual(clientCredentials(undefined, { client_id: APP.clientId, client_secret: 's' }), { id: APP.clientId, secret: 's' });
  assert.deepEqual(clientCredentials(basic, { client_secret: 's' }), { error: 'invalid_request' });
  assert.deepEqual(clientCredentials(basic, { client_id: 'papp_other0000000000000' }), { error: 'invalid_request' });
  assert.deepEqual(clientCredentials(undefined, {}), { error: 'invalid_client' });
  assert.match(newClientId(), /^papp_[a-z0-9]{20}$/);
  assert.match(newClientSecret(), /^psec_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(scopeList('openid  profile openid'), ['openid', 'profile']);
});

test('signing keys: RSA of at least 2048 bits, kid is the RFC 7638 thumbprint', () => {
  assert.equal(parseSigningKeys('nothing here'), null);
  assert.equal(parseSigningKeys(pem(1024)), null);
  const [a, b] = parseSigningKeys(pem() + '\n' + pem());
  assert.ok(a && b && a.kid !== b.kid && a.jwk.kid === a.kid && a.jwk.alg === 'RS256' && !('d' in a.jwk));
});

test('signing keys come from a file only the server can read, or from the env file as base64', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-oidc-keys-')), file = join(dir, 'signing.pem'), text = pem();
  const kid = parseSigningKeys(text)[0].kid, read = async (path, inline) => { forgetSigningKeys(); return signingKeys(path, inline); };
  try {
    await writeFile(file, text, { mode: 0o600 });
    assert.equal((await read(file, '')).keys[0].kid, kid);
    await chmod(file, 0o640);
    assert.equal((await read(file, '')).keys[0].kid, kid, 'root with the Pulse group (640), as the document keyring is mounted');
    await chmod(file, 0o644);
    assert.deepEqual(await read(file, ''), { ok: false, reason: 'exposed' }, 'a key everyone on the machine can read is not used');
    assert.deepEqual(await read(join(dir, 'missing.pem'), ''), { ok: false, reason: 'missing' });
    const inline = Buffer.from(text).toString('base64');
    assert.equal((await read('', inline)).keys[0].kid, kid, 'the same key from the env file');
    assert.equal((await read('', `${inline}
`)).keys[0].kid, kid);
    assert.deepEqual(await read('', Buffer.from('nothing here').toString('base64')), { ok: false, reason: 'invalid' });
    assert.deepEqual(await read('', '  '), { ok: false, reason: 'missing' });
    await chmod(file, 0o600);
    assert.equal((await read(file, Buffer.from(pem()).toString('base64'))).keys[0].kid, kid, 'the file wins when both are set');
  } finally { forgetSigningKeys(); await rm(dir, { recursive: true, force: true }); }
});

test('the ID token verifies against the published keys and carries the contract claims', async () => {
  const keys = parseSigningKeys(pem() + '\n' + pem()), issuer = 'https://pulse.example.test';
  const access = 'pxa_' + 'a'.repeat(43);
  const r = { kind: 'org', org: '00000000-0000-4000-8000-0000000000aa', scopes: ['openid'], refresh: true, appId: 'x', nonce: 'n-1', authTime: 1792900000, amr: 'sso',
    claims: { sub: 'f'.repeat(32), name: 'Kabir Mifos', given_name: 'Kabir', family_name: 'Mifos', title: 'Graphic Designer', team: 'Pod 1',
      photo: { member: '00000000-0000-4000-8000-0000000000bb', version: 1792900000123 } } };
  const jwt = idToken(keys[0], issuer, APP.clientId, r, access);
  const { payload, protectedHeader } = await jwtVerify(jwt, createLocalJWKSet({ keys: keys.map((k) => k.jwk) }), { issuer, audience: APP.clientId });
  assert.equal(protectedHeader.kid, keys[0].kid);
  assert.equal(payload.exp - payload.iat, 600, 'ID tokens live 10 minutes');
  assert.deepEqual([payload.sub, payload.nonce, payload.at_hash, payload.pulse_org_id, payload.amr, payload.title, payload.team],
    ['f'.repeat(32), 'n-1', halfHash(access), r.org, ['sso'], 'Graphic Designer', 'Pod 1']);
  assert.ok(!('photo' in payload));
  const pic = new URL(payload.picture);
  assert.equal(pic.pathname, '/api/v1/connect/photos/00000000-0000-4000-8000-0000000000bb');
  assert.ok(pictureSignatureOk(keys, APP.clientId, r.org, '00000000-0000-4000-8000-0000000000bb', '1792900000123', pic.searchParams.get('s')));
  // A retired key that is still listed keeps its addresses working; a changed version or member does not.
  assert.ok(pictureSignatureOk(keys, 'papp_x', 'o', 'm', '1', pictureSignature(keys[1], 'papp_x', 'o', 'm', '1')));
  assert.ok(!pictureSignatureOk(keys, 'papp_x', 'o', 'm', '2', pictureSignature(keys[0], 'papp_x', 'o', 'm', '1')));
  assert.ok(!pictureSignatureOk(keys, 'papp_x', 'o', 'n', '1', pictureSignature(keys[0], 'papp_x', 'o', 'm', '1')));
  assert.ok(pictureUrl(issuer, keys[0], 'papp_x', 'o', 'm', 7).startsWith(`${issuer}/api/v1/connect/photos/m?o=o&v=7&a=papp_x&s=`));
});

test('discovery names the contract endpoints and the org API base', () => {
  const d = discovery('https://pulse.example.test');
  assert.equal(d.issuer, 'https://pulse.example.test');
  assert.equal(d.jwks_uri, 'https://pulse.example.test/oauth/jwks');
  assert.equal(d.pulse_org_api_base, 'https://pulse.example.test/api/v1/connect');
  assert.deepEqual(d.code_challenge_methods_supported, ['S256']);
  assert.ok(d.token_endpoint_auth_methods_supported.includes('client_secret_basic'));
  for (const s of ['openid', 'profile', 'email', 'pulse.orgs', 'pulse.org.read', 'pulse.org.webhooks', 'pulse.signals.write']) assert.ok(d.scopes_supported.includes(s), s);
});

test('webhook signatures and addresses', () => {
  // HMAC-SHA256("pwhs_test", "1700000000.{}"), as AC's receiver computes it.
  assert.equal(webhookSignature('pwhs_test', 1700000000, '{}'), 't=1700000000,v1=60d341f660757a5fbff5a33a10ec2e0c9758825a8b51e4ea4ee9aed4d1c1bbbd');
  assert.notEqual(webhookSignature('pwhs_test', 1700000000, '{}'), webhookSignature('pwhs_test', 1700000001, '{}'));
  assert.ok(hookUrlOk('https://salesxray-dev.atlascrest.example/v1/integrations/pulse/webhook'));
  for (const bad of ['http://x.example/h', 'https://x.example:8443/h', 'https://u:p@x.example/h', 'https://x.example/h#f', 'https://127.0.0.1/h', 'https://localhost/h', 'ftp://x.example/h', 42]) assert.ok(!hookUrlOk(bad), String(bad));
});

test('cursors and pages', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(cursorIn(cursorOut(id)), id);
  assert.equal(cursorIn(undefined), null);
  assert.throws(() => cursorIn('not-a-cursor'));
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(paged(rows, 2, 'id'), { items: rows.slice(0, 2), next_cursor: cursorOut('b') });
  assert.deepEqual(paged(rows.slice(0, 2), 2, 'id'), { items: rows.slice(0, 2), next_cursor: null });
});
