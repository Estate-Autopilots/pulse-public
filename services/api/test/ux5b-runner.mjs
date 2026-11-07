// UX-5B: the task companion in the browser on a production build, through the real API, on a disposable synthetic
// company (tests/core/test_ux5b.py::test_ux5b_flows_in_the_browser). The owner's example end to end: Go there →
// spotlight → save the office network → the companion lights up → two arrivals → Pulse marks it done, with Undo. Every
// flow is reported by name. Optional: PULSE_UX5B_EVIDENCE=<dir> (screenshots of failing flows, the report) and
// PULSE_UX5B_SHOTS=<dir> (the screens at 1440 and 390 px, light and dark, through the unstyled-page gate).
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const workerPool = new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS);
const emails = { admin: process.env.TEST_ADMIN, hr: process.env.TEST_HR, member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD };
const evidence = process.env.PULSE_UX5B_EVIDENCE; if (evidence) await mkdir(evidence, { recursive: true });
const shotsDir = process.env.PULSE_UX5B_SHOTS; if (shotsDir) await mkdir(shotsDir, { recursive: true });
const only = (process.env.UX5B_ONLY ?? '').split(',').filter(Boolean);
const call = async (path, body, role = 'hr', expected = 200) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body}`); return r.json();
};
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const { shot } = await import('../../../tests/e2e/tasks4b-gate.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0' }, stdio: 'ignore' });
let browser; const results = []; let checks = 0;
const posted = (page, path) => { const w = page.waitForResponse((r) => (typeof path === 'string' ? r.url().endsWith(`/api/v0/${path}`) : path.test(r.url())) && r.request().method() === 'POST', { timeout: 30000 }); w.catch(() => null); return w; };
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(300); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
const pages = {};
async function flow(name, run) {
  if (only.length && !only.includes(name)) { results.push({ name, ok: true, skipped: true }); return; }
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (e) {
    const error = String(e?.message ?? e).split('\n').slice(0, 6).join(' | ').slice(0, 900);
    results.push({ name, ok: false, error, ms: Date.now() - started }); console.log(`FAIL ${name}: ${error}`);
    if (evidence) for (const [role, p] of Object.entries(pages)) if (!p.isClosed()) await p.screenshot({ path: `${evidence}/fail-${name}-${role}.png` }).catch(() => null);
  }
}
const as = async (role, width = 1440, extra = {}) => {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] }, ...extra });
  const page = await ctx.newPage(); pages[`${role}-${width}${extra.reducedMotion ? '-still' : ''}`] = page;
  page.on('pageerror', (e) => console.log(`PAGEERROR ${role} ${e.message.slice(0, 200)}`));
  return page;
};
const OWNER = 'Add the office Wi-Fi and IP in Office presence, and test arrival check-in with 2 people';
const given = async (title, to, extra = {}) => (await call('work/tasks', { title, assigneeId: to, ...extra }, 'admin')).id;
const companion = (page) => page.getByRole('complementary', { name: 'Task companion' });
const task = (id, role = 'admin') => call(`tasks/${id}`, undefined, role);
/** A phone recognises the office and checks someone in (the worker's presence path: no viewer). */
async function arrive(person, office) {
  const c = await workerPool.connect();
  try {
    await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [E.org]);
    const e = (await c.query("insert into pulse.attendance_entry(org_id,person_id,mode) values($1,$2,'office') returning id,work_date::text", [E.org, person])).rows[0];
    await c.query(`insert into pulse.attendance_event(org_id,person_id,work_date,kind,signals,office_id,entry_id,device_kind) values($1,$2,$3,'auto_check_in','{wifi,geofence}',$4,$5,'phone')`, [E.org, person, e.work_date, office, e.id]);
    // Checked out again, so the same person can arrive twice (one open check-in a person).
    await c.query('update pulse.attendance_entry set checked_out_at=now() where id=$1', [e.id]);
    await c.query('commit');
  } catch (err) { await c.query('rollback'); throw err; } finally { c.release(); }
}
/** Ask the companion to look again now (it also does on focus and every half minute). */
const nudge = (page) => page.evaluate(() => window.dispatchEvent(new Event('pulse:data-changed')));

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 159) throw Error('web did not start'); }
  browser = await chromium.launch({ headless: true });
  let owner = null, office = null;

  // The owner's example, end to end on a computer.
  await flow('owner-example', async () => {
    const hr = await as('hr');
    owner = await given(OWNER, E.hr);
    await go(hr, `/tasks/${owner}`);
    const goBtn = hr.getByRole('button', { name: 'Go to Office presence' });
    await expect(goBtn).toBeVisible();
    const proposal = hr.getByRole('region', { name: 'Pip: done when' });
    await expect(proposal).toContainText('Office Wi-Fi and IP saved');
    await expect(proposal).toContainText('2 people checked in on arriving at the office');
    const confirmed = posted(hr, `tasks/${owner}/companion`); await proposal.getByRole('button', { name: 'Confirm' }).click();
    const body = JSON.parse((await confirmed).request().postData());
    ok(body.signals.length === 2 && body.signals[1].need === 2 && body.signals[1].distinct === 'subject' && body.signals[0].where.ip_count.gte === 1, 'one tap confirms both signals');
    await expect(hr.getByRole('region', { name: 'Done when' })).toContainText('0 of 2 happened');
    // Go there: the task starts, the page opens, the place is spotlit (no office yet: "add the office first").
    const started = posted(hr, `tasks/${owner}/move`); await goBtn.click();
    ok(JSON.parse((await started).request().postData()).status === 'in_progress', 'going there starts the task');
    await expect(hr).toHaveURL(/\/hr\?tab=policies&view=presence$/, { timeout: 20000 });
    const lit = hr.locator('[data-spotlight]');
    await expect(lit).toHaveAttribute('data-dest', 'hr.policies.presence.office', { timeout: 15000 });
    await expect(hr.locator('[data-coach]')).toContainText('First: add the office and its location here. Office Wi-Fi goes in it.');
    await expect(companion(hr).getByRole('button', { name: /^Task: Add the office Wi-Fi and IP/ })).toBeVisible();
    // Save the office with its Wi-Fi and IP.
    await hr.getByRole('button', { name: 'Add an office' }).click();
    await hr.getByRole('textbox', { name: 'Name' }).fill('Synthetic studio');
    await hr.getByRole('textbox', { name: /^Location/ }).fill('12.9716, 77.5946');
    await hr.getByRole('textbox', { name: /Office public IP/ }).fill('203.0.113.10/32');
    await hr.getByRole('button', { name: 'Add a Wi-Fi network' }).click();
    await hr.getByRole('textbox', { name: 'Wi-Fi name (SSID)' }).fill('EA-Studio');
    const saved = posted(hr, 'hr/presence'); await hr.getByRole('button', { name: 'Save office presence' }).click();
    ok((await saved).status() === 200, 'office presence saved');
    // The companion lights up: one tap would mark it done; not yet (two people must still arrive).
    const bubble = hr.getByRole('region', { name: 'Connected to your task' });
    await expect(bubble).toContainText('You saved the office Wi-Fi and IP.', { timeout: 15000 });
    await expect(bubble).toContainText('Mark “Add the office Wi-Fi and IP');
    ok(await companion(hr).getAttribute('data-lit') !== null, 'the companion is lit');
    const seen = posted(hr, `tasks/${owner}/companion/seen`); await bubble.getByRole('button', { name: 'Not yet' }).click(); await seen;
    await expect(bubble).toBeHidden();
    office = (await call('hr/presence', undefined, 'hr')).offices[0].id;
    ok((await task(owner)).task.status === 'in_progress', 'not done on a guess');
    // Two different people arrive: every signal met exactly, so Pulse marks it done and says so, with Undo.
    await arrive(E.member, office); await arrive(E.member, office);
    ok((await task(owner)).task.status === 'in_progress', 'the same person twice counts once');
    await arrive(E.head, office);
    ok((await task(owner)).task.status === 'done', 'Pulse marked it done');
    await nudge(hr);
    const told = hr.getByRole('region', { name: 'Pulse finished a task' });
    await expect(told).toContainText('Pulse marked “Add the office Wi-Fi and IP', { timeout: 15000 });
    await expect(told).toContainText('Office Wi-Fi and IP saved; 2 people checked in on arriving at the office');
    const history = (await task(owner)).events.find((e) => e.kind === 'auto_done');
    ok(history && !history.byId, 'the history says Pulse did it');
    // Undo from the companion: back to Doing, and it stops finishing itself.
    const undone = posted(hr, `tasks/${owner}/auto-done/undo`); await told.getByRole('button', { name: 'Undo' }).click();
    ok((await undone).status() === 200, 'undone');
    ok((await task(owner)).task.status === 'in_progress', 'back to Doing');
    ok((await call(`tasks/${owner}/companion`, undefined, 'hr')).companion.autoDone === false, 'it asks next time');
  });

  // A place without signals: changing it lights the companion up; one tap marks the task done, Undo takes it back.
  await flow('one-tap-done-and-undo', async () => {
    const hr = await as('hr');
    const cutoff = await given('Set the payroll cut-off day', E.hr);
    await go(hr, `/tasks/${cutoff}`);
    await hr.getByRole('button', { name: 'Go to Check-in settings' }).click();
    await expect(hr).toHaveURL(/\/hr\?tab=onboard&view=settings$/, { timeout: 20000 });
    await expect(hr.locator('[data-spotlight]')).toHaveAttribute('data-dest', 'hr.onboard.settings.cutoff', { timeout: 15000 });
    await expect(hr.locator('[data-coach]')).toContainText('Pick the payroll cut-off day here');
    const saved = posted(hr, 'hr/checkin-settings'); await hr.getByRole('button', { name: /^Attendance closes for payroll on:/ }).click(); await hr.getByRole('option', { name: 'day 5 of each month', exact: true }).click(); await saved;
    const bubble = hr.getByRole('region', { name: 'Connected to your task' });
    await expect(bubble).toContainText('You saved the payroll cut-off. Mark “Set the payroll cut-off day” done?', { timeout: 15000 });
    const moved = posted(hr, `tasks/${cutoff}/move`); await bubble.getByRole('button', { name: 'Mark done' }).click();
    ok(JSON.parse((await moved).request().postData()).status === 'done', 'one tap');
    ok((await task(cutoff)).task.status === 'done', 'done');
    const back = posted(hr, `tasks/${cutoff}/move`); await hr.getByRole('button', { name: 'Undo' }).click();
    ok(JSON.parse((await back).request().postData()).status === 'in_progress', 'Undo puts it back');
  });

  // The companion stays with the person: other pages, steps ticked anywhere, and the task beside the page.
  await flow('companion-travels-and-beside', async () => {
    const hr = await as('hr');
    const steps = await given('Send the welcome kit to new joiners', E.hr, { notes: '1. Open Pulse → HR → Onboard team → Rollout kit.\n2. Check the draft.\n3. Send it.' });
    await go(hr, `/tasks/${steps}`);
    // v0.3.66 train (18 Oct): the companion hears "Keep it with me" only once it is hydrated; on a busy machine an early
    // click was lost and /me had no companion. Click again (at most 4 times) until the companion holds the task.
    for (let i = 0; ; i++) {
      await hr.getByRole('button', { name: 'Keep it with me' }).click();
      if (await hr.waitForFunction((id) => (sessionStorage.getItem('pulse.companion') ?? '').includes(id), steps, { timeout: 3000 }).then(() => true, () => false)) break;
      if (i === 3) throw Error('the companion never took the task');
    }
    await go(hr, '/me');
    await expect(companion(hr)).toContainText('Send the welcome kit');
    // "Keep it with me" opens the card; a pill opens it too.
    const small = companion(hr).getByRole('button', { name: /^Task: Send the welcome kit/ }); if (await small.isVisible()) await small.click();
    const card = companion(hr).getByRole('region', { name: /^Task: Send the welcome kit/ });
    await expect(card.getByRole('checkbox', { name: /^Step 2: Check the draft/ })).toBeVisible();
    const ticked = posted(hr, `tasks/${steps}/checks`); await card.getByRole('checkbox', { name: /^Step 2/ }).click(); await ticked;
    await expect(card.getByRole('checkbox', { name: /^Step 2/ })).toHaveAttribute('aria-checked', 'true');
    await go(hr, '/tasks');
    await expect(companion(hr)).toBeVisible();
    const pill = companion(hr).getByRole('button', { name: /^Task: Send the welcome kit/ }); if (await pill.isVisible()) await pill.click();
    await hr.getByRole('button', { name: 'Open beside the page' }).click();
    const pane = hr.getByRole('complementary', { name: /^Task beside the page/ });
    await expect(pane).toBeVisible();
    const margin = await hr.evaluate(() => parseFloat(getComputedStyle(document.body).marginRight));
    ok(Math.round(margin) === 400, `the page makes room (${margin})`);
    await pane.getByRole('separator', { name: 'Resize the task pane' }).focus(); await hr.keyboard.press('ArrowLeft');
    ok(Math.round(await hr.evaluate(() => parseFloat(getComputedStyle(document.body).marginRight))) === 424, 'resized with the keyboard');
    await pane.getByRole('button', { name: /^Close the pane/ }).click();
    await expect(pane).toBeHidden();
    ok(await hr.evaluate(() => !document.documentElement.hasAttribute('data-beside')), 'the page takes its room back');
  });

  // On a phone: the spotlight and coach mark sit in view, the companion above the tab bar.
  await flow('phone-go-there', async () => {
    const phone = await as('hr', 390);
    const wifi = await given('Add the guest Wi-Fi in Office presence', E.hr);
    await go(phone, `/tasks/${wifi}`);
    await phone.getByRole('button', { name: 'Go to Office presence' }).click();
    await expect(phone.locator('[data-spotlight]')).toHaveAttribute('data-dest', 'hr.policies.presence.wifi', { timeout: 15000 });
    await phone.waitForTimeout(900);
    const box = await phone.locator('[data-spotlight]').boundingBox();
    ok(box && box.y >= 0 && box.y + Math.min(box.height, 200) <= 844, `the Wi-Fi is in view (${JSON.stringify(box)})`);
    const coach = await phone.locator('[data-coach]').boundingBox();
    ok(coach && coach.x >= 0 && coach.x + coach.width <= 390, 'the coach mark fits the screen');
    const pill = await companion(phone).boundingBox(); const nav = await phone.getByRole('navigation', { name: 'Mobile navigation' }).boundingBox();
    ok(pill && nav && pill.y + pill.height <= nav.y + 1, 'the companion sits above the tab bar');
  });

  // Reduced motion: it jumps and glows, without pulsing.
  await flow('reduced-motion', async () => {
    const still = await as('hr', 1440, { reducedMotion: 'reduce' });
    const t = await given('Check the office IP in Office presence', E.hr);
    await go(still, `/tasks/${t}`);
    await still.getByRole('button', { name: 'Go to Office presence' }).click();
    await expect(still.locator('[data-spotlight]')).toHaveAttribute('data-spotlight', 'still', { timeout: 15000 });
    ok(await still.locator('[data-spotlight]').evaluate((el) => getComputedStyle(el).animationName) === 'none', 'no pulse');
  });

  // The registry's anchors are on their pages.
  await flow('anchors-present', async () => {
    const hr = await as('hr');
    await go(hr, '/hr?tab=policies&view=presence');
    for (const id of ['hr.policies.presence.auto', 'hr.policies.presence.office', 'hr.policies.presence.ip', 'hr.policies.presence.wifi', 'hr.policies.presence'])
      await expect(hr.locator(`[data-dest="${id}"]`).first()).toBeAttached();
    await go(hr, '/hr?tab=onboard&view=settings');
    for (const id of ['hr.onboard.settings.arrival', 'hr.onboard.settings.reminders', 'hr.onboard.settings.cutoff', 'hr.onboard.settings.profiles'])
      await expect(hr.locator(`[data-dest="${id}"]`)).toBeAttached();
    ok(true, 'anchors');
  });

  // Priority: importance and effort, one line of why; how Pip worked it out; never a value (INTEGRITY 0910).
  await flow('value-priority', async () => {
    const admin = await as('admin');
    const t = await given('Edit 3 reels for the Northstar launch', E.member, { dueOn: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10) });
    await call(`work/tasks/${t}/suggest`, {}, 'admin');
    await go(admin, `/tasks/${t}`);
    const card = admin.getByRole('region', { name: 'Priority' });
    await expect(card).toContainText(/Pip: .*about /);
    await card.getByRole('button', { name: /How was this worked out/ }).click();
    ok(await card.getByText(/\d+\s*(pts?|points)|Cost of delay/).count() === 0, 'no value or cost of delay');
  });

  if (shotsDir) await flow('screens', async () => {
    const proposal = await given(OWNER, E.hr);
    const watching = await given('Add the guest Wi-Fi and IP in Office presence', E.hr);
    await call(`tasks/${watching}/companion`, { signals: [{ event: 'office.network.saved', label: 'Office Wi-Fi and IP saved', where: { wifi_count: { gte: 1 }, ip_count: { gte: 1 } } }, { event: 'attendance.office.arrived', label: '2 people checked in on arriving at the office', need: 2, distinct: 'subject' }], autoDone: true }, 'hr');
    // HR saves a guest network once, so the watching task has something to light up for.
    let guest = false;
    const guestWifi = async () => {
      if (guest) return; guest = true;
      const now = await call('hr/presence', undefined, 'hr');
      const offices = now.offices.map((o) => ({ id: o.id, name: o.name, lat: o.lat, lng: o.lng, radius: o.radius, publicIpRanges: o.publicIpRanges ?? [], wifi: [...o.wifi, { ssid: 'EA-Guest', bssids: [] }] }));
      await call('hr/presence', { offices, autoCheckIn: now.autoCheckIn, sites: now.sites, dwellMinutes: now.dwellMinutes, leaveMinutes: now.leaveMinutes }, 'hr');
    };
    const keep = async (p, id, view = 'pill') => { await p.evaluate(([t, v]) => sessionStorage.setItem('pulse.companion', JSON.stringify({ task: t, view: v, beside: false, width: 400 })), [id, view]); await p.reload({ waitUntil: 'load' }); await p.waitForTimeout(1500); };
    const SHOTS = [
      ['task-go-there', `/tasks/${proposal}`, 'hr'],
      ['task-done-when', `/tasks/${watching}`, 'hr'],
      ['spotlight', `/hr?tab=policies&view=presence&go=hr.policies.presence.wifi&task=${watching}`, 'hr', async (p) => { await p.locator('[data-coach]').waitFor({ timeout: 15000 }); }],
      ['companion-card', '/me', 'hr', async (p) => keep(p, watching, 'card')],
      ['companion-lit', '/hr?tab=policies&view=presence', 'hr', async (p) => { await guestWifi(); await keep(p, watching); await p.getByRole('region', { name: /Connected to your task|Pulse finished a task/ }).waitFor({ timeout: 15000 }); }],
      ['beside', '/tasks', 'hr', async (p) => { await p.evaluate((t) => sessionStorage.setItem('pulse.companion', JSON.stringify({ task: t, view: 'card', beside: true, width: 400 })), watching); await p.reload({ waitUntil: 'load' }); await p.waitForTimeout(1500); }],
      ['value-priority', `/tasks/${proposal}`, 'admin', async (p) => { await p.getByRole('region', { name: 'Priority' }).getByRole('button', { name: /How was this worked out/ }).click().catch(() => null); }],
    ];
    const failedShots = [];
    for (const [name, path, role, prepare] of SHOTS) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      if (name === 'beside' && width < 1100) continue;
      const r = await shot(browser, { base, path, email: emails[role], width, theme, out: shotsDir, name, prepare });
      if (r.problems.length) failedShots.push(`${name} ${width} ${theme}: ${r.problems.slice(0, 2).join(' | ')}`);
      console.log(`${r.problems.length ? 'GATE' : 'shot'} ${name} ${width} ${theme}${r.problems.length ? `: ${r.problems.slice(0, 2).join(' | ')}` : ''}`);
    }
    ok(!failedShots.length, `unstyled-page gate: ${failedShots.join(' ; ')}`);
  });

  const failed = results.filter((r) => !r.ok);
  const report = { results, checks, failed: failed.map((r) => r.name) };
  if (process.env.PULSE_UX5B_REPORT) await writeFile(process.env.PULSE_UX5B_REPORT, JSON.stringify(report, null, 1));
  if (evidence) await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 1));
  console.log(`${results.filter((r) => r.ok && !r.skipped).length} passed, ${failed.length} failed, ${checks} checks`);
  if (failed.length) process.exitCode = 1;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); await workerPool.end(); }
