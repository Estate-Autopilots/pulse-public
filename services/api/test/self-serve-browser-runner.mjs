// SELF-SERVE in the browser (tests/core/test_self_serve_setup.py): the real API on synthetic data, the web app under
// `next dev`, signed out like a stranger. Each type signs up (Which describes you? What will you use Pulse for? name and
// e-mail, the e-mailed code from the mail sink) at 390 px or on a computer, and lands on its first useful screen with
// its getting-started cards: timed from "Create my space" and from the first page. The psychologist adds a client and
// books the first appointment; the client's e-mailed link opens their space with one press and shows it. A new person
// signs up on the way to the ChatGPT/Claude connector and comes back to its consent screen. No sideways scroll, no page
// errors, no dead end ("Nearly there", "Not part of your access"). Screenshots with PULSE_SS_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/auth-mail.js';

const E = process.env, pool = new Pool(JSON.parse(E.TEST_API_CONFIG)), app = createApp(pool, pool);
const shots = E.PULSE_SS_SCREENSHOTS; if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-ss', NEXT_TELEMETRY_DISABLED: '1', PULSE_PUBLIC_LOGIN_ENABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`self-serve-browser-runner: no result after 28 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 28 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const noDeadEnd = async (page, what) => { const t = await page.locator('body').innerText(); assert.ok(!/Nearly there|Not part of your access|This page could not be found|Something went wrong/i.test(t), `${what}: a dead end`); checks++; };
const errors = [], consoleErrors = [];
const context = (width) => { const phone = width < 600; return browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone }); };
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${name}: ${page.url().split('#')[0]} ${m.location()?.url ?? ''} ${m.text().slice(0, 100)} ... ${m.text().slice(-600)}`); });
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const run = Date.now().toString(36);
const mailTo = async (to, title) => { for (let i = 0; i < 100; i++) { const m = testMail.filter((x) => x.to === to && x.title === title).at(-1); if (m) return m; await delay(100); } throw new Error(`no mail to ${to}`); };
const report = { firstUseful: {}, journey: {} };

/** A stranger signs up in the browser and lands on the first useful screen; answers what was timed. */
async function signup(page, key, { profiles, space, orgName, served, name, width }) {
  const t0 = performance.now(), email = `ssb.${key}.${width}.${run}@gmail.example`;
  await seen(page.getByRole('heading', { name: 'Create your Pulse account' }));
  if (key === 'practice') { await shot(page, `${key}-1-who-${width}`); }
  for (const p of profiles) await page.getByRole('button', { name: new RegExp(p) }).first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await seen(page.getByRole('heading', { name: 'Set up your space' }));
  await page.getByRole('radio', { name: new RegExp(space) }).click();
  if (orgName) { await page.getByLabel(/practice’s name|organisation’s name/).fill(orgName); if (served) await page.getByRole('button', { name: served, exact: true }).click(); }
  await fits(page, `${key} second question at ${width}`);
  if (key === 'practice' || key === 'student') await shot(page, `${key}-2-use-${width}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await seen(page.getByRole('heading', { name: 'Your details' }));
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'E-mail me a code' }).click();
  await seen(page.getByRole('heading', { name: 'Check your e-mail' }));
  const code = (await mailTo(email, 'Your Pulse sign-up code')).body.match(/sign-up code is (\d{6})/)[1];
  await page.getByLabel('6-digit code').fill(code);
  if (key === 'practice') await shot(page, `${key}-3-code-${width}`);
  const t1 = performance.now();
  await page.getByRole('button', { name: /Create my space|Create my account and continue/ }).click();
  return { email, t0, t1 };
}
async function landed(page, key, t, width, firstCard) {
  await seen(page.getByRole('heading', { name: /^Getting .* started$/ }), 240000);
  await seen(page.getByText(firstCard, { exact: true }));
  report.firstUseful[`${key}@${width}`] = Math.round(performance.now() - t.t1); report.journey[`${key}@${width}`] = Math.round(performance.now() - t.t0);
  await fits(page, `${key} home at ${width}`); await noDeadEnd(page, `${key} home`);
  await shot(page, `${key}-4-home-${width}`);
}

try {
  step('next dev');
  for (let i = 0; i < 180; i++) { if (serverExit !== null) throw new Error(`next dev exited (${serverExit}): ${serverTail}`); try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(2000); }
  browser = await chromium.launch();
  // Warm the pages once (next dev compiles on first visit) so the timings measure Pulse, not the compiler.
  for (const p of ['/signup', '/login', '/dashboard', '/my-day', '/clients/add', '/appointments', '/invited', '/client', '/settings']) await fetch(base + p).catch(() => null);

  const journeys = [
    ['practice', { profiles: ['Professional practice'], space: 'My practice', orgName: `Synthetic Omoza Pesub Practice ${run}`, served: 'Patients', name: 'Synthetic Omoza Pesub', width: 390 }, 'Add your first patient'],
    ['student', { profiles: ['Student'], space: 'Just me', name: 'Synthetic Rila Shah', width: 390 }, 'Add three things to do this week'],
    ['employee', { profiles: ['I work at a company'], space: 'Just me', name: 'Synthetic Dev Kalah', width: 1440 }, 'Add three things to do this week'],
    ['creator', { profiles: ['Creator, model or artist'], space: 'Just me', name: 'Synthetic Mira Kapoor', width: 390 }, 'Add three things to do this week'],
    ['agency', { profiles: ['Freelancer', 'Business owner'], space: 'Agency or studio', orgName: `Synthetic Pixel Studio ${run}`, name: 'Synthetic Neha Iyer', width: 1440 }, 'Add your first client'],
    ['shop', { profiles: ['Business owner'], space: 'Shop or store', orgName: `Synthetic Chai Corner ${run}`, served: 'Customers', name: 'Synthetic Ravi Panab', width: 390 }, 'Add your first customer'],
    ['maker', { profiles: ['Business owner'], space: 'Manufacturer or dealer', orgName: `Synthetic Steel Works ${run}`, served: 'Dealers', name: 'Synthetic Ahoro Rao', width: 1440 }, 'Add your first dealer'],
    ['real_estate', { profiles: ['Business owner'], space: 'Real estate', orgName: `Synthetic Homes ${run}`, served: 'Buyers', name: 'Synthetic Kavya Nair', width: 390 }, 'Add your first buyer'],
    ['school', { profiles: ['Business owner'], space: 'School or classes', orgName: `Synthetic Academy ${run}`, served: 'Students', name: 'Synthetic Tara Pillai', width: 1440 }, 'Add your first student'],
    ['ngo', { profiles: ['Something else'], space: 'NGO or community', orgName: `Synthetic Care Trust ${run}`, served: 'Donors', name: 'Synthetic Sana Qipedot', width: 390 }, 'Add your first donor'],
    ['other', { profiles: ['Business owner'], space: 'Another kind of organisation', orgName: `Synthetic Team ${run}`, name: 'Synthetic Ishaan Gobap', width: 1440 }, 'Invite your team'],
  ];
  let practice = null;
  for (const [key, a, firstCard] of journeys) {
    step(`sign up: ${key} at ${a.width}`);
    const c = await context(a.width); const page = await open(c, '/signup', key);
    const t = await signup(page, key, a);
    await landed(page, key, t, a.width, firstCard);
    if (key === 'practice') practice = { c, page, email: t.email }; else await c.close();
  }
  // The practice also on a computer: the same questions fit and lead to the same home.
  step('practice at 1440');
  { const c = await context(1440); const page = await open(c, '/signup', 'practice-desktop');
    const t = await signup(page, 'practice', { profiles: ['Professional practice'], space: 'My practice', orgName: `Synthetic Mind Clinic ${run}`, served: 'Clients', name: 'Synthetic Anil Desai', width: 1440 });
    await landed(page, 'practice', t, 1440, 'Add your first client'); await c.close(); }

  step('the psychologist adds a client');
  const { page } = practice;
  await page.getByRole('link', { name: 'Open' }).first().click();
  await seen(page.getByRole('heading', { name: 'Add a patient' }));
  await fits(page, 'add a patient at 390'); await shot(page, 'practice-5-add-client-390');
  const clientEmail = `ssb.client.${run}@gmail.example`;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Synthetic Asha Rao');
  await page.getByRole('textbox', { name: /^E-mail/ }).fill(clientEmail);
  await page.getByRole('button', { name: 'Add and e-mail their link' }).click();
  await seen(page.getByRole('heading', { name: 'Synthetic Asha Rao is added' }));
  await seen(page.getByText(new RegExp(`We e-mailed ${clientEmail.replace(/\./g, '\\.')} a link`)));
  await page.getByRole('button', { name: 'Book the appointment' }).click();
  await seen(page.getByText(/^Booked for /));
  await fits(page, 'client added at 390'); await noDeadEnd(page, 'client added'); await page.evaluate(() => window.scrollTo(0, 0)); await shot(page, 'practice-6-added-booked-390');

  step('the client opens the e-mailed link');
  const mail = await mailTo(clientEmail, 'Synthetic Omoza Pesub has set up your space on Pulse');
  const link = mail.body.match(/https?:\/\/\S+\/invited#[A-Za-z0-9_-]{43}.[A-Za-z0-9_-]{43}/)[0];
  // The link the professional copies or shares (no key) asks for details: no one click (review, 5 Nov 2026).
  const sc = await context(390);
  const sp = await open(sc, '/invited#' + link.split('#')[1].split('.')[0], 'shared link');
  await seen(sp.getByText(/Synthetic Omoza/).first()); await delay(1500);
  assert.equal(await sp.getByRole('button', { name: /Open my space/ }).count(), 0, 'the shared link has no one click'); checks++;
  await fits(sp, 'shared link at 390'); await shot(sp, 'client-0-shared-link-390'); await sc.close();
  const cc = await context(390);
  const cp = await open(cc, '/invited#' + link.split('#')[1], 'client');
  await seen(cp.getByRole('button', { name: /Open my space/ }));
  await fits(cp, 'invitation at 390'); await shot(cp, 'client-1-invited-390');
  const t2 = performance.now();
  await cp.getByRole('button', { name: /Open my space/ }).click();
  await seen(cp.getByRole('heading', { name: 'Your appointments' }), 240000);
  await seen(cp.locator('[data-appointment]'));
  report.firstUseful['client@390'] = Math.round(performance.now() - t2);
  assert.match(cp.url(), /\/client/); await fits(cp, 'client space at 390'); await noDeadEnd(cp, 'client space'); await shot(cp, 'client-2-space-390');
  await cc.close(); await practice.c.close();

  step('a new person connects the ChatGPT/Claude connector');
  const reg = await app.inject({ method: 'POST', url: '/api/v0/oauth/register', headers: { 'content-type': 'application/json', 'x-pulse-client-ip': '198.51.100.140' },
    payload: { client_name: 'Synthetic Assistant', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none' } });
  assert.equal(reg.statusCode, 201, reg.body);
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id: reg.json().client_id, redirect_uri: 'https://assistant.example/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'people.read tasks.read', state: 'synthetic' });
  const mc = await context(390);
  const mp = await open(mc, `/oauth/mcp/authorize?${q}`, 'connector');
  await seen(mp.getByRole('heading', { name: /continue to Synthetic Assistant/ }));
  await shot(mp, 'connector-1-sign-in-390');
  await mp.getByRole('link', { name: 'Create your account' }).click();
  await seen(mp.getByText('New to Pulse · for Synthetic Assistant'));
  const tm = await signup(mp, 'connector', { profiles: ['Freelancer'], space: 'Just me', name: 'Synthetic Kabir Mifos', width: 390 });
  await seen(mp.getByRole('heading', { name: /Synthetic Assistant wants to use Pulse as you/ }), 240000);
  report.firstUseful['connector@390'] = Math.round(performance.now() - tm.t1);
  await fits(mp, 'connector consent at 390'); await shot(mp, 'connector-2-consent-390');
  // Allow: back to the app with a code (the app's address is answered here; nothing leaves the machine).
  await mp.route('https://assistant.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Back in Synthetic Assistant</h1>' }));
  await mp.getByRole('button', { name: 'Allow' }).click();
  await mp.waitForURL(/^https:\/\/assistant\.example\/callback\?/, { timeout: 120000 }); checks++;
  const back = new URL(mp.url()); assert.ok(back.searchParams.get('code')?.startsWith('poc_')); assert.equal(back.searchParams.get('state'), 'synthetic');
  await mc.close();

  assert.deepEqual(errors, [], errors.join('\n'));
  report.checks = checks; report.consoleErrors = consoleErrors;
  writeFileSync(E.TEST_REPORT, JSON.stringify(report));
  console.log(`self-serve-browser-runner: ${checks} checks; first useful screen (ms): ${JSON.stringify(report.firstUseful)}; whole journey (ms): ${JSON.stringify(report.journey)}`);
} catch (e) {
  if (last && shots) await last.screenshot({ path: `${shots}/failed-${current.replace(/[^a-z0-9]+/gi, '-')}.png`, fullPage: true }).catch(() => {});
  console.error(`failed at step ${current}: ${e.stack ?? e}\n${serverTail}`);
  process.exitCode = 1;
} finally { await browser?.close().catch(() => {}); stopServer(); await app.close(); await pool.end(); }
