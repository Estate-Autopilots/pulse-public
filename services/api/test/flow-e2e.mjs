// FLOW-D end to end in the browser (owner, 21 Oct 2026: "nothing is tested end to end: I need it tested perfectly"):
// the real API (in this process) and the web app on a disposable synthetic agency (tests/core/test_flow.py::
// test_flow_end_to_end). Three processes, each made, made live, run and finished by the people of each role signing in:
//   (a) built from scratch with primitives through the builder (list, "+", side sheet), run: a form with a photo and
//       GPS, a meeting transcript, a document, a review sent back and approved, a Decide, a Message, the End;
//   (b) the EA client project template, run on the Starter package;
//   (c) the Solar install template: a new lead starts it by itself, the site visit's photos with GPS, Billing's quote
//       and invoice, the approval.
// Each asserts that the next steps open by data, that notifications land, that an alert fires on a late step (the
// clock moved by the minute tick), that the run ends and the scorecard counts.
// FLOW-E adds three: (d) solar-company: the operator sets up a new company from scratch with the Solar pack; its
//       admin names who holds each role; a new lead starts a job whose steps land on the role holders by themselves;
//       the sales call is picked from Sales X-Ray (a test double here, reached through the real Connect and read as the
//       person), the site visit's photo carries GPS, the quote, the install by the same person in his second role,
//       the invoice; the job is done. (e) consulting-pack: the Consulting pack chosen in Settings, its engagement made
//       live and run to the end by its role holders. (f) two-hats: someone in HR who also holds a work role sees that
//       role's step on their home and My steps, beside the HR desk. `next start` on NEXT_DIST_DIR (CI:
// after `next build`), or FLOW_NEXT_DEV=1 for a private `next dev` (NEXT_DIST_DIR=.next-e2e). Every scenario is
// reported by name; PULSE_FLOW_SHOTS=<dir> keeps screenshots (and PULSE_FLOW_VIDEO=1 videos) of each person's screens.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN; const org = process.env.PULSE_ORG_ID;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
const worker = new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const shots = process.env.PULSE_FLOW_SHOTS; if (shots) await mkdir(shots, { recursive: true });
const only = (process.env.FLOW_ONLY ?? '').split(',').filter(Boolean);
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`; const dev = process.env.FLOW_NEXT_DEV === '1';
// The web server's own output goes to a log beside the screenshots (or nowhere), so a server that never answers says why.
const { openSync } = await import('node:fs'); const out = shots ? openSync(`${shots}/next.log`, 'a') : 'ignore';
// FLOW-E: the new company's own address (Chromium resolves *.localhost) may load the dev server's scripts.
process.env.PULSE_DEV_ORIGIN ??= 'suryodaya-e2e.localhost';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: dev ? 'development' : 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? (dev ? '.next-e2e' : '.next') }, stdio: ['ignore', out, out] });
let exited = null; server.on('exit', (code) => { exited = code; });
process.on('exit', () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} });
const T = dev ? 180000 : 45000;
let browser; const results = []; let checks = 0; const errors = [];
const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };

// ------------------------------------------------------------------------------------------------ the API and the DB
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const r = await app.inject({ url, method, headers: { 'cf-access-authenticated-user-email': `${who}@${domain}`, 'x-pulse-client-ip': crypto.randomUUID() }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const must = async (who, url, payload) => { const r = await call(who, url, payload); assert.equal(r.status, 200, `${who} ${url}: ${JSON.stringify(r.data).slice(0, 500)}`); checks++; return r.data; };
const sql = async (q, params = [], p = pool, viewer = P.kedab) => { const c = await p.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [org, viewer ?? '']); const r = await c.query(q, params); await c.query('commit'); return r.rows; } finally { c.release(); } };
const run = (rid) => must('kedab', `/v1/flow/runs/${rid}`);
const st = (d, keyOrTitle) => d.steps.find((s) => s.key === keyOrTitle || s.title === keyOrTitle);
/** A person's notifications (each person reads only their own). */
const notes = async (person, type) => (await sql(`select title,event_type from pulse.notification where person_id=$1 and ($2::text is null or event_type=$2) order by created_at`, [person, type ?? null], pool, person));
/** The minute tick, as if `days` had passed (the worker's tick, run here for this company only). */
const tickLater = (days) => sql(`select pulse.flow_tick(now()+make_interval(days=>$1)) r`, [days], worker, null);

// ------------------------------------------------------------------------------------------------ the browser
const pages = [];
async function as(who, width = 1440, theme = 'light') {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1,
    geolocation: { latitude: 18.5204, longitude: 73.8567, accuracy: 12 }, permissions: ['geolocation'], extraHTTPHeaders: { 'cf-access-authenticated-user-email': `${who}@${domain}` },
    ...(shots && process.env.PULSE_FLOW_VIDEO === '1' ? { recordVideo: { dir: `${shots}/video`, size: { width: 1280, height: 800 } } } : {}) });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.flow.listHint', 'seen'); } catch {} }, theme);
  const page = await ctx.newPage(); pages.push(page); page.setDefaultTimeout(T);
  page.on('pageerror', (e) => errors.push(`${who} ${e.message.slice(0, 200)}`));
  return page;
}
// A page is ready when its heading is there and nothing is loading. On a busy machine a page's data can take longer
// than the page waits for it: it says "This didn't load" with Try again, and the runner presses it, as a person would.
const ready = async (page) => {
  for (let i = 0; ; i++) {
    await page.waitForFunction(() => (document.querySelector('main h1,main h2') || /This didn.t load/.test(document.body.innerText)) && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: T });
    const again = page.getByRole('button', { name: 'Try again' });
    if (i >= 3 || !(await page.getByText(/This didn.t load/).count()) || !(await again.count())) break;
    await again.first().click(); await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(400);
};
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: T }); await ready(page); };
// A POST the page makes (awaited after the click; a click that fails first must not leave it rejecting unhandled).
const posted = (page, path) => { const w = page.waitForResponse((r) => r.url().includes(path) && r.request().method() === 'POST' && r.status() < 400, { timeout: T }); w.catch(() => null); return w; };
let n = 0; async function shot(page, name) { if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png` }); } }
async function scenario(name, body) {
  if (only.length && !only.includes(name)) return;
  const started = Date.now();
  const log = (line) => (shots ? writeFile(`${shots}/results.txt`, `${new Date().toISOString()} ${line}\n`, { flag: 'a' }) : null);
  try { await body(); results.push({ name, ok: true, ms: Date.now() - started, checks }); console.log(`PASS ${name}`); await log(`PASS ${name} (${Math.round((Date.now() - started) / 1000)} s, ${checks} checks)`); }
  catch (e) {
    const error = String(e?.message ?? e).split('\n').slice(0, 8).join(' | ').slice(0, 1200);
    results.push({ name, ok: false, error }); console.log(`FAIL ${name}: ${error}`); await log(`FAIL ${name}: ${error}`);
    if (shots) for (const [i, p] of pages.entries()) if (!p.isClosed()) await p.screenshot({ path: `${shots}/fail-${name}-${i}.png` }).catch(() => null);
  }
  for (const p of pages.splice(0)) await p.context().close().catch(() => null);
}
/** A step's own screen (FLOW-C's work screens), as that step's person. */
async function openStep(who, rid, key) {
  const d = await run(rid); const s = st(d, key); assert.ok(s, `no step ${key}`);
  const page = await as(who); await go(page, `/steps/${s.id}`);
  if (!(await page.getByRole('heading', { name: s.title }).count())) await go(page, `/steps/${s.id}`);   // a slow first load, once more
  await expect(page.getByRole('heading', { name: s.title }).first()).toBeVisible({ timeout: T });
  return { page, step: s };
}
async function photo(page) { return page.screenshot({ clip: { x: 0, y: 0, width: 96, height: 96 } }); }
/** Fill a field form on a Collect step: text answers, a photo from the camera (with the place), then send it. */
async function fillForm(page, answers, photoLabels = []) {
  for (const [label, value] of Object.entries(answers)) await page.getByLabel(label, { exact: true }).fill(value);
  for (const label of photoLabels) { await page.getByLabel(`${label}: camera`).setInputFiles({ name: 'site.png', mimeType: 'image/png', buffer: await photo(page) }); await expect(page.getByRole('img', { name: `${label} 1` })).toBeVisible(); }
  const sent = posted(page, '/api/v0/forms/submit');
  await page.getByRole('button', { name: /^Send/ }).last().click(); return sent;
}

// ------------------------------------------------------------------------------------------------ the builder's moves
/** Press a "+" and pick a primitive (or a company block) in the menu; the new step's sheet opens. */
async function add(page, plus, what) {
  await plus.click();
  const menu = page.getByRole('dialog', { name: /Add a step/ }); await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: new RegExp(`^${what}`) }).first().click();
  await expect(page.getByRole('complementary', { name: /^Step: / })).toBeVisible();
  return page.getByRole('complementary', { name: /^Step: / });
}
async function kind(sheet, label) { await sheet.getByRole('radio', { name: new RegExp(`^${label}`) }).click(); }
async function who(sheet, role, isNew) {
  const pick = sheet.getByLabel('Who does it');
  if (isNew) { await pick.selectOption('new'); await sheet.getByLabel('The new role').fill(role); await sheet.getByRole('button', { name: 'Add', exact: true }).click(); }
  else await pick.selectOption({ label: role });
}
async function title(sheet, text) { await sheet.locator('label', { hasText: 'What happens here?' }).locator('input').fill(text); }

process.on('unhandledRejection', (e) => { if (shots) void writeFile(`${shots}/results.txt`, `${new Date().toISOString()} UNHANDLED ${String(e?.stack ?? e).slice(0, 800)}\n`, { flag: 'a' }); });
try {
  for (let i = 0; i < 2400; i++) { if (exited !== null) throw new Error(`next stopped (${exited}): see next.log`); try { if ((await fetch(base + '/login')).status < 500) break; } catch {} await delay(250); if (i === 2399) throw new Error('next did not answer in 10 minutes'); }
  browser = await chromium.launch();
  // A live field form with a camera photo (place stamped), and the Billing quote and invoice the Solar job picks.
  const form = (await must('kedab', '/api/v0/forms', { name: 'Site details (E2E)', fields: [{ key: 'notes', label: 'What did you see', type: 'text', required: true },
    { key: 'roof', label: 'Roof photo', type: 'photo', required: true, max: 2 }] })).id;
  await must('kedab', `/api/v0/forms/${form}/status`, { status: 'live' });

  // ============================================================================ (a) a process built from scratch
  await scenario('built-from-scratch', async () => {
    const page = await as('kedab'); await go(page, '/processes/new');
    await page.getByLabel('What is it called?').fill('Client onboarding (E2E)');
    await page.getByRole('radio', { name: /^Blank/ }).click(); await shot(page, 'a-new-blank');
    await page.getByRole('button', { name: 'Open it' }).click(); await page.waitForURL(/\/processes\/[0-9a-f-]{36}$/); await ready(page);
    const pid = page.url().split('/').pop();
    await expect(page.getByRole('heading', { name: 'Three steps to a process' })).toBeVisible(); await shot(page, 'a-empty-guide');
    await page.getByRole('button', { name: 'Add how it starts' }).click();
    let sheet = page.getByRole('complementary', { name: /^Step: / }); await expect(sheet.getByRole('radio', { name: /^By hand/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    // Collect: the form with a photo, from the Project coordinator (a role named here).
    sheet = await add(page, page.getByRole('button', { name: 'Add a step', exact: true }), 'Collect');
    await kind(sheet, 'Answers to questions'); await sheet.locator('label', { hasText: 'Which form?' }).locator('select').selectOption(form);
    await title(sheet, 'Site details'); await who(sheet, 'Project coordinator', true); await shot(page, 'a-sheet-collect');
    // Meet, Write, Review, Decide.
    const after = () => page.getByRole('button', { name: 'Add a step here' }).last();
    const atEnd = () => page.getByRole('button', { name: 'Add a step', exact: true });
    sheet = await add(page, atEnd(), 'Meet'); await title(sheet, 'Kick-off call'); await who(sheet, 'Creative strategist', true);
    sheet = await add(page, atEnd(), 'Write'); await kind(sheet, 'A document'); await title(sheet, 'Project brief');
    await sheet.locator('label', { hasText: 'Its sections' }).locator('textarea').fill('Goals\nPlan'); await who(sheet, 'Creative strategist', false);
    sheet = await add(page, atEnd(), 'Review'); await kind(sheet, 'Someone approves'); await title(sheet, 'Approve the brief'); await who(sheet, 'PGS', true);
    await sheet.locator('label', { hasText: 'Answer within' }).locator('input').fill('2');
    sheet = await add(page, atEnd(), 'Decide'); await title(sheet, 'Go ahead?'); await sheet.locator('label', { hasText: 'One way is' }).locator('input').fill('Go');
    await sheet.locator('label', { hasText: 'The other way' }).locator('input').fill('Stop'); await who(sheet, 'PGS', false); await shot(page, 'a-sheet-decide');
    // Each way: a Message to whoever started it, or a Task; then the End after both.
    sheet = await add(page, page.getByRole('button', { name: 'If Go' }), 'Message'); await kind(sheet, 'Tell people in Pulse');
    await sheet.getByRole('group', { name: 'Who should know?' }).getByRole('button', { name: 'Whoever started it' }).click();
    await sheet.locator('label', { hasText: 'What do they read?' }).locator('textarea').fill('{client} is a go');
    sheet = await add(page, page.getByRole('button', { name: 'If Stop' }), 'Task'); await title(sheet, 'Close the file');
    sheet = await add(page, atEnd(), 'End'); await page.keyboard.press('Escape');
    await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible({ timeout: T });
    await shot(page, 'a-list-built');
    let p = await must('kedab', `/v1/flow/processes/${pid}`);
    eq(p.definition.steps.map((s) => s.block), ['start', 'collect', 'meet', 'write', 'review', 'decide', 'message', 'task', 'end'], 'the steps are the primitives chosen, in order');
    ok(p.definition.rules.some((r) => r.when === 'in-state-longer' && r.waitDays === 2), 'the review\'s time limit is an alert rule');
    // Map, then live.
    await page.getByRole('button', { name: 'Map', exact: true }).click(); await page.waitForTimeout(1200); await shot(page, 'a-map');
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await page.getByRole('button', { name: 'Go live' }).click(); await expect(page.getByText('Live: new runs follow this version').first()).toBeVisible({ timeout: T });
    // Start a run, naming the people.
    await go(page, `/processes/${pid}?tab=runs`); await page.getByRole('button', { name: 'Start a run' }).click();
    await page.getByLabel('Which client or project').fill('Acme Homes');
    const crew = page.getByRole('group', { name: /Who is on it/ });
    await crew.locator('label', { hasText: 'Project coordinator' }).locator('select').selectOption(P.neha);
    await crew.locator('label', { hasText: 'Creative strategist' }).locator('select').selectOption(P.meera);
    await crew.locator('label', { hasText: 'PGS' }).locator('select').selectOption(P.asha);
    await page.getByRole('button', { name: 'Start', exact: true }).click(); await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/); await ready(page);
    const rid = page.url().split('/').pop(); await shot(page, 'a-run-started');
    let d = await run(rid); eq([st(d, 'Site details').state, st(d, 'Kick-off call').state], ['open', 'waiting']);
    ok((await notes(P.neha, 'task.assigned')).length >= 1, 'the coordinator was told (a Work task)');
    // Neha: My steps → the form, a photo with the place, sent.
    let me = await as('neha'); await go(me, '/me/steps'); await expect(me.getByText('Site details').first()).toBeVisible(); await shot(me, 'a-neha-my-steps');
    ({ page: me } = await openStep('neha', rid, 'Site details'));
    await fillForm(me, { 'What did you see': 'Flat roof, meter on the left' }, ['Roof photo']); await shot(me, 'a-neha-form-sent');
    d = await run(rid); eq([st(d, 'Site details').state, st(d, 'Kick-off call').state], ['done', 'open'], 'the form finished the step; the meeting opened');
    const got = d.values.find((x) => x.step === st(d, 'Site details').key && x.side === 'makes');
    ok(got?.value?.answers?.notes === 'Flat roof, meter on the left' && got.value.location?.lat && got.value.photos === 1, `answers, place and photo: ${JSON.stringify(got?.value)}`);
    ok((await notes(P.meera, 'task.assigned')).length >= 1, 'the strategist was told');
    // Meera: the meeting (transcript, Pip's summary), then the document.
    ({ page: me } = await openStep('meera', rid, 'Kick-off call'));
    await me.getByLabel('Transcript', { exact: true }).fill('Client: We want to launch in June. Budget ₹ 40 lakh.\nFOLLOW-UP: send the price sheet.');
    let wait = posted(me, '/actions/transcript'); await me.getByRole('button', { name: 'Save the transcript' }).click(); await wait;
    wait = posted(me, '/actions/summarise'); await me.getByRole('button', { name: 'Summarise with Pip' }).click(); await wait; await shot(me, 'a-meera-meeting');
    wait = posted(me, '/finish'); await me.getByRole('button', { name: 'Done', exact: true }).click(); await wait;
    d = await run(rid); eq(st(d, 'Project brief').state, 'open', 'the document opened');
    ({ page: me } = await openStep('meera', rid, 'Project brief'));
    for (const section of ['Goals', 'Plan']) {
      await me.getByRole('tab', { name: new RegExp(`${section}$`) }).click();
      const write = me.getByRole('button', { name: 'Write', exact: true }); if (await write.getAttribute('aria-pressed') !== 'true') await write.click();
      const box = me.getByRole('textbox', { name: `Section ${section}` }); await box.fill(`${section}: launch in June, three creatives.`);
      wait = posted(me, '/actions/section'); await box.blur(); await wait;   // a section saves when you leave it
    }
    wait = posted(me, '/finish'); await me.getByRole('button', { name: 'Done', exact: true }).click(); await wait; await shot(me, 'a-meera-doc-done');
    d = await run(rid); eq(st(d, 'Approve the brief').state, 'open', 'the review opened');
    // Asha: sends it back with changes (a round), then the clock moves: the review is late, the alert fires.
    ({ page: me } = await openStep('asha', rid, 'Approve the brief'));
    await me.getByLabel(/^Note/).fill('Add the budget split'); wait = posted(me, '/verdict'); await me.getByRole('button', { name: 'Send back with changes' }).click(); await wait;
    d = await run(rid); eq([st(d, 'Approve the brief').state, st(d, 'Approve the brief').rounds >= 0], ['in_progress', true], 'sent back: in progress again');
    await sql(`update pulse.flow_run_step set state='open',opened_at=now() where run_id=$1 and title='Approve the brief'`, [rid]);   // waiting for the approver again
    const t = await tickLater(4); ok(t[0].r.active >= 1, JSON.stringify(t));
    d = await run(rid); ok(d.alerts.some((a) => /waiting/.test(a.name)), `the late review alerted: ${JSON.stringify(d.alerts)}`);
    ok((await notes(P.asha, 'flow.alert')).length + (await notes(P.kedab, 'flow.alert')).length >= 1, 'the alert reached the doer or whoever started it');
    await go(me, `/steps/${st(d, 'Approve the brief').id}`); wait = posted(me, '/verdict'); await me.getByRole('button', { name: 'Approve' }).click(); await wait; await shot(me, 'a-asha-approved');
    // The Decide: Go. The Message tells whoever started it, with the run's name; the other way is skipped; the run ends.
    ({ page: me } = await openStep('asha', rid, 'Go ahead?')); wait = posted(me, '/verdict'); await me.getByRole('button', { name: 'Go', exact: true }).click(); await wait;
    d = await run(rid);
    eq([st(d, 'Close the file').state, d.status], ['skipped', 'done'], 'the way not chosen is skipped; the run is done');
    ok((await notes(P.kedab, 'flow.wire')).some((x) => x.title.startsWith('Acme Homes is a go')), 'the message reached whoever started it, its values filled in');
    ok((await notes(P.kedab, 'flow.done')).length >= 1, 'whoever started it heard it is done');
    const card = await must('kedab', `/v1/flow/scorecard?processId=${pid}`);
    ok(card.processes[0]?.metrics.some((m) => m.total.n >= 1), `the scorecard counts: ${JSON.stringify(card).slice(0, 300)}`);
    me = await as('kedab'); await go(me, `/runs/${rid}`); await shot(me, 'a-run-done');
  });

  // ============================================================================ (b) the EA client project template
  await scenario('ea-client-project', async () => {
    const page = await as('kedab'); await go(page, '/processes/new');
    await page.getByLabel('What is it called?').fill('EA client project (E2E)');
    await page.getByRole('radio', { name: /^Start from a template/ }).click(); await page.getByRole('radio', { name: /^Client project \(creative strategy\)/ }).click();
    await page.getByRole('button', { name: 'Open it' }).click(); await page.waitForURL(/\/processes\/[0-9a-f-]{36}$/); await ready(page);
    const pid = page.url().split('/').pop(); await shot(page, 'b-ea-list');
    await page.getByRole('button', { name: 'Go live' }).click(); await expect(page.getByText('Live: new runs follow this version').first()).toBeVisible({ timeout: T });
    const people = { gs_head: P.kedab, gs: P.asha, cs: P.meera, ve: P.ishaan, gd: P.kabir, pc: P.neha, ac: P.neha, vg: P.ahoro, sme: P.sana };
    const p = await must('kedab', `/v1/flow/processes/${pid}`);
    const rid = (await must('kedab', `/v1/flow/processes/${pid}/runs`, { name: 'Skyline (E2E)', fields: { package: 'starter', segment: p.definition.fields.find((f) => f.key === 'segment')?.options?.[0]?.value, research_meet: new Date().toISOString().slice(0, 10), prelaunch: false, project_code: 'SKY' },
      people: Object.fromEntries(Object.entries(people).filter(([k]) => p.definition.roles.some((r) => r.key === k))) })).id;
    let d = await run(rid); ok(d.steps.filter((s) => s.state === 'skipped').length >= 5, 'Sell-Out and Growth-only steps are skipped on Starter');
    // Each step as its person on its own screen; the key ones through the screen, the rest through the step's API.
    const person = (s) => Object.entries(P).find(([, id]) => id === s.who?.id)?.[0] ?? 'kedab';
    const viaUi = new Set(['1.3', '2.1', '3.5']);
    for (let guard = 0; guard < 80; guard++) {
      d = await run(rid); if (d.status === 'done') break;
      const open = d.steps.filter((s) => ['open', 'in_progress', 'in_review', 'confirmed'].includes(s.state));
      if (!open.length) {
        // Only a step waiting for something typed in by hand is left (the optional client review meeting): it is skipped.
        const typed = d.steps.filter((s) => s.state === 'waiting' && s.waitingFor.some((w) => !w.from));
        assert.ok(typed.length, `stuck: nothing open; waiting: ${d.steps.filter((s) => s.state === 'waiting').map((s) => `${s.key} ${s.stateText}`).join('; ')}`);
        for (const s of typed) await must('kedab', `/v1/flow/steps/${s.id}/skip`, { why: 'Not needed for this project' });
        continue;
      }
      for (const s of open) {
        const who = person(s);
        if (viaUi.has(s.key)) {
          const { page: me } = await openStep(who, rid, s.key); await shot(me, `b-${s.key}`);
          if (s.key === '1.3') { await me.getByLabel('Transcript', { exact: true }).fill('Client: 2 towers, 220 flats, from ₹ 1.2 Cr. PENDING: the club house date.'); let w = posted(me, '/actions/transcript');
            await me.getByRole('button', { name: 'Save the transcript' }).click(); await w; w = posted(me, '/finish'); await me.getByRole('button', { name: 'Done', exact: true }).click(); await w; }
          if (s.key === '2.1') { const write = me.getByRole('button', { name: 'Write', exact: true }); if (await write.getAttribute('aria-pressed') !== 'true') await write.click();
            const box = me.getByRole('textbox', { name: /^Section / }).first(); await box.fill('1.1 Overview: 2 towers, 220 flats (Client — Meeting).');
            let w = posted(me, '/actions/section'); await box.blur(); await w;
            w = posted(me, '/actions/section'); await me.getByRole('button', { name: 'Mark section done' }).click(); await w; }
          if (s.key === '3.5') { let w = posted(me, '/actions/run'); await me.getByRole('button', { name: 'Pre-check with Pip' }).click(); await w;
            w = posted(me, '/verdict'); await me.getByRole('button', { name: 'It passes' }).click(); await w; }
          viaUi.delete(s.key); continue;
        }
        await doStep(who, rid, s, d);
      }
    }
    d = await run(rid); eq(d.status, 'done', `the EA project ran to the end: ${d.steps.filter((s) => !['done', 'skipped'].includes(s.state)).map((s) => `${s.key} ${s.state}`).join(', ')}`);
    eq(d.day1 !== null, true, 'Day 1 started when the inputs were in');
    const card = await must('kedab', `/v1/flow/scorecard?processId=${pid}`); ok(card.processes[0]?.metrics.length >= 4, 'the EA scorecard');
    const me = await as('kedab'); await go(me, `/runs/${rid}`); await shot(me, 'b-run-done');
  });

  // ============================================================================ (c) the Solar install template
  await scenario('solar-install', async () => {
    const page = await as('kedab'); await go(page, '/processes/new');
    await page.getByLabel('What is it called?').fill('Solar install (E2E)');
    await page.getByRole('radio', { name: /^Start from a template/ }).click(); await page.getByRole('radio', { name: /^Solar install/ }).click();
    await page.getByRole('button', { name: 'Open it' }).click(); await page.waitForURL(/\/processes\/[0-9a-f-]{36}$/); await ready(page);
    const pid = page.url().split('/').pop();
    // The site visit and the install use the E2E form (camera photo, place stamped).
    await page.getByRole('button', { name: /^Site visit · GPS photos/ }).click();
    let sheet = page.getByRole('complementary', { name: /^Step: / }); await sheet.locator('label', { hasText: 'Which form takes the photos?' }).locator('select').selectOption(form);
    await page.getByRole('button', { name: /^Install: photos and panel/ }).click();
    sheet = page.getByRole('complementary', { name: /^Step: / }); await sheet.locator('label', { hasText: 'Which form?' }).locator('select').selectOption(form);
    await page.keyboard.press('Escape'); await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible({ timeout: T }); await shot(page, 'c-solar-list');
    await page.getByRole('button', { name: 'Go live' }).click(); await expect(page.getByText('Live: new runs follow this version').first()).toBeVisible({ timeout: T });
    // A new lead starts a job by itself.
    const project = { id: process.env.TEST_PROJECT };
    await sql(`insert into pulse.lead(org_id,buyer_id,project_id,created_at,status) values($1,gen_random_uuid(),$2,now(),'new')`, [org, project?.id ?? null], worker, null);
    let list = await must('kedab', `/v1/flow/runs?processId=${pid}`); eq(list.runs.length, 1, 'the lead started a job'); const rid = list.runs[0].id;
    // Name the people on the run (its view), then the sales call (Sales X-Ray is outside: its analysis is picked).
    const me0 = await as('kedab'); await go(me0, `/runs/${rid}`); await shot(me0, 'c-run-from-lead');
    for (const [role, who] of [['sales', P.asha], ['surveyor', P.ravi], ['installer', P.ravi], ['accounts', P.kedab], ['owner', P.kedab]]) await must('kedab', `/v1/flow/runs/${rid}/people`, { role, personId: who });
    let d = await run(rid); eq([st(d, 's2').who?.id, st(d, 's3').who?.id], [P.asha, P.ravi], 'their steps went to them');
    await must('asha', `/v1/flow/steps/${st(d, 's2').id}/actions/pick`, { callId: 'call-1', summary: 'Wants 5 kW; asked about the subsidy', items: ['5 kW panels'], objections: ['Price'], promises: ['Quote by Friday'], score: 7 });
    // The quote is late: the alert reaches the sales person and the owner.
    await tickLater(5); d = await run(rid); ok(d.alerts.some((a) => a.name === 'Site visit late'), `alerts: ${JSON.stringify(d.alerts.map((a) => a.name))}`);
    ok((await notes(P.ravi, 'flow.alert')).length >= 1, 'the surveyor heard the visit is late');
    // Ravi: the site visit, photos with the place, on the phone-sized screen.
    let { page: me } = await openStep('ravi', rid, 's3');
    await fillForm(me, { 'What did you see': 'RCC roof, no shade after 10' }, ['Roof photo']); await shot(me, 'c-ravi-visit');
    d = await run(rid); eq(st(d, 's4').state, 'open', 'the quotation opened with the photos in');
    ok(d.values.some((x) => x.step === 's4' && x.port === 'survey'), 'the photos reached the quotation by themselves');
    // Asha: the quotation from Billing, then the follow-up and the approval.
    const [q] = await sql(`select id from pulse.erp_document where number='Q-E2E-1'`);   // made by the test's setup (Billing's own rows)
    ({ page: me } = await openStep('asha', rid, 's4')); let wait = posted(me, '/actions/pick');
    await me.getByRole('listitem').filter({ hasText: 'Q-E2E-1' }).getByRole('button', { name: 'Use this' }).click(); await wait; await shot(me, 'c-asha-quote');
    d = await run(rid); ok(d.values.some((x) => x.step === 's4' && x.value?.erpId === q.id), 'the quotation is on the job');
    await must('asha', `/v1/flow/steps/${st(d, 's5').id}/verdict`, { answer: 'yes' });
    ({ page: me } = await openStep('asha', rid, 's6')); wait = posted(me, '/verdict'); await me.getByRole('button', { name: 'Approve' }).click(); await wait;
    d = await run(rid); eq([st(d, 's7').state, st(d, 's8').state], ['open', 'skipped'], 'the install opened; the subsidy papers are not for this job');
    // Ravi: the install record; accounts: the invoice; the job is done.
    ({ page: me } = await openStep('ravi', rid, 's7')); await fillForm(me, { 'What did you see': 'Panels SN-1 to SN-10, inverter INV-7' }, ['Roof photo']);
    d = await run(rid); ({ page: me } = await openStep('kedab', rid, 's9')); wait = posted(me, '/actions/pick');
    await me.getByRole('listitem').filter({ hasText: 'INV-E2E-1' }).getByRole('button', { name: 'Use this' }).click(); await wait;
    d = await run(rid); eq(d.status, 'done', `the job is done: ${d.steps.filter((s) => !['done', 'skipped'].includes(s.state)).map((s) => `${s.key} ${s.state}`).join(', ')}`);
    const card = await must('kedab', `/v1/flow/scorecard?processId=${pid}`); ok(card.processes[0]?.metrics.some((m) => m.key === 'quote_on_time' && m.total.n === 1), 'quotes on time counted');
    me = await as('kedab'); await go(me, `/runs/${rid}`); await shot(me, 'c-job-done');
  });

  // ============================================================================ FLOW-E: any industry, any role, any app
  // Sales X-Ray, here: a test double that speaks its Connect (OAuth with PKCE) and call API, so Pulse reaches it as it
  // reaches the real one (the person's own connection, the call read as them). Tokens are sealed with a throwaway ring.
  const { createServer } = await import('node:http'); const { randomBytes } = await import('node:crypto');
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  if (!process.env.PULSE_DOCUMENT_KEY_FILE) { const dir = mkdtempSync(join(tmpdir(), 'flowe-ring-')); writeFileSync(join(dir, 'ring'), `k1 ${randomBytes(32).toString('base64')}\n`); chmodSync(join(dir, 'ring'), 0o600); process.env.PULSE_DOCUMENT_KEY_FILE = join(dir, 'ring'); }
  const CALL = '0e2e0000-0000-4000-8000-00000000ca11';
  const sx = createServer((req, res) => { const u = new URL(req.url, 'http://x'); req.resume(); req.on('end', () => {
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/v1/oauth/register') return json(201, { client_id: `sxc_E2E${'x'.repeat(21)}`, client_secret: `secret-${'s'.repeat(40)}` });
    if (u.pathname === '/connect') { const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', `sxo_${'c'.repeat(40)}`); back.searchParams.set('state', u.searchParams.get('state') ?? ''); res.writeHead(302, { location: back.href }); return res.end(); }
    if (u.pathname === '/v1/oauth/token') return json(200, { access_token: 'sxa_e2e', refresh_token: 'sxr_e2e', expires_in: 3600, scope: 'calls:read reports:read leads:read leads:write' });
    if (u.pathname === '/v1/api/me') return json(200, { person: { name: 'Priya Suryodaya' }, workspace: { name: 'Suryodaya Solar', kind: 'organisation', role: 'member' } });
    if (u.pathname === '/v1/api/calls') return json(200, { calls: [{ id: CALL, title: 'Call with Mr Kireteso (rooftop)', created_at: new Date().toISOString(), duration_seconds: 540, has_report: true, open_url: 'https://salesxray.example.test/calls/kireteso' }] });
    if (u.pathname === `/v1/api/calls/${CALL}`) return json(200, { id: CALL, title: 'Call with Mr Kireteso (rooftop)', open_url: 'https://salesxray.example.test/calls/kireteso', facts: [
      { label: 'Asked for', category: 'item', display: '5 kW rooftop system' }, { label: 'Asked for', category: 'item', display: 'Net metering help' },
      { label: 'Objection', category: 'objection', display: 'Price is above the neighbour\'s quote' }, { label: 'Promise', category: 'promise', display: 'Quotation by Friday' },
      { label: 'Lead score', category: 'score', value: 8 }] });
    return json(404, { error: { message: 'Not found' } });
  }); });
  await new Promise((done) => sx.listen(0, '127.0.0.1', done)); process.env.PULSE_SALES_XRAY = '1'; process.env.PULSE_SALES_XRAY_URL = `http://127.0.0.1:${sx.address().port}`;
  const owner = process.env.TEST_OWNER_CONFIG ? new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)) : null;
  const inOrg = async (o, q, params = [], p = pool, viewer = '') => { const c = await p.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [o, viewer]); const r = await c.query(q, params); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } };

  // ---------------------------------------------------------------------------- (d) a new solar company, from scratch
  const host = 'suryodaya-e2e.localhost', hostBase = `http://${host}:${port}`;
  const at = async (token, url, payload, method = payload ? 'POST' : 'GET') => { const r = await app.inject({ url, method, headers: { 'x-pulse-host': host, ...(token ? { 'x-pulse-session': token } : {}), 'x-pulse-client-ip': crypto.randomUUID() }, ...(payload ? { payload } : {}) });
    return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body }; };
  const mustAt = async (token, url, payload) => { const r = await at(token, url, payload); assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.data).slice(0, 500)}`); checks++; return r.data; };
  async function asAt(token, width = 1440) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: 1, geolocation: { latitude: 18.5074, longitude: 73.8077, accuracy: 9 }, permissions: ['geolocation'],
      ...(shots && process.env.PULSE_FLOW_VIDEO === '1' ? { recordVideo: { dir: `${shots}/video`, size: { width: 1280, height: 800 } } } : {}) });
    await ctx.addCookies([{ name: 'pulse_session', value: token, domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
    await ctx.addInitScript(() => { try { localStorage.setItem('pulse.flow.listHint', 'seen'); } catch {} });
    const page = await ctx.newPage(); pages.push(page); page.setDefaultTimeout(T); page.on('pageerror', (e) => errors.push(`${host} ${e.message.slice(0, 200)}`)); return page;
  }
  const goAt = async (page, path) => { await page.goto(hostBase + path, { waitUntil: 'load', timeout: T }); await ready(page); };
  const sun = { tokens: {}, ids: {}, rid: null };
  await scenario('solar-company', async () => {
    assert.ok(owner, 'the test passes the owner login (TEST_OWNER_CONFIG) to activate the company as the operator would');
    // The operator (an admin of this install's own company) sets the company up, the Solar pack chosen in the wizard.
    const setupId = (await must('admin', '/api/v0/tenants', { name: 'Suryodaya Solar (E2E)' })).id;
    let setup = (await must('admin', `/api/v0/tenants/${setupId}/company`, { name: 'Suryodaya Solar (E2E)', slug: 'suryodaya-e2e', code: 'SURY', timeZone: 'Asia/Kolkata', dataRegion: 'in', host, rehearsal: true })).setup;
    const sorg = setup.org.id;
    setup = await must('admin', `/api/v0/tenants/${setupId}/pack`, { pack: 'solar' }); eq(setup.steps.pack.pack, 'solar', 'the wizard wrote the Solar pack into the company');
    const op = await as('admin'); await go(op, `/companies/${setupId}?step=settings`); await expect(op.getByText('Solar installer').first()).toBeVisible(); await shot(op, 'd-wizard-industry');
    await must('admin', `/api/v0/tenants/${setupId}/admin`, { name: 'Meher Suryodaya', email: 'meher@suryodaya.example.test', title: 'Owner' });
    const csv = 'Name,Email,Title,Pod,Team,Manager,Access\nPriya Suryodaya,priya@suryodaya.example.test,Sales,Sales,Sales,,\nRavi Suryodaya,ravi@suryodaya.example.test,Field engineer,Field,Field,,\n'
      + 'Anil Suryodaya,anil@suryodaya.example.test,Accountant,Office,Office,,\n';
    const people = await must('admin', `/api/v0/tenants/${setupId}/people`, { source: 'csv', csv, apply: true });
    for (const x of people.setup.people) sun.ids[x.name.split(' ')[0].toLowerCase()] = x.id;
    await must('admin', `/api/v0/tenants/${setupId}/structure`, { ops: [{ op: 'pod', name: 'Leadership' }, { op: 'place', personId: sun.ids.meher, pod: 'Leadership', team: 'Leadership' }, { op: 'role', personId: sun.ids.meher, role: 'leadership', grant: true }] });
    await must('admin', `/api/v0/tenants/${setupId}/settings`, { modules: { finance: true, chats: true, tasks: true, attendance: false }, rules: [] });
    await must('admin', `/api/v0/tenants/${setupId}/check`, {}); await must('admin', `/api/v0/tenants/${setupId}/open`, {});
    // Activation (the operator's handover gates are R53/R54's, tested there) and everyone's first password.
    await inOrg(sorg, "update pulse.org set activation='live' where id=$1", [sorg], owner);
    await inOrg(sorg, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values($1,$2,'finance','2020-01-01'),($1,$3,'finance','2020-01-01')", [sorg, sun.ids.priya, sun.ids.anil], owner);
    for (const [k, id] of Object.entries(sun.ids)) {
      const username = (await inOrg(sorg, "select pulse.login_issue($1,'Suryodaya-E2E-issued-2026!'),(select username from pulse.people_profile where person_id=$1) u", [id], pool, sun.ids.meher))[0].u;
      let r = await at(null, '/api/v0/auth/sign-in', { username, password: 'Suryodaya-E2E-issued-2026!' }); assert.equal(r.status, 200, `${k} signs in: ${JSON.stringify(r.data)}`);
      const token = r.data.token; r = await at(token, '/api/v0/auth/change-password', { current: 'Suryodaya-E2E-issued-2026!', next: `Suryodaya-${k}-E2E-2026!` });
      sun.tokens[k] = r.data?.token ?? token;
    }
    const meMeher = await mustAt(sun.tokens.meher, '/api/v0/me'); eq([meMeher.org, meMeher.words.client, meMeher.words.runs], [sorg, 'Customer', 'Jobs'], 'the company speaks solar');
    // Meher names who holds each role in Settings → Industry & roles (Ravi holds two: the survey and the install).
    let page = await asAt(sun.tokens.meher); await goAt(page, '/settings?tab=industry');
    await expect(page.getByRole('listitem', { name: 'Solar installer' })).toContainText('In use');
    const holder = async (roleName, who) => { const row = page.getByRole('listitem', { name: roleName, exact: true }); const w = posted(page, '/holders');
      await row.getByLabel(`Add someone to ${roleName}`).selectOption(sun.ids[who.split(' ')[0].toLowerCase()]); await w; await expect(row).toContainText(who); };
    for (const [r, who] of [['Sales executive', 'Priya Suryodaya'], ['Site surveyor', 'Ravi Suryodaya'], ['Install team lead', 'Ravi Suryodaya'], ['Accounts', 'Anil Suryodaya'], ['Owner', 'Meher Suryodaya']]) await holder(r, who);
    await page.getByRole('listitem', { name: 'Site surveyor' }).scrollIntoViewIfNeeded(); await shot(page, 'd-roles-named');
    // The camera form for the visit and the install, and the job's process made live from its draft.
    const form = (await mustAt(sun.tokens.meher, '/api/v0/forms', { name: 'Roof survey (E2E)', fields: [{ key: 'notes', label: 'What did you see', type: 'text', required: true }, { key: 'roof', label: 'Roof photo', type: 'photo', required: true, max: 2 }] })).id;
    await mustAt(sun.tokens.meher, `/api/v0/forms/${form}/status`, { status: 'live' });
    const pid = (await mustAt(sun.tokens.meher, '/v1/flow/processes')).processes.find((x) => x.name === 'Solar install').id;
    await goAt(page, `/processes/${pid}`);
    await page.getByRole('button', { name: /^Site visit · GPS photos/ }).click();
    let sheet = page.getByRole('complementary', { name: /^Step: / }); await sheet.locator('label', { hasText: 'Which form takes the photos?' }).locator('select').selectOption(form);
    await page.getByRole('button', { name: /^Install: photos and panel/ }).click();
    sheet = page.getByRole('complementary', { name: /^Step: / }); await sheet.locator('label', { hasText: 'Which form?' }).locator('select').selectOption(form);
    await page.getByRole('button', { name: /^Sales X-Ray call/ }).click(); sheet = page.getByRole('complementary', { name: /^Step: / });
    await expect(sheet.getByLabel('App: Sales X-Ray')).toBeVisible(); await shot(page, 'd-sheet-app-xray');
    await page.keyboard.press('Escape'); await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible({ timeout: T });
    await page.getByRole('button', { name: 'Go live' }).click(); await expect(page.getByText('Live: new runs follow this version').first()).toBeVisible({ timeout: T });
    // A new lead (the ads sync's insert) starts a job; nobody is named on it: each step finds its role's holder.
    await inOrg(sorg, `insert into pulse.lead(org_id,buyer_id,created_at,status) values($1,gen_random_uuid(),now(),'new')`, [sorg], worker);
    const runs = (await mustAt(sun.tokens.meher, `/v1/flow/runs?processId=${pid}`)).runs; eq(runs.length, 1, 'the lead started a job'); sun.rid = runs[0].id;
    let d = await mustAt(sun.tokens.meher, `/v1/flow/runs/${sun.rid}`);
    eq([d.terms.run, st(d, 's2').who?.id, st(d, 's3').who?.id], ['Job', sun.ids.priya, sun.ids.ravi], 'the call went to the sales executive and the visit to the surveyor, by role');
    // Priya connects her Sales X-Ray (its Connect, as the browser would) and picks the call on the step's own screen.
    const consent = await mustAt(sun.tokens.priya, '/api/v0/sales-xray/connect', {});
    const back = new URL((await fetch(consent.url, { redirect: 'manual' })).headers.get('location'));
    const linked = await mustAt(sun.tokens.priya, '/api/v0/sales-xray/callback', { code: back.searchParams.get('code'), state: back.searchParams.get('state') }); eq(linked.connected, true);
    page = await asAt(sun.tokens.priya); await goAt(page, `/steps/${st(d, 's2').id}`);
    await expect(page.getByText('Call with Mr Kireteso (rooftop)')).toBeVisible(); await shot(page, 'd-priya-xray-calls');
    let w = posted(page, '/actions/pick'); await page.getByRole('button', { name: 'Use this call' }).click(); await w;
    d = await mustAt(sun.tokens.meher, `/v1/flow/runs/${sun.rid}`);
    const items = d.values.find((x) => x.step === 's2' && x.port === 'items' && x.side === 'makes')?.value;
    ok(items?.items?.some((x) => /5 kW rooftop/.test(x)) && d.values.some((x) => x.step === 's2' && x.port === 'objections' && JSON.stringify(x.value).includes('neighbour')), `the call's analysis is the step's output: ${JSON.stringify(items)}`);
    ok(d.values.some((x) => x.step === 's4' && x.port === 'items'), 'the items asked for reached the quotation by themselves');
    await shot(page, 'd-priya-xray-done');
    // Ravi's home: two roles, each with its tiles; the visit with the GPS photo on his phone.
    page = await asAt(sun.tokens.ravi); await goAt(page, '/dashboard');
    const roles = page.getByRole('region', { name: 'Your roles' }); await expect(roles).toContainText('Site surveyor'); await expect(roles).toContainText('Install team lead');
    await expect(roles.getByRole('link', { name: /Site surveyor: Site visits to do, 1/ })).toBeVisible(); await shot(page, 'd-ravi-home-two-roles');
    page = await asAt(sun.tokens.ravi, 390); await goAt(page, `/steps/${st(d, 's3').id}`);
    await fillForm(page, { 'What did you see': 'RCC roof, no shade after 10, meter by the gate' }, ['Roof photo']); await shot(page, 'd-ravi-visit-gps');
    d = await mustAt(sun.tokens.meher, `/v1/flow/runs/${sun.rid}`); const visit = d.values.find((x) => x.step === 's3' && x.side === 'makes')?.value;
    ok(visit?.location && Math.abs(visit.location.lat - 18.5074) < 0.01, `the photos carry the place: ${JSON.stringify(visit?.location)}`); eq(st(d, 's4').state, 'open', 'the quotation opened with the photos in');
    // The quote from Billing, the follow-up, the customer's approval; the install by Ravi (his second role); the invoice.
    for (const [kind, status, number] of [['quotation', 'sent', 'Q-SUR-1'], ['invoice', 'issued', 'INV-SUR-1']])
      await inOrg(sorg, `insert into pulse.erp_document(org_id,doc_type,status,number,buyer,total) values($1,$2,$3,$4,'{"name":"Kireteso"}',310000)`, [sorg, kind, status, number], owner);
    page = await asAt(sun.tokens.priya); await goAt(page, `/steps/${st(d, 's4').id}`);
    w = posted(page, '/actions/pick'); await page.getByRole('listitem').filter({ hasText: 'Q-SUR-1' }).getByRole('button', { name: 'Use this' }).click(); await w;
    d = await mustAt(sun.tokens.meher, `/v1/flow/runs/${sun.rid}`);
    await mustAt(sun.tokens.priya, `/v1/flow/steps/${st(d, 's5').id}/verdict`, { answer: 'yes' }); await mustAt(sun.tokens.priya, `/v1/flow/steps/${st(d, 's6').id}/verdict`, { answer: 'approved' });
    d = await mustAt(sun.tokens.meher, `/v1/flow/runs/${sun.rid}`); eq([st(d, 's7').who?.id, st(d, 's8').state], [sun.ids.ravi, 'skipped'], 'the install is Ravi\'s too (install team lead); no subsidy papers this time');
    page = await asAt(sun.tokens.ravi, 390); await goAt(page, `/steps/${st(d, 's7').id}`); await fillForm(page, { 'What did you see': 'Panels SN-501 to SN-510, inverter INV-77' }, ['Roof photo']);
    d = await mustAt(sun.tokens.meher, `/v1/flow/runs/${sun.rid}`); eq(st(d, 's9').who?.id, sun.ids.anil, 'the invoice is the accountant\'s');
    page = await asAt(sun.tokens.anil); await goAt(page, `/steps/${st(d, 's9').id}`);
    w = posted(page, '/actions/pick'); await page.getByRole('listitem').filter({ hasText: 'INV-SUR-1' }).getByRole('button', { name: 'Use this' }).click(); await w;
    d = await mustAt(sun.tokens.meher, `/v1/flow/runs/${sun.rid}`); eq(d.status, 'done', `the job is done: ${d.steps.filter((x) => !['done', 'skipped'].includes(x.state)).map((x) => `${x.key} ${x.state}`).join(', ')}`);
    page = await asAt(sun.tokens.meher); await goAt(page, `/runs/${sun.rid}`); await shot(page, 'd-job-done');
    // Nothing of it in this install's own company.
    eq((await must('kedab', '/v1/flow/runs')).runs.some((x) => x.id === sun.rid), false, 'the other company sees none of it');
  });

  // ---------------------------------------------------------------------------- (e) a consulting engagement
  const con = { rid: null, pid: null };
  await scenario('consulting-pack', async () => {
    const page = await as('kedab'); await go(page, '/settings?tab=industry');
    const card = page.getByRole('listitem', { name: 'Consulting firm' }); await card.getByRole('button', { name: /^(Use this pack|Switch to this)$/ }).click();
    const w = posted(page, '/setup/pack'); await card.getByRole('button', { name: 'Use Consulting firm' }).click(); await w;
    await expect(card).toContainText('In use'); await shot(page, 'e-consulting-pack');
    const setup = await must('kedab', '/v1/flow/setup'); eq([setup.words.run, setup.words.projects], ['Engagement', 'Engagements'], 'the words are the consulting firm\'s');
    const roleId = (k) => setup.roles.find((r) => r.key === k).id;
    for (const [k, p] of [['partner', P.kedab], ['manager', P.asha], ['consultant', P.meera], ['analyst', P.hr]]) await must(k === 'analyst' ? 'hr' : 'kedab', `/v1/flow/roles/${roleId(k)}/holders`, { personId: p });
    con.pid = (await must('kedab', '/v1/flow/processes')).processes.find((x) => x.name === 'Consulting engagement').id;
    await go(page, `/processes/${con.pid}`); await shot(page, 'e-consulting-list');
    await page.getByRole('button', { name: 'Go live' }).click(); await expect(page.getByText('Live: new runs follow this version').first()).toBeVisible({ timeout: T });
    con.rid = (await must('kedab', `/v1/flow/processes/${con.pid}/runs`, { name: 'Durineho Steel: plant efficiency' })).id;
    let d = await run(con.rid); eq([d.terms.run, st(d, 'c2').who?.id], ['Engagement', P.asha], 'an engagement; the discovery call is the engagement manager\'s');
    const by = { kedab: 'kedab', [P.asha]: 'asha', [P.meera]: 'meera', [P.hr]: 'hr' };
    const step = async (key, fn) => { d = await run(con.rid); const s = st(d, key); assert.ok(['open', 'in_progress', 'in_review'].includes(s.state), `${key} is ${s.state}`); await fn(by[s.who?.id] ?? 'kedab', s); };
    for (const k of ['c2', 'c3', 'c4', 'c5', 'c6']) await step(k, async (who, s) => {
      if (s.module === 'quotation') { const q = (await must(who, `/v1/flow/steps/${s.id}/actions/candidates`, {})).documents.find((x) => x.number === 'Q-E2E-1'); return must(who, `/v1/flow/steps/${s.id}/actions/pick`, { documentId: q.id }); }
      return doStep(who, con.rid, s, d); });
    // The engagement manager decides on the Decide's own screen: they signed.
    d = await run(con.rid); const { page: am } = await openStep('asha', con.rid, 'c7');
    const v = posted(am, '/verdict'); await am.getByRole('button', { name: 'Signed' }).click(); await v; await shot(am, 'e-decide-signed');
    d = await run(con.rid); eq(st(d, 'c15').state, 'skipped', 'the thank-you note is on the way not chosen');
    await step('c8', (who, s) => doStep(who, con.rid, s, d));
    eq(st(await run(con.rid), 'c9').who?.id, P.hr, 'the data step went to the analyst, who is in HR too');
  });

  // ---------------------------------------------------------------------------- (f) a role with two hats
  await scenario('two-hats', async () => {
    assert.ok(con.rid, 'the consulting engagement ran first');
    // Tara is HR (her access) and the engagement's Analyst (a work role): her home shows both.
    const me = await must('hr', '/api/v0/me'); eq([me.role, me.workRoles], ['hr', ['Analyst']]);
    let page = await as('hr'); await go(page, '/dashboard');
    const roles = page.getByRole('region', { name: 'Your roles' }); await expect(roles).toContainText('As Analyst');
    await expect(roles.getByRole('link', { name: /Analyst: Data to gather, 1/ })).toBeVisible(); await shot(page, 'f-hr-home-analyst');
    await go(page, '/me/steps'); await expect(page.getByText(/as Analyst/).first()).toBeVisible(); await shot(page, 'f-hr-my-steps');
    await go(page, '/hr'); await expect(page.locator('main')).not.toContainText('Hidden by your admin');
    // She does the step; the engagement runs to its end by the role holders.
    let d = await run(con.rid); await doStep('hr', con.rid, st(d, 'c9'), d);
    d = await run(con.rid); const c10 = st(d, 'c10'); eq(c10.who?.id, P.meera);
    await must('meera', '/v1/flow/records', { type: 'finding', runId: con.rid, stepKey: 'c10', data: { insight: 'Compressor idles 31% of the shift', evidence: 'Plant logs, week 38', impact: 'High' } });
    await must('meera', `/v1/flow/steps/${c10.id}/finish`, {});
    for (const k of ['c11', 'c12', 'c13', 'c14']) { d = await run(con.rid); const s = st(d, k); const who = { [P.kedab]: 'kedab', [P.asha]: 'asha', [P.meera]: 'meera' }[s.who?.id] ?? 'kedab';
      if (s.module === 'tax_invoice') { const inv = (await must(who, `/v1/flow/steps/${s.id}/actions/candidates`, {})).documents.find((x) => x.number === 'INV-E2E-1'); await must(who, `/v1/flow/steps/${s.id}/actions/pick`, { documentId: inv.id }); }
      else await doStep(who, con.rid, s, d); }
    d = await run(con.rid); eq(d.status, 'done', `the engagement is done: ${d.steps.filter((x) => !['done', 'skipped'].includes(x.state)).map((x) => `${x.key} ${x.state}`).join(', ')}`);
    page = await as('kedab'); await go(page, `/runs/${con.rid}`); await shot(page, 'f-engagement-done');
    const card = await must('kedab', `/v1/flow/scorecard?processId=${con.pid}`); ok(card.processes[0]?.metrics.some((m) => m.key === 'proposal_on_time' && m.total.n === 1), 'proposals on time counted');
  });
  sx.close(); await owner?.end();

  const failed = results.filter((x) => !x.ok);
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, results, failed: failed.map((x) => x.name), pageErrors: errors.slice(0, 20) }));
  console.log(`flow-e2e: ${results.length - failed.length}/${results.length} scenarios, ${checks} checks`);
} catch (e) {
  if (shots) await writeFile(`${shots}/results.txt`, `${new Date().toISOString()} ERROR ${String(e?.stack ?? e).slice(0, 1500)}\n`, { flag: 'a' });
  throw e;
} finally {
  await browser?.close().catch(() => null);
  // The web server and its workers go with it (a dev server left behind keeps its lock).
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  await delay(1500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
  await app.close(); await pool.end(); await worker.end();
}

/** A step done through its API as its person, as its screen would (the screens are opened and checked above). */
async function doStep(who, rid, s, d) {
  const go = (path, body = {}) => must(who, `/v1/flow/steps/${s.id}/${path}`, body);
  switch (s.module) {
    case 'intake': for (const i of d.intake.filter((x) => x.step === s.key && !x.receivedOn)) await go('actions/receive', { item: i.key, on: new Date().toISOString().slice(0, 10) }); return;
    case 'assign': return go('finish');
    case 'schedule': return go('actions/slot', { on: new Date().toISOString().slice(0, 10), time: '11:00', place: 'Google Meet' });
    case 'transcribe': case 'meeting': await go('actions/transcript', { transcript: 'Client: notes from the call.' }); return go('finish');
    case 'doc_section': return go('actions/section', { text: `${s.title}: written in the E2E run.`, final: true });
    case 'doc': await go('actions/section', { section: 'Main', text: 'Written in the E2E run.' }); return go('actions/final');
    case 'share_review': if (s.state !== 'in_review') await go('actions/send', { message: 'Drafts for your review', links: [] }); return (await run(rid)).steps.find((x) => x.id === s.id)?.state === 'done' ? null : go('actions/confirm', {});
    case 'check': await go('actions/run'); return go('verdict', { answer: 'passed' });
    case 'approval': return go('verdict', { answer: 'approved' });
    case 'decision': return go('verdict', { answer: 'yes' });
    case 'pack': await go('actions/ready'); return go('finish');
    case 'media_review': await go('actions/version', { url: 'https://drive.example/cut-v1' }); return go('actions/freeze');
    case 'session': await go('actions/note', { notes: 'Looked at the cut', decisions: ['Shorter hook'], requests: [] }); return go('finish');
    case 'edit': case 'upload': await go('actions/version', { url: 'https://drive.example/file', done: true }); return null;
    default: return go('finish');
  }
}
