import { expect, test, type Page } from "@playwright/test";

// TASKS-4A: the shared controls (/kit) on a production build: keyboard, screen-reader roles, phones and reduced motion.
const open = async (page: Page, width = 1440) => {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  await page.goto("/kit");
  // Owner workbench (21 Oct 2026): /kit opens on the AC design system; the controls kit follows it on the same page.
  await expect(page.getByRole("heading", { name: "AC design system" })).toBeVisible();
  // The server-rendered heading precedes hydration; theme controls need their client handlers.
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
};

test("AC theme controls restyle the primitives and component tabs select", async ({ page }) => {
  await open(page);
  const theme = page.getByRole("region", { name: "Theme", exact: true });
  await theme.getByLabel(/^Accent/).fill("#d64578");
  await expect(page.getByRole("region", { name: "Buttons", exact: true }).getByRole("button", { name: "New task", exact: true }))
    .toHaveCSS("background-color", "rgb(214, 69, 120)");
  await theme.getByRole("slider", { name: /^Roundness/ }).focus();
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--ds-roundness"))).toBe("0.3");
  await theme.getByRole("slider", { name: /^Density/ }).focus();
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--ds-density"))).toBe("0.86");
  const tabs = page.getByRole("navigation", { name: "Sections", exact: true });
  await tabs.getByRole("button", { name: "Time", exact: true }).click();
  await expect(tabs.getByRole("button", { name: "Time", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("button", { name: "Today", exact: true })).toHaveAttribute("aria-selected", "false");
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`AC catalogue ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((value) => localStorage.setItem("pulse.theme", value), theme);
      await open(page, width);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: "Tier 1 · Primitives" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Tier 2 · Components" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const path = testInfo.outputPath(`ac-kit-${theme}-${width}.png`);
      await page.screenshot({ path, fullPage: true, animations: "disabled" });
      await testInfo.attach(`AC kit ${theme} ${width}px`, { path, contentType: "image/png" });
    });
  }
}

test("segmented control: one tab stop, arrows move and choose", async ({ page }) => {
  await open(page);
  const group = page.getByRole("radiogroup", { name: "View", exact: true });
  await group.getByRole("radio", { name: "List" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(group.getByRole("radio", { name: "Board" })).toHaveAttribute("aria-checked", "true");
  await expect(group.getByRole("radio", { name: "Board" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(group.getByRole("radio", { name: "Table" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Chosen: table")).toBeVisible();
});

test("select and combobox open downward, choose with the keyboard and give focus back", async ({ page }) => {
  await open(page);
  const status = page.getByRole("button", { name: /^Status:/ });
  await status.focus(); await page.keyboard.press("Enter");
  const list = page.getByRole("listbox", { name: "Status" });
  await expect(list).toBeVisible();
  const [t, l] = [await status.boundingBox(), await list.boundingBox()];
  expect(l!.y).toBeGreaterThan(t!.y + t!.height - 1);
  await expect(list).toBeFocused();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(status).toHaveAccessibleName("Status: Blocked");
  await expect(status).toBeFocused();
  // A person, by typing on the closed button.
  const who = page.getByRole("button", { name: /^Who does it:/ });
  await who.focus(); await page.keyboard.type("vik");
  await expect(page.getByRole("combobox", { name: "Who does it" })).toHaveValue("vik");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(who).toHaveAccessibleName("Who does it: Vikram Seduh");
  // Enter opens the list again; Escape closes it once its search box has the focus.
  await page.keyboard.press("Enter"); await expect(page.getByRole("combobox", { name: "Who does it" })).toBeFocused(); await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(who).toBeFocused();
});

test("date picker: a calendar grid driven by the keyboard", async ({ page }) => {
  await open(page);
  const due = page.getByRole("button", { name: /^Due:/ });
  await due.click();
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  const today = page.locator('[role="grid"] button[aria-current="date"]');
  await expect(today).toBeFocused();
  // Focus follows each key after the picker re-renders: wait for it to move before reading where it is.
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  const start = await focused();
  await page.keyboard.press("ArrowDown"); await expect.poll(focused).not.toBe(start);
  const week = await focused();
  await page.keyboard.press("ArrowRight"); await expect.poll(focused).not.toBe(week);
  const target = await focused();
  await page.keyboard.press("Enter");
  await expect(grid).toHaveCount(0);
  expect(target).toMatch(/^\w+day \d+ \w+ 20\d\d$/);
  await expect(due).toHaveAccessibleName(`Due: ${target}`);
  // Quick choices.
  await due.click(); await page.getByRole("button", { name: /^Tomorrow/ }).click();
  await expect(due).toContainText("Tomorrow");
});

test("mention input: @ lists people at once, a chosen one becomes a chip, Backspace removes it whole", async ({ page }) => {
  await open(page);
  const box = page.getByRole("textbox", { name: "What needs doing" });
  await box.click(); await box.pressSequentially("Ask @");
  await expect(page.getByRole("listbox", { name: "People" }).getByRole("option")).toHaveCount(6);
  await box.pressSequentially("ro");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(box.locator("[data-mention-id]")).toHaveText(/Rovan Iyer/);
  await box.pressSequentially("for the cut");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Sent: Ask @Rovan Iyer for the cut/)).toBeVisible();
  await box.pressSequentially("Ping @vi");
  await page.keyboard.press("Enter");
  await expect(box.locator("[data-mention-id]")).toHaveCount(1);
  await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
  await expect(box.locator("[data-mention-id]")).toHaveCount(0);
});

test("menu, tooltip, help hint and rating", async ({ page }) => {
  await open(page);
  const more = page.getByRole("button", { name: "More actions" });
  await more.focus(); await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu", { name: "Task actions" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Edit/ })).toBeFocused();
  await page.keyboard.press("d");
  await expect(page.getByRole("menuitem", { name: /Delete/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();
  // The tooltip is the control's description, and shows on keyboard focus.
  const create = page.getByRole("button", { name: "+ New" });
  await expect(create).toHaveAccessibleDescription("Create a task or a project (C)");
  await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  await page.getByRole("button", { name: "What is the pool?" }).click();
  await expect(page.getByText(/the first claim wins/)).toBeVisible();
  const stars = page.getByRole("radiogroup", { name: "Quality" });
  await stars.getByRole("radio", { name: /^4 of 5/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(stars.getByRole("radio", { name: /^5 of 5/ })).toHaveAttribute("aria-checked", "true");
});

test("on a phone: the calendar is a sheet, nothing runs sideways; reduced motion stops the animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, 390);
  await page.getByRole("button", { name: /^Due:/ }).click();
  const sheet = page.locator("[data-sheet]");
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box!.width).toBeGreaterThan(385);
  expect(await sheet.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  for (const b of await page.locator('[role="grid"] button').all()) { const r = await b.boundingBox(); if (r) expect(r.height).toBeGreaterThanOrEqual(38); }
});

test("billing parts: +/− and an open amount gate the next step; the drawer has section tabs and phone snap heights", async ({ page }) => {
  await open(page);
  const card = page.getByRole("region", { name: "Billing parts" });
  await card.getByRole("button", { name: "More: Quantity of PP-15.0L" }).click();
  await expect(card.getByRole("spinbutton", { name: "Quantity of PP-15.0L" })).toHaveValue("2");
  await expect(card.getByRole("button", { name: "Fill 1 amount" })).toBeDisabled();
  await card.getByRole("textbox", { name: "Installation amount" }).fill("12500");
  await expect(card.getByRole("button", { name: "Approve" })).toBeEnabled();
  await card.getByRole("button", { name: "More details" }).or(card.getByText("More details")).first().click();
  await card.getByRole("button", { name: "Add where it lives" }).click();
  await expect(card.getByPlaceholder("Drive folder, ad account")).toBeFocused();
  await card.getByRole("button", { name: "PP-15.0L system" }).click();
  const drawer = page.getByRole("dialog", { name: "PP-15.0L system" });
  await expect(drawer.getByRole("tab", { name: "Line" })).toHaveAttribute("aria-selected", "true");
  await drawer.getByRole("tab", { name: "Line" }).focus(); await page.keyboard.press("ArrowRight");
  await expect(drawer.getByRole("tab", { name: "Terms" })).toBeFocused();
  await expect(drawer.getByText("Delivered to site · valid 15 days")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await open(page, 390);
  await page.getByRole("region", { name: "Billing parts" }).getByRole("button", { name: "PP-15.0L system" }).click();
  await expect(page.getByRole("dialog", { name: "PP-15.0L system" })).toHaveAttribute("data-snap", "half");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
