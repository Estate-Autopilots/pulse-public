// CHAT-GROUPS in the browser (tests/core/test_chat_groups_browser.py): the Groups tab by category (sections, New group,
// requests waiting), New group's second step (category, icon and colour, rules), Group info's settings, group requests,
// Ask for a group (a member where managers make groups), Settings → Chats, Report a bug with "Post in Bugs and support",
// the bug's post in Bugs and support, and a project's "Start the project's team chat". On a disposable synthetic company
// (the real API, the web app under next dev). Phone 390, tablet 834, laptop 1440, light and dark; no sideways scroll, no
// page errors. Screenshots with PULSE_CG_SCREENSHOTS=<dir>. Preamble from pm-chat-board-browser-runner.mjs. Nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_CG_SCREENSHOTS, observe = process.env.OBSERVE === '1';
if (shots) mkdirSync(shots, { recursive: true });
const emails = { admin: 'admin@estateautopilots.com', editor: E.editor };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-cg', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const deadline = setTimeout(() => { console.error(`chat-groups-browser-runner: no result after 38 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 38 * 60_000);
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


const SIZES = [[390, 'light'], [834, 'light'], [1440, 'light'], [390, 'dark'], [834, 'dark'], [1440, 'dark']];
// A tap made before the page has hydrated does nothing: tap again (up to three times) until what it opens shows.
const tapUntil = async (button, target) => { for (let i = 0; i < 3; i++) { await button.first().click(); try { await target.first().waitFor({ state: 'visible', timeout: 8000 }); return; } catch { /* not yet */ } } };
const groupsTab = async (c) => { await c.addInitScript(() => { try { localStorage.setItem('pulse.chats.section', 'groups'); } catch { /* none */ } }); };
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  const list = await call('admin', 'chats');
  const byName = Object.fromEntries(list.channels.map((c) => [c.name, c]));
  check(byName['Company news']?.category === 'announcements' && byName['Company news']?.posting === 'admins', `Company news is an announcements group (${JSON.stringify(byName['Company news'] ?? null).slice(0, 160)})`);
  check(byName['Bugs and support']?.category === 'bugs', 'Bugs and support is in the list, under its category');
  check(byName['Orchid Towers launch']?.category === 'projects' && byName['Orchid Towers launch']?.projectId === E.project, 'the project\'s team chat is under Projects');
  check(byName['Orchid Realty × Studio']?.category === 'clients', 'the client\'s group is under Clients');
  check(byName['Friday lunch']?.category == null, 'a group nobody filed is in Other groups');
  check(list.groups?.creators === 'managers' && list.groups?.canCreate === true && list.groups?.requests?.waiting === 1, `the admin's group context (${JSON.stringify(list.groups ?? null).slice(0, 200)})`);
  const theirs = await call('editor', 'chats');
  check(theirs.groups?.canCreate === false && theirs.groups?.requests?.mine === 1, 'the editor asks for groups and has one waiting');
  fact(`categories: ${list.groups.categories.map((c) => c.id).join(', ')}`);

  for (const [width, theme] of SIZES) {
    const phone = width < 600, tag = `${width}-${theme}`;
    // 1. The Groups tab: a section per category, New group on top, the request waiting for the admin.
    step(`1-groups-${tag}`);
    let c = await context('admin', width, theme); await groupsTab(c);
    let page = await open(c, '/chats', `groups ${tag}`);
    await seen(page.locator('[data-group-section="announcements"]'), 'the Announcements section');
    for (const k of ['projects', 'teams', 'clients', 'bugs', 'other']) await seen(page.locator(`[data-group-section="${k}"]`), `the ${k} section`);
    await seen(page.locator('[data-new-group="make"]'), 'New group on top');
    await seen(page.locator('[data-requests-waiting="1"]'), 'the request waiting for the admin');
    const order = await page.locator('[data-group-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-section')));
    check(order.indexOf('announcements') < order.indexOf('projects') && order.at(-1) === 'other', `sections in the company's order (${order.join(', ')})`);
    await fits(page, `groups ${tag}`);
    await shot(page, `01-groups-${tag}`, false);
    // Folding a section keeps it folded.
    await tapUntil(page.locator('[data-section-toggle="clients"]'), page.locator('[data-section-toggle="clients"][aria-expanded="false"]'));
    check(await page.locator('[data-group-section="clients"] [data-chat-row]').count() === 0, 'Clients folds');
    await page.locator('[data-section-toggle="clients"]').click();
    // 2. New group, step 2: the name, the look, the category and the rules.
    step(`2-new-${tag}`);
    await tapUntil(page.locator('[data-new-group="make"]'), page.getByRole('heading', { name: 'Add group members' }));
    await seen(page.getByRole('heading', { name: 'Add group members' }), 'New group: members');
    await page.getByRole('button', { name: /Rifob Das/ }).first().click();
    await page.getByRole('button', { name: 'Next' }).click();
    await seen(page.getByRole('heading', { name: 'New group' }), 'New group: details');
    await page.getByRole('textbox', { name: /Group name/ }).fill('Launch crew');
    await page.locator('[data-category="projects"]').first().click();
    await page.evaluate(() => document.querySelector('[data-chat-list] [class*="groupForm"]')?.scrollTo(0, 0));
    await fits(page, `new group ${tag}`);
    await shot(page, `02-new-group-${tag}`, false);
    await page.locator('[data-more-options]').click();
    await seen(page.getByRole('radiogroup', { name: 'Who adds people' }), 'who adds people');
    await seen(page.getByRole('radiogroup', { name: 'Who sends messages' }), 'who sends messages');
    await c.close();
    // 3. Group info: the category, the icon, the rules and notifications (the admin's own announcements group).
    step(`3-info-${tag}`);
    c = await context('admin', width, theme); page = await open(c, `/chats?channel=${E.news}`, `info ${tag}`);
    await seen(page.getByRole('button', { name: 'Company news: details and members' }), 'the conversation header');
    const settings = page.locator('[data-group-settings]');
    await tapUntil(page.getByRole('button', { name: 'Company news: details and members' }), settings);
    await seen(settings, 'Group info: settings');
    await seen(settings.getByText('Announcements'), 'the category in Group info');
    check(await settings.getByRole('radio', { name: 'Only admins' }).getAttribute('aria-checked') === 'true', 'only admins send messages here');
    await settings.scrollIntoViewIfNeeded();
    await fits(page, `info ${tag}`);
    await shot(page, `03-group-info-${tag}`, false);
    await c.close();
    // 4. Group requests: the editor's request, waiting for the admin's answer.
    step(`4-requests-${tag}`);
    c = await context('admin', width, theme); page = await open(c, '/chats?requests=1', `requests ${tag}`);
    await seen(page.locator('[data-group-requests]'), 'the group requests');
    await seen(page.getByText('Edit room'), 'the request');
    await seen(page.getByRole('button', { name: 'Approve' }), 'Approve');
    await seen(page.getByRole('button', { name: 'Decline' }), 'Decline');
    await fits(page, `requests ${tag}`);
    await shot(page, `04-requests-${tag}`, false);
    await c.close();
    // 5. A member where managers and leadership make groups: Ask for a group.
    step(`5-ask-${tag}`);
    c = await context('editor', width, theme); await groupsTab(c); page = await open(c, '/chats', `ask ${tag}`);
    await seen(page.locator('[data-new-group="ask"]'), 'Ask for a group');
    await seen(page.locator('[data-groups-top]').getByText('A manager or leadership approves it'), 'who approves, in words');
    await fits(page, `ask ${tag}`);
    await shot(page, `05-ask-${tag}`, false);
    // 6. The bug's post in Bugs and support, with its picture and its thread.
    step(`6-bugs-${tag}`);
    await page.goto(`${base}/chats?channel=${E.bugs}`, { waitUntil: 'load', timeout: 300000 });
    await seen(page.getByText(/Bug #1 on the Tasks page/), 'the bug\'s post');
    await seen(page.locator('[data-thread-chip]'), 'its thread (1 reply)');
    await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 30000 }).catch(() => null);
    await fits(page, `bugs ${tag}`);
    await shot(page, `06-bugs-${tag}`, false);
    // 7. Report a bug: "Post in Bugs and support", on by default, with the picture switch.
    step(`7-report-${tag}`);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pulse:report-bug', { detail: null })));
    await seen(page.locator('[data-bug-share]'), 'Post in Bugs and support');
    check(await page.getByRole('switch', { name: 'Post in Bugs and support' }).getAttribute('aria-checked') !== 'false', 'posting is on by default');
    await page.locator('[data-bug-share]').scrollIntoViewIfNeeded();
    await shot(page, `07-report-${tag}`, false);
    await c.close();
    // 8. Settings → Chats: who may make groups, and the categories.
    step(`8-settings-${tag}`);
    c = await context('admin', width, theme); page = await open(c, '/settings?tab=chats', `settings ${tag}`);
    await seen(page.getByRole('group', { name: 'Groups can be made by' }), 'who may make groups');
    await seen(page.locator('[data-group-categories]'), 'the categories');
    await seen(page.locator('[data-category="' + list.groups.categories.find((x) => !x.builtin).id + '"]'), 'the company\'s own category');
    await fits(page, `settings ${tag}`);
    await shot(page, `08-settings-${tag}`, false);
    // 9. A project with no group yet: "Start the project's team chat".
    step(`9-project-${tag}`);
    await page.goto(`${base}/projects/${E.empty}?tab=chats`, { waitUntil: 'load', timeout: 300000 });
    // next dev compiles this large page on its first visit; a read that waited too long is read again (as a person would).
    if (!(await page.locator('[data-project-group]').first().waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false))) await page.reload({ waitUntil: 'load', timeout: 300000 });
    await seen(page.locator('[data-project-group]'), 'Start the project\'s team chat');
    await fits(page, `project ${tag}`);
    await shot(page, `09-project-${tag}`, false);
    // Pressed on the last size only: after it the project has its team chat, and the page lists it instead (no second one).
    if (width === 1440 && theme === 'dark') {
      for (let i = 0; i < 3 && !/\/chats\?channel=/.test(page.url()); i++) { await page.locator('[data-project-group]').first().click(); await page.waitForURL(/\/chats\?channel=/, { timeout: 60000 }).catch(() => null); }
      check(/\/chats\?channel=/.test(page.url()), `the button opens the new team chat (${page.url()})`);
      await seen(page.getByRole('button', { name: /Sunrise Heights: details and members/ }), 'the new team chat opens');
      const again = await call('admin', `projects/${E.empty}/group`, {});
      check(again.made === false && page.url().includes(again.id), 'pressing again opens the same team chat (never a second one)');
    }
    await c.close();
    if (phone && theme === 'light') fact('phone walk done');
  }
  check(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  if (shots) writeFileSync(`${shots}/facts.txt`, `${facts.join('\n')}\n${issues.length ? `ISSUES\n${issues.join('\n')}\n` : ''}`);
  console.log(`CHAT-GROUPS OK: ${checks} checks${issues.length ? `, ${issues.length} issues` : ''}`);
} catch (e) {
  if (last && shots) await shot(last, `fail-${current}`, false).catch(() => null);
  console.error(`chat-groups-browser-runner failed at ${current}: ${e.stack ?? e}`);
  if (shots) writeFileSync(`${shots}/findings.txt`, `${facts.join('\n')}\n\nISSUES (${issues.length}):\n${issues.join('\n')}\n\nFAILED at ${current}: ${e.message}\n`);
  if (serverTail) console.error(`next dev: ${serverTail.slice(-1200)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => null); await stopServer(); await app.close().catch(() => null); await pool.end().catch(() => null);
  clearTimeout(deadline);
}
