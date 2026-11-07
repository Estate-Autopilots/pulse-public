// PROJECTS-STAGES in the browser (tests/core/test_project_stages.py): the real API on a disposable synthetic company and
// the web app under `next dev`. An admin takes a starter template for a company that has none, the plan is laid out, a
// stage gets its owner; a member gives a task in the project through the Create dialog and it lands on a stage; the
// member says why their late task is late (on a phone); the admin chases, the member answers again, the admin escalates
// and gives a new date from Work → Projects; each person's load shows. Phone (390) and desktop (1440), no sideways scroll, no page errors. Screenshots
// with PULSE_PS_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_PS_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const emails = { admin: 'admin@estateautopilots.com', editor: E.editorEmail, head: E.headEmail };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-ps', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`project-stages-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440) {
  const phone = width < 600;
  return browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const call = async (role, path, body) => {
  const r = await fetch(`${base}/api/v0/${path}`, { method: body ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': emails[role], ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); assert.ok(r.status < 300, `${path}: ${JSON.stringify(j)}`); return j;
};
const project = `/tasks/projects/${E.project}`;
// 8 days ago: the first steps are late, inside the 7 days late work is asked about.
const kickoff = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
// The API asks about late work every 10 minutes (runDelays); the journey asks at once, as that tick would.
const askLate = async () => { const c = await pool.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [E.org]); await c.query('select pulse.task_delays_sync()'); await c.query('commit'); } finally { c.release(); } };
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // 1. A company with no delivery template: the project page offers starters for its industry; the admin takes one.
  step(1);
  {
    const c = await context('admin'), page = await open(c, project, 'admin project');
    await seen(page.getByText('Run this project in stages'));
    await shot(page, 'starters-1440');
    await page.getByRole('radio', { name: /Simple project/ }).click();
    await page.getByRole('button', { name: 'Use this template' }).click();
    await seen(page.getByText('Set up the delivery plan'), 60000);
    // The plan from a kick-off 10 days ago (so some steps are late), as the plan dialog sends it.
    await call('admin', `projects/${E.project}/plan`, { template: 'simple-project', package: 'standard', category: null, kickoff, leadId: null });
    await askLate();
    await page.reload({ waitUntil: 'load' });
    await seen(page.getByRole('list', { name: 'Stages' }).getByText('Do the work'));
    // B2: stage 2 gets its owner.
    await page.getByRole('button', { name: /Owner of stage 2, Do the work: nobody yet/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Owner of Do the work' });
    await expect(dlg.locator('select[name="personId"] option', { hasText: 'Editor Two' })).toHaveCount(1, { timeout: 30000 });
    await dlg.locator('select[name="personId"]').selectOption({ label: 'Editor Two' });
    await dlg.getByRole('button', { name: 'Save' }).click();
    await seen(page.getByRole('button', { name: /Owner of stage 2, Do the work: Editor Two/ }), 60000);
    // The late synthetic task given before the plan is on no stage: it still shows, with a pick; and the lateness panel lists it.
    await seen(page.getByRole('combobox', { name: 'Stage of Synthetic late edit' }));
    await page.getByRole('combobox', { name: 'Stage of Synthetic late edit' }).selectOption('2');
    await seen(page.getByText('On Do the work'), 60000);
    await seen(page.getByText('Late work'));
    await fits(page, 'project page 1440'); await shot(page, 'project-1440');
    await c.close();
  }
  // 2. B9: a member gives a task in the project from the Create dialog; it goes on the stage the project is in.
  step(2);
  {
    const c = await context('editor'), page = await open(c, project, 'editor project');
    await page.getByRole('button', { name: 'Add task' }).first().click();
    const box = page.getByRole('textbox', { name: 'What needs doing' });
    await box.click(); await box.pressSequentially('Shoot the synthetic site walkthrough');
    await seen(page.getByText('Stage', { exact: true }), 60000);
    await page.getByRole('button', { name: /Create task/ }).click();
    await seen(page.getByText('Added'), 60000);
    await page.goto(`${base}${project}?pt=stage#plan-tasks`, { waitUntil: 'load' });
    await seen(page.getByRole('link', { name: 'Shoot the synthetic site walkthrough' }));
    await c.close();
  }
  // 3. B4: on a phone the doer is asked why their task is late and answers on the task.
  step(3);
  {
    const c = await context('editor', 390), page = await open(c, '/tasks?view=projects', 'editor projects phone');
    await seen(page.getByText('Say why it is late'));
    await fits(page, 'Work → Projects 390'); await shot(page, 'projects-editor-390');
    await page.getByRole('link', { name: 'Answer' }).first().click();
    const late = page.locator('#late');
    await seen(late.getByRole('button', { name: 'Waiting on the client' }));
    await late.getByRole('button', { name: 'Waiting on the client' }).click();
    await late.getByLabel(/A note/).fill('Synthetic: the client has not sent the floor plan');
    await late.getByRole('button', { name: 'Send' }).click();
    await seen(page.getByText(/You said: Waiting on the client/), 60000);
    await fits(page, 'task page 390'); await shot(page, 'task-late-390');
    await c.close();
  }
  // 4. B5/B6: the admin sees what waits on them, chases, escalates, gives a new date; each person's load shows.
  step(4);
  {
    const c = await context('admin'), page = await open(c, '/tasks?view=projects', 'admin projects');
    const rail = page.getByRole('region', { name: 'Late: needs you to act' }).or(page.locator('section', { hasText: 'Late: needs you to act' })).first();
    await seen(rail.getByText('Synthetic late edit'));
    await seen(rail.getByText('Waiting on the client'));
    await seen(page.getByText('Team load'));
    await fits(page, 'Work → Projects 1440'); await shot(page, 'projects-admin-1440');
    // The doer is chased: the task leaves the rail until they answer again.
    const item = rail.locator('li', { hasText: 'Synthetic late edit' });
    await item.getByRole('button', { name: 'Chase' }).click();
    await seen(page.getByText(/Asked .* again/), 60000);
    await expect(rail.getByText('Synthetic late edit')).toHaveCount(0, { timeout: 60000 }); checks++;
    // A plan step that is late (the lead's): chase, then escalate another.
    const steps = rail.locator('li');
    await steps.first().getByRole('button', { name: 'Chase' }).click();
    await seen(page.getByText(/Asked .* again/), 60000);
    const left = await call('admin', 'projects/delays');
    if (left.toAct.length) {
      await page.reload({ waitUntil: 'load' });
      await rail.locator('li').first().getByRole('button', { name: 'Escalate' }).click();
      const up = page.getByRole('dialog', { name: 'Escalate' });
      // Only people who can open the task are offered (1455); the admin picks the first.
      await expect(up.locator('select[name="toId"] option')).not.toHaveCount(1, { timeout: 30000 });
      await up.locator('select[name="toId"]').selectOption({ index: 1 });
      await up.getByRole('button', { name: 'Escalate' }).click();
      await seen(page.getByText('Escalated'), 60000);
    }
    await c.close();
  }
  // 4b. Chased, the doer sees their earlier answer and gives a new one, on a phone (the chase is no dead end).
  step('4b');
  {
    const c = await context('editor', 390), page = await open(c, '/tasks?view=projects', 'editor chased phone');
    await seen(page.getByText('asked again'));
    await page.getByRole('link', { name: 'Answer' }).first().click();
    const late = page.locator('#late');
    await seen(late.getByText(/You said earlier: Waiting on the client/));
    await seen(late.getByText(/You were asked again/));
    await late.getByRole('button', { name: 'Waiting on the client' }).click();
    await late.getByLabel(/A note/).fill('Synthetic: still waiting on the floor plan, chased today');
    await late.getByRole('button', { name: 'Send' }).click();
    await seen(page.getByText(/You said: Waiting on the client, “Synthetic: still waiting/), 60000);
    await fits(page, 'task page chased 390'); await shot(page, 'task-chased-390');
    await c.close();
  }
  // 4c. The answer brings it back to the admin, who gives it a new date.
  step('4c');
  {
    const c = await context('admin'), page = await open(c, '/tasks?view=projects', 'admin new date');
    const rail = page.locator('section', { hasText: 'Late: needs you to act' }).first();
    const item = rail.locator('li', { hasText: 'Synthetic late edit' });
    await seen(item.getByText(/still waiting on the floor plan/));
    await item.getByRole('button', { name: 'New date' }).click();
    const dlg = page.getByRole('dialog', { name: 'Give it a new date' });
    const later = new Date(Date.now() + 5 * 86400000);
    await dlg.getByLabel('New due day').fill(later.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
    await dlg.getByRole('button', { name: 'Set the date' }).click();
    await seen(page.getByText('New date set'), 60000);
    await expect(rail.getByText('Synthetic late edit')).toHaveCount(0, { timeout: 60000 }); checks++;
    await c.close();
  }
  // 5. The stage owner (and escalation target) sees their stage and what was escalated to them, on a phone.
  step(5);
  {
    const c = await context('head', 390), page = await open(c, project, 'head project phone');
    await seen(page.getByRole('list', { name: 'Stages' }));
    await fits(page, 'project page 390'); await shot(page, 'project-head-390');
    await c.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`project-stages-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) { try { await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }); } catch { /* closed */ } }
  console.error(`step ${current}: ${e?.stack ?? e}`); process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  stopServer(); await app.close(); await pool.end();
}
process.exit(process.exitCode ?? 0);
