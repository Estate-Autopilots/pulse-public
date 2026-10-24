// R49 in the browser (tests/core/test_internal_ats.py): the real API on a disposable synthetic agency and the web app
// under `next dev`. HR reads how matching works and accepts it, opens the job, reads candidates' explanations (the
// skill that counted and the arithmetic, the others not added, unknowns, below the level asked), changes the job's
// skills, opens the job, picks a person and asks another to check; the person answers on their Skills & CV tab; a
// colleague cannot open internal jobs. Screenshots with PULSE_R49_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { BLOCKING, SIZES, auditLayout, settle } from '../../../tests/e2e/layout-audit.mjs';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_R49_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const emails = { editor: E.editorEmail, head: E.headEmail, hr: 'hr@estateautopilots.com' };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-r49', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
// v0.3.66 train (18 Oct): the retry's `next dev` never answered (no log at all) while the first attempt's server may
// still have held .next-r49. The server now runs in its own process group and is ended whole; if it exits early, the run
// stops at once with the end of its stderr instead of waiting 5 minutes.
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, last;
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const errors = [];
// RELEASE-6: under load on 13 Oct this runner gave no output for 40 minutes, until pytest killed it. Each step now
// says when it starts, a stuck run stops itself after 25 minutes naming the step (a quiet run takes about 3), and
// the cleanup cannot wait forever, so a failure is reported instead of a silent timeout.
let current = 'start';
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`ats-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const within = (promise, ms) => Promise.race([promise, delay(ms)]);
async function context(role, { width = 1440, theme = 'light' } = {}) {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const job = `/people/jobs/${E.job}`, tab = `/people/${E.editor}?tab=skills`;
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(500); if (i === 599) throw Error('next dev did not start'); }
  browser = await chromium.launch();
  // 1. HR: the published method, not accepted yet; HR accepts it after reading explanations.
  step(1);
  {
    const c = await context('hr'), page = await open(c, '/people/jobs', 'hr jobs');
    await seen(page.getByRole('heading', { name: 'How matching works' }));
    await seen(page.getByRole('link', { name: 'Synthetic launch editor' }));
    await seen(page.getByText('Not accepted by HR yet.'));
    await seen(page.getByText(/A required skill is worth/));
    assert.ok(await fits(page), 'jobs list fits 1440'); checks++;
    await shot(page, 'jobs-1440-light');
    await page.getByRole('button', { name: 'Accept' }).click();
    const accept = page.getByRole('dialog', { name: 'Accept the matching method' });
    await accept.getByLabel('Which example explanations did you check?').fill('Synthetic: the launch editor job, the top three and two people with unknowns');
    await accept.getByRole('button', { name: 'Accept' }).click();
    await seen(page.getByText(/Accepted by Project Lead/), 60000);
    await c.close();
  }
  // 2. HR on the job: skills, the ranking and its explanations; change the skills; open the job; pick; ask a check.
  step(2);
  {
    const c = await context('hr'), page = await open(c, job, 'hr job');
    await seen(page.getByRole('heading', { name: 'Skills the job needs' }));
    await seen(page.getByText('Also accepted as the same: Reel editing'));
    await seen(page.getByText(/use spreadsheet software \(ESCO|Synthetic Spreadsheets \(O\*NET, same skill \(counts\)\)/));
    const top = page.locator('li[data-person="Editor One"]');
    await seen(top.getByText('5.4 / 9'));
    await top.locator('summary').click();
    await seen(top.getByText('Counts: 3 (required) × 1 (verified) = 3'));
    await seen(top.getByText(/On record, not added: one skill counts per requirement/));
    await seen(top.getByText(/verified Strong by Editor Two \(manager\)/));
    await seen(top.getByText(/Nothing on record for this skill\. That is not a sign Editor can’t do it/));
    const out = page.locator('li[data-person="Pod Two Outsider"]');
    await out.locator('summary').click();
    await seen(out.getByText(/Below the level asked \(Learning; the job asks Working\): counts 0/));
    await seen(out.getByText(/× 0.5 \(not used in the last 12 months\)/));
    await seen(page.getByRole('button', { name: /Show 2 people with nothing on record/ }));
    assert.equal(await page.locator('li[data-person="Pod Manager"]').count(), 0, 'people with nothing on record are folded, not removed'); checks++;
    await page.getByRole('button', { name: /Show 2 people with nothing on record/ }).click();
    await seen(page.locator('li[data-person="Pod Manager"]').getByText('up to 9'));
    assert.ok(await fits(page), 'job page fits 1440'); checks++;
    await shot(page, 'job-explained-1440-light');
    // A draft: nobody can be picked yet.
    await seen(top.getByText('Open the job to pick people.'));
    // Add a preferred skill and take it out again.
    await page.locator('#job-skills').getByRole('button', { name: 'Add a skill' }).click();
    const add = page.getByRole('dialog', { name: 'Add a skill the job needs' });
    await add.getByLabel('Search skills').fill('spreadsheet');
    await seen(add.getByText('Already on the job'), 60000);
    await add.getByLabel('Search skills').fill('reel ed');
    await add.getByRole('button', { name: /Reel editing/ }).click();
    await add.getByText('Preferred', { exact: true }).click();
    await shot(page, 'job-add-skill-1440-light');
    await add.getByRole('button', { name: 'Save' }).click();
    const reel = page.locator('#job-skills li').filter({ has: page.locator('b', { hasText: /^Reel editing$/ }) });
    await seen(reel, 60000);
    await reel.getByRole('button', { name: 'Remove' }).click();
    await expect(reel).toHaveCount(0, { timeout: 60000 }); checks++;
    // Open the job, pick Editor One, ask Editor One to check an unknown skill.
    await page.locator('section[aria-label="The job"]').getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit the job' });
    await edit.getByRole('radio', { name: /^Open/ }).check();
    await edit.getByRole('button', { name: 'Save' }).click();
    await seen(page.getByText('Open', { exact: true }), 60000);
    if (!(await top.locator('details').evaluate((d) => d.open))) await top.locator('summary').click();
    await top.getByRole('button', { name: 'Pick' }).click();
    const pick = page.getByRole('dialog', { name: 'Pick Editor One' });
    await pick.getByLabel('Why you pick them').fill('Synthetic: strongest launch cuts, verified');
    await pick.getByRole('button', { name: 'Pick' }).click();
    await seen(page.locator('#job-picks').getByText('“Synthetic: strongest launch cuts, verified”'), 60000);
    if (!(await top.locator('details').evaluate((d) => d.open))) await top.locator('summary').click();
    await top.getByRole('button', { name: 'Ask to check' }).click();
    const ask = page.getByRole('dialog', { name: 'Ask Editor to check' });
    await ask.getByLabel('Question for Editor').fill('Synthetic: have you flown aerial camera shoots? Add it if so.');
    await ask.getByRole('button', { name: 'Ask' }).click();
    await seen(page.locator('#job-checks').getByText('Waiting'), 60000);
    await c.close();
  }
  // 3. The person: the check on their Skills & CV tab, with what Pulse read about them for that skill only; they answer.
  step(3);
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const c = await context('editor', { width, theme }), page = await open(c, tab, `editor ${width}`);
    const card = page.locator('#skills-checks');
    await seen(card.getByRole('heading', { name: 'Checks from HR' }));
    await seen(card.getByText('“Synthetic: have you flown aerial camera shoots? Add it if so.”'));
    await seen(card.getByText(/Nothing on record for this skill yet\. It counts 0, never a minus/));
    assert.equal(await card.getByText('Synthetic launch editor').count(), 0, 'the job is not shown to the person'); checks++;
    assert.equal(await card.getByText('Pod Two Outsider').count(), 0, 'nobody else is shown'); checks++;
    await card.scrollIntoViewIfNeeded();
    assert.ok(await fits(page), `check card fits ${width}`); checks++;
    if (width === 1440) {
      await card.getByRole('button', { name: 'Answer' }).click();
      const answer = page.getByRole('dialog', { name: 'Answer about pilot aerial camera' });
      await answer.getByLabel('Your answer (optional)').fill('Synthetic: not yet; happy to learn');
      await answer.getByRole('button', { name: 'Send' }).click();
      await seen(card.getByText(/Your answer: “Synthetic: not yet; happy to learn”/), 60000);
    }
    await shot(page, `check-person-${width}-${theme}`);
    await c.close();
  }
  // 4. A colleague cannot open internal jobs; HR sees the answer and closes the check; the job on a phone.
  step(4);
  {
    const c = await context('head'), page = await open(c, '/people/jobs', 'head jobs');
    await seen(page.getByText('Internal jobs are for HR and admins.'));
    await c.close();
  }
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const c = await context('hr', { width, theme }), page = await open(c, job, `hr job ${width}`);
    await seen(page.locator(`html[data-theme="${theme}"]`));
    await seen(page.locator('#job-checks').getByText(/Synthetic: not yet; happy to learn/));
    if (width === 1440) {
      // Flaky timing: a click that lands before the page has hydrated opens nothing (CI under load); click until it opens.
      const closing = page.getByRole('dialog', { name: 'Close the check' });
      await expect(async () => {
        if (!(await closing.isVisible())) await page.locator('#job-checks').getByRole('button', { name: 'Close' }).click();
        await expect(closing).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 60000 });
      await closing.getByRole('button', { name: 'Close check' }).click();
      await seen(page.locator('#job-checks').getByText(/Closed by Project Lead/), 60000);
    } else {
      const top = page.locator('li[data-person="Editor One"]');
      await top.locator('summary').click();
      await seen(top.getByText('Counts: 3 (required) × 1 (verified) = 3'));
      assert.ok(await fits(page), 'job page fits 390'); checks++;
    }
    await shot(page, `job-${width}-${theme}`);
    await c.close();
  }
  // 5. The owner's layout rules (tests/e2e/layout-audit.mjs) at its five sizes: nothing covered, cut off or out of reach.
  step(5);
  for (const [role, path] of [['hr', '/people/jobs'], ['hr', job], ['editor', tab]]) {
    const problems = [];
    for (const [width, height] of SIZES) {
      const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
      const page = await open(c, path, `layout ${role} ${width}`);
      await seen(page.locator('main h3').first());
      if (path === job) await page.locator('li[data-person="Editor One"] summary').click();
      await settle(page, 400);
      const { findings } = await page.evaluate(auditLayout, {});
      for (const f of findings) if (BLOCKING.includes(f.rule)) problems.push(`${role} ${path} ${width}×${height} ${f.rule}: ${f.where} — ${f.detail}`);
      await c.close();
    }
    assert.deepEqual(problems, [], problems.join('\n')); checks++;
  }
  assert.deepEqual(errors, []);
  if (process.env.PULSE_R49_REPORT) writeFileSync(process.env.PULSE_R49_REPORT, JSON.stringify({ browserChecks: checks, screenshots: shots ?? null }));
  console.log(`browser checks: ${checks}`);
} catch (e) {
  // What the page showed when a check failed (for the log; synthetic data only).
  if (last && process.env.PULSE_R49_FAILURE) { await last.screenshot({ path: `${process.env.PULSE_R49_FAILURE}.png` }).catch(() => undefined); writeFileSync(`${process.env.PULSE_R49_FAILURE}.txt`, `${last.url()}\n${await last.innerText('body').catch(() => '')}\n${errors.join('\n')}`); }
  throw e;
} finally { await within(browser?.close(), 30000); stopServer(); await within(app.close(), 15000); await within(pool.end(), 15000); clearTimeout(deadline); }
