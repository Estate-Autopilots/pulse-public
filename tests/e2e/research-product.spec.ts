import { test, expect } from "@playwright/test";
test.skip(
  !process.env.PULSE_REAL_SMOKE,
  "Uses the live, cleaned research snapshot",
);
const admin = {
  "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com",
};
test("cleaned buyer totals and finance boundaries are visible through the real API", async ({
  request,
}) => {
  const r = await request.get("/api/v0/research", { headers: admin });
  expect(r.status()).toBe(200);
  const d = await r.json();
  expect(d.summary.leads).toBe(133769);
  expect(d.summary.noted).toBe(18882);
  expect(d.summary.booked).toBe(115);
  expect(d.summary.visited).toBe(1147);
  expect(
    d.imports.find((x: { dataset: string }) => x.dataset === "leads_clean").n,
  ).toBe(143541);
  expect(
    await request
      .get("/api/v0/money/ad-spend", {
        headers: {
          "Cf-Access-Authenticated-User-Email": "hr@estateautopilots.com",
        },
      })
      .then((r) => r.status()),
  ).toBe(403);
  const ad = await request.get("/api/v0/money/ad-spend", { headers: admin });
  expect(ad.status()).toBe(200);
  const data = await ad.json();
  expect(data.accounts.length).toBe(286);
  expect(data.totals.reduce((n: number, x: { n: number }) => n + x.n, 0)).toBe(
    5258,
  );
  expect(data.totals.length).toBe(2);
  expect(
    data.cpl.every(
      (x: { spend: number; leads: number }) => x.spend >= 5000 && x.leads >= 50,
    ),
  ).toBe(true);
});
test("growth, sources and renewal views explain their denominators", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders(admin);
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.goto("/leadership?tab=growth");
  await expect(
    page.getByRole("heading", { name: "New engagements", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/13 complete calendar months/)).toBeVisible();
  await page.goto("/leadership?tab=pipeline");
  await expect(
    page.getByRole("heading", { name: "Agency prospects", exact: true }),
  ).toBeVisible();
  await page.goto("/dashboard?tab=research&researchView=Outcomes");
  await expect(
    page.getByRole("heading", { name: "Recorded outcome funnel" }),
  ).toBeVisible();
  await expect(page.getByText(/Nested stages/)).toBeVisible();
  await page.goto("/clients?tab=renewals");
  await expect(
    page.getByRole("heading", { name: "Client renewals" }),
  ).toBeVisible();
  await expect(page.getByText(/No fitted churn probability/)).toBeVisible();
});
test("project lead and creative tabs persist and call rows have a team boundary", async ({
  page,
  request,
}) => {
  await page.setExtraHTTPHeaders(admin);
  const projects = await request
    .get("/api/v0/projects?scope=all", { headers: admin })
    .then((r) => r.json());
  const id = projects.projects[0].projectId;
  await page.goto(`/projects/${id}?tab=leads`);
  await expect(
    page.getByRole("link", { name: "Creatives", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Development-wide:/)).toBeVisible();
  await page.getByRole("link", { name: "Creatives", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Lead response by creative type" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Lead response by creative type" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Calls", exact: true }).click();
  await expect(page.getByRole("heading", { name: /candidates/ })).toBeVisible();
});
test("ad account mapping drawer is reviewable and retains a manual-values explanation", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders(admin);
  await page.goto("/money?tab=ad-spend&adView=Account+mapping");
  const drawer = page.getByRole("heading", {
    name: "Map ad account",
    exact: true,
  });
  await expect(async () => {
    await page
      .getByRole("button", { name: "Map account", exact: true })
      .first()
      .click();
    await expect(drawer).toBeVisible({ timeout: 1500 });
  }).toPass();
  await expect(page.getByText(/future imports preserve/)).toBeVisible();
  await page.keyboard.press("Escape");
});
