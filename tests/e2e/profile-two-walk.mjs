// PROFILE-2 walk (owner, 17 Nov 2026): the person's own profile and a People page, on a scratch DB seeded by
// profile-two-seed.sql (synthetic). Shoots /profile and /people/<report> at 1440 and 363, light and dark, the skill
// picker open, and the People page's Tasks tab. Checks: no test company on the profile, no sideways scroll.
// Env: WEB, API, OUT.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const WEB = process.env.WEB, OUT = process.env.OUT ?? '/tmp/profile-two-shots';
const TOKEN = 'profiletwoPersonalWalkToken00000000000000001';
const MEGUD = 'e5000000-0000-4000-8000-0000000000b5';
mkdirSync(OUT, { recursive: true });
const host = new URL(WEB).hostname;
const results = [];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const step = async (name, fn) => { if (ONLY && !ONLY.test(name)) return; try { await fn(); results.push(['pass', name]); console.log('PASS', name); } catch (e) { results.push(['FAIL', name, String(e).slice(0, 300)]); console.log('FAIL', name, String(e).slice(0, 300)); } };
const browser = await chromium.launch();
async function page(width, dark) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 780 : 900 }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: 'pulse_session', value: TOKEN, domain: host, path: '/', httpOnly: true }]);
  const p = await ctx.newPage(); p.setDefaultTimeout(180000);
  return { ctx, p };
}
const noSideways = async (p) => {
  const w = await p.evaluate(() => ({ s: document.scrollingElement.scrollWidth, i: window.innerWidth }));
  assert.ok(w.s <= w.i + 1, `sideways scroll: ${w.s} > ${w.i}`);
};
// The app scrolls inside its shell, not the document: shoot one screen, scroll the biggest scroller in main, shoot again
// (up to three screens on a computer, two on a phone).
const shot = async (p, name) => {
  await p.waitForTimeout(900);
  const phone = p.viewportSize().width < 500;
  const scrollOnce = () => p.evaluate(() => {
    const els = [document.scrollingElement, ...document.querySelectorAll('main, main *')].filter((e) => e && e.scrollHeight - e.clientHeight > 40
      && (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY)));
    const el = els.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (!el) return false;
    const before = el.scrollTop; el.scrollTop = before + el.clientHeight - 120; return el.scrollTop > before;
  });
  for (let i = 1; i <= (phone ? 2 : 3); i++) {
    if (i > 1) { if (!(await scrollOnce())) break; await p.waitForTimeout(500); }
    await p.screenshot({ path: `${OUT}/${name}-${i}.jpg`, type: 'jpeg', quality: 82 });
  }
};
const sizes = [[1440, false], [1440, true], [363, false], [363, true]];

for (const [width, dark] of sizes) {
  const tag = `${width}-${dark ? 'dark' : 'light'}`;
  await step(`profile ${tag}`, async () => {
    const { ctx, p } = await page(width, dark);
    await p.goto(`${WEB}/profile`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-profile-hero]');
    const text = await p.locator('[data-profile-page]').innerText();
    assert.match(text, /Asha Fakerao/); assert.match(text, /Head of Content/);
    assert.doesNotMatch(text, /Fake Sales Test/, 'a test company shows on the profile');
    assert.doesNotMatch(text, /Your job title in each company|Build my resume|Change username/);
    await noSideways(p);
    await shot(p, `profile-${tag}`);
    await ctx.close();
  });
  await step(`people ${tag}`, async () => {
    const { ctx, p } = await page(width, dark);
    await p.goto(`${WEB}/people/${MEGUD}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-overview]');
    const text = await p.locator('main').innerText();
    assert.match(text, /Megud Fakegaonkar/); assert.match(text, /Reporting line/);
    await noSideways(p);
    await shot(p, `people-${tag}`);
    await ctx.close();
  });
}
await step('profile skill picker 1440 light', async () => {
  const { ctx, p } = await page(1440, false);
  await p.goto(`${WEB}/profile`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-skill-view]');
  await p.locator('[data-skill-view] button', { hasText: 'Add skill' }).first().click();
  await p.locator('[data-skill-editor] input').fill('motion');
  await p.locator('[role="listbox"] [role="option"]', { hasText: 'Motion graphics' }).first().waitFor(); await p.waitForTimeout(700);
  const opts = await p.locator('[role="listbox"]').innerText();
  assert.match(opts, /Motion graphics/);
  await shot(p, 'profile-skills-open-1440-light');
  await ctx.close();
});
await step('people tasks 1440 light', async () => {
  const { ctx, p } = await page(1440, false);
  await p.goto(`${WEB}/people/${MEGUD}?tab=tasks`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('main');
  await p.waitForTimeout(1500);
  await shot(p, 'people-tasks-1440-light');
  await ctx.close();
});
await browser.close();
const failed = results.filter((r) => r[0] !== 'pass');
console.log(`WALK ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
