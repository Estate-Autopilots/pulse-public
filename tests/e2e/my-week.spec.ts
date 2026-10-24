import { expect, test } from "@playwright/test";

const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const editorEmail = process.env.PULSE_E2E_EDITOR_EMAIL?.trim();
const editorSession = process.env.PULSE_E2E_EDITOR_SESSION?.trim();

test("My week is private for editors and team scoped for admins", async ({ page, request }) => {
  test.skip(!process.env.PULSE_REAL_SMOKE, "Run against the live EA tenant");
  test.skip(!editorEmail, "Set PULSE_E2E_EDITOR_EMAIL to an active editor account");

  const editor = { "Cf-Access-Authenticated-User-Email": editorEmail! };
  const meResponse = await request.get("/api/v0/me", { headers: editor });
  expect(meResponse.status()).toBe(200);
  const me = await meResponse.json() as { role: string; person: string; name: string };
  expect(me.role).toBe("person");
  expect(me.person).toMatch(/^[0-9a-f-]{36}$/i);

  const rosterResponse = await request.get("/api/v0/people", { headers: admin });
  expect(rosterResponse.status()).toBe(200);
  const roster = await rosterResponse.json() as { people: { id: string; name: string }[] };
  const otherNames = roster.people.filter(person => person.id !== me.person).map(person => person.name).filter(Boolean);
  const other = roster.people.find(person => person.id !== me.person);
  expect(other, "the live tenant should have another team member for the isolation check").toBeTruthy();

  await page.setExtraHTTPHeaders(editor);
  await page.goto("/my-week");
  await expect(page.getByRole("heading", { name: "My week" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Deliveries by creative type" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open tasks assigned to you" })).toBeVisible();
  const personalView = await page.locator("main").innerText();
  for (const name of otherNames) expect(personalView).not.toContain(name);

  const week = await page.locator('input[name="week"]').inputValue();
  const reportResponse = await request.get(`/api/v1/editors/${me.person}/week?week=${encodeURIComponent(week)}`, { headers: editor });
  expect(reportResponse.status()).toBe(200);
  const report = await reportResponse.json() as { openTasks?: unknown[] };
  expect(report.openTasks, "the signed-in editor's report includes only their assigned open tasks").toBeDefined();
  const crossPersonResponse = await request.get(`/api/v1/editors/${other!.id}/week?week=${encodeURIComponent(week)}`, { headers: editor });
  expect(crossPersonResponse.status()).toBe(403);

  const teamResponse = await request.get("/api/v0/leadership-week", { headers: admin });
  expect(teamResponse.status()).toBe(200);
  expect((await teamResponse.json()).scope).toBe("All EA accounts");
  await page.setExtraHTTPHeaders(admin);
  await page.goto("/my-week");
  await expect(page.getByRole("heading", { name: "Leadership" })).toBeVisible();
  await expect(page.getByText("All EA accounts", { exact: true })).toBeVisible();
});

test("My week accepts a Pulse session-cookie editor", async ({ page }) => {
  test.skip(!process.env.PULSE_REAL_SMOKE, "Run against the live EA tenant");
  test.skip(!editorEmail || !editorSession, "Set PULSE_E2E_EDITOR_EMAIL and PULSE_E2E_EDITOR_SESSION");

  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": editorEmail! });
  await page.goto("/");
  const origin = new URL(page.url());
  await page.context().addCookies([{
    name: "pulse_session",
    value: editorSession!,
    url: origin.origin,
    httpOnly: true,
    secure: origin.protocol === "https:",
  }]);
  await page.goto("/my-week");
  await expect(page.getByRole("heading", { name: "My week" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Deliveries by creative type" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open tasks assigned to you" })).toBeVisible();
});
