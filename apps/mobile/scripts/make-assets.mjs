// Draws the shell's launcher icons (Android legacy, round and adaptive foreground), the iPhone app icon and the
// iPhone launch images from the Pulse brand masters (packages/design-system/src/brand.js), with headless Chromium.
// The adaptive icon's background is the brand iris (@color/ic_launcher_background). Run from the repository root:
//   node apps/mobile/scripts/make-assets.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, appIconSvg, markGlyph, markSvg } from '../../../packages/design-system/src/brand.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const require = createRequire(resolve(here, '../../../tests/e2e/package.json'));
const { chromium } = require('@playwright/test');

const CANVAS = { light: BRAND.canvas, dark: BRAND.night };
const res = resolve(app, 'android/app/src/main/res');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
// Adaptive foreground: Android masks to a circle or squircle, so the white mark stays inside the central 66 dp.
const foreground = (px) => `<div style="width:${px}px;height:${px}px;display:grid;place-items:center"><svg viewBox="0 0 32 32" width="${Math.round(px * 0.56)}" height="${Math.round(px * 0.56)}" style="display:block">${markGlyph(BRAND.paper)}</svg></div>`;
const shots = [];
for (const [d, k] of Object.entries(densities)) {
  const legacy = Math.round(48 * k), fg = Math.round(108 * k);
  shots.push([`${res}/mipmap-${d}/ic_launcher.png`, legacy, appIconSvg({ size: legacy })]);
  shots.push([`${res}/mipmap-${d}/ic_launcher_round.png`, legacy, `<div style="width:${legacy}px;height:${legacy}px;border-radius:50%;overflow:hidden">${appIconSvg({ size: legacy, platform: 'maskable' })}</div>`]);
  shots.push([`${res}/mipmap-${d}/ic_launcher_foreground.png`, fg, foreground(fg)]);
}
shots.push([resolve(app, 'assets/icon.png'), 1024, appIconSvg({ size: 1024, platform: 'ios' }), true]);
shots.push([resolve(app, 'assets/adaptive-icon.png'), 1024, foreground(1024)]);
const ios = resolve(app, 'ios/App/App/Assets.xcassets');
shots.push([`${ios}/AppIcon.appiconset/AppIcon-512@2x.png`, 1024, appIconSvg({ size: 1024, platform: 'ios' }), true]);
for (const theme of ['light', 'dark']) {
  const html = `<div style="width:2732px;height:2732px;display:grid;place-items:center;background:${CANVAS[theme]}">${markSvg({ size: 300, id: `splash-${theme}` })}</div>`;
  for (const name of theme === 'light' ? ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'] : ['splash-dark-2732x2732.png', 'splash-dark-2732x2732-1.png', 'splash-dark-2732x2732-2.png'])
    shots.push([`${ios}/Splash.imageset/${name}`, 2732, html, true]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [file, size, html, opaque] of shots) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent} #x svg{display:block}</style><div id="x" style="display:inline-block">${html}</div>`);
    await mkdir(dirname(file), { recursive: true });
    await page.locator('#x').screenshot({ path: file, omitBackground: !opaque });
  }
} finally { await browser.close(); }

const image = (filename, scale, dark) => ({ idiom: 'universal', filename, scale, ...(dark ? { appearances: [{ appearance: 'luminosity', value: 'dark' }] } : {}) });
await writeFile(`${ios}/Splash.imageset/Contents.json`, JSON.stringify({ images: [
  image('splash-2732x2732-2.png', '1x'), image('splash-dark-2732x2732-2.png', '1x', true),
  image('splash-2732x2732-1.png', '2x'), image('splash-dark-2732x2732-1.png', '2x', true),
  image('splash-2732x2732.png', '3x'), image('splash-dark-2732x2732.png', '3x', true),
], info: { version: 1, author: 'xcode' } }, null, 2) + '\n');
console.log(`${shots.length} images written`);
