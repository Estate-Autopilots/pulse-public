// WORK-SPINE in the browser (tests/core/test_work_spine.py): the real API on a disposable synthetic company and the web
// app under `next dev`. The owner opens a goal and sees its projects with their next tasks, finishes one there in one
// click; opens the project: List, Board, Timeline and Calendar each show its tasks (the views were empty), Overview,
// Files and Activity read in plain words; a task shows Goal › Project; an internal project never opens as a client
// package; projects an AI started sit under "Started by AI". The pod head and a member walk it too, on a phone. Phone
// (390) and desktop (1440), light and dark, no sideways scroll, no clipped titles, no page errors. Screenshots with
// PULSE_WS_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_WS_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const emails = { admin: 'admin@estateautopilots.com', member: E.editorEmail, head: E.headEmail };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-ws', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`work-spine-browser-runner: no result after 28 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 28 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const errors = [], changedCount = new Map();
// No sideways scroll, and no text that runs out of its box: a title or chip whose content is wider than its box and
// is not meant to clip (an ellipsis or line clamp says it is).
async function fits(page, what) {
  const r = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth > innerWidth + 1;
    const spill = [], edge = [];
    for (const el of document.querySelectorAll('main a, main h1, main h2, main h3, main span, main small, main b, main p')) {
      const s = getComputedStyle(el); if (s.display === 'inline' || el.clientWidth < 4 || s.position === 'absolute' || s.position === 'fixed' || el.closest('[aria-hidden="true"]')) continue;
      const clips = s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none' || s.overflowX === 'auto' || s.overflowX === 'scroll';
      if (!clips && s.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 2) spill.push(`cut: ${el.textContent.trim().slice(0, 40)}`);
      // Inside a box that scrolls or clips sideways (a timeline, a board, a table), going past the screen is that box's job.
      let boxed = false; for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { if (getComputedStyle(a).overflowX !== 'visible') { boxed = true; break; } }
      const box = el.getBoundingClientRect(); if (box.width && box.right > innerWidth + 1 && !boxed) edge.push(el.textContent.trim().slice(0, 40));
    }
    return { wide, spill: spill.slice(0, 5), edge: edge.slice(0, 5) };
  });
  assert.ok(!r.wide, `${what} has no sideways scroll`);
  assert.deepEqual(r.edge, [], `${what}: nothing runs off the right edge`);
  if (r.spill.length) console.log(`look at ${what}: ${r.spill.join(' | ')}`);
  checks += 2;
}
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, colorScheme: theme,
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.browser.asked', '1'); } catch { /* none */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  // WORK-SPINE: how often each page was told its work changed (a page that reads itself again and again is a bug).
  page.on('response', async (r) => { if (r.url().includes('/api/v0/work/changed')) { const j = await r.json().catch(() => null); if (j?.changed) changedCount.set(name, (changedCount.get(name) ?? 0) + 1); } });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|Download the React DevTools/.test(m.text())) { console.log(`console error on ${name}: ${m.text().slice(0, 300)}`); if (shots) appendFileSync(`${shots}/console.txt`, `${name}: ${m.text().slice(0, 600)}\n`); } });
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name) => {
  if (!shots) return;
  const vp = page.viewportSize();
  const extra = await page.evaluate(() => { let most = 0; for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.clientHeight > 200) most = Math.max(most, el.scrollHeight - el.clientHeight); } return Math.max(most, document.documentElement.scrollHeight - innerHeight); });
  if (extra > 0) { await page.setViewportSize({ width: vp.width, height: Math.min(4200, vp.height + extra) }); await page.waitForTimeout(500); }
  await page.screenshot({ path: `${shots}/${name}.png`, timeout: 120000 }); // a loaded server took over 30 s (13 Nov)
  if (extra > 0) await page.setViewportSize(vp);
};
const call = async (role, path, body) => {
  const r = await fetch(`${base}/api/v0/${path}`, { method: body ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': emails[role], ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); assert.ok(r.status < 300, `${path}: ${JSON.stringify(j)}`); return j;
};
const project = `/tasks/projects/${E.project}`, goal = `/goals/${E.goal}`;
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // A link and a file note on the parent task, for the Files tab.
  await call('admin', `tasks/${E.spice}/attachments`, { url: 'https://example.com/synthetic-filing-sheet', label: 'Synthetic filing sheet' });

  // 1. The owner's goal: its projects, each with its type, progress and next tasks; late says why; one click finishes.
  step(1);
  {
    const c = await context('admin'), page = await open(c, goal, 'admin goal');
    await seen(page.getByRole('heading', { name: 'Register the synthetic company' }));
    const work = page.getByRole('region', { name: /under this goal/ });
    await seen(work.getByRole('article', { name: 'Synthetic incorporation' }));
    await seen(work.getByRole('article', { name: 'Synthetic bank account' }));
    await seen(work.getByText('Internal'));
    await seen(page.getByText('Counted from the tasks of 2 projects: every task finished moves it.'));
    await seen(work.getByText(/Late · was due/));
    await seen(page.getByRole('link', { name: 'Synthetic incorporation' }));
    assert.equal(await page.getByRole('link', { name: 'Synthetic incorporation' }).first().getAttribute('href'), project, 'the project opens on its own page, not a client package'); checks++;
    await fits(page, 'goal 1440');
    await shot(page, '01-goal-1440');
    const before = (await call('admin', `goals/${E.goal}`)).goal.progress.tasksDone;
    await work.getByRole('button', { name: 'Mark “Consult the CA on cost” done' }).click();
    // DITASU-2 (AC card 7): the Undo banner beside the circle says it is done (its words: a tick, "Done", the task's name).
    await seen(page.locator('[data-undo-here] [title^="Done: Consult the CA on cost"]'));
    await expect.poll(async () => (await call('admin', `goals/${E.goal}`)).goal.progress.tasksDone, { timeout: 30000 }).toBe(before + 1); checks++;
    // The ring says the goal's number once; its label carries the count ("22% done: 2 of 9 tasks").
    await expect.poll(async () => (await page.getByRole('region', { name: 'Progress' }).getByRole('img').first().getAttribute('aria-label')) ?? '', { timeout: 60000 }).toContain(`${before + 1} of`); checks++;
    await page.mouse.move(4, 4);
    await shot(page, '02-goal-ticked-1440');
    // A task's title opens it in a drawer beside the goal: where it sits, its due day, Mark done, its checklist.
    await work.getByRole('link', { name: 'Write the vesting terms' }).click();
    const drawer = page.getByRole('dialog', { name: 'Task: Write the vesting terms' });
    await seen(drawer.getByRole('navigation', { name: 'Where this task sits' }).getByRole('link', { name: 'Synthetic incorporation' }));
    await seen(drawer.getByRole('button', { name: 'Mark done' }));
    await shot(page, '02b-goal-drawer-1440');
    await page.keyboard.press('Escape');
    await c.close();
  }
  // 2. The project: the trail, the header, and the four views, each with its tasks.
  step(2);
  {
    const c = await context('admin'), page = await open(c, project, 'admin project');
    await seen(page.getByRole('navigation', { name: 'Where this project sits' }).getByRole('link', { name: 'Register the synthetic company' }));
    await seen(page.getByRole('heading', { name: 'Synthetic incorporation' }));
    await seen(page.getByRole('link', { name: 'Tasks', exact: false }).first());
    await seen(page.getByRole('link', { name: 'Book the name and send the details' }));
    assert.equal(await page.getByText('Client package').count(), 0, 'no client-package words on an internal project'); checks++;
    assert.equal(await page.getByText(/Fulfil?ment/).count(), 0, 'no fulfilment words on an internal project'); checks++;
    await fits(page, 'project list 1440');
    await shot(page, '03-project-list-1440');
    for (const [view, name] of [['board', 'Board'], ['timeline', 'Timeline'], ['calendar', 'Calendar']]) {
      await page.getByRole('navigation', { name: 'Show the tasks as' }).getByRole('link', { name }).click();
      await page.waitForURL(new RegExp(`view=${view}`), { timeout: 120000 });
      const t = page.getByText('Write the vesting terms').first();
      await seen(t);
      const box = await t.boundingBox(); assert.ok(box && box.height > 4 && box.width > 20, `${name}: the task is drawn, not in a box of no height`); checks++;
      await fits(page, `project ${view} 1440`);
      await shot(page, `04-project-${view}-1440`);
    }
    for (const [tab, text, file] of [['Overview', 'Coming up', '05-project-overview-1440'], ['Files', 'Synthetic filing sheet', '06-project-files-1440'], ['Activity', /added “|added \d+ tasks|made \d+ changes/, '07-project-activity-1440']]) {
      await page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name: new RegExp(`^${tab}`) }).click();
      await seen(page.getByText(text));
      await fits(page, `project ${tab} 1440`);
      await shot(page, file);
    }
    await c.close();
  }
  // 3. A task shows where it sits: Goals › goal › project › parent (as the person doing it).
  step(3);
  {
    const m = await context('member'), page = await open(m, `/tasks/${E.book}`, 'member task');
    const trail = page.getByRole('navigation', { name: 'Where this task sits' });
    await seen(trail.getByRole('link', { name: 'Register the synthetic company' }));
    await seen(trail.getByRole('link', { name: 'Synthetic incorporation' }));
    // The parent task is the pod head's: a member does not see it, so the trail stops at the project for them.
    await fits(page, 'task 1440');
    await shot(page, '08-task-1440');
    await m.close();
    // An internal project never opens as a client package.
    const c = await context('admin'), p2 = await c.newPage(); await p2.goto(`${base}/projects/${E.project}`, { waitUntil: 'load', timeout: 300000 });
    await p2.waitForURL(new RegExp(`/tasks/projects/${E.project}`), { timeout: 120000 }); checks++;
    await c.close();
  }
  // 4. Projects: the AI-started one is not in the list until you look under Started by AI.
  step(4);
  {
    const c = await context('admin'), page = await open(c, '/tasks?view=projects', 'admin projects');
    await seen(page.getByRole('link', { name: 'Synthetic incorporation' }));
    assert.equal(await page.getByRole('link', { name: 'Synthetic Drive storage' }).count(), 0, 'an AI-started project is not in the main list'); checks++;
    // The task finished on the goal page (step 2) is no longer late anywhere, before the delays sync runs.
    assert.equal(await page.getByRole('complementary').getByRole('link', { name: 'Consult the CA on cost' }).count(), 0, 'a finished task is not listed as late'); checks++;
    await fits(page, 'projects 1440');
    await shot(page, '09-projects-1440');
    await page.getByRole('link', { name: /Started by AI/ }).click();
    await seen(page.getByRole('link', { name: 'Synthetic Drive storage' }));
    await shot(page, '10-projects-ai-1440');
    await c.close();
  }
  // 5. The pod head (a manager) at 1440, and dark.
  step(5);
  {
    const c = await context('head', 1440, 'dark');
    for (const [path, name, file] of [[goal, 'Register the synthetic company', '11-head-goal-1440-dark'], [project, 'Synthetic incorporation', '12-head-project-1440-dark'], [`${project}?view=board`, 'Synthetic incorporation', '13-head-board-1440-dark']]) {
      const page = await open(c, path, `head ${file}`);
      await seen(page.getByRole('heading', { name }));
      await fits(page, file);
      await shot(page, file);
      await page.close();
    }
    await c.close();
  }
  // 6. A member on a phone: My work by goal, the goal, the project's list and board, a task.
  step(6);
  {
    const c = await context('member', 390);
    let page = await open(c, '/tasks', 'member my work');
    await seen(page.getByRole('region', { name: 'Register the synthetic company' }));
    await seen(page.getByRole('link', { name: 'Open the bank account' }));
    await fits(page, 'my work 390');
    await shot(page, '14-member-mywork-390');
    for (const [path, name, file] of [[goal, 'Register the synthetic company', '15-member-goal-390'], [project, 'Synthetic incorporation', '16-member-project-390'],
      [`${project}?view=board`, 'Synthetic incorporation', '17-member-board-390'], [`${project}?view=calendar`, 'Synthetic incorporation', '18-member-calendar-390'], [`${project}?tab=overview`, 'Synthetic incorporation', '19-member-overview-390'],
      [`/tasks/${E.book}`, 'Book the name and send the details', '20-member-task-390']]) {
      page = await open(c, path, `member ${file}`);
      await seen(page.getByRole('heading', { name }));
      await fits(page, file);
      await shot(page, file);
      await page.close();
    }
    // One click from the phone: the member finishes their own task on the goal page.
    page = await open(c, goal, 'member goal tick');
    await page.getByRole('button', { name: 'Mark “Open the bank account” done' }).click();
    await seen(page.locator('[data-undo-here] [title^="Done: Open the bank account"]'));
    await c.close();
  }
  // 7. Dark, phone: the owner's goal and project.
  step(7);
  {
    const c = await context('admin', 390, 'dark');
    for (const [path, name, file] of [[goal, 'Register the synthetic company', '21-goal-390-dark'], [project, 'Synthetic incorporation', '22-project-390-dark']]) {
      const page = await open(c, path, file);
      await seen(page.getByRole('heading', { name }));
      await fits(page, file);
      await shot(page, file);
      await page.close();
    }
    await c.close();
  }
  // 8. Live (owner, round 2: "open screens update within ~1-2 s with no reload"): the member has the project open; the
  // owner adds a task for them through the API; it shows on the open page without a reload.
  step(8);
  {
    const c = await context('member'), page = await open(c, project, 'live project');
    await expect(page.locator('[data-work-live="on"]')).toHaveCount(1, { timeout: 120000 }); checks++;
    await page.evaluate(() => { window.__sameLoad = 'yes'; });
    const t0 = Date.now();
    await call('admin', 'tasks', { title: 'Synthetic live check: sign the bank form', projectId: E.project, assigneeId: E.editor });
    await expect(page.getByText('Synthetic live check: sign the bank form').first()).toBeVisible({ timeout: 20000 }); checks++;
    const ms = Date.now() - t0;
    assert.equal(await page.evaluate(() => window.__sameLoad), 'yes', 'the page updated in place, not by a reload'); checks++;
    console.log(`live: the owner's new task showed on the member's open project page after ${ms} ms`);
    if (shots) (await import('node:fs')).writeFileSync(`${shots}/live.txt`, `the owner's new task showed on the member's open project page after ${ms} ms, without a reload\n`);
    await c.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`WORK-SPINE OK: ${checks} checks passed`);
} catch (e) {
  console.error(`work-spine-browser-runner failed at step ${current}: ${e.stack ?? e}`);
  console.error(`work changed answers per page: ${JSON.stringify([...changedCount])}`);
  if (last && shots) await last.screenshot({ path: `${shots}/failed-${current}.png`, timeout: 120000 }).catch((x) => console.error(`no failure shot: ${x}`));
  if (serverTail) console.error(`next dev: ${serverTail.slice(-1200)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => null);
  await stopServer(); await app.close().catch(() => null); await pool.end().catch(() => null);
  clearTimeout(deadline);
}
