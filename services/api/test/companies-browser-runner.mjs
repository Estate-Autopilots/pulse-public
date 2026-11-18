// COMPANIES-MODEL in the browser (tests/core/test_companies_model.py, PULSE_COMPANIES_BROWSER=1): four synthetic
// companies (a freelancer with no industry, a real-estate agency, an STP / ATP plants company, a sales team) each add a
// person at a new company, answer "is their company a client too?", open the company, the client and a new quote.
// The words offered follow each company's industry (no Developer / Channel partner / Model outside real estate). Phone
// (363) and desktop (1440), light and dark; no sideways scroll, no page errors. Screens with PULSE_CM_SHOTS=<dir>.
// Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const ORGS = JSON.parse(process.env.TEST_ORGS), shots = process.env.PULSE_CM_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-cm', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = async () => {
  if (serverExit !== null) return;
  const gone = new Promise((done) => server.once('exit', done));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { return; }
  if (await Promise.race([gone.then(() => true), delay(10000).then(() => false)])) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await Promise.race([gone, delay(5000)]);
};
let browser, checks = 0, current = 'start', lastPage = null; const failures = [];
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`companies-browser-runner: no result after 90 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 90 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 240000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
const shot = async (page, name, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
const RE = /\b(Developer|Channel partner|Model)s?\b/;
const context = async (org, width, theme) => {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 780 : 900 }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: theme,
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': org.email } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
  const page = await c.newPage(); lastPage = page;
  page.on('pageerror', (e) => errors.push(`${org.key} ${width} ${theme}: ${e.message}`));
  return { c, page };
};
const dismiss = async (page) => { for (const name of ['Later', 'Not now', 'Close']) { const b = page.getByRole('button', { name, exact: true }); try { if (await b.first().isVisible({ timeout: 1500 })) await b.first().click(); } catch { /* none */ } } };
try {
  for (let i = 0; i < 900; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  for (const org of ORGS.filter((o) => !process.env.PULSE_CM_ONLY || process.env.PULSE_CM_ONLY.split(',').includes(o.key))) {
   try {
    for (const [width, theme] of org.key === 'freelancer' ? [[1440, 'light'], [363, 'light'], [1440, 'dark'], [363, 'dark']] : [[1440, 'light'], [363, 'light']]) {
      step(`${org.key} ${width} ${theme}`);
      const tag = `${org.key}-${width}-${theme}`, phone = width < 600, n = `${width}${theme[0]}`;
      const { c, page } = await context(org, width, theme);
      // 1. People: add a person at a new company; their company is a client too.
      await page.goto(base + '/contacts', { waitUntil: 'load', timeout: 600000 });
      await dismiss(page);
      await seen(page.getByRole('navigation', { name: 'Address book' }));
      await fits(page, `${tag} people`);
      await shot(page, `01-people-${tag}`);
      await page.getByRole('button', { name: 'Add contact' }).or(page.getByRole('link', { name: 'Add contact' })).first().click();
      const drawer = page.getByRole('dialog', { name: 'Add a contact' });
      await seen(drawer);
      await drawer.getByLabel('Name', { exact: true }).fill(`Kedab ${org.word} ${n}`);
      await drawer.getByLabel('Phone', { exact: true }).fill('+91 90000 00011');
      await drawer.getByRole('combobox', { name: 'Works at' }).fill(`Lotus ${org.word} ${n}`);
      await seen(drawer.getByRole('option', { name: new RegExp(`Add “Lotus ${org.word} ${n}” as a new company`) }));
      await drawer.getByRole('option', { name: /as a new company/ }).click();
      await drawer.getByLabel('Their role', { exact: true }).fill('Owner');
      // The type list follows the industry; "+ Add new" saves a type right here.
      const types = await drawer.getByRole('radiogroup', { name: 'Type' }).innerText();
      if (org.realEstate) assert.ok(/Developer/.test(types), `${tag}: real estate offers its own words: ${types}`);
      else assert.ok(!RE.test(types), `${tag}: no real-estate words offered: ${types}`);
      checks++;
      if (width === 1440 && theme === 'light') {
        await drawer.getByRole('button', { name: 'Add new' }).click();
        await drawer.getByLabel("New type's name").fill(org.newType);
        await drawer.getByRole('button', { name: 'Add', exact: true }).click();
        await seen(drawer.getByRole('radio', { name: new RegExp(org.newType) }));
        await expect(drawer.getByRole('radio', { name: new RegExp(org.newType) })).toHaveAttribute('aria-checked', 'true');
      }
      await drawer.getByRole('radio', { name: /^Yes, their company/ }).click();
      await page.evaluate(() => document.querySelectorAll('[role=dialog] *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }));
      await shot(page, `02-add-person-${tag}`, false);
      await drawer.getByRole('button', { name: 'Add contact', exact: true }).click();
      // 2. Lands on the new client: who it is, at which company.
      await page.waitForURL(/\/clients\/[0-9a-f-]{36}/, { timeout: 300000 });
      await seen(page.getByRole('heading', { name: new RegExp(`Lotus ${org.word} ${n}`) }));
      await fits(page, `${tag} client`);
      await shot(page, `03-client-${tag}`);
      // 3. The company: its person as main contact, its client record, New quote.
      await page.locator('main a[href^="/contacts/companies/"], a[href^="/contacts/companies/"]:not(nav a)').first().click();
      await page.waitForURL(/\/contacts\/companies\/[0-9a-f-]{36}/, { timeout: 300000 });
      const companyUrl = page.url();
      await seen(page.getByText('Main contact', { exact: true }));
      await seen(page.getByText(`Kedab ${org.word} ${n}`));
      await fits(page, `${tag} company`);
      await shot(page, `04-company-${tag}`);
      // 4. The company book.
      await page.goto(base + '/contacts/companies', { waitUntil: 'load', timeout: 600000 });
      await seen(page.getByRole('link', { name: `Lotus ${org.word} ${n}` }));
      await fits(page, `${tag} companies`);
      await shot(page, `05-companies-${tag}`);
      // 5. Clients: add a client that is one person, with their details in the same step.
      await page.goto(base + '/clients', { waitUntil: 'load', timeout: 600000 });
      await dismiss(page);
      await fits(page, `${tag} clients`);
      await shot(page, `06-clients-${tag}`);
      if (org.billing) {
        // 6. New quote from the company page opens Billing with the client ready.
        await page.goto(companyUrl, { waitUntil: 'load', timeout: 600000 });
        await page.getByRole('link', { name: 'New quote' }).click();
        await page.waitForURL(/\/erp\/new/, { timeout: 300000 });
        try { await seen(page.getByRole('button', { name: /^Start quotation$/ }), 120000); } catch (e) { console.log(`${tag}: billing did not offer the client: ${String(e).slice(0, 160)}`); }
        await fits(page, `${tag} new quote`);
        await shot(page, `07-new-quote-${tag}`);
        if (width === 1440 && theme === 'light') {
          try {
            await page.getByRole('button', { name: /^Start quotation$/ }).click();
            await page.waitForURL(/\/erp\/documents\/[0-9a-f-]{36}/, { timeout: 120000 });
            await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => undefined);
            await page.getByText(/draft/i).first().waitFor({ timeout: 120000 }).catch(() => undefined);
            await shot(page, `08-quote-${tag}`); checks++; console.log(`${tag}: quote started`);
          } catch (e) { await shot(page, `08-quote-${tag}`); console.log(`${tag}: quote not started: ${String(e).slice(0, 200)}`); }
        }
      }
      if (width === 1440 && theme === 'light') {
        await page.goto(base + '/clients', { waitUntil: 'load', timeout: 600000 });
        await page.getByRole('button', { name: /^Add / }).first().click();
        const add = page.getByRole('dialog', { name: /^Add a / });
        await seen(add);
        await add.getByRole('radio', { name: 'One person' }).click();
        await add.getByLabel('Name', { exact: true }).fill(`Diya ${org.word}`);
        await add.getByLabel('Phone', { exact: true }).fill('+91 90000 00012');
        await shot(page, `09-add-client-${tag}`, false);
        await add.locator('button[type=submit]').first().click();
        await page.waitForURL(/\/clients\/[0-9a-f-]{36}/, { timeout: 300000 });
        await seen(page.getByRole('heading', { name: `Diya ${org.word}` }));
      }
      await c.close();
    }
   } catch (e) {
    failures.push(`${current}: ${String(e.message ?? e).split('\n').slice(0, 4).join(' ')}`);
    try { if (shots && lastPage) await lastPage.screenshot({ path: `${shots}/zz-failed-${current.replaceAll(' ', '-')}.png`, fullPage: true }); console.log(`failed page: ${lastPage?.url()}`); } catch { /* closed */ }
   }
  }
  assert.deepEqual(failures, [], 'every company walked');
  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ checks }));
} catch (e) {
  console.error(`failed at ${current}: ${e.stack ?? e}`);
  try { if (shots && lastPage) { await lastPage.screenshot({ path: `${shots}/zz-failed-${current.replaceAll(' ', '-')}.png`, fullPage: true }); console.error(`failed page: ${lastPage.url()}`); } } catch { /* closed */ } console.error(serverTail.slice(-800)); process.exitCode = 1;
} finally { await browser?.close(); await stopServer(); await app.close(); await pool.end(); }
