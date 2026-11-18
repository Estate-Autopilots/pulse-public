// FEATURES-1024 (J1 + J8: "a missed call is a needs you"; CHAT-VOICE: "a Calls tab listing calls across chats"), in a
// real browser against a running Pulse (pulse-dev by default), as two synthetic staff (Access identities):
//   Kedab calls Asha and hangs up before she answers → Asha's chat home shows "Missed calls · Kedab Mifos" with Call
//   back → /calls lists it as Missed (1440 and 390, light and dark, no sideways scroll) → Call back rings Kedab from
//   Asha's Pulse and the missed line leaves Needs you → Asha hangs up (nothing left ringing).
//   CALLS_BASE=http://127.0.0.1:3200 CALLS_OUT=~/ea-research/ux/journeys/FEATURES/calls node services/api/test/calls-log-journey.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.CALLS_BASE ?? 'http://127.0.0.1:3200';
const OUT = process.env.CALLS_OUT ?? '/tmp/calls-log';
const CALLER = process.env.CALLS_CALLER ?? 'kedab.mifos@synthetic.invalid', CALLEE = process.env.CALLS_CALLEE ?? 'asha.kireteso@synthetic.invalid';
await mkdir(OUT, { recursive: true });
const report = { base: BASE, checks: 0, steps: [], shots: [] };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };
const step = (s) => { report.steps.push(s); console.log('·', s); };
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const post = (page, path, body = {}) => page.evaluate(async ([p, b]) => {
  const r = await fetch(`/api/v0/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${d.error ?? ''}`); return d;
}, [path, body]);
const get = (page, path) => page.evaluate(async (p) => (await fetch(`/api/v0/${p}`, { cache: 'no-store' })).json(), path);
async function open(email, { w = 1440, theme = 'light' } = {}) {
  const phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone,
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': email }, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage(); page.setDefaultTimeout(90_000); page.setDefaultNavigationTimeout(180_000);
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  return { ctx, page };
}
const snap = async (page, name) => { const path = `${OUT}/${String(report.shots.length + 1).padStart(2, '0')}-${name}.png`; await page.screenshot({ path }); report.shots.push(path); };
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const kedab = await open(CALLER);
let asha = null, mine = null;
try {
  // 1. Kedab rings Asha in their direct chat and hangs up before she answers: a missed call for her.
  await kedab.page.goto(`${BASE}/chats`);
  const opts = await get(kedab.page, 'work/options');
  const ashaP = opts.people.find((p) => /^asha kireteso/i.test(p.name)), kedabP = opts.people.find((p) => p.id === opts.me);
  ok(ashaP && kedabP, 'both synthetic people are in the organisation');
  const dm = await post(kedab.page, 'chats/direct', { personId: ashaP.id });
  const started = await post(kedab.page, 'calls', { channelId: dm.id, video: false });
  await post(kedab.page, `calls/${started.call.id}/leave`);
  const after = await get(kedab.page, `calls/${started.call.id}`);
  ok(after.call.state === 'ended' && after.call.endReason === 'missed', `the call ended missed (${after.call.state}/${after.call.endReason})`);
  step(`${kedabP.name} rang ${ashaP.name} and hung up: missed`);

  // 2. Asha's chat home: Missed calls first, with Call back.
  asha = await open(CALLEE);
  await asha.page.goto(`${BASE}/chats`);
  const needs = asha.page.getByRole('region', { name: 'Missed calls' }).or(asha.page.locator('section[aria-label="Missed calls"]'));
  await needs.first().waitFor();
  await needs.first().getByText(kedabP.name).first().waitFor();
  ok(await needs.first().getByRole('button', { name: `Call ${kedabP.name} back` }).isVisible(), 'Call back is offered');
  await snap(asha.page, 'needs-you-missed-1440-light');
  step('chat home: Missed calls shows the call with Call back');

  // 3. /calls at both sizes and themes.
  for (const [w, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const v = await open(CALLEE, { w, theme });
    await v.page.goto(`${BASE}/calls`);
    const row = v.page.locator('li[data-missed]').filter({ hasText: kedabP.name }).first();
    await row.waitFor();
    ok((await row.innerText()).includes('Missed'), 'the row says Missed');
    ok(await row.getByRole('button', { name: `Call ${kedabP.name}`, exact: true }).isVisible(), 'call back from the list');
    ok(await noSideScroll(v.page), `no sideways scroll at ${w} ${theme}`);
    ok(await v.page.evaluate(() => document.documentElement.dataset.theme) === theme, `theme ${theme}`);
    await snap(v.page, `calls-${w}-${theme}`);
    await v.ctx.close();
  }
  step('/calls: the missed call, call back and message, 1440/390 light/dark');

  // 4. Call back from Needs you: Asha's Pulse rings Kedab; the line leaves Needs you.
  await asha.page.getByRole('button', { name: `Call ${kedabP.name} back` }).click();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !mine) {
    const d = await get(asha.page, 'calls');
    mine = (d.calls ?? []).find((c) => c.startedBy !== kedabP.id && c.channelId === dm.id && c.state !== 'ended') ?? null;
    if (!mine) await asha.page.waitForTimeout(1500);
  }
  ok(mine, 'calling back started a call in the same conversation');
  ok(!(await asha.page.locator('section[aria-label="Missed calls"]').count()), 'the missed call left Needs you');
  await snap(asha.page, 'call-back-ringing-1440-light');
  step('Call back rang Kedab from Asha’s Pulse; Needs you is clear of it');
  report.ok = true;
} finally {
  if (mine && asha) await post(asha.page, `calls/${mine.id}/leave`).catch((e) => console.log('  cleanup:', e.message));
  if (asha) await asha.ctx.close();
  await kedab.ctx.close(); await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(report.ok ? `calls-log journey: PASS (${report.checks} checks)` : 'calls-log journey: FAILED');
}
