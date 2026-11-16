// PROJECTS-FIX in the browser (tests/core/test_projects_fix_browser.py): the real API on a disposable synthetic company
// shaped like the owner's own, and the web app under `next dev`. The owner (10 Nov 2026): the goal's next step links to
// work he can't find; an internal project opens as a client package; List, Board, Timeline and Calendar show nothing;
// the list does not scroll. This walk: the goal's next step lands on that exact task, highlighted; the internal project
// opens on its own page (what it is, its state, progress, its tasks) with no client words; every view draws the same
// tasks; the long list scrolls to its last task. 1440 and 363, light and dark; no sideways scroll, no page errors.
// Screenshots with PULSE_PF_SCREENSHOTS=<dir>. OBSERVE=1 records what it finds instead of failing (the "before" walk).
// Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_PF_SCREENSHOTS, observe = process.env.OBSERVE === '1';
if (shots) mkdirSync(shots, { recursive: true });
const emails = { admin: 'admin@estateautopilots.com', member: E.editorEmail };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-pf', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const issues = [], facts = [];
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`projects-fix-browser-runner: no result after 28 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 28 * 60_000);
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
/** Which of these task titles the page draws (a box with size, not hidden), and which it doesn't. */
const drawn = (page, titles) => page.evaluate((titles) => {
  const want = new Set(titles), got = new Set();
  for (const el of document.querySelectorAll('main *')) {
    if (el.children.length > 2) continue;
    const text = (el.textContent ?? '').trim(); if (!want.has(text) || got.has(text)) continue;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width > 8 && r.height > 4 && s.visibility !== 'hidden') got.add(text);
  }
  return { got: [...got], missing: titles.filter((t) => !got.has(t)) };
}, titles);
/** The page reaches this task: scrolled to, it sits inside the screen and nothing covers it. */
const reaches = (page, title) => page.evaluate(async (title) => {
  const el = [...document.querySelectorAll('main a, main span, main b')].find((x) => (x.textContent ?? '').trim() === title);
  if (!el) return { ok: false, why: 'not on the page' };
  el.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 400));
  const r = el.getBoundingClientRect(); const x = Math.min(innerWidth - 2, Math.max(1, r.left + Math.min(20, r.width / 2))), y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const inside = r.top >= 0 && r.bottom <= innerHeight + 1;
  return { ok: inside && !!top && (top === el || el.contains(top) || top.contains(el)), why: `top ${Math.round(r.top)} bottom ${Math.round(r.bottom)} of ${innerHeight}; at that point: ${top?.tagName ?? 'nothing'} ${String(top?.className ?? '').slice(0, 40)}`, scrollY: Math.round(scrollY), height: document.documentElement.scrollHeight };
}, title);
const VIEWS = [['list', 'List'], ['board', 'Board'], ['timeline', 'Timeline'], ['calendar', 'Calendar']];
const COUNTED = new Set(['open', 'in_progress', 'blocked', 'unknown', 'done', 'accepted', 'in_review']);

try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  const tasksOf = async (pid) => (await call('admin', `tasks/projects/${pid}`)).tasks.filter((t) => COUNTED.has(t.status));
  const inc = await tasksOf(E.inc), dev = await tasksOf(E.dev);
  fact(`incorporation: ${inc.length} tasks that count; developer accounts: ${dev.length}`);
  const consult = 'Consult the CA: LLP cost, India vs abroad, investor structure';

  // 1. The goal: its next step is the late "Consult the CA" task; following it lands on that task, highlighted.
  step('1-goal');
  {
    const c = await context('admin'), page = await open(c, `/goals/${E.goal}`, 'goal');
    await seen(page.getByRole('heading', { name: 'Register Synthetic Technology Pvt Ltd' }), 'the goal');
    const next = page.getByRole('region', { name: 'Next thing to do' });
    await seen(next.getByText(consult), 'the next step names the task');
    await fits(page, 'goal 1440');
    await shot(page, '01-goal-1440');
    const link = next.getByRole('link').first(); const href = await link.getAttribute('href');
    fact(`next step links to ${href}`);
    check(href?.startsWith(`/tasks/projects/${E.inc}`) && href.includes(E.consult), `the next step opens the task in its project's list (was ${href})`);
    await link.click();
    await page.waitForURL(/\/tasks\/projects\//, { timeout: 180000 }).catch(() => null);
    await page.locator(`[data-highlight]`).first().waitFor({ timeout: 120000 }).catch(() => null); await page.waitForTimeout(1200);
    fact(`landed on ${new URL(page.url()).pathname}${new URL(page.url()).search}`);
    const hl = page.locator(`[data-highlight="${E.consult}"]`);
    check(await hl.count() === 1, 'the task is highlighted where it lands');
    if (await hl.count()) { const r = await hl.first().boundingBox(); check(r && r.y >= 0 && r.y + r.height <= 901, `the highlighted task is on screen (y ${r?.y})`); }
    await shot(page, '02-goal-next-lands-1440', false);
    // The project's card on the goal opens the project's own page.
    const p2 = await open(c, `/goals/${E.goal}`, 'goal card');
    const card = p2.getByRole('region', { name: /under this goal/ }).getByRole('link', { name: 'Incorporate Synthetic Technologies' }).first();
    const cardHref = await card.getAttribute('href').catch(() => null);
    check(cardHref === `/tasks/projects/${E.inc}`, `the project card opens the project's page (was ${cardHref})`);
    // The goals list says "Next: …" too (where the owner clicked it): it lands on the same task.
    const p3 = await open(c, '/goals', 'goals list');
    const nextLink = p3.getByRole('link', { name: new RegExp(`Next: ${consult.slice(0, 20)}`) }).first();
    await seen(nextLink, 'the goals list names the next step');
    const listHref = await nextLink.getAttribute('href').catch(() => null);
    check(listHref?.startsWith(`/tasks/projects/${E.inc}?task=${E.consult}`), `the goals list's next step opens the task in its project (was ${listHref})`);
    await shot(p3, '00-goals-list-1440', false);
    await c.close();
  }
  // 1b. On a phone, in dark: the next step lands on the highlighted task too.
  step('1b-goal-phone');
  {
    const c = await context('admin', 363, 'dark'), page = await open(c, `/goals/${E.goal}`, 'goal phone');
    await seen(page.getByRole('heading', { name: 'Register Synthetic Technology Pvt Ltd' }), 'the goal on a phone');
    await fits(page, 'goal 363 dark');
    await shot(page, '01b-goal-363-dark');
    await page.getByRole('region', { name: 'Next thing to do' }).getByRole('link').first().click();
    await page.waitForURL(/\/tasks\/projects\//, { timeout: 180000 }).catch(() => null);
    const hl = page.locator(`[data-highlight="${E.consult}"]`);
    await hl.first().waitFor({ timeout: 120000 }).catch(() => null); await page.waitForTimeout(1200);
    check(await hl.count() === 1, 'on a phone the task is highlighted where it lands');
    if (await hl.count()) { const r = await hl.first().boundingBox(); check(r && r.y >= 0 && r.y + r.height <= 801, `on a phone the highlighted task is on screen (y ${r?.y})`); }
    await fits(page, 'project 363 dark');
    await shot(page, '02b-goal-next-lands-363-dark', false);
    await c.close();
  }

  // 2. An internal project: the old client-package address sends it to its own page; no client words; the page says what
  // it is, its state, its progress and lists its tasks.
  step('2-internal');
  {
    const c = await context('admin'), page = await open(c, `/projects/${E.inc}`, 'old address');
    await page.waitForURL(new RegExp(`/tasks/projects/${E.inc}`), { timeout: 120000 }).catch(() => null);
    check(page.url().includes(`/tasks/projects/${E.inc}`), `/projects/<internal> opens the project's own page (was ${page.url()})`);
    for (const words of ['Client package', /Fulfil?ment/, /require[sd]? (a )?link/i, 'Latest deliveries', 'Leads', 'Creatives', 'Calls']) {
      check(await page.getByRole('main').getByText(words).count() === 0, `no client words on an internal project: ${words}`);
    }
    await seen(page.getByText(/Register the synthetic company as a private limited company/), 'what the project is (its summary) on the first view');
    await seen(page.getByText(/^(On track|Behind|Waiting|Paused|All tasks done)$/), 'the project\'s state');
    await seen(page.getByRole('region', { name: 'Progress' }), 'its progress');
    await fits(page, 'internal project 1440');
    await shot(page, '03-internal-project-1440');
    await c.close();
  }

  // 3. The four views each draw the same tasks, at 1440 and 363; the long list reaches its last task.
  for (const [pid, rows, label] of [[E.inc, inc, 'incorporation'], [E.dev, dev, 'developer accounts']]) {
    for (const width of [1440, 363]) {
      step(`3-${label}-${width}`);
      const c = await context('admin', width);
      const titles = rows.map((t) => t.title);
      for (const [view, name] of VIEWS) {
        const page = await open(c, `/tasks/projects/${pid}?view=${view}`, `${label} ${view} ${width}`);
        await page.getByRole('navigation', { name: 'Show the tasks as' }).waitFor({ timeout: 180000 }).catch(() => null);
        await page.waitForTimeout(800);
        // The picture is the view as it opens (folded bands, a capped column, a short tray); then everything is opened
        // to count: folded bands, "Show all", "+N more".
        await fits(page, `${label} ${view} ${width}`);
        await shot(page, `04-${label.split(' ')[0]}-${view}-${width}`);
        const expand = async () => {
          for (const s2 of await page.locator('[data-band-fold]:not([open]) > summary').all()) await s2.click().catch(() => null);
          for (const b of await page.getByRole('button', { name: /^\+\d+ more$|^Show all \d+$|^Show \d+ more$|^Show \d+ done$/ }).all()) if (await b.isVisible()) await b.click().catch(() => null);
          await page.waitForTimeout(300);
        };
        await expand();
        // What this view should draw: every task, except that a calendar shows one month (plus the tasks with no day) and
        // offers the other months one tap away; a phone board shows one column at a time, each a chip.
        let want = titles, elsewhere = 0;
        if (view === 'calendar') {
          const head = (await page.locator('h3[aria-live]').first().textContent().catch(() => '')) ?? '';
          const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
          const [mon, yr] = head.trim().split(/\s+/); const key = `${yr}-${String(MONTHS.indexOf(mon) + 1).padStart(2, '0')}`;
          want = rows.filter((t) => !t.dueOn || t.dueOn.startsWith(key)).map((t) => t.title); elsewhere = rows.length - want.length;
          fact(`Calendar opens on ${head.trim()}: ${want.length} there or with no day, ${elsewhere} in other months`);
          if (elsewhere) {
            const chips = page.getByLabel('Tasks in other months').getByRole('button');
            let n = 0; for (const b of await chips.all()) n += Number((await b.getAttribute('aria-label'))?.match(/: (\d+) task/)?.[1] ?? 0);
            check(n === elsewhere, `${label} Calendar at ${width}: the other months are one tap away (${n} of ${elsewhere})`);
          }
        }
        let d = await drawn(page, want);
        if (view === 'board' && width < 600 && d.missing.length) {
          const got = new Set(d.got);
          const chips = await page.getByRole('group', { name: 'Column' }).getByRole('button').all();
          for (const b of chips) { await b.click(); await page.waitForTimeout(300); await expand(); for (const x of (await drawn(page, want)).got) got.add(x); }
          d = { got: [...got], missing: want.filter((x) => !got.has(x)) };
        }
        fact(`${name}: draws ${d.got.length} of ${want.length}${d.missing.length ? `; missing e.g. ${d.missing.slice(0, 3).join(' | ')}` : ''}`);
        check(d.missing.length === 0 && want.length > 0, `${label} ${name} at ${width} draws every task (${d.got.length} of ${want.length})`);
        if (view === 'list') {
          const lastTitle = rows.map((t) => t.title).includes('Developer account 49: the last task in the list') ? 'Developer account 49: the last task in the list' : null;
          if (lastTitle) { const r = await reaches(page, lastTitle); fact(`list reaches the last task: ${JSON.stringify(r)}`); check(r.ok, `${label} list at ${width} scrolls to its last task (${r.why})`); await page.evaluate(() => scrollTo(0, 0)); }
        }
        await page.close();
      }
      await c.close();
    }
  }

  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  if (shots) writeFileSync(`${shots}/findings.txt`, `${facts.join('\n')}\n\nISSUES (${issues.length}):\n${issues.join('\n')}\n`);
  console.log(`PROJECTS-FIX ${observe ? 'OBSERVED' : 'OK'}: ${checks} checks, ${issues.length} issues`);
  if (observe) console.log('PROJECTS-FIX OK (observe mode)');
} catch (e) {
  console.error(`projects-fix-browser-runner failed at step ${current}: ${e.stack ?? e}`);
  if (shots) writeFileSync(`${shots}/findings.txt`, `${facts.join('\n')}\n\nISSUES (${issues.length}):\n${issues.join('\n')}\n\nFAILED at ${current}: ${e.message}\n`);
  if (last && shots) await last.screenshot({ path: `${shots}/failed-${current}.png`, timeout: 120000 }).catch((x) => console.error(`no failure shot: ${x}`));
  if (serverTail) console.error(`next dev: ${serverTail.slice(-1200)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => null);
  stopServer(); await app.close().catch(() => null); await pool.end().catch(() => null);
  clearTimeout(deadline);
}
