import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, describe, describeForm, deviceClass, edgeOf, isPrefetch, nativeStart, networkOf, STREAM_GRACE_MS, streamDropped, pathTemplate, platformOf, pollSampler, randomId, renderId, safeLabel, screenOf, scrub, selectorOf } from './telemetry.mjs';
import { inboundHeaders } from './host-mode.mjs';

// TELEMETRY: the collector's pure parts. Synthetic values only.
test('ids, e-mail addresses, tokens and numbers never leave the page', () => {
  assert.equal(scrub('Open 3f2a1b4c-1111-4222-8333-444455556666 for test.person@example.test'), 'Open :id for :email');
  assert.equal(scrub('session test-0000000000000000000000 expired'), 'session :token expired');
  assert.equal(scrub('call +91 98765 43210 now'), 'call :n now');
  assert.equal(scrub('invoice 20261024'), 'invoice :n');
  assert.equal(scrub(42), null);
});

test('labels that look like names or content are dropped, UI words stay', () => {
  assert.equal(safeLabel('New task'), 'New task');
  assert.equal(safeLabel('Go to Dashboard'), 'Go to Dashboard');
  assert.equal(safeLabel('HR desk'), 'HR desk');
  assert.equal(safeLabel('Chat with Synthetic'), null);
  assert.equal(safeLabel('Open Synthetic Person'), null);
  assert.equal(safeLabel('this is a very long sentence that is content'), null);
});

test('paths become templates: ids, numbers and e-mails replaced, the query keeps its keys only', () => {
  assert.equal(pathTemplate('/api/v0/people/3f2a1b4c-1111-4222-8333-444455556666/files?q=secret&tab=x'), '/api/v0/people/:id/files?q&tab');
  assert.equal(pathTemplate('/api/v0/tasks/12345'), '/api/v0/tasks/:n');
  assert.equal(pathTemplate('/people/accounts/someone%40example.test'), '/people/accounts/:email');
  assert.equal(pathTemplate('/tasks/EA-T00123'), '/tasks/:id');
  assert.equal(pathTemplate('/hr'), '/hr');
  assert.equal(screenOf('https://pulse.example.test/hr?tab=leave&view=types&q=private'), '/hr?tab=leave&view=types');
  assert.equal(screenOf('/people/3f2a1b4c-1111-4222-8333-444455556666?tab=Not Plain'), '/people/:id');
});

test('platform, phone-app shell version and device class', () => {
  assert.deepEqual(platformOf('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile PulseShell/1.1.4'), { plat: 'android', shell: '1.1.4' });
  assert.deepEqual(platformOf('Mozilla/5.0 (Windows NT 10.0) Chrome/130'), { plat: 'web', shell: null });
  assert.deepEqual(platformOf('x', { __TAURI_INTERNALS__: {} }), { plat: 'desktop', shell: null });
  assert.equal(deviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 390, true), 'phone');
  assert.equal(deviceClass('Mozilla/5.0 (iPad)', 820, true), 'tablet');
  assert.equal(deviceClass('Mozilla/5.0 (Windows NT 10.0)', 1080, false), 'desktop');
});

// A tiny element double: attributes, parent, closest by a few selectors, text.
function el(tag, attrs = {}, { text = '', parent = null, children = 0 } = {}) {
  const node = { tagName: tag.toUpperCase(), parentElement: parent, textContent: text, childElementCount: children,
    getAttribute: (k) => (k in attrs ? attrs[k] : null) };
  node.closest = (sel) => {
    for (let n = node; n; n = n.parentElement) {
      const t = n.tagName.toLowerCase(), role = n.getAttribute('role');
      if (sel.includes('a[href]') && ((t === 'a' && n.getAttribute('href') !== null) || ['button', 'input', 'select', 'textarea', 'summary', 'label'].includes(t)
        || (role && ['button', 'tab', 'link', 'menuitem', 'option', 'checkbox', 'switch'].includes(role)) || n.getAttribute('data-testid') !== null)) return n;
      if (!sel.includes('a[href]') && (['li', 'tr', 'article'].includes(t) || (role && ['row', 'listitem', 'option'].includes(role)))) return n;
    }
    return null;
  };
  return node;
}

test('a click names its element by test id, link target or short label; never by content in a list', () => {
  const loc = { href: 'https://pulse.example.test/dashboard' };
  assert.equal(describe(el('button', { 'data-testid': 'save-task' }), loc).name, 'save-task');
  const link = describe(el('a', { href: '/people/3f2a1b4c-1111-4222-8333-444455556666?tab=work' }), loc);
  assert.equal(link.name, 'link /people/:id?tab=work');
  assert.equal(link.nav, true);
  assert.equal(describe(el('a', { href: '/dashboard' }), loc).nav, false, 'the same screen is not a navigation');
  assert.equal(describe(el('button', {}, { text: 'Save changes' }), loc).name, 'button Save changes');
  const row = el('li');
  assert.equal(describe(el('button', {}, { text: 'Synthetic preview', parent: row }), loc).name, 'button', 'words inside a list item are content');
  assert.equal(describe(el('button', { 'aria-label': 'Message Synthetic Person' }), loc).name, 'button');
  const input = describe(el('input', { name: 'email', type: 'email', value: 'private@example.test' }), loc);
  assert.equal(input.name, 'input email');
  assert.ok(!JSON.stringify(input).includes('private'), 'an input value is never read');
  assert.equal(describe(el('div'), loc), null);
  assert.equal(describe(el('span', {}, { parent: el('button', { role: 'tab', 'aria-expanded': 'true' }, { text: 'Leave' }) }), loc).expanded, true);
});

test('selectors use test ids, plain ids and CSS-module class names without their hash', () => {
  const main = el('main', { id: 'main-content' });
  const panel = el('section', { class: 'ui-module__a1B2c__panel other' }, { parent: main });
  assert.equal(selectorOf(el('button', { class: 'ui-module__a1B2c__btn' }, { parent: panel })), 'main#main-content>section.panel>button.btn');
  assert.equal(selectorOf(el('button', {}, { parent: el('div', { 'data-testid': 'composer' }) })), '[data-testid=composer]>button');
});

test('a form submit carries its field names only', () => {
  const form = { getAttribute: (k) => ({ 'aria-label': 'New task' })[k] ?? null,
    elements: [{ getAttribute: (k) => ({ name: 'title', type: 'text', value: 'private words' })[k] ?? null },
      { getAttribute: (k) => ({ name: 'due' })[k] ?? null }, { getAttribute: (k) => ({ name: 'csrf', type: 'hidden' })[k] ?? null },
      { getAttribute: (k) => ({ name: 'title' })[k] ?? null }] };
  assert.deepEqual(describeForm(form, { href: 'https://pulse.example.test/tasks' }), { name: 'New task', fields: ['title', 'due'] });
});

test('request and session ids are URL-safe', () => {
  for (let i = 0; i < 20; i++) assert.match(randomId(12), /^[A-Za-z0-9_-]{16}$/);
});

test('the queue batches, retries later on 5xx and network errors and stops on 404', async () => {
  let clock = 1000, answer = { ok: true, status: 200 };
  const sent = [];
  const q = createQueue({ send: async (body) => { sent.push(JSON.parse(body)); return answer; }, context: () => ({ sid: 'synthetic-session' }),
    now: () => clock, batch: 2, max: 5 });
  for (let i = 0; i < 7; i++) q.push({ k: 'ui.click', t: i });
  assert.equal(q.state().size, 5);
  assert.equal(q.state().dropped, 2, 'the oldest are dropped past the cap');
  assert.equal(await q.flush(), true);
  assert.deepEqual(sent[0].ev.map((e) => e.t), [2, 3]);
  assert.equal(sent[0].sid, 'synthetic-session');
  assert.equal(sent[0].sentAt, 1000);
  answer = { ok: false, status: 503 };
  assert.equal(await q.flush(), false);
  assert.equal(q.state().size, 3, 'a failed batch goes back');
  assert.equal(await q.flush(), false);
  assert.equal(sent.length, 2, 'and waits before the next try');
  clock += 16_000;
  answer = { ok: false, status: 404 };
  await q.flush();
  assert.equal(q.state().off, true, 'no endpoint: the collector stops for this page');
  q.push({ k: 'ui.click', t: 10 });
  assert.equal(q.state().size, 0);
});

test('a page going away hands one batch over without waiting and stores only what it could not hand over', async () => {
  const handed = [], stored = [];
  let take = true;
  const q = createQueue({ send: async () => { throw new Error('the periodic send is not used'); }, sendFinal: (body) => { if (take) handed.push(JSON.parse(body)); return take; },
    context: () => ({ sid: 'synthetic-session' }), store: (ev) => stored.push(...ev), batch: 2 });
  for (let i = 0; i < 3; i++) q.push({ k: 'ui.click', t: i });
  assert.equal(await q.flush(true), true);
  assert.deepEqual(handed[0].ev.map((e) => e.t), [0, 1], 'one batch goes with the page');
  assert.deepEqual(stored.map((e) => e.t), [2], 'the rest waits for the next page; nothing handed over is stored again');
  stored.length = 0;
  take = false;
  q.push({ k: 'ui.click', t: 3 });
  assert.equal(await q.flush(true), false);
  assert.deepEqual(stored.map((e) => e.t), [3], 'a batch the browser would not take is stored');
});

test('a final flush while offline stores everything without sending', async () => {
  const sent = [], stored = [];
  const q = createQueue({ send: async (b) => { sent.push(b); return { ok: true, status: 200 }; }, sendFinal: (b) => { sent.push(b); return true; }, context: () => ({}),
    store: (ev) => stored.push(...ev), offline: () => true });
  q.push({ k: 'app.offline', t: 1 });
  await q.flush(true);
  assert.equal(sent.length, 0);
  assert.equal(stored.length, 1);
  q.restore(stored);
  assert.equal(q.state().size, 1, 'the next page sends what was stored');
});

// PERF: production (a password host) removed the browser's request id with the client-sent identity headers, so no API
// call there joined the API's own timing.
test('the request id survives on a password host; identity headers still do not', () => {
  const h = inboundHeaders(new Headers({ 'x-pulse-request-id': 'synthetic-req-01', 'x-pulse-session': 'spoofed', 'cf-access-authenticated-user-email': 'test.person@example.test' }), '/api/v0/me', true, 'GET');
  assert.equal(h.get('x-pulse-request-id'), 'synthetic-req-01');
  assert.equal(h.get('x-pulse-session'), null);
  assert.equal(h.get('cf-access-authenticated-user-email'), null);
});

test('background polls are sampled after their first calls; actions, failures and slow calls are always kept', () => {
  const keep = pollSampler(3, 5);
  const poll = Array.from({ length: 13 }, () => keep('GET /api/v0/companion/updates', { during: false, status: 200, ms: 40 }));
  assert.deepEqual(poll.map((k) => k.keep), [true, true, true, false, false, false, false, true, false, false, false, false, true]);
  assert.equal(poll[7].sample, 5, 'a kept sample carries its weight');
  assert.equal(poll[0].sample, undefined);
  assert.equal(keep.isPoll('GET /api/v0/companion/updates'), true, 'a route seen polling is a poll');
  assert.equal(keep.isPoll('POST /api/v0/tasks'), false);
  for (const call of [{ during: true, status: 200, ms: 40 }, { during: false, status: 500, ms: 40 }, { during: false, status: 0, ms: 40 }, { during: false, status: 200, ms: 1500 }])
    assert.deepEqual(keep('GET /api/v0/companion/updates', call), { keep: true });
});

test('a page load reads its request id from Server-Timing', () => {
  assert.equal(renderId([{ name: 'pulse', description: 'synthetic-render-1' }]), 'synthetic-render-1');
  assert.equal(renderId([{ name: 'cfL4', description: 'x' }]), undefined);
  assert.equal(renderId([{ name: 'pulse', description: 'bad id!' }]), undefined);
  assert.equal(renderId(undefined), undefined);
});

test('the Cloudflare location and protocol come from the edge trace', () => {
  assert.deepEqual(edgeOf('fl=1\nh=pulse.example.test\nip=192.0.2.1\nhttp=http/3\nloc=IN\ncolo=BOM\n'), { colo: 'BOM', http: 'http/3' });
  assert.deepEqual(edgeOf('colo=SIN\n'), { colo: 'SIN' });
  assert.equal(edgeOf('<html>Not found</html>'), null);
  assert.equal(edgeOf(undefined), null);
});

// SPEED-TELEMETRY (14 Nov 2026)
test("Next's link prefetches are told apart from the screen's own page fetches", () => {
  assert.equal(isPrefetch('/people/x?_rsc=1', { headers: { RSC: '1', 'Next-Router-Prefetch': '1' } }), true);
  assert.equal(isPrefetch('/people/x?_rsc=1', { headers: { rsc: '1', 'next-router-segment-prefetch': '/_tree' } }), true);
  assert.equal(isPrefetch('/people/x', { headers: new Headers({ 'next-router-prefetch': '1' }) }), true);
  assert.equal(isPrefetch('/people/x', { headers: [['next-router-prefetch', '1']] }), true);
  assert.equal(isPrefetch(new Request('http://pulse.invalid/people/x', { headers: { 'next-router-prefetch': '1' } })), true);
  assert.equal(isPrefetch('/people/x?_rsc=1', { headers: { RSC: '1', 'Next-Url': '/people' } }), false, 'a navigation fetch is the screen\'s work');
  assert.equal(isPrefetch('/people/x'), false);
  assert.equal(isPrefetch(new URL('http://pulse.invalid/x')), false);
});

test('the phone app counts its native start only for a cold start', () => {
  assert.equal(nativeStart(1800, 300), 1500);
  assert.equal(nativeStart(200, 300), 0, 'never negative');
  assert.equal(nativeStart(2_687_697, 300), null, 'a process up for 45 minutes was resumed: not start time');
  assert.equal(nativeStart(undefined, 300), null);
});

test('the network is reported as numbers and short codes only', () => {
  assert.deepEqual(networkOf({ effectiveType: '3g', rtt: 450, downlink: 1.25, saveData: true }), { conn: '3g', rtt: 450, down: 1.3, save: true });
  assert.deepEqual(networkOf({ effectiveType: 'wifi-ish', rtt: NaN }), {});
  assert.deepEqual(networkOf(undefined), {});
});

test("SPEED-NET: a page load says which Cloudflare location answered and where its first byte went; a call says the server's part", async () => {
  const { edgeColo, serverMs, netTiming } = await import("./telemetry.mjs");
  assert.equal(edgeColo([{ name: "pulse", description: "abcdefgh12" }, { name: "edge", description: "MRS" }]), "MRS");
  assert.equal(edgeColo([{ name: "edge", description: "<script>" }]), undefined);
  assert.equal(edgeColo(undefined), undefined);
  assert.equal(serverMs("app;dur=12"), 12);
  assert.equal(serverMs("cfL4;desc=x, app;dur=40.6"), 41);
  assert.equal(serverMs("pulse;desc=x"), undefined);
  assert.equal(serverMs(null), undefined);
  assert.deepEqual(netTiming({ domainLookupStart: 5, domainLookupEnd: 9, connectStart: 9, connectEnd: 400, secureConnectionStart: 200, requestStart: 401, responseStart: 1201, nextHopProtocol: "h3" }),
    { dns: 4, tcp: 391, tls: 200, req: 800, proto: "h3" });
  // A reused connection: no lookup, no connect, only the request.
  assert.deepEqual(netTiming({ domainLookupStart: 0, domainLookupEnd: 0, connectStart: 0, connectEnd: 0, secureConnectionStart: 0, requestStart: 3, responseStart: 700, nextHopProtocol: "h2" }), { req: 697, proto: "h2" });
  assert.deepEqual(netTiming(null), {});
});

test("SPEED-3: a load's own styles and scripts: over the network or from cache, and when the last arrived", async () => {
  const { assetLoad } = await import("./telemetry.mjs");
  const r = (name, transferSize, decodedBodySize, startTime, responseEnd) => ({ name, transferSize, decodedBodySize, startTime, responseEnd });
  const entries = [
    r("https://app.example/_next/static/chunks/a1.css", 20480, 120000, 30, 900),
    r("https://app.example/_next/static/chunks/b2.css", 0, 90000, 31, 120),           // from the browser's cache
    r("https://app.example/_next/static/chunks/c3.js", 102400, 400000, 40, 2100),
    r("https://app.example/_next/static/chunks/d4.js?dpl=x", 0, 50000, 41, 300),
    r("https://app.example/_next/static/chunks/late.js", 51200, 9000, 9000, 9500),   // started after the load ended
    r("https://app.example/api/v0/me", 800, 2000, 50, 400),                             // not an asset
    r("https://app.example/photo/abc.css-not", 100, 100, 10, 20),
    null, { name: 42 },
  ];
  assert.deepEqual(assetLoad(entries, 5000), { css: 20, cssN: 2, cssC: 1, cssT: 900, js: 100, jsN: 2, jsC: 1, jsT: 2100 });
  assert.deepEqual(assetLoad(entries).jsN, 3);
  assert.deepEqual(assetLoad([r("https://app.example/x.png", 1, 1, 1, 1)]), {});
  assert.deepEqual(assetLoad(null), {});
  // Never more than 8 keys, all numbers (the API keeps at most 16 per row, numbers as they are).
  const out = assetLoad(entries, 5000);
  assert.ok(Object.keys(out).length <= 8 && Object.values(out).every((v) => Number.isFinite(v)));
});

test('a live stream closed by its own page leaving is not a drop (FIX-LIVE, BC-083)', () => {
  // The page never started leaving: a stream that closed is a drop.
  assert.equal(streamDropped(5000, 0), true);
  // Production: the stream closed 2 ms before the page's own app.background (a reload): not a drop.
  assert.equal(streamDropped(5000, 5002), false);
  // The page was hidden half a second before the stream closed (the tab closing): not a drop.
  assert.equal(streamDropped(5000, 4500), false);
  // Hidden long ago and back again: a later close is a drop.
  assert.equal(streamDropped(65000, 5000), true);
  // The check waits long enough for hide() to have run after a leaving page's stream closed.
  assert.ok(STREAM_GRACE_MS >= 1000 && STREAM_GRACE_MS <= 5000);
  // TEAM-TELEMETRY: a reload whose next page takes 3 s to answer: the stream closed at the start, the page hid 3 s
  // later, before the check ran; not a drop (the 1.5 s check had already counted it).
  assert.ok(STREAM_GRACE_MS > 3000);
  assert.equal(streamDropped(5000, 8000), false);
});
