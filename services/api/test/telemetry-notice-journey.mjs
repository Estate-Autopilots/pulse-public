// FEATURES-1024: the one-time telemetry toast and Settings → Privacy, in a real browser against a running Pulse
// (pulse-dev by default), as a synthetic staff member (Access identity), 1440 light and 390 dark: a slim line at the top
// says what is measured and what never is, stays clear of the phone's bottom bar, leaves by itself within ~7 s and never
// comes back; Privacy in Settings says it too; it never shows inside a framed page.
//   NOTICE_BASE=http://127.0.0.1:3200 NOTICE_OUT=~/ea-research/ux/journeys/FEATURES/telemetry-notice node services/api/test/telemetry-notice-journey.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.NOTICE_BASE ?? 'http://127.0.0.1:3200';
const OUT = process.env.NOTICE_OUT ?? '/tmp/telemetry-notice';
const WHO = process.env.NOTICE_WHO ?? 'asha.kireteso@synthetic.invalid';
await mkdir(OUT, { recursive: true });
const report = { base: BASE, checks: 0, steps: [], shots: [] };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };
const step = (s) => { report.steps.push(s); console.log('·', s); };
const browser = await chromium.launch();
const snap = async (page, name) => { const path = `${OUT}/${String(report.shots.length + 1).padStart(2, '0')}-${name}.png`; await page.screenshot({ path }); report.shots.push(path); };
try {
  for (const [w, theme] of [[1440, 'light'], [390, 'dark']]) {
    const phone = w < 500, h = phone ? 844 : 900;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, isMobile: phone, hasTouch: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': WHO } });
    // An automated browser sees the note only when it asks (telemetry-notice.tsx).
    await ctx.addInitScript(() => { try { localStorage.setItem('pulse.telemetry.notice.v1.test', '1'); } catch { /* ignore */ } });
    const page = await ctx.newPage(); page.setDefaultTimeout(90_000); page.setDefaultNavigationTimeout(180_000);
    await page.goto(`${BASE}/dashboard`);
    const toast = page.getByRole('status', { name: 'Pulse measures its own speed' });
    await toast.waitFor();
    const words = await toast.innerText();
    for (const t of ['measures taps', 'never what you type', 'passwords', 'leadership sees summaries']) ok(words.includes(t), `the note says “${t}”`);
    const box = await toast.boundingBox();
    ok(box && box.x >= 0 && box.x + box.width <= w + 1, `fits the width at ${w}`);
    ok(box && box.y + box.height < h / 3, `sits at the top, clear of the bottom bar (y ${Math.round(box?.y ?? -1)})`);
    await snap(page, `toast-${w}-${theme}`);
    await toast.waitFor({ state: 'detached', timeout: 9000 });
    ok(true, 'it left by itself');
    await page.reload(); await page.waitForTimeout(3000);
    ok(!(await toast.count()), 'seen once: it does not come back');
    await page.goto(`${BASE}/settings${theme === 'light' ? '' : ''}`);
    const privacy = page.locator('#privacy');
    if (!(await privacy.count())) await page.goto(`${BASE}/settings?tab=sign-in`);
    await privacy.waitFor();
    ok((await privacy.innerText()).includes('never records what you type'), 'Settings → Privacy says it in full');
    await privacy.scrollIntoViewIfNeeded(); await snap(page, `privacy-${w}-${theme}`);
    step(`${w} ${theme}: top toast, gone in ~6 s, not again; Privacy in Settings`);
    await ctx.close();
  }
  // Never inside a page framed by Pulse (the chat's side panel).
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'cf-access-authenticated-user-email': 'neha.soniba@synthetic.invalid' } });
  await ctx.addInitScript(() => { try { localStorage.setItem('pulse.telemetry.notice.v1.test', '1'); } catch { /* ignore */ } });
  const framed = await ctx.newPage(); await framed.setContent(`<iframe src="${BASE}/dashboard?embed=1" style="width:900px;height:600px"></iframe>`);
  const inner = framed.frameLocator('iframe'); await inner.locator('body').waitFor(); await framed.waitForTimeout(4000);
  ok(!(await inner.getByRole('status', { name: 'Pulse measures its own speed' }).count()), 'not inside a framed page');
  await ctx.close();
  report.ok = true;
} finally {
  await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(report.ok ? `telemetry-notice journey: PASS (${report.checks} checks)` : 'telemetry-notice journey: FAILED');
}
