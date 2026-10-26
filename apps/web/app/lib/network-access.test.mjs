import test from 'node:test';
import assert from 'node:assert/strict';
import * as loadError from './load-error.mjs';
import { load, render, ui, aiBadge } from '../../../../tools/qa/updates-fixture.mjs';

const NOTICE = 'Pulse Network is not available for this company. Sign in directly on Pulse Network.';
const DIRECT = 'https://network.estateautopilots.com';
const parts = Object.fromEntries(['AskHandoff', 'Composer', 'Conversation', 'HandoffButtons', 'NewMessage', 'Thread'].map(name => [name, () => null]));

function web(status, body) {
  const seen = [];
  const api = load('lib/api.ts', {
    'next/headers': { headers: async () => new Map(), cookies: async () => new Map([['pulse_session', { value: 'synthetic-hosted-session' }]]) },
    './host-mode.mjs': { passwordHost: async () => true, requestHost: () => 'hosted.example.test', hostHeader: () => ({ 'x-pulse-host': 'hosted.example.test' }) },
    './load-error.mjs': loadError,
    globals: { fetch: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status }); } },
  });
  const page = load('network/page.tsx', { '../lib/api': api, '../ui': ui, '../kit/ai-badge': aiBadge, './parts': parts }).default;
  const open = load('network/open/route.ts', { '../../lib/api': api }).GET;
  return { seen, page, open };
}
const pageHtml = page => render(() => page, {});

test('hosted-org refusal survives the real API filter and Message view with an independent direct-sign-in link', async () => {
  const h = web(403, { error: NOTICE });
  const html = await pageHtml(await h.page({ searchParams: Promise.resolve({ error: 'https://untrusted.example.test' }) }));
  assert.match(html, /Pulse Network is not available for this company\. Sign in directly on Pulse Network\./);
  assert.ok(html.includes(`href="${DIRECT}" referrerPolicy="no-referrer"`));
  assert.match(html, /Sign in directly to Pulse Network/);
  assert.doesNotMatch(html, /Try again|\/network\/open|\/connect\/|untrusted\.example/);
  assert.equal(h.seen.length, 1);
  assert.ok(h.seen[0].url.endsWith('/api/v0/network/home'));
  assert.equal(h.seen[0].init.headers['x-pulse-session'], 'synthetic-hosted-session');
  assert.equal(h.seen[0].init.cache, 'no-store');
});

test('unknown refusals and 5xx text stay sanitized; other refusals never receive a Network sign-in link', async () => {
  for (const [status, error] of [[403, 'Authorization: Bearer synthetic-canary'], [403, NOTICE + ' https://untrusted.example.test'], [503, NOTICE], [502, '<html>synthetic-canary</html>'], [403, 'Pulse Network is open to leaders first.']]) {
    const h = web(status, { error });
    const html = await pageHtml(await h.page({ searchParams: Promise.resolve({}) }));
    assert.ok(!html.includes(DIRECT));
    assert.doesNotMatch(html, /synthetic-canary|\/network\/open|\/connect\//);
    if (error.includes('leaders first')) assert.match(html, /Pulse Network is open to leaders first/);
    else { assert.match(html, /Try again/); assert.ok(!html.includes(NOTICE)); }
  }
});

test('denied connector sign-in returns to the Pulse guidance page; the independent site is never an automatic redirect', async () => {
  const h = web(403, { error: NOTICE });
  const response = await h.open({ nextUrl: new URL('https://hosted.example.test/network/open?next=/') });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/network?error=1');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(h.seen.length, 1);
  assert.ok(h.seen[0].url.endsWith('/api/v0/network/sign-in?next=%2F'));
});

test('the install organisation retains the embedded page and connector sign-in', async () => {
  const h = web(200, { me: { handle: 'synthetic.lead' }, posts: [], channels: [], handoffs: [], agents: [], people: [] });
  const html = await pageHtml(await h.page({ searchParams: Promise.resolve({}) }));
  assert.match(html, /href="\/network\/open\?next=%2F"/);
  assert.match(html, /Open Pulse Network/);
  assert.ok(!html.includes(DIRECT));
  const signedIn = web(200, { url: 'https://network.example.test/connect/synthetic-once' });
  const response = await signedIn.open({ nextUrl: new URL('https://install.example.test/network/open') });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://network.example.test/connect/synthetic-once');
});
