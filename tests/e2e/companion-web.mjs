// Pulse web companion on a running dev server: the corner pill and the open panel, /connect with a live pairing
// code, Settings → Devices → Get the apps and HR → Office presence, in light/dark at desktop and phone widths.
// node tests/e2e/companion-web.mjs [outDir] [email]   (needs pulse-dev on 127.0.0.1:3200; no data is written except
// one pairing code, which is deleted by the caller afterwards)
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const [out = '/home/eadev/ea-research/companion/web', email = 'user-668d21b6@estateautopilots.com'] = process.argv.slice(2);
const base = 'http://127.0.0.1:3200';
await mkdir(out, { recursive: true });
const pair = await (await fetch(`${base}/api/native/v0/native/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'windows', name: 'Screenshot laptop (synthetic)' }) })).json();
const scenes = [
  { name: 'pill', path: '/me', open: false },
  { name: 'panel', path: '/me', open: true },
  { name: 'connect', path: `/connect?code=${pair.code}`, open: false, hide: true },
  { name: 'get-the-apps', path: '/settings?tab=devices', open: false },
  { name: 'office-presence', path: '/hr?tab=policies&view=presence', open: false, hide: true },
];
const browser = await chromium.launch();
const results = [];
try {
  for (const [width, height] of [[1440, 900], [390, 844]]) for (const theme of ['light', 'dark']) for (const s of scenes) {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce', extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': email }, deviceScaleFactor: width < 500 ? 2 : 1 });
    await ctx.addInitScript(([t, open, hide]) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); localStorage.setItem('pulse-companion-web', JSON.stringify({ open, hidden: hide })); } catch {} }, [theme, s.open, !!s.hide]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + s.path, { waitUntil: 'load', timeout: 180000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (s.name === 'pill') await page.waitForSelector('[aria-label^="Open the Pulse companion"]', { timeout: 30000 });
    if (s.name === 'panel') await page.waitForSelector('.pc', { timeout: 30000 });
    if (s.name === 'connect') await page.getByText(pair.code).waitFor({ timeout: 30000 });
    const g = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth > innerWidth + 1 }));
    assert.equal(g.overflowX, false, `${s.name} ${width} overflows`);
    assert.deepEqual(errors, [], `${s.name} ${width} ${theme}: ${errors.join(' | ')}`);
    await page.screenshot({ path: `${out}/${theme}-${width}-${s.name}.png` });
    results.push({ scene: s.name, width, theme, ...g });
    await ctx.close();
  }
} finally {
  await browser.close();
  await writeFile(`${out}/results.json`, JSON.stringify({ pairCode: 'deleted after the run', results }, null, 2));
}
console.log(JSON.stringify({ shots: results.length, pairId: pair.pairId }));
