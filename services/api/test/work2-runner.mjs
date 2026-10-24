// UX-TASKS-2 screens through the real API and the built web app, on a disposable synthetic tenant
// (tests/core/test_work_domains.py::test_work_two_screens_in_the_browser). Optional screenshots: PULSE_WORK_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let apiChecks = 0, browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS);
const emails = { member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD, outsider: process.env.TEST_OUTSIDER_EMAIL, dev: process.env.TEST_DEV, tara: process.env.TEST_TARA,
  hr: 'hr@estateautopilots.com', admin: 'admin@estateautopilots.com' };
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
const pickProject = async (page, text) => { await page.getByRole('button', { name: /^Project:/ }).click(); await page.getByRole('combobox', { name: 'Project' }).fill(text); await page.keyboard.press('Enter'); };
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 159) throw Error('Work browser web did not start'); }
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const ctx = {}; for (const role of Object.keys(emails)) ctx[role] = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
    // 1. Inside Dev's domain (company policy: video editing for Pod 1 clients) his pod head assigns at once.
    const h = await ctx.head.newPage(); await go(h, '/tasks');
    await openCreate(h);
    await h.getByRole('textbox', { name: 'What needs doing' }).fill(`Edit the Skyline reel ${width}`);
    await h.getByRole('button', { name: /^Who does it:/ }).click();
    await h.getByRole('combobox', { name: 'Who does it' }).fill('Dev'); await h.keyboard.press('Enter');
    await pickProject(h, 'Northstar Heights');
    await expect(h.getByText('In Dev’s domain')).toBeVisible({ timeout: 15000 }); browserChecks++;
    await expect(h.getByText(/Pip suggests/)).toBeVisible(); browserChecks++;
    const direct = posted(h, 'work/tasks'); await h.getByRole('button', { name: 'Assign to Dev' }).click();
    const a = await (await direct).json(); check(a.assigned === true && a.mode.why === 'head_domain' && a.suggestion.valuePoints === undefined, 'in the domain: assigned directly');
    // 2. Outside his domains the same dialog sends a request to join.
    await openCreate(h);
    await h.getByRole('textbox', { name: 'What needs doing' }).fill(`Design the Skyline brochure ${width}`);
    await h.getByRole('button', { name: /^Who does it:/ }).click();
    await h.getByRole('combobox', { name: 'Who does it' }).fill('Dev'); await h.keyboard.press('Enter');
    await pickProject(h, 'Northstar Heights');
    await expect(h.getByRole('button', { name: 'Ask Dev to take it' })).toBeVisible({ timeout: 15000 }); browserChecks++;
    await expect(h.getByText(/Outside Dev’s domains/)).toBeVisible(); browserChecks++;
    check(await fits(h), `create dialog fits at ${width}`);
    const asked = posted(h, 'work/tasks'); await h.getByRole('button', { name: 'Ask Dev to take it' }).click();
    const q = await (await asked).json(); check(q.asked?.id && q.mode.why === 'outside_domains', 'outside: a request to join');
    // 3. HR throws a task in the pool and takes Pip's importance and estimate (no value: INTEGRITY 0910).
    const hrp = await ctx.hr.newPage(); await go(hrp, '/tasks');
    await openCreate(hrp);
    await hrp.getByRole('textbox', { name: 'What needs doing' }).fill(`Cut a 15-second teaser ${width}`);
    await hrp.getByRole('button', { name: 'Pool', exact: true }).click();
    // TASKS-4A: the pool is one choice in a list (it was a row of sixteen chips); the company's pool comes first.
    await expect(hrp.getByRole('button', { name: /^Which pool: Company pool/ })).toBeVisible(); browserChecks++;
    await expect(hrp.getByText(/Pip suggests/)).toBeVisible({ timeout: 15000 }); browserChecks++;
    await hrp.getByRole('button', { name: 'Use', exact: true }).click();
    const pooled = posted(hrp, 'work/tasks'); await hrp.getByRole('button', { name: 'Put in the pool' }).click();
    const p = await (await pooled).json(); check(p.pooled?.scope === 'company' && p.valued?.importance && p.valued.valuePoints === undefined && !p.assigned, 'pooled with Pip’s suggestion, no value');
    await go(hrp, '/tasks?view=pool'); await expect(hrp.locator('li').filter({ hasText: `Cut a 15-second teaser ${width}` }).first()).toBeVisible(); browserChecks++;
    // 4. Kabir claims it from the pool (first claim wins); the claim is his.
    const m = await ctx.member.newPage(); await go(m, '/tasks?view=pool');
    const row = m.locator('li').filter({ hasText: `Cut a 15-second teaser ${width}` }).first();
    const claimed = posted(m, `work/pool/${p.id}/claim`); await row.getByRole('button', { name: /^Claim/ }).click();
    check((await claimed).status() === 200, 'claimed from the pool');
    assert.equal((await call(`tasks/${p.id}`, undefined, 'member')).task.assigneeId, E.member);
    await call(`work/pool/${p.id}/claim`, {}, 'head', 409);
    check(await fits(m), `pool fits at ${width}`);
    // 5. Dev hears that a pool task fits his domains, with Claim on the card.
    const dn = await call('work/notices?limit=50', undefined, 'dev');
    check(dn.rows.some((n) => n.eventType === 'pool.match' && n.actions?.[0]?.label?.startsWith('Claim')), 'pool card for the person it fits');
    // 6. The leader's view: who works on what, departments with eight weeks, drill-down to a person.
    const ad = await ctx.admin.newPage(); await go(ad, '/tasks?view=team');
    await expect(ad.getByRole('heading', { name: /Who is working on what/ })).toBeVisible(); browserChecks++;
    await expect(ad.getByRole('heading', { name: /Finished per week/ })).toBeVisible(); browserChecks++;
    check(await fits(ad), `leader view fits at ${width}`);
    await ad.getByRole('link', { name: 'Departments', exact: true }).click(); await expect(ad).toHaveURL(/group=department/, { timeout: 30000 }); await ready(ad);
    await expect(ad.getByRole('link', { name: /Creative/ }).first()).toBeVisible(); browserChecks++;
    await go(ad, '/tasks?view=team');
    check(await ad.locator(`a[href="/tasks/people/${E.dev}"]`).count() >= 1, 'each person drills down');
    await go(ad, `/tasks/people/${E.dev}`);
    await expect(ad.getByRole('heading', { name: 'Dev Panab', level: 2 })).toBeVisible(); browserChecks++;
    await expect(ad.getByRole('heading', { name: /Eight weeks/ })).toBeVisible(); browserChecks++;
    check(await fits(ad), `person view fits at ${width}`);
    // 7. The priority on a task: the head takes Pip's suggestion (importance and effort; no value: INTEGRITY 0910).
    await go(h, `/tasks/${a.id}`);
    const valueCard = h.getByRole('region', { name: 'Priority' });
    await expect(valueCard).toBeVisible(); browserChecks++;
    check(await valueCard.getByText(/\d+\s*(pts?|points)/).count() === 0, 'no points on the task');
    const useIt = valueCard.getByRole('button', { name: /Use Pip’s suggestion/ });
    if (await useIt.count()) { const v = posted(h, `work/tasks/${a.id}/value`); await useIt.first().click(); check((await v).status() === 200, 'Pip’s suggestion taken'); }
    check(await fits(h), `task page fits at ${width}`);
    if (width === 1440) {
      // 8. Kabir proposes a domain; his pod head agrees on Kabir's profile.
      await go(m, `/people/${E.member}?tab=domains`);
      await m.getByRole('button', { name: 'Propose a domain' }).first().click();
      const dialog = m.getByRole('dialog'); await dialog.getByRole('button', { name: 'Video editing', exact: true }).click();
      await dialog.getByRole('radio', { name: 'A pod’s clients' }).click(); await dialog.getByLabel('Pod').selectOption('Pod 1');
      const sent = posted(m, 'work/domains'); await dialog.getByRole('button', { name: 'Send the proposal' }).click();
      const prop = await (await sent).json(); check(!!prop.id, 'proposed by the person');
      await go(h, `/people/${E.member}?tab=domains`);
      const agree = posted(h, `work/domains/${prop.id}/accept`); await h.getByRole('button', { name: 'Agree' }).first().click();
      check((await agree).status() === 200, 'agreed by the head');
      const mine = await call('work/domains', undefined, 'member');
      check(mine.domains.some((x) => x.id === prop.id && x.status === 'active' && x.agreedOn), 'active, with a date');
      // 9. Leadership links a client folder that EA filed under the package (Project 2) in one click.
      await go(ad, `/projects/${E.northstar}?tab=includes`);
      const sug = ad.locator('li').filter({ hasText: 'Northstar Skyline' }).first();
      const linked = ad.waitForResponse((r) => /\/api\/v0\/work\/links\/[0-9a-f-]+\/link$/.test(r.url()) && r.request().method() === 'POST', { timeout: 30000 });
      await sug.getByRole('button', { name: 'Link' }).click(); check((await linked).status() === 200, 'linked in one click');
      const pk = await call(`work/package/${E.northstar}`, undefined, 'admin');
      check(pk.links.linked.some((l) => l.projectId === E.skyline), 'the package includes the folder');
      // 10. The business model names things: a product company sees Releases.
      await go(ad, '/settings?tab=work-rules');
      const set = posted(ad, 'work/settings'); await ad.getByRole('radio', { name: /Product or IT/ }).click(); check((await set).status() === 200, 'business model saved');
      await go(ad, '/projects'); await expect(ad.getByRole('heading', { name: 'Releases', level: 2 })).toBeVisible(); browserChecks++;
      await call('work/settings', { businessModel: 'agency' }, 'admin');
      // 11. My tasks: the week, your domains and the pool; no value credited anywhere (INTEGRITY 0910).
      await go(m, '/tasks'); await expect(m.getByRole('heading', { name: 'Your domains' })).toBeVisible(); browserChecks++;
      check(await m.getByText('value credited').count() === 0, 'no value credited on My tasks');
    }
    for (const c of Object.values(ctx)) await c.close();
  }
  if (shots) {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      const make = async (role) => { const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
        await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme); return c; };
      const admin = await make('admin'), head = await make('head'), hr = await make('hr'), member = await make('member'), tara = await make('tara');
      const ap = await admin.newPage(), hp = await head.newPage(), rp = await hr.newPage(), mp = await member.newPage(), tp = await tara.newPage();
      const shot = async (pg, name) => { await pg.waitForTimeout(250); await pg.screenshot({ path: `${shots}/${name}-${width}-${theme}.png` }); };
      await go(hp, '/tasks'); await openCreate(hp);
      await hp.getByRole('textbox', { name: 'What needs doing' }).fill('Edit the Northstar walkthrough');
      await hp.getByRole('button', { name: /^Who does it:/ }).click(); await hp.getByRole('combobox', { name: 'Who does it' }).fill('Dev'); await hp.keyboard.press('Enter');
      await pickProject(hp, 'Northstar Heights'); await expect(hp.getByText('In Dev’s domain')).toBeVisible({ timeout: 15000 }); await shot(hp, '01-create-in-domain');
      await hp.getByRole('textbox', { name: 'What needs doing' }).fill('Design the Northstar brochure'); await expect(hp.getByText(/Outside Dev’s domains/)).toBeVisible({ timeout: 15000 }); await shot(hp, '02-create-request-to-join');
      await hp.keyboard.press('Escape');
      await go(rp, '/tasks'); await openCreate(rp);
      await rp.getByRole('textbox', { name: 'What needs doing' }).fill('Refresh the Lakeview ad set'); await rp.getByRole('button', { name: 'Pool', exact: true }).click();
      await expect(rp.getByText(/Pip suggests/)).toBeVisible({ timeout: 15000 }); await shot(rp, '03-create-pool-with-pip'); await rp.keyboard.press('Escape');
      await go(mp, '/tasks?view=pool'); await shot(mp, '04-pool');
      await go(mp, '/tasks'); await shot(mp, '05-my-tasks-value-domains');
      await go(ap, '/tasks?view=team'); await shot(ap, '06-leader-people');
      await go(ap, '/tasks?view=team&group=department'); await shot(ap, '07-leader-departments');
      await go(ap, '/tasks?view=team&group=pod'); await shot(ap, '08-leader-pods');
      await go(ap, `/tasks/people/${E.dev}`); await shot(ap, '09-person-drilldown');
      await go(tp, `/people/${E.tara}?tab=domains`); await shot(tp, '10-domains-own-proposal');
      await go(rp, `/people/${E.dev}?tab=domains`); await shot(rp, '11-domains-policy');
      await go(rp, `/people/${E.tara}?tab=domains`); await rp.getByRole('button', { name: 'Propose a domain' }).first().click(); await shot(rp, '12-propose-domain'); await rp.keyboard.press('Escape');
      await go(hp, `/tasks/${E.task}`); await shot(hp, '13-task-value');
      await go(ap, `/projects/${E.northstar}?tab=includes`); await shot(ap, '14-package-includes');
      await go(ap, '/tasks?view=projects&review=1'); await shot(ap, '15-link-review');
      await go(ap, '/settings?tab=work-rules'); await shot(ap, '16-work-model-and-rules');
      await go(mp, '/notifications'); await shot(mp, '17-notifications');
      for (const c of [admin, head, hr, member, tara]) await c.close();
    }
  }
  const receipt = JSON.stringify({ apiChecks, browserChecks });
  await writeFile(process.env.PULSE_WORK_REPORT, receipt); console.log(receipt);
} catch (e) {
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) console.error('PAGE', p.url().replace(base, ''), (await p.locator('main').innerText().catch(() => '')).slice(0, 600));
  throw e;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
