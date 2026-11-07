// Toolbar and store icons (16/32/48/128) from the Pulse mark (packages/design-system/src/brand.js), drawn with headless
// Chromium. The 128 px store icon keeps Chrome's 16 px transparent margin. Run: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { markSvg } from '../../../packages/design-system/src/brand.js';
const require = createRequire(new URL('../../../tests/e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const out = fileURLToPath(new URL('../icons/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const art = size === 128 ? 96 : size;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}div{display:grid;place-items:center;width:${size}px;height:${size}px}svg{display:block}</style><div>${markSvg({ size: art, radius: size === 16 ? 7 : 9 })}</div>`);
    await page.screenshot({ path: `${out}${size}.png`, omitBackground: true });
  }
} finally { await browser.close(); }
console.log('icons written to', out);
