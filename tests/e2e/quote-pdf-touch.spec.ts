import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Browser } from "@playwright/test";

// PULSE-BUGS-2 (Willow Lane #10, Akabod 18 Nov 2026: "Can't scroll through quotation", Android Chrome 157, 411 px): on a
// phone the quotation's PDF opens in a sheet (Preview → the Drawer, snap full, bare). Its pages sit in .pdfWrap, a box
// with overflow-y: auto that is as tall as the pages, so it has nothing to scroll; with overscroll-behavior: contain,
// Chrome since OverscrollBehaviorRespectedOnAllScrollContainers keeps a finger's scroll in that box anyway, so a drag on
// the PDF moved nothing and page 2 could not be reached. Here the real stylesheets (the kit's Drawer, the documents'
// bare preview, the ERP's PDF pages) on the same markup the app renders, in Chromium with that behaviour on and off:
// a finger dragged up on page 1 scrolls the sheet down to page 2. No app server or data needed.
const APP = resolve(__dirname, "../../apps/web/app");
const sheet = (file: string) => readFileSync(resolve(APP, file), "utf8").replace(/:global\(([^)]*)\)/g, "$1");
const CSS = [sheet("kit/drawer.module.css"), sheet("erp/documents/documents.module.css"), sheet("erp/erp.module.css")].join("\n");
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}
  html, body { margin: 0; } .pdfPage { width: 100%; height: 560px; }</style></head><body>
  <main style="height: 2000px">The issued quotation behind the sheet</main>
  <div class="backdrop"><div class="drawer" role="dialog" aria-modal="true" aria-label="Quotation QT/26-27/0002" data-snap="full" data-bare="">
    <header class="head"><span class="grip"></span><div class="headMain"><h2 class="title"><span>Quotation QT/26-27/0002</span></h2></div></header>
    <div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="true">Filed copy</button><button class="tab" role="tab">Activity</button></div>
    <div class="body" role="tabpanel"><section class="previewBare" aria-label="Filed copy"><div class="pdfWrap"><div class="pdfPages">
      <canvas class="pdfPage" data-pdf-page="1"></canvas><canvas class="pdfPage" data-pdf-page="2"></canvas></div></div></section></div>
    <footer style="flex: none; height: 76px">Send (e-mail + WhatsApp)</footer>
  </div></div></body></html>`;

async function dragOnThePdf(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 411, height: 869 }, deviceScaleFactor: 2.63, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.setContent(PAGE);
  const first = page.locator('[data-pdf-page="1"]'), second = page.locator('[data-pdf-page="2"]');
  await expect(first).toBeVisible();
  const box = (await first.boundingBox())!;
  const x = Math.round(box.x + box.width / 2), from = Math.round(Math.min(box.y + box.height - 20, 700));
  expect(from - 300, "the finger starts on page 1").toBeGreaterThan(box.y);
  const before = (await second.boundingBox())!.y;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
  for (let y = from - 20; y >= from - 400; y -= 20) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
  const moved = before - (await second.boundingBox())!.y;
  await context.close();
  return moved;
}

for (const newer of [true, false]) {
  test(`a finger on a phone's quotation PDF scrolls the sheet to page 2 (Chrome ${newer ? "with" : "without"} overscroll-behavior on every scroll box)`, async ({ playwright }) => {
    const feature = "OverscrollBehaviorRespectedOnAllScrollContainers";
    const browser = await playwright.chromium.launch({ headless: true, args: newer ? [`--enable-features=${feature}`, `--enable-blink-features=${feature}`] : [`--disable-features=${feature}`] });
    try {
      expect(await dragOnThePdf(browser), "page 2 came up").toBeGreaterThan(200);
    } finally { await browser.close(); }
  });
}
