// Writes Pulse's master SVGs (packages/design-system/brand/) and the web app's icons from src/brand.js and Pip,
// rasterised with headless Chromium. Run from the repository root: node packages/design-system/scripts/make-brand.mjs
// The native icon sets come from their own scripts, which read the same masters:
//   apps/desktop/scripts/make-icons.mjs, apps/chrome-extension/scripts/make-icons.mjs, apps/mobile/scripts/make-assets.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, appIconSvg, lockupSvg, markGlyph, markSvg, wordmarkSvg } from '../src/brand.js';
import { pipStaticSvg } from '../../companion/src/pip.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(root, 'tests/e2e/package.json'));
const { chromium } = require('@playwright/test');
const doc = (svg) => `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;
const glyph = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">${markGlyph(color)}</svg>`;

const masters = {
  'pulse-mark.svg': markSvg({ size: 512 }),
  'pulse-mark-iris.svg': glyph(BRAND.iris),
  'pulse-mark-ink.svg': glyph(BRAND.ink),
  'pulse-mark-white.svg': glyph(BRAND.paper),
  'pulse-wordmark-ink.svg': wordmarkSvg({ height: 60 }),
  'pulse-wordmark-white.svg': wordmarkSvg({ height: 60, color: BRAND.paper }),
  'pulse-lockup-light.svg': lockupSvg({ height: 96 }),
  'pulse-lockup-dark.svg': lockupSvg({ height: 96, theme: 'dark' }),
  'pulse-app-icon.svg': appIconSvg({ size: 1024 }),
  'pulse-app-icon-mac.svg': appIconSvg({ size: 1024, platform: 'mac' }),
  'pulse-app-icon-square.svg': appIconSvg({ size: 1024, platform: 'ios' }),
  'pip-light.svg': pipStaticSvg({ mood: 'idle', size: 240 }),
  'pip-dark.svg': pipStaticSvg({ mood: 'idle', size: 240, theme: 'dark' }),
};
const brand = resolve(root, 'packages/design-system/brand');
await mkdir(brand, { recursive: true });
for (const [name, svg] of Object.entries(masters)) await writeFile(resolve(brand, name), doc(svg));

// Web: the SVG favicon, a 16/32/48 .ico for older browsers, the iPhone home-screen icon and the manifest's icons.
const web = resolve(root, 'apps/web');
await writeFile(resolve(web, 'app/icon.svg'), markSvg({ size: 32 }) + '\n');
const pngs = [
  ['public/icons/icon-192.png', 192, appIconSvg({ size: 192 })],
  ['public/icons/icon-512.png', 512, appIconSvg({ size: 512 })],
  ['public/icons/maskable-512.png', 512, appIconSvg({ size: 512, platform: 'maskable' })],
  ['app/apple-icon.png', 180, appIconSvg({ size: 180, platform: 'ios' }), true],
  // Android shows a browser ping's badge in the status bar: white on transparent, like the phone app's own icon.
  ['public/icons/badge-96.png', 96, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 3 24 26" width="96" height="96">${markGlyph(BRAND.paper)}</svg>`],
];
const ico = [16, 32, 48];
const browser = await chromium.launch();
const icoImages = [];
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const shot = async (svg, size, opaque) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    return page.screenshot({ omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
  };
  for (const [file, size, svg, opaque] of pngs) {
    await mkdir(dirname(resolve(web, file)), { recursive: true });
    await writeFile(resolve(web, file), await shot(svg, size, opaque));
  }
  for (const size of ico) icoImages.push(await shot(markSvg({ size, radius: size === 16 ? 7 : 9, id: `ico${size}` }), size));
} finally { await browser.close(); }
// An .ico of PNG images (Vista+ format): 6-byte header, one 16-byte entry per image, then the images.
const header = Buffer.alloc(6 + 16 * icoImages.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoImages.length, 4);
let offset = header.length;
icoImages.forEach((png, i) => {
  const at = 6 + 16 * i, size = ico[i];
  header.writeUInt8(size, at); header.writeUInt8(size, at + 1); header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += png.length;
});
await writeFile(resolve(web, 'app/favicon.ico'), Buffer.concat([header, ...icoImages]));
console.log(`${Object.keys(masters).length} masters and ${pngs.length + 2} web icons written`);
