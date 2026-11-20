import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// QUOTE-BUILDER (owner, 19-20 Nov 2026; board 5, option C "Quote + AI assistant"): the composer shows each line's base
// against your price, the extra charges (one settled at the end is an estimate, out of the total), the seller-only
// comparison, and the AI's change card that changes nothing until Apply; an invoice asks for its estimates to be
// confirmed; and (Willow Lane bug #10) an approved two-page quotation's Preview scrolls to its second page on a phone.
// Synthetic API only (tests/e2e/fixtures/quote-builder.mjs, admin@quote-builder.example). Screenshots go to
// PULSE_SCREENSHOT_DIR when it is set.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "Synthetic API only");

const WHO = { "Cf-Access-Authenticated-User-Email": "admin@quote-builder.example" };
const QUOTE = "/erp/documents/synthetic-builder", INVOICE = "/erp/documents/synthetic-builder-invoice", ISSUED = "/erp/documents/synthetic-builder-issued";
const SIZES = [{ width: 363, height: 800, phone: true }, { width: 1280, height: 900, phone: false }] as const;
type Size = (typeof SIZES)[number] | { width: number; height: number; phone: boolean };

async function open(browser: Browser, size: Size, theme: "light" | "dark") {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, extraHTTPHeaders: WHO, colorScheme: theme, reducedMotion: "reduce",
    ...(size.phone ? { hasTouch: true, isMobile: true } : {}) });
  await context.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
  const page = await context.newPage();
  await expect(await page.request.post("/api/v0/erp/test-reset", { headers: { Origin: process.env.PLAYWRIGHT_TEST_BASE_URL! } })).toBeOK();
  return { context, page };
}
/** The screen as a person sees it, then scrolled a screen at a time (name-1, name-2 …), up to four. */
async function shoot(page: Page, name: string, scrolled = true) {
  const dir = process.env.PULSE_SCREENSHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  // Judge r7: the pointer left where Apply was hovered the row that moved under it ("looks pressed", "looks selected").
  await page.mouse.move(1, 1);
  if (!scrolled) { await page.screenshot({ path: join(dir, `${name}.png`) }); return; }
  for (let i = 0; i < 4; i++) {
    const moved = await page.evaluate((n) => {
      // The page's scroller: the nearest scrolling box around the heading (the shell's column on a computer), else the page.
      let box = document.querySelector<HTMLElement>("h1");
      while (box && !(box.scrollHeight > box.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      const el = box ?? (document.scrollingElement as HTMLElement);
      const step = Math.max(200, el.clientHeight - 140), before = el.scrollTop;
      el.scrollTop = n * step;
      return n === 0 || el.scrollTop > before;
    }, i);
    if (!moved) break;
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(dir, `${name}-${i + 1}.png`) });
  }
  await page.evaluate(() => { document.querySelectorAll<HTMLElement>("*").forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }); document.scrollingElement?.scrollTo(0, 0); });
  // On a computer the shell's column scrolls inside a fixed frame: one tall window shows the whole composer too.
  const size = page.viewportSize()!;
  if (size.width >= 900) {
    await page.setViewportSize({ width: size.width, height: 2200 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(dir, `${name}-full.png`) });
    await page.setViewportSize(size);
  }
}
/** On a computer the customer's copy is drawn beside the composer: wait for its first page. */
const drawn = async (page: Page, size: Size) => { if (!size.phone) await expect(page.locator('[data-drawn="1"] canvas[data-pdf-page="1"]').first()).toBeVisible({ timeout: 20_000 }); };
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

for (const theme of ["light", "dark"] as const) for (const size of SIZES) {
  const at = `${size.width}-${theme}`;
  test(`the quotation shows your price, the charges and the AI's card; Apply changes it (${at})`, async ({ browser }) => {
    const { context, page } = await open(browser, size, theme);
    await page.goto(QUOTE);
    const card = page.getByRole("region", { name: "Change proposal" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(card.getByText("Hybrid inverter 5 kVA: ₹1,10,000 → ₹1,04,500 (−5%)")).toBeVisible();
    await expect(card.getByText("₹7,46,940")).toBeVisible();
    // Your price against the base, with its reason; extra charges in their own card; the seller-only comparison.
    await expect(page.getByText("₹3,65,000 · base ₹3,85,000 · “Festive offer”", { exact: false }).first()).toBeVisible();
    await expect(page.getByTitle("Your price against the base").first()).toHaveText("−5.2%");
    const charges = page.getByRole("region", { name: "Extra charges" }).or(page.locator('[aria-label="Extra charges"]')).first();
    await expect(charges.getByText("Installation", { exact: true })).toBeVisible();
    await expect(page.getByText("Only you see this", { exact: true })).toBeVisible();
    expect(await noSideways(page), "nothing runs off the right edge").toBe(true);
    await drawn(page, size);
    await shoot(page, `quote-${at}-before`);

    await card.getByRole("button", { name: "Apply changes" }).click();
    await expect(page.getByRole("region", { name: "Change proposal" })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("Transport to Hinjewadi", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Estimate, settled at the end/).first()).toBeVisible();
    await expect(page.getByText("To be confirmed", { exact: true }).first()).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    await page.waitForTimeout(3500);   // the "Changes applied" toast lives 3 s
    await drawn(page, size);
    await shoot(page, `quote-${at}-after`);
    await context.close();
  });

  test(`an invoice asks for its estimate to be confirmed first (${at})`, async ({ browser }) => {
    const { context, page } = await open(browser, size, theme);
    await page.goto(INVOICE);
    await expect(page.getByRole("button", { name: "Confirm the charges" }).first()).toBeVisible({ timeout: 30_000 });
    expect(await noSideways(page)).toBe(true);
    await drawn(page, size);
    await shoot(page, `invoice-${at}`);
    // The sheet confirms it: then the main step is no longer about the charges.
    await page.getByRole("button", { name: "Confirm the charges" }).first().click();
    await page.getByRole("button", { name: "Confirm the final amount" }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirm the charges" })).toHaveCount(0);
    await context.close();
  });
}

// QUOTE-BUILDER-4 (Kazuk's 19 Nov test, VTI task 1514f831): seats sold per user per month show two numbers (users and
// months), the prepaid discount follows the months, a package part's changes say "+1 user", "+2 months" (never "price
// changed"), and an old draft item is never offered.
const PHASED = "/erp/documents/synthetic-builder-phased";
for (const theme of ["light", "dark"] as const) for (const size of SIZES) {
  const at = `${size.width}-${theme}`;
  test(`users × months on a package part; the prepaid discount follows the months; no draft offered (${at})`, async ({ browser }) => {
    const { context, page } = await open(browser, size, theme);
    await page.goto(PHASED);
    const seats = "Sample CRM seats (pro)";
    await expect(page.getByRole("group", { name: `Quantity of ${seats}: 5 users × 4 months` })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/₹1,199 a user a month · 5%\s+off for 4\s+months paid ahead/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Sample brand film \(old draft\)/ })).toHaveCount(0);
    expect(await noSideways(page), "nothing runs off the right edge").toBe(true);
    await drawn(page, size);
    await shoot(page, `phased-${at}-before`);
    await page.getByRole("button", { name: `More: Users of ${seats}` }).click();
    for (let i = 0; i < 2; i++) await page.getByRole("button", { name: `More: Months of ${seats}` }).click();
    await expect(page.getByRole("group", { name: `Quantity of ${seats}: 6 users × 6 months` })).toBeVisible();
    await expect(page.getByText(/₹1,199 a user a month · 10%\s+off for 6\s+months paid ahead/).first()).toBeVisible();
    const marks = page.locator("span", { hasText: /^\+1 user$/ });
    await expect(marks.first()).toBeVisible();
    await expect(page.getByText("+2 months", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("price changed", { exact: true })).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    await drawn(page, size);
    await shoot(page, `phased-${at}-after`);
    // The changed line as the seller looks at it: in the middle of the screen.
    await page.getByRole("group", { name: `Quantity of ${seats}: 6 users × 6 months` }).evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await shoot(page, `phased-${at}-row`, false);
    await context.close();
  });
}

// Willow Lane bug #10 (Android, 411 px): "Can't scroll through quotation". The approved quotation's Preview (a bottom sheet
// on a phone) scrolls with a finger down to the PDF's second page.
for (const size of [{ width: 412, height: 915, phone: true }, { width: 363, height: 800, phone: true }]) {
  test(`an approved two-page quotation's Preview scrolls to page 2 on a phone (${size.width})`, async ({ browser }) => {
    const { context, page } = await open(browser, size, "light");
    await page.goto(ISSUED);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const sheet = page.getByRole("dialog");
    const second = sheet.locator('canvas[data-pdf-page="2"]');
    await expect(second).toBeAttached({ timeout: 30_000 });
    const top = () => second.evaluate((e) => e.getBoundingClientRect().top);
    const before = await top();
    expect(before, "page 2 starts below the screen").toBeGreaterThan(size.height * 0.5);
    const cdp = await context.newCDPSession(page);
    const x = Math.round(size.width / 2);
    for (let swipe = 0; swipe < 4; swipe++) {
      const y0 = Math.round(size.height * 0.8);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      for (let y = y0 - 25; y >= Math.round(size.height * 0.25); y -= 25) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(250);
    }
    await cdp.detach();
    const after = await top();
    await shoot(page, `wl10-preview-${size.width}`, false);
    expect(before - after, "the finger moved the PDF up").toBeGreaterThan(400);
    expect(after, "page 2 is on the screen").toBeLessThan(size.height);
    await context.close();
  });
}
