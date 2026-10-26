// FEATURES-1024: Stack Intelligence, "Use this stack" across two organisations, in a real browser against a running
// Pulse (pulse-dev by default). Owner decision (24 Oct 2026): a tool is new spend for the organisation using a stack
// unless THAT organisation already pays for it; another organisation paying never covers it.
//   Source: Estate Autopilots, as a synthetic leader (Access identity) shares a stack with tool A (EA pays for it) and B.
//   Target: EA Production Test, as a synthetic staff account (its own Pulse sign-in), already pays for B.
//   The shared page says "New spend for EA Production Test" = A only; A says "Paid by Estate Autopilots, not by EA
//   Production Test"; B says "Already paid by EA Production Test" and "₹0 new". "Use this stack" keeps that maths in the
//   copy. At 1440 and 390 px, light and dark, with no sideways scroll; the stack card's "already paid" line is one line;
//   the radar's crowded adopt ring ends with no two dots on top of each other. Everything made here is removed again.
//   STACK_BASE=http://127.0.0.1:3200 STACK_OUT=~/ea-research/ux/journeys/FEATURES/stack node services/api/test/stack-spend-journey.mjs
// The target's password is read at run time (STACK_TARGET_PASSWORD, else the E2E-4P state file), never kept here.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.STACK_BASE ?? 'http://127.0.0.1:3200';
const OUT = process.env.STACK_OUT ?? '/tmp/stack-spend';
const SOURCE = process.env.STACK_SOURCE ?? 'kedab.mifos@synthetic.invalid';
const TARGET = process.env.STACK_TARGET ?? 'test.coordinator', TARGET_ORG = process.env.STACK_TARGET_ORG ?? 'EA Production Test';
const STATE = process.env.STACK_TARGET_STATE ?? `${homedir()}/ea-research/ux/journeys/E2E-4P-rerun/state.json`;
const secret = process.env.STACK_TARGET_PASSWORD ?? JSON.parse(await readFile(STATE, 'utf8')).coordinator?.password;
assert.ok(secret, 'the target account sign-in (STACK_TARGET_PASSWORD or the E2E-4P state file)');
const run = Date.now().toString(36).slice(-5);
const A = `Spend test Alpha ${run}`, B = `Spend test Beta ${run}`, STACK = `Spend journey ${run} (test)`;
await mkdir(OUT, { recursive: true });
const report = { base: BASE, run, checks: 0, steps: [], shots: [] };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };
const step = (s) => { report.steps.push(s); console.log('·', s); };
const browser = await chromium.launch();
// The dev origin stands behind Access: a placeholder identity rides along; the target's own Pulse session decides who it is.
const TGT_HEADERS = { 'cf-access-authenticated-user-email': `stack-spend-${run}@example.test` };

const post = (page, path, body = {}) => page.evaluate(async ([p, b]) => {
  const r = await fetch(`/api/v0/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${d.error ?? ''}`); return d;
}, [path, body]);
const get = (page, path) => page.evaluate(async (p) => { const r = await fetch(`/api/v0/${p}`, { cache: 'no-store' }); return r.json(); }, path);
async function open(opts) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const page = await ctx.newPage(); page.setDefaultTimeout(90_000); page.setDefaultNavigationTimeout(180_000);
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  return { ctx, page };
}
/** Removes what an earlier, interrupted run of this journey left (its names only). */
async function sweep(page, data) {
  const ours = (n) => /^(Spend test (Alpha|Beta)|Radar test \d+) [a-z0-9]{5}$/.test(n);
  for (const st of data.stacks.filter((x) => /^Spend journey [a-z0-9]{5} \(test\)$/.test(x.name))) await post(page, `stack/stacks/${st.id}/remove`).catch(() => {});
  const ids = data.tools.filter((x) => ours(x.name)).map((x) => x.id);
  if (ids.length) await post(page, 'stack/tools/bulk', { ids, remove: true }).catch(() => {});
}
async function snap(page, name) { const path = `${OUT}/${String(report.shots.length + 1).padStart(2, '0')}-${name}.png`; await page.screenshot({ path }); report.shots.push(path); }
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const src = await open({ extraHTTPHeaders: { 'cf-access-authenticated-user-email': SOURCE } });
let tgtState = null, made = { src: { tools: [], stack: null }, tgt: { tools: [], stacks: [] } };
try {
  // 1. Source shares a stack: A is marked paid in EA's stack, B is not.
  await src.page.goto(`${BASE}/stack`);
  const mine = await get(src.page, 'stack'); ok(mine.canEdit, 'the source person leads (may share)');
  const srcOrg = mine.org; ok(srcOrg, 'GET /api/v0/stack names the organisation');
  await sweep(src.page, mine);
  const t = await post(src.page, 'stack/tools/batch', { items: [{ name: A, category: 'monitoring', costInr: 1000, verdict: 'adopt', status: 'adopted' }, { name: B, category: 'ci', costInr: 500, verdict: 'trial', status: 'trial' }] });
  made.src.tools = t.ids;
  const s = await post(src.page, 'stack/stacks', { name: STACK, items: [{ toolId: t.ids[0], existing: true }, { toolId: t.ids[1] }] }); made.src.stack = s.id;
  const share = await post(src.page, `stack/stacks/${s.id}/share`, { public: false });
  ok(/^[0-9a-f]{64}$/.test(share.token), 'a share link'); step(`${srcOrg} shared “${STACK}”`);

  // 2. Target signs in with its own Pulse account, in EA Production Test, which already pays for B.
  const tgt = await open({ extraHTTPHeaders: TGT_HEADERS });
  await tgt.page.goto(`${BASE}/login`);
  const signed = await post(tgt.page, 'auth/account-sign-in', { login: TARGET, password: secret });
  if (signed.name !== TARGET_ORG) { const me = await get(tgt.page, 'account'); const o = me.orgs.find((x) => x.name === TARGET_ORG); ok(o, `${TARGET} is in ${TARGET_ORG}`); await post(tgt.page, 'account/switch', { org: o.id }); }
  await sweep(tgt.page, await get(tgt.page, 'stack'));
  const ours = await post(tgt.page, 'stack/tools', { name: B, category: 'ci', costInr: 500, verdict: 'adopt', status: 'adopted' }); made.tgt.tools.push(ours.id);
  tgtState = await tgt.ctx.storageState(); await tgt.ctx.close();
  step(`${TARGET} signed in to ${TARGET_ORG}, which already pays for B`);

  // 3. The shared page, as the target, at both sizes and themes.
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const theme of ['light', 'dark']) {
    const v = await open({ storageState: tgtState, extraHTTPHeaders: TGT_HEADERS, viewport: { width: w, height: h }, colorScheme: theme, isMobile: w < 500, hasTouch: w < 500 });
    await v.page.goto(`${BASE}/stack/s/${share.token}`);
    const head = v.page.getByTestId('new-spend');
    await head.waitFor();
    ok((await head.innerText()).includes(`New spend for ${TARGET_ORG}`), 'headline names the target organisation');
    ok((await head.innerText()).includes('₹1,000'), `new spend is A only: ${await head.innerText()}`);
    const rowA = v.page.locator('tr', { hasText: A }), rowB = v.page.locator('tr', { hasText: B });
    await rowA.getByText(`Paid by ${srcOrg}, not by ${TARGET_ORG}`).waitFor();
    await rowB.getByText(`Already paid by ${TARGET_ORG}`).waitFor();
    await rowB.getByText('₹0 new').waitFor();
    ok(!(await v.page.getByText('tools already paid for are left out').count()), 'the ambiguous wording is gone');
    ok(await noSideScroll(v.page), `no sideways scroll at ${w} ${theme}`);
    ok(await v.page.evaluate(() => document.documentElement.dataset.theme) === theme, `theme ${theme}`);
    await snap(v.page, `shared-${w}-${theme}`);
    await v.ctx.close();
  }
  step('shared page: new spend for the target, source-paid and target-paid tools labelled, 1440/390 light/dark');

  // 4. Use this stack: the copy keeps the same maths.
  const u = await open({ storageState: tgtState, extraHTTPHeaders: TGT_HEADERS });
  await u.page.goto(`${BASE}/stack/s/${share.token}`);
  await u.page.getByRole('button', { name: 'Use this stack' }).click();
  await u.page.waitForURL(/\/stack\?stack=/);
  const sheet = u.page.getByRole('dialog', { name: STACK });
  await sheet.waitFor();
  const sheetHead = sheet.getByTestId('new-spend');
  ok((await sheetHead.innerText()).includes(`New spend for ${TARGET_ORG}`) && (await sheetHead.innerText()).includes('₹1,000'), `copied stack headline: ${await sheetHead.innerText()}`);
  await sheet.locator('tr', { hasText: A }).getByText(`Paid by ${srcOrg}, not by ${TARGET_ORG}`).waitFor();
  await sheet.locator('tr', { hasText: B }).getByText(`Already paid by ${TARGET_ORG}`).waitFor();
  await snap(u.page, 'used-sheet-1440-light');
  const data = await get(u.page, 'stack'); const copy = data.stacks.find((x) => x.name === STACK); ok(copy, 'the copy exists'); made.tgt.stacks.push(copy.id);
  const byName = new Map(data.tools.map((x) => [x.name, x.id]));
  const itA = copy.items.find((i) => i.toolId === byName.get(A)), itB = copy.items.find((i) => i.toolId === byName.get(B));
  ok(itA && !itA.existing && itA.paidBy === srcOrg, 'A: new spend here, paid by the source');
  ok(itB && itB.existing && !itB.paidBy, 'B: covered by the target (matched by its own tool id)');
  if (byName.get(A)) made.tgt.tools.push(byName.get(A));
  await u.page.keyboard.press('Escape');
  step('Use this stack: copy counts A only; B covered by the target’s own tool');

  // 5. The stack card at 390: "already paid" is one line.
  for (const theme of ['light', 'dark']) {
    const c = await open({ storageState: tgtState, extraHTTPHeaders: TGT_HEADERS, viewport: { width: 390, height: 844 }, colorScheme: theme, isMobile: true, hasTouch: true });
    await c.page.goto(`${BASE}/stack`);
    await c.page.getByRole('tab', { name: 'Stacks' }).click();
    const card = c.page.locator('button', { hasText: STACK }).first(); await card.waitFor();
    const note = card.getByText(/already paid, not counted/); await note.waitFor();
    const lines = await note.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '18')));
    ok(lines <= 1, `already-paid line wraps (${lines} lines)`);
    ok(await noSideScroll(c.page), `stacks view fits 390 ${theme}`);
    await card.scrollIntoViewIfNeeded(); await snap(c.page, `stack-card-390-${theme}`);
    await c.ctx.close();
  }
  await u.ctx.close();
  step('stack card: the already-paid line stays on one line at 390');

  // 6. Radar: a crowded adopt ring spreads out (source organisation, throwaway tools).
  const cats = ['compute', 'hosting', 'ci', 'monitoring'];
  const crowd = await post(src.page, 'stack/tools/batch', { items: Array.from({ length: 16 }, (_, i) => ({ name: `Radar test ${i + 1} ${run}`, category: cats[i % 4], verdict: 'adopt', status: 'adopted', costInr: 0 })) });
  made.src.tools.push(...crowd.ids);
  for (const [w, theme] of [[1440, 'light'], [390, 'dark']]) {
    const r = await open({ extraHTTPHeaders: { 'cf-access-authenticated-user-email': SOURCE }, viewport: { width: w, height: w < 500 ? 844 : 900 }, colorScheme: theme, isMobile: w < 500, hasTouch: w < 500 });
    await r.page.goto(`${BASE}/stack`);
    await r.page.getByRole('tab', { name: 'Radar' }).click();
    const svg = r.page.locator('svg[aria-label^="Tech radar"]'); await svg.waitFor();
    const min = await svg.evaluate((el) => { const p = [...el.querySelectorAll('g circle')].map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]);
      let m = Infinity; for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) m = Math.min(m, Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1])); return m; });
    ok(min >= 17, `radar dots overlap (closest ${min.toFixed(1)})`);
    await svg.scrollIntoViewIfNeeded(); await snap(r.page, `radar-${w}-${theme}`);
    await r.ctx.close();
  }
  step('radar: 18 adopted tools, no two dots closer than 17 units');
  report.ok = true;
} finally {
  // Everything made here is removed again (leaders remove; a target without the right leaves its "(test)" rows).
  const clean = async (page, what) => { try { await what(page); } catch (e) { console.log('  cleanup:', e.message); report.leftovers = (report.leftovers ?? 0) + 1; } };
  if (made.src.stack) await clean(src.page, (p) => post(p, `stack/stacks/${made.src.stack}/remove`));
  if (made.src.tools.length) await clean(src.page, (p) => post(p, 'stack/tools/bulk', { ids: made.src.tools, remove: true }));
  if (tgtState && (made.tgt.stacks.length || made.tgt.tools.length)) {
    const c = await open({ storageState: tgtState, extraHTTPHeaders: TGT_HEADERS }); await c.page.goto(`${BASE}/stack`);
    for (const id of made.tgt.stacks) await clean(c.page, (p) => post(p, `stack/stacks/${id}/remove`));
    if (made.tgt.tools.length) await clean(c.page, (p) => post(p, 'stack/tools/bulk', { ids: made.tgt.tools, remove: true }));
    await c.ctx.close();
  }
  await src.ctx.close(); await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(report.ok ? `stack-spend journey: PASS (${report.checks} checks)` : 'stack-spend journey: FAILED');
}
