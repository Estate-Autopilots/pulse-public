// CONNECT journey in a real browser against a running Pulse (pulse-dev's origin by default), two separate browser
// contexts: the inviting organisation's leader (Access identity) and the client (signed out, their own Pulse account).
//   EA makes a client request → the client opens the link → makes an account and sets up their organisation from the
//   details → accepts → both see the connection → EA makes a group with the client and gives them a task → the client
//   sees the group in their own Chats ("with …"), opens it, replies, and finishes the task → EA sees the reply and the
//   finished task.
//   CONNECT_BASE=http://localhost:3200 CONNECT_OWNER=user-668d21b6@estateautopilots.com \
//   CONNECT_OUT=~/ea-research/ux/journeys/CONNECT node services/api/test/connect-journey.mjs
import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.CONNECT_BASE ?? 'http://localhost:3200';
const OWNER = process.env.CONNECT_OWNER ?? 'user-668d21b6@estateautopilots.com';
const OUT = process.env.CONNECT_OUT ?? '/tmp/connect';
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const run = Date.now().toString(36).slice(-5);
const COMPANY = "Skyline Homes (test)", GROUP = "Skyline Homes × EA (test)", CONTACT = "Rila Testwala", PASSWORD = "Connect-journey-pass-9";
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
let shot = 0; const report = { base: BASE, run, company: COMPANY, steps: [], checks: 0 };
const step = (s) => { report.steps.push(s); console.log('·', s); };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };

/** The task page leads with Start (To do → Doing); then Mark done finishes it. */
export async function finishTask(c) {
  const start = c.getByRole('button', { name: 'Start', exact: true }).first();
  if (await start.isVisible().catch(() => false)) { await start.click(); await c.getByRole('button', { name: 'Mark done' }).first().waitFor({ timeout: 60_000 }); }
  await c.getByRole('button', { name: 'Mark done' }).first().click();
  const dialog = c.getByRole('dialog').filter({ hasText: 'Mark done' });
  if (await dialog.isVisible({ timeout: 5000 }).catch(() => false) || await dialog.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) await dialog.getByRole('button', { name: 'Mark done' }).click();
  await c.getByText(/Done|In review|Waiting for review/).first().waitFor({ timeout: 60_000 });
}

async function context(name, headers = {}) {
  const viewport = { width: 1440, height: 900 };
  const ctx = await browser.newContext({ viewport, recordVideo: { dir: `${OUT}/raw-${name}`, size: viewport }, extraHTTPHeaders: headers });
  const page = await ctx.newPage(); page.setDefaultTimeout(120_000); page.setDefaultNavigationTimeout(240_000);
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  return { ctx, page, name };
}
async function snap(page, label) { shot++; await page.screenshot({ path: `${OUT}/${String(shot).padStart(2, '0')}-${label}.png`, fullPage: false }); }
async function finish({ ctx, page, name }) { const video = page.video(); await ctx.close(); if (video) await rename(await video.path(), `${OUT}/CONNECT-${name}.webm`).catch(() => {}); }

const ea = await context('ea', { 'cf-access-authenticated-user-email': OWNER });
// The shared address is behind Cloudflare Access: a placeholder identity stands in for the public sign-in path the
// shared address still needs (ORG report); the client's Pulse sign-in is their own account session.
const client = await context('client', { 'cf-access-authenticated-user-email': `connect-client-${run}@example.test` });
try {
  // 0. EA side = the synthetic "EA Production Test" organisation of the owner's account (made once): on the Access
  //    address a session in the install's own organisation is replaced by the Access identity, so a client's seat
  //    works in an organisation other than the install's.
  let p = ea.page;
  await p.goto(`${BASE}/orgs`);
  const moved = await p.evaluate(async (name) => {
    const post = async (path, body) => { const r = await fetch(`/api/v0/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };
    const me = await (await fetch('/api/v0/account', { cache: 'no-store' })).json();
    const there = (me.orgs ?? []).find((o) => o.name === name);
    return there ? post('account/switch', { org: there.id }) : post('account/start', { name, handle: 'eaproductiontest' });
  }, 'EA Production Test');
  ok(moved.name === 'EA Production Test', `EA side opened: ${moved.name}`);
  report.eaOrg = moved.name;
  // 1. EA: the client request.
  await p.goto(`${BASE}/connections`);
  await p.getByRole('heading', { name: 'Invite a client' }).waitFor();
  await snap(p, 'ea-connections');
  const form = p.getByRole('form', { name: 'Client request' });
  await form.getByLabel('Client company').fill(COMPANY);
  await form.getByLabel('Contact name').fill(CONTACT);
  await form.getByLabel(/Contact e-mail/).fill("rila.skyline@example.test");
  await form.getByLabel(/Project/).fill('Website and lead capture');
  await form.getByLabel(/Deal summary/).fill('Closed today: 3-month retainer, website + lead capture, weekly review calls.');
  await form.getByRole('button', { name: 'Make the client link' }).click();
  const linkText = (await p.locator('[data-client-link]').textContent({ timeout: 60_000 }))?.trim();
  ok(linkText && /\/invited#[A-Za-z0-9_-]{43}$/.test(linkText), `a client link: ${linkText}`);
  ok(await p.getByRole('img', { name: 'Scan to open the client link' }).count() === 1, 'a QR code for the link');
  ok(await p.getByLabel('E-mail preview').getByText('not sent').count() >= 1, 'the e-mail preview says it is not sent');
  await p.getByRole('group', { name: 'Client link', exact: true }).scrollIntoViewIfNeeded();
  await snap(p, 'ea-client-link-qr-email');
  const link = linkText.replace(/^https?:\/\/[^/]+/, BASE);
  step(`EA made the client request for ${COMPANY}`);

  // 2. Client: opens the link, makes their account, sets up their organisation, accepts.
  const c = client.page;
  await c.goto(link);
  await c.getByRole('heading', { name: new RegExp(`invites ${esc(COMPANY)}`) }).waitFor();
  ok(await c.getByText('Website and lead capture').count() >= 1, 'the project is pre-filled');
  ok(await c.getByLabel('Organisation name').inputValue() === COMPANY, 'the organisation name is pre-filled');
  ok(await c.getByLabel('Your name').inputValue() === CONTACT, 'the contact name is pre-filled');
  await snap(c, 'client-opens-link');
  await c.getByLabel('Your handle').fill('rila.skyline');
  await c.getByLabel('Password').fill(PASSWORD);
  await snap(c, 'client-fills-account');
  await c.getByRole('button', { name: 'Create my account and accept' }).click();
  await c.waitForURL(/\/connections/, { timeout: 240_000 });
  await c.getByRole('article', { name: /Connection with / }).first().waitFor({ timeout: 240_000 });
  ok(await c.getByRole('article', { name: /Connection with / }).count() === 1, 'the client sees the connection');
  await snap(c, 'client-connected');
  step('client accepted: their organisation is set up and connected');

  // 3. EA sees the connection; makes a group with the client and gives them a task.
  await p.goto(`${BASE}/connections`);
  const card = p.getByRole('article', { name: `Connection with ${COMPANY}` });
  await card.waitFor();
  ok(await card.getByText(CONTACT).count() >= 1, 'EA sees the client contact');
  await snap(p, 'ea-sees-connection');
  await card.getByRole('button', { name: `New group with ${COMPANY}` }).click();
  const gform = card.getByRole('form', { name: `New group with ${COMPANY}` });
  await gform.getByLabel('Group name').fill(GROUP);
  await gform.getByRole('button', { name: 'Make the group' }).click();
  await p.waitForURL(/\/chats\?channel=/, { timeout: 240_000 });
  const channel = new URL(p.url()).searchParams.get('channel');
  const composer = p.getByRole('textbox').last();
  await composer.waitFor();
  await composer.fill(`Welcome aboard, Rila! Here we share everything for the launch.`);
  await composer.press('Enter');
  await p.getByText(`Welcome aboard, Rila!`).first().waitFor();
  ok(await p.getByText(`with ${COMPANY}`).count() >= 1, 'the group says "with <client>" in EA\'s Chats');
  await snap(p, 'ea-group-with-client');
  step('EA made the cross-organisation group and wrote in it');
  await p.goto(`${BASE}/connections`);
  await card.getByRole('button', { name: `Give a task to ${COMPANY}` }).click();
  const tform = card.getByRole('form', { name: `Give a task to ${COMPANY}` });
  await tform.getByLabel('Task').fill("Share the brand assets");
  await tform.getByRole('button', { name: 'Give the task' }).click();
  await card.getByText("Share the brand assets").waitFor();
  await snap(p, 'ea-task-given');
  step('EA gave the client contact a task');

  // 4. Client: the group is in their own Chats with "with …"; opens it in the shared space and replies.
  await c.goto(`${BASE}/chats`);
  const shared = c.getByRole('region', { name: 'Shared with other organisations' });
  await shared.waitFor({ timeout: 240_000 });
  await snap(c, 'client-own-chats-with-ea');
  await shared.getByRole('button', { name: new RegExp(esc(GROUP)) }).click();
  await c.waitForURL(/\/chats\?channel=/, { timeout: 240_000 });
  await c.getByText('Welcome aboard, Rila!').first().waitFor({ timeout: 240_000 });
  const reply = c.getByRole('textbox').last();
  await reply.fill(`Thanks! Sending the brand assets today.`);
  await reply.press('Enter');
  await c.getByText('Sending the brand assets today').first().waitFor();
  await snap(c, 'client-replies-in-group');
  step('client replied in the shared group');

  // 5. Client finishes the task.
  const conn = await (await p.request.get(`${BASE}/api/v0/connections`)).json();
  const mine = conn.connections.find((x) => x.other.name === COMPANY);
  const taskId = mine.shared.find((s) => s.kind === 'task').ref;
  await c.goto(`${BASE}/tasks/${taskId}`);
  await c.getByText("Share the brand assets").first().waitFor();
  await snap(c, 'client-opens-task');
  await finishTask(c);
  await snap(c, 'client-task-done');
  step('client marked the task done');

  // 6. EA sees the reply and the finished task.
  await p.goto(`${BASE}/connections`);
  await card.waitFor();
  await card.getByText('Sending the brand assets today').first().waitFor({ timeout: 60_000 });
  ok(await card.getByText(/Done/).count() >= 1, 'EA sees the task done');
  await snap(p, 'ea-sees-reply-and-done');
  await p.goto(`${BASE}/chats?channel=${channel}`);
  await p.getByText('Sending the brand assets today').first().waitFor();
  await snap(p, 'ea-reads-client-reply');
  step('EA sees the reply and the finished task');
  report.ok = true;
} catch (e) {
  report.error = String(e?.message ?? e).slice(0, 800);
  await snap(ea.page, 'fail-ea').catch(() => {}); await snap(client.page, 'fail-client').catch(() => {});
  throw e;
} finally {
  await finish(ea); await finish(client); await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
}
