// UX-TASKS screens through the real API and the built web app, on a disposable synthetic tenant
// (tests/core/test_work_structure.py::test_work_screens_in_the_browser). Optional screenshots: PULSE_WORK_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let apiChecks = 0, browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS);
const emails = { member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD, outsider: process.env.TEST_OUTSIDER_EMAIL, hr: 'hr@estateautopilots.com', admin: 'admin@estateautopilots.com' };
const shots = process.env.PULSE_WORK_SCREENSHOTS;
const call = async (path, body, role = 'member', expected = 200) => {
  apiChecks++; const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body}`); return r.json();
};
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0' }, stdio: 'ignore' });
let browser;
const check = (condition, msg) => { browserChecks++; assert.ok(condition, msg); };
const posted = (page, path, extra = () => true) => page.waitForResponse((r) => r.url().endsWith(`/api/v0/${path}`) && r.request().method() === 'POST' && extra(r), { timeout: 30000 });
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(300); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
// Owner workbench (21 Oct 2026): C opens the task form at once; Project on its "What to create" switch makes a project.
const toProject = (page) => page.getByRole('dialog', { name: 'New task' }).getByRole('radiogroup', { name: 'What to create' }).getByRole('radio', { name: 'Project' }).click();
const openCreate = async (page) => {
  await expect(async () => { await page.keyboard.press('c'); await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible({ timeout: 1500 }); }).toPass({ timeout: 20000 }); browserChecks++;
};
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 159) throw Error('Work browser web did not start'); }
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const ctx = {}; for (const role of Object.keys(emails)) ctx[role] = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
    // 1. A pod head gives a task in three fields: title, person, day, and it is assigned at once.
    const h = await ctx.head.newPage(); await go(h, '/tasks');
    await expect(h.getByRole('heading', { name: 'Work', exact: true, level: 2 })).toBeVisible(); browserChecks++;
    await openCreate(h);
    await h.getByRole('textbox', { name: 'What needs doing' }).fill(`Prep the shot list ${width}`);
    await h.getByRole('button', { name: /^Who does it:/ }).click();
    await h.getByRole('combobox', { name: 'Who does it' }).fill('Kabir'); await h.keyboard.press('Enter');
    await h.getByRole('button', { name: 'Today', exact: true }).click();
    const assigned = posted(h, 'work/tasks');
    await h.getByRole('button', { name: 'Assign to Kabir' }).click();
    const a = await (await assigned).json(); check(a.assigned === true && !a.asked, 'pod head assigns directly');
    await expect(h.getByText('Assigned to Kabir').first()).toBeVisible(); browserChecks++;
    const told = await call('work/notices?limit=50', undefined, 'member');
    assert.ok(told.rows.some((n) => n.eventType === 'task.assigned' && n.subject?.id === a.id), 'the assignee is told');
    // 2. A member asks someone outside their reach; the same button says so.
    const m = await ctx.member.newPage(); await go(m, '/tasks');
    await openCreate(m);
    await m.getByRole('textbox', { name: 'What needs doing' }).fill(`Check the music licence ${width}`);
    await m.getByRole('button', { name: /^Who does it:/ }).click();
    await m.getByRole('combobox', { name: 'Who does it' }).fill('Meera'); await m.keyboard.press('Enter');
    await expect(m.getByRole('button', { name: 'Ask Meera to take it' })).toBeVisible(); browserChecks++;
    const asked = posted(m, 'work/tasks'); await m.getByRole('button', { name: 'Ask Meera to take it' }).click();
    const q = await (await asked).json(); check(q.asked?.id && q.assigned === false, 'member asks instead of assigning');
    check(await fits(m), `create dialog fits at ${width}`);
    // 3. Meera answers from her notifications: Take it.
    const o = await ctx.outsider.newPage(); await go(o, '/notifications');
    const row = o.locator('li').filter({ hasText: `asks you to take “Check the music licence ${width}”` }).first();
    const took = posted(o, `work/asks/${q.asked.id}/accept`); await row.getByRole('button', { name: 'Take it' }).click();
    check((await took).status() === 200, 'accepted from the notification');
    assert.equal((await call(`tasks/${q.id}`, undefined, 'outsider')).task.assigneeId, E.outsider);
    check(await fits(o), `notifications fit at ${width}`);
    // 4. The pod head creates a project from a template and adds someone.
    await openCreate(h); await toProject(h);
    await h.getByRole('textbox', { name: 'Project name' }).fill(`Launch checklist ${width}`);
    await h.getByRole('button', { name: /^Add people:/ }).click(); await h.getByRole('combobox', { name: 'Add people' }).fill('Dev'); await h.keyboard.press('Enter'); await h.keyboard.press('Escape');
    await h.getByRole('radio', { name: 'Internal initiative' }).click();
    const made = posted(h, 'work/projects'); await h.getByRole('button', { name: 'Create project' }).click();
    const p = await (await made).json(); check(p.steps === 4 && p.added === 1, 'project created with its steps and person');
    await h.waitForURL(`**/tasks/projects/${p.id}`); await ready(h);
    // Owner workbench (21 Oct 2026): a new project's page opens on its tasks with the discussion beside them; what was
    // finished after what appears (folded) once something is finished.
    await expect(h.getByRole('region', { name: 'Discussion', exact: true })).toBeVisible(); browserChecks++;
    // 5. A comment with an @mention brings someone in.
    const box = h.getByRole('textbox', { name: 'Write a comment' });
    await box.click(); await box.pressSequentially('Please own the review @Kab'); await expect(h.getByRole('listbox', { name: 'Mention someone' })).toBeVisible(); browserChecks++;
    await h.keyboard.press('Enter'); await box.pressSequentially('thanks');
    const commented = posted(h, 'work/comments'); await h.getByRole('button', { name: 'Comment', exact: true }).click();
    check((await commented).status() === 200, 'comment posted');
    const said = (await call(`work/comments?project=${p.id}`, undefined, 'head')).rows.at(-1);
    assert.equal(said.body, 'Please own the review @Kabir Shah thanks', 'the mention lands where it was typed');
    const mention = await call('work/notices?limit=50', undefined, 'member');
    assert.ok(mention.rows.some((n) => n.eventType === 'project.mention' && n.subject?.id === p.id), 'the mentioned person is told');
    check(await fits(h), `project page fits at ${width}`);
    // 6. Leadership: the team dashboard, and filing an unplaced client package in one click.
    const ad = await ctx.admin.newPage(); await go(ad, '/tasks?view=team');
    await expect(ad.getByRole('heading', { name: /Act on today/ })).toBeVisible(); browserChecks++;
    await expect(ad.getByRole('heading', { name: /Finished per week/ })).toBeVisible(); browserChecks++;
    check(await fits(ad), `dashboard fits at ${width}`);
    if (width === 1440) {
      await go(ad, '/tasks?view=projects&review=1');
      const filing = ad.locator('li').filter({ hasText: 'Harbour Point' }).first();
      const filed = posted(ad, `work/review/${E.review}`); await filing.getByRole('button', { name: 'Internal', exact: true }).click();
      check((await filed).status() === 200, 'filed in one click');
      // 7. HR adjusts a rule inside its limits.
      const hrp = await ctx.hr.newPage(); await go(hrp, '/settings?tab=work-rules');
      const rule = posted(hrp, 'work/rules'); await hrp.getByLabel('Members: Assign tasks to others').selectOption('pod');
      check((await rule).status() === 200, 'HR changes a rule');
      assert.equal((await call('work/rules', undefined, 'member')).cells.find((c) => c.role === 'member' && c.action === 'task.assign').scope, 'pod');
      await call('work/rules', { role: 'member', action: 'task.assign', scope: 'self' }, 'hr');
    }
    for (const c of Object.values(ctx)) await c.close();
  }
  // Screenshots: the main screens in both widths and both themes, as leadership (and HR for the rules).
  if (shots) {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      const make = async (role) => { const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
        await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme); return c; };
      const admin = await make('admin'), hr = await make('hr'), member = await make('member');
      const page = await admin.newPage(); const hp = await hr.newPage(); const mp = await member.newPage();
      const shot = async (pg, name) => { await pg.screenshot({ path: `${shots}/${name}-${width}-${theme}.png` }); };
      await go(page, '/tasks?view=team'); await shot(page, '01-team-dashboard');
      await go(page, '/tasks'); await openCreate(page); await shot(page, '02-create-choice');
      await page.getByRole('textbox', { name: 'What needs doing' }).fill('Cut the teaser for Northstar');
      await page.getByRole('button', { name: /^Who does it:/ }).click(); await page.getByRole('combobox', { name: 'Who does it' }).fill('ka');
      await page.waitForTimeout(250); await shot(page, '03-create-task-people');
      await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Friday', exact: true }).click(); await shot(page, '04-create-task-ready');
      await page.keyboard.press('Escape'); await openCreate(page); await toProject(page);
      await page.getByRole('radio', { name: /Fulfilment/ }).click(); await page.waitForTimeout(200); await shot(page, '05-create-project-fulfilment');
      await page.keyboard.press('Escape');
      await go(page, '/tasks'); await shot(page, '06-my-tasks-with-asks');
      await go(page, '/tasks?view=projects'); await shot(page, '07-work-projects');
      await go(page, `/tasks/projects/${E.fulfilment}`); await shot(page, '08-fulfilment-project');
      await go(page, `/tasks/${E.task}`); await shot(page, '09-task-discussion');
      await go(page, `/projects/${E.fulfilment}`); await shot(page, '10-client-package');
      await go(page, '/projects'); await shot(page, '11-client-projects');
      await go(hp, '/settings?tab=work-rules'); await shot(hp, '12-who-can-do-what');
      await go(mp, '/notifications'); await shot(mp, '13-notifications-asks');
      await go(page, '/tasks?view=projects&review=1'); await shot(page, '14-filing-review');
      for (const c of [admin, hr, member]) await c.close();
    }
  }
  const receipt = JSON.stringify({ apiChecks, browserChecks });
  await writeFile(process.env.PULSE_WORK_REPORT, receipt); console.log(receipt);
} catch (e) {
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) console.error('PAGE', p.url().replace(base, ''), (await p.locator('main').innerText().catch(() => '')).slice(0, 600));
  throw e;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
