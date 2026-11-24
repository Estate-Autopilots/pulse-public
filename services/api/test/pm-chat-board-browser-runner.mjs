// PM-BUILD-4 phase 3 in the browser (tests/core/test_pm_chat_board_browser.py): the step card under the viewer's own message in a
// project's group, My day's "From your chats" and the project page's "We need from the client", on a disposable synthetic
// agency (the real API, the web app under next dev). Phone 390, tablet 834, laptop 1440, light and dark; no sideways scroll, no page
// errors. Screenshots with PULSE_PC_SCREENSHOTS=<dir>. Preamble from pm-spec-browser-runner.mjs (PM-BUILD-3). Nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_PC_SCREENSHOTS, observe = process.env.OBSERVE === '1';
if (shots) mkdirSync(shots, { recursive: true });
const emails = { admin: 'admin@estateautopilots.com' };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-pc', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
// CI-GREEN-4: stop waits until next dev has gone (SIGKILL after 10 s); the 3 s kill timer was unref'd, so the runner could
// exit first and leave the server up, and Next 16 allows one next dev per app folder: an alone retry could not start one.
const stopServer = async () => {
  if (serverExit !== null) return;
  const gone = new Promise((done) => server.once('exit', done));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { return; }
  if (await Promise.race([gone.then(() => true), delay(10000).then(() => false)])) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await Promise.race([gone, delay(5000)]);
};
let browser, checks = 0, current = 'start', last;
const issues = [], facts = [];
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`pm-chat-board-browser-runner: no result after 28 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 28 * 60_000);
deadline.unref();
/** A check: in the before walk (OBSERVE=1) a failure is written down and the walk goes on; otherwise it fails. */
const check = (ok, what) => { checks++; if (ok) return true; if (observe) { issues.push(`${current}: ${what}`); console.log(`ISSUE ${current}: ${what}`); return false; } assert.fail(what); };
const fact = (s) => { facts.push(`${current}: ${s}`); console.log(`FACT ${current}: ${s}`); };
const seen = async (locator, what, timeout = 180000) => { try { await expect(locator.first()).toBeVisible({ timeout }); checks++; return true; } catch (e) { return check(false, `${what} is shown (${String(e.message).split('\n')[0].slice(0, 160)})`); } };
const errors = [];
async function fits(page, what) {
  const r = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth > innerWidth + 1, edge = [];
    for (const el of document.querySelectorAll('main a, main h1, main h2, main h3, main span, main small, main b, main p')) {
      const s = getComputedStyle(el); if (s.display === 'inline' || el.clientWidth < 4 || s.position === 'absolute' || s.position === 'fixed' || el.closest('[aria-hidden="true"]')) continue;
      let boxed = false; for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { if (getComputedStyle(a).overflowX !== 'visible') { boxed = true; break; } }
      const box = el.getBoundingClientRect(); if (box.width && box.right > innerWidth + 1 && !boxed) edge.push(el.textContent.trim().slice(0, 40));
    }
    return { wide, edge: edge.slice(0, 5) };
  });
  check(!r.wide, `${what} has no sideways scroll`);
  check(!r.edge.length, `${what}: nothing runs off the right edge (${r.edge.join(' | ')})`);
}
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600, tablet = width >= 600 && width < 1100;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : tablet ? 1112 : 900 }, deviceScaleFactor: 1, hasTouch: phone || tablet, isMobile: phone, colorScheme: theme,
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.browser.asked', '1'); } catch { /* none */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Download the React DevTools/.test(m.text())) { console.log(`console error on ${name}: ${m.text().slice(0, 300)}`); if (shots) appendFileSync(`${shots}/console.txt`, `${name}: ${m.text().slice(0, 4000)}\n`); } });
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = true) => {
  if (!shots) return;
  for (let i = 0; i < 2; i++) { try { await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full, caret: 'initial', timeout: 120000 }); return; } catch (e) { if (i) console.log(`no shot ${name}: ${e.message.split('\n')[0]}`); } }
};
const call = async (role, path, body) => {
  const r = await fetch(`${base}/api/v0/${path}`, { method: body ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': emails[role], ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); assert.ok(r.status < 300, `${path}: ${JSON.stringify(j)}`); return j;
};


const today = E.today, group = E.group, project = E.project;
const SIZES = [[390, 'light'], [834, 'light'], [1440, 'light'], [390, 'dark'], [834, 'dark'], [1440, 'dark']];
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  const mine = await call('admin', `step-cards?channel=${group}`);
  check(mine.cards.length === 1 && mine.cards[0].what === 'round' && mine.cards[0].candidates[0].code === 'M1', `one round card for M1 in the group (${JSON.stringify(mine.cards).slice(0, 200)})`);
  const all = await call('admin', 'step-cards');
  check(all.cards.some((c) => c.kind === 'backfill'), 'a back-fill card after M2 was finished');
  const asks = await call('admin', `projects/${project}/client-asks`);
  check(asks.items.length >= 1 && asks.draft && asks.draft.includes('Brief received'), `the client asks list and its draft (${JSON.stringify(asks).slice(0, 200)})`);
  fact(`draft: ${asks.draft?.replace(/\n/g, ' / ')}`);

  // 1. The card under the viewer's own message, only for them.
  for (const [width, theme] of SIZES) {
    step(`1-chat-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, `/chats?channel=${group}`, `chat ${width} ${theme}`);
    const card = page.locator('[data-step-card]');
    await seen(card, 'the step card');
    await seen(card.getByText('Only you see this'), 'the "only you" line');
    await seen(card.getByText(/Move “.+” to First draft\?/), 'the question in words');
    check(await card.getByRole('button', { name: 'Yes' }).count() === 1, 'one Yes');
    check(await card.getByRole('button', { name: 'Not this' }).count() === 1, 'one Not this');
    const box = await card.boundingBox(), vh = width < 600 ? 844 : width < 1100 ? 1112 : 900;
    check(box && box.y + box.height <= vh, `the card is in view (${Math.round(box?.y ?? -1)})`);
    await fits(page, `chat ${width} ${theme}`);
    await shot(page, `p3-chat-${width}-${theme}`, false);
    await c.close();
  }
  // 2. My day: "From your chats", both cards (the round and the back-fill).
  for (const [width, theme] of SIZES) {
    step(`2-myday-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, '/my-day', `my day ${width} ${theme}`);
    const box = page.getByRole('region', { name: 'From your chats' });
    await seen(box, 'From your chats');
    check(await box.locator('[data-step-card]').count() === 2, 'two cards on My day');
    await seen(box.getByText(/(Was “.+” finished too\?|Were these finished too\?)/), 'the back-fill question');
    const quick = page.getByRole('region', { name: /Quick check for today/ });
    await seen(quick, 'the assistant\'s quick check');
    check(await quick.locator('[data-step-card]').count() >= 1, 'at least one check-in card');
    await seen(quick.getByRole('button', { name: 'Done' }), 'Done on a check-in');
    await seen(quick.getByRole('button', { name: 'Stop checking on me' }), 'Stop checking on me');
    await fits(page, `my day ${width} ${theme}`);
    await shot(page, `p3-myday-${width}-${theme}`, false);
    await c.close();
  }
  // 3. The project page: "We need from the client", with Copy the request and Mark as asked.
  for (const [width, theme] of SIZES) {
    step(`3-asks-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, `/tasks/projects/${project}`, `project ${width} ${theme}`);
    const box = page.getByRole('region', { name: 'We need from the client' });
    await seen(box, 'We need from the client');
    await seen(box.getByRole('button', { name: 'Copy the request' }), 'Copy the request');
    // The card near the top of the screen, so the picture shows it whole (it sits in the side column, below the plan on a phone).
    await page.evaluate(() => { const el = [...document.querySelectorAll('section[aria-label="We need from the client"]')][0]; if (el) window.scrollBy(0, el.getBoundingClientRect().top - 90); });
    await fits(page, `project ${width} ${theme}`);
    await shot(page, `p3-asks-${width}-${theme}`, false);
    await c.close();
  }
  // 4. Taps: Yes moves M1 to First draft and offers Undo; Undo puts it back; Mark as asked starts the wait.
  step('4-taps');
  {
    const c = await context('admin', 1440, 'light'), page = await open(c, `/chats?channel=${group}`, 'chat taps');
    const card = page.locator('[data-step-card]');
    await seen(card.getByRole('button', { name: 'Yes' }), 'Yes');
    await card.getByRole('button', { name: 'Yes' }).click();
    await seen(card.getByText(/^Moved to First draft$/), 'the done line in words');
    await seen(card.getByRole('button', { name: 'Undo' }), 'Undo');
    await shot(page, 'p3-chat-1440-light-yes', false);
    const pm = await call('admin', `projects/${project}/pm`);
    check(pm.steps.find((s) => s.code === 'M1')?.status === 'in_progress', 'M1 is in progress after Yes');
    await card.getByRole('button', { name: 'Undo' }).click();
    await expect(card).toHaveCount(0, { timeout: 15000 }); checks++;
    const pm2 = await call('admin', `projects/${project}/pm`);
    check(pm2.steps.find((s) => s.code === 'M1')?.status !== 'in_progress', 'M1 is back after Undo');
    const p2 = await open(c, `/tasks/projects/${project}`, 'project asks');
    const box = p2.getByRole('region', { name: 'We need from the client' });
    await box.getByRole('button', { name: 'Mark as asked' }).click();
    await seen(box.getByText(/^Asked /), 'the asked line');
    await shot(p2, 'p3-asks-1440-light-asked', false);
    const asked = await call('admin', `projects/${project}/client-asks`);
    check(asked.items.every((x) => x.asked), 'every client input is marked asked');
    await c.close();
  }
  // 5. Leadership's desk: Delivery (going live at risk, waiting on clients, date moves by reason) and own benchmarks.
  for (const [width, theme] of SIZES) {
    step(`5-desk-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, '/tasks?view=projects&desk=1', `desk ${width} ${theme}`);
    const moves = page.getByRole('region', { name: 'Date moves by reason' });
    await seen(moves, 'Date moves by reason');
    await seen(moves.getByText('Client', { exact: true }), 'the client side of a move');
    await seen(moves.getByText('Client delay'), 'the reason in words');
    await seen(page.getByRole('region', { name: 'Waiting on clients' }).getByText(/asked of clients/), 'the client waits line');
    await seen(page.getByRole('button', { name: /benchmark/i }), 'a benchmark button');
    await seen(page.getByText(/their own healthy load/), 'an own benchmark on the load');
    await page.getByText('Going live at risk', { exact: true }).first().evaluate((el) => { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -110); });
    await fits(page, `desk ${width} ${theme}`);
    await shot(page, `p6-desk-${width}-${theme}`, false);
    if (width === 1440 && theme === 'light') {
      await page.getByRole('button', { name: /benchmark/i }).first().click();
      await seen(page.getByRole('dialog'), 'the benchmark sheet');
      await page.waitForTimeout(700); // the sheet slides in; shoot it settled
      await shot(page, 'p6-benchmark-1440-light', false);
    }
    await c.close();
  }
  check(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  if (shots) writeFileSync(`${shots}/facts.txt`, `${facts.join('\n')}\n${issues.length ? `ISSUES\n${issues.join('\n')}\n` : ''}`);
  console.log(`PM-CHAT OK: ${checks} checks${issues.length ? `, ${issues.length} issues` : ''}`);
} catch (e) {
  if (last && shots) await shot(last, `fail-${current}`, false).catch(() => null);
  console.error(`pm-chat-board-browser-runner failed at ${current}: ${e.stack ?? e}`);
  if (shots) writeFileSync(`${shots}/findings.txt`, `${facts.join('\n')}\n\nISSUES (${issues.length}):\n${issues.join('\n')}\n\nFAILED at ${current}: ${e.message}\n`);
  if (serverTail) console.error(`next dev: ${serverTail.slice(-1200)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => null); await stopServer(); await app.close().catch(() => null); await pool.end().catch(() => null);
  clearTimeout(deadline);
}
