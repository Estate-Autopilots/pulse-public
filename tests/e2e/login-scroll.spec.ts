import { expect, test } from "@playwright/test";

// BUGFIX #16 (Catitokag, 28 Oct 2026: "open the login page and try to scroll"; the workaround was zooming out). At 900 px
// and up the shell locks html and body (signed-in pages scroll inside the shell's panel), and the sign-in page has no
// such panel: on a short, wide window (a laptop with display scaling, a phone in "desktop site") the bottom of the form
// was out of reach. The page must scroll by the wheel (programmatic scrollIntoView works even under overflow: hidden,
// so this test scrolls the way a person does) until the last control is on screen.
test("sign-in scrolls on a short window at desktop width, down to its last control", async ({ browser }) => {
  for (const [width, height] of [[1280, 400], [960, 360]] as const) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    try {
      await page.goto("/login");
      const main = page.locator("#main-content");
      await expect(main.getByRole("heading").first()).toBeVisible();
      const last = main.locator("a[href], button, input, select, textarea").last();
      // The form is taller than this window: its last control starts below the fold.
      await expect(last, `the form fits ${width}x${height}; pick a shorter window`).not.toBeInViewport();
      await page.mouse.move(width * 0.75, height / 2);
      for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 400);
      await expect(last, `the wheel scrolls the sign-in page at ${width}x${height}`).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    } finally {
      await context.close();
    }
  }
});
