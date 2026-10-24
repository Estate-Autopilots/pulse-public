import { expect, test } from "@playwright/test";

test.skip(Boolean(process.env.PULSE_BASE_URL), "Uses the exact synthetic v0 Designers fixtures from the local API.");

test("Designers renders v0 week responses and keeps daily detail self-only", async ({ page }) => {
  const week = "2026-W40";
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "manager@estateautopilots.com" });
  await page.goto(`/designers?week=${week}`);
  const teamTable = page.getByRole("table", { name: "Weekly design deliveries by person and type" });
  await expect(teamTable.getByRole("row", { name: /Synthetic Sam/ })).toBeVisible();
  await expect(teamTable.getByRole("row", { name: /Synthetic Manager/ })).toBeVisible();
  await expect(teamTable.getByRole("row", { name: /Shared login/ })).toBeVisible();
  await expect(teamTable.getByRole("row", { name: /Synthetic Blair/ })).toContainText("Nothing recorded this week");
  await expect(teamTable.getByRole("link", { name: "Synthetic Manager" })).toHaveCount(0);
  await page.locator("summary[aria-label='How Pulse knows this']").click();
  await expect(page.getByText(/eligible design exports last modified in Drive/)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Week navigation" }).getByText("Week 40 · 28 Sep – 4 Oct 2026")).toBeVisible();
  await expect(page.getByRole("link", { name: "Next week" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const zeroRowCard = page.getByRole("article").filter({ hasText: "Synthetic Blair" });
  await expect(zeroRowCard.getByText("Nothing recorded this week")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto("/designers?week=2026-W41");
  await expect(page.getByRole("table", { name: "Weekly design deliveries by person and type" })).toHaveCount(0);
  await expect(page.getByText("Not enough data yet")).toBeVisible();
  await page.goto(`/designers/synthetic-manager?week=${week}`);
  await expect(page.getByText("Daily detail is private")).toBeVisible();

  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "sales@estateautopilots.com" });
  await page.goto(`/designers?week=${week}`);
  const ownTable = page.getByRole("table", { name: "Weekly design deliveries by person and type" });
  await expect(ownTable.getByRole("row", { name: /Synthetic Sam/ })).toBeVisible();
  await expect(ownTable.getByRole("row", { name: /Synthetic Blair|Shared login/ })).toHaveCount(0);
  await ownTable.getByRole("link", { name: "Synthetic Sam" }).click();
  const weekly = page.getByRole("table", { name: "Your weekly design deliveries by type" });
  await expect(weekly.getByRole("row", { name: /Carousel/ })).toContainText("3");
  await expect(weekly.getByRole("row", { name: /Logo/ })).toContainText("1");
  await expect(page.getByRole("table", { name: "Your daily design deliveries" })).toBeVisible();
  await page.locator("summary[aria-label='How Pulse knows this']").click();
  await expect(page.getByText(/eligible design exports last modified in Drive/)).toBeVisible();
  await page.goto("/designers/synthetic-sam?week=2026-W41");
  await expect(page.getByRole("table", { name: "Your weekly design deliveries by type" })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Your daily design deliveries" })).toHaveCount(0);
  await expect(page.getByText("Not enough data yet")).toBeVisible();
});

test("a designer claim moves one design from shared login to the designer after manager confirmation", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "designer-b@estateautopilots.com" });
  await page.goto("/my-week?week=2026-W40");
  const personalDesigns = page.locator("section").filter({ has: page.getByRole("heading", { name: "Shared-login designs this week" }) });
  await expect(personalDesigns.getByText("Synthetic claimed brochure.pdf", { exact: true })).toBeVisible();
  await personalDesigns.getByRole("button", { name: "This is mine" }).click();
  await expect(personalDesigns.getByText("Waiting for your manager", { exact: true })).toBeVisible();

  const managerPage = await page.context().newPage();
  await managerPage.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "manager@estateautopilots.com" });
  await managerPage.goto("/designers?week=2026-W40");
  const reviewPanel = managerPage.locator("section").filter({ has: managerPage.getByRole("heading", { name: "Claims to confirm" }) });
  await expect(reviewPanel.getByText("Synthetic claimed brochure.pdf", { exact: true })).toBeVisible();
  const table = managerPage.getByRole("table", { name: "Weekly design deliveries by person and type" });
  const claimRow = reviewPanel.locator("li").filter({ hasText: "Synthetic claimed brochure.pdf" });
  const designerRow = table.getByRole("row", { name: /Synthetic Designer B/ });
  const sharedRow = table.getByRole("row", { name: /Shared login/ });
  await expect(designerRow).toContainText("Nothing recorded this week");
  await expect(sharedRow.getByRole("cell").nth(2)).toHaveText("1");

  for (const [theme, width, height, size] of [
    ["light", 1440, 900, "desktop"], ["dark", 1440, 900, "desktop"],
    ["light", 390, 844, "phone"], ["dark", 390, 844, "phone"],
  ] as const) {
    await managerPage.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await managerPage.setViewportSize({ width, height });
    if (size === "phone") {
      const claimMeta = claimRow.locator(":scope > span").nth(1).locator(":scope > span").nth(1);
      await expect(claimMeta).toHaveCSS("flex-wrap", "wrap");
      await expect(claimMeta).toHaveCSS("white-space", "normal");
      await expect(reviewPanel.getByText("Synthetic Designer B", { exact: true })).toBeVisible();
    }
    await managerPage.waitForTimeout(180);
    await managerPage.screenshot({ path: `test-results/designers-claims-${theme}-${size}.png`, fullPage: true });
  }
  await managerPage.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await managerPage.setViewportSize({ width: 1440, height: 900 });

  await reviewPanel.getByRole("button", { name: "Confirm" }).click();
  await expect(reviewPanel.getByRole("status")).toContainText("Design claim confirmed");
  const claimNote = designerRow.getByText("Includes 1 confirmed claim");
  await expect(claimNote).toBeVisible();
  await expect(claimNote).toHaveCSS("font-size", "12px");
  await expect(claimNote).toHaveCSS("font-weight", "400");
  await expect(designerRow.locator("th span").first()).toHaveCSS("row-gap", "1px");
  await expect(designerRow.getByRole("cell").nth(2)).toHaveText("1");
  await expect(sharedRow.getByRole("cell").nth(2)).toHaveText("0");
  await expect(table.getByRole("row", { name: /Shared login/ })).toHaveCount(1);
  await managerPage.setViewportSize({ width: 390, height: 844 });
  const creditedCard = managerPage.getByRole("article").filter({ hasText: "Synthetic Designer B" });
  await expect(creditedCard.getByText("Includes 1 confirmed claim")).toBeVisible();
  await managerPage.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ["light", "dark"] as const) {
    await managerPage.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await managerPage.waitForTimeout(180);
    await designerRow.screenshot({ path: `test-results/designers-claim-note-${theme}-desktop.png` });
    await managerPage.setViewportSize({ width: 390, height: 844 });
    await creditedCard.screenshot({ path: `test-results/designers-claim-note-${theme}-phone.png` });
    await managerPage.setViewportSize({ width: 1440, height: 900 });
  }

  const staffPage = await page.context().newPage();
  await staffPage.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "staff@estateautopilots.com" });
  await staffPage.goto("/designers?week=2026-W40");
  await expect(staffPage.getByRole("heading", { name: "Claims to confirm" })).toHaveCount(0);
  await staffPage.close();
  await managerPage.close();
});
