// CONNECT journey, last part (resume after connect-journey.mjs stopped at the task): the client signs back in with
// their own Pulse account, opens the task EA gave them in the shared space and finishes it; EA sees the reply and the
// finished task. Same two separate contexts and output folder; screenshots continue from 20.
//   CONNECT_BASE=http://localhost:3200 CONNECT_OUT=~/ea-research/ux/journeys/CONNECT node services/api/test/connect-journey-finish.mjs
import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.CONNECT_BASE ?? 'http://localhost:3200';
const OWNER = process.env.CONNECT_OWNER ?? 'user-668d21b6@estateautopilots.com';
const OUT = process.env.CONNECT_OUT ?? '/tmp/connect';
const COMPANY = 'Skyline Homes (test)', EA_ORG = 'EA Production Test', HANDLE = 'rila.skyline', PASSWORD = 'Connect-journey-pass-9';
const browser = await chromium.launch();
let shot = 19; const report = JSON.parse(await readFile(`${OUT}/report.json`, 'utf8').catch(() => '{}')); report.finish = { steps: [] };
const step = (s) => { report.finish.steps.push(s); console.log('·', s); };
async function context(name, headers) {
  const viewport = { width: 1440, height: 900 };
  const ctx = await browser.newContext({ viewport, recordVideo: { dir: `${OUT}/raw-${name}-finish`, size: viewport }, extraHTTPHeaders: headers });
  const page = await ctx.newPage(); page.setDefaultTimeout(120_000); page.setDefaultNavigationTimeout(240_000);
  return { ctx, page, name };
}
const snap = async (page, label) => { shot++; await page.screenshot({ path: `${OUT}/${shot}-${label}.png` }); };
async function finish({ ctx, page, name }) { const v = page.video(); await ctx.close(); if (v) await rename(await v.path(), `${OUT}/CONNECT-${name}-finish.webm`).catch(() => {}); }
const post = async (page, path, body) => page.evaluate(async ([p, b]) => { const r = await fetch(`/api/v0/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; }, [path, body]);

const ea = await context('ea', { 'cf-access-authenticated-user-email': OWNER });
const client = await context('client', { 'cf-access-authenticated-user-email': 'connect-client-finish@example.test' });
try {
  // EA side in the synthetic EA organisation; the shared task's id from its Connections.
  const p = ea.page; await p.goto(`${BASE}/orgs`);
  const me = await p.evaluate(async () => (await fetch('/api/v0/account', { cache: 'no-store' })).json());
  const eaOrg = me.orgs.find((o) => o.name === EA_ORG); assert.ok(eaOrg, 'the EA side organisation');
  if (!eaOrg.current) await post(p, 'account/switch', { org: eaOrg.id });
  const conns = await (await p.request.get(`${BASE}/api/v0/connections`)).json();
  const conn = conns.connections.find((x) => x.other.name === COMPANY); assert.ok(conn, 'the connection with the client');
  const task = conn.shared.find((s) => s.kind === 'task'), group = conn.shared.find((s) => s.kind === 'chat');

  // The client signs in with their own Pulse account (handle + password) and opens the task in the shared space.
  const c = client.page; await c.goto(`${BASE}/login`);
  const signed = await post(c, 'auth/account-sign-in', { login: HANDLE, password: PASSWORD });
  if (signed.name !== EA_ORG) await post(c, 'account/switch', { org: eaOrg.id });
  step(`client signed in as @${HANDLE}`);
  await c.goto(`${BASE}/tasks/${task.ref}`);
  await c.getByText(task.title).first().waitFor();
  await snap(c, 'client-opens-task');
  const start = c.getByRole('button', { name: 'Start', exact: true }).first();
  if (await start.isVisible().catch(() => false)) { await start.click(); await c.getByRole('button', { name: 'Mark done' }).first().waitFor({ timeout: 60_000 }); await snap(c, 'client-task-doing'); }
  await c.getByRole('button', { name: 'Mark done' }).first().click();
  const dialog = c.getByRole('dialog').filter({ hasText: 'Mark done' });
  if (await dialog.isVisible({ timeout: 5000 }).catch(() => false) || await dialog.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) await dialog.getByRole('button', { name: 'Mark done' }).click();
  await c.waitForTimeout(4000);
  await snap(c, 'client-task-done');
  step('client marked the task done');

  // EA sees the reply and the finished task.
  await p.goto(`${BASE}/connections`);
  const card = p.getByRole('article', { name: `Connection with ${COMPANY}` });
  await card.getByText('Sending the brand assets today').first().waitFor({ timeout: 60_000 });
  const after = (await (await p.request.get(`${BASE}/api/v0/connections`)).json()).connections.find((x) => x.id === conn.id);
  const st = after.shared.find((s) => s.ref === task.ref).status;
  assert.ok(['done', 'in_review', 'accepted'].includes(st), `EA sees the task finished: ${st}`);
  await snap(p, 'ea-sees-reply-and-done');
  await p.goto(`${BASE}/chats?channel=${group.ref}`);
  await p.getByText('Sending the brand assets today').first().waitFor();
  await snap(p, 'ea-reads-client-reply');
  step(`EA sees the reply and the task ${st}`);
  report.finish.ok = true; report.ok = true;
} catch (e) {
  report.finish.error = String(e?.message ?? e).slice(0, 800);
  await snap(ea.page, 'finish-fail-ea').catch(() => {}); await snap(client.page, 'finish-fail-client').catch(() => {});
  throw e;
} finally {
  await finish(ea); await finish(client); await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
}
