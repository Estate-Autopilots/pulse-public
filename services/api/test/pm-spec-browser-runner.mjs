// PM-BUILD-3 in the browser (tests/core/test_pm_spec_browser.py): the Mac's project-management screens (SPEC v1.1) on a
// disposable synthetic agency, the real API and the web app under `next dev`. Work → Projects is one list of cards
// (health word with its reason, phase strip, next step with owner and due, one clock line), with Mine / At risk /
// Waiting on client / Quiet / All and search. Phone 390, tablet 834, laptop 1440, light and dark; no sideways scroll, no
// page errors. Screenshots with PULSE_PC_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
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
const deadline = setTimeout(() => { console.error(`pm-spec-browser-runner: no result after 28 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 28 * 60_000);
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


const P = E.projects, today = E.today;
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  const h = await call('admin', 'projects/health?scope=all');
  const byName = Object.fromEntries(h.rows.map((r) => [r.title, r]));
  for (const r of h.rows) fact(`${r.title}: ${r.pm?.word}${r.pm?.reason ? ` · ${r.pm.reason}` : ''} | next ${r.pm?.next?.title ?? '-'} (${r.pm?.next?.due ?? ''}) | ${r.pm?.line ?? ''} | mine ${r.mine}`);
  const want = { 'Skyline Residency': ['at_risk', 'late'], 'Aranya Heights launch': ['not_started'], 'Bluewater Villas': ['waiting_client'], 'Cedar Court Phase 2': ['late'], 'Orchid Towers': ['on_track'], 'Marigold Plots': ['needs_setup'] };
  for (const [name, ok] of Object.entries(want)) check(ok.includes(byName[name]?.pm?.health), `${name} is ${ok.join(' or ')} (was ${byName[name]?.pm?.health})`);
  check(!h.rows.some((r) => r.pm?.health === 'on_track' && (!r.pm.progress.done || !r.leadId)), 'no On track at 0 % or with no lead');
  check(h.rows.every((r) => r.pm?.health === 'on_track' || r.pm?.reason), 'every health but On track has a reason');

  // 1. Work → Projects: one list of cards. Phone, tablet, laptop; light and dark.
  for (const [width, theme] of [[390, 'light'], [834, 'light'], [1440, 'light'], [390, 'dark'], [1440, 'dark']]) {
    step(`1-projects-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, '/tasks?view=projects&f=all', `projects ${width} ${theme}`);
    const list = page.getByRole('region', { name: 'Projects' });
    await seen(list.getByRole('link', { name: 'Cedar Court Phase 2' }), 'the late project');
    const first = list.locator('article').first();
    check((await first.getByRole('link').first().textContent()).includes('Cedar Court'), 'Late sorts first');
    const box = await first.boundingBox();
    check(box && box.y < (width < 600 ? 844 : 900) - 60, `the first card starts above the fold (y ${box?.y})`);
    for (const word of ['Late', 'Waiting on client', 'Not started', 'Needs setup', 'On track']) await seen(list.locator('[data-health]').getByText(word, { exact: true }), `the ${word} chip`);
    check(!(await page.locator('main').innerText()).includes('₹'), 'no money on Projects');
    await fits(page, `projects ${width} ${theme}`);
    await shot(page, `01-projects-${width}-${theme}`, false);
    if (width === 1440 && theme === 'light') {
      await shot(page, '01-projects-1440-light-full', true);
      const chips = page.getByRole('group', { name: 'Show' });
      await chips.getByRole('button', { name: /^At risk/ }).click();
      check(await list.locator('article').count() === h.rows.filter((r) => ['late', 'at_risk'].includes(r.pm.health)).length, 'At risk shows the late and at-risk projects only');
      await chips.getByRole('button', { name: /^All/ }).click();
      const t0 = Date.now();
      await page.getByRole('searchbox', { name: /Search projects/ }).fill('aranya');
      await expect(list.locator('article')).toHaveCount(1, { timeout: 2000 }); checks++;
      fact(`search answered in ${Date.now() - t0} ms`);
      await shot(page, '01-projects-search-1440', false);
      await page.getByRole('searchbox', { name: /Search projects/ }).fill('');
      await list.getByRole('link', { name: 'Skyline Residency' }).click();
      await page.waitForURL(/\/tasks\/projects\//, { timeout: 120000 }); checks++;
    }
    await c.close();
  }
  // 2. A project opens on its next step: header with the health and its reason, the next step card, the numbered phases
  // with the clock line, the phase's steps; Clocks and Team beside them. Phone, tablet, laptop; light and dark.
  const sky = `/tasks/projects/${P['Skyline Residency'].id}`;
  for (const [width, theme] of [[390, 'light'], [834, 'light'], [1440, 'light'], [390, 'dark'], [1440, 'dark']]) {
    step(`2-project-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, sky, `project ${width} ${theme}`);
    const next = page.getByRole('region', { name: 'Next step' });
    await seen(next.getByRole('heading', { level: 2 }), 'the next step card');
    const nb = await next.boundingBox();
    check(nb && nb.y + 60 < (width < 600 ? 844 : 900), `the next step starts above the fold (y ${nb?.y})`);
    await seen(page.getByRole('link', { name: 'Projects' }).first(), 'the back link says Projects');
    await seen(page.getByRole('region', { name: 'Phases' }).getByText(/^Day 14 of 21/), 'the clock line');
    await seen(page.getByRole('region', { name: 'Clocks' }), 'the clocks card');
    check(!(await page.locator('main').innerText()).includes('₹'), 'no money on the project page');
    await fits(page, `project ${width} ${theme}`);
    await shot(page, `02-project-${width}-${theme}`, false);
    if (width === 1440 && theme === 'light') {
      await shot(page, '02-project-1440-light-full', true);
      await page.getByRole('navigation', { name: 'Show the steps as' }).getByRole('link', { name: 'Board' }).click();
      await seen(page.getByRole('region', { name: /^Doing, \d+/ }), 'the board columns');
      await shot(page, '03-board-1440-light', false);
    }
    if (width === 390 && theme === 'light') {
      await page.goto(`${base}${sky}?pv=board#steps`, { waitUntil: 'load' });
      await seen(page.getByRole('region', { name: /^To do, \d+/ }), 'the board on a phone, one column');
      await fits(page, 'board 390'); await shot(page, '03-board-390-light', false);
    }
    await c.close();
  }

  // 3. Move a clock (screen 11): Aranya's planned Day 0 moves 3 days; the sheet shows what moves; a reason is required.
  const ar = `/tasks/projects/${P['Aranya Heights launch'].id}`;
  for (const [width, theme] of [[390, 'light'], [834, 'light'], [1440, 'light']]) {
    step(`3-clock-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, ar, `clock ${width} ${theme}`);
    await page.getByRole('button', { name: 'Move a date' }).click();
    const sheet = page.getByRole('dialog', { name: /Move / });
    await seen(sheet, 'the clock move sheet');
    const pv = await call('admin', `projects/${P['Aranya Heights launch'].id}/pm`);
    const d0 = pv.clocks.find((k) => k.key === 'day0').on;
    const to = new Date(Date.parse(`${d0}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
    await sheet.locator('input[type="date"]').fill(to);
    await seen(sheet.getByText(/steps? moves? \+3 days/), 'the preview says how many steps move');
    await fits(page, `clock sheet ${width}`); await shot(page, `11-clock-move-${width}-${theme}`, false);
    if (width === 1440) {
      await sheet.getByRole('button', { name: 'Move the dates' }).click();
      await seen(sheet.getByText('Reason is required'), 'a reason is required');
      await shot(page, '11-clock-move-1440-noreason', false);
      await sheet.locator('select').selectOption({ index: 1 });
      await sheet.getByRole('button', { name: 'Move the dates' }).click();
      await sheet.waitFor({ state: 'detached', timeout: 60000 }).catch(() => null);
      const after = await call('admin', `projects/${P['Aranya Heights launch'].id}/pm`);
      check(after.clocks.find((k) => k.key === 'day0').on === to, `Day 0 is now planned for ${to}`);
      await shot(page, '11-after-move-1440', false);
    }
    await c.close();
  }
  // 4. Approvals (screen 05): the team's review queue and what waits on clients ("Client late" in amber).
  for (const [width, theme] of [[390, 'light'], [834, 'light'], [1440, 'light'], [1440, 'dark']]) {
    step(`4-approvals-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, '/approvals', `approvals ${width} ${theme}`);
    await seen(page.getByText('Launch video – final cut').first(), 'the item to review');
    await fits(page, `approvals ${width} ${theme}`); await shot(page, `05-approvals-team-${width}-${theme}`, false);
    await page.getByRole('navigation', { name: 'Approvals' }).getByRole('link', { name: /Client approval/ }).click();
    await seen(page.getByRole('list', { name: 'Client approval' }).getByText('Brochure, second draft'), 'a creative waiting on the client');
    await seen(page.getByText(/^Client late · \d+ days?$/).first(), 'Client late, in words');
    await fits(page, `client approvals ${width} ${theme}`); await shot(page, `05-approvals-client-${width}-${theme}`, false);
    await c.close();
  }
  // 5. This week's update (screen 13): drafted from the week's steps; the health picker shows what the system says; better
  // than the system needs a reason; posting puts it on the project and "Updated today" on its card.
  for (const [width, theme] of [[390, 'light'], [834, 'light'], [1440, 'light']]) {
    step(`5-update-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, sky, `update ${width} ${theme}`);
    await page.getByRole('region', { name: 'Updates' }).getByRole('button', { name: /update/ }).click();
    const sheet = page.getByRole('dialog', { name: "This week's update" });
    await seen(sheet.getByText(/^System says:/), 'the system\'s health beside the picker');
    await seen(sheet.getByLabel('Done this week'), 'the drafted sections');
    await fits(page, `update sheet ${width}`); await shot(page, `13-weekly-update-${width}-${theme}`, false);
    if (width === 1440) {
      await sheet.getByRole('radio', { name: 'On track' }).click();
      await sheet.getByRole('button', { name: 'Post update' }).click();
      await seen(sheet.getByText('Say why it is better than the system says'), 'better than the system needs a reason');
      await sheet.getByLabel(/Why it is better/).fill('Synthetic: the designer finishes the image set this evening');
      await sheet.getByRole('button', { name: 'Post update' }).click();
      await sheet.waitFor({ state: 'detached', timeout: 60000 }).catch(() => null);
      await seen(page.getByRole('region', { name: 'Updates' }).getByText(/^Today/), 'the update is on the project');
      const h2 = await call('admin', 'projects/health?scope=all');
      check(h2.rows.find((r) => r.title === 'Skyline Residency')?.pm?.updated === today, 'the card knows it was updated today');
      await shot(page, '13-after-post-1440', false);
    }
    await c.close();
  }
  // 6. Team workload (screen 09): people × days, one suggestion with one Reassign.
  const wl = await call('admin', 'projects/workload');
  fact(`workload: ${wl.people.map((p) => `${p.name} ${p.total} h (${p.state})`).join(', ')}; suggestion ${wl.suggestion ? `${wl.suggestion.step.title} ${wl.suggestion.from.name} → ${wl.suggestion.to.name}` : 'none'}`);
  check(wl.people.some((p) => p.state === 'over'), 'someone is overloaded');
  for (const [width, theme] of [[390, 'light'], [834, 'light'], [1440, 'dark'], [1440, 'light']]) {
    step(`6-workload-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, '/projects/workload', `workload ${width} ${theme}`);
    await seen(page.getByRole('table', { name: /Hours of open work/ }), 'the people × days grid');
    await fits(page, `workload ${width} ${theme}`); await shot(page, `09-workload-${width}-${theme}`, false);
    if (width === 1440 && theme === 'light' && wl.suggestion) {
      await page.getByRole('region', { name: 'Suggestion' }).getByRole('button', { name: /Reassign/ }).click();
      await seen(page.getByText(new RegExp(`Moved to ${wl.suggestion.to.name}`)), 'the step moved, both told');
    }
    await c.close();
  }
  // 7. Set up a project in four steps (screens 07/08): Marigold Plots has no plan; its card leads to the set-up.
  for (const [width, theme] of [[390, 'light'], [834, 'light'], [1440, 'light']]) {
    step(`7-setup-${width}-${theme}`);
    const c = await context('admin', width, theme), page = await open(c, `/tasks/projects/${P['Marigold Plots'].id}/setup`, `setup ${width} ${theme}`);
    const wiz = page.getByRole('region', { name: 'Set up this project' });
    await seen(wiz.getByRole('radio').first(), 'the template cards');
    await fits(page, `setup template ${width}`); await shot(page, `07-template-${width}-${theme}`, false);
    await page.waitForLoadState('networkidle').catch(() => null);
    for (let k = 0; k < 3 && !(await wiz.getByRole('region', { name: "The phases' dates" }).count()); k++) { await wiz.getByRole('button', { name: /^Next: Dates/ }).click(); await page.waitForTimeout(1500); }
    await seen(wiz.getByRole('region', { name: "The phases' dates" }), 'the phases with dates');
    await fits(page, `setup dates ${width}`); await shot(page, `08-dates-${width}-${theme}`, false);
    if (width === 1440) {
      await wiz.getByRole('button', { name: /^Next: People/ }).click();
      await wiz.locator('select').first().selectOption({ index: 1 });
      await shot(page, '08-people-1440-light', false);
      await wiz.getByRole('button', { name: /^Next: Preview/ }).click();
      await seen(wiz.getByRole('region', { name: 'The first steps' }), 'the first steps with owners and dates');
      await shot(page, '08-preview-1440-light', false);
      await wiz.getByRole('button', { name: 'Create the plan' }).click();
      await page.waitForURL(new RegExp(`/tasks/projects/${P['Marigold Plots'].id}$`), { timeout: 120000 }); checks++;
      await seen(page.getByRole('region', { name: 'Next step' }), 'the new plan opens on its next step');
    }
    await c.close();
  }
  check(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  if (shots) writeFileSync(`${shots}/facts.txt`, `${facts.join('\n')}\n${issues.length ? `ISSUES\n${issues.join('\n')}\n` : ''}`);
  console.log(`PM-SPEC OK: ${checks} checks${issues.length ? `, ${issues.length} issues` : ''}`);
} catch (e) {
  if (last && shots) await shot(last, `fail-${current}`, false).catch(() => null);
  console.error(`pm-spec-browser-runner failed at ${current}: ${e.stack ?? e}`);
  if (shots) writeFileSync(`${shots}/findings.txt`, `${facts.join('\n')}\n\nISSUES (${issues.length}):\n${issues.join('\n')}\n\nFAILED at ${current}: ${e.message}\n`);
  if (serverTail) console.error(`next dev: ${serverTail.slice(-1200)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => null); await stopServer(); await app.close().catch(() => null); await pool.end().catch(() => null);
  clearTimeout(deadline);
}
