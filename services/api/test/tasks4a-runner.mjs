// TASKS-4A: creating work and finding it, through the real API and the production web build, on a disposable synthetic
// agency (tests/core/test_tasks4a.py). + Create as the one way to create (N, the smart title, @ chips, pool toggle,
// date and time, kind), views everywhere (table edits, calendar moves, timeline, gallery, board groupings), the
// remembered view and "make it your default?", saved views and filters, a person's page, a project's views, and the
// company's word for a team. Every flow is reported by name. Evidence: PULSE_TASKS4A_EVIDENCE=<dir>.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS);
const emails = { member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD, outsider: process.env.TEST_OUTSIDER_EMAIL, dev: process.env.TEST_DEV, sana: process.env.TEST_SANA,
  hr: 'hr@estateautopilots.com', admin: 'admin@estateautopilots.com' };
const evidence = process.env.PULSE_TASKS4A_EVIDENCE; if (evidence) await mkdir(evidence, { recursive: true });
const only = (process.env.TASKS4A_ONLY ?? '').split(',').filter(Boolean);
const call = async (path, body, role = 'member', expected = 200) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body}`); return r.json();
};
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0' }, stdio: 'ignore' });
let browser; const results = []; let checks = 0;
const posted = (page, path, extra = () => true) => {
  const waiting = page.waitForResponse((r) => (typeof path === 'string' ? r.url().endsWith(`/api/v0/${path}`) : path.test(r.url())) && r.request().method() === 'POST' && extra(r), { timeout: 30000 });
  waiting.catch(() => null);
  return waiting;
};
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(300); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
// UX-SIMPLE (b63f8072): the six layouts are one "View" pick, not six radio buttons.
const pickView = async (page, label) => { await page.getByRole('button', { name: /^View: / }).click(); await page.getByRole('option', { name: label, exact: true }).click(); };
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
const as = async (role, width = 1440) => {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  const page = await ctx.newPage(); pages[`${role}-${width}`] = page;
  page.on('pageerror', (e) => console.log(`PAGEERROR ${role} ${e.message.slice(0, 200)}`));
  return page;
};
const task = (id, role = 'admin') => call(`tasks/${id}`, undefined, role);
/** N opens a new task straight away (+ Create is the one way to create). */
const newTask = async (page) => {
  const box = page.getByRole('textbox', { name: 'What needs doing' });
  // Retry only an unhandled shortcut (before hydration). Once CreateHost consumes N, a slow dialog must not
  // receive another N in its auto-focused title. Window runs after CreateHost's document keydown listener.
  await page.evaluate(() => {
    window.__taskShortcutHandled = false;
    window.__taskShortcutListener = (e) => { if (e.key === 'n' && e.defaultPrevented) window.__taskShortcutHandled = true; };
    window.addEventListener('keydown', window.__taskShortcutListener);
  });
  try {
    await expect(async () => {
      if (!(await page.evaluate(() => window.__taskShortcutHandled))) await page.keyboard.press('n');
      await expect(box).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20000 });
    await expect(box).toBeEmpty();
    return box;
  } finally {
    await page.evaluate(() => { window.removeEventListener('keydown', window.__taskShortcutListener); delete window.__taskShortcutListener; delete window.__taskShortcutHandled; });
  }
};
const dialog = (page) => page.getByRole('dialog', { name: /New task|New project|Create/ });
const istDay = (n = 0) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
// "fri" is this Friday, so today on a Friday: the line's rule (quick-parse.mjs) and the picker's "This Friday".
const friday = () => { const d = new Date(`${istDay()}T00:00:00Z`); const add = (5 - d.getUTCDay() + 7) % 7; return istDay(add); };

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 159) throw Error('web did not start'); }
  browser = await chromium.launch({ headless: true });
  const member = await as('member'), head = await as('head'), admin = await as('admin');

  // A handled N can take longer than the helper's first 1.5 s visibility attempt. The old retry typed another N
  // into the newly focused field. Cover that boundary, also when the first N precedes listener installation.
  await flow('shortcut-slow-dialog', async () => {
    for (const lateListener of [false, true]) {
      const probe = await browser.newPage();
      try {
        await probe.setContent('<main>Shortcut timing fixture</main>');
        await probe.evaluate((late) => {
          window.__shortcutOpens = 0;
          const install = () => document.addEventListener('keydown', (e) => {
            if (e.key !== 'n' || e.target.isContentEditable) return;
            e.preventDefault(); window.__shortcutOpens++;
            setTimeout(() => {
              const box = document.createElement('div'); box.contentEditable = 'true';
              box.setAttribute('role', 'textbox'); box.setAttribute('aria-label', 'What needs doing');
              document.body.append(box); box.focus();
            }, 1550);
          });
          if (late) window.addEventListener('keydown', install, { once: true }); else install();
        }, lateListener);
        const box = await newTask(probe);
        ok(await probe.evaluate(() => window.__shortcutOpens) === 1, 'only one handled N opens the delayed dialog');
        await box.pressSequentially('Cut the teaser for');
        await expect(box).toHaveText('Cut the teaser for'); checks++;
      } finally { await probe.close(); }
    }
  });

  // 1. The title reads the old quick-add line: @someone becomes a chip and sets Who; !priority, a day at the end and the
  //    project fill their fields; the saved title keeps only the words.
  await flow('create-smart-title', async () => {
    await go(head, '/tasks');
    const box = await newTask(head);
    await box.click(); await box.pressSequentially('Cut the teaser for @Sa', { delay: 30 });
    await head.getByRole('option', { name: /Sana Khan/ }).first().click();
    await expect(box.locator('[data-mention-id]')).toHaveCount(1);
    await expect(head.getByRole('button', { name: /^Who does it: Sana Khan/ })).toBeVisible(); checks++;
    await box.pressSequentially(' !high fri', { delay: 30 });
    await expect(dialog(head).getByText('from the title').first()).toBeVisible(); checks++;
    await expect(dialog(head).getByRole('radio', { name: /High/ })).toHaveAttribute('aria-checked', 'true'); checks++;
    await dialog(head).getByRole('button', { name: /^Project:/ }).click(); await head.getByRole('combobox', { name: 'Project' }).fill('Northstar'); await head.keyboard.press('Enter');
    const made = posted(head, 'work/tasks'); await box.press('Enter');
    const r = await (await made).json();
    const t = (await task(r.id, 'head')).task;
    ok(t.title === 'Cut the teaser for', `the chip at the end is who does it, not words (got “${t.title}”)`);
    ok(t.priority === 'high' && t.dueOn === friday() && /Northstar/.test(t.projectName ?? ''), `priority, Friday and project from the line (${t.priority} ${t.dueOn} ${t.projectName})`);
    ok(r.assigned ? t.assigneeId === E.sana : r.asked?.to === 'Sana Khan', 'Sana gets it, or is asked');
  });

  // 2. The owner's bug: from Pool back to a person stays on the task form.
  await flow('pool-back-stays-on-form', async () => {
    await go(head, '/tasks');
    const box = await newTask(head); await box.fill('Tidy the shared drive');
    await dialog(head).getByRole('button', { name: 'Pool', exact: true }).click();
    await expect(dialog(head).getByRole('button', { name: /^Which pool:/ })).toBeVisible(); checks++;
    await dialog(head).getByRole('button', { name: 'Pool', exact: true }).click();
    await expect(dialog(head).getByRole('button', { name: /^Who does it:/ })).toBeVisible(); checks++;
    ok((await box.innerText()).includes('Tidy the shared drive'), 'the title is still there');
    ok(await dialog(head).getByRole('button', { name: /Back to the two choices/ }).count() === 0, 'no step back to the chooser');
    await head.keyboard.press('Escape'); await expect(dialog(head)).toHaveCount(0); checks++;
  });

  // 3. A due date with a time, from the calendar.
  await flow('due-with-time', async () => {
    await go(member, '/tasks');
    const box = await newTask(member); await box.fill('Book the drone pilot');
    await dialog(member).getByRole('button', { name: /^Due date:/ }).click();
    const cal = member.getByRole('dialog', { name: 'Due date' });
    await cal.getByRole('button', { name: /^Tomorrow/ }).click();
    await cal.getByRole('button', { name: '5 pm', exact: true }).click();
    await cal.getByRole('button', { name: 'Done' }).click();
    await expect(dialog(member).getByRole('button', { name: /^Due date: .* at 5 pm/ })).toBeVisible(); checks++;
    const made = posted(member, 'work/tasks'); await dialog(member).getByRole('button', { name: 'Create task' }).click();
    const t = (await task((await (await made).json()).id, 'member')).task;
    ok(t.dueAt && new Date(t.dueAt).toISOString() === new Date(`${istDay(1)}T17:00:00+05:30`).toISOString(), `due tomorrow at 17:00 IST (got ${t.dueAt})`);
  });

  // 4. Kind of work: a searchable list that opens downward, with "read from the title" while nothing is chosen.
  await flow('kind-combobox', async () => {
    await go(member, '/tasks');
    const box = await newTask(member); await box.fill('Write the voice-over script for the teaser');
    const kind = dialog(member).getByRole('button', { name: /^Kind of work:/ });
    await expect(kind).toContainText(/read from the title/i, { timeout: 15000 }); checks++;
    const kb = await kind.boundingBox(); await kind.click();
    await member.getByRole('combobox', { name: /kinds of work|kind of work/i }).fill('script');
    const list = member.getByRole('listbox', { name: 'Kind of work' }); const lb = await list.boundingBox();
    ok(lb.y >= kb.y + kb.height - 1, 'the list opens downward');
    await member.keyboard.press('Enter');
    const made = posted(member, 'work/tasks'); await box.press('Enter');
    const t = (await task((await (await made).json()).id, 'member')).task;
    ok(t.category === 'scripting', `kind chosen (${t.category})`);
  });

  // 5. Views: the table edits in place, sorted by a heading; the calendar moves a day with Alt+→.
  await flow('views-table-and-calendar', async () => {
    const probe = await call('work/tasks', { title: 'Views probe for the table', dueOn: istDay(), assigneeId: E.kabir }, 'admin');
    await go(admin, '/tasks?scope=company&layout=list');
    await pickView(admin, 'Table');
    await expect(admin.locator('table thead')).toBeVisible(); checks++;
    await expect(admin).not.toHaveURL(/layout=list/); checks++;
    await admin.getByRole('button', { name: /^Priority/ }).first().click();
    await expect(admin.locator('th[aria-sort]')).toHaveText(/Priority/); checks++;
    await admin.getByRole('button', { name: 'Priority for “Views probe for the table”: change' }).click();
    const saved = posted(admin, `tasks/${probe.id}`); await admin.getByRole('option', { name: 'Urgent' }).click(); await saved;
    await expect.poll(async () => (await task(probe.id)).task.priority).toBe('urgent'); checks++;
    await pickView(admin, 'Calendar');
    const chip = admin.locator(`[data-cal-task="${probe.id}"]`).first();
    if (!(await chip.count())) await admin.locator('[data-today]').getByRole('button', { name: /more/ }).click();
    await chip.focus();
    const moved = posted(admin, `tasks/${probe.id}`); await admin.keyboard.press('Alt+ArrowRight'); await moved;
    await expect.poll(async () => (await task(probe.id)).task.dueOn).toBe(istDay(1)); checks++;
  });

  // 6. Timeline, gallery and a board grouped by priority draw the same rows.
  await flow('views-timeline-gallery-board', async () => {
    await go(admin, '/tasks?scope=company&layout=timeline');
    await expect(admin.locator('a[aria-label*="Views probe for the table"]').first()).toBeVisible(); checks++;
    await pickView(admin, 'Gallery');
    await expect(admin.locator('li').filter({ hasText: 'Views probe for the table' }).first()).toBeVisible(); checks++;
    await pickView(admin, 'Board');
    await admin.getByRole('button', { name: /^Group by:/ }).click(); await admin.getByRole('option', { name: 'Priority' }).click();
    await expect(admin.getByRole('region', { name: 'Urgent' })).toBeVisible(); checks++;
    await admin.getByRole('button', { name: /^Group by:/ }).click(); await admin.getByRole('option', { name: 'Importance × urgency' }).click();
    await expect(admin.getByRole('region', { name: 'Do now' })).toBeVisible(); checks++;
  });

  // 7. The view is remembered; after much time in one view Pulse asks once whether it should be the default.
  await flow('remembered-and-default', async () => {
    await call('work/views/use', { place: 'company', layout: 'timeline', ms: 700000, switched: false }, 'admin');
    await go(admin, '/tasks?scope=company&layout=timeline');
    const note = admin.getByRole('note').filter({ hasText: /Open it this way by default/ });
    await expect(note).toBeVisible(); checks++;
    const answered = posted(admin, 'work/views/pref'); await note.getByRole('button', { name: /Make Timeline my default/ }).click(); await answered;
    await go(admin, '/tasks?scope=company');
    await expect(admin.getByRole('button', { name: 'View: Timeline', exact: true })).toBeVisible(); checks++;
    const prefs = await call('work/views?place=company', undefined, 'admin');
    ok(prefs.defaultLayout === 'timeline' && prefs.ask === null, 'the default is kept and not asked again');
    await call('work/views/pref', { place: 'company', defaultLayout: null }, 'admin');
  });

  // 8. Filters as chips, and a saved view that comes back.
  await flow('filters-and-saved-views', async () => {
    await go(admin, '/tasks?scope=company&layout=list');
    await admin.getByRole('button', { name: /^Filter/ }).click();
    await admin.getByRole('dialog', { name: 'Filter tasks' }).getByRole('button', { name: 'Due today' }).click();
    await admin.getByRole('dialog', { name: 'Filter tasks' }).getByRole('button', { name: 'Done' }).click();
    await expect(admin.getByRole('button', { name: 'Remove filter: Due today' })).toBeVisible(); checks++;
    await expect(admin).toHaveURL(/due=today/); checks++;
    await admin.getByRole('button', { name: /^Views/ }).click();
    await admin.getByRole('textbox', { name: 'Name this view' }).fill('Due today, everyone');
    const saved = posted(admin, 'work/views/saved'); await admin.getByRole('button', { name: 'Save', exact: true }).click(); await saved;
    await go(admin, '/tasks?scope=company');
    await admin.getByRole('button', { name: /^Views/ }).click();
    await admin.getByRole('button', { name: 'Due today, everyone', exact: true }).click();
    await expect(admin.getByRole('button', { name: 'Remove filter: Due today' })).toBeVisible(); checks++;
    await admin.getByRole('button', { name: /^Views/ }).click();
    const removed = posted(admin, /work\/views\/saved\/[0-9a-f-]+\/remove$/); await admin.getByRole('button', { name: 'Remove saved view Due today, everyone' }).click(); await removed;
    ok(!(await call('work/views?place=company', undefined, 'admin')).saved.length, 'removed');
  });

  // 9. A person's page: their photo and numbers, their tasks in any view, value this week as a chart, domains as cards.
  await flow('person-page', async () => {
    await go(head, `/tasks/people/${E.kabir}`);
    await expect(head.getByRole('heading', { name: 'Kabir Shah', level: 2 })).toBeVisible(); checks++;
    await expect(head.getByRole('heading', { name: 'Finished this week' })).toBeVisible(); checks++;
    await expect(head.getByRole('heading', { name: 'Domains' })).toBeVisible(); checks++;
    await pickView(head, 'Board');
    await expect(head.getByRole('region', { name: /To do|Overdue|Today|This week/ }).first()).toBeVisible(); checks++;
    await head.getByRole('button', { name: /^Give Kabir a task/ }).click();
    await expect(dialog(head).getByRole('button', { name: /^Who does it: Kabir Shah/ })).toBeVisible(); checks++;
    await head.keyboard.press('Escape');
  });

  // 10. A project's tasks in the same views, with what was finished after what beside them.
  await flow('project-page-views', async () => {
    await go(admin, `/tasks/projects/${E.fulfilment}`);
    // Owner workbench (21 Oct 2026): what was finished after what is folded beside the tasks and opens in place.
    const finished = admin.locator('details').filter({ has: admin.locator('summary', { hasText: /What was finished after what/ }) });
    await finished.locator('summary').click(); await expect(finished.locator('ol')).toBeVisible(); checks++;
    await pickView(admin, 'Table');
    await expect(admin.locator('table thead')).toContainText('Priority'); checks++;
  });

  // 11. The pool as cards to claim; old links still open it.
  await flow('pool-cards', async () => {
    await go(member, '/tasks?view=pool');
    const card = member.locator('li').filter({ hasText: 'Refresh the agency pitch deck' }).first();
    await expect(card).toBeVisible(); checks++;
    await expect(card.getByRole('button', { name: /^Claim/ })).toBeVisible(); checks++;
    await expect(member.getByRole('button', { name: 'How the pool works' })).toBeVisible(); checks++;
  });

  // 12. Pods are the teams; the company names them.
  await flow('team-word', async () => {
    await call('work/settings', { teamLabel: 'Squad' }, 'admin');
    try {
      await go(head, '/tasks?scope=me');
      await expect(head.getByRole('link', { name: 'My squad' })).toBeVisible(); checks++;
      await go(admin, '/tasks');
      await admin.getByRole('button', { name: 'More in Work' }).click(); // UX-SIMPLE: the team dashboard waits in More
      await expect(admin.getByRole('menu', { name: 'More in Work' }).getByRole('menuitem', { name: /Squad dashboard/ })).toBeVisible(); checks++;
      await admin.keyboard.press('Escape');
    } finally { await call('work/settings', { teamLabel: 'Pod' }, 'admin'); }
  });

  // 13. On a phone: N opens the sheet, everything fits, Create works with the thumb.
  await flow('phone-create', async () => {
    const phone = await as('member', 390);
    await go(phone, '/tasks');
    const box = await newTask(phone); await box.fill('Send the client the first cut');
    const d = await dialog(phone).boundingBox(); ok(d.width >= 388, 'a sheet across the screen');
    ok(await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, 'nothing runs sideways');
    const made = posted(phone, 'work/tasks'); await dialog(phone).getByRole('button', { name: 'Create task' }).click();
    ok((await made).status() === 200, 'created on a phone');
  });

  const failed = results.filter((r) => !r.ok);
  const report = { results, checks, failed: failed.map((r) => r.name) };
  if (process.env.PULSE_TASKS4A_REPORT) await writeFile(process.env.PULSE_TASKS4A_REPORT, JSON.stringify(report, null, 1));
  if (evidence) await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 1));
  console.log(`${results.filter((r) => r.ok && !r.skipped).length} flows passed, ${failed.length} failed, ${checks} checks`);
  if (failed.length) process.exitCode = 1;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
