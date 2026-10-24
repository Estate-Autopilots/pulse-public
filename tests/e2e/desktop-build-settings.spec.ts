import { expect, test } from "@playwright/test";

const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };

test.skip(Boolean(process.env.PULSE_BASE_URL), "Uses synthetic identity and build metadata for local web builds.");

test("desktop build tab is separate from personal devices and gates downloads", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  let metadataRequests = 0;
  await page.route("**/api/admin/devices/desktop-build", async (route) => {
    metadataRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "0.1.0",
        commit: "abc1234",
        buildDate: "2026-10-06T10:00:00.000Z",
        fileName: "pulse-desktop.msi",
        sizeBytes: 123456,
        sha256: "a".repeat(64),
        noticeVersion: "v2",
        downloadUrl: "/api/admin/devices/desktop-build?download=1",
      }),
    });
  });

  await page.goto("/settings?tab=desktop-app");
  const sections = page.getByRole("navigation", { name: "Sections" });
  await expect(sections.getByRole("link", { name: "Desktop build" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Unsigned internal build", { exact: true })).toBeVisible();
  const download = page.getByRole("button", { name: "Download unsigned Windows installer" });
  await expect(download).toBeDisabled();
  await page.getByRole("checkbox", { name: /I confirm each person who will use this build/ }).check();
  await expect(download).toBeEnabled();
  expect(metadataRequests).toBeGreaterThan(0);

  const requestsBeforePersonalDevices = metadataRequests;
  await page.goto("/settings?tab=devices");
  await expect(page.getByRole("heading", { name: "Your devices" })).toBeVisible();
  await expect(page.getByText("Unsigned internal build", { exact: true })).toHaveCount(0);
  expect(metadataRequests).toBe(requestsBeforePersonalDevices);
});
