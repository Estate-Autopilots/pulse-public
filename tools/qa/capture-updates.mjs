// Run through ea-heavy. Static synthetic renders; does not start or modify a Pulse service.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { element, load, ui, views, render, update } from './updates-fixture.mjs';
const require = createRequire(new URL('../../tests/e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const out = process.env.PULSE_UPDATES_SCREENSHOT_DIR ?? process.env.PAPERCLIP_RUN_SCRATCH_DIR;
assert.ok(out, 'Set PULSE_UPDATES_SCREENSHOT_DIR');
await mkdir(out, { recursive: true });
const tokens = await readFile(new URL('../../packages/design-system/src/tokens.css', import.meta.url), 'utf8');
// Scope Updates' local classes as CSS modules do, so the full kit sheet cannot style its cards/rows.
const css = (await readFile(new URL('../../apps/web/app/updates/updates.module.css', import.meta.url), 'utf8')).replace(/\.([a-zA-Z_][\w-]*)/g, '.updates_$1');
const shared = await readFile(new URL('../../apps/web/app/ui.module.css', import.meta.url), 'utf8');
const badge = (await readFile(new URL('../../apps/web/app/kit/kit.module.css', import.meta.url), 'utf8')).split('\n').filter(line => /^\.aiBadge\b/.test(line)).join('\n');
const zone = 'Asia/Kolkata';
const listPage = load('updates/page.tsx', { '../ui': ui, './views': views, '../lib/brand-server': { orgZone: async () => zone }, '../lib/api': { apiV1: async () => ({ data: { items: [update, { ...update, id: 'older', headline: 'Your morning hand-off', period: 'morning', openedAt: update.createdAt }], nextCursor: update.id } }) } }).default;
const detailPage = load('updates/[id]/page.tsx', { '../../ui': ui, '../views': views, '../../lib/brand-server': { orgZone: async () => zone }, '../../lib/api': { apiV1: async () => ({ data: update }) } }).default;
const listMarkup = await listPage({ searchParams: Promise.resolve({}) });
const detailMarkup = await detailPage({ params: Promise.resolve({ id: update.id }) });
const scenes = {
  home: render(ui.Page, { children: [element(ui.PageHeader, { key: 'header', title: 'Home' }), element(views.HomeUpdate, { key: 'update', update, zone })] }),
  list: render(() => listMarkup, {}),
  detail: render(() => detailMarkup, {}),
};
const browser = await chromium.launch({ headless: true });
const evidence = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    for (const [scene, html] of Object.entries(scenes)) {
      // Supply the desktop bar's containing block; this remains synthetic component evidence, not a live shell.
      await page.setContent(`<!doctype html><html lang="en" data-theme="${theme}"><meta charset="utf-8"><title>Updates static harness</title><style>${tokens}\n${shared}\n${badge}\n${css}\nbody{padding:16px}main{position:relative;margin:auto;max-width:1280px}@media(min-width:900px){main{padding-top:48px}main::before{content:"";position:absolute;inset:0 0 auto;height:48px;border-bottom:1px solid var(--theme-border);background:var(--theme-surface)}}</style><main>${html}</main></html>`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width} ${scene} overflow`);
      const header = page.locator('.page > [data-page-header]');
      assert.equal(await header.locator('h2').innerText(), { home: 'Home', list: 'Updates', detail: 'Update' }[scene]);
      if (width >= 900) {
        const box = await header.boundingBox();
        assert.ok(box && box.y < 48 && box.height <= 48, `${scene} title is in the desktop bar`);
      }
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('a:focus-visible').count(), 1);
      assert.equal(await page.locator('a:focus-visible').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      const filename = `${scene}-${theme}-${width}.png`;
      await page.screenshot({ path: join(out, filename), fullPage: true }); evidence.push({ filename, theme, width, scene });
    }
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(join(out, 'screenshots.json'), JSON.stringify(evidence, null, 2));
console.log(`Verified ${evidence.length} static screenshots, no horizontal overflow; page headers in desktop bar and keyboard focus visible. Saved to ${out}`);
