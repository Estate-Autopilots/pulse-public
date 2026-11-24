// PM-BUILD-4 in the browser (tests/core/test_pm_first_run_browser.py): lane B's judged First run screen (19), mounted on
// Work → Projects for a company with no projects yet, on a disposable synthetic company, the real API and the web app
// under `next dev`. Its one button "Start your first project" and each template card open the New project form, a
// second press too (the link only changes the address's query, so the page stays mounted); the template card shows the
// template's real counts. Phone 390, tablet 834, laptop 1440, light and dark; no sideways scroll, no page errors.
// Screenshots with PULSE_PC_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
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
const deadline = setTimeout(() => { console.error(`pm-first-run-browser-runner: no result after 28 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 28 * 60_000);
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


try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  step('data'); fact(`synthetic company ${E.org}`);
  const h = await call('admin', 'projects/health?scope=all');
  check(h.rows.length === 0, `the company has no project to list (has ${h.rows.map((r) => r.title).join(', ')})`);
  const tpl = (await call('admin', 'projects/templates?full=1')).templates;
  check(tpl.length === 1 && tpl[0].name === 'Property launch campaign', `one template (${tpl.map((t) => t.name).join(', ')})`);
  const counts = `${tpl[0].stages.length} phases · ${tpl[0].steps} steps · `;
  for (const [width, theme] of [[390, 'light'], [390, 'dark'], [834, 'light'], [834, 'dark'], [1440, 'light'], [1440, 'dark']]) {
    const tag = `${width}-${theme}`;
    step(`first run ${tag}`);
    const c = await context('admin', width, theme);
    const page = await open(c, '/tasks?view=projects', tag);
    await seen(page.getByRole('heading', { name: 'Run every client project the same, good way' }), `${tag}: the First run headline`);
    const card = page.getByRole('link', { name: /Property launch campaign/ });
    await seen(card, `${tag}: the company's template card`);
    const text = (await card.first().innerText()).replace(/\s+/g, ' ');
    check(text.includes(counts), `${tag}: the card counts the template's phases and steps ("${counts}…", was "${text}")`);
    check(!/ 0 days/.test(text), `${tag}: the card never says 0 days ("${text}")`);
    await fits(page, `${tag} First run`);
    check(!(await page.locator('[data-new-project]').first().isVisible()), `${tag}: Work's own "New project" steps aside while First run shows`);
    const filled = await page.locator('main [data-variant="primary"]').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent.trim()));
    check(filled.length === 1 && filled[0] === 'Start your first project', `${tag}: one filled button, "Start your first project" (${filled.join(' | ')})`);
    await shot(page, `19-first-run-live-${tag}`, false);
    const form = page.getByRole('dialog', { name: 'New project' });
    const press = async (target, what) => {
      await target.first().click();
      await seen(form, `${tag}: ${what} opens the New project form`, 30000);
      await form.getByRole('button', { name: 'Cancel' }).click();
      await expect(form).toBeHidden({ timeout: 10000 }); checks++;
    };
    await press(page.getByRole('link', { name: 'Start your first project' }), '“Start your first project”');
    await press(page.getByRole('link', { name: 'Start your first project' }), 'a second press of “Start your first project”');
    await press(card, 'the template card');
    if (width === 1440 && theme === 'light') {
      await page.getByRole('link', { name: 'Start your first project' }).click();
      await seen(form, `${tag}: the form again`, 30000);
      await shot(page, `19-first-run-live-form-${tag}`, false);
      // KAZUK-GAPS (A12): "Resume where you left off" opens the page with …&newProject=1 and the form opens by itself.
      step(`resume ${tag}`);
      const again = await open(c, '/tasks?view=projects&newProject=1', `resume ${tag}`);
      await seen(again.getByRole('dialog', { name: 'New project' }), `${tag}: opening …&newProject=1 opens the form`, 60000);
    }
    await c.close();
  }
  check(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  if (shots) writeFileSync(`${shots}/facts.txt`, `${facts.join('\n')}\n${issues.length ? `ISSUES\n${issues.join('\n')}\n` : ''}`);
  console.log(`PM-FIRST-RUN OK: ${checks} checks${issues.length ? `, ${issues.length} issues` : ''}`);
} catch (e) {
  if (last && shots) await shot(last, `fail-${current.replace(/\s+/g, '-')}`, false).catch(() => null);
  console.error(`pm-first-run-browser-runner failed at ${current}: ${e.stack ?? e}`);
  if (shots) writeFileSync(`${shots}/findings.txt`, `${facts.join('\n')}\n\nISSUES (${issues.length}):\n${issues.join('\n')}\n\nFAILED at ${current}: ${e.message}\n`);
  if (serverTail) console.error(`next dev: ${serverTail.slice(-1200)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => null); await stopServer(); await app.close().catch(() => null); await pool.end().catch(() => null);
  clearTimeout(deadline);
}
