import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, verifyUrl, checkBase, pipSvg, pipStaticSvg, pipFace, PIP_MOODS, demoClient } from '../src/index.js';

const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const memoryStore = (initial = null) => { let t = initial; return { get: async () => t, set: async (x) => { t = x; }, clear: async () => { t = null; }, peek: () => t }; };
const T = (c) => c.repeat(43);

test('base address must be https (loopback http allowed for local tests)', () => {
  assert.equal(checkBase('https://pulse.example/api/native/v0/'), 'https://pulse.example/api/native/v0');
  assert.equal(checkBase('http://127.0.0.1:3200/api/native/v0'), 'http://127.0.0.1:3200/api/native/v0');
  assert.throws(() => checkBase('http://pulse.example/api/native/v0'));
  assert.throws(() => checkBase('https://user:pw@pulse.example/api'));
  assert.equal(verifyUrl('https://pulse.example/api/native/v0', 'ABCD-EFGH'), 'https://pulse.example/connect?code=ABCD-EFGH');
});

test('token-only calls, single-flight refresh on 401, rotated tokens stored', async () => {
  const store = memoryStore({ accessToken: T('a'), refreshToken: T('r'), deviceId: 'd1' });
  const seen = [];
  let refreshes = 0;
  const fetchImpl = async (url, init) => {
    seen.push([url.split('/v0/')[1], init.headers.authorization ?? null, init.redirect]);
    if (url.endsWith('native/refresh')) { refreshes++; return json(200, { accessToken: T('b'), refreshToken: T('s') }); }
    return init.headers.authorization === `Bearer ${T('b')}` ? json(200, { state: 'in' }) : json(401, { error: 'expired' });
  };
  const c = createClient({ base: 'https://pulse.example/api/native/v0', fetchImpl, store });
  const [a, b] = await Promise.all([c.companion(), c.companion()]);
  assert.equal(a.state, 'in');
  assert.equal(b.state, 'in');
  assert.equal(refreshes, 1, 'one refresh for concurrent 401s');
  assert.equal(store.peek().accessToken, T('b'));
  assert.equal(store.peek().refreshToken, T('s'));
  assert.ok(seen.every(([, , redirect]) => redirect === 'manual'));
});

test('a refused refresh signs the device out', async () => {
  const store = memoryStore({ accessToken: T('a'), refreshToken: T('r'), deviceId: 'd1' });
  const c = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async () => json(401, { error: 'revoked' }) });
  await assert.rejects(c.companion(), (e) => e.signedOut === true && e.status === 401);
  assert.equal(store.peek(), null);
});

test('a late 401 reuses the rotated credential instead of replaying the spent refresh token', async () => {
  const store = memoryStore({ accessToken: T('a'), refreshToken: T('r'), deviceId: 'd1' });
  let release, refreshes = 0, oldCalls = 0;
  const late = new Promise((resolve) => { release = resolve; });
  const c = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async (url, init) => {
    if (url.endsWith('native/refresh')) { refreshes++; return json(200, { accessToken: T('b'), refreshToken: T('s') }); }
    if (init.headers.authorization === `Bearer ${T('b')}`) return json(200, { state: 'in' });
    if (++oldCalls === 2) await late;
    return json(401, { error: 'expired' });
  } });
  const first = c.companion(), second = c.companion();
  await first;
  release();
  assert.equal((await second).state, 'in');
  assert.equal(refreshes, 1);
});

test('a refresh finishing after local sign-out cannot restore a device credential', async () => {
  const store = memoryStore({ accessToken: '', refreshToken: T('r'), deviceId: 'd1' });
  let release, started;
  const waiting = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const c = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async () => {
    started(); await waiting; return json(200, { accessToken: T('b'), refreshToken: T('s') });
  } });
  const pending = c.companion();
  await entered; await store.clear(); release();
  await assert.rejects(pending, (e) => e.signedOut === true);
  assert.equal(store.peek(), null);
});

test('the outer Access gate and offline are told apart from Pulse errors', async () => {
  const store = memoryStore({ accessToken: T('a'), refreshToken: T('r'), deviceId: 'd1' });
  const redirect = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://x.cloudflareaccess.com/login' } }) });
  await assert.rejects(redirect.companion(), (e) => e.gate === true);
  const html = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html.companion(), (e) => e.gate === true);
  const offline = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.companion(), (e) => e.offline === true);
  const conflict = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async () => json(409, { error: 'You are already checked in' }) });
  await assert.rejects(conflict.act('check-in'), (e) => e.status === 409 && /already/.test(e.message));
  const limited = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async () => json(429, { error: 'Slow down' }, { 'retry-after': '12' }) });
  await assert.rejects(limited.companion(), (e) => e.status === 429 && e.retryAfter === 12);
});

test('browser pairing stores tokens only once approved', async () => {
  const store = memoryStore();
  let polls = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.authorization, undefined, 'pairing is unauthenticated');
    if (url.endsWith('pair/start')) return json(200, { pairId: 'p1', pollSecret: T('p'), code: 'ABCD-EFGH', expiresIn: 600, interval: 3 });
    polls++;
    return polls < 2 ? json(200, { status: 'pending' }) : json(200, { status: 'approved', accessToken: T('a'), refreshToken: T('r'), deviceId: 'd9', person: { id: 'p', name: 'Asha' } });
  };
  const c = createClient({ base: 'https://pulse.example/api/native/v0', fetchImpl, store });
  const start = await c.pairStart('windows', 'Asha’s laptop');
  assert.equal(start.code, 'ABCD-EFGH');
  assert.equal((await c.pairPoll('p1', T('p'))).status, 'pending');
  assert.equal(store.peek(), null);
  const done = await c.pairPoll('p1', T('p'));
  assert.equal(done.status, 'approved');
  assert.equal(store.peek().deviceId, 'd9');
});

test('sign-out revokes this device and forgets tokens even when offline', async () => {
  const store = memoryStore({ accessToken: T('a'), refreshToken: T('r'), deviceId: 'd1' });
  const calls = [];
  const c = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async (url) => { calls.push(url); throw new TypeError('offline'); } });
  await c.signOut();
  assert.ok(calls[0].endsWith('devices/d1/revoke'));
  assert.equal(store.peek(), null);
});

test('Pip: every mood renders small, labelled, static markup', () => {
  for (const mood of PIP_MOODS) {
    const svg = pipSvg({ mood, uid: 't' });
    assert.match(svg, new RegExp(`data-mood="${mood}"`));
    assert.match(svg, /role="img" aria-label="Pip, the Pulse bot/);
    assert.ok(svg.length < 3000, `${mood} is ${svg.length} bytes`);
    assert.doesNotMatch(svg, /<script|on\w+=/);
  }
  assert.match(pipSvg({ mood: 'break' }), /pip-cup/);
  assert.match(pipSvg({ mood: 'sleepy' }), /pip-zzz/);
  assert.match(pipSvg({ mood: 'celebrate' }), /pip-confetti/);
  assert.match(pipSvg({ mood: 'done' }), /pip-wave/);
  assert.match(pipSvg({ still: true }), /pip-still/);
  assert.match(pipSvg({ label: '<b>"x"</b>' }), /&lt;b&gt;&quot;x&quot;/);
  assert.equal(pipFace('nonsense').eyes, 'open');
});

test('Pip: the island states each have their own face', () => {
  for (const mood of ['idle', 'listening', 'thinking', 'new-message', 'happy', 'concerned', 'sleeping']) assert.ok(PIP_MOODS.includes(mood), mood);
  assert.match(pipSvg({ mood: 'thinking' }), /pip-dots/);
  assert.match(pipSvg({ mood: 'listening' }), /pip-rings/);
  assert.match(pipSvg({ mood: 'new-message' }), /pip-rings/);
  assert.match(pipSvg({ mood: 'concerned' }), /pip-brows/);
  assert.match(pipSvg({ mood: 'sleeping' }), /pip-zzz/);
  assert.equal(pipFace('happy').eyes, 'happy');
  assert.equal(pipFace('new-message').mouth, 'o');
});

test('demo client responds to clicks locally', async () => {
  const c = demoClient('out');
  assert.equal((await c.companion()).state, 'out');
  await c.act('check-in');
  assert.equal((await c.companion()).state, 'in');
  await c.act('break-start');
  assert.equal((await c.companion()).state, 'break');
});

test('Pip without a stylesheet (phone app and Android widget) carries every colour inline', () => {
  for (const mood of PIP_MOODS) for (const theme of ['light', 'dark']) {
    const svg = pipStaticSvg({ mood, theme });
    assert.doesNotMatch(svg, /class=|style=|var\(/);
    assert.match(svg, /stop-color="#/);
    assert.ok(svg.length < 3500);
  }
  assert.match(pipStaticSvg({ blink: true }), /M45.4 66q4.4 4.5 8.8 0/);
});

test('a remembered device without an access credential rotates before its first call', async () => {
  const store = memoryStore({ accessToken: '', refreshToken: T('r'), deviceId: 'd1' });
  const paths = [];
  const c = createClient({ base: 'https://pulse.example/api/native/v0', store, fetchImpl: async (url, init) => { paths.push(url.split('/v0/')[1]); return url.endsWith('native/refresh') ? json(200, { accessToken: T('n'), refreshToken: T('m') }) : json(200, { state: 'out', auth: init.headers.authorization }); } });
  const day = await c.companion();
  assert.deepEqual(paths, ['native/refresh', 'companion']);
  assert.equal(day.auth, `Bearer ${T('n')}`);
});

test('an old device response cannot expose its data or clear a newly paired account', async () => {
  for (const status of [200,401]) {
    const store=memoryStore({accessToken:T('a'),deviceId:'old'});
    let release,entered;const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r);
    const c=createClient({base:'https://pulse.example/api/native/v0',store,fetchImpl:async()=>{entered();await waiting;return json(status,{private:'old account',error:'expired'});}});
    const pending=c.companion();await started;await store.set({accessToken:T('b'),deviceId:'new'});release();
    await assert.rejects(pending,e=>e.status===409&&!e.signedOut);
    assert.equal(store.peek().deviceId,'new');
  }
});
