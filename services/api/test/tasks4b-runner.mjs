// TASKS-4B: a task's life (doing, finishing, reviewing, value), in the browser on a production build, through the real
// API, on a disposable synthetic agency (tests/core/test_tasks4b.py::test_tasks4b_flows_in_the_browser). Every flow is
// reported by name. Optional: PULSE_TASKS4B_EVIDENCE=<dir> (a screenshot of every failing flow, and the report) and
// PULSE_TASKS4B_SHOTS=<dir> (the screens at 1440 and 390 px, light and dark, through the unstyled-page gate).
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
  kedab: process.env.TEST_KEDAB, hr: 'hr@estateautopilots.com', admin: 'admin@estateautopilots.com' };
const evidence = process.env.PULSE_TASKS4B_EVIDENCE; if (evidence) await mkdir(evidence, { recursive: true });
const shotsDir = process.env.PULSE_TASKS4B_SHOTS; if (shotsDir) await mkdir(shotsDir, { recursive: true });
const only = (process.env.TASKS4B_ONLY ?? '').split(',').filter(Boolean), skip = (process.env.TASKS4B_SKIP ?? '').split(',').filter(Boolean);
const call = async (path, body, role = 'member', expected = 200) => {
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
const posted = (page, path, extra = () => true) => {
  const waiting = page.waitForResponse((r) => (typeof path === 'string' ? r.url().endsWith(`/api/v0/${path}`) : path.test(r.url())) && r.request().method() === 'POST' && extra(r), { timeout: 30000 });
  waiting.catch(() => null);
  return waiting;
};
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(300); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
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
const as = async (role, width = 1440) => {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  const page = await ctx.newPage(); pages[role] = page;
  page.on('pageerror', (e) => console.log(`PAGEERROR ${role} ${e.message.slice(0, 200)}`));
  return page;
};
const task = (id, role = 'admin') => call(`tasks/${id}`, undefined, role);
/** A task given by `by` to `to` (a role), optionally with value points and subtasks. */
async function given(title, by, toId, extra = {}) {
  const t = await call('work/tasks', { title, assigneeId: toId, ...extra }, by);
  return t.id;
}
const done = (id, role) => call(`tasks/${id}/move`, { status: 'done' }, role);

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 159) throw Error('web did not start'); }
  browser = await chromium.launch({ headless: true });
  const head = await as('head'), member = await as('member'), admin = await as('admin');

  // 8. The owner's case: a parent cannot be Done while its subtasks are open; each closes in one tap.
  await flow('subtasks-block-done', async () => {
    const parent = await given('Zoho: confirm Zoho Books and export the invoices', 'head', E.kabir, { projectId: E.fulfilment });
    const sub1 = (await call('work/tasks', { title: 'Create the Zoho API client', parentId: parent, assigneeId: E.kabir }, 'member')).id;
    const sub2 = (await call('work/tasks', { title: 'Old finance desk task', parentId: parent, assigneeId: E.kabir }, 'member')).id;
    await call(`tasks/${parent}/move`, { status: 'in_progress' }, 'member');
    await call(`tasks/${parent}/move`, { status: 'done' }, 'member', 400);  // the database says no
    await go(member, `/tasks/${parent}`);
    await member.getByRole('button', { name: /^Mark done/ }).first().click();
    const dlg = member.getByRole('dialog', { name: 'Mark done' });
    await expect(dlg.getByText('2 subtasks are still open')).toBeVisible();
    ok(await dlg.getByRole('button', { name: 'Mark done' }).isDisabled(), 'Mark done waits for the subtasks');
    const finish = posted(member, `tasks/${sub1}/move`); await dlg.getByRole('listitem').filter({ hasText: 'Create the Zoho API client' }).getByRole('button', { name: 'Finish' }).click();
    ok((await finish).status() === 200, 'finished one');
    await dlg.getByRole('listitem').filter({ hasText: 'Old finance desk task' }).getByRole('button', { name: 'Cancel…' }).click();
    await dlg.getByRole('textbox', { name: /not needed/ }).fill('Folded into the finance desk work');
    const cancel = posted(member, `tasks/${sub2}/move`); await dlg.getByRole('button', { name: 'Cancel it' }).click();
    ok((await cancel).status() === 200, 'cancelled the other with a note');
    await expect(dlg.getByRole('button', { name: 'Mark done' })).toBeEnabled();
    const moved = posted(member, `tasks/${parent}/move`); await dlg.getByRole('button', { name: 'Mark done' }).click();
    ok((await moved).status() === 200, 'done now');
    await expect(member.getByRole('region', { name: 'Where this task stands' }).getByText('Done', { exact: true })).toBeVisible();
    ok((await task(parent)).task.status === 'done', 'the task is Done');
  });

  // 1, 2, 10. The reviewer's bar: one rating, above and beyond, Accept; the banner celebrates (no points: INTEGRITY 0910).
  await flow('review-and-accept', async () => {
    const t = await given('Cut the Lakeview teaser', 'head', E.kabir, { projectId: E.fulfilment, dueOn: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10) });
    await call(`work/tasks/${t}/value`, { importance: 'high' }, 'head');
    await done(t, 'member');
    await go(head, `/tasks/${t}`);
    const banner = head.getByRole('region', { name: 'Where this task stands' });
    await expect(banner).toContainText('Done by');
    await expect(banner).toContainText(/early|on time/);
    await expect(banner).toContainText('Waiting for your review');
    const bar = head.getByRole('group', { name: /^Review .+’s work$/ });
    await bar.getByRole('radio', { name: 'Great' }).click();
    await bar.getByRole('switch', { name: 'Above and beyond' }).check();
    const accepted = posted(head, `tasks/${t}/accept`); await bar.getByRole('button', { name: 'Accept' }).click();
    const body = JSON.parse((await accepted).request().postData());
    ok(body.quality === 'great' && body.above === true && !('effort' in body), 'one rating, no effort or impact typed in');
    await expect(banner).toContainText('Accepted');
    await expect(banner).not.toContainText(/\d+\s*pts?/);
    const d = await task(t);
    ok(d.task.reviewKind === 'rated' && d.task.reviewQuality === 5 && !d.life.credit, 'rated Great, nothing credited');
  });

  // 10. A founder's work is acknowledged, never graded.
  await flow('founder-acknowledged', async () => {
    const t = await given('Approve staff notice v2', 'admin', E.kedab);
    await done(t, 'kedab');
    await go(admin, `/tasks/${t}`);
    const bar = admin.getByRole('group', { name: /work$/ });
    ok(await bar.getByRole('radio').count() === 0, 'no rating for a founder');
    await bar.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(admin.getByRole('region', { name: 'Where this task stands' })).toContainText('Accepted');
    ok((await task(t)).task.reviewKind === 'acknowledged', 'acknowledged');
  });

  // 11. The bell's card: photo, timing, waiting; one quality rating instead of two dropdowns; accepting there works.
  // ATT (ef5221e4): two or more cards of one family on the same day fold into a stack ("3 task updates") in the bell;
  // open the stack that holds this card, then use the card itself.
  const bellCard = async (scope, text) => {
    await expect(scope.locator('[data-card]').filter({ hasText: text }).first()).toBeVisible();
    const stack = scope.locator('li[data-stack]').filter({ hasText: text }).first();
    if (await stack.count()) {
      const toggle = stack.getByRole('button', { expanded: false });
      if (await toggle.count()) await toggle.first().click();
      return stack.locator('ul [data-card]').filter({ hasText: text }).first();
    }
    return scope.locator('[data-card]').filter({ hasText: text }).first();
  };
  await flow('bell-accept-with-rating', async () => {
    const t = await given('Colour the Sunrise reel', 'head', E.kabir);
    await done(t, 'member');
    await go(head, '/tasks');
    await head.getByRole('button', { name: /^Notifications/ }).click();
    const card = await bellCard(head, 'Colour the Sunrise reel');
    await expect(card).toContainText(/finished “Colour the Sunrise reel”/);
    ok(await card.locator('select').count() === 0, 'no effort or impact dropdowns');
    await card.getByRole('radio', { name: 'Good' }).click();
    const accepted = posted(head, `tasks/${t}/accept`); await card.getByRole('button', { name: 'Accept' }).click();
    ok(JSON.parse((await accepted).request().postData()).quality === 'good', 'accepted from the bell with a rating');
    await expect(card).toContainText('Accepted');
    ok((await task(t)).task.reviewQuality === 4, 'Good');
    await head.keyboard.press('Escape');
  });

  // PROMOTE-4B: the bell's "All notifications" opens /notifications, which still offered Effort 1–5 and Impact 1–5 and
  // credited effort × impact. Its finished-work row now has the bell's own card: one quality rating, above and beyond.
  await flow('notifications-page-rating', async () => {
    const t = await given('Grade the Harbour walkthrough', 'head', E.kabir);
    await done(t, 'member');
    await go(head, '/tasks');
    await head.getByRole('button', { name: /^Notifications/ }).click();
    const panel = head.locator('#pulse-notices');
    const card = await bellCard(panel, 'Grade the Harbour walkthrough');
    await expect(card.getByRole('radiogroup', { name: 'How was the work?' })).toBeVisible();
    ok(await card.locator('select').count() === 0 && !/\b(Effort|Impact)\b/.test(await card.innerText()), 'the bell: one rating, no Effort or Impact');
    await panel.getByRole('link', { name: 'All notifications' }).click();
    await expect(head).toHaveURL(/\/notifications$/);
    await ready(head);
    const row = head.locator('main li').filter({ hasText: 'Ready to accept: Grade the Harbour walkthrough' }).first();
    const rating = row.getByRole('radiogroup', { name: 'How was the work?' });
    for (const level of ['Great', 'Good', 'Needs work']) await expect(rating.getByRole('radio', { name: level })).toBeVisible();
    await expect(row.getByRole('switch', { name: 'Above and beyond' })).toBeAttached();
    ok(await row.locator('select').count() === 0, 'no dropdowns on the row');
    ok(!/\b(Effort|Impact)\b/.test(await head.locator('main').innerText()), 'no Effort or Impact anywhere on /notifications');
    await rating.getByRole('radio', { name: 'Great' }).click();
    await row.getByRole('switch', { name: 'Above and beyond' }).check();
    const accepted = posted(head, `tasks/${t}/accept`); await row.getByRole('button', { name: 'Accept', exact: true }).click();
    const sent = JSON.parse((await accepted).request().postData());
    ok(sent.quality === 'great' && sent.above === true && !('effort' in sent) && !('impact' in sent), 'accepted with the rating, never effort × impact');
    await expect(row).toContainText('Accepted');
    const after = (await task(t)).task;
    ok(after.status === 'accepted' && after.reviewKind === 'rated' && after.reviewQuality === 5 && after.reviewAbove === true, 'rated Great, above and beyond');
    // A blocker's row keeps its one tap (the same card contract): the owner finishes their task from /notifications.
    const blocker = (await call('work/tasks', { title: 'Send the Harbour floor plans', assigneeId: E.kabir }, 'member')).id;
    const waiting = await given('Price the Harbour units', 'head', E.kabir);
    await call(`tasks/${waiting}/block`, { blockerId: blocker }, 'head');
    await go(member, '/notifications');
    const blocked = member.locator('main li').filter({ hasText: 'is waiting on your task “Send the Harbour floor plans”' }).first();
    const unblock = posted(member, `tasks/${blocker}/move`); await blocked.getByRole('button', { name: 'Mine is done: unblock' }).click();
    ok((await unblock).status() === 200, 'unblocked from /notifications');
    await expect(blocked).toContainText('Done · unblocked');
    ok(['done', 'in_review', 'accepted'].includes((await task(blocker, 'member')).task.status), 'the blocker is done');
  });

  // 11. The queue: obvious from the top bar, oldest first, accept several at once.
  await flow('review-queue-bulk', async () => {
    const ids = [];
    for (const title of ['Retouch the Lakeview photos', 'Caption the Skyline reels', 'Trim the Northstar drone cut']) { const id = await given(title, 'head', E.kabir); await done(id, 'member'); ids.push(id); }
    await go(head, '/tasks');
    const chip = head.getByRole('link', { name: /waiting for your review/ });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(head).toHaveURL(/view=reviews/);
    const queue = head.getByRole('region', { name: 'Waiting for your review' });
    await expect(queue.getByRole('link', { name: 'Retouch the Lakeview photos' })).toBeVisible();
    for (const id of ids) { const title = (await task(id)).task.title; await queue.getByRole('checkbox', { name: `Select “${title}”` }).check(); }
    const bulk = posted(head, 'tasks/reviews/bulk'); await queue.getByRole('button', { name: 'Accept 3' }).click();
    const r = await (await bulk).json();
    ok(r.accepted === 3 && !r.failed.length, 'three accepted at once');
    for (const id of ids) ok((await task(id)).task.status === 'accepted', 'accepted');
  });

  // 8. Finished with an open subtask (an import did it, before the rule): the reviewer is warned and marks it seen.
  await flow('flag-warning', async () => {
    const id = E.flagged;
    await go(head, `/tasks/${id}`);
    const warn = head.getByRole('note').filter({ hasText: /still open/ });
    await expect(warn).toContainText('Check the retouch');
    const seen = posted(head, `tasks/${id}/flags/resolve`); await warn.getByRole('button', { name: 'Mark as seen' }).click();
    ok((await seen).status() === 200, 'marked as seen');
  });

  // 12 (send back): the doer sees the note at the top.
  await flow('send-back', async () => {
    const t = await given('Write the Sunrise captions', 'head', E.kabir);
    await done(t, 'member');
    await go(head, `/tasks/${t}`);
    await head.getByRole('group', { name: /^Review / }).getByRole('button', { name: 'Send back' }).click();
    const dlg = head.getByRole('dialog'); await dlg.getByRole('textbox').fill('The second caption is too long');
    const back = posted(head, `tasks/${t}/return`); await dlg.getByRole('button', { name: 'Send back' }).click(); ok((await back).status() === 200, 'sent back');
    await go(member, `/tasks/${t}`);
    await expect(member.getByRole('region', { name: 'Where this task stands' })).toContainText('Sent back by');
    await expect(member.getByRole('region', { name: 'Where this task stands' })).toContainText('The second caption is too long');
  });

  // 10. The policy in Settings → Who can do what.
  await flow('review-policy-settings', async () => {
    await go(admin, '/settings?tab=work-rules');
    const box = admin.getByRole('region', { name: 'Reviews and value' }).or(admin.locator('section[aria-labelledby="review-policy-title"]'));
    const saved = posted(admin, 'work/settings'); await box.getByRole('radio', { name: /^1 to 5/ }).click();
    ok((await saved).status() === 200, 'saved');
    ok((await call('work/settings', undefined, 'admin')).reviewScale === 'five', 'five-point scale');
    await call('work/settings', { reviewScale: 'three' }, 'admin');
  });

  // 5. Time is captured by itself: Start (or Doing) runs the clock, Pause stops it, the entry appears; asked once for an estimate.
  await flow('time-captured', async () => {
    const t = await given('Draft the Skyline storyboard', 'head', E.kabir);
    await go(member, `/tasks/${t}`);
    const ask = member.getByRole('group', { name: 'About how long will this take?' });
    await expect(ask).toBeVisible();
    const est = posted(member, `tasks/${t}/estimate`); await ask.getByRole('button', { name: '2 h' }).click(); ok((await est).status() === 200, 'estimate given once');
    const card = member.getByRole('region', { name: 'Time' });
    // AskEstimate refreshes server props. Let that refresh render before Start triggers another,
    // otherwise the earlier response can still describe the clock before it was started.
    await expect(card).toContainText('of about 2 h', { timeout: 20000 });
    await expect(ask).toHaveCount(0);
    const start = posted(member, `tasks/${t}/timer`); await card.getByRole('button', { name: 'Start' }).click(); ok((await start).status() === 200, 'clock started');
    await expect(card).toContainText('Running since');
    const started = await task(t);
    ok(started.task.status === 'in_progress', 'Start moved it to Doing');
    ok(!!started.life.clock.running, 'the running clock is persisted');
    await go(member, `/tasks/${t}`);
    await expect(member.getByRole('group', { name: 'About how long will this take?' })).toHaveCount(0);
    const pause = posted(member, `tasks/${t}/timer`); await member.getByRole('region', { name: 'Time' }).getByRole('button', { name: 'Pause' }).click(); ok((await pause).status() === 200, 'paused');
    await expect(member.getByRole('region', { name: 'Time' })).toContainText('Clock paused');
    ok((await task(t)).life.clock.running === null, 'not running');
  });

  // 3, 4. Priority at a glance, with how Pip worked out the effort; no value anywhere (INTEGRITY 0910).
  await flow('priority-breakdown', async () => {
    const t = await given('Edit the Lakeview walkthrough video', 'head', E.kabir, { projectId: E.fulfilment });
    await call(`work/tasks/${t}/suggest`, {}, 'head');
    await go(head, `/tasks/${t}`);
    const card = head.getByRole('region', { name: 'Priority' });
    await card.getByRole('button', { name: /How was this worked out/ }).click();
    ok(await card.getByText(/\d+\s*(pts?|points)/).count() === 0, 'no points in the card');
    const use = posted(head, `work/tasks/${t}/value`); await card.getByRole('button', { name: /Use Pip’s suggestion/ }).click(); ok((await use).status() === 200, 'Pip’s suggestion used');
    const after = (await task(t)).task;
    ok(after.estimateMinutes > 0 && after.valuePoints === undefined, 'estimate set, no value');
  });

  // 9. Threads and help: reply under a comment, ask for help (who is told shown first), resolve, rate the helper privately.
  await flow('threads-and-help', async () => {
    const t = await given('Fix the banding in the Lakeview sky shots', 'head', E.kabir);
    await call('work/comments', { taskId: t, body: 'Which LUT did you use?' }, 'head');
    await go(member, `/tasks/${t}`);
    const thread = member.locator('li', { hasText: 'Which LUT did you use?' }).first();
    await thread.getByRole('button', { name: 'Reply' }).first().click();
    const box = member.getByRole('textbox', { name: /^Reply to/ });
    await box.click(); await box.pressSequentially('The Rec709 one', { delay: 10 });
    // The page's own Reply (a floating Pip's arrival bubble, last in the document since 20 Oct, has one too).
    const replied = posted(member, 'work/comments'); await member.locator('#main-content').getByRole('button', { name: 'Reply', exact: true }).last().click();
    ok(JSON.parse((await replied).request().postData()).parentId, 'the reply carries its parent');
    await member.getByRole('button', { name: /Ask for help/ }).click();
    const ask = member.getByRole('group', { name: 'Ask for help' });
    await expect(ask).toContainText('reviews it');
    const helpBox = ask.getByRole('textbox', { name: 'What are you stuck on?' });
    await helpBox.click(); await helpBox.pressSequentially('Stuck on banding in the sky', { delay: 10 });
    const asked = posted(member, 'work/comments'); await ask.getByRole('button', { name: 'Ask for help' }).click();
    const helpId = (await (await asked).json()).id;
    ok(helpId, 'asked for help');
    await call('work/comments', { parentId: helpId, body: 'Add a little grain before export' }, 'head');
    await go(member, `/tasks/${t}`);
    const help = member.locator('li', { hasText: 'Stuck on banding in the sky' }).first();
    const resolved = posted(member, `work/comments/${helpId}/resolve`); await help.getByRole('button', { name: 'Resolve' }).first().click(); ok((await resolved).status() === 200, 'resolved');
    const rate = member.getByRole('group', { name: 'How helpful was each person?' });
    const rated = posted(member, `work/comments/${helpId}/rate`); await rate.getByRole('radio', { name: 'Helpful', exact: true }).click(); ok((await rated).status() === 200, 'rated');
    const totals = await call('outcomes', undefined, 'head');
    ok(totals.help.helpful === 1 && !totals.help.points, 'the helper sees their totals, no points');
  });

  // 12. Delete a project: what is connected, then one soft delete with its tasks; restore brings everything back.
  await flow('project-delete', async () => {
    const pr = await call('work/projects', { type: 'internal', name: 'Brand refresh (synthetic)', ownerId: E.head }, 'admin');
    const pid = pr.id ?? pr.projectId;
    await call('work/tasks', { title: 'Draft the palette', assigneeId: E.kabir, projectId: pid }, 'head');
    await call('work/tasks', { title: 'Pick the typeface', assigneeId: E.kabir, projectId: pid }, 'head');
    await go(head, `/tasks/projects/${pid}`);
    // A crowded header folds its last actions into "More actions"; while Pip's island shows a notice it takes more of the
    // header's room, so whether Delete… is folded can change between looking and clicking: look and click together, and
    // count it only once the dialog is open (a click that lands while the header reflows opens nothing).
    const dlg = head.getByRole('dialog', { name: 'Delete this project?' });
    await expect(async () => {
      if (await dlg.isVisible()) return;
      if (!(await head.getByRole('button', { name: 'Delete…' }).isVisible())) await head.getByRole('button', { name: /^More actions/ }).click();
      await head.getByRole('button', { name: 'Delete…' }).click({ timeout: 3000 });
      await expect(dlg).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
    await expect(dlg).toContainText('2 tasks are deleted with it');
    await dlg.getByRole('textbox').fill('Brand refresh (synthetic)');
    const del = posted(head, `work/projects/${pid}/delete`); await dlg.getByRole('button', { name: /^Delete with 2 tasks/ }).click(); ok((await del).status() === 200, 'deleted');
    await expect(head).toHaveURL(/view=projects/);
    await go(head, '/tasks?view=deleted');
    const row = head.getByRole('list', { name: 'Deleted projects' }).getByRole('listitem').filter({ hasText: 'Brand refresh (synthetic)' });
    const back = posted(head, `work/projects/${pid}/restore`); await row.getByRole('button', { name: 'Restore' }).click(); ok((await back).status() === 200, 'restored');
    ok((await call(`tasks/projects/${pid}`, undefined, 'head')).tasks.length === 2, 'its tasks are back');
  });

  // 13. My tasks: domains as chips with set-up in place; the week's finished work as a chart.
  await flow('my-tasks-rail', async () => {
    await go(member, '/tasks?view=me');
    const domains = member.getByRole('region', { name: 'Your domains' });
    await expect(domains.getByRole('button', { name: /Set one up|Propose another|Propose/ }).first()).toBeVisible();
    const week = member.getByRole('region', { name: 'Finished this week' });
    await expect(week.getByRole('figure', { name: 'Tasks finished each day this week' })).toBeVisible();
    await week.getByRole('button', { name: 'Table' }).click();
    await expect(week.getByRole('table')).toContainText('Monday');
  });

  // 8. The person's record, kindly: on My outcomes.
  await flow('signals', async () => {
    await go(member, '/tasks/outcomes');
    await expect(member.getByRole('region', { name: 'How work went' })).toContainText('sent back');
    // The head sees the same on the person's page.
    await go(head, `/tasks/people/${E.kabir}`);
    await expect(head.getByRole('region', { name: 'How work went' })).toBeVisible();
  });

  // The screens, through the unstyled-page gate (production build, synthetic agency).
  if (shotsDir) await flow('screens', async () => {
    const reviewT = await given('Edit the Northstar walkthrough video', 'head', E.kabir, { projectId: E.fulfilment, dueOn: new Date(Date.now() + 86400000).toISOString().slice(0, 10) });
    await call(`work/tasks/${reviewT}/value`, { importance: 'high' }, 'head');
    await call('work/tasks', { title: 'Export the colour LUTs', parentId: reviewT, assigneeId: E.kabir }, 'member').then((x) => done(x.id, 'member'));
    await done(reviewT, 'member');
    const accepted = await given('Shoot the Lakeview amenities', 'head', E.kabir); await done(accepted, 'member'); await call(`tasks/${accepted}/accept`, { quality: 'great', above: true }, 'head');
    const cancelled = await given('Book a second drone', 'head', E.kabir); await call(`tasks/${cancelled}/move`, { status: 'cancelled', note: 'The first drone covers both shoots' }, 'member');
    const doing = await given('Grade the Sunrise reel', 'head', E.kabir); await call(`tasks/${doing}/move`, { status: 'in_progress' }, 'member');
    const founder = await given('Sign the office lease', 'admin', E.kedab); await done(founder, 'kedab');
    const SHOTS = [['task-review', `/tasks/${reviewT}`, 'head'], ['task-done-doer', `/tasks/${reviewT}`, 'member'], ['task-accepted', `/tasks/${accepted}`, 'member'],
      ['task-cancelled', `/tasks/${cancelled}`, 'member'], ['task-doing', `/tasks/${doing}`, 'member'], ['task-founder', `/tasks/${founder}`, 'admin'],
      ['reviews', '/tasks?view=reviews', 'head'], ['my-tasks-reviewer', '/tasks?view=me', 'head'], ['my-tasks-doer', '/tasks?view=me', 'member'], ['review-settings', '/settings?tab=work-rules', 'admin'],
      ['outcomes-signals', '/tasks/outcomes', 'member'], ['deleted', '/tasks?view=deleted', 'head'],
      ['notices', '/tasks?view=me', 'head', async (p) => { await p.getByRole('button', { name: /^Notifications/ }).click(); await p.locator('[data-card]').first().waitFor(); }]];
    const failedShots = [];
    for (const [name, path, role, prepare] of SHOTS) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      const r = await shot(browser, { base, path, email: emails[role], width, theme, out: shotsDir, name, prepare });
      if (r.problems.length) failedShots.push(`${name} ${width} ${theme}: ${r.problems.slice(0, 2).join(' | ')}`);
      console.log(`${r.problems.length ? 'GATE' : 'shot'} ${name} ${width} ${theme}${r.problems.length ? `: ${r.problems.slice(0, 2).join(' | ')}` : ''}`);
    }
    ok(!failedShots.length, `unstyled-page gate: ${failedShots.join(' ; ')}`);
  });

  const failed = results.filter((r) => !r.ok);
  const report = { results, checks, failed: failed.map((r) => r.name) };
  if (process.env.PULSE_TASKS4B_REPORT) await writeFile(process.env.PULSE_TASKS4B_REPORT, JSON.stringify(report, null, 1));
  if (evidence) await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 1));
  console.log(`${results.filter((r) => r.ok && !r.skipped).length} passed, ${failed.length} failed, ${checks} checks`);
  if (failed.length) process.exitCode = 1;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
