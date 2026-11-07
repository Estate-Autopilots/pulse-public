// One staging synthetic draft, read-only browser, one cropped line-list screenshot. Never capture the app shell/catalogue.
import { chromium } from '../tests/e2e/node_modules/@playwright/test/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { environment, origin, port, out, session, document: id, sourceSha } = input;
assert.equal(environment, 'staging');
assert.equal(origin, 'https://pulse-staging.estateautopilots.com');
assert.equal(port, 4102);
assert.match(id, /^[0-9a-f-]{36}$/);
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'light' });
  try {
    let writes = 0, pageErrors = 0;
    await ctx.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) { writes++; await route.abort(); return; }
      if (url.origin !== origin || url.pathname === '/api/v0/chats/events') { await route.abort(); return; }
      try {
        const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`,
          headers: { ...request.headers(), host: new URL(origin).host }, maxRedirects: 0, maxRetries: 0, timeout: 30000 });
        await route.fulfill({ response });
      } catch { await route.abort().catch(() => {}); }
    });
    await ctx.addCookies([{ name: 'pulse_session', value: session, domain: new URL(origin).hostname,
      path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    await ctx.addInitScript(() => { localStorage.setItem('pulse.theme', 'light'); localStorage.setItem('pulse.notify.browser.asked', '1'); });
    const page = await ctx.newPage();
    page.on('pageerror', () => { pageErrors++; });
    const response = await page.goto(`${origin}/erp/documents/${id}`, { waitUntil: 'networkidle', timeout: 60000 });
    assert.equal(response.status(), 200);
    const facts = await page.evaluate(async id => {
      const read = async path => { const r = await fetch(path, { cache: 'no-store' }); if (!r.ok) throw Error('read failed'); return r.json(); };
      const [health, data] = await Promise.all([read('/healthz'), read(`/api/v0/erp/documents/${id}`)]);
      return { release: health.release, draft: data.document.status === 'draft',
        buyer: data.document.buyer.name === 'Release validation Billing party (synthetic)',
        lines: data.lines.map(l => ({ description: l.description, itemId: l.itemId, rate: l.rate, notNeeded: l.notNeeded })) };
    }, id);
    assert.equal(facts.release, sourceSha);
    assert.ok(facts.draft && facts.buyer);
    assert.deepEqual(facts.lines, ['Synthetic base', 'Synthetic add-on', 'Synthetic open charge'].map((description, i) =>
      ({ description, itemId: null, rate: [100000, 10000, 0][i], notNeeded: i === 2 })));
    const lines = page.getByRole('list', { name: 'Lines', exact: true });
    for (const line of facts.lines) await lines.getByText(line.description, { exact: true }).waitFor();
    assert.equal(await lines.getByRole('listitem').count(), 3);
    assert.equal(pageErrors, 0);
    assert.equal(writes, 0);
    const screenshot = 'staging-quote-lines-synthetic.png';
    await lines.screenshot({ path: `${out}/${screenshot}` });
    fs.chmodSync(`${out}/${screenshot}`, 0o600);
    process.stdout.write(JSON.stringify({ passed: true, screenshot }));
  } finally { await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close(); }
} finally { await browser.close(); }
