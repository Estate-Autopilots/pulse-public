// FINANCE-TRUTH in the browser (tests/core/test_finance_truth.py::test_finance_numbers_in_the_browser): Finance →
// Numbers, the payment drawer's "What arrived" (the GST into the GST account) and My sales, through the real API and
// the web app at 1440 and 390 px, on a disposable synthetic tenant. NEXT_MODE=dev runs `next dev` instead of the built
// app. Optional screenshots: PULSE_FT_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_FT_SCREENSHOTS;
let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks++; };
const { chromium, expect: baseExpect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`, dev = process.env.NEXT_MODE === 'dev';
const expect = baseExpect.configure({ timeout: dev ? 90000 : 15000 });
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: dev ? 'development' : 'production', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next' }, stdio: 'ignore' });
let browser;
const T = dev ? 180000 : 60000;
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: T }); await page.waitForTimeout(300); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: T }); await ready(page); };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
// No horizontal page scroll at any width (the month table scrolls inside its own panel).
const fits = async (page, what) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}: no horizontal page scroll`);
try {
  for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('the web app did not start'); }
  browser = await chromium.launch({ headless: true });
  const context = async (role, width = 1440) => {
    const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
    c.on('page', (p) => { p.on('pageerror', (e) => console.error('PAGEERROR', p.url().replace(base, ''), e.message)); });
    return c;
  };

  // Leadership on a computer: the six numbers, GST apart, each with where it comes from.
  {
    const c = await context('founder'), p = await c.newPage();
    await go(p, '/finance?tab=numbers&period=fy');
    await expect(p.getByRole('link', { name: 'Numbers' })).toHaveAttribute('aria-current', 'true'); checks++;
    const tiles = p.getByRole('region', { name: 'Key numbers' });
    await expect(tiles.getByText('Revenue, net of GST')).toBeVisible(); checks++;
    await expect(tiles.getByText('₹3,00,000', { exact: true }).first()).toBeVisible(); checks++;   // the base paid in September, not the ₹3,54,000 billed
    await expect(tiles.getByText('GST still to receive')).toBeVisible(); checks++;
    await expect(tiles.getByText('₹63,000', { exact: true })).toBeVisible(); checks++;               // ₹54,000 + ₹9,000 of GST still to come
    await expect(p.getByText('Received into GST account')).toBeVisible(); checks++;
    await expect(p.getByRole('heading', { name: 'Where each number comes from' })).toBeVisible(); checks++;
    await expect(p.getByRole('table')).toContainText('Sep 2026'); checks++;
    await p.getByRole('button', { name: 'How it is worked out' }).first().click();
    await expect(p.getByRole('dialog')).toContainText('without the GST'); checks++;
    await p.keyboard.press('Escape');
    await fits(p, 'Numbers at 1440'); await shot(p, 'numbers-1440');
    // Overview opens on the same revenue (without GST) and leads to Numbers; there is one "Revenue" on Finance.
    await go(p, '/finance?tab=overview');
    const band = p.getByRole('region', { name: 'Finance numbers' });
    await expect(band.getByText('Revenue, net of GST')).toBeVisible(); checks++;
    // UX-FINANCE: Collected is a tile beside it and, in this fixture, the same ₹3,00,000; the figure is the revenue tile's own.
    const revenue = band.locator('div').filter({ has: p.getByText('Revenue, net of GST') }).last();
    await expect(revenue.getByText('₹3,00,000', { exact: true })).toBeVisible(); checks++;
    await expect(band.getByRole('link', { name: 'Open Numbers →' })).toHaveAttribute('href', /tab=numbers/); checks++;
    await shot(p, 'overview-1440');
    // The salesperson's row opens their numbers.
    await go(p, '/finance?tab=numbers&period=fy');
    await Promise.all([p.waitForURL(/\/sales\?/, { timeout: T }), p.getByRole('link', { name: /Synthetic Sales/ }).click()]); await ready(p);
    await expect(p.getByRole('heading', { name: 'Sales · Synthetic Sales' })).toBeVisible(); checks++;
    await expect(p.getByText(E.quoteNumber).first()).toBeVisible(); checks++;
    // Naming another GST account moves the GST received into it; naming it back restores it.
    await go(p, '/finance?tab=numbers&period=fy');
    await p.locator('label', { hasText: 'GST is paid into' }).locator('select').selectOption('Cash'); await p.getByRole('button', { name: 'Save' }).click();
    await expect(p.getByText('Received into Cash')).toBeVisible({ timeout: 20000 }); checks++;
    await p.locator('label', { hasText: 'GST is paid into' }).locator('select').selectOption(E.gst); await p.getByRole('button', { name: 'Save' }).click();
    await expect(p.getByText('Received into GST account')).toBeVisible({ timeout: 20000 }); checks++;
    // A period with nothing in it says so and leads somewhere.
    await go(p, '/finance?tab=numbers&period=lastfy');
    await expect(p.getByText('No invoices, payments or spending in this period')).toBeVisible(); checks++;
    await expect(p.getByRole('link', { name: 'Open Billing documents' })).toBeVisible(); checks++;
    await expect(p.getByText('Today, on issued invoices: ₹50,000 still to collect without GST, and GST ₹63,000 still to receive.')).toBeVisible(); checks++;
    await c.close();
  }

  // Finance records the GST of an invoice into the GST account from the payment drawer.
  {
    const c = await context('finance'), p = await c.newPage();
    await go(p, `/erp/documents/${E.invoice2}`);
    await p.getByRole('button', { name: 'Record payment' }).first().click();
    const drawer = p.getByRole('dialog');
    await drawer.getByText(`The GST, into ${E.gst}`).click();
    await expect(drawer.getByText('pays this invoice’s GST first').or(drawer.getByText("pays this invoice's GST first"))).toBeVisible(); checks++;
    await drawer.getByRole('button', { name: 'Record ₹9,000' }).click();
    await expect(p.getByText(`into ${E.gst} (GST account)`)).toBeVisible({ timeout: 20000 }); checks++;
    // A payment's account is corrected on the payment itself (one recorded before accounts were kept says none).
    const menu = () => p.getByRole('button', { name: 'Payment of ₹9,000: paid into, remove' });
    await menu().click(); await p.getByRole('menuitemradio', { name: 'HDFC current' }).click();
    await expect(p.getByLabel('Payments').getByText(/into HDFC current/)).toBeVisible({ timeout: 20000 }); checks++;
    await menu().click(); await p.getByRole('menuitemradio', { name: `${E.gst} (GST account)` }).click();
    await expect(p.getByText(`into ${E.gst} (GST account)`)).toBeVisible({ timeout: 20000 }); checks++;
    await go(p, '/finance?tab=numbers&period=fy');
    await expect(p.getByRole('region', { name: 'Key numbers' }).getByText('₹54,000', { exact: true })).toBeVisible(); checks++;   // only the first invoice's GST is still to come
    await c.close();
  }

  // The salesperson on a phone: their own quotations, invoices and collections, nothing wider than the screen.
  {
    const c = await context('sales', 390), p = await c.newPage();
    await go(p, '/sales?period=fy');
    await expect(p.getByRole('heading', { name: 'My sales' })).toBeVisible(); checks++;
    await expect(p.getByText(E.quoteNumber).first()).toBeVisible(); checks++;
    await expect(p.getByText(/GST ₹54,000 still to come/).first()).toBeVisible(); checks++;
    await fits(p, 'My sales at 390'); await shot(p, 'my-sales-390');
    await go(p, `/sales?person=${E.founder}`);
    await expect(p.getByText('Another person’s sales are for leadership and Finance')).toBeVisible(); checks++;
    await Promise.all([p.waitForURL(/\/sales$/, { timeout: T }), p.getByRole('link', { name: 'See my own' }).click()]); await ready(p);
    await expect(p.getByRole('heading', { name: 'My sales' })).toBeVisible(); checks++;
    await c.close();
  }

  // Leadership on a phone, and a member who may not see finance.
  {
    const c = await context('founder', 390), p = await c.newPage();
    await go(p, '/finance?tab=numbers&period=fy');
    await expect(p.getByText('GST still to receive')).toBeVisible(); checks++;
    await fits(p, 'Numbers at 390'); await shot(p, 'numbers-390');
    await c.close();
    const m = await context('member', 390), q = await m.newPage();
    await go(q, '/finance?tab=numbers');
    await expect(q.getByText('Finance access required')).toBeVisible(); checks++;
    await go(q, '/sales');
    await expect(q.getByText('No quotations in this period')).toBeVisible(); checks++;
    await m.close();
  }
  const receipt = JSON.stringify({ checks });
  await writeFile(process.env.TEST_REPORT, receipt); console.log(receipt);
} catch (e) {
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) console.error('PAGE', p.url().replace(base, ''), (await p.locator('main').innerText().catch(() => '')).slice(0, 1500));
  throw e;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
