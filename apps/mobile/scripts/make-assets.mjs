// Draws the Vitals OS app icons from the Vitals symbol (dark teal tile, red pulse line; Vitals Technologies brand
// masters, owner 6 Nov 2026): the phone shell's launcher icons (Android legacy, round and adaptive foreground), the
// iPhone app icon and launch images, the desktop icon source (apps/desktop/icons-source/vitals-os-1024.png, turned
// into every desktop size by `tauri icon`) and the web app's install icons (apps/web/public/icons/vitals-os-*.png,
// used by the PWA manifest and Add to Home Screen on iPhone). Headless Chromium; run from the repository root:
//   node apps/mobile/scripts/make-assets.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const repo = resolve(app, '../..');
const require = createRequire(resolve(here, '../../../tests/e2e/package.json'));
const { chromium } = require('@playwright/test');

export const VITALS = { tile: '#0E2A2F', line: '#D63F3A', light: '#EEF2F1' };
const LINE = 'M100 220H172L242 388L316 116L356 220H412';
// The full symbol on a 512 grid; `radius` 116 is the brand's rounded tile, 0 a full-bleed square (iOS masks it itself).
const tile = (size, radius = 116) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" style="display:block"><rect width="512" height="512" rx="${radius}" fill="${VITALS.tile}"/><path d="${LINE}" fill="none" stroke="${VITALS.line}" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Maskable / adaptive: the line alone, scaled into the central safe zone so a circle or squircle mask never clips it.
const line = (size, scale = 0.62, bg = 'none') => {
  const pad = (512 * (1 - scale)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" style="display:block"><rect width="512" height="512" fill="${bg}"/><g transform="translate(${pad} ${pad}) scale(${scale})"><path d="${LINE}" fill="none" stroke="${VITALS.line}" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
};

const res = resolve(app, 'android/app/src/main/res');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const shots = [];
for (const [d, k] of Object.entries(densities)) {
  const legacy = Math.round(48 * k), fg = Math.round(108 * k);
  shots.push([`${res}/mipmap-${d}/ic_launcher.png`, legacy, tile(legacy)]);
  shots.push([`${res}/mipmap-${d}/ic_launcher_round.png`, legacy, `<div style="width:${legacy}px;height:${legacy}px;border-radius:50%;overflow:hidden">${line(legacy, 0.7, VITALS.tile)}</div>`]);
  // Adaptive foreground: the background is @color/ic_launcher_background (the Vitals tile colour); 66 of 108 dp show.
  shots.push([`${res}/mipmap-${d}/ic_launcher_foreground.png`, fg, line(fg, 0.5)]);
}
shots.push([resolve(app, 'assets/icon.png'), 1024, tile(1024, 0), true]);
shots.push([resolve(app, 'assets/adaptive-icon.png'), 1024, line(1024, 0.5)]);
const ios = resolve(app, 'ios/App/App/Assets.xcassets');
shots.push([`${ios}/AppIcon.appiconset/AppIcon-512@2x.png`, 1024, tile(1024, 0), true]);
for (const theme of ['light', 'dark']) {
  const bg = theme === 'light' ? VITALS.light : VITALS.tile;
  const html = `<div style="width:2732px;height:2732px;display:grid;place-items:center;background:${bg}">${tile(360)}</div>`;
  for (const name of theme === 'light' ? ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'] : ['splash-dark-2732x2732.png', 'splash-dark-2732x2732-1.png', 'splash-dark-2732x2732-2.png'])
    shots.push([`${ios}/Splash.imageset/${name}`, 2732, html, true]);
}
// Desktop (tauri icon makes .ico/.icns and every PNG size from this) and the web install icons.
shots.push([resolve(repo, 'apps/desktop/icons-source/vitals-os-1024.png'), 1024, tile(1024)]);
const web = resolve(repo, 'apps/web/public/icons');
shots.push([`${web}/vitals-os-192.png`, 192, tile(192)]);
shots.push([`${web}/vitals-os-512.png`, 512, tile(512)]);
shots.push([`${web}/vitals-os-maskable-512.png`, 512, line(512, 0.6, VITALS.tile), true]);
shots.push([`${web}/vitals-os-apple-180.png`, 180, tile(180, 0), true]);
// Add to Home Screen on iPhone: the touch icon, and a launch image per iPhone screen (layout.tsx names the same sizes).
shots.push([resolve(repo, 'apps/web/app/apple-icon.png'), 180, tile(180, 0), true]);
for (const [w, h, r] of [[430, 932, 3], [393, 852, 3], [390, 844, 3], [428, 926, 3], [375, 812, 3], [414, 896, 2], [375, 667, 2], [440, 956, 3], [402, 874, 3]]) {
  const W = w * r, H = h * r;
  shots.push([resolve(repo, `apps/web/public/splash/vitals-os-${W}x${H}.png`), [W, H], `<div style="width:${W}px;height:${H}px;display:grid;place-items:center;background:${VITALS.light}">${tile(Math.round(W * 0.28))}</div>`, true]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [file, size, html, opaque] of shots) {
    const [width, height] = Array.isArray(size) ? size : [size, size];
    await page.setViewportSize({ width, height });
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
