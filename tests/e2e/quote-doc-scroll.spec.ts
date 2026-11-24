import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

// QUOTE-SCROLL (owner, 17 Nov 2026: "when scrolling documents or quotations, it's not being scrolled … the work is
// slowing"). A long quotation (40 lines) and a long doc (60 sections) scroll with the mouse wheel on a laptop and with a
// finger on a phone, also after a dialog or the phone's "Customer's copy" sheet opened and closed, and inside the chat's
// side panel (the page framed with embed=1), however wide the panel is dragged. Synthetic data only: the quotation is
// billing-review.mjs's synthetic-review (admin@billing-one.example), the doc mock-editors-api.mjs's synthetic-long-doc.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "Synthetic API only");

const ADMIN = { "Cf-Access-Authenticated-User-Email": "admin@billing-one.example" };
const QUOTE = "/erp/documents/synthetic-review";
const DOC = "/docs/synthetic-long-doc";
const SIZES = [{ width: 360, height: 780, phone: true }, { width: 412, height: 915, phone: true }, { width: 1280, height: 800, phone: false }] as const;

async function open(browser: Browser, size: { width: number; height: number; phone?: boolean }) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, extraHTTPHeaders: ADMIN, reducedMotion: "reduce",
    ...(size.phone ? { hasTouch: true, isMobile: true } : {}) });
  return { context, page: await context.newPage() };
}
async function longQuote(page: Page) {
  const origin = process.env.PLAYWRIGHT_TEST_BASE_URL!;
  await expect(await page.request.post("/api/v0/erp/test-reset", { headers: { Origin: origin } })).toBeOK();
  const lines = Array.from({ length: 40 }, (_, i) => ({ itemId: null, description: `Synthetic scroll line ${i + 1}`, details: "", sac: null, unit: "nos", qty: 1, rate: 1000 + i,
    discount: 0, discountPercent: null, gstRate: 18 }));
  await expect(await page.request.post(`/api/v0${QUOTE}`, { headers: { Origin: origin }, data: { lines } })).toBeOK();
}
const top = (l: Locator) => l.evaluate((e) => e.getBoundingClientRect().top);
/** Scrolls the way a person does (the wheel over the middle of the window, or a finger dragging up from the middle) and
 *  returns how far the marker moved up. */
async function scrollBy(page: Page, context: BrowserContext, marker: Locator, phone: boolean) {
  const before = await top(marker);
  const { width, height } = page.viewportSize()!;
  const x = Math.round(width / 2);
  if (phone) {
    const cdp = await context.newCDPSession(page);
    const y0 = Math.round(height * 0.6);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
    for (let y = y0 - 20; y >= 120; y -= 20) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(x, Math.round(height * 0.55));
    await page.mouse.wheel(0, 600);
  }
  await page.waitForTimeout(400);
  return before - (await top(marker));
}
const unlocked = (page: Page) => page.evaluate(() => !("scrollLocked" in document.documentElement.dataset) && document.documentElement.style.overflow !== "hidden");
/** Back to the top of whatever scrolls the marker: the document on a phone; on a computer the page kit's own page
 *  (ui.module.css .page scrolls inside the shell's main at 900 px and up), which #main-content and the document are not.
 *  CI-RED-FIX-2: resetting only those two left the quotation 509 px down at 1280×800 after "Delete this draft?". */
const toTop = (marker: Locator) => marker.evaluate((e) => {
  for (let el = e.parentElement; el; el = el.parentElement) el.scrollTop = 0;
  document.scrollingElement!.scrollTop = 0;
});

for (const size of SIZES) {
  const at = `${size.width}×${size.height}`;
  test(`a long quotation scrolls at ${at}, also after a dialog closes`, async ({ browser }) => {
    const { context, page } = await open(browser, size);
    await longQuote(page);
    await page.goto(QUOTE);
    const head = page.getByRole("heading", { name: "New quotation", exact: true });
    await expect(head).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => unlocked(page), { message: "nothing holds the page still on load" }).toBe(true);
    expect(await scrollBy(page, context, head, size.phone), "the quotation moved").toBeGreaterThan(200);
    await toTop(head);
    if (size.phone) {
      // The "Customer's copy" sheet rises (it holds the page still while it covers it) and goes back down to its bar.
      const sheet = page.getByRole("dialog", { name: "Customer's copy" });
      await sheet.locator("header").first().click({ position: { x: 30, y: 8 } });
      await expect(sheet).toHaveAttribute("aria-modal", "true");
      await page.keyboard.press("Escape");
      await expect(sheet).not.toHaveAttribute("aria-modal", "true");
    } else {
      // "Delete this draft?" opens and is cancelled.
      await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Delete draft", exact: true }).click();
      const ask = page.getByRole("alertdialog", { name: "Delete this draft?" });
      await expect(ask).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(ask).toBeHidden();
    }
    await expect.poll(() => unlocked(page), { message: "no scroll lock is left behind" }).toBe(true);
    // Opening More actions scrolled the page down to it: from the top again, the wheel or a finger still moves it.
    await toTop(head);
    await expect.poll(() => top(head)).toBeGreaterThan(0);
    expect(await scrollBy(page, context, head, size.phone), "the quotation moved after the dialog").toBeGreaterThan(200);
    await context.close();
  });

  test(`a long doc scrolls at ${at}`, async ({ browser }) => {
    const { context, page } = await open(browser, size);
    await page.goto(DOC);
    const first = page.getByRole("heading", { name: "Synthetic section 1", exact: true });
    await expect(first).toBeVisible({ timeout: 30_000 });
    expect(await scrollBy(page, context, first, size.phone), "the doc moved").toBeGreaterThan(200);
    await context.close();
  });
}

// The chat's side panel frames the page with embed=1 and no shell: the document itself is what scrolls, in a narrow
// panel and after the panel is dragged 900 px or wider (where the desktop shell's "the document never scrolls" rule began).
for (const width of [520, 1000]) {
  test(`in the chat's side panel (${width} px wide) a long quotation and a long doc scroll`, async ({ browser }) => {
    const { context, page } = await open(browser, { width, height: 800 });
    await longQuote(page);
    await page.goto(`${QUOTE}?embed=1`);
    const head = page.getByRole("heading", { name: "New quotation", exact: true });
    await expect(head).toBeVisible({ timeout: 30_000 });
    expect(await scrollBy(page, context, head, false), "the quotation in the panel moved").toBeGreaterThan(200);
    await page.goto(`${DOC}?embed=1`);
    const first = page.getByRole("heading", { name: "Synthetic section 1", exact: true });
    await expect(first).toBeVisible({ timeout: 30_000 });
    expect(await scrollBy(page, context, first, false), "the doc in the panel moved").toBeGreaterThan(200);
    await context.close();
  });
}
