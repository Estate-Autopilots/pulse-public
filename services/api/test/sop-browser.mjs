// SOP-WORKFLOW in the browser: the real API (this process) and the web app on a disposable synthetic agency
// (tests/core/test_sop.py::test_sop_in_the_browser). `next start` on NEXT_DIST_DIR (CI: after `next build`), or with
// SOP_NEXT_DEV=1 a private `next dev` (NEXT_DIST_DIR=.next-sop) for previews. Every flow is reported by name;
// PULSE_SOP_SCREENSHOTS=<dir> keeps a screenshot of each screen (1440 light, 390 dark) and of any failure.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/app.js';
const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
const shots = process.env.PULSE_SOP_SCREENSHOTS; if (shots) await mkdir(shots, { recursive: true });
const only = (process.env.SOP_ONLY ?? '').split(',').filter(Boolean);
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`; const dev = process.env.SOP_NEXT_DEV === '1';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: dev ? 'development' : 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? (dev ? '.next-sop' : '.next') }, stdio: 'ignore' });
const T = dev ? 120000 : 30000;
let browser; const results = []; let checks = 0; const errors = [];
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: T }); await page.waitForTimeout(500); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: T }); await ready(page); };
const posted = (page, path) => { const w = page.waitForResponse((r) => r.url().includes(`/api/v0/${path}`) && r.request().method() === 'POST', { timeout: T }); w.catch(() => null); return w; };
const pages = [];
async function as(who, width = 1440, theme = 'light') {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, ...(width < 500 ? { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 PulseShell/1.1.2', isMobile: true, hasTouch: true } : {}),
    geolocation: { latitude: 18.5204, longitude: 73.8567, accuracy: 12 }, permissions: ['geolocation'], extraHTTPHeaders: { 'cf-access-authenticated-user-email': `${who}@${domain}` } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch {} }, theme);
  const page = await ctx.newPage(); pages.push(page); page.setDefaultTimeout(T);
  page.on('pageerror', (e) => errors.push(`${who} ${e.message.slice(0, 200)}`));
  return page;
}
async function shot(page, name) { if (shots) { await page.waitForTimeout(600); await page.screenshot({ path: `${shots}/${name}.png` }); } }
async function flow(name, run) {
  if (only.length && !only.includes(name)) return;
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (e) {
    const error = String(e?.message ?? e).split('\n').slice(0, 6).join(' | ').slice(0, 900);
    results.push({ name, ok: false, error }); console.log(`FAIL ${name}: ${error}`);
    if (shots) for (const [i, p] of pages.entries()) if (!p.isClosed()) await p.screenshot({ path: `${shots}/fail-${name}-${i}.png` }).catch(() => null);
  }
  for (const p of pages.splice(0)) await p.context().close().catch(() => null);
}
/** Both sizes and themes of one screen. */
async function both(who, path, name, act) {
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) { const page = await as(who, width, theme); await go(page, path); if (act) await act(page, width); await shot(page, `${name}-${width}-${theme}`); }
}

try {
  for (let i = 0; i < 900; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch {} await delay(200); if (i === 899) throw new Error('next did not answer'); }
  browser = await chromium.launch();

  // FLOW-B (4329dcb8): Processes + Runs replace the six SOP pages. /sops and /sops/workflows open the Processes library
  // (every SOP, workflow and board as one process; New process and Import from Drive for leadership), /sops/runs opens
  // Runs, and the New workflow drawer is gone. An SOP's own page, a workflow's builder and the forms keep their addresses.
  // The processes themselves are tested end to end in the browser by tests/core/test_flow.py (flow-e2e).
  const api = (page, path, body) => page.evaluate(async ([p, b]) => { const r = await fetch(`/api/v0/${p}`, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => null) }; }, [path, body]);
  const sopPage = async (page, title) => { if (!page.url().startsWith(base)) await go(page, '/processes'); const sop = (await api(page, 'sops')).data.sops.find((x) => x.title === title); ok(sop, title); await go(page, `/sops/${sop.id}`); };
  await flow('library', async () => {
    await both('kedab', '/sops', 'library', async (page, width) => {
      await expect(page).toHaveURL(/\/processes$/);
      await expect(page.getByRole('link', { name: /Client onboarding/ })).toBeVisible();
      await expect(page.getByRole('link', { name: 'New process' }).first()).toBeVisible();
      if (width > 900) await expect(page.getByRole('link', { name: /^Import from Drive\s*3/ })).toBeVisible();
    });
    const page = await as('kabir'); await go(page, '/sops');
    await expect(page.getByRole('link', { name: /Shoot day/ })).toBeVisible();
    ok(await page.getByRole('link', { name: 'New process' }).count() === 0, 'members do not write processes');
    ok(await page.getByText('Monthly results report').count() === 0, 'members do not see drafts');
    await shot(page, 'library-member-1440-light');
  });

  await flow('sop-flow', async () => {
    for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
      const page = await as('kedab', width, theme); await sopPage(page, 'Client onboarding');
      // Phones open on the steps; the flow is one tap away.
      if (width < 500) { await expect(page.getByRole('heading', { name: 'Blueprint', exact: true })).toBeVisible({ timeout: T }); await page.getByRole('button', { name: 'Flow', exact: true }).click(); }
      await expect(page.getByRole('region', { name: 'Client onboarding: the flow' })).toBeVisible({ timeout: T });
      await expect(page.getByRole('button', { name: /^Step 6: Client approves the blueprint, Client/ })).toBeVisible();
      ok(await page.locator('svg path[data-kind="handoff"]').count() >= 5, 'handoffs are drawn');
      ok(await page.locator('svg path[data-kind="back"]').count() === 1, 'the send-back loop is drawn');
      await shot(page, `sop-flow-${width}-${theme}`);
      await page.getByRole('button', { name: /^Step 5: Brand alignment/ }).click();
      const side = page.getByRole('complementary', { name: 'Brand alignment' });
      await expect(side.getByText('Kabir Mifos').or(side.getByText('Kabir'))).toBeVisible();
      await expect(side.getByText('Logo files')).toBeVisible();
      await expect(side.getByRole('link', { name: /Brand kit template/ })).toBeVisible();
      await side.scrollIntoViewIfNeeded(); await shot(page, `sop-step-${width}-${theme}`);
      await page.getByRole('button', { name: 'Steps', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Blueprint', exact: true })).toBeVisible();
      await expect(page.getByText(/Handed over from Creative strategist/).first()).toBeVisible();
      await shot(page, `sop-steps-${width}-${theme}`);
    }
    const page = await as('kedab'); await sopPage(page, 'Shoot day');
    await expect(page.getByRole('button', { name: /^Step 1: Is the sample flat ready\?/ })).toBeVisible({ timeout: T });
    await shot(page, 'sop-decision-1440-light');
  });

  await flow('drive-review-import', async () => {
    await both('kedab', '/sops/drive', 'drive', async (page) => {
      await expect(page.getByRole('heading', { name: 'PGS Workflow & Responsibilities (synthetic)', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Banner/ })).toBeVisible();
    });
    const page = await as('kedab'); await go(page, '/sops/drive');
    await page.getByRole('link', { name: 'PGS Workflow & Responsibilities (synthetic)' }).click();
    await expect(page.getByRole('region', { name: /as Pulse read it/ })).toBeVisible({ timeout: T });
    await shot(page, 'drive-review-1440-light');
    await page.getByRole('link', { name: 'Edit first' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('PGS Workflow & Responsibilities (synthetic)', { timeout: T });
    await page.getByRole('button', { name: /^Brand Alignment/ }).first().click();
    await page.getByLabel('Role', { exact: true }).fill('Graphic Designer');
    await expect(page.getByRole('button', { name: /^Step 3: Brand Alignment, Graphic Designer/ })).toBeVisible();
    await shot(page, 'editor-1440-light');
    const saving = posted(page, 'sops/drive/'); await page.getByRole('button', { name: 'Bring in as active' }).click(); ok((await saving).ok(), 'brought in');
    await expect(page.getByRole('region', { name: /: the flow$/ })).toBeVisible({ timeout: T });
    ok(await page.locator('svg path[data-kind="handoff"]').count() >= 1, 'the designer step is a handoff now');
  });

  await flow('new-from-text', async () => {
    const page = await as('kedab'); await go(page, '/sops/new');
    await page.getByLabel('Name', { exact: true }).fill('Site visit');
    await page.getByLabel('The SOP text').fill('Site Visit – Process\n1. Confirm the visit date (Coordinator)\n   * Call the client within 24 hours\n2. Visit the site\n3. Is the site ready?\n4. Client approval\n');
    await page.getByRole('button', { name: 'Read the steps' }).click();
    await expect(page.getByRole('button', { name: 'Use these 4 steps' })).toBeVisible({ timeout: T });
    await shot(page, 'new-from-text-1440-light');
    await page.getByRole('button', { name: 'Use these 4 steps' }).click();
    await expect(page.getByRole('button', { name: /^Step 3: Is the site ready\?/ })).toBeVisible();
    const saving = posted(page, 'sops'); await page.getByRole('button', { name: 'Save draft' }).click(); ok((await saving).ok(), 'saved');
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible({ timeout: T });
  });

  // Part 2: a workflow made from an SOP with Pip beside it, published, run on a project and answered.
  let workflowId = null, runId = null;
  await flow('workflow-build', async () => {
    // FLOW-B: the New workflow drawer is gone; a workflow is still made from an SOP (the call the drawer made) and is
    // designed on its own page with Pip beside it.
    const page = await as('kedab'); await go(page, '/processes');
    const sop = (await api(page, 'sops')).data.sops.find((x) => x.title === 'Client onboarding');
    const made = await api(page, 'workflows/from-sop', { sopId: sop.id }); ok(made.status === 200 && made.data?.id, `made: ${JSON.stringify(made.data)}`);
    workflowId = made.data.id; await go(page, `/sops/workflows/${workflowId}`);
    await expect(page.getByRole('region', { name: 'Pip on this workflow' })).toBeVisible({ timeout: T });
    await page.locator('ol li').filter({ hasText: 'Brand alignment' }).getByRole('button').first().click();
    const pip = page.getByRole('note', { name: 'Pip on this step' });
    await expect(pip.getByText('Kabir Mifos')).toBeVisible({ timeout: T });
    await expect(pip.getByText(/^Only Kabir holds/)).toBeVisible();
    await pip.getByRole('button', { name: 'Use' }).first().click();
    await expect(page.getByText(/^If Kabir does it/)).toBeVisible({ timeout: T });
    await shot(page, 'builder-1440-light');
    const close = page.getByRole('region', { name: 'Pip on this workflow' }).getByRole('listitem').filter({ hasText: 'End with a close-out' });
    if (await close.count()) { await close.getByRole('button', { name: 'Add' }).click(); await expect(page.getByRole('button', { name: /^Step 9: Close out/ })).toBeVisible(); }
    const saving = posted(page, `workflows/${workflowId}`); await page.getByRole('button', { name: 'Publish', exact: true }).click(); ok((await saving).ok(), 'published');
    await expect(page.getByText('Live', { exact: true }).first()).toBeVisible({ timeout: T });
    await shot(page, 'builder-live-1440-light');
    const phone = await as('kedab', 390, 'dark'); await go(phone, `/sops/workflows/${workflowId}`); await shot(phone, 'builder-390-dark');
  });

  await flow('workflow-run', async () => {
    ok(workflowId, 'a workflow from the build flow');
    const page = await as('vikram'); await go(page, `/sops/workflows/${workflowId}`);
    await page.getByRole('button', { name: 'Start a run' }).click();
    const dialog = page.getByRole('dialog', { name: /^Start:/ });
    await dialog.getByRole('button', { name: /^Project:/ }).click(); await dialog.getByRole('combobox', { name: 'Project' }).fill('Pilot');
    await dialog.getByRole('option', { name: /Pilot project/ }).click();
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByRole('region', { name: /: the run$/ })).toBeVisible({ timeout: T });
    runId = page.url().split('/').pop();
    // Walk the run to its approval: each active step's task is finished by its doer (as leadership here).
    const lead = await as('kedab'); await go(lead, `/sops/runs/${runId}`);
    for (let i = 0; i < 5; i++) { const d = (await api(lead, `workflows/runs/${runId}`)).data; const a = d.steps.find((x) => x.status === 'active'); ok(a && a.kind === 'task', `step ${i + 1} is a task`);
      ok((await api(lead, `tasks/${a.taskId}/move`, { status: 'done' })).status === 200, 'finished'); }
    await go(lead, `/sops/runs/${runId}`);
    const side = lead.getByRole('complementary', { name: 'Client approves the blueprint' });
    await expect(side.getByRole('button', { name: 'Send back' })).toBeVisible({ timeout: T });
    await shot(lead, 'run-approval-1440-light');
    await side.getByLabel('Note (optional)').fill('Make the logo bigger');
    await side.getByRole('button', { name: 'Send back' }).click();
    await expect(lead.getByRole('button', { name: /^Step 4: Write the project blueprint.*Doing/ })).toBeVisible({ timeout: T });
    await shot(lead, 'run-sent-back-1440-light');
    const phone = await as('kedab', 390, 'dark'); await go(phone, `/sops/runs/${runId}`); await shot(phone, 'run-390-dark');
  });

  await flow('task-banner', async () => {
    ok(runId, 'a run from the run flow');
    const page = await as('kedab'); await go(page, `/sops/runs/${runId}`);
    let d = (await api(page, `workflows/runs/${runId}`)).data; let a = d.steps.find((x) => x.status === 'active');
    ok((await api(page, `tasks/${a.taskId}/move`, { status: 'done' })).status === 200, 'blueprint again');
    a = d.steps.find((x) => x.status === 'active'); d = (await api(page, `workflows/runs/${runId}`)).data; a = d.steps.find((x) => x.status === 'active');
    for (let i = 0; i < 1 && a.kind === 'task'; i++) { ok((await api(page, `tasks/${a.taskId}/move`, { status: 'done' })).status === 200, 'brand again'); d = (await api(page, `workflows/runs/${runId}`)).data; a = d.steps.find((x) => x.status === 'active'); }
    ok(a.kind === 'approval', 'back at the approval');
    await go(page, `/tasks/${a.taskId}`);
    const banner = page.getByRole('note', { name: 'Workflow step' });
    await expect(banner.getByText(/^Step 6 of \d+ in/)).toBeVisible({ timeout: T });
    await shot(page, 'task-banner-1440-light');
    await banner.getByRole('button', { name: 'Approved' }).click();
    await page.waitForTimeout(800);
    d = (await api(page, `workflows/runs/${runId}`)).data;
    ok(d.steps.find((x) => x.key === 's6').outcome === 'Approved' && d.steps.find((x) => x.key === 's7').status === 'active', 'approved on the task page');
  });

  await flow('workflow-member', async () => {
    ok(workflowId, 'a workflow from the build flow');
    const page = await as('kabir'); await go(page, '/sops/workflows');
    await expect(page.getByRole('link', { name: /Client onboarding/ }).first()).toBeVisible();
    ok(await page.getByRole('link', { name: 'New process' }).count() === 0, 'members do not design processes');
    await go(page, `/sops/workflows/${workflowId}`);
    await expect(page.getByRole('region', { name: 'Client onboarding: the flow' })).toBeVisible({ timeout: T });
    ok(await page.getByRole('region', { name: 'Pip on this workflow' }).count() === 0, 'no builder for members');
    await shot(page, 'workflow-member-1440-light');
    await go(page, `/runs?workflow=${workflowId}`); await expect(page.getByRole('link', { name: 'Pilot project' }).first()).toBeVisible(); await shot(page, 'runs-member-1440-light');
  });

  // Part 3: the solar installation template installed and its pickup form filled on a phone with the camera, a signature and the place.
  let recordId = null;
  await flow('forms-template', async () => {
    const page = await as('kedab'); await go(page, '/sops/forms');
    const tpl = page.getByRole('region', { name: 'Templates' }).getByRole('listitem').filter({ hasText: 'Solar installation' });
    await shot(page, 'forms-1440-light');
    await tpl.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('region', { name: 'Pip on this workflow' })).toBeVisible({ timeout: T });
    await shot(page, 'solar-workflow-1440-light');
    const saving = posted(page, 'workflows/'); await page.getByRole('button', { name: 'Publish', exact: true }).click(); ok((await saving).ok(), 'published');
    await go(page, '/sops/forms');
    await page.getByRole('link', { name: /Installation report/ }).click();
    await expect(page.getByText('On the phone')).toBeVisible({ timeout: T });
    await shot(page, 'form-builder-1440-light');
  });

  await flow('forms-fill', async () => {
    const lead = await as('kedab'); await go(lead, '/sops/workflows');
    const list = (await api(lead, 'workflows')).data.workflows; const wl = list.find((x) => x.name.startsWith('Solar installation'));
    ok(wl && wl.status === 'live', 'the solar workflow is live');
    const started = await api(lead, `workflows/${wl.id}/start`, { projectId: process.env.TEST_PROJECT, name: 'Rooftop 12 kW · synthetic' }); ok(started.status === 200, JSON.stringify(started.data));
    const run = (await api(lead, `workflows/runs/${started.data.id}`)).data; const step = run.steps.find((x) => x.status === 'active');
    const page = await as('ravi', 390, 'dark'); await go(page, `/tasks/${step.taskId}`);
    await page.getByRole('note', { name: 'Workflow step' }).getByRole('link', { name: 'Fill the form' }).click();
    await expect(page.getByRole('form', { name: 'Material pickup' })).toBeVisible({ timeout: T });
    await expect(page.getByText(/Location found/)).toBeVisible({ timeout: T });
    await page.getByRole('radio', { name: 'Main warehouse' }).click();
    await page.getByLabel('Panel serial numbers').fill('WL-001\nWL-002\nWL-003');
    await page.getByLabel('Inverter serial number').fill('INV-77');
    await page.getByLabel('Panels picked up').fill('12');
    // The camera: a picture of panels on a roof, taken now.
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 1200; c.height = 900; const g = c.getContext('2d');
      g.fillStyle = '#7fb3e0'; g.fillRect(0, 0, 1200, 900); g.fillStyle = '#8a7f72'; g.fillRect(0, 520, 1200, 380);
      for (let r = 0; r < 3; r++) for (let k = 0; k < 6; k++) { g.fillStyle = '#1d3557'; g.fillRect(120 + k * 165, 300 + r * 120, 150, 105); g.strokeStyle = '#a8c5e0'; g.lineWidth = 3; g.strokeRect(120 + k * 165, 300 + r * 120, 150, 105); }
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
      const input = document.querySelector('input[type=file][capture]');
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'IMG_0001.jpg', { type: 'image/jpeg', lastModified: Date.now() })); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.getByRole('img', { name: 'Photo of the loaded material 1' })).toBeVisible({ timeout: T });
    // A Pip arrival ("A task was assigned to you": the run gave Ravi this step) opens over the bottom of a phone screen
    // for a few seconds by design and took the strokes meant for the pad; the pad is what is tested here.
    await page.addStyleTag({ content: '[data-island]{display:none !important}' });
    const pad = page.getByRole('img', { name: /signature: sign here/ }); await pad.scrollIntoViewIfNeeded(); const box = await pad.boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height * 0.6); await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 20, box.y + box.height * (0.6 + 0.25 * Math.sin(i)), { steps: 2 });
    await page.mouse.up(); await expect(page.getByText('Signed', { exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0)); await shot(page, 'fill-390-dark');
    await page.getByRole('img', { name: 'Photo of the loaded material 1' }).scrollIntoViewIfNeeded(); await shot(page, 'fill-photo-390-dark');
    const sending = posted(page, 'forms/submit'); await page.getByRole('button', { name: 'Send', exact: true }).click(); const res = await sending; ok(res.ok(), `sent: ${res.status()} ${(await res.text()).slice(0, 300)}`);
    recordId = (await res.json()).id;
    await expect(page.getByRole('status').getByText('The step is done and the run has moved on.')).toBeVisible({ timeout: T });
    await shot(page, 'fill-sent-390-dark');
    const after = (await api(lead, `workflows/runs/${started.data.id}`)).data; ok(after.steps.find((x) => x.status === 'active').key === 'entry', 'the run moved on to the site entry');
    const forms = await as('ravi', 390, 'light'); await go(forms, '/sops/forms'); await expect(forms.getByRole('region', { name: 'To fill now' })).toBeVisible(); await shot(forms, 'forms-to-fill-390-light');
  });

  await flow('forms-record', async () => {
    ok(recordId, 'a sent form');
    for (const [w, theme] of [[1440, 'light'], [390, 'dark']]) {
      const page = await as('kedab', w, theme); await go(page, `/sops/records/${recordId}`);
      await expect(page.getByRole('region', { name: 'Answers' }).getByText('WL-002')).toBeVisible({ timeout: T });
      await expect(page.getByText('Pulse phone app')).toBeVisible();
      const img = page.getByRole('img', { name: /^Photo of the loaded material, taken/ });
      await expect(img).toBeVisible(); await page.waitForFunction((alt) => [...document.images].some((i) => i.alt.startsWith(alt) && i.naturalWidth > 100), 'Photo of the loaded material', { timeout: T });
      await shot(page, `record-${w}-${theme}`);
    }
  });

  // Part 4: where runs stand, and the project's strip.
  await flow('runs-overview', async () => {
    for (const [w, theme] of [[1440, 'light'], [390, 'dark']]) {
      // FLOW-B: /runs leads with the processes' runs; an older workflow's runs keep their overview at ?workflow=.
      const page = await as('kedab', w, theme); await go(page, `/runs${workflowId ? `?workflow=${workflowId}` : ''}`);
      await expect(page.getByRole('complementary', { name: 'Where runs wait' })).toBeVisible({ timeout: T });
      await expect(page.getByText('Finished this week')).toBeVisible();
      await shot(page, `runs-${w}-${theme}`);
    }
    const page = await as('kedab'); await go(page, `/tasks/projects/${process.env.TEST_PROJECT}`);
    const strip = page.getByRole('region', { name: 'Workflows on this project' });
    await expect(strip).toBeVisible({ timeout: T }); await expect(strip.getByRole('button', { name: 'Start a workflow' })).toBeVisible();
    await shot(page, 'project-strip-1440-light');
    await strip.getByRole('link', { name: /All runs and sent forms/ }).click();
    await expect(page.getByRole('heading', { name: /^Runs: / })).toBeVisible({ timeout: T });
    await shot(page, 'runs-project-1440-light');
  });

  // LAYOUT-SWEEP's rules on every new screen: nothing covered, clipped, spilling or out of reach.
  await flow('layout-audit', async () => {
    const { auditLayout, BLOCKING, settle } = await import('../../../tests/e2e/layout-audit.mjs');
    const lead = await as('kedab'); await go(lead, '/sops');
    const sop = (await api(lead, 'sops')).data.sops.find((x) => x.title === 'Client onboarding');
    const wf = (await api(lead, 'workflows')).data.workflows[0]; const runs = (await api(lead, 'workflows/runs')).data.runs;
    const forms = (await api(lead, 'forms')).data.forms; const src = (await api(lead, 'sops/drive')).data.sources[0];
    const fieldStep = runs.flatMap((r) => r.active).find((a) => a.person === 'Ravi Putig');
    const routes = [['kedab', '/sops'], ['kedab', `/sops/${sop.id}`], ['kedab', `/sops/${sop.id}/edit`], ['kedab', '/sops/drive'], src ? ['kedab', `/sops/drive/${src.id}`] : null, ['kedab', '/sops/new'],
      ['kedab', '/sops/workflows'], ['kedab', `/sops/workflows/${wf.id}`], ['kabir', `/sops/workflows/${wf.id}`], runs[0] ? ['kedab', `/sops/runs/${runs[0].id}`] : null, ['kedab', '/sops/runs'],
      ['kedab', '/sops/forms'], forms[0] ? ['kedab', `/sops/forms/${forms[0].id}`] : null, fieldStep ? ['ravi', `/sops/fill/${fieldStep.id}`] : null, recordId ? ['kedab', `/sops/records/${recordId}`] : null].filter(Boolean);
    const problems = [];
    for (const [width, height] of [[1366, 768], [1440, 900], [768, 1024], [390, 844]]) for (const [who, path] of routes) {
      const ctx = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': `${who}@${domain}` }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
      const p = await ctx.newPage(); p.setDefaultTimeout(T); await go(p, path);
      await p.addStyleTag({ content: '[data-island]{display:none !important}' }); await settle(p, 400);
      const { findings } = await p.evaluate(auditLayout, {});
      for (const f of findings) if (BLOCKING.includes(f.rule)) problems.push(`${width}x${height} ${path} ${f.rule}: ${f.where} — ${f.detail}`);
      await ctx.close();
    }
    for (const x of problems) console.log(`LAYOUT ${x}`);
    if (problems.length) await writeFile(`${process.env.TEST_REPORT}.layout.txt`, problems.join('\n'));
    ok(!problems.length, `${problems.length} layout problems (each printed as LAYOUT …)`);
  });

  ok(!errors.length, `no page errors: ${errors.join(' | ')}`);
} catch (e) { results.push({ name: 'setup', ok: false, error: String(e?.message ?? e).slice(0, 900) }); console.log(`FAIL setup: ${e}`); }
finally {
  await browser?.close().catch(() => null); try { process.kill(-server.pid, 'SIGTERM'); } catch {} await app.close(); await pool.end();
  const failed = results.filter((r) => !r.ok);
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, results, failed, errors }));
  console.log(`sop-browser: ${results.length - failed.length}/${results.length} flows, ${checks} checks`);
}
