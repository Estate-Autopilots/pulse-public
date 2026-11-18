// PM-BUILD-1 in the browser (tests/core/test_plan_clocks_browser.py): the real API on a disposable synthetic agency and
// the web app under `next dev`. A client project whose plan runs on clocks (migration 2262): where it stands (package,
// the day number since inputs complete, ads live not yet), "Before ads can go live" with its inputs and one button, the
// clock dialog refusing and naming what is open, the steps by phase (Running for set-up work that runs on, "Waits on"
// while an earlier step is open), a step's own page with its card, and a task that reads as leadership business: the
// ask, then the mark. 1440 and 363, light and dark; no sideways scroll, no page errors. Screenshots with
// PULSE_PC_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
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
const deadline = setTimeout(() => { console.error(`plan-clocks-browser-runner: no result after 28 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 28 * 60_000);
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
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, colorScheme: theme,
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

const project = `/tasks/projects/${E.project}`;
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  const plan = await call('admin', `projects/${E.project}/plan`);
  fact(`plan: ${plan.tasks.length} tasks; day ${plan.state.clocks.dayN}; gates ${plan.state.clocks.gates.map((g) => `${g.key} open ${g.open}`).join(', ')}; running ${plan.state.running.length}`);
  check(plan.state.clocks.fromDay0 && plan.state.clocks.dayN === 14, `day 14 since inputs complete (was ${plan.state.clocks.dayN})`);
  check(plan.notMade.some((x) => x.id === 'O1') && plan.notMade.some((x) => x.id === 'W4'), 'the system\'s own step and the conditional one are not cards');

  // 1. The project page: where it stands, the gate, the steps by phase. 1440 and 363, light and dark.
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']]) {
    step(`1-project-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, project, `project ${width} ${theme}`);
    await seen(page.getByText(/^Day 14/).first(), 'the day number since inputs complete');
    // On a phone the numbered "Ads live" step says it is not live yet (the chip would only repeat it).
    if (width >= 600) await seen(page.getByText('Ads live: not yet'), 'ads live not yet');
    else await seen(page.getByRole('region', { name: 'Before ads can go live' }).getByText('Ads live', { exact: true }), 'the ads live step, not yet recorded');
    const gate = page.getByRole('region', { name: 'Before ads can go live' });
    await seen(gate, 'the go-live card');
    await seen(gate.getByRole('button', { name: /Record ads live: waits on C5/ }), 'the record button, locked, says what it waits on');
    await seen(gate.getByText('Design confirmed by the strategist', { exact: true }), 'the locked button leads with the step it waits on');
    await seen(gate.getByText(/^C5 · Ravi has it/), 'then its code and who has it');
    check(await gate.locator('a[data-state="open"]').count() === 0, 'the step the button names is not a second chip (PM-BUILD-2)');
    check(await gate.getByText('Declared for').count() > 0, 'day 0 says when it was declared');
    await seen(gate.getByText(/all 4 inputs done/), 'a recorded clock folds its inputs into its one line');
    await seen(gate.getByText(/3 of 5 done/), 'the open clock says how many inputs are done on its line');
    await seen(page.getByText('Running').first(), 'the set-up step reads Running');
    // PM-BUILD-2: what we promised (a change waiting for sales), and "Set up this project" (roles, chats, a condition).
    const promise = page.getByRole('region', { name: 'What we promised' });
    await seen(promise.getByText('Change waiting for sales'), 'a proposed change waits for sales');
    await seen(promise.getByText(/site visits a month/), 'the worked-out numbers');
    await seen(promise.getByText(/bookings a month 4 → 5/), 'what the proposal changes');
    const setup = page.locator('details[aria-label="Set up this project"]');
    await seen(setup.getByText('Who does what'), 'who does what');
    await seen(setup.getByText(/\d steps? ha(s|ve) nobody/).first(), 'a role with a step that has nobody');
    await seen(setup.getByRole('link', { name: /Skyline Residency team/ }), 'the linked chat');
    await seen(setup.getByRole('button', { name: 'Unlink Skyline Residency team' }), 'the linked chat can be unlinked');
    // The first pass links the suggested client group; the later passes see it linked.
    if (width === 1440 && theme === 'light') await seen(setup.getByRole('button', { name: 'Link', exact: true }), 'a suggested chat to link');
    else await seen(setup.getByRole('link', { name: /Kireteso Builders/ }), 'the client group linked in the first pass');
    await seen(setup.getByRole('switch', { name: 'Does the project have real buyers yet?' }), 'the condition, asked as a question');
    await seen(page.getByText(/Waits on C\d/).first(), 'a step waiting on an earlier one says so');
    await page.waitForTimeout(800);
    await fits(page, `project ${width} ${theme}`);
    if (width < 600) { await shot(page, `01-project-${width}-${theme}-a`, false); await gate.evaluate((el) => el.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -64)); await page.waitForTimeout(500); await shot(page, `01-project-${width}-${theme}-b`, false);
      await page.getByText('Steps', { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -64)); await page.waitForTimeout(500); await shot(page, `01-project-${width}-${theme}-c`, false);
      await setup.evaluate((el) => el.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -64)); await page.waitForTimeout(500); await shot(page, `01-project-${width}-${theme}-d`, false); }
    else await shot(page, `01-project-${width}-${theme}`);
    if (width === 1440 && theme === 'light') {
      // PM-BUILD-2: link the client's group from the suggestion; it becomes a linked chat.
      step('1b-link-chat');
      await setup.getByRole('button', { name: 'Link', exact: true }).first().click();
      await seen(setup.getByRole('link', { name: /Kireteso Builders/ }), 'the suggested group is linked');
      // The promise panel's change dialog opens with the fields (closed again without saving).
      await promise.getByRole('button', { name: 'Change' }).click();
      const pd = page.getByRole('dialog');
      await seen(pd.getByText('Bookings a month'), 'the change dialog has the sales-set fields');
      await seen(pd.getByText(/Already waiting/), 'the dialog shows the change already waiting');
      await page.waitForTimeout(900); // the sheet has finished opening
      await shot(page, '06-promise-dialog-1440', false);
      await pd.getByRole('button', { name: 'Cancel' }).click();
      // The clock dialog refuses while inputs are open, and names them.
      step('2-clock-dialog');
      await gate.getByRole('button', { name: /Record ads live: waits on C5/ }).click();
      const dlg = page.getByRole('dialog').or(page.getByRole('alertdialog'));
      await seen(dlg.getByText("Can't go live yet"), 'the dialog says why');
      await seen(dlg.getByText('Design confirmed by the strategist'), 'the dialog names the open input');
      await seen(dlg.getByRole('button', { name: 'Open the step' }), 'one button opens the step that blocks it');
      await shot(page, '02-clock-dialog-1440', false);
      await dlg.getByRole('button', { name: 'Open the step' }).click();
      await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 120000 }).catch(() => null);
      check(/\/tasks\/[0-9a-f-]{36}$/.test(page.url()), `"Open the step" opens it (${page.url()})`);
    }
    await c.close();
  }

  // 3. A step's own page: its card (code, phase, owner role, when, benchmark, waits on, opens).
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']]) {
    step(`3-step-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, `/tasks/${E.c6}`, `step ${width} ${theme}`);
    const card = page.getByRole('region', { name: 'Step C6' });
    await seen(card, 'the step card');
    await seen(card.getByText('Video editor', { exact: true }), 'the owner role');
    await seen(card.getByText('Next after this'), 'what finishing it opens');
    await seen(card.getByTitle(/project days 13–20/), 'where it sits on its clock (project days 13–20, on the day count)');
    await seen(card.getByText('Day 2 of 8'), 'where today falls in its planned days');
    // PM-BUILD-2: what it waits on is on the card (C2 and C3), beside what it opens; the map link is the card's foot.
    await seen(card.getByRole('list', { name: 'Waits on' }), 'what it waits on, on the card');
    await seen(card.getByRole('link', { name: 'See how it connects' }), 'the map link on the card');
    check(await page.getByRole('region', { name: 'Unlocks' }).count() === 0, 'no second list of what it opens');
    await fits(page, `step ${width} ${theme}`);
    if (width < 600) { await page.waitForTimeout(800); await shot(page, `03-step-${width}-${theme}`, false); }
    else await shot(page, `03-step-${width}-${theme}`);
    await c.close();
  }

  // 4. Leadership business: the ask (leadership only), then the mark once it is made leadership-only.
  for (const [width, theme] of [[363, 'light'], [1440, 'dark'], [1440, 'light']]) {
    step(`4-leadership-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, `/tasks/${E.pay}`, `pay ${width} ${theme}`);
    const ask = page.getByRole('note').filter({ hasText: 'Make this leadership-only?' });
    await seen(ask, 'the ask');
    await fits(page, `ask ${width} ${theme}`);
    await shot(page, `04-ask-${width}-${theme}`, false);
    if (width === 1440 && theme === 'light') {
      await ask.getByRole('button', { name: 'Yes, leadership only' }).click();
      await ask.waitFor({ state: 'detached', timeout: 120000 }).catch(() => null);
      check(await page.getByText('Make this leadership-only?').count() === 0, 'the ask is gone once it is leadership-only');
      check(await page.getByText('Leadership only', { exact: true }).count() >= 2, 'the mark beside the title (and the switch in the side panel)');
      await page.waitForTimeout(4800); // the toast clears
      await shot(page, '05-marked-1440-light', false);
    }
    await c.close();
  }
  check(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  if (shots) writeFileSync(`${shots}/facts.txt`, `${facts.join('\n')}\n${issues.length ? `ISSUES\n${issues.join('\n')}\n` : ''}`);
  console.log(`PLAN-CLOCKS OK: ${checks} checks${issues.length ? `, ${issues.length} issues` : ''}`);
} catch (e) {
  if (last && shots) await shot(last, `fail-${current}`, false).catch(() => null);
  console.error(`plan-clocks-browser-runner failed at ${current}: ${e.stack ?? e}`);
  if (shots) writeFileSync(`${shots}/findings.txt`, `${facts.join('\n')}\n\nISSUES (${issues.length}):\n${issues.join('\n')}\n\nFAILED at ${current}: ${e.message}\n`);
  if (serverTail) console.error(`next dev: ${serverTail.slice(-1200)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => null); await stopServer(); await app.close().catch(() => null); await pool.end().catch(() => null);
  clearTimeout(deadline);
}
