import { expect, test } from "@playwright/test";

test.skip(Boolean(process.env.PULSE_BASE_URL), "Uses synthetic claim data from the local fixture server; staging checks use real data.");

const designerA = { "Cf-Access-Authenticated-User-Email": "designer-a@estateautopilots.com" };
const designerB = { "Cf-Access-Authenticated-User-Email": "designer-b@estateautopilots.com" };
const editor = { "Cf-Access-Authenticated-User-Email": "editor@estateautopilots.com" };

test("a designer claims a shared-login export and another designer no longer sees it", async ({ page }) => {
  await page.setExtraHTTPHeaders(designerA);
  await page.goto("/my-week");
  await expect(page.getByRole("heading", { name: "Shared-login designs this week" })).toBeVisible();

  const designPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Shared-login designs this week" }) });
  await expect(designPanel.getByText("Synthetic brochure.pdf", { exact: true })).toBeVisible();
  await expect(designPanel.getByText("Synthetic Design Campaign", { exact: true })).toBeVisible();
  await expect(designPanel.getByText("Type: Brochure", { exact: true })).toBeVisible();
  await expect(designPanel.getByText("Day: 5 Oct 2026", { exact: true })).toBeVisible();

  const staleDesignerPage = await page.context().newPage();
  await staleDesignerPage.setExtraHTTPHeaders(designerB);
  await staleDesignerPage.goto("/my-week");
  const staleDesignerPanel = staleDesignerPage.locator("section").filter({ has: staleDesignerPage.getByRole("heading", { name: "Shared-login designs this week" }) });
  await expect(staleDesignerPanel.getByText("Synthetic brochure.pdf", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await designPanel.getByRole("button", { name: "This is mine" }).click();
  const waitingBadge = designPanel.getByText("Waiting for your manager", { exact: true });
  await expect(waitingBadge).toBeVisible();
  await expect(waitingBadge).toHaveCSS("grid-column-start", "2");
  await expect(waitingBadge).toHaveCSS("justify-self", "start");

  await staleDesignerPanel.getByRole("button", { name: "This is mine" }).click();
  await expect(staleDesignerPanel.getByRole("alert")).toContainText("no longer available to claim");
  await staleDesignerPage.reload();
  await expect(staleDesignerPanel.getByText("No shared-login designs to claim", { exact: true })).toBeVisible();
  await expect(staleDesignerPanel.getByText("Synthetic brochure.pdf", { exact: true })).toHaveCount(0);
  await staleDesignerPage.close();

  await page.setExtraHTTPHeaders(editor);
  const editorResponse = await page.goto("/my-week");
  expect(editorResponse).not.toBeNull();
  expect(await editorResponse!.text()).not.toContain("Shared-login designs this week");
  await expect(page.getByRole("heading", { name: "Shared-login designs this week" })).toHaveCount(0);
});
