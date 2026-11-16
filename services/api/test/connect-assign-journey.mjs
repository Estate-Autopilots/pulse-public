// FEATURES-1024 / CONNECT 2 (owner: "task assignment from them to this organisation or the points of contact of the
// org"), in a real browser against a running Pulse (pulse-dev by default): a synthetic coordinator of "EA Production
// Test" gives a task from the ordinary Create form (N) to a contact of a connected organisation ("Lakeview Homes
// (test)"): the contact is in "Who does it" with their organisation, the task is assigned at once, and it is shared
// through the connection (the client sees it in their own Pulse, CONNECT slice 1). 1440 light and 390 dark.
//   CONNECT2_BASE=http://127.0.0.1:3200 CONNECT2_OUT=~/ea-research/ux/journeys/FEATURES/connect2 node services/api/test/connect-assign-journey.mjs
// The coordinator's password is read at run time (CONNECT2_PASSWORD, else the E2E-4P state file), never kept here.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.CONNECT2_BASE ?? 'http://127.0.0.1:3200';
const OUT = process.env.CONNECT2_OUT ?? '/tmp/connect2';
const LOGIN = process.env.CONNECT2_LOGIN ?? 'test.coordinator', ORG = process.env.CONNECT2_ORG ?? 'EA Production Test';
const OTHER = process.env.CONNECT2_OTHER ?? 'Lakeview Homes (test)';
const STATE = process.env.CONNECT2_STATE ?? `${homedir()}/ea-research/ux/journeys/E2E-4P-rerun/state.json`;
const secret = process.env.CONNECT2_PASSWORD ?? JSON.parse(await readFile(STATE, 'utf8')).coordinator?.password;
assert.ok(secret, 'the coordinator sign-in (CONNECT2_PASSWORD or the E2E-4P state file)');
const run = Date.now().toString(36).slice(-5), TITLE = `Send the site photos (test ${run})`;
await mkdir(OUT, { recursive: true });
const report = { base: BASE, run, checks: 0, steps: [], shots: [] };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };
const step = (s) => { report.steps.push(s); console.log('·', s); };
const HEADERS = { 'cf-access-authenticated-user-email': `connect2-${run}@example.test` };
const browser = await chromium.launch();
const post = (page, path, body = {}) => page.evaluate(async ([p, b]) => {
  const r = await fetch(`/api/v0/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${d.error ?? ''}`); return d;
}, [path, body]);
const get = (page, path) => page.evaluate(async (p) => (await fetch(`/api/v0/${p}`, { cache: 'no-store' })).json(), path);
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: HEADERS, ...opts });
  const page = await ctx.newPage(); page.setDefaultTimeout(90_000); page.setDefaultNavigationTimeout(180_000);
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  return { ctx, page };
}
const snap = async (page, name) => { const path = `${OUT}/${String(report.shots.length + 1).padStart(2, '0')}-${name}.png`; await page.screenshot({ path }); report.shots.push(path); };
const dialog = (page) => page.getByRole('dialog', { name: /New task|Create/ });
async function newTask(page) {
  const box = page.getByRole('textbox', { name: 'What needs doing' });
  for (let i = 0; i < 12 && !(await box.isVisible().catch(() => false)); i++) { await page.keyboard.press('n'); await page.waitForTimeout(1500); }
  await box.waitFor(); return box;
}
async function pickContact(page, name) {
  await dialog(page).getByRole('button', { name: /^Who does it:/ }).click();
  await page.getByPlaceholder('Search people').fill(name.split(' ')[0]);
  const option = page.getByRole('option', { name: new RegExp(name) }).first();
  await option.waitFor();
  ok((await option.innerText()).includes(OTHER), `the contact shows their organisation (${(await option.innerText()).replace(/\s+/g, ' ')})`);
  return option;
}

let state = null, made = null;
try {
  // 0. The coordinator signs in to EA Production Test with their own Pulse account.
  const s = await open(); await s.page.goto(`${BASE}/login`);
  const signed = await post(s.page, 'auth/account-sign-in', { login: LOGIN, password: secret });
  if (signed.name !== ORG) { const me = await get(s.page, 'account'); const o = me.orgs.find((x) => x.name === ORG); ok(o, `${LOGIN} is in ${ORG}`); await post(s.page, 'account/switch', { org: o.id }); }
  const opts = await get(s.page, 'work/options');
  const contact = opts.people.find((p) => p.org === OTHER);
  ok(contact && contact.connectionId, `a contact of ${OTHER} is offered to give work to`);
  ok(opts.people.findIndex((p) => p.org) > opts.people.findIndex((p) => !p.org), 'contacts come after the team');
  state = await s.ctx.storageState(); await s.ctx.close();
  step(`${LOGIN} in ${ORG}: ${contact.name} of ${OTHER} is in the people list`);

  // 1. 1440 light: N → title → Who does it → the contact → Enter.
  const d = await open({ storageState: state });
  await d.page.goto(`${BASE}/tasks`);
  const box = await newTask(d.page);
  await box.fill(TITLE);
  const option = await pickContact(d.page, contact.name);
  await snap(d.page, 'who-does-it-contact-1440-light');
  await option.click();
  ok((await dialog(d.page).getByRole('button', { name: /^Who does it:/ }).innerText()).includes(contact.name.split(' ')[0]), 'the contact is chosen');
  const made1 = d.page.waitForResponse((r) => r.url().endsWith('/api/v0/work/tasks') && r.request().method() === 'POST');
  await box.press('Enter');
  const res = await made1; const r = await res.json();
  ok(res.ok(), `created: ${res.status()} ${r.error ?? ''}`);
  made = r.id;
  ok(r.assigned && r.connection?.org === OTHER, 'assigned at once, through the connection');
  await d.page.getByText(new RegExp(`Assigned to ${contact.name.split(' ')[0]}`)).first().waitFor();
  await snap(d.page, 'assigned-toast-1440-light');
  const conns = await get(d.page, 'connections');
  const conn = conns.connections.find((x) => x.id === contact.connectionId);
  ok(conn?.shared?.some((x) => x.kind === 'task' && x.ref === made), 'the task is shared with the connected organisation');
  const t = await get(d.page, `tasks/${made}`);
  ok((t.task?.assigneeId ?? t.assigneeId) === contact.id || JSON.stringify(t).includes(contact.id), 'the contact is the assignee');
  await d.ctx.close();
  step(`Create → ${contact.name} (${OTHER}) → assigned and shared through the connection`);

  // 2. 390 dark: the same picker fits a phone.
  const p = await open({ storageState: state, viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true });
  await p.page.goto(`${BASE}/tasks`);
  const pbox = p.page.getByRole('textbox', { name: 'What needs doing' });
  for (let i = 0; i < 6 && !(await pbox.isVisible().catch(() => false)); i++) {
    const add = p.page.getByRole('button', { name: /^(New|Create|New task)$/ }).first();
    if (await add.isVisible().catch(() => false)) await add.click(); else await p.page.keyboard.press('n');
    await p.page.waitForTimeout(1500);
  }
  await pbox.waitFor(); await pbox.fill(`Phone check (test ${run})`);
  await pickContact(p.page, contact.name);
  ok(await p.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390');
  await snap(p.page, 'who-does-it-contact-390-dark');
  await p.ctx.close();
  step('390 dark: the contact and their organisation in the picker');

  // 3. A client link goes out on WhatsApp too (the message is written; nothing is sent until they press send).
  const wa = await open({ storageState: state });
  await wa.page.goto(`${BASE}/connections`);
  const company = `WhatsApp check (test ${run})`;
  const form = wa.page.getByRole('form', { name: 'Client request' });
  await form.getByLabel('Client company').fill(company); await form.getByLabel('Contact name').fill('Test Contact');
  await form.getByRole('button', { name: /Make the client link/ }).click();
  const link = await wa.page.locator('code[data-client-link]').innerText();
  const href = await wa.page.locator('a[data-whatsapp-share]').getAttribute('href');
  ok(href?.startsWith('https://wa.me/?text=') && decodeURIComponent(href.split('text=')[1]).includes(link), 'WhatsApp carries the client link');
  await wa.page.locator('a[data-whatsapp-share]').scrollIntoViewIfNeeded(); await snap(wa.page, 'client-link-whatsapp-1440-light');
  const reqs = (await get(wa.page, 'connections')).requests ?? [];
  const mineReq = reqs.find((q) => q.company === company);
  if (mineReq) await post(wa.page, `connections/requests/${mineReq.id}/revoke`).catch((e) => console.log('  cleanup:', e.message));
  await wa.ctx.close();
  step('client link: Copy, QR and WhatsApp');

  // 4. People shows the connected organisations and their contacts beside the team.
  const pe = await open({ storageState: state });
  await pe.page.goto(`${BASE}/people`);
  const side = pe.page.locator('a[href="/connections"]', { hasText: OTHER.split(' (')[0] }).first();
  await side.waitFor();
  ok((await side.getAttribute('href'))?.endsWith('/connections'), 'People → Connected organisations links to Connections');
  await snap(pe.page, 'people-connected-1440-light'); await pe.ctx.close();
  step('People: Connected organisations');
  report.ok = true;
} finally {
  // The test task is cancelled again so it leaves nobody's list.
  if (made && state) { const c = await open({ storageState: state }); await c.page.goto(`${BASE}/tasks`);
    await post(c.page, `tasks/${made}/move`, { status: 'cancelled' }).catch((e) => { console.log('  cleanup:', e.message); report.leftover = made; }); await c.ctx.close(); }
  await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(report.ok ? `connect-assign journey: PASS (${report.checks} checks)` : 'connect-assign journey: FAILED');
}
