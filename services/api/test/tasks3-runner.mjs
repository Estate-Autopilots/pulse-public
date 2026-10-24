// TASKS-3: the owner's reported Work bugs, reproduced and kept fixed, through the real API and the built web app on a
// disposable synthetic agency (tests/core/test_tasks3.py::test_tasks3_flows_in_the_browser).
// Every flow is checked on its own and reported by name, so a run lists exactly what is broken. Optional evidence:
// PULSE_TASKS3_EVIDENCE=<dir> (a screenshot of every failing flow, and the report).
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
const evidence = process.env.PULSE_TASKS3_EVIDENCE; if (evidence) await mkdir(evidence, { recursive: true });
const only = (process.env.TASKS3_ONLY ?? '').split(',').filter(Boolean), skip = (process.env.TASKS3_SKIP ?? '').split(',').filter(Boolean);
const call = async (path, body, role = 'member', expected = 200) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body}`); return r.json();
};
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0' }, stdio: 'ignore' });
let browser; const results = []; let checks = 0;
const posted = (page, path, extra = () => true) => {
  const waiting = page.waitForResponse((r) => (typeof path === 'string' ? r.url().endsWith(`/api/v0/${path}`) : path.test(r.url())) && r.request().method() === 'POST' && extra(r), { timeout: 30000 });
  waiting.catch(() => null); // a flow that fails before its click leaves this waiting: never an unhandled rejection
  return waiting;
};
/** A project picker: the searchable combobox, or (before TASKS-3) a native select. */
const chooseProject = async (scope, page, name) => {
  // TASKS-4A: the kit's picker is a button that opens a searchable list (already open when it is the dialog's only field).
  await scope.getByRole('combobox', { name: /Project/ }).or(scope.getByRole('button', { name: /^Project[^:]*:/ })).first().waitFor();
  if (!(await scope.getByRole('combobox', { name: /Project/ }).count())) await scope.getByRole('button', { name: /^Project[^:]*:/ }).last().click();
  const picker = scope.getByRole('combobox', { name: /Project/ }).last();
  if (await picker.evaluate((el) => el.tagName === 'SELECT')) await picker.selectOption({ label: name });
  else { await picker.fill(name); await page.keyboard.press('Enter'); }
};
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(300); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
// Owner workbench (21 Oct 2026): C opens the task form at once; Project on its "What to create" switch makes a project.
const toProject = (page) => page.getByRole('dialog', { name: 'New task' }).getByRole('radiogroup', { name: 'What to create' }).getByRole('radio', { name: 'Project' }).click();
const openCreate = async (page) => { await expect(async () => { await page.keyboard.press('c'); await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible({ timeout: 1500 }); }).toPass({ timeout: 20000 }); };
const pages = {};
/** One reported flow: run it, record pass or the first failure (with a screenshot of every open page). */
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
const as = async (role, width = 1440) => {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  const page = await ctx.newPage(); pages[role] = page;
  page.on('pageerror', (e) => console.log(`PAGEERROR ${role} ${e.message.slice(0, 200)}`));
  return page;
};
const task = (id, role = 'admin') => call(`tasks/${id}`, undefined, role);
const notices = async (role, type) => (await call('work/notices?limit=60', undefined, role)).rows.filter((n) => n.eventType === type);

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 159) throw Error('web did not start'); }
  browser = await chromium.launch({ headless: true });
  const head = await as('head'), member = await as('member'), admin = await as('admin'), hr = await as('hr'), dev = await as('dev'), outsider = await as('outsider');

  // 1. Assign, then change the assignee from the task page.
  await flow('assign-and-change-assignee', async () => {
    const t = await call('work/tasks', { title: 'Grade the Northstar teaser', assigneeId: E.kabir, projectId: E.fulfilment }, 'head');
    ok(t.assigned, 'the head assigns Kabir directly');
    await go(head, `/tasks/${t.id}`);
    await head.getByRole('button', { name: 'More actions' }).click();
    await head.getByRole('menuitem', { name: /Give to|Change who/ }).click();
    const box = head.getByRole('dialog');
    await box.getByRole('combobox').or(box.getByRole('textbox')).first().fill('Sana');
    const gave = posted(head, `tasks/${t.id}/give`); await box.getByRole('option', { name: /Sana Khan/ }).first().click();
    ok((await gave).status() === 200, 'given to Sana');
    ok((await task(t.id)).task.assigneeId === E.sana, 'Sana does it now');
    // A member hands his own task to someone outside his reach: that becomes a request, never an error.
    const mine = await call('work/tasks', { title: 'Collect the Lakeview floor plans' }, 'member');
    await go(member, `/tasks/${mine.id}`);
    await member.getByRole('button', { name: 'More actions' }).click();
    await member.getByRole('menuitem', { name: /Give to|Change who|Ask someone/ }).first().click();
    const dlg = member.getByRole('dialog');
    await dlg.getByRole('combobox').or(dlg.getByRole('textbox')).first().fill('Meera');
    const handed = posted(member, /\/api\/v0\/(tasks\/[0-9a-f-]+\/give|work\/asks)$/); await dlg.getByRole('option', { name: /Meera Iyer/ }).first().click();
    if (await dlg.getByRole('button', { name: /^Send|^Ask/ }).count()) await dlg.getByRole('button', { name: /^Send|^Ask/ }).first().click();
    ok((await handed).status() === 200, 'handed over as a request');
    ok((await call('work/asks', undefined, 'outsider')).incoming.some((a) => a.taskId === mine.id), 'Meera has the request');
  });

  // 2. People on a task: a leader adds a colleague at once; they see it and hear about it.
  await flow('add-people-to-a-task', async () => {
    const t = await call('work/tasks', { title: 'Shortlist music for the Lakeview reel', assigneeId: E.tara }, 'admin');
    await go(admin, `/tasks/${t.id}`);
    await admin.getByRole('button', { name: /Add people|Invite/ }).first().click().catch(async () => { await admin.getByText('People', { exact: true }).click(); await admin.getByRole('button', { name: /Add people|Invite/ }).first().click(); });
    const dlg = admin.getByRole('dialog');
    await dlg.getByRole('combobox').first().fill('Ishaan'); await admin.keyboard.press('Enter');
    // TASKS-4A: the picker's own button is named “Add a person: …”; the action has no colon.
    if (await dlg.getByRole('button', { name: /^(Add|Send)[^:]*$/ }).count()) await dlg.getByRole('button', { name: /^(Add|Send)[^:]*$/ }).first().click();
    await expect.poll(async () => (await task(t.id)).members.some((m) => m.id === E.ishaan && m.role === 'collaborator'), { timeout: 15000 }).toBe(true);
    ok(true, 'Ishaan works on it with Tara');
  });

  // 3. Tags: add a tag on the task page; it shows, and the task carries it.
  await flow('tags', async () => {
    const t = await call('work/tasks', { title: 'Retouch the Sunrise brochure photos', assigneeId: E.sana }, 'head');
    await go(head, `/tasks/${t.id}`);
    await head.getByRole('button', { name: /Add a tag|Tags/ }).first().click();
    await head.getByLabel('New tag').fill('print'); await head.keyboard.press('Enter');
    await expect.poll(async () => (await task(t.id)).task.tags ?? [], { timeout: 15000 }).toContain('print');
    await expect(head.getByLabel('Tags').getByText('print', { exact: true })).toBeVisible();
    ok(true, 'tagged');
  });

  // 4. @mentions: a chip in the comment, the person notified.
  await flow('mentions', async () => {
    const t = await call('work/tasks', { title: 'Check the Northstar drone footage', assigneeId: E.dev }, 'head');
    await go(head, `/tasks/${t.id}`);
    const box = head.getByRole('textbox', { name: 'Write a comment' });
    await box.click(); await box.pressSequentially('Can you look at this @Kab', { delay: 20 });
    await head.getByRole('option', { name: /Kabir Shah/ }).click();
    await box.pressSequentially(' thanks', { delay: 10 });
    const sent = posted(head, 'work/comments'); await head.getByRole('button', { name: 'Comment' }).click();
    ok(JSON.parse((await sent).request().postData()).mentions.includes(E.kabir), 'the mention carries Kabir');
    await expect.poll(async () => (await notices('member', 'task.mention')).some((n) => n.subject?.id === t.id), { timeout: 15000 }).toBe(true);
  });

  // 5. Watchers: follow, hear about a change, stop following.
  await flow('watchers', async () => {
    const t = await call('work/tasks', { title: 'Book the Sunrise rooftop slot', assigneeId: E.sana }, 'head');
    await go(admin, `/tasks/${t.id}`);
    const follow = posted(admin, 'work/watch'); await admin.getByRole('button', { name: 'Follow', exact: true }).click(); ok((await follow).status() === 200, 'following');
    await call(`tasks/${t.id}/move`, { status: 'in_progress' }, 'sana');
    await expect.poll(async () => (await call('work/notices?limit=60', undefined, 'admin')).rows.some((n) => n.subject?.id === t.id), { timeout: 15000 }).toBe(true);
    await go(admin, `/tasks/${t.id}`);
    await admin.getByRole('button', { name: 'More actions' }).click(); await admin.getByRole('menuitem', { name: 'Stop following' }).click();
    await expect.poll(async () => (await task(t.id)).watching, { timeout: 15000 }).toBe(false);
  });

  // 6. Projects of both kinds, then tasks moved into them.
  await flow('projects-and-moving-tasks', async () => {
    await go(head, '/tasks'); await openCreate(head); await toProject(head);
    await head.getByRole('textbox', { name: 'Project name' }).fill('Brand refresh');
    const made = posted(head, 'work/projects'); await head.getByRole('button', { name: 'Create project' }).click();
    const p = await (await made).json(); ok(!!p.id, 'internal project created');
    await expect(head).toHaveURL(new RegExp(`/tasks/projects/${p.id}`), { timeout: 30000 });
    await go(admin, '/tasks'); await openCreate(admin); await toProject(admin);
    await admin.getByRole('radio', { name: /Fulfilment/ }).click();
    await admin.getByRole('combobox', { name: 'Client project' }).fill('Sunrise'); await admin.keyboard.press('Enter');
    const set = posted(admin, 'work/projects'); await admin.getByRole('button', { name: 'Set up fulfilment' }).click();
    ok((await set).status() === 200, 'fulfilment set up');
    // Move a task into the internal project from the task page.
    const t = await call('work/tasks', { title: 'New logo lockups', assigneeId: E.sana }, 'head');
    await go(head, `/tasks/${t.id}`);
    await head.getByRole('button', { name: 'More actions' }).click(); await head.getByRole('menuitem', { name: /Edit|Move to project/ }).first().click();
    const dlg = head.getByRole('dialog');
    await chooseProject(dlg, head, 'Brand refresh');
    const saved = posted(head, /\/api\/v0\/tasks\/[0-9a-f-]+$/); await dlg.getByRole('button', { name: /^Save|^Move/ }).click(); ok((await saved).status() === 200, 'moved');
    ok((await task(t.id)).task.projectId === p.id, 'the task is in Brand refresh');
    // Several at once from My tasks: select, then Move to project.
    const a = await call('work/tasks', { title: 'Brand colours one-pager', dueOn: E.today }, 'head'), b = await call('work/tasks', { title: 'Brand font licences', dueOn: E.today }, 'head');
    await go(head, '/tasks?view=me');
    for (const title of ['Brand colours one-pager', 'Brand font licences']) await head.getByRole('checkbox', { name: new RegExp(`Select .${title}`) }).check();
    await head.getByRole('button', { name: /Move to project/ }).click();
    await chooseProject(head, head, 'Brand refresh');
    await expect.poll(async () => [(await task(a.id)).task.projectId, (await task(b.id)).task.projectId], { timeout: 15000 }).toEqual([p.id, p.id]);
  });

  // 7. Claim from the pool, finish with one click, accept: it shows as accepted, with no points (INTEGRITY 0910).
  await flow('claim-complete-accept-credit', async () => {
    const pooled = E.pool[0];
    await go(member, '/tasks?view=pool');
    const row = member.locator('li').filter({ hasText: 'Edit the testimonial cutdown' }).first();
    const claimed = posted(member, `work/pool/${pooled}/claim`); await row.getByRole('button', { name: /^Claim/ }).click(); ok((await claimed).status() === 200, 'claimed');
    await go(member, '/tasks?view=me');
    const done = posted(member, `tasks/${pooled}/move`);
    // EST-997: the circle asks first; the second click marks it done.
    await member.getByRole('button', { name: 'Mark “Edit the testimonial cutdown” done' }).click(); await member.waitForTimeout(350);
    await member.getByRole('button', { name: 'Confirm: mark “Edit the testimonial cutdown” done' }).click(); ok((await done).status() === 200, 'done after the circle asks once');
    await go(hr, '/tasks?view=me');
    // TASKS-4B: the row's button reads Review and opens the same accept dialog (one quality rating).
    await hr.locator('li').filter({ hasText: 'Edit the testimonial cutdown' }).getByRole('button', { name: /^(Accept|Review)/ }).first().click();
    const accepted = posted(hr, `tasks/${pooled}/accept`); await hr.getByRole('dialog').getByRole('button', { name: /^Accept/ }).click();
    const r = await (await accepted).json(); ok(r.credit === null && r.points === undefined, `nothing credited (got ${JSON.stringify(r.credit)})`);
    const home = await call('tasks/home', undefined, 'member');
    ok(home.summary.weekAccepted >= 1 && home.summary.weekValue === undefined, 'the week shows accepted work, no value');
    const shipped = home.summary.shipped.find((x) => x.id === pooled);
    ok(shipped && shipped.status === 'accepted' && shipped.valuePoints === undefined && shipped.points === undefined, 'shipped shows it accepted, no points');
    await go(member, '/tasks?view=me');
    const creditedTask = member.getByRole('list', { name: 'What shipped this week' }).getByRole('listitem')
      .filter({ has: member.locator(`a[href="/tasks/${pooled}"]`) });
    await expect(creditedTask.getByRole('link', { name: 'Edit the testimonial cutdown', exact: true })).toBeVisible();
    await expect(creditedTask.getByText('accepted', { exact: true })).toBeVisible();
    await go(member, '/tasks/outcomes');
    ok(await member.getByText(/\d+\s*pts?/).count() === 0, 'no points on My outcomes');
  });

  // 8. Extra work: done outside one's domains (or above plan) and accepted by someone else counts, and is highlighted.
  await flow('extra-work-credit', async () => {
    const deck = E.pool[1];
    await call(`work/pool/${deck}/claim`, {}, 'dev'); await call(`tasks/${deck}/move`, { status: 'done' }, 'dev');
    const r = await call(`tasks/${deck}/accept`, { effort: 3, impact: 3 }, 'admin');
    ok(r.credit === null, 'nothing credited');
    const o = await call('outcomes', undefined, 'dev');
    ok((o.charts?.extra?.points ?? 0) >= 1 && o.charts.extra.items.some((x) => x.taskId === deck && x.reasons.includes('pool')), `extra work counted (got ${JSON.stringify(o.charts?.extra ?? null).slice(0, 300)})`);
    await go(dev, '/tasks/outcomes');
    await expect(dev.getByRole('heading', { name: /Extra work/ })).toBeVisible();
    await expect(dev.getByText('Refresh the agency pitch deck').first()).toBeVisible();
  });

  // 9. Quick add: chips while typing; assigning outside one's reach asks; full names and twin records resolve.
  await flow('quick-add', async () => {
    let r = await call('tasks/quick', { text: 'Fix the pricing typo @Sana Khan !!', preview: true }, 'head');
    ok(r.parsed.title === 'Fix the pricing typo' && r.parsed.assignee?.id === E.sana && r.parsed.priority === 'urgent', `full name read (${JSON.stringify(r.parsed)})`);
    r = await call('tasks/quick', { text: 'Check the edit @Sana', preview: true }, 'head');
    ok(r.parsed.assignee?.id === E.sana && !r.parsed.problems.length, `the twin record does not block @Sana (${JSON.stringify(r.parsed.problems)})`);
    await go(member, '/tasks');
    // TASKS-4A: the quick add lives in + Create's title now (N opens it); the same line, the same chips.
    const input = member.getByRole('textbox', { name: 'What needs doing' });
    await expect(async () => { await member.keyboard.press('n'); await expect(input).toBeVisible({ timeout: 1500 }); }).toPass({ timeout: 20000 });
    await input.click(); await input.pressSequentially('Send the site plan @Mee', { delay: 25 });
    const opt = member.getByRole('option', { name: /Meera Iyer/ });
    if (await opt.count()) await opt.first().click(); else await input.pressSequentially('ra', { delay: 25 });
    await input.pressSequentially(' fri !high', { delay: 25 });
    await expect(member.getByText('Meera Iyer').or(member.getByText('Meera')).first()).toBeVisible();
    const made = posted(member, /\/api\/v0\/(tasks\/quick|work\/tasks)$/); await input.press('Enter');
    const res = await made; ok(res.status() === 200, `added (HTTP ${res.status()}: ${await res.text()})`);
    ok((await call('work/asks', undefined, 'outsider')).incoming.some((a) => /site plan/.test(a.title)), 'Meera is asked to take it');
  });

  // 9b. The board: drag a card with the pointer to another column (it lifts, the column lights up, it lands), and the
  // keyboard moves a focused card.
  await flow('board-drag', async () => {
    const t = await call('work/tasks', { title: 'Drag me to Doing' }, 'member');
    await go(member, '/tasks?view=board&scope=mine&group=status');
    const card = member.getByRole('listitem', { name: /^Drag me to Doing/ }), doing = member.getByRole('region', { name: 'Doing', exact: true });
    // Owner workbench (21 Oct 2026): with the page header in the page the board starts lower; bring the card into view.
    await card.scrollIntoViewIfNeeded();
    const from = await card.boundingBox(), to = await doing.boundingBox();
    const moved = posted(member, `tasks/${t.id}/move`);
    await member.mouse.move(from.x + from.width / 2, from.y + from.height - 8); await member.mouse.down();
    await member.mouse.move(from.x + from.width / 2 + 20, from.y + from.height, { steps: 4 });
    await expect(member.locator('[class*="ghost"]')).toBeVisible();
    await member.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 12 });
    await expect(doing).toHaveAttribute('data-over', '');
    await member.mouse.up();
    ok((await moved).status() === 200, 'dropped in Doing');
    await expect.poll(async () => (await task(t.id, 'member')).task.status).toBe('in_progress');
    // Back with the keyboard.
    await go(member, '/tasks?view=board&scope=mine&group=status');
    const back = posted(member, `tasks/${t.id}/move`);
    await member.getByRole('listitem', { name: /^Drag me to Doing/ }).focus(); await member.keyboard.press('ArrowLeft');
    ok((await back).status() === 200, 'moved back with the arrow key');
    await expect.poll(async () => (await task(t.id, 'member')).task.status).toBe('open');
  });

  // 14. The pool filled from data: leadership looks for work, takes one out, approves the batch in one click.
  await flow('pool-from-data', async () => {
    await go(admin, '/tasks?view=pool');
    const look = posted(admin, 'work/pool/proposals/generate'); await admin.getByRole('button', { name: 'Look for work' }).click();
    const g = await (await look).json(); ok(g.batches >= 1, `batches proposed (${JSON.stringify(g)})`);
    await go(admin, '/tasks?view=pool');
    const batch = admin.getByRole('region', { name: 'Proposed for the pool' }).locator('article').first();
    await expect(batch).toBeVisible();
    const before = (await call('work/pool?scope=', undefined, 'admin')).total;
    const out = posted(admin, /\/api\/v0\/work\/pool\/proposals\/[0-9a-f-]+$/); await batch.getByRole('button', { name: /^Take out/ }).first().click(); ok((await out).status() === 200, 'taken out');
    const approve = posted(admin, /\/api\/v0\/work\/pool\/batches\/[0-9a-f-]+\/approve$/); await batch.getByRole('button', { name: /^Approve/ }).click();
    const r = await (await approve).json(); ok(r.made >= 1, `published (${JSON.stringify(r)})`);
    ok((await call('work/pool', undefined, 'admin')).total === before + r.made, 'they are in the pool');
  });

  // 12. Reporting lines: Pulse proposes from the evidence, HR confirms one, and sets one by hand from the chart.
  await flow('org-chart', async () => {
    await go(hr, '/people/org');
    await expect(hr.getByRole('heading', { name: 'Org chart' })).toBeVisible();
    const look = posted(hr, 'org/suggest'); await hr.getByRole('button', { name: 'Look again' }).click(); ok((await look).status() === 200, 'proposals made');
    await expect(hr.getByRole('button', { name: 'Confirm', exact: true }).first()).toBeVisible({ timeout: 15000 });
    const before = (await call('org/chart', undefined, 'hr')).proposals.length;
    const conf = posted(hr, /\/api\/v0\/org\/proposals\/[0-9a-f-]+\/confirm$/); await hr.getByRole('button', { name: 'Confirm', exact: true }).first().click(); ok((await conf).status() === 200, 'confirmed');
    await expect.poll(async () => (await call('org/chart', undefined, 'hr')).proposals.length).toBeLessThan(before);
    await go(hr, '/people/org');
    await hr.getByRole('button', { name: /^Kabir Shah,/ }).click();
    await hr.getByRole('button', { name: /who they report to/ }).click();
    const line = posted(hr, 'org/line'); await hr.getByRole('combobox', { name: 'Reports to' }).fill('Rila'); await hr.keyboard.press('Enter'); ok((await line).status() === 200, 'line set');
    const chart = await call('org/chart', undefined, 'hr'); const rila = chart.people.find((x) => x.name === 'Rila Kapoor');
    ok(chart.people.find((x) => x.id === E.kabir)?.managerId === rila.id, 'Kabir reports to Rila');
    // Rila now sees Kabir's work as his manager would.
    ok((await call('outcomes/team', undefined, 'admin')).people.some((x) => x.id === E.kabir), 'leaders see the team summary');
  });

  // 13. Nothing covered, cut off or out of reach on the Work screens (the LAYOUT-SWEEP rules), at a desktop and a phone.
  await flow('layout-audit', async () => {
    const { auditLayout, BLOCKING, settle } = await import('../../../tests/e2e/layout-audit.mjs');
    const problems = [];
    for (const [width, height] of [[1440, 900], [390, 844]]) for (const [role, path] of [['member', '/tasks'], ['admin', '/tasks?view=board&scope=all'], ['admin', '/tasks?view=projects'],
      ['admin', '/tasks?view=team'], ['admin', '/tasks?view=blocking'], ['admin', '/tasks?view=pool'], ['member', '/tasks/outcomes'], ['admin', '/tasks/outcomes?view=team'], ['hr', '/people/org'],
      ['head', `/tasks/${E.task}`], ['member', '/tasks?view=deleted']]) {
      const ctx = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
      const p = await ctx.newPage(); await go(p, path);
      // Pip's island (arrivals animating in the top bar) has its own reliability tests; the audit looks at the screen.
      await p.addStyleTag({ content: '[data-island]{display:none !important}' }); await settle(p, 400);
      const { findings } = await p.evaluate(auditLayout, {});
      for (const f of findings) if (BLOCKING.includes(f.rule)) problems.push(`${width} ${path} ${f.rule}: ${f.where} — ${f.detail}`);
      await ctx.close();
    }
    for (const x of problems) console.log(`LAYOUT ${x}`);
    ok(!problems.length, `${problems.length} layout problems (each printed as LAYOUT …)`);
  });

  // 10. Every Work view opens for each role without an error.
  await flow('work-views-open', async () => {
    for (const [role, page] of [['admin', admin], ['head', head], ['member', member]]) for (const view of ['me', 'board', 'pool', 'projects', 'team', 'blocking', 'all', 'deleted']) {
      if (role === 'member' && ['team', 'blocking'].includes(view)) continue;
      const bad = []; const watch = (r) => { if (r.url().includes('/api/v0/') && r.status() >= 500) bad.push(`${r.status()} ${r.url().replace(base, '')}`); };
      page.on('response', watch); await go(page, `/tasks?view=${view}`); page.off('response', watch);
      ok(!bad.length && !(await page.getByText(/did not load|Something went wrong/).count()), `${role} ${view}: ${bad.join(', ')}`);
    }
  });

  // 11. Delete a task made by mistake: see what is connected first, then restore it from Recently deleted.
  await flow('delete-and-restore', async () => {
    const t = await call('work/tasks', { title: 'Duplicate: brochure retouch' }, 'head');
    await call('work/tasks', { title: 'Check the retouch', parentId: t.id }, 'head');
    await go(head, `/tasks/${t.id}`);
    await head.getByRole('button', { name: 'More actions' }).click(); await head.getByRole('menuitem', { name: /Delete/ }).click();
    const dlg = head.getByRole('dialog'); await expect(dlg.getByText('1 subtask goes with it')).toBeVisible();
    const del = posted(head, `tasks/${t.id}/delete`); await dlg.getByRole('button', { name: /^Delete/ }).click(); ok((await del).status() === 200, 'deleted');
    await call(`tasks/${t.id}`, undefined, 'head', 404);
    await go(head, '/tasks?view=deleted');
    const restore = posted(head, `tasks/${t.id}/restore`); await head.locator('li').filter({ hasText: 'Duplicate: brochure retouch' }).getByRole('button', { name: 'Restore' }).click();
    ok((await restore).status() === 200, 'restored'); ok((await task(t.id, 'head')).children.length === 1, 'with its subtask');
  });

  // Evidence: the screens these flows touch, as they look after the run.
  if (evidence && process.env.TASKS3_SHOTS) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    for (const [role, path, name] of [['member', '/tasks', 'my-tasks'], ['head', '/tasks', 'my-tasks-head'], ['head', `/tasks/${E.task}`, 'task'], ['admin', '/tasks?view=board&scope=all', 'board'],
      ['admin', '/tasks?view=projects', 'projects'], ['admin', '/tasks?view=team', 'team'], ['admin', '/tasks?view=blocking', 'blocking'], ['member', '/tasks/outcomes', 'outcomes'], ['dev', '/tasks/outcomes', 'outcomes-extra'],
      ['admin', '/tasks/outcomes?view=team', 'outcomes-team'], ['hr', '/people/org', 'org'], ['member', '/tasks?view=deleted', 'deleted'], ['head', '/tasks?view=board&scope=pod', 'board-pod']]) {
      if (process.env.TASKS3_SHOTS !== '1' && !process.env.TASKS3_SHOTS.split(',').includes(name)) continue;
      const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
      await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private */ } }, theme);
      const p = await ctx.newPage(); await go(p, path).catch(() => null); await p.waitForTimeout(400);
      await p.screenshot({ path: `${evidence}/${name}-${width}-${theme}.png` }); await ctx.close();
    }
  }
  const failed = results.filter((r) => !r.ok);
  const report = { results, checks, failed: failed.map((r) => r.name) };
  if (process.env.PULSE_TASKS3_REPORT) await writeFile(process.env.PULSE_TASKS3_REPORT, JSON.stringify(report, null, 1));
  if (evidence) await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.map((r) => r.name) }));
  if (failed.length) process.exitCode = 1;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
