import { expect, test } from "@playwright/test";

test.skip(Boolean(process.env.PULSE_BASE_URL), "Uses synthetic claim data from the local fixture server; staging checks use real data.");

const editor = { "Cf-Access-Authenticated-User-Email": "editor@estateautopilots.com" };
const manager = { "Cf-Access-Authenticated-User-Email": "manager@estateautopilots.com" };

test("an editor claims a shared-login delivery, a manager confirms it, and the editor's gap updates", async ({ page }) => {
  await page.setExtraHTTPHeaders(editor);
  await page.goto("/my-week");
  await expect(page.getByRole("heading", { name: "My week" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shared-login deliveries to claim" })).toBeVisible();
  await expect(page.getByText("Synthetic model video.mp4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "This is mine" }).click();
  await expect(page.getByRole("status")).toContainText("sent to your manager for confirmation");
  await expect(page.getByText("Synthetic model video.mp4", { exact: true })).toHaveCount(0);

  await page.setExtraHTTPHeaders(manager);
  await page.goto("/people?tab=tracking&view=accounts");
  await expect(page.getByRole("heading", { name: "Claims to confirm" })).toBeVisible();
  await expect(page.getByText("Synthetic model video.mp4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("status")).toContainText("weekly delivered total and gap now include this confirmed claim");
  const accountPages = page.getByRole("group", { name: "Pages of Uploader accounts" });
  await accountPages.getByRole("button", { name: "Next page" }).click();
  await accountPages.getByRole("button", { name: "Next page" }).click();
  const sam = page.getByRole("row", { name: /sam\.editor@example\.test/ });
  await expect(sam).toContainText("confirmed claim · 1");
  await expect(sam.getByRole("cell").nth(5)).toHaveText("9");

  await page.setExtraHTTPHeaders(editor);
  await page.goto("/my-week");
  const modelVideo = page.getByRole("row", { name: /Model video/ });
  await expect(modelVideo).toContainText("confirmed claim · 1");
  await expect(modelVideo).toContainText("Target met");
});
