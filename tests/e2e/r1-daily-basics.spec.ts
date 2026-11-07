import { expect, test } from "@playwright/test";

// R1 Daily basics (EST-1195/1196, CTO and UI Guard review), on a phone's My desk where the day's card is the one
// attendance control: Pip and the island act through the card, a check-out to correct stays reachable, and a retry
// Pulse accepts keeps its progress until the day changes. Synthetic persona and days only.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "Isolated synthetic browser adapters only");
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const PHONE = { width: 390, height: 844 };
const iso = (ms: number) => new Date(ms).toISOString();
const istDay = (ms: number) => iso(ms + 330 * 60_000).slice(0, 10);
const day = (person: string, patch: Record<string, unknown> = {}) => {
  const now = Date.now();
  return { attendanceEnabled: true, person: { id: person, name: "Synthetic Admin", firstName: "Synthetic" }, now: iso(now), today: istDay(now), clock: "12:00", timezone: "Asia/Kolkata",
    utcOffsetMinutes: 330, shift: { start: "00:01", end: "23:59", graceMinutes: 15, onTimeBy: "00:16", workingDay: true, mode: "office" }, shiftStartsAt: iso(now - 3_600_000),
    shiftEndsAt: iso(now + 3_600_000), state: "out", holiday: null, entry: null, nextShift: null, streak: { onTime: 0, firstCheckIn: false }, waiting: null,
    presence: { autoCheckIn: false, offices: [], sites: [] }, ...patch };
};

test("a check-out to correct stays reachable on a phone's My desk", async ({ browser, request }) => {
  const person = (await (await request.get("/api/v0/hr/self", { headers: admin })).json()).person.id;
  const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: admin });
  const now = Date.now();
  await context.route("**/api/v0/companion", (route) => route.fulfill({ json: day(person, { state: "in",
    entry: { id: "synthetic-open-entry", date: istDay(now - 86_400_000), in: iso(now - 20 * 3_600_000), out: null, mode: "office", late: 0, onBreak: false, breakStartedAt: null, closedBreakSeconds: 0 } }) }));
  const page = await context.newPage();
  await page.goto("/me?checkout=synthetic-open-entry");
  const menu = page.getByRole("dialog", { name: "Today’s attendance" });
  await expect(menu).toBeVisible();
  const left = menu.getByLabel("I left at");
  await left.focus();
  await expect(left).toBeFocused();
  await context.close();
});

test("Pip's Check in on a phone's My desk goes through the card, and an accepted retry keeps its progress", async ({ browser, request }) => {
  const person = (await (await request.get("/api/v0/hr/self", { headers: admin })).json()).person.id;
  const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: admin });
  await context.route("**/api/v0/companion", (route) => route.fulfill({ json: day(person) }));
  const ids: string[] = []; let ready = false;
  await context.route("**/api/v0/attendance/check-in", async (route) => {
    ids.push(route.request().postDataJSON().queueId);
    if (!ready) await route.abort("failed"); else await route.fulfill({ json: { id: "synthetic-server-receipt" } });
  });
  const page = await context.newPage();
  await page.goto("/me");
  const today = page.getByRole("region", { name: "Today", exact: true });
  await expect(today.getByRole("button", { name: "Check in", exact: true })).toBeEnabled();
  // The server's HTML shows the button before the card hydrates; the card marks <html> once it is the live control.
  await page.waitForFunction(() => "todayCard" in document.documentElement.dataset);
  await page.getByRole("button", { name: /^Pip/ }).click();
  await page.getByRole("menuitem", { name: "Check in" }).click();
  // The tap is queued by the card's own recovery: the card says so and holds its button.
  await expect(today).toContainText("Your tap is saved on this device");
  await expect(today.getByRole("button", { name: "Check in", exact: true })).toBeDisabled();
  ready = true;
  await today.getByRole("button", { name: "Retry saved attendance" }).click();
  // Accepted while the page's day has not changed (this synthetic day stays "out"): no enabled Check in in between.
  await expect(today.getByRole("button", { name: "Checking in…" })).toBeDisabled();
  await expect(today.getByRole("button", { name: "Check in", exact: true })).toHaveCount(0);
  expect(new Set(ids).size).toBe(1);
  await context.close();
});

test("an unconfirmed clock shows not saved and Try again in the card when Pip or a nudge checks in", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: admin });
  await context.route("**/api/v0/companion", (route) => route.abort("failed"));
  const page = await context.newPage();
  await page.goto("/me");
  const today = page.getByRole("region", { name: "Today", exact: true });
  await expect(today.getByRole("button", { name: "Check in", exact: true })).toBeEnabled();
  // The server's HTML shows the button before the card hydrates; the card marks <html> once it is the live control.
  await page.waitForFunction(() => "todayCard" in document.documentElement.dataset);
  // Pip's menu, the island's arrival nudge and Ctrl+K all send this event; the card takes it.
  const handled = await page.evaluate(() => { const detail = { id: "check-in", handled: false }; window.dispatchEvent(new CustomEvent("pulse:checkin-act", { detail })); return detail.handled; });
  expect(handled).toBe(true);
  await expect(today).toContainText("so this check-in was not saved");
  await expect(today.getByRole("button", { name: "Try again" })).toBeVisible();
  await context.close();
});

// CTO review (EST-1196 @ bc120af6): on a day of approved leave, Ctrl+K's "Check in (from home)" or "(on duty)" opens the
// leave question, and whichever answer the person gives sends the place they chose (not the card's default, Office).
const LEAVE_ADMIN = { "Cf-Access-Authenticated-User-Email": "admin@on-leave.example" };
for (const [how, label] of [["wfh", "Check in (from home)"], ["field", "Check in (on duty)"]] as const) {
  for (const answer of ["Check in, keep the leave", "Cancel today’s leave and check in"]) {
    test(`on a leave day, Ctrl+K "${label}" then "${answer}" sends ${how}`, async ({ browser, request }) => {
      const person = (await (await request.get("/api/v0/hr/self", { headers: LEAVE_ADMIN })).json()).person.id;
      const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: LEAVE_ADMIN });
      await context.route("**/api/v0/companion", (route) => route.fulfill({ json: day(person, { state: "leave" }) }));
      const sent: { mode?: string; leave?: string }[] = [];
      await context.route("**/api/v0/attendance/check-in", async (route) => { sent.push(route.request().postDataJSON()); await route.fulfill({ json: { id: "synthetic-server-receipt" } }); });
      const page = await context.newPage();
      await page.goto("/me");
      await page.waitForFunction(() => "todayCard" in document.documentElement.dataset);
      const palette = page.getByRole("dialog", { name: "Search Pulse" });
      await expect(async () => { await page.keyboard.press("Control+k"); await expect(palette).toBeVisible({ timeout: 1000 }); }).toPass();
      // The palette paints before its deferred focus runs; target the input itself.
      await palette.getByRole("combobox").fill("check in");
      await expect(palette.getByRole("combobox")).toHaveValue("check in");
      await palette.getByRole("option", { name: label, exact: true }).click();
      const ask = page.getByRole("dialog", { name: "You’re on leave today" });
      await expect(ask).toBeVisible();
      // The card's place control already shows the chosen place while the question is open.
      await expect(page.getByRole("region", { name: "Today", exact: true }).getByRole("group", { name: "Where you are working" }).getByRole("button", { name: how === "wfh" ? "Home" : "On duty" })).toHaveAttribute("aria-current", "true");
      await ask.getByRole("button", { name: answer, exact: true }).click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].mode).toBe(how);
      expect(sent[0].leave).toBe(answer.startsWith("Cancel") ? "cancel" : undefined);
      await context.close();
    });
  }
}

// QA and CTO review (EST-1198 @ bc120af6): the phone bar's tabs are named by the word they show first ("Home (Dashboard)",
// "Me (My desk)"), so they can be found and opened by that name; Chats still announces its unread count, and computers
// keep the full labels.
test("the phone bar's Home and Me are named by their visible words and open Dashboard and My desk", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: admin });
  await context.route("**/api/v0/companion/updates*", (route) => route.fulfill({ json: { rows: [], cursor: null, page: null, counts: { chats: 3 } } }));
  const page = await context.newPage();
  await page.goto("/tasks");
  const bar = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(bar.getByRole("link", { name: "Chats, 3 unread", exact: true })).toBeVisible();
  for (const [name, path] of [["Home (Dashboard)", "/dashboard"], ["Me (My desk)", "/me"]] as const) {
    await bar.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(bar.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await expect(bar.getByRole("link", { name: "Home", exact: true })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "More", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  // Owner workbench (21 Oct 2026): the rail holds sections; Home's pages (Dashboard, My desk) are listed by their full
  // names in the panel beside it.
  const rail = page.getByRole("navigation", { name: "Main sections" });
  await expect(rail.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  const home = page.getByRole("navigation", { name: "Home pages", exact: true });
  await expect(home.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(home.getByRole("link", { name: "My desk", exact: true })).toBeVisible();
  await context.close();
});
