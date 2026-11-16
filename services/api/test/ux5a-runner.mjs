// UX-5A in the browser on a production build, through the real API, on a disposable synthetic agency
// (tests/core/test_ux5a.py::test_ux5a_flows_in_the_browser): the shared drawer, accepting work from every entry point
// (no points since INTEGRITY 0910), checking in on approved leave, My desk, the Attendance tab's day-off action, Ctrl+K and
// the layout-shift gate. Every flow is reported by name. Optional: PULSE_UX5A_EVIDENCE=<dir> (a screenshot of every
// failing flow) and PULSE_UX5A_SHOTS=<dir> (the screens at 1440 and 390 px, light and dark, through the unstyled-page and
// layout-shift gates). UX5A_ONLY / UX5A_SKIP pick flows.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS);
const emails = { member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD, outsider: process.env.TEST_OUTSIDER_EMAIL, hr: 'hr@estateautopilots.com', admin: 'admin@estateautopilots.com' };
const evidence = process.env.PULSE_UX5A_EVIDENCE; if (evidence) await mkdir(evidence, { recursive: true });
const shotsDir = process.env.PULSE_UX5A_SHOTS; if (shotsDir) await mkdir(shotsDir, { recursive: true });
const only = (process.env.UX5A_ONLY ?? '').split(',').filter(Boolean), skip = (process.env.UX5A_SKIP ?? '').split(',').filter(Boolean);
const call = async (path, body, role = 'member', expected = 200) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body}`); return r.json();
};
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const { STYLE_AUDIT } = await import('../../../tests/e2e/style-gate.mjs');
const { SHIFT_RECORDER, SHIFTS, settleShifts, LOAD_LIMIT, CLICK_LIMIT } = await import('../../../tests/e2e/layout-shift.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) console.log(`WEB ${s.slice(0, 300)}`); });
let browser; const results = []; let checks = 0;
const posted = (page, path, extra = () => true) => {
  const waiting = page.waitForResponse((r) => (typeof path === 'string' ? r.url().endsWith(`/api/v0/${path}`) : path.test(r.url())) && r.request().method() === 'POST' && extra(r), { timeout: 30000 });
  waiting.catch(() => null);
  return waiting;
};
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await settleShifts(page, 700, 6000); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
const after = async (page, act) => { const t = await page.evaluate(() => performance.now()); await act(); await settleShifts(page); return page.evaluate(SHIFTS, { since: t, all: true }); };
const said = (s) => `${s.score}: ${s.shifts.slice(0, 3).map((x) => `${x.value} ${x.where.join(', ')}`).join(' | ')}`;
const pages = {};
async function flow(name, run) {
  if ((only.length && !only.includes(name)) || skip.includes(name)) { results.push({ name, ok: true, skipped: true }); return; }
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (e) {
    const error = String(e?.message ?? e).split('\n').slice(0, 6).join(' | ').slice(0, 900);
    results.push({ name, ok: false, error, ms: Date.now() - started }); console.log(`FAIL ${name}: ${error}`);
    if (evidence) for (const [role, p] of Object.entries(pages)) if (!p.isClosed()) await p.screenshot({ path: `${evidence}/fail-${name}-${role}.png` }).catch(() => null);
  }
}
const as = async (role, width = 1440, theme = 'light') => {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await ctx.addInitScript(SHIFT_RECORDER);
  await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
  const page = await ctx.newPage(); pages[`${role}-${width}`] = page;
  page.on('pageerror', (e) => console.log(`PAGEERROR ${role} ${e.message.slice(0, 200)}`));
  return page;
};
/** A task given by `by` to `toId`, valued, and finished by its doer. */
async function finished(title, value, by = 'head', doer = 'member') {
  const toId = (await call('me', undefined, doer)).person;
  const t = await call('work/tasks', { title, assigneeId: toId, ...(value ? { valuePoints: value } : {}) }, by);
  await call(`tasks/${t.id}/move`, { status: 'done' }, doer);
  return t.id;
}
/** Approved leave today for `role` (asked by them, decided by HR). */
async function onLeaveToday(role) {
  const self = await call('hr/self', undefined, role);
  const kind = (self.leave.types.find((t) => t.paid) ?? self.leave.types[0]).key;
  const asked = await call('leave', { kind, fromDate: E.today, toDate: E.today, reason: 'Synthetic leave today' }, role);
  await call(`hr/flows/${asked.flowId}/decision`, { action: 'approved', note: 'Synthetic approval' }, 'hr');
  return asked.id;
}

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 159) throw Error('web did not start'); }
  browser = await chromium.launch({ headless: true });
  const me = { member: (await call('me', undefined, 'member')).person, head: (await call('me', undefined, 'head')).person };

  // 1. Accepting work is one rating; no points anywhere (INTEGRITY 0910). Every entry point.
  await flow('accept-from-a-list-row', async () => {
    const id = await finished('Colour pass on the Lakeview teaser', 6);
    const head = await as('head');
    await go(head, '/tasks?scope=me');
    const row = head.getByRole('listitem').filter({ hasText: 'Colour pass on the Lakeview teaser' }).first();
    await row.getByRole('button', { name: /^(Review|Accept)$/ }).click();
    const dlg = head.getByRole('dialog', { name: /^Accept .*’s work$/ });
    await expect(dlg).toBeVisible();
    ok(await dlg.getByText(/\d+\s*(pts?|points)/).count() === 0, 'no points shown (INTEGRITY: tasks carry no value)');
    ok(await dlg.locator('input[type=number], select, input[type=range]').count() === 0 && await dlg.getByText(/^(Effort|Impact)\b/).count() === 0, 'no effort, impact or value-points field');
    await dlg.getByRole('radio', { name: 'Great' }).click();
    await dlg.getByRole('switch', { name: 'Above and beyond' }).check();
    ok(await dlg.getByText(/\d+\s*(pts?|points)/).count() === 0, 'no points shown (INTEGRITY: tasks carry no value)');
    const accepted = posted(head, `tasks/${id}/accept`); await dlg.getByRole('button', { name: 'Accept', exact: true }).click();
    ok((await accepted).status() === 200, 'accepted from the drawer');
    const d = await call(`tasks/${id}`, undefined, 'head');
    ok(d.task.status === 'accepted' && !d.life?.credit, `nothing credited: ${JSON.stringify(d.life?.credit)}`);
  });
  await flow('accept-on-the-task-page', async () => {
    const id = await finished('Write the Lakeview caption', 5);
    const head = await as('head');
    await go(head, `/tasks/${id}`);
    const bar = head.getByRole('group', { name: /^Review .*’s work$/ });
    ok(await bar.getByText(/\d+\s*(pts?|points)/).count() === 0, 'no points shown (INTEGRITY: tasks carry no value)');
    ok(await bar.locator('input[type=number], select, input[type=range]').count() === 0, 'no effort or impact on the task page');
    const accepted = posted(head, `tasks/${id}/accept`); await bar.getByRole('button', { name: 'Accept' }).click();
    ok((await accepted).status() === 200, 'accepted on the task page');
  });
  await flow('accept-in-notifications-and-reviews', async () => {
    const a = await finished('Export the Lakeview stills', 4), b = await finished('Sort the Lakeview raw files', 3);
    const head = await as('head');
    await go(head, '/notifications');
    const row = head.locator('li').filter({ hasText: 'Export the Lakeview stills' }).first();
    ok(await row.getByText(/\d+\s*(pts?|points)/).count() === 0, 'no points shown (INTEGRITY: tasks carry no value)');
    ok(await row.getByRole('combobox').count() === 0, 'no dropdowns on the notification');
    const accepted = posted(head, `tasks/${a}/accept`); await row.getByRole('button', { name: 'Accept' }).click();
    ok((await accepted).status() === 200, 'accepted from Notifications');
    await go(head, '/tasks?view=reviews');
    const r2 = head.getByRole('listitem').filter({ hasText: 'Sort the Lakeview raw files' }).first();
    ok(await r2.getByText(/\d+\s*(pts?|points)/).count() === 0, 'no points shown (INTEGRITY: tasks carry no value)');
    const acc2 = posted(head, `tasks/${b}/accept`); await r2.getByRole('button', { name: 'Accept' }).click();
    ok((await acc2).status() === 200, 'accepted from Reviews');
  });
  await flow('accept-from-the-bell', async () => {
    await finished('Grade the Lakeview drone shots', 7);
    const head = await as('head');
    await go(head, '/tasks?scope=me');
    await head.getByRole('button', { name: /^Notifications/ }).first().click();
    const card = head.locator('[data-card]').filter({ hasText: 'Grade the Lakeview drone shots' }).first();
    ok(await card.getByText(/\d+\s*(pts?|points)/).count() === 0, 'no points shown (INTEGRITY: tasks carry no value)');
    await expect(card.getByRole('radio', { name: 'Good' })).toBeVisible();
  });

  // 2. The one drawer: header, scrolling body, sticky footer, Escape and focus; a sheet on a phone.
  await flow('drawer-anatomy', async () => {
    for (const width of [1440, 390]) {
      const p = await as('member', width);
      await go(p, '/me?tab=requests');
      const open = p.getByRole('button', { name: 'Raise a request' }).first();
      const s = await after(p, () => open.click());
      ok(s.score <= CLICK_LIMIT, `opening a drawer moves nothing (${width}): ${said(s)}`);
      const dlg = p.getByRole('dialog', { name: 'Raise a request with HR' });
      await expect(dlg.getByRole('heading', { level: 2, name: 'Raise a request with HR' })).toBeVisible();
      await expect(dlg.getByRole('button', { name: 'About this', exact: true })).toBeVisible();   // "?" instead of a paragraph
      const box = await dlg.boundingBox(), vh = p.viewportSize().height;
      if (width < 600) ok(Math.abs(box.y + box.height - vh) <= 2, `a sheet on a phone: ${JSON.stringify(box)}`);
      else ok(box.x + box.width >= p.viewportSize().width - 12 && box.width <= 660, `a side panel on a computer: ${JSON.stringify(box)}`);
      const send = dlg.getByRole('button', { name: 'Send to HR' }); const sb = await send.boundingBox();
      ok(sb.y + sb.height <= box.y + box.height + 1, 'the primary action is in view (sticky footer)');
      await p.keyboard.press('Escape');
      await expect(dlg).toHaveCount(0);
      await expect(open).toBeFocused();
    }
  });

  // 6. Checking in on a day of approved leave asks first; it never cancels the leave silently.
  await flow('leave-checkin-cancels-today-only', async () => {
    const leave = await onLeaveToday('member');
    const p = await as('member');
    await go(p, '/me');
    const today = p.getByRole('region', { name: 'Today' });
    await today.getByRole('button', { name: 'Check in' }).click();
    const ask = p.getByText('You’re on leave today.');
    await expect(ask).toBeVisible();
    const checked = posted(p, 'attendance/check-in');
    await p.getByRole('button', { name: 'Cancel today’s leave and check in' }).click();
    const r = await checked; ok(r.status() === 200 && (await r.json()).leave === 'cancelled', 'checked in; today’s leave cancelled');
    const self = await call('hr/self', undefined, 'member');
    ok(self.now.state === 'in' && self.now.leaveCheckIn?.decision === 'cancelled', `now: ${JSON.stringify(self.now)}`);
    ok(self.leave.requests.find((l) => l.id === leave)?.status === 'cancelled', 'the leave day is cancelled');
    await call('attendance/check-out', {}, 'member');
  });
  await flow('leave-checkin-kept-for-hr', async () => {
    const leave = await onLeaveToday('head');
    const p = await as('head');
    await go(p, '/me');
    await p.getByRole('region', { name: 'Today' }).getByRole('button', { name: 'Check in' }).click();
    const checked = posted(p, 'attendance/check-in');
    await p.getByRole('button', { name: 'Check in, keep the leave' }).click();
    const r = await checked; ok(r.status() === 200 && (await r.json()).leave === 'kept', 'checked in; the leave kept for HR');
    const self = await call('hr/self', undefined, 'head');
    ok(self.leave.requests.find((l) => l.id === leave)?.status === 'approved', 'the leave stays approved');
    ok(self.tickets.some((t) => /^Checked in on approved leave/.test(t.subject)), 'HR has it to decide');
    await call('attendance/check-out', {}, 'head');
    // A phone that cannot ask: the check-in is recorded and HR decides (no leave is cancelled).
    await onLeaveToday('outsider');
    const phone = await call('attendance/check-in', { mode: 'office', via: 'android' }, 'outsider');
    ok(phone.leave === 'kept', `a phone check-in keeps the leave: ${JSON.stringify(phone)}`);
    await call('attendance/check-out', {}, 'outsider');
  });

  // 2. My desk: today, due today and waiting for you on top; the week; compact tiles; what Pulse knows on the profile.
  await flow('my-desk-in-order', async () => {
    for (const width of [1440, 390]) {
      const p = await as('member', width);
      await go(p, '/me');
      const load = await p.evaluate(SHIFTS, { since: 0 });
      ok(load.score <= LOAD_LIMIT, `My desk does not move while it loads (${width}): ${said(load)}`);
      const home = p.locator('[data-my-pulse]');
      // Owner workbench (21 Oct 2026): what is due and what waits for the person are one card, titled Today and named
      // "Due today" (the check-in is the "Today" region); its "Waiting for you" list shows only when something waits.
      for (const name of ['Today', 'Due today', 'My week', 'Recognition', 'My growth', 'My money', 'Time off', 'Requests with HR', 'Coming up'])
        await expect(home.getByRole('region', { name, exact: true })).toBeVisible();
      ok(await home.getByRole('region', { name: 'What Pulse knows about me' }).count() === 0, 'what Pulse knows moved to the profile');
      const top = await home.getByRole('region', { name: 'Due today', exact: true }).boundingBox(), week = await home.getByRole('region', { name: 'My week' }).boundingBox();
      ok(top.y < week.y, 'due today and waiting for you come before the week');
      await home.getByRole('region', { name: 'Time off' }).getByRole('button', { name: /^Time off/ }).click();
      await expect(p.getByRole('dialog', { name: 'Time off' })).toBeVisible();
      await p.keyboard.press('Escape');
    }
    const p = await as('member');
    await go(p, `/people/${me.member}?tab=info`);
    const knows = p.getByRole('region', { name: 'What Pulse knows about me' });
    await expect(knows).toBeVisible();
    await knows.getByRole('button', { name: /: not right\?$/ }).first().click();
    const fix = p.getByRole('dialog', { name: /: not right\?$/ });
    await fix.getByRole('textbox', { name: 'What it should be' }).fill('Senior video editor');
    const sent = posted(p, 'me/corrections'); await fix.getByRole('button', { name: 'Send to HR' }).click();
    ok((await sent).status() === 200, 'a correction goes to HR from the profile');
  });

  // 3. The Attendance tab: working on a day off is an action that opens a small drawer; nothing moves.
  await flow('attendance-day-off-action', async () => {
    const p = await as('member');
    await go(p, '/me?tab=attendance');
    ok(await p.getByRole('heading', { name: 'Working on a day off?' }).count() === 0, 'no permanent day-off block');
    const action = p.getByRole('button', { name: 'Work on a day off…' });
    const opened = await after(p, () => action.click());
    ok(opened.score <= CLICK_LIMIT, `opening moves nothing: ${said(opened)}`);
    const dlg = p.getByRole('dialog', { name: 'Working on a day off?' });
    // Every day is a working day in this test company, so there may be no day off to ask for: the button says so.
    const go2 = dlg.getByRole('button', { name: /^I'll work on|^Choose a day/ });
    if (await go2.isEnabled()) {
      const asked = posted(p, 'hr/work-days');
      const s = await after(p, () => go2.click());
      ok((await asked).status() === 200, 'asked to work on a day off');
      ok(s.score <= CLICK_LIMIT, `asking moves nothing on the page: ${said(s)}`);
    }
  });

  // 5. Ctrl+K: "office" finds the Office presence settings (the exact section), the office Wi-Fi task, "Check in
  //    (office)", office people and places; local results in under 100 ms; a question gets Pip's reading.
  await flow('ctrl-k-office', async () => {
    const p = await as('hr');
    await go(p, '/dashboard');
    await expect(async () => { await p.keyboard.press('Control+k'); await expect(p.getByRole('dialog', { name: 'Search Pulse' })).toBeVisible({ timeout: 1000 }); }).toPass();
    const box = p.getByRole('dialog', { name: 'Search Pulse' });
    await p.waitForTimeout(800);   // the local lists load once
    const ms = await p.evaluate(() => new Promise((done) => {
      const input = document.querySelector('[role=dialog][aria-label="Search Pulse"] input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const t = performance.now();
      const mo = new MutationObserver(() => { if (document.querySelector('[role=option][aria-label="Office presence"]')) { mo.disconnect(); done(performance.now() - t); } });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true });
      set.call(input, 'office'); input.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    console.log(`ctrl-k local results in ${Math.round(ms)} ms`);
    ok(ms < 100, `local results under 100 ms (${Math.round(ms)})`);
    await expect(box.getByRole('option', { name: 'Office presence', exact: true })).toBeVisible();
    await expect(box.getByRole('option', { name: 'Check in (office)', exact: true })).toBeVisible();
    await expect(box.getByRole('option', { name: /Omoza Office/ })).toBeVisible();
    await expect(box.getByRole('option', { name: /office Wi-Fi name/ })).toBeVisible({ timeout: 15000 });
    await expect(box.getByRole('option', { name: /Main office \(synthetic\)/ })).toBeVisible({ timeout: 15000 });
    await box.getByRole('option', { name: 'Office presence', exact: true }).click();
    await p.waitForURL(/\/hr\?tab=policies&view=presence/);
    ok(/go=hr\.policies\.presence/.test(p.url()) || !/go=/.test(p.url()), 'opened at the exact section');
    await go(p, '/dashboard');
    await expect(async () => { await p.keyboard.press('Control+k'); await expect(p.getByRole('dialog', { name: 'Search Pulse' })).toBeVisible({ timeout: 1000 }); }).toPass();
    await p.getByRole('dialog', { name: 'Search Pulse' }).getByRole('combobox').fill('where do I add the office internet?');
    await expect(p.getByRole('option', { name: /^Pip: Office/ })).toBeVisible();
    // Staff: no HR settings, but the check-in.
    const s = await as('member');
    await go(s, '/dashboard');
    await expect(async () => { await s.keyboard.press('Control+k'); await expect(s.getByRole('dialog', { name: 'Search Pulse' })).toBeVisible({ timeout: 1000 }); }).toPass();
    await s.getByRole('dialog', { name: 'Search Pulse' }).getByRole('combobox').fill('office');
    await expect(s.getByRole('option', { name: 'Check in (office)', exact: true })).toBeVisible();
    ok(await s.getByRole('option', { name: 'Office presence', exact: true }).count() === 0, 'staff do not see HR settings');
  });

  if (shotsDir) await flow('screens', async () => {
    const SHOTS = [['me', '/me', 'member'], ['me-attendance', '/me?tab=attendance', 'member'], ['reviews', '/tasks?view=reviews', 'head'], ['profile-info', `/people/${me.member}?tab=info`, 'member']];
    const bad = [];
    for (const [name, path, role] of SHOTS) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      const p = await as(role, width, theme); await go(p, path);
      await p.screenshot({ path: `${shotsDir}/${name}-${width}-${theme}.png` });
      const audit = await p.evaluate(STYLE_AUDIT, { theme, width }); const load = await p.evaluate(SHIFTS, { since: 0 });
      if (load.score > LOAD_LIMIT) audit.problems.push(`layout shift ${said(load)}`);
      if (audit.problems.length) bad.push(`${name} ${width} ${theme}: ${audit.problems.slice(0, 3).join(' | ')}`);
      await p.context().close();
    }
    ok(!bad.length, bad.join('\n'));
  });
} finally {
  await browser?.close().catch(() => null); server.kill(); await app.close(); await pool.end();
  const failed = results.filter((r) => !r.ok);
  const report = { checks, flows: results.length, failed: failed.length, results };
  if (process.env.PULSE_UX5A_REPORT) await writeFile(process.env.PULSE_UX5A_REPORT, JSON.stringify(report, null, 1));
  console.log(`${results.length} flows, ${failed.length} failed, ${checks} checks`);
  process.exitCode = failed.length ? 1 : 0;
}
