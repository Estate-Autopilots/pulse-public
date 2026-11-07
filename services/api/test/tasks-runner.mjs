// RT1 task screens through the real API and the built web app, on a disposable synthetic tenant (tests/core/test_tasks_rt1.py).
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let apiChecks = 0, browserChecks = 0;
const emails = { member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD, hr: 'hr@estateautopilots.com', admin: 'admin@estateautopilots.com' };
const shots = process.env.PULSE_TASKS_SCREENSHOTS;
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
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 119) throw Error('Task browser web did not start'); }
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const ctx = {}; for (const role of Object.keys(emails)) ctx[role] = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
    const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png` }); };
    // My tasks and quick add: one line, parsed in place, then a quiet celebration on Done.
    const m = await ctx.member.newPage();
    await m.goto(base + '/tasks');
    await expect(m.getByRole('heading', { name: 'Work', exact: true, level: 2 })).toBeVisible(); browserChecks++;
    // QA-1024 (R084, intended): on a phone Work opens with search and one "Filters · Me" chip; the status pick waits
    // behind it. UX-SIMPLE (28 Oct, 9b19b313, intended): one "Show" pick ("Which tasks": Open, Today, This week, …)
    // replaced the five status tabs.
    const show = m.getByRole('button', { name: /^Which tasks: Open/ });
    if (width <= 760) {
      await expect(show).toBeHidden(); browserChecks++;
      await m.getByRole('button', { name: /^Filters · Me/ }).click();
    }
    await expect(show).toBeVisible(); browserChecks++;
    const title = `Brochure copy ${width}`;
    // TASKS-4A: + Create is the one way to create (N opens a task); its title reads the line the quick add used to.
    const box = m.getByRole('textbox', { name: 'What needs doing' });
    await expect(async () => { await m.keyboard.press('n'); await expect(box).toBeVisible({ timeout: 1500 }); }).toPass({ timeout: 20000 });
    await box.fill(`${title} #Northstar fri !high`);
    await expect(m.getByText('Northstar', { exact: true }).first()).toBeVisible(); browserChecks++;
    const added = m.waitForResponse((r) => r.url().endsWith('/api/v0/work/tasks') && r.request().method() === 'POST');
    await box.press('Enter');
    check((await added).status() === 200, 'quick add creates the task');
    await expect(m.getByText(/^Added/).first()).toBeVisible(); browserChecks++;
    const mine = (await call('tasks/home')).rows; const created = mine.find((t) => t.title === title);
    assert.ok(created && created.priority === 'high' && created.projectName === 'Northstar', 'quick add parsed project and priority');
    check(await fits(m), `my tasks fit at ${width}`); await shot(m, 'my-tasks');
    await m.goto(base + `/tasks?view=all&q=${encodeURIComponent(title)}`);
    const moved = m.waitForResponse((r) => r.url().includes(`/api/v0/tasks/${created.id}/move`));
    // EST-997: the circle asks first; a second click (after a beat, so not a double click) marks it done.
    await m.getByRole('button', { name: `Mark “${title}” done` }).click();
    await m.waitForTimeout(350);
    await m.getByRole('button', { name: `Confirm: mark “${title}” done` }).click();
    check((await moved).status() === 200, 'circle asks, then marks done');
    await expect(m.getByText(/done this week/).first()).toBeVisible(); browserChecks++;
    // The board: drag on a desktop, the Move menu on a phone.
    const card = (await call('tasks', { title: `Board card ${width}` })).id;
    // TASKS-P0: one person's board groups by when; the drag between status columns is the By status view.
    await m.goto(base + '/tasks?view=board&scope=mine&group=status');
    await expect(m.getByRole('region', { name: 'To do' })).toBeAttached(); browserChecks++;
    await shot(m, 'board-before');
    const movedCard = m.waitForResponse((r) => r.url().includes(`/api/v0/tasks/${card}/move`));
    if (width === 1440) await m.getByRole('listitem', { name: new RegExp(`^Board card ${width}`) }).dragTo(m.getByRole('region', { name: 'Doing' }));
    else await m.getByRole('combobox', { name: `Move “Board card ${width}”` }).selectOption('doing');
    check((await movedCard).status() === 200, 'board move saved');
    assert.equal((await call(`tasks/${card}`)).task.status, 'in_progress');
    check(await fits(m), `board fits at ${width}`); await shot(m, 'board');
    // The task page: subtask, blocker, proof. Since the 21 Oct task page (ff4a25a7) the Proof section shows only once
    // proof exists or the project requires it, so the first link goes in through the API and the page adds the second.
    await call(`tasks/${card}/proof`, { url: 'https://github.com/synthetic/pulse/pull/6', label: 'First proof' });
    await m.goto(base + `/tasks/${card}`);
    await expect(m.getByRole('group', { name: 'Status' })).toBeVisible(); browserChecks++;
    await m.getByRole('textbox', { name: 'Add a subtask' }).fill('Proofread the copy');
    const sub = m.waitForResponse((r) => r.url().endsWith('/api/v0/tasks/quick') && r.request().method() === 'POST' && !r.request().postData()?.includes('"preview":true'));
    await m.getByRole('textbox', { name: 'Add a subtask' }).press('Enter'); check((await sub).status() === 200, 'subtask added');
    await m.getByRole('button', { name: 'Waiting on…' }).click();
    await m.getByLabel('Search tasks or describe a new one').fill(`Licence approval ${width}`);
    const blocked = m.waitForResponse((r) => r.url().endsWith(`/api/v0/tasks/${card}/block`));
    await m.getByRole('button', { name: 'New blocker task' }).click(); check((await blocked).status() === 200, 'blocker added');
    const proofs = m.getByRole('region', { name: 'Proof', exact: true });
    await proofs.getByRole('textbox', { name: 'Proof link' }).fill('https://github.com/synthetic/pulse/pull/7');
    const proof = m.waitForResponse((r) => r.url().endsWith(`/api/v0/tasks/${card}/proof`));
    await proofs.getByRole('button', { name: 'Add link' }).click(); check((await proof).status() === 200, 'proof link added');
    const detail = await call(`tasks/${card}`);
    assert.equal(detail.children.length, 1); assert.equal(detail.blockedBy.length, 1); assert.equal(detail.task.status, 'blocked'); assert.equal(detail.proof.length, 2);
    check(await fits(m), `task page fits at ${width}`); await shot(m, 'task');
    // One tap from the notification: the reviewer (pod head) accepts.
    const review = (await call('tasks', { title: `Ready to review ${width}` })).id;
    await call(`tasks/${review}/move`, { status: 'done' });
    const h = await ctx.head.newPage(); await h.goto(base + '/notifications');
    const row = h.locator('li').filter({ hasText: `Ready to accept: Ready to review ${width}` }).first();
    const accepted = h.waitForResponse((r) => r.url().endsWith(`/api/v0/tasks/${review}/accept`));
    await row.getByRole('button', { name: 'Accept' }).click(); check((await accepted).status() === 200, 'accepted from the notification');
    assert.equal((await call(`tasks/${review}`)).task.status, 'accepted');
    check(await fits(h), `notifications fit at ${width}`); await shot(h, 'notifications');
    // HR → Pod heads: cards, a searchable picker and a save bar that is always there.
    const hr = await ctx.hr.newPage(); await hr.goto(base + '/hr?tab=pods');
    const pod = width === 1440 ? 'Pod 1' : 'Pod 2';
    await hr.getByRole('region', { name: pod }).getByRole('button', { name: 'Add people' }).click();
    await hr.getByLabel('Search people').fill('Outsider'); await hr.getByRole('dialog').getByRole('button', { name: /Pod Two Outsider/ }).click();
    await hr.keyboard.press('Escape');
    const saved = hr.waitForResponse((r) => r.url().endsWith('/api/v0/hr/pods'));
    await hr.getByRole('button', { name: 'Save team assignments' }).click(); check((await saved).status() === 200, 'pods saved');
    await expect(hr.getByText('Saved', { exact: true }).first()).toBeVisible(); browserChecks++;
    check(await fits(hr), `pod cards fit at ${width}`); await shot(hr, 'pods');
    // Outcomes, the project page and what is blocking us.
    await m.goto(base + '/tasks/outcomes'); await expect(m.getByRole('heading', { name: 'My outcomes' })).toBeVisible(); browserChecks++;
    check(await fits(m), `outcomes fit at ${width}`); await shot(m, 'outcomes');
    await m.goto(base + `/tasks/projects/${process.env.TEST_PROJECT}`);
    // Owner workbench (21 Oct 2026): the project page opens on its tasks with the discussion beside them; what was
    // finished after what is folded there once something is finished (a summary, not a heading).
    await expect(m.getByRole('region', { name: 'Discussion', exact: true })).toBeVisible(); browserChecks++;
    await shot(m, 'project');
    const a = await ctx.admin.newPage(); await a.goto(base + '/tasks?view=blocking');
    await expect(a.getByText(`Licence approval ${width}`).first()).toBeVisible(); browserChecks++;
    check(await fits(a), `blocking view fits at ${width}`); await shot(a, 'blocking');
    for (const c of Object.values(ctx)) await c.close();
  }
  const receipt = JSON.stringify({ apiChecks, browserChecks });
  await writeFile(process.env.PULSE_TASKS_REPORT, receipt); console.log(receipt);
} catch (e) {
  // Show what the page said, without any synthetic identifiers beyond the fixture's own text.
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) console.error('PAGE', p.url().replace(base, ''), (await p.locator('main').innerText().catch(() => '')).slice(0, 600),
    '\nISLAND', await p.evaluate(() => { const i = document.querySelector('[data-island]'); return i ? `${i.hasAttribute('data-open') ? 'open' : 'at rest'}: ${i.textContent?.slice(0, 200)}` : 'none'; }).catch(() => ''));
  throw e;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
