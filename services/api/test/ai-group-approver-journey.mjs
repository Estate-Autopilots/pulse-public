// FEATURES-1024 (0987): an AI employee asks the person set for a group, in a real browser against a running Pulse
// (pulse-dev by default), as a synthetic leader (Access identity): a "(test)" project group with a synthetic colleague
// and the AI employee → the AI's profile → AI tab → Groups and projects → "Asks here: <colleague>" → saved (the profile
// reads it back) → reset to the usual approver. 1440 light and 390 dark. The AI leaves the test group again.
//   AIG_BASE=http://127.0.0.1:3200 AIG_OUT=~/ea-research/ux/journeys/FEATURES/ai-group node services/api/test/ai-group-approver-journey.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.AIG_BASE ?? 'http://127.0.0.1:3200';
const OUT = process.env.AIG_OUT ?? '/tmp/ai-group';
const WHO = process.env.AIG_WHO ?? 'kedab.mifos@synthetic.invalid', AI = process.env.AIG_AI ?? 'Luna', COLLEAGUE = process.env.AIG_COLLEAGUE ?? /^Asha Kireteso/i;
await mkdir(OUT, { recursive: true });
const report = { base: BASE, checks: 0, steps: [], shots: [] };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };
const step = (s) => { report.steps.push(s); console.log('·', s); };
const browser = await chromium.launch();
const get = (page, path) => page.evaluate(async (p) => (await fetch(`/api/v0/${p}`, { cache: 'no-store' })).json(), path);
const post = (page, path, body = {}) => page.evaluate(async ([p, b]) => {
  const r = await fetch(`/api/v0/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${d.error ?? ''}`); return d;
}, [path, body]);
async function open({ w = 1440, theme = 'light' } = {}) {
  const phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': WHO } });
  const page = await ctx.newPage(); page.setDefaultTimeout(90_000); page.setDefaultNavigationTimeout(180_000);
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  return { ctx, page };
}
const snap = async (page, name) => { const path = `${OUT}/${String(report.shots.length + 1).padStart(2, '0')}-${name}.png`; await page.screenshot({ path }); report.shots.push(path); };

const d = await open();
let ai = null, group = null;
try {
  await d.page.goto(`${BASE}/chats`);
  const team = await get(d.page, 'agents/team');
  ai = (team.agents ?? []).find((a) => a.name === AI && a.status !== 'off') ?? (team.agents ?? []).find((a) => a.status !== 'off');
  ok(ai, 'an AI employee to set up');
  const opts = await get(d.page, 'work/options');
  const colleague = opts.people.find((p) => COLLEAGUE.test(p.name) && !p.agent);
  ok(colleague, 'a synthetic colleague');
  const name = `Project room (test ${Date.now().toString(36).slice(-5)})`;
  group = (await post(d.page, 'chats/groups', { name, memberIds: [colleague.id] })).id;
  await post(d.page, `chats/${group}/agents`, { agentId: ai.id, add: true });
  step(`${name}: ${colleague.name} and ${ai.name}`);

  // The profile's AI tab: "Asks here" for that group.
  await d.page.goto(`${BASE}/people/${ai.id}?tab=ai`);
  const select = d.page.getByLabel(`Who it asks in ${name}`);
  await select.waitFor();
  ok((await select.inputValue()) === '', 'it asks its usual approver at first');
  const saved = d.page.waitForResponse((r) => r.url().includes(`/api/v0/agents/${ai.id}/group-approver`) && r.request().method() === 'POST');
  await select.selectOption(colleague.id);
  const res = await saved; ok(res.ok(), `saved: ${res.status()}`);
  const detail = await get(d.page, `agents/${ai.id}/detail`);
  ok(detail.ai?.groupApprovers?.[group] === colleague.id, 'the profile reads the choice back');
  await select.scrollIntoViewIfNeeded(); await snap(d.page, 'asks-here-1440-light');
  await d.page.reload(); await d.page.getByLabel(`Who it asks in ${name}`).waitFor();
  ok((await d.page.getByLabel(`Who it asks in ${name}`).inputValue()) === colleague.id, 'kept after a reload');
  step(`Asks here: ${colleague.name}, saved and kept`);

  const p = await open({ w: 390, theme: 'dark' });
  await p.page.goto(`${BASE}/people/${ai.id}?tab=ai`);
  const ps = p.page.getByLabel(`Who it asks in ${name}`); await ps.waitFor(); await ps.scrollIntoViewIfNeeded();
  ok(await p.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'fits 390');
  await snap(p.page, 'asks-here-390-dark'); await p.ctx.close();

  // Back to the usual approver.
  await d.page.getByLabel(`Who it asks in ${name}`).selectOption('');
  await d.page.waitForResponse((r) => r.url().includes('/group-approver'));
  ok(!(await get(d.page, `agents/${ai.id}/detail`)).ai?.groupApprovers?.[group], 'reset to the usual approver');
  step('reset; 390 dark fits');
  report.ok = true;
} finally {
  if (ai && group) await post(d.page, `chats/${group}/agents`, { agentId: ai.id, add: false }).catch((e) => console.log('  cleanup:', e.message));
  await d.ctx.close(); await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(report.ok ? `ai-group-approver journey: PASS (${report.checks} checks)` : 'ai-group-approver journey: FAILED');
}
