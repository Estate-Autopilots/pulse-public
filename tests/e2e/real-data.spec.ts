import { expect, test } from "@playwright/test";
test.skip(!process.env.PULSE_REAL_SMOKE, "Run against an environment with the real EA tenant");
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
test("real API and weekly views expose indexed evidence", async ({ page, request }) => {
  test.setTimeout(90000); // seven Leadership tabs, each compiled on first visit against a dev server
  const api = await request.get("/api/v0/my-week", { headers: admin, maxRetries: 2 }); expect(api.status()).toBe(200);
  // My week is personal since round 5B: the viewer's own qualified uploads, never the company's files.
  const data = await api.json(); expect(data.scope).toMatch(/this person/); expect(Array.isArray(data.recentDeliveries)).toBe(true);
  expect(data.recentDeliveries.every((d: { fileId: string }) => !d.fileId.includes("synthetic"))).toBe(true);
  const home = await (await request.get("/api/v0/home", { headers: admin })).json(); expect(home.freshness.files).toBeGreaterThan(1000);
  await page.setExtraHTTPHeaders(admin);
  await page.goto("/my-week"); await expect(page.getByRole("group", { name: "Period" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent deliveries" })).toBeVisible();
  // Leadership: every tab renders its panels; the old pod routes open the new views.
  for (const [tab, heading] of [["overview", "Deliveries per week"], ["delivery", "Quality signals"], ["pods", "Pods side by side"], ["clients", "Portfolio"], ["people", "Capacity"], ["risks", "Risks"], ["money", "Money"]]) {
    await page.goto(`/leadership?tab=${tab}&section=${encodeURIComponent(heading)}`); await expect(page.getByRole("group", { name: "Period" })).toBeVisible();
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
  await page.goto("/pod"); await expect(page).toHaveURL(/\/leadership\?tab=pods/);
  await page.goto("/pods/Pod%201"); await expect(page).toHaveURL(/\/people\?pod=Pod/);
});
test("home is role-aware and every number links to its evidence", async ({ page, request, baseURL }) => {
  const home = await (await request.get("/api/v0/home", { headers: admin })).json();
  expect(home.view).toBe("leadership"); expect(home.trend).toHaveLength(12); expect(home.freshness.files).toBeGreaterThan(1000);
  expect((await request.get("/api/v0/home?from=2026-13-01&to=2026-12-01", { headers: admin })).status()).toBe(400);
  await page.setExtraHTTPHeaders(admin); await page.goto("/"); await expect(page).toHaveURL(/\/dashboard$/);
  // OWNER-HOME: leadership opens Focus by default; these panels are the Max view, remembered in a cookie.
  await page.context().addCookies([{ name: "pulse.home.mode", value: "max", url: baseURL! }]); await page.goto("/dashboard");
  for (const name of ["Deliveries per week", "Needs attention"]) await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  // Pipeline and clients are the overview's second view on a 1280 px window.
  await page.getByRole("button", { name: "Pipeline & clients" }).click();
  for (const name of ["Project pipeline", "Clients"]) await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  await page.goto("/dashboard");
  // A desktop page fits the window; longer lists page within their panels.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && [...document.querySelectorAll("main > div")].every((el) => el.scrollHeight <= el.clientHeight + 1))).toBe(true);
  await page.goto("/dashboard?tab=delivery"); for (const name of ["Latest deliveries", "Most active projects"]) await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.goto("/dashboard?tab=people"); for (const name of ["Attendance Last 14 days", "Attendance today"]) await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.getByText(/Synced .+ ago|Synced just now/)).toBeVisible();
  await expect(async () => { await page.getByRole("button", { name: "Last week" }).click(); await expect(page).toHaveURL(/period=last/, { timeout: 1500 }); }).toPass();
  await page.getByRole("link", { name: /^Projects with deliveries/ }).click(); await expect(page).toHaveURL(/\/projects\?.*show=active/);
  await page.goto("/projects?view=list"); await page.locator("tbody tr a").first().click(); await expect(page.getByRole("heading", { name: "Deliveries per week" })).toBeVisible();
  // Recents live in the side panel, which opens on very wide windows (round 6).
  await page.setViewportSize({ width: 2400, height: 900 });
  await expect(page.getByRole("region", { name: "Recent pages" }).getByRole("link")).toHaveCount(2);
});
test("people profiles and encoded editor routes show real data", async ({ page, request }) => {
  await page.setExtraHTTPHeaders(admin); await page.goto("/people");
  await page.getByRole("link", { name: /Kazuk Bukin/ }).first().click();
  await expect(page.getByRole("heading", { name: "Kazuk Bukin" })).toBeVisible();
  const r = await request.get("/api/v0/editors", { headers:admin }); const d = await r.json();
  const account = d.accounts.find((a: {thisWeek:number}) => a.thisWeek > 0).account;
  // Editors folded into Team: the old routes open Tracking and the account page under it.
  await page.goto(`/editors/${encodeURIComponent(account)}`); await expect(page).toHaveURL(/\/people\/accounts\//);
  await expect(page.getByRole("heading", { name: account })).toBeVisible();
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("button", { name: "Deliveries per day", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Deliveries per day" })).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await expect(page.getByText("Shared login · individual editor unverified")).toBeVisible();
  await page.goto("/editors"); await expect(page).toHaveURL(/\/people\?tab=tracking/);
  await expect(page.getByRole("heading", { name: /came through a shared login/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Everyone, by their own signals" })).toBeVisible();
  // Adding opens a side drawer, not a popup in the middle of the page.
  await page.goto("/contacts");
  const drawer = page.getByRole("dialog", { name: "Add a contact" });
  // A dev server can paint the button before it hydrates; click until the drawer opens.
  await expect(async () => { await page.getByRole("button", { name: "Add contact" }).click(); await expect(drawer).toBeVisible({ timeout: 1500 }); }).toPass();
  await page.waitForTimeout(400); const box = await drawer.boundingBox(); const width = page.viewportSize()!.width;
  expect(Math.abs(box!.x + box!.width - width)).toBeLessThan(2); expect(box!.x).toBeGreaterThan(width / 2);
  await page.keyboard.press("Escape"); await expect(drawer).toHaveCount(0);
});
test("HR is restricted to attendance and leave; unknown and anonymous identities fail", async ({ page, request }) => {
  const h = { "Cf-Access-Authenticated-User-Email":"hr@estateautopilots.com" };
  await page.setExtraHTTPHeaders(h); await page.goto("/");
  await expect(page.getByRole("heading", {name:"Attendance today"})).toBeVisible();
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("button", { name: "People changes", exact: true }).click();
  await expect(page.getByRole("heading", {name:"People changes"})).toBeVisible(); await expect(page.getByRole("heading", {name:"Deliveries per week"})).toHaveCount(0);
  expect((await (await request.get("/api/v0/home?view=leadership",{headers:h})).json()).view).toBe("hr");
  await page.goto("/attendance"); await expect(page).toHaveURL(/\/me\?tab=attendance/); await expect(page.getByRole("heading", {name:"My desk", level:2})).toBeVisible();
  await expect(page.getByRole("region", {name:"Today"})).toBeVisible();
  await page.getByRole("navigation", {name:"Views",exact:true}).getByRole("button", {name:"Your month",exact:true}).click();
  await expect(page.getByRole("grid", {name:"Attendance this month"})).toBeVisible();
  await expect(page.getByRole("link", {name:"Editors",exact:true})).toHaveCount(0);
  await page.goto("/leave"); await expect(page).toHaveURL(/\/me\?tab=leave/); await expect(page.getByRole("button", {name:"Apply for leave"})).toBeVisible();
  await expect(page.getByRole("heading", {name:"Leave balances"})).toBeVisible();
  expect((await request.get("/api/v0/my-week",{headers:h})).status()).toBe(403);
  expect((await request.get("/api/v0/my-week")).status()).toBe(401);
  expect((await request.get("/api/v0/my-week", {headers:{"Cf-Access-Authenticated-User-Email":"nobody@example.test"}})).status()).toBe(403);
  expect((await request.post("/api/v0/attendance/check-in",{headers:{...admin,Origin:"https://example.test"},data:{}})).status()).toBe(403);
});
test("navigation lives in the icon rail and every record section loads", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin); await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Main sections" });
  for (const name of ["Dashboard", "Work", "Clients", "Contacts", "Team", "My desk", "HR desk", "Leadership"]) await expect(rail.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pages" })).toHaveCount(0);
  for (const [route, heading] of [["/clients", "Clients"], ["/contacts", "Contacts"], ["/people", "Team"]]) {
    await rail.getByRole("link", { name: heading, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expect(page.getByRole("heading", { name: heading, exact: true, level: 2 })).toBeVisible(); await expect(page.getByText("could not load")).toHaveCount(0);
  }
  // Client projects (the packages sold) are a tab of Clients, not a rail entry of their own.
  await page.goto("/projects"); await expect(page.getByRole("heading", { name: "Client projects", exact: true, level: 2 })).toBeVisible();
  await page.goto("/clients"); await page.locator("a[href^='/clients/']").first().click(); await expect(page.getByRole("navigation", { name: "Sections", exact: true }).getByRole("link", { name: /^Projects/ })).toBeVisible();
});
test("people: the full roster, filters, questions to confirm, and HR records for HR and leadership only", async ({ page, request }) => {
  const list = await (await request.get("/api/v0/people", { headers: admin })).json();
  expect(list.people.length).toBeGreaterThan(25);
  for (const name of ["Datup Velupenubo", "Sakipa Velupenubo", "Muder Denika", "Omoza Ubuk", "Nedeho Daroto"]) expect(list.people.map((p: { name: string }) => p.name)).toContain(name);
  const opinem = list.people.find((p: { name: string }) => p.name === "Opinem Rafa");
  await page.setExtraHTTPHeaders(admin); await page.goto("/people");
  await page.getByRole("button", { name: /^Pod 2/ }).click(); await expect(page.getByRole("link", { name: /Muder Denika/ })).toBeVisible(); await expect(page.getByRole("link", { name: /Kazuk Bukin/ })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search the team" }).fill("zzzz"); await expect(page.getByText("Nobody matches")).toBeVisible();
  await page.goto(`/people/${opinem.id}`);
  for (const tab of ["Overview", "Work", "Projects", "Deliveries", "Attendance & leave", "HR", "Documents"]) await expect(page.getByRole("navigation", { name: "Sections", exact: true }).getByRole("link", { name: new RegExp(`^${tab}`) })).toBeVisible();
  await page.goto(`/people/${opinem.id}?tab=hr&section=Salary%20history`); await expect(page.getByRole("heading", { name: "Salary history" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show figures" })).toBeVisible(); await expect(page.getByText("₹")).toHaveCount(0);      // hidden until asked for
  // A signed-in account without the HR or admin role: no HR tab, no HR sources, and the API refuses.
  const other = { "Cf-Access-Authenticated-User-Email": "sales@estateautopilots.com" };
  expect((await request.get(`/api/v0/people/${opinem.id}/hr`, { headers: other })).status()).toBe(403);
  const seen = await (await request.get(`/api/v0/people/${opinem.id}`, { headers: other })).json();
  expect(seen.can.record).toBe(false); expect(seen.sources.every((s: { restricted: boolean }) => !s.restricted)).toBe(true); expect(JSON.stringify(seen)).not.toMatch(/Salary sheet|amount|joined_on/);
  const home = JSON.stringify(await (await request.get("/api/v0/home", { headers: admin })).json()); expect(home).not.toMatch(/salary|amount/i);
});
test("Team & HR: My desk for everyone, the HR desk for HR and admins, salary only when asked for", async ({ page, request }) => {
  const hr = { "Cf-Access-Authenticated-User-Email": "hr@estateautopilots.com" }, other = { "Cf-Access-Authenticated-User-Email": "sales@estateautopilots.com" };
  const self = await (await request.get("/api/v0/hr/self", { headers: hr })).json();
  expect(self.self).toBe(true); expect(self.month.days.length).toBeGreaterThan(27); expect(self.leave.types.length).toBeGreaterThan(1); expect(self.performance === null || self.performance.allTime === 0).toBe(true); // HR sees only her own recorded work (round 7A2), none of the company's
  await page.setExtraHTTPHeaders(hr); await page.goto("/me");
  for (const tab of ["Overview", "Attendance", "Leave", "Performance", "Requests"]) await expect(page.getByRole("navigation", { name: "Sections", exact: true }).getByRole("link", { name: new RegExp(`^${tab}`) })).toBeVisible();
  await page.goto("/me?tab=requests"); await expect(page.getByRole("button", { name: "Raise a request" })).toBeVisible();
  await page.goto("/hr");
  for (const tab of ["Dashboard", "Attendance", "Leave", "Requests", "Payroll", "Policies"]) await expect(page.getByRole("navigation", { name: "Sections", exact: true }).getByRole("link", { name: new RegExp(`^${tab}`) })).toBeVisible();
  await page.goto("/hr?tab=payroll"); await expect(page.getByRole("button", { name: "Show figures" })).toBeVisible(); await expect(page.getByText("₹")).toHaveCount(0);
  const list = await (await request.get("/api/v0/hr/payroll", { headers: hr })).json(); expect(list.figures).toBeNull(); expect(JSON.stringify(list)).not.toMatch(/amount/);
  // An account without the HR or admin role: no HR desk, no payroll, nobody else's record.
  for (const path of ["hr/desk", "hr/attendance", "hr/leave", "hr/payroll", `hr/person/${self.person.id}`]) expect((await request.get(`/api/v0/${path}`, { headers: other })).status()).toBe(403);
  expect((await request.post("/api/v0/hr/policy", { headers: other, data: { graceMinutes: 30 } })).status()).toBe(403);
});
