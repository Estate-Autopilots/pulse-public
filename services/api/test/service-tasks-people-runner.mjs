import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../dist/app.js';
import { serviceProxy } from '../../../apps/web/app/lib/service-proxy.mjs';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool), logs = [];
app.addHook('onRequest', (request, _reply, done) => { for (const l of ['info', 'warn', 'error']) request.log[l] = (...a) => logs.push(JSON.stringify(a)); done(); });
const key = async (scopes) => {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  await pool.query("select pulse.service_key_manage('issue',$1,$2,$3,'Synthetic WAS',$4)", [id, createHash('sha256').update(secret).digest('hex'), scopes, process.env.TEST_AGENT]);
  return { authorization: `Bearer psvc_${id}_${secret}` };
};
const token = [{ alg: 'RS256' }, { sub: 'synthetic' }].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.') + '.synthetic'; // unsigned fixture
try {
  const both = await key(['tasks.read', 'people.read']), people = await key(['people.read']);
  const page = await app.inject({ url: '/api/v1/service/people?limit=200', headers: both });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.headers['cache-control'], /no-store/);
  assert.deepEqual(page.json().items.map((p) => p.id).sort(), JSON.parse(process.env.TEST_PEOPLE).sort());
  for (const [path, headers, status, error] of [['people?phone=%2B919999999999', both, 400], ['people?limit=2&extra=1', both, 400],
    ['people?limit=201', both, 400], ['tasks/mine?limit=1', both, 400], ['tasks/mine', both, 401, 'person_token_invalid'],
    ['tasks/mine', { ...both, 'pulse-person-token': token }, 401, 'person_token_invalid'],
    ['tasks/mine', { ...people, 'pulse-person-token': token }, 403], ['people', {}, 401]]) {
    const response = await app.inject({ url: `/api/v1/service/${path}`, headers });
    assert.equal(response.statusCode, status, path + ' ' + response.body);
    if (error) assert.deepEqual(response.json(), { error });
  }
  let sub = 'sub-editor';
  const verified = createApp(pool, pool, undefined, undefined, undefined, async (t) => t === token ? { iss: 'https://accounts.google.com', sub } : null);
  const headers = { ...both, 'pulse-person-token': token };
  try {
    const own = await verified.inject({ url: '/api/v1/service/tasks/mine', headers });
    assert.equal(own.statusCode, 200, own.body); assert.equal(own.json().personId, JSON.parse(process.env.TEST_PEOPLE)[0]);
    sub = 'unlinked'; const missing = await verified.inject({ url: '/api/v1/service/tasks/mine', headers });
    assert.equal(missing.statusCode, 403); assert.deepEqual(missing.json(), { error: 'person_not_linked' });
    assert.equal((await verified.inject({ url: '/api/v1/service/tasks/mine?personId=' + randomUUID(), headers })).statusCode, 400);
    verified.serviceKeyContext.pool = { connect: async () => { const c = await pool.connect(); return {
      query: async (...args) => { const r = await c.query(...args); if (args[0].includes('service_people(')) r.rows[0].page.items[0].phone = 'synthetic'; return r; }, release: () => c.release(),
    }; } };
    assert.equal((await verified.inject({ url: '/api/v1/service/people', headers: both })).statusCode, 500, 'unexpected private field fails closed');
  } finally { await verified.close(); }
  // EST-1879: the production default verifier, real RSA signatures, synthetic Google discovery/JWKS only.
  const savedFetch = globalThis.fetch, savedAudiences = process.env.PULSE_SERVICE_PERSON_TOKEN_AUDIENCES;
  const rsa = await generateKeyPair('RS256'), forged = await generateKeyPair('RS256'), requests = [];
  const jwks = 'https://www.googleapis.com/synthetic-jwks', iss = 'https://accounts.google.com', now = Math.floor(Date.now() / 1000);
  globalThis.fetch = async url => {
    requests.push(String(url));
    if (String(url) === iss + '/.well-known/openid-configuration') return Response.json({ issuer: iss, jwks_uri: jwks });
    assert.equal(String(url), jwks, 'no real provider request');
    return Response.json({ keys: [{ ...await exportJWK(rsa.publicKey), kid: 'synthetic', alg: 'RS256', use: 'sig' }] });
  };
  const sign = (overrides = {}, alg = 'RS256', key = rsa.privateKey) => new SignJWT({ iss, sub: 'sub-editor', aud: 'synthetic-client',
    exp: now + 300, iat: now, email_verified: true, hd: 'example.test', ...overrides }).setProtectedHeader({ alg, kid: 'synthetic' }).sign(key);
  const seenTokens = [], ownTasks = async (t, status, error) => {
    seenTokens.push(t);
    const r = await app.inject({ url: '/api/v1/service/tasks/mine', headers: { ...both, 'pulse-person-token': t } });
    assert.equal(r.statusCode, status, r.body); if (error) assert.deepEqual(r.json(), { error }); return r.json();
  };
  try {
    const good = await sign();
    for (const audiences of [undefined, '', ' , , ']) {
      if (audiences === undefined) delete process.env.PULSE_SERVICE_PERSON_TOKEN_AUDIENCES;
      else process.env.PULSE_SERVICE_PERSON_TOKEN_AUDIENCES = audiences;
      await ownTasks(good, 401, 'person_token_invalid');
    }
    assert.deepEqual(requests, [], 'empty audiences never fetch provider keys');
    process.env.PULSE_SERVICE_PERSON_TOKEN_AUDIENCES = ' other-client, synthetic-client, ';
    for (const claims of [{ aud: 'wrong' }, { exp: now - 120 }, { iss: 'https://evil.example' }, { email_verified: false },
      { email_verified: 'true' }, { hd: undefined }, { hd: 'other.test' }, { hd: ['example.test'] }, { iat: now + 120 },
      { iat: undefined }, { exp: undefined }, { sub: undefined }, { sub: '' }, { iat: now + 10, exp: now + 5 }]) {
      await ownTasks(await sign(claims), 401, 'person_token_invalid');
    }
    await ownTasks(await sign({}, 'RS256', forged.privateKey), 401, 'person_token_invalid');
    await ownTasks(await sign({}, 'HS256', new Uint8Array(32)), 401, 'person_token_invalid');
    await ownTasks(Buffer.from('{"alg":"none"}').toString('base64url') + '.' + good.split('.')[1] + '.', 401, 'person_token_invalid');
    for (const claims of [{}, { iss: 'accounts.google.com' }, { exp: now - 10, iat: now - 300 }, { iat: now + 10 }]) {
      const mine = await ownTasks(await sign(claims), 200);
      assert.equal(mine.personId, JSON.parse(process.env.TEST_PEOPLE)[0]);
      assert.deepEqual(mine.items.map(t => t.title), ['Synthetic token task']);
    }
    await ownTasks(await sign({ sub: 'unlinked' }), 403, 'person_not_linked');
    assert.deepEqual(requests, [iss + '/.well-known/openid-configuration', jwks], 'discovery and keys are cached');
    assert.ok(seenTokens.every(t => !logs.join('\n').includes(t)), 'no signed token in logs');
    assert.ok(!logs.join('\n').includes('sub-editor'), 'no claims in logs');
    console.log('GOOGLE_PERSON_TOKEN ok: 401 refusals, 403 unlinked, 200 own tasks; canonical issuer; cached JWKS');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedAudiences === undefined) delete process.env.PULSE_SERVICE_PERSON_TOKEN_AUDIENCES;
    else process.env.PULSE_SERVICE_PERSON_TOKEN_AUDIENCES = savedAudiences;
  }
  // The deployed proxy forwards the person token to tasks/mine only and refuses other shapes before the API.
  const original = globalThis.fetch, forwarded = [];
  process.env.PULSE_API_URL = await app.listen({ host: '127.0.0.1', port: 0 });
  globalThis.fetch = (url, options) => { forwarded.push(new Headers(options.headers).has('pulse-person-token')); return original(url, options); };
  for (const [path, method, status] of [['tasks/mine', 'GET', 401], ['people?limit=1', 'GET', 200], ['people?phone=1', 'GET', 400],
    ['tasks/mine', 'POST', 403], ['tasks/other', 'GET', 403]]) {
    const request = new Request(`https://synthetic.example/api/v1/service/${path}`, { method, headers: { ...both, 'pulse-person-token': token } });
    assert.equal((await serviceProxy(request, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) })).status, status, path);
  }
  globalThis.fetch = original;
  assert.deepEqual(forwarded, [true, false]);
  assert.ok(logs.length && !logs.join('\n').includes(token), 'the person token is never logged');
  console.log('SERVICE_TASKS_PEOPLE ok');
} finally {
  await app.close();
  await pool.end();
}
