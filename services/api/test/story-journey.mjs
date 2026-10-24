// FEATURES-1024: Product Story in a real browser against a running Pulse (pulse-dev by default), as a synthetic leader
// (Access identity): start a product's story → add the idea (a change typed, two pasted from release notes, a video
// link) → add v1.0 → the timeline shows both, newest first → tick both → Compare shows what changed from the idea to
// v1.0 → open a version on a phone. 1440 and 390, light and dark, no sideways scroll. The test product is removed again.
//   STORY_BASE=http://127.0.0.1:3200 STORY_OUT=~/ea-research/ux/journeys/FEATURES/story node services/api/test/story-journey.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.STORY_BASE ?? 'http://127.0.0.1:3200';
const OUT = process.env.STORY_OUT ?? '/tmp/story';
const WHO = process.env.STORY_WHO ?? 'kedab.mifos@synthetic.invalid';
const run = Date.now().toString(36).slice(-5), NAME = `Journey Product (test ${run})`;
await mkdir(OUT, { recursive: true });
const report = { base: BASE, run, checks: 0, steps: [], shots: [] };
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
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const d = await open();
let productId = null;
try {
  // 0. Leftovers of an interrupted run go first (by their names only).
  await d.page.goto(`${BASE}/story`);
  const before = await get(d.page, 'story');
  ok(Array.isArray(before.products), 'GET /api/v0/story answers');
  for (const p of before.products.filter((x) => /^Journey Product \(test [a-z0-9]{5}\)$/.test(x.name))) await post(d.page, `story/products/${p.id}/remove`).catch(() => {});
  await d.page.reload();
  await d.page.getByRole('heading', { name: 'Product Story', level: 1 }).waitFor();

  // 1. Start a product's story (the empty state when the organisation has none, else "+ Product").
  const start = d.page.getByRole('button', { name: /Start a product’s story/ });
  if (await start.isVisible().catch(() => false)) { await snap(d.page, 'empty-1440-light'); await start.click(); }
  else await d.page.getByRole('button', { name: 'Product', exact: true }).click();
  const ps = d.page.getByRole('dialog', { name: 'New product' });
  await ps.getByRole('textbox', { name: 'Product name' }).fill(NAME);
  await ps.getByRole('button', { name: 'Create' }).click();
  await d.page.getByRole('heading', { name: NAME, level: 2 }).waitFor();
  productId = (await get(d.page, 'story')).products.find((p) => p.name === NAME)?.id;
  ok(productId, 'the product exists');
  step('product created');

  // 2. The idea: one change typed, two pasted, a video link.
  const addVersion = async (label, title, stage, date, typed, pasted, link) => {
    await d.page.getByRole('button', { name: 'New version' }).click();
    const s = d.page.getByRole('dialog', { name: 'New version' });
    await s.getByRole('textbox', { name: 'Version label' }).fill(label);
    await s.getByRole('textbox', { name: 'Title' }).fill(title);
    await s.getByRole('combobox').first().selectOption(stage);
    await s.locator('input[type="date"]').fill(date);
    await s.getByRole('textbox', { name: 'Summary' }).fill(`${title}: written by the story journey.`);
    if (typed) { await s.getByRole('button', { name: 'Add a change' }).click(); await s.getByRole('textbox', { name: 'Change', exact: true }).last().fill(typed); }
    if (pasted) await s.getByRole('textbox', { name: 'Paste changes' }).fill(pasted);
    if (link) { await s.getByRole('button', { name: 'Add a link' }).click(); await s.getByRole('textbox', { name: 'Link', exact: true }).last().fill(link); await s.getByRole('textbox', { name: 'Label', exact: true }).last().fill('Walkthrough'); }
    await s.getByRole('button', { name: 'Save' }).click();
    await d.page.getByRole('article', { name: new RegExp(`^${label.replace('.', '\\.')}: `) }).waitFor();
  };
  await addVersion('Idea', 'A shared inbox for site visits', 'idea', '2026-09-01', 'Who it is for: sales teams on site', '• Visits logged from the phone\n• A photo with each visit', 'https://example.com/idea-walkthrough.mp4');
  await addVersion('v1.0', 'First release', 'live', '2026-10-01', 'Visit reports for the client', '- Offline drafts\n- Faster photo upload', null);
  const story = await get(d.page, 'story'); const mine = story.versions.filter((v) => v.productId === productId);
  ok(mine.length === 2, `two versions (${mine.length})`);
  const idea = mine.find((v) => v.label === 'Idea'), v1 = mine.find((v) => v.label === 'v1.0');
  ok(idea.changes.length === 3 && idea.media.length === 1 && idea.stage === 'idea', 'the idea keeps its typed and pasted changes and its video link');
  ok(v1.changes.length === 3 && v1.releasedOn === '2026-10-01', 'v1.0 kept its changes and date');
  const order = await d.page.locator('ol > li article').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  ok(order[0].startsWith('v1.0') && order[1].startsWith('Idea'), `newest first (${order.join(' | ')})`);
  ok(await d.page.getByRole('link', { name: /Walkthrough/ }).isVisible(), 'the video link is on the idea');
  await snap(d.page, 'timeline-1440-light');
  step('two versions on the timeline, newest first, with changes and a video link');

  // 3. Compare the two.
  for (const label of ['v1.0', 'Idea']) await d.page.getByRole('article', { name: new RegExp(`^${label.replace('.', '\\.')}: `) }).getByLabel('Compare').check();
  await d.page.getByRole('button', { name: 'Compare the two chosen' }).click();
  await d.page.getByRole('heading', { name: 'What changed from Idea to v1.0' }).waitFor();
  const cmp = d.page.getByRole('region', { name: 'Compare two versions' }).or(d.page.locator('section[aria-label="Compare two versions"]'));
  for (const t of ['Offline drafts', 'Faster photo upload', 'Visit reports for the client']) ok(await cmp.first().getByText(t).first().isVisible(), `compare lists “${t}”`);
  ok((await cmp.first().innerText()).includes('30 days apart'), 'the two are 30 days apart');
  await snap(d.page, 'compare-1440-light');
  step('Compare: what changed from the idea to v1.0, 30 days apart');

  // 4. Other sizes and themes.
  for (const [w, theme] of [[1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const v = await open({ w, theme });
    await v.page.goto(`${BASE}/story?product=${productId}`);
    await v.page.getByRole('heading', { name: NAME, level: 2 }).waitFor();
    ok(await noSideScroll(v.page), `no sideways scroll at ${w} ${theme}`);
    ok(await v.page.evaluate(() => document.documentElement.dataset.theme) === theme, `theme ${theme}`);
    await snap(v.page, `timeline-${w}-${theme}`);
    if (w < 500 && theme === 'dark') {
      await v.page.getByRole('article', { name: /^Idea: / }).getByRole('button').first().click();
      const s = v.page.getByRole('dialog', { name: 'Version Idea' }); await s.waitFor();
      ok(await noSideScroll(v.page), 'the version sheet fits a phone');
      await snap(v.page, 'version-sheet-390-dark');
    }
    await v.ctx.close();
  }
  step('1440 dark, 390 light and dark: fits, version sheet on a phone');
  report.ok = true;
} finally {
  if (productId) await post(d.page, `story/products/${productId}/remove`).catch((e) => { console.log('  cleanup:', e.message); report.leftover = productId; });
  await d.ctx.close(); await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(report.ok ? `story journey: PASS (${report.checks} checks)` : 'story journey: FAILED');
}
