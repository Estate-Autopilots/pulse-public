// DOCS-POLISH (owner, 14 Nov 2026): the reading view and "Make this doc richer" end to end on a disposable synthetic company
// (tests/core/test_docs_polish_walk.py). Always (the API, under row security): a Markdown report imported the way the Docs
// page imports it; the upgrades offered (chart, big numbers, timeline, flow diagram, toggle, Indian amounts; the words-only
// table kept); a colleague who cannot see the doc gets nothing; applying is its own History version ("enrich") that one
// Restore undoes; a stale look answers 409; a second look offers nothing; the empty doc's templates.
// With PULSE_AUTH_BROWSER=1, a real browser: the plain import at 1440 light and 363 dark (before), "This doc can look
// better" → the sheet → Apply (after), the Document outline, the PDF (File → Download), an empty doc's templates and the "+" block menu, no page
// errors (the old hydration mismatch on "last changed" included) and no sideways scroll. Screenshots go to
// DOCS_POLISH_SHOTS. Every name and number is synthetic.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { blocksOf } from '../../../apps/web/app/lib/doc-rich.mjs';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER_EMAIL;
const shots = process.env.DOCS_POLISH_SHOTS || join(tmpdir(), 'docs-polish-shots');
let apiChecks = 0, browserChecks = 0;
const consoleErrors = []; // other console errors, reported (the walk's evidence)
const as = (who) => ({ 'cf-access-authenticated-user-email': who });
const raw = async (path, who, method = 'GET', body) => app.inject({ url: '/api/v0/' + path, method, headers: as(who), ...(body === undefined ? {} : { payload: body }) });
const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await raw(path, who, method, body);
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body.slice(0, 400)}`);
  return r.json();
};

const method = Array.from({ length: 26 }, (_, i) => `Visit ${i + 1} was logged by the field team with its site, time and the person met.`).join(' ');
const REPORT = (title) => `---
title: ${title}
tags: [report, field]
category: Report
---
# ${title}

Our field team visited more sites this quarter, and bookings followed the faster follow-ups.

## Key numbers

- Site visits: 1,248 (up from 1,114)
- Bookings: ₹4.2 Cr
- Conversion: 6.8%

## Visits by city

| City | Site visits | Bookings (₹) |
| --- | --- | --- |
| Mumbai | 420 | 14000000 |
| Pune | 336 | 11200000 |
| Bengaluru | 288 | 9600000 |
| Ahmedabad | 204 | 7200000 |
| Total | 1,248 | 42000000 |

> **Tip:** Share visit notes on the same day to keep follow-ups moving.

## Rollout

- Week 1: Train the new field staff
- Week 2: Start same-day notes in Pune
- Week 4: All four cities on same-day notes
- Week 8: Review bookings with the leads

## How it works

1. The visitor scans the site code
2. The field kit logs the visit
3. The manager sees it the same day

## Vendors compared

| Vendor | Support | Warranty |
| --- | --- | --- |
| Lotus Supplies | Phone and site visit | One year |
| Harbor Tech | Phone only | Two years |

> Clear notes help every team take the next step. (Diya Nair, synthetic)

\`\`\`json
{ "quarter": "Q3", "visits": 1248, "team": "Field (synthetic)" }
\`\`\`

## Method

${method}
`;

let browser, web;
try {
  // ---- API --------------------------------------------------------------------------------------------------------
  const importOne = async (title) => {
    const r = await call('docs/import-tree', ADMIN, 'POST', { folderId: null, items: [{ path: `${title}.md`, data: Buffer.from(REPORT(title)).toString('base64') }], replace: true, access: 'private' });
    assert.equal(r.created + r.updated, 1, JSON.stringify(r)); apiChecks++;
    const list = (await call(`docs?q=${encodeURIComponent(title)}`, ADMIN)).docs;
    const found = list.find((d) => d.title === title); assert.ok(found, `imported ${title}`); apiChecks++;
    return found.id;
  };
  const id = await importOne('Q3 field visits report (synthetic)');
  const plain = (await call(`docs/${id}`, ADMIN)).doc;
  assert.equal(blocksOf(plain.html).length, 0, 'an import arrives as plain words'); apiChecks++;
  const look = await call(`docs/${id}/richer`, ADMIN);
  const kinds = look.suggestions.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ['chart', 'diagram', 'numbers', 'stat', 'stat', 'timeline', 'toggle'], JSON.stringify(look.suggestions.map((s) => s.title))); apiChecks++;
  assert.equal(look.kept.tables, 1, 'the vendors table (words) stays a table'); apiChecks++;
  const chart = look.suggestions.find((s) => s.kind === 'chart');
  assert.deepEqual(chart.block.rows, [['Mumbai', 14000000], ['Pune', 11200000], ['Bengaluru', 9600000], ['Ahmedabad', 7200000]], 'money column, total row left out'); apiChecks++;
  assert.equal((await raw(`docs/${id}/richer`, MEMBER)).statusCode, 404, 'a colleague cannot see a private doc, nor its upgrades'); apiChecks++;
  assert.equal((await raw(`docs/${id}/richer`, MEMBER, 'POST', { apply: 'all' })).statusCode, 404); apiChecks++;
  assert.equal((await raw(`docs/${id}/richer`, ADMIN, 'POST', { apply: [chart.id], baseVersion: look.version - 1 })).statusCode, 409, 'a stale look'); apiChecks++;
  assert.equal((await raw(`docs/${id}/richer`, ADMIN, 'POST', { apply: ['chart_000000000000'], baseVersion: look.version })).statusCode, 409, 'an id the doc no longer has'); apiChecks++;
  const done = await call(`docs/${id}/richer`, ADMIN, 'POST', { apply: look.suggestions.map((s) => s.id), baseVersion: look.version });
  assert.equal(done.applied.length, 7); assert.equal(done.version, look.version + 1); apiChecks++;
  assert.deepEqual(blocksOf(done.html).map((b) => b.kind), ['stat', 'stat', 'chart', 'timeline', 'diagram']); apiChecks++;
  assert.match(done.html, /<td>(<p>)?1,40,00,000/); assert.match(done.html, /<summary>Method<\/summary>/); apiChecks++;
  assert.match(plain.html, /<div data-type="callout" data-tone="tip"><p>Share visit notes/, 'a **Tip:** quote imports as a callout'); apiChecks++;
  const versions = (await call(`docs/${id}/versions`, ADMIN)).versions;
  assert.equal(versions[0].reason, 'enrich', 'its own History version'); assert.equal(versions[1].id, done.undo, 'undo is the version before'); apiChecks++;
  assert.equal((await call(`docs/${id}/richer`, ADMIN)).suggestions.length, 0, 'nothing more to offer'); apiChecks++;
  await call(`docs/${id}/versions/${done.undo}/restore`, ADMIN, 'POST');
  assert.equal(blocksOf((await call(`docs/${id}`, ADMIN)).doc.html).length, 0, 'one Restore undoes it'); apiChecks++;
  const tpl = await call('docs/templates/analysis', MEMBER);
  assert.equal(tpl.title, 'Analysis'); assert.deepEqual(blocksOf(tpl.html).map((b) => b.kind), ['stat', 'chart']); apiChecks++;
  assert.equal((await raw('docs/templates/nope', MEMBER)).statusCode, 404); apiChecks++;

  // ---- Browser ----------------------------------------------------------------------------------------------------
  if (process.env.PULSE_AUTH_BROWSER === '1') {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    const devLog = openSync(join(tmpdir(), 'docs-polish-next-dev.log'), 'w');
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: ['ignore', devLog, devLog],
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-docs-polish', PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_TELEMETRY: '0' } });
    for (const until = Date.now() + 600_000; ;) {
      try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(60_000) })).status < 500) break; } catch { /* starting */ }
      if (Date.now() > until) throw Error('web did not start'); await delay(1000);
    }
    browser = await chromium.launch({ headless: true });
    const shot = async (p, name, full = false) => { await delay(600); await p.screenshot({ path: join(shots, name), fullPage: full }); };
    // a part of the doc at the top of the screen (its scroll margin keeps it below the stuck writing tools)
    const to = async (loc) => { await loc.first().evaluate((el) => el.scrollIntoView({ block: 'start' })); await delay(400); };
    // the shell's passing notices (checked where they matter) are hidden for the doc's own screenshots
    const calm = (p) => p.addStyleTag({ content: '[class*="island-module__"]{visibility:hidden !important}' });
    const open = async (width, theme) => {
      const c = await browser.newContext({ viewport: { width, height: width < 600 ? 800 : 1000 }, colorScheme: theme });
      await c.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue({ headers: { ...route.request().headers(), ...as(ADMIN) } }) : route.continue());
      await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* no storage */ } }, theme);
      const p = await c.newPage(), errors = [];
      p.on('pageerror', (e) => errors.push(String(e).slice(0, 240)));
      p.on('console', (m) => { if (m.type() !== 'error') return; if (/hydrat|did not match/i.test(m.text())) errors.push(`console: ${m.text().slice(0, 240)}`); else consoleErrors.push(`${width}: ${m.text().slice(0, 300)}`); });
      p.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
      return { c, p, errors };
    };
    const noSideways = async (p, tag) => { assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: no sideways scroll`); browserChecks++; };
    let step = 'start';
    const failShot = async (p, tag, e) => {
      appendFileSync(join(shots, 'walk-fail.txt'), `${new Date().toISOString()} ${tag} at ${step} after ${browserChecks} browser checks: ${String(e?.stack ?? e).slice(0, 3000)}\n`);
      await p?.screenshot({ path: join(shots, `fail-${tag}.png`), fullPage: true }).catch(() => undefined);
    };

    // 1. Import through the Docs page (New → Import), then the plain doc at 1440 light: before.
    const title = 'Q3 site visits report (synthetic)';
    let L = await open(1440, 'light');
    try {
      step = 'import'; await L.p.goto(`${base}/docs`, { timeout: 240000 });
      await L.p.locator('button[aria-haspopup="menu"]').filter({ hasText: /^New/ }).first().click({ timeout: 420000 });
      const [chooser] = await Promise.all([L.p.waitForEvent('filechooser'), L.p.getByRole('menuitem', { name: 'Import Word, Markdown or a zip' }).click()]);
      await chooser.setFiles({ name: `${title}.md`, mimeType: 'text/markdown', buffer: Buffer.from(REPORT(title)) });
      await L.p.getByText(title).first().click({ timeout: 240000 }); browserChecks++;
      step = 'before'; await L.p.waitForURL(/\/docs\/[0-9a-f-]{36}/, { timeout: 120000 });
      await expect(L.p.getByRole('textbox', { name: 'Title' })).toHaveValue(title, { timeout: 180000 }); browserChecks++;
      await expect(L.p.getByText(/\d+ min read/)).toBeVisible(); browserChecks++;
      // DOCS-GDOCS (14 Nov): the outline is Google Docs' "Document outline" rail beside the page on a computer.
      await expect(L.p.getByRole('navigation', { name: 'Document outline' })).toBeVisible(); browserChecks++;
      await noSideways(L.p, '1440 before');
      await calm(L.p); await shot(L.p, 'before-01-top-1440-light.png');
      await to(L.p.getByRole('heading', { name: 'Visits by city' })); await shot(L.p, 'before-02-table-1440-light.png');
      await L.p.evaluate(() => document.querySelector('[class*="island-module__"]') && document.querySelectorAll('style').forEach((x) => { if (x.textContent?.includes('island-module__')) x.remove(); }));
      await shot(L.p, 'before-00-full-1440-light.png', true);
    } catch (e) { await failShot(L.p, '1440-before', e); throw e; }
    const docUrl = L.p.url();

    // 2. The same plain doc on a phone, dark: before.
    let D = await open(363, 'dark');
    try {
      step = 'phone-before'; await D.p.goto(docUrl, { timeout: 240000 });
      // on a phone the outline opens in place from the doc at a glance's "Outline" chip (SHELL-FLOAT ef24f6abf)
      await expect(D.p.getByRole('button', { name: 'Outline', exact: true })).toBeVisible({ timeout: 180000 }); browserChecks++;
      await noSideways(D.p, '363 before');
      await calm(D.p); await shot(D.p, 'before-01-top-363-dark.png'); await shot(D.p, 'before-00-full-363-dark.png', true);
      await D.c.close();
    } catch (e) { await failShot(D.p, '363-before', e); throw e; }

    // 3. "This doc can look better" → the sheet → Apply, at 1440 light: after.
    try {
      step = 'offer'; await L.p.evaluate(() => window.scrollTo(0, 0));
      const offer = L.p.getByRole('status').filter({ hasText: 'This doc can look better' });
      await expect(offer).toBeVisible({ timeout: 60000 }); browserChecks++;
      await offer.getByRole('button', { name: /^See the/ }).click();
      const sheet = L.p.getByRole('dialog', { name: 'Make this doc richer' });
      await expect(sheet.getByText(/We found 7 upgrades/)).toBeVisible({ timeout: 60000 }); browserChecks++;
      await expect(sheet.locator('svg[role="img"]').first()).toBeVisible({ timeout: 60000 }); browserChecks++; // the chart's preview, drawn
      await shot(L.p, 'richer-01-sheet-1440-light.png');
      await sheet.getByRole('button', { name: /^Apply 7 changes$/ }).click();
      await expect(sheet).toBeHidden({ timeout: 60000 }); browserChecks++;
      await expect(L.p.getByText(/^Your doc is richer/).first()).toBeVisible({ timeout: 30000 }); browserChecks++;
      await expect(L.p.locator('[data-block-kind="chart"] svg[role="img"]').first()).toBeVisible({ timeout: 60000 }); browserChecks++;
      await expect(L.p.locator('[data-block-kind="stat"]').getByText('₹4.2 Cr')).toBeVisible(); browserChecks++;
      await expect(L.p.locator('[data-block-kind="timeline"]').getByText('Train the new field staff')).toBeVisible(); browserChecks++;
      await expect(L.p.locator('[data-block-kind="diagram"] svg').first()).toBeVisible({ timeout: 60000 }); browserChecks++;
      await expect(L.p.locator('td[data-num]').first()).toBeVisible(); await expect(L.p.locator('tr[data-total]').first()).toBeVisible(); browserChecks++;
      step = 'after'; await calm(L.p); await to(L.p.locator('header').filter({ has: L.p.getByRole('textbox', { name: 'Title' }) })); await delay(400);
      await shot(L.p, 'after-01-top-1440-light.png');
      await to(L.p.getByRole('heading', { name: 'Visits by city' })); await shot(L.p, 'after-02-chart-table-1440-light.png');
      await to(L.p.getByRole('heading', { name: 'Rollout' })); await shot(L.p, 'after-03-timeline-1440-light.png');
      await L.p.getByRole('navigation', { name: 'Document outline' }).getByRole('button', { name: 'Vendors compared' }).click();
      await expect(L.p.getByRole('navigation', { name: 'Document outline' }).getByRole('button', { name: 'Vendors compared' })).toHaveAttribute('aria-current', 'location', { timeout: 10000 }); browserChecks++;
      await shot(L.p, 'after-04-outline-1440-light.png');
      await shot(L.p, 'after-00-full-1440-light.png', true);
      await noSideways(L.p, '1440 after');
      // History shows it as its own version
      await L.p.getByRole('button', { name: 'Version history', exact: true }).click();
      await expect(L.p.getByText('Made richer').first()).toBeVisible({ timeout: 30000 }); browserChecks++;
      await L.p.getByRole('button', { name: 'Version history', exact: true }).click();
      // 4. The PDF: the print page the browser saves (cover, numbers right-aligned, the chart as SVG).
      step = 'pdf';
      // DOCS-GDOCS: File → Download → PDF document (.pdf), as in Google Docs.
      await L.p.getByRole('navigation', { name: 'Doc menu' }).getByRole('button', { name: 'File', exact: true }).click();
      await L.p.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'Download' }).click();
      const [pop] = await Promise.all([L.p.waitForEvent('popup', { timeout: 30000 }), L.p.getByRole('menuitem', { name: 'PDF document (.pdf)' }).click()]);
      await pop.waitForLoadState(); await expect(pop.locator('header.cover h1')).toHaveText(title); browserChecks++;
      await expect(pop.locator('td[data-num]').first()).toBeVisible(); await expect(pop.locator('.pulse-print-block svg').first()).toBeVisible(); browserChecks++;
      await pop.setViewportSize({ width: 820, height: 1100 }); await shot(pop, 'pdf-01-print-page.png', true);
      await pop.emulateMedia({ media: 'print' }); await pop.pdf({ path: join(shots, 'docs-polish-export.pdf'), format: 'A4', printBackground: true }); browserChecks++;
      await pop.close();
      assert.deepEqual(L.errors, [], '1440: no page errors, hydration mismatches or browser dialogs'); browserChecks++;
    } catch (e) { await failShot(L.p, '1440-after', e); throw e; }

    // 5. The rich doc on a phone, dark: after.
    D = await open(363, 'dark');
    try {
      step = 'phone-after'; await D.p.goto(docUrl, { timeout: 240000 });
      await expect(D.p.locator('[data-block-kind="stat"]').first()).toBeVisible({ timeout: 180000 }); browserChecks++;
      await calm(D.p);
      await noSideways(D.p, '363 after');
      await shot(D.p, 'after-01-top-363-dark.png');
      await D.p.getByRole('button', { name: 'Outline', exact: true }).click();
      await expect(D.p.getByRole('navigation', { name: 'Document outline' }).getByRole('button', { name: 'Vendors compared' })).toBeVisible(); browserChecks++;
      await shot(D.p, 'after-02-outline-363-dark.png');
      await D.p.getByRole('button', { name: 'Outline', exact: true }).click();
      await to(D.p.locator('tr[data-total]')); await shot(D.p, 'after-03-chart-table-363-dark.png');
      await to(D.p.getByRole('heading', { name: 'Vendors compared' })); await shot(D.p, 'after-04-code-quote-363-dark.png');
      await shot(D.p, 'after-00-full-363-dark.png', true);
      assert.deepEqual(D.errors, [], '363: no page errors or hydration mismatches'); browserChecks++;
      await D.c.close();
    } catch (e) { await failShot(D.p, '363-after', e); throw e; }

    // 6. An empty doc: templates, and the "+" beside the empty line opening the block menu.
    try {
      step = 'empty';
      const blank = (await call('docs', ADMIN, 'POST', { title: 'Untitled' })).doc;
      await L.p.goto(`${base}/docs/${blank.id}`, { timeout: 240000 });
      const starts = L.p.getByRole('region', { name: 'Start with a template' });
      await expect(starts).toBeVisible({ timeout: 180000 }); browserChecks++;
      const plus = L.p.getByRole('button', { name: /^Add a block/ });
      await expect(plus).toBeVisible({ timeout: 30000 }); browserChecks++;
      await plus.click();
      const menu = L.p.getByRole('listbox', { name: 'Add a block' });
      await expect(menu.getByRole('option', { name: /^Chart/ })).toBeVisible(); await expect(menu.getByRole('option', { name: /^Big numbers/ })).toBeVisible(); browserChecks++;
      await shot(L.p, 'empty-01-templates-menu-1440-light.png');
      await L.p.keyboard.press('Escape'); await L.p.keyboard.press('Backspace');
      await starts.getByRole('button', { name: /^Analysis with charts/ }).click();
      await expect(L.p.locator('[data-block-kind="chart"] svg[role="img"]').first()).toBeVisible({ timeout: 60000 }); browserChecks++;
      await expect(L.p.getByRole('textbox', { name: 'Title' })).toHaveValue('Analysis'); browserChecks++;
      await expect(L.p.getByText(/^Saved/).first()).toBeVisible({ timeout: 30000 }); browserChecks++;
      await shot(L.p, 'empty-02-analysis-1440-light.png');
      assert.deepEqual(L.errors, [], 'empty doc: no page errors'); browserChecks++;
      await L.c.close();
    } catch (e) { await failShot(L.p, '1440-empty', e); throw e; }
  }
  assert.deepEqual(consoleErrors, [], 'no console errors in the browser');
  writeFileSync(process.env.DOCS_POLISH_REPORT || join(tmpdir(), 'docs-polish.json'), JSON.stringify({ apiChecks, browserChecks, docId: id, consoleErrors }));
  console.log(`docs-polish: ${apiChecks} API checks, ${browserChecks} browser checks pass; other console errors: ${JSON.stringify(consoleErrors)}`);
  if (process.env.PULSE_AUTH_BROWSER === '1') writeFileSync(join(shots, 'console-errors.json'), JSON.stringify(consoleErrors, null, 1));
} finally {
  await browser?.close().catch(() => undefined);
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); await delay(3000); process.kill(-web.pid, 'SIGKILL'); } catch { /* gone */ } }
  if (web) { try { execFileSync('git', ['checkout', '--', 'tsconfig.json', 'next-env.d.ts'], { cwd: '../../apps/web', stdio: 'ignore' }); } catch { /* not a checkout */ } }
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
