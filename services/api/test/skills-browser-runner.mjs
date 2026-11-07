// R48 in the browser (tests/core/test_structured_skills.py): the real API on a disposable synthetic agency and the web
// app under `next dev`. The person adds a skill from the list, sees their pod head's separate mark and their approved
// work, reviews and keeps their CV; the pod head opens the kept CV (logged) and can verify; HR looks after the list.
// Screenshots with PULSE_R48_SCREENSHOTS=<dir>. Every person, code, label and task is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { BLOCKING, SIZES, auditLayout, settle } from '../../../tests/e2e/layout-audit.mjs';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_R48_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const emails = { editor: E.editorEmail, head: E.headEmail, hr: 'hr@estateautopilots.com' };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-r48', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
let browser, checks = 0;
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const errors = [];
// RELEASE-6: under load on 13 Oct this runner gave no output for 40 minutes, until pytest killed it. Each step now
// says when it starts, a stuck run stops itself after 25 minutes naming the step (a quiet run takes about 3), and
// the cleanup cannot wait forever, so a failure is reported instead of a silent timeout.
let current = 'start';
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`skills-browser-runner: no result after 25 minutes (step ${current})`); server.kill('SIGKILL'); process.exit(1); }, 25 * 60_000);
deadline.unref();
const within = (promise, ms) => Promise.race([promise, delay(ms)]);
async function context(role, { width = 1440, theme = 'light' } = {}) {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const tab = `/people/${E.editor}?tab=skills`;
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } await delay(500); if (i === 599) throw Error('next dev did not start'); }
  browser = await chromium.launch();
  // 1. The person: their skills with the pod head's separate mark and approved work; add one from the list.
  step(1);
  {
    const c = await context('editor'), page = await open(c, tab, 'editor skills');
    await seen(page.getByRole('heading', { name: 'Your skills and work' }));
    const edit = page.locator('li[data-skill="edit video footage"]');
    await seen(edit.getByText('Strong'));
    await seen(edit.getByText(/Verified Working by Editor Two \(manager\)/));
    await seen(edit.getByText('Synthetic launch reel'));
    await seen(edit.getByText('Approved'));
    await seen(page.locator('li[data-skill="Model shoot direction"]').getByText('Local'));
    await seen(page.getByText('This service uses the ESCO classification of the European Commission.'));
    await seen(page.getByText('Pulse’s starting scale: HR hasn’t confirmed its own yet.'));
    assert.ok(await fits(page), 'skills tab fits 1440'); checks++;
    await shot(page, 'skills-person-1440-light');
    await page.getByRole('button', { name: 'Add a skill' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add a skill' });
    await drawer.getByLabel('Search skills').fill('वीडियो');
    await seen(drawer.getByText(/Local name “वीडियो एडिटिंग” \(hi, not an official translation\)/), 60000);
    await seen(drawer.getByText('On your profile'));
    await drawer.getByLabel('Search skills').fill('drone');
    await drawer.getByRole('button', { name: /operate camera drone/ }).click();
    await drawer.getByText('3 Strong').click();
    await drawer.getByText('Synthetic launch reel').click();
    await shot(page, 'skills-add-drawer-1440-light');
    await drawer.getByRole('button', { name: 'Save' }).click();
    const drone = page.locator('li[data-skill="operate camera drone"]');
    await seen(drone.getByText('Not verified yet'), 60000);
    await seen(drone.getByText('Synthetic launch reel'));
    // Review and keep the CV: exactly the text read.
    await page.getByRole('button', { name: 'Review and keep' }).click();
    const cv = page.getByRole('dialog', { name: 'Your internal CV' });
    await cv.getByLabel('Headline (optional)').fill('Synthetic video editor');
    await cv.getByRole('button', { name: 'Show the result' }).click();
    await seen(cv.getByRole('article').getByText('Synthetic video editor'), 60000);
    await seen(cv.getByRole('article').getByText(/verified Working by Editor Two/));
    await shot(page, 'cv-review-1440-light');
    await cv.getByRole('button', { name: 'Keep this version' }).click();
    await seen(page.getByText(/Version 1, kept/), 60000);
    await c.close();
  }
  // 2. The same page on a phone, dark.
  step(2);
  {
    const c = await context('editor', { width: 390, theme: 'dark' }), page = await open(c, tab, 'editor phone');
    await seen(page.getByRole('heading', { name: 'Your skills and work' }));
    await seen(page.locator('html[data-theme="dark"]'));
    await page.locator('#skills-list').scrollIntoViewIfNeeded();
    assert.ok(await fits(page), 'skills tab fits 390'); checks++;
    await shot(page, 'skills-person-390-dark');
    await c.close();
  }
  // 3. The pod head: reads, can verify (separately), opens the kept CV (a logged read).
  step(3);
  {
    const c = await context('head'), page = await open(c, tab, 'head skills');
    await seen(page.getByRole('heading', { name: 'Editor’s skills and work' }));
    assert.equal(await page.getByRole('button', { name: 'Add a skill' }).count(), 0, 'only the person adds skills'); checks++;
    const drone = page.locator('li[data-skill="operate camera drone"]');
    await drone.getByRole('button', { name: 'Verify' }).click();
    const verify = page.getByRole('dialog', { name: 'Verify operate camera drone' });
    await verify.getByRole('radio', { name: '2 Working' }).check();
    await shot(page, 'verify-drawer-1440-light');
    await verify.getByRole('button', { name: 'Verify' }).click();
    await seen(drone.getByText(/Verified Working by Editor Two \(manager\)/), 60000);
    await seen(drone.getByText('Strong'));
    await page.getByRole('button', { name: 'Open the CV' }).click();
    const opened = page.getByRole('dialog', { name: 'Editor’s CV' });
    await seen(opened.getByText(/Version 1, kept by Editor/));
    await seen(opened.getByRole('link', { name: 'Download' }));
    await shot(page, 'cv-open-pod-head-1440-light');
    await c.close();
  }
  // 4. The person sees who opened it, and that the CV changed since (the new verification).
  step(4);
  {
    const c = await context('editor'), page = await open(c, tab, 'editor again');
    await seen(page.getByText(/Editor Two opened it/));
    await seen(page.getByText('Your skills or experience changed since you kept it: review it again.'));
    await c.close();
  }
  // 5. HR: the list, its provenance and the scale.
  step(5);
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const c = await context('hr', { width, theme }), page = await open(c, '/people/skills', `hr list ${width}`);
    await seen(page.getByRole('heading', { name: 'Industry taxonomy' }));
    await seen(page.locator(`html[data-theme="${theme}"]`));
    await seen(page.getByText('ESCO 1.0-synthetic'));
    await seen(page.getByText('Model shoot direction'));
    await seen(page.getByText('वीडियो एडिटिंग'));
    assert.ok(await fits(page), `skills list fits ${width}`); checks++;
    await shot(page, `skills-list-${width}-${theme}`);
    await c.close();
  }
  // 6. The owner's layout rules (tests/e2e/layout-audit.mjs) at its five sizes: nothing covered, cut off or out of reach.
  step(6);
  for (const [role, path] of [['editor', tab], ['head', tab], ['hr', '/people/skills']]) {
    const problems = [];
    for (const [width, height] of SIZES) {
      const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
      const page = await open(c, path, `layout ${role} ${width}`);
      await seen(page.locator('main h3').first());
      await settle(page, 400);
      const { findings } = await page.evaluate(auditLayout, {});
      for (const f of findings) if (BLOCKING.includes(f.rule)) problems.push(`${role} ${path} ${width}×${height} ${f.rule}: ${f.where} — ${f.detail}`);
      await c.close();
    }
    assert.deepEqual(problems, [], problems.join('\n')); checks++;
  }
  assert.deepEqual(errors, []);
  if (process.env.PULSE_R48_REPORT) writeFileSync(process.env.PULSE_R48_REPORT, JSON.stringify({ browserChecks: checks, screenshots: shots ?? null }));
  console.log(`browser checks: ${checks}`);
} finally { await within(browser?.close(), 30000); server.kill(); await within(app.close(), 15000); await within(pool.end(), 15000); clearTimeout(deadline); }
