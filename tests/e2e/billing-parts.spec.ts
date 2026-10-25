import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// EST-1376: exercise the real catalogue drawer and outgoing save body, entirely on synthetic data.
test.use({ extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": "admin@northwind-on.example" }, reducedMotion: "reduce" });
test.skip(!!process.env.PULSE_REAL_SMOKE, "Uses the synthetic mock API, never tenant records");

async function open(page: Page, state: "linked" | "new" | "free" = "linked") {
  const isNew = state === "new";
  const pkgId = state === "free" ? "synthetic-free-package" : "synthetic-package";
  const saves: { parts: { itemId: string | null; quantity: number; label: string }[] }[] = [];
  // Refuse every API write except the one captured and fulfilled inside this browser.
  await page.route("**/api/**", async (route) => {
    if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.continue();
    if (route.request().method() === "POST" && new URL(route.request().url()).pathname === `/api/v0/erp/items/${pkgId}/parts`) {
      saves.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.abort();
  });
  await page.goto("/erp/catalog");
  await expect(page.getByRole("heading", { name: "Catalogue", exact: true })).toBeVisible();
  // The Show control marks itself ready after hydration; SSR-visible rows are not interactive yet.
  await expect(page.getByRole("radiogroup", { name: "Show", exact: true })).toHaveAttribute("data-ready", "");
  // Assert the synthetic sentinel, including its known subtitle, within the package list.
  const packageName = state === "free" ? "Synthetic Free Package" : "Synthetic Package";
  const packages = page.getByRole("list", { name: "Packages", exact: true });
  const packageRow = packages.getByRole("button", { name: new RegExp(`^${packageName}\\s+1 parts · v1$`) });
  await packageRow.click();
  await expect(packageRow).toHaveAttribute("aria-expanded", "true");
  const parts = packages.getByRole("list", { name: `Parts of ${packageName}`, exact: true });
  await expect(parts).toBeVisible();
  if (isNew) await packages.getByRole("button", { name: "Part", exact: true }).click();
  else await parts.getByRole("button", { name: /^Synthetic Design\s+1 × month$/ }).click();
  const drawer = page.getByRole("dialog", { name: isNew ? "New part" : "Synthetic Design", exact: true });
  await expect(drawer).toBeVisible();
  return { drawer, saves };
}

for (const [typed, quantity] of [[0.5, 0.5], [0.125, 0.125], [0.001, 0.001], [1.23456, 1.235]]) {
  test(`a typed quantity of ${typed} saves as ${quantity} with the shared rounding`, async ({ page }) => {
    const { drawer, saves } = await open(page);
    const input = drawer.getByRole("spinbutton", { name: "Quantity", exact: true });
    await input.fill(String(typed));
    await input.press("Tab");
    await expect(input).toHaveValue(String(quantity));
    await drawer.getByRole("button", { name: "Save part", exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].parts[0].quantity).toBe(quantity);
    expect(saves[0].parts[0].itemId).toBe("synthetic-service");
  });
}

test("quantity controls keep minus disabled at 0.5 and plus steps to 1.5", async ({ page }) => {
  const { drawer, saves } = await open(page);
  const input = drawer.getByRole("spinbutton", { name: "Quantity", exact: true });
  const less = drawer.getByRole("button", { name: "Less: Quantity", exact: true });
  await input.fill("0.5");
  await input.press("Tab");
  await expect(less).toBeDisabled();
  await drawer.getByRole("button", { name: "More: Quantity", exact: true }).click();
  await expect(input).toHaveValue("1.5");
  await expect(less).toBeEnabled();
  await less.click();
  await expect(input).toHaveValue("0.5");
  await expect(less).toBeDisabled();
  await drawer.getByRole("button", { name: "Save part", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].parts[0].quantity).toBe(0.5);
});

for (const quantity of [0, -0.5]) {
  test(`quantity ${quantity} shows an error and does not save`, async ({ page }) => {
    const { drawer, saves } = await open(page);
    const input = drawer.getByRole("spinbutton", { name: "Quantity", exact: true });
    await input.fill(String(quantity));
    await input.press("Tab");
    await expect(input).toHaveValue(String(quantity));
    await drawer.getByRole("button", { name: "Save part", exact: true }).click();
    await expect(drawer.getByRole("alert")).toHaveText("Quantity must be greater than zero");
    expect(saves).toHaveLength(0);
    await input.fill("0.5");
    await drawer.getByRole("button", { name: "Save part", exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].parts[0].quantity).toBe(0.5);
  });
}

for (const isNew of [false, true]) {
  test(`explicit unlink is preserved for a same-name ${isNew ? "new suggested" : "existing linked"} part`, async ({ page }) => {
    const { drawer, saves } = await open(page, isNew ? "new" : "linked");
    if (isNew) await drawer.getByRole("textbox", { name: "Name", exact: true }).fill("Synthetic Design");
    const line = drawer.getByText("Catalogue item:", { exact: false });
    await line.getByRole("button", { name: "Change", exact: true }).click();
    const choice = drawer.getByRole("combobox", { name: "Catalogue item", exact: true });
    await expect(choice).toHaveValue("synthetic-service");
    await choice.selectOption("");
    await expect(drawer.getByText("Not in the catalogue (a free part)", { exact: false })).toBeVisible();
    await expect(drawer.getByText("same as the part", { exact: true })).toHaveCount(0);
    await drawer.getByRole("button", { name: isNew ? "Add part" : "Save part", exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].parts.at(-1)).toMatchObject({ itemId: null, label: "Synthetic Design" });
  });
}

test("an untouched new part automatically matches the catalogue by name", async ({ page }) => {
  const { drawer, saves } = await open(page, "new");
  await drawer.getByRole("textbox", { name: "Name", exact: true }).fill(" synthetic design ");
  await drawer.getByRole("button", { name: "Add part", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].parts.at(-1)).toMatchObject({ itemId: "synthetic-service", label: "synthetic design", quantity: 1 });
});

test("an existing same-name free part keeps its label, empty choice and null link when only quantity changes", async ({ page }) => {
  const { drawer, saves } = await open(page, "free");
  const free = drawer.getByText("Not in the catalogue (a free part)", { exact: false });
  await expect(free).toBeVisible();
  await expect(drawer.getByText("same as the part", { exact: true })).toHaveCount(0);
  await free.getByRole("button", { name: "Change", exact: true }).click();
  await expect(drawer.getByRole("combobox", { name: "Catalogue item", exact: true })).toHaveValue("");
  await drawer.getByRole("spinbutton", { name: "Quantity", exact: true }).fill("0.5");
  await drawer.getByRole("button", { name: "Save part", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].parts[0]).toMatchObject({ itemId: null, label: "Synthetic Design", quantity: 0.5 });
});

test("drawer fits desktop and phone in both themes", async ({ page }) => {
  const out = process.env.PULSE_BILLING_PART_SHOTS;
  if (out) await mkdir(out, { recursive: true });
  const { drawer } = await open(page);
  await drawer.getByRole("spinbutton", { name: "Quantity", exact: true }).fill("0.5");
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await expect(drawer.getByRole("button", { name: "Save part", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (out) await page.screenshot({ path: join(out, `billing-part-${width}-${theme}.png`) });
  }
});
