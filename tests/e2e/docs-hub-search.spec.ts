import { expect, test, type Browser } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// DOCS-HUB (owner, 21 Nov 2026: "I can't find specific documents"): Billing → Documents searches every document on the
// server, says what it understood, offers the closest names when nothing matches every word, and says where a row was
// found. Synthetic API only (tests/e2e/fixtures/docs-hub.mjs, admin@docs-hub.example). Phone (390) and tablet (1024),
// light and dark; screenshots go to PULSE_SCREENSHOT_DIR when it is set.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "Synthetic API only");

const WHO = { "Cf-Access-Authenticated-User-Email": "admin@docs-hub.example" };
const SIZES = [{ width: 390, height: 844, phone: true }, { width: 1024, height: 768, phone: false }] as const;

async function open(browser: Browser, size: (typeof SIZES)[number], theme: "light" | "dark") {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, extraHTTPHeaders: WHO, colorScheme: theme, reducedMotion: "reduce",
    ...(size.phone ? { hasTouch: true, isMobile: true } : {}) });
  await context.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
  const page = await context.newPage();
  await page.goto("/erp/documents");
  await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
  return { context, page };
}

for (const size of SIZES) for (const theme of ["light", "dark"] as const) {
  test(`one search finds documents from plain words (${size.width}-${theme})`, async ({ browser }) => {
    const { context, page } = await open(browser, size, theme);
    const dir = process.env.PULSE_SCREENSHOT_DIR;
    const shot = async (name: string) => {
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      await page.mouse.move(1, 1);
      await page.screenshot({ path: join(dir, `docs-search-${size.width}-${theme}-${name}.png`) });
    };
    const box = page.getByRole("searchbox", { name: "Search documents" });
    await shot("before");

    // The owner's own ask: one invoice, and what was understood said back.
    await box.fill("last month's invoices for Willow Lane over 1 lakh");
    const said = page.getByRole("status").filter({ hasText: "Looking for" });
    for (const term of ["Invoices", "Last month: 1–31 Oct 2026", "Over ₹1 lakh", "Matching “willow lane”"]) await expect(said.getByText(term, { exact: true })).toBeVisible();
    const rows = page.getByRole("list", { name: "Documents" }).getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("INV/26-27/0141");
    await shot("ask");

    // A slip of the keyboard: the closest names, said as such.
    await box.fill("wise lyfe");
    await expect(page.getByRole("status").filter({ hasText: "No exact match for “wise lyfe”. These are the closest names:" })).toBeVisible();
    await expect(rows).toHaveCount(4);
    await expect(rows.first().getByText("Close to “Willow Lane Solar (sample)”", { exact: true })).toBeVisible();
    await shot("closer");

    // An item inside a quotation: the row says which.
    await box.fill("purepower");
    await expect(rows).toHaveCount(1);
    // On a line of its own, so a phone shows it whole.
    await expect(rows.first().getByText("Item: PurePower 5.0 kW solar system", { exact: true })).toBeVisible();
    await shot("item");

    // No sideways scroll at either size.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await context.close();
  });
}
