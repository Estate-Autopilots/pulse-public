// Draws Pulse's app and tray icons from the brand masters (packages/design-system/src/brand.js) with headless Chromium.
// Run: node scripts/make-icons.mjs && pnpm exec tauri icon src-tauri/icons/source-1024.png -o src-tauri/icons
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BRAND, appIconSvg, markGlyph, markSvg } from '../../../packages/design-system/src/brand.js';
import { PIP_BULB } from '../../../packages/companion/src/pip.js';

const require = createRequire(new URL('../../../tests/e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const out = resolve('src-tauri/icons');
await mkdir(out, { recursive: true });

// Tray: the mark's tile with a status dot. Windows shows colour; macOS uses a black template image of the glyph.
const tray = (dot) => `<svg viewBox="0 0 32 32" width="64" height="64" xmlns="http://www.w3.org/2000/svg">${markSvg({ size: 32, id: 'tray' }).replace(/^<svg[^>]*>|<\/svg>$/g, '')}${dot ? `<circle cx="26" cy="26" r="5.5" fill="${dot}" stroke="#fff" stroke-width="2.2"/>` : ''}</svg>`;
const template = `<svg viewBox="4 3 24 26" width="44" height="44" xmlns="http://www.w3.org/2000/svg">${markGlyph('#000')}</svg>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const shot = async (html, file, size) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}#x{width:${size}px;height:${size}px;display:grid;place-items:center}svg{display:block}</style><div id="x">${html}</div>`);
    await page.locator('#x').screenshot({ path: resolve(out, file), omitBackground: true });
  };
  await shot(appIconSvg({ size: 1024, platform: 'mac' }), 'source-1024.png', 1024);
  await shot(tray(null), 'tray.png', 64);
  await shot(tray(PIP_BULB.in), 'tray-in.png', 64);
  await shot(tray(PIP_BULB.break), 'tray-break.png', 64);
  await shot(tray('#ff8a3d'), 'tray-alert.png', 64);
  await shot(template, 'tray-template.png', 44);
} finally {
  await browser.close();
}
console.log('icons written to', out, '(brand colour', BRAND.iris + ')');
