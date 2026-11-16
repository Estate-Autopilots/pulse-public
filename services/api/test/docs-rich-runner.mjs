// DOCS-RICH (owner, 9 Nov 2026): rich docs end to end on a disposable synthetic company (tests/core/test_docs_rich_walk.py).
// Always (the API, under row security): a doc written in Markdown with a chart, a diagram, big numbers, a toggle, columns
// and a web page sent inline; the page kept as the doc's file and served only sealed (its policy), to a colleague when the
// doc is the company's and to nobody else when it is private; "Turn into doc blocks" on an analysis page; a colleague's
// change kept as a version and what changed in the chart told block by block; Markdown export keeping the layout.
// With PULSE_AUTH_BROWSER=1 the doc in a real browser at 1440 (light) and 363 (dark): the chart, the Mermaid timeline,
// the sealed page (its chart drawn by Chart.js from the CDN), big numbers, columns; the Insert menu, the chart editor and
// "Add a web page" turning a page into blocks. Screenshots go to DOCS_RICH_SHOTS. Every name and number is synthetic.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { FRAME_CSP } from '../dist/doc-rich.js';
import { blockChanges, blocksOf } from '../../../apps/web/app/lib/doc-rich.mjs';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER_EMAIL;
const shots = process.env.DOCS_RICH_SHOTS || join(tmpdir(), 'docs-rich-shots');
let apiChecks = 0, browserChecks = 0;
const cdn = {};
const as = (who) => ({ 'cf-access-authenticated-user-email': who });
const raw = async (path, who, method = 'GET', body) => app.inject({ url: '/api/v0/' + path, method, headers: as(who), ...(body === undefined ? {} : { payload: body }) });
const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await raw(path, who, method, body);
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body.slice(0, 400)}`);
  return r.json();
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pipeline analysis (synthetic)</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:16px;color:#1f1d2b}.kpis{display:flex;gap:10px}.kpi{border:1px solid #ddd;border-radius:10px;padding:10px 14px}
.v{font-size:24px;font-weight:700}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style></head><body>
<h1>Pipeline analysis</h1><p>Synthetic numbers for a made-up agency, October.</p>
<div class="kpis"><div class="kpi"><div class="v">₹42.6 L</div><div>Pipeline</div><div>+12% vs Sep</div></div><div class="kpi"><div class="v">28%</div><div>Win rate</div><div>+4 pp vs Sep</div></div></div>
<h2>Pipeline by stage</h2><div style="max-width:560px"><canvas id="stage"></canvas></div>
<h2>Deals</h2><table><tr><th>Stage</th><th>Deals</th></tr><tr><td>Lead</td><td>41</td></tr><tr><td>Proposal</td><td>12</td></tr></table>
<button onclick="document.getElementById('more').hidden=false">Show more</button><p id="more" hidden>Hidden detail (synthetic).</p>
<script>new Chart(document.getElementById('stage'), { type: 'bar', data: { labels: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed'],
  datasets: [{ label: 'Pipeline (₹ lakh)', data: [8.2, 6.4, 3.8, 2.9, 2.1], backgroundColor: '#5b45d6' }] }, options: { plugins: { title: { display: true, text: 'Pipeline by stage (₹ lakh)' } } } });</script>
</body></html>`;
const fence = (b) => '```pulse-block\n' + JSON.stringify(b) + '\n```';
const MD = ['# October sales review (synthetic)', 'A steady month, with stronger margins.',
  fence({ kind: 'stat', items: [{ value: '₹42.6 L', label: 'Revenue', delta: '+12% vs Sep', tone: 'good' }, { value: '318', label: 'Leads', delta: '-4% vs Sep', tone: 'bad' }, { value: '9.4%', label: 'Win rate' }] }),
  '> **Info:** Pune is now our best city.',
  fence({ kind: 'chart', id: 'b_revcost01', type: 'line', title: 'Revenue vs cost', unit: '₹ lakh', columns: ['Month', 'Revenue', 'Cost'],
    rows: [['Jan', 2.4, 1.8], ['Feb', 2.7, 1.9], ['Mar', 2.6, 2], ['Apr', 3.1, 2.2], ['May', 3.3, 2.3], ['Jun', 3.5, 2.4], ['Jul', 3.7, 2.5], ['Aug', 3.8, 2.6], ['Sep', 3.8, 2.8], ['Oct', 4.2, 2.9]] }),
  '<div data-type="columns" data-count="2">\n<div data-type="column">\n\n' + fence({ kind: 'chart', id: 'b_leadscity1', type: 'bar', title: 'Leads by city', columns: ['City', 'Leads'],
    rows: [['Pune', 96], ['Mumbai', 78], ['Delhi', 62], ['Jaipur', 46], ['Kochi', 36]] }) + '\n\n</div>\n<div data-type="column">\n\n## What changed\n\n- Pune leads on qualified enquiries\n- Mumbai steady\n- Faster follow-ups next month\n\n</div>\n</div>',
  fence({ kind: 'diagram', id: 'b_launch001', title: 'Launch plan', code: 'timeline\n  title Launch plan\n  04 Nov : Prepare\n  11 Nov : Pilot in Pune\n  18 Nov : Launch\n  25 Nov : Review' }),
  fence({ kind: 'html', id: 'b_pagepipe1', title: 'Pipeline analysis', source: PAGE }),
  '<details data-type="toggle">\n<summary>Method and data sources</summary><div data-type="toggle-content">\n\nCRM export, 1–31 October (synthetic).\n\n</div></details>',
].join('\n\n');

let browser, web;
try {
  // ---- API --------------------------------------------------------------------------------------------------------
  const made = (await call('docs', ADMIN, 'POST', { title: 'October sales review (synthetic)', access: 'company', markdown: MD })).doc;
  const blocks = blocksOf(made.html);
  assert.deepEqual(blocks.map((b) => b.kind), ['stat', 'chart', 'chart', 'diagram', 'html'], made.html.slice(0, 300)); apiChecks++;
  assert.match(made.html, /<div data-type="columns" data-count="2">\s*<div data-type="column">/); assert.match(made.html, /<details data-type="toggle">\s*<summary>Method and data sources<\/summary>/); apiChecks++;
  const page = blocks.find((b) => b.kind === 'html');
  assert.match(page.fileId, /^[0-9a-f-]{36}$/); assert.ok(!made.html.includes('Pipeline by stage'), 'the page is a file, not part of the body'); apiChecks++;
  const frame = await raw(`docs/frames/${page.fileId}`, ADMIN); apiChecks++;
  assert.equal(frame.statusCode, 200); assert.match(frame.headers['content-type'], /^text\/html/); assert.equal(frame.headers['content-security-policy'], FRAME_CSP);
  assert.match(frame.body, /^<!doctype html><html><head><script>\(function\(\)\{var l=-1;/); assert.match(frame.body, /<h1>Pipeline analysis<\/h1>/);
  const source = await raw(`docs/frames/${page.fileId}?source=1`, ADMIN); apiChecks++;
  assert.equal(source.body, PAGE); assert.match(source.headers['content-type'], /^text\/plain/); assert.match(source.headers['content-security-policy'], /sandbox/);
  assert.equal((await raw(`docs/frames/${page.fileId}`, MEMBER)).statusCode, 200, 'a colleague sees the page of a company doc'); apiChecks++;
  const secret = (await call('docs', ADMIN, 'POST', { title: 'Private analysis (synthetic)', markdown: fence({ kind: 'html', title: 'Private page', source: '<!doctype html><p>Only mine</p>' }) })).doc;
  const secretPage = blocksOf(secret.html)[0].fileId;
  assert.equal((await raw(`docs/frames/${secretPage}`, MEMBER)).statusCode, 404, 'a private doc\'s page is nobody else\'s'); apiChecks++;
  assert.equal((await raw(`docs/frames/${secretPage}`, ADMIN)).statusCode, 200); apiChecks++;
  assert.equal((await raw('docs/frames/not-a-file', ADMIN)).statusCode, 404); apiChecks++;
  // Turn into doc blocks
  const conv = await call('docs/convert-html', MEMBER, 'POST', { html: PAGE });
  assert.equal(conv.title, 'Pipeline analysis (synthetic)'); assert.equal(conv.found.charts, 1); assert.equal(conv.found.numbers, 1); assert.equal(conv.found.tables, 1); apiChecks++;
  const convChart = blocksOf(conv.html).find((b) => b.kind === 'chart');
  assert.deepEqual([convChart.title, convChart.rows[0]], ['Pipeline by stage (₹ lakh)', ['Lead', 8.2]]); apiChecks++;
  assert.ok(!/<script|onclick|<button/.test(conv.html)); apiChecks++;
  assert.equal((await call('docs/convert-html', ADMIN, 'POST', { fileId: page.fileId })).found.charts, 1); apiChecks++;
  assert.equal((await raw('docs/convert-html', ADMIN, 'POST', {})).statusCode, 400); apiChecks++;
  // a colleague changes the chart: a new version, and what changed is told block by block
  const now = await call(`docs/${made.id}`, MEMBER);
  const edited = now.doc.html.replace(/(data-id="b_revcost01" data-block=")([^"]*)"/, (_m, pre, attr) => {
    const b = JSON.parse(attr.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    b.type = 'area'; b.rows = [...b.rows, ['Nov', 4.5, 3]];
    return `${pre}${JSON.stringify(b).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  });
  assert.notEqual(edited, now.doc.html);
  await call(`docs/${made.id}`, MEMBER, 'POST', { html: edited, baseVersion: now.doc.version });
  const versions = (await call(`docs/${made.id}/versions`, ADMIN)).versions;
  assert.ok(versions.length >= 2, `versions: ${versions.length}`); apiChecks++;
  const first = (await call(`docs/${made.id}/versions/${versions[versions.length - 1].id}`, ADMIN)).version;
  const latest = (await call(`docs/${made.id}`, ADMIN)).doc;
  const changes = blockChanges(first.html, latest.html).map((c) => c.text);
  assert.ok(changes.some((c) => /^Chart “Revenue vs cost”: type line → area; 1 row added$/.test(c)), changes.join(' | ')); apiChecks++;
  const md = (await call(`docs/${made.id}?format=markdown`, ADMIN)).markdown;
  assert.match(md, /```pulse-block\n\{"kind":"chart","id":"b_revcost01","type":"area"/); assert.match(md, /<details data-type="toggle">/); assert.match(md, /<div data-type="columns" data-count="2">/); apiChecks++;
  const hostile = (await call('docs', ADMIN, 'POST', { title: 'Hostile (synthetic)', html: '<p>x</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><div data-type="pulse-block" data-block=\'{"kind":"html","fileId":"x","source":"<script>"}\'></div>' })).doc;
  assert.ok(!/<script|<iframe|evil\.example/.test(hostile.html), hostile.html); apiChecks++;

  // ---- Browser ----------------------------------------------------------------------------------------------------
  if (process.env.PULSE_AUTH_BROWSER === '1') {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    const devLog = openSync(join(tmpdir(), 'docs-rich-next-dev.log'), 'w'); // what next dev said, for a walk that fails
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: ['ignore', devLog, devLog],
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-docs-rich', PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_TELEMETRY: '0' } });
    // next dev compiles its first page on demand: up to 10 minutes on a busy server, each try answering within 60 s
    for (const until = Date.now() + 600_000; ;) {
      try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(60_000) })).status < 500) break; } catch { /* starting */ }
      if (Date.now() > until) throw Error('web did not start'); await delay(1000);
    }
    browser = await chromium.launch({ headless: true });
    const shot = async (pg2, name, full = false) => { await delay(500); await pg2.screenshot({ path: join(shots, name), fullPage: full }); };
    for (const [width, theme] of [[1440, 'light'], [363, 'dark']]) {
      const tag = `${width}-${theme}`, phone = width < 600;
      let p = null;
      try {
      const c = await browser.newContext({ viewport: { width, height: phone ? 800 : 1000 }, colorScheme: theme });
      // the signed-in person's header goes to the local app only (the page's own CDN request carries nothing of ours)
      await c.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue({ headers: { ...route.request().headers(), ...as(ADMIN) } }) : route.continue());
      // init scripts also run inside the sealed page, where storage is (rightly) refused
      await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* the sealed frame */ } }, theme);
      p = await c.newPage();
      const errors = [];
      // Not counted: the sealed page's own CDN being unreachable here, and the doc page's "last changed …" time, which
      // DOCS-WORKBENCH renders with the server's locale on the server and the browser's in the browser (a hydration
      // mismatch that predates this lane: doc-view.tsx `when(doc.updatedAt)`).
      p.on('pageerror', (e) => { if (!/Chart is not defined|Hydration failed because the server rendered text didn't match/.test(String(e))) errors.push(String(e).slice(0, 200)); });
      p.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
      const frameResp = p.waitForResponse((r) => r.url().includes('/api/v0/docs/frames/'), { timeout: 240000 });
      await p.goto(`${base}/docs/${made.id}`, { timeout: 240000 });
      await expect(p.locator('[data-block-kind="chart"] svg[role="img"]').first()).toBeVisible({ timeout: 180000 }); browserChecks++;
      await p.locator('[data-block-kind="html"]').scrollIntoViewIfNeeded(); // the frame loads when it comes near the screen
      const fr = await frameResp;
      assert.equal(fr.headers()['content-security-policy'], FRAME_CSP, 'the page answers with its own sealed policy through the web proxy'); browserChecks++;
      await expect(p.locator('[data-block-kind="diagram"] svg').first()).toBeVisible({ timeout: 60000 }); browserChecks++;
      await expect(p.locator('[data-block-kind="stat"]').getByText('₹42.6 L').first()).toBeVisible(); browserChecks++;
      const iframe = p.locator('[data-block-kind="html"] iframe');
      assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts'); browserChecks++;
      await expect.poll(async () => (await iframe.boundingBox())?.height ?? 0, { timeout: 60000 }).toBeGreaterThan(500); browserChecks++; // the page told its height
      await expect(p.frameLocator('[data-block-kind="html"] iframe').getByRole('heading', { name: 'Pipeline analysis' })).toBeVisible(); browserChecks++;
      const inner = p.frames().find((f) => f.url().includes('/api/v0/docs/frames/'));
      cdn[tag] = inner ? await inner.evaluate(() => typeof window.Chart === 'function').catch(() => 'unknown') : 'no frame'; // Chart.js from the allowed CDN
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: no sideways scroll`); browserChecks++;
      await shot(p, `01-doc-${tag}.png`);
      await p.locator('[data-block-kind="chart"]').first().scrollIntoViewIfNeeded(); await shot(p, `02-charts-${tag}.png`);
      await p.locator('[data-block-kind="diagram"]').scrollIntoViewIfNeeded(); await shot(p, `03-timeline-${tag}.png`);
      await p.locator('[data-block-kind="html"]').scrollIntoViewIfNeeded(); await shot(p, `04-page-${tag}.png`);
      await shot(p, `00-doc-full-${tag}.png`, true);
      // "Show the numbers": the chart's table
      const revenue = p.locator('[data-block-kind="chart"]').filter({ hasText: 'Revenue vs cost' }).first();
      await revenue.getByRole('button', { name: 'Show the numbers' }).click();
      await expect(revenue.getByRole('cell', { name: '₹4.5 lakh' })).toBeVisible(); browserChecks++;
      if (!phone) {
        // Insert ▾ → Chart opens the chart's editor; then "Add a web page" turns a page into blocks
        await p.locator('.ProseMirror > p').first().click(); await p.keyboard.press('End');
        await p.getByRole('button', { name: 'Insert' }).click();
        await expect(p.getByRole('menu', { name: 'Insert' })).toBeVisible(); browserChecks++;
        await shot(p, `05-insert-menu-${tag}.png`);
        await p.getByRole('menuitem', { name: /Chart/ }).click();
        await expect(p.getByRole('radiogroup', { name: 'Chart type' }).last()).toBeVisible(); browserChecks++;
        await p.getByRole('radiogroup', { name: 'Chart type' }).last().getByRole('radio', { name: 'Bar' }).click();
        await p.getByPlaceholder('e.g. Revenue vs cost').fill('Cost by month (synthetic)'); // the chart editor's title (a diagram's label also says "title")
        await p.getByRole('radiogroup', { name: 'Chart type' }).last().scrollIntoViewIfNeeded();
        await shot(p, `06-chart-editor-${tag}.png`);
        await p.getByRole('button', { name: 'Done' }).last().click();
        await p.getByRole('button', { name: 'Insert' }).click();
        await p.getByRole('menuitem', { name: /Web page/ }).click();
        const dlg = p.getByRole('dialog', { name: 'Add a web page' });
        await expect(dlg).toBeVisible(); browserChecks++;
        await dlg.locator('input[type=file]').setInputFiles({ name: 'pipeline-analysis.html', mimeType: 'text/html', buffer: Buffer.from(PAGE) });
        await expect(dlg.getByText(/Found: \d+ headings?, 1 table, 1 chart/)).toBeVisible({ timeout: 30000 }); browserChecks++;
        await dlg.getByText('Turn into doc blocks').click();
        await shot(p, `07-add-page-${tag}.png`);
        await dlg.getByRole('button', { name: 'Add to doc' }).click();
        await expect(dlg).toBeHidden(); browserChecks++;
        await expect(p.locator('[data-block-kind="chart"]')).toHaveCount(4, { timeout: 30000 }); browserChecks++; // 2 + the new one + the page's
        await p.locator('[data-block-kind="chart"]').last().scrollIntoViewIfNeeded();
        await shot(p, `08-converted-${tag}.png`);
        await expect(p.getByText(/^Saved/)).toBeVisible({ timeout: 30000 }); browserChecks++;
      }
      assert.deepEqual(errors, [], `${tag}: no page errors or browser dialogs`); browserChecks++;
      await c.close();
      } catch (e) { // keep the evidence: the error, and the page as it was
        appendFileSync(join(tmpdir(), 'docs-rich-walk-fail.txt'), `${new Date().toISOString()} ${tag} after ${browserChecks} browser checks: ${String(e?.stack ?? e).slice(0, 3000)}\n`);
        await p?.screenshot({ path: join(shots, `fail-${tag}.png`), fullPage: true }).catch(() => undefined);
        throw e;
      }
    }
  }
  writeFileSync(process.env.DOCS_RICH_REPORT || join(tmpdir(), 'docs-rich.json'), JSON.stringify({ apiChecks, browserChecks, docId: made.id, cdn }));
  console.log(`docs-rich: ${apiChecks} API checks, ${browserChecks} browser checks pass; Chart.js from the CDN inside the page: ${JSON.stringify(cdn)}`);
} finally {
  await browser?.close().catch(() => undefined);
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); await delay(3000); process.kill(-web.pid, 'SIGKILL'); } catch { /* gone */ } }
  if (web) { try { execFileSync('git', ['checkout', '--', 'tsconfig.json', 'next-env.d.ts'], { cwd: '../../apps/web', stdio: 'ignore' }); } catch { /* not a checkout */ } }
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
