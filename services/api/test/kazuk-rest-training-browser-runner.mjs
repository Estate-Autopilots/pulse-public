// KAZUK-REST slice 7 in the browser (tests/core/test_kazuk_rest_training.py): the real API on a disposable synthetic
// company and the web app under `next dev`. A manager opens Manage training (the course, its videos, quiz, who it is
// assigned to and who has finished), makes a new course and adds a linked video and a quiz question; a member opens My
// training, the course, says they watched the linked video and passes the quiz. 1440 and 390, light and dark, no
// sideways scroll, no page errors. Screenshots with PULSE_KR_SCREENSHOTS=<dir>. Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_KR_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kr7', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`kazuk-rest-training-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
const SIZES = [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']];
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // 1. The manager's view of the course: videos, quiz with answers, assigned to channel partners and dealers, who has finished.
  step(1);
  for (const [width, theme] of SIZES) {
    const c = await context('founder', width, theme);
    const list = await open(c, '/learn/training/manage', `manage ${width} ${theme}`);
    await seen(list.getByRole('link', { name: /Synthetic dealer onboarding/ }));
    await seen(list.getByText(/1 of 3 people done/));
    await fits(list, `Manage training ${width} ${theme}`); await shot(list, `manage-${width}-${theme}`);
    const page = await open(c, `/learn/training/manage/${E.course}`, `course ${width} ${theme}`);
    await seen(page.getByText('Synthetic intro'));
    await seen(page.getByText(/Uploaded/));
    await seen(page.getByRole('group', { name: 'Question 1' }));
    await seen(page.getByText(/Channel partners and dealers · due 1 Dec/));
    const table = page.getByRole('table', { name: 'Who has finished' });
    await seen(table.getByText('Synthetic Dealer One'));
    await seen(table.getByText('Not done'));
    await fits(page, `Edit course ${width} ${theme}`); await shot(page, `edit-${width}-${theme}`);
    await c.close();
  }
  // 2. A new course from the form: a title, then a linked video and one quiz question.
  step(2);
  {
    const c = await context('founder', 1440, 'light'), page = await open(c, '/learn/training/manage', 'new course');
    const form = page.getByRole('form', { name: 'New course' });
    await form.getByLabel('Title').fill('Synthetic safety refresher');
    await form.getByRole('button', { name: 'Make course' }).click();
    await page.waitForURL(/\/learn\/training\/manage\/[0-9a-f-]{36}$/, { timeout: 240000 }); checks++;
    const add = page.getByRole('form', { name: 'Add a video' });
    await add.getByLabel('Video title').fill('Synthetic ladder check');
    await add.getByLabel('Link').fill('https://video.example.test/synthetic/ladder');
    await add.getByRole('button', { name: 'Add video' }).click();
    await seen(page.getByText('1. Synthetic ladder check'));
    await page.getByRole('button', { name: 'Add a question' }).click();
    const q = page.getByRole('group', { name: 'Question 1' });
    await q.getByLabel('Question 1').fill('Synthetic: who holds the ladder?');
    await q.getByLabel('Choice 1', { exact: true }).fill('A colleague');
    await q.getByLabel('Choice 2', { exact: true }).fill('Nobody');
    await page.getByRole('button', { name: 'Save quiz' }).click();
    await seen(page.getByText(/1 question · pass mark 70 %/));
    await shot(page, 'new-course-1440-light');
    await c.close();
  }
  // 3. The member: My training, the course, "I watched it" on the linked video, the quiz (wrong, then right).
  step(3);
  for (const [width, theme] of SIZES) {
    const c = await context('member', width, theme);
    const mine = await open(c, '/learn/training', `mine ${width} ${theme}`);
    await seen(mine.getByRole('link', { name: /Synthetic dealer onboarding/ }));
    await fits(mine, `My training ${width} ${theme}`); await shot(mine, `mine-${width}-${theme}`);
    const page = await open(c, `/learn/training/${E.course}`, `take ${width} ${theme}`);
    await seen(page.getByRole('heading', { name: 'Videos' }));
    await seen(page.getByRole('link', { name: /Watch on the video page/ }));
    await seen(page.getByRole('form', { name: 'Quiz' }));
    await fits(page, `Course ${width} ${theme}`); await shot(page, `course-${width}-${theme}`);
    if (width === 1440 && theme === 'light') {
      await page.getByRole('button', { name: 'I watched it' }).click();
      await seen(page.getByText('Watched', { exact: true }));
      const quiz = page.getByRole('form', { name: 'Quiz' });
      await quiz.getByLabel('Red').check(); await quiz.getByLabel('Two').check();
      await quiz.getByRole('button', { name: 'Send answers' }).click();
      await seen(page.getByText(/not passed yet \(pass mark 75 %\)/));
      await seen(page.getByText('Look at this one again.'));
      await quiz.getByLabel('Blue').check();
      await quiz.getByRole('button', { name: 'Send again' }).click();
      await seen(page.getByText(/Passed: 100 %/));
      await shot(page, `course-passed-${width}-${theme}`);
    }
    await c.close();
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`kazuk-rest-training-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
