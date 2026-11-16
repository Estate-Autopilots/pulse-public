import { expect, test, type Browser, type Page } from "@playwright/test";

// TASKS-SCROLL (owner, 7 Nov 2026, production 4faf78ed): on Work the check-in card, the tiles and the bars took the top
// of the window and never shrank, and My tasks was a small box in the bottom 20-30 % that was hard to scroll. Now Work is
// one page that scrolls: the header is one row, what sits above the list (the check-in card, Today's focus) folds behind
// "Show summary" once the person has seen it, the view's toolbar is the one slim bar that stays at the top while the
// list moves, a table's header row sticks under it, a board's columns fill the window, and no box inside the page
// scrolls on its own. Synthetic data only: busy@ has 48 open tasks (tests/e2e/fixtures/tasks-p0.mjs) and is checked in.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "Synthetic build only (tests/e2e/fixtures/tasks-p0.mjs, busy@)");

const BUSY = { "Cf-Access-Authenticated-User-Email": "user-fc79d8bf@estateautopilots.com" };
// mock-editors-api.mjs: an address it does not know is the staff persona, Synthetic Sam.
const PERSON = "synthetic-sam";
const iso = (ms: number) => new Date(ms).toISOString();
const istDay = (ms: number) => iso(ms + 330 * 60_000).slice(0, 10);
function checkedIn() {
  const now = Date.now();
  return { attendanceEnabled: true, person: { id: PERSON, name: "Synthetic Sam", firstName: "Synthetic" }, now: iso(now), today: istDay(now), clock: "12:00", timezone: "Asia/Kolkata",
    utcOffsetMinutes: 330, shift: { start: "00:01", end: "23:59", graceMinutes: 15, onTimeBy: "00:16", workingDay: true, mode: "office" }, shiftStartsAt: iso(now - 3_600_000),
    shiftEndsAt: iso(now + 6 * 3_600_000), state: "in", holiday: null, nextShift: null, streak: { onTime: 3, firstCheckIn: false }, waiting: null,
    presence: { autoCheckIn: false, offices: [], sites: [] },
    entry: { id: "synthetic-entry", date: istDay(now), in: iso(now - 47 * 60_000), out: null, mode: "office", late: 0, onBreak: false, breakStartedAt: null, closedBreakSeconds: 0 },
    week: { onTime: 3, late: 0, missed: 0, days: [0, 1, 2, 3, 4].map((i) => ({ date: istDay(now - (4 - i) * 86_400_000), state: i === 4 ? "today" : "on_time" })) } };
}

async function busy(browser: Browser, size: { width: number; height: number }, opts: { phone?: boolean; seen?: boolean } = {}) {
  const context = await browser.newContext({ viewport: size, extraHTTPHeaders: BUSY, ...(opts.phone ? { hasTouch: true, isMobile: true } : {}) });
  await context.route("**/api/v0/companion", (route) => route.fulfill({ json: checkedIn() }));
  // Someone who has opened Work before on this device: the summary is folded.
  if (opts.seen) await context.addInitScript((p) => { try { localStorage.setItem(`vitals.work.summary-seen.${p}`, "1"); } catch { /* none */ } }, PERSON);
  return { context, page: await context.newPage() };
}
const TASK = 'a[href^="/tasks/tp-busy-"]';
/** Every box between a task and the page that scrolls by itself, and how tall the window it scrolls is. */
const scrollers = (page: Page) => page.evaluate((sel) => {
  const row = document.querySelector(`section[aria-label="My tasks"] li ${sel}`);
  const out: { name: string; height: number; inList: boolean }[] = [];
  const list = document.querySelector('section[aria-label="My tasks"]');
  for (let el = row?.parentElement ?? null; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2) out.push({ name: `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`, height: el.clientHeight, inList: !!list?.contains(el) });
  }
  return out;
}, TASK);
/** The top of the first task in the window (in page order), or of the highest one shown. */
const firstTaskTop = (page: Page) => page.evaluate((sel) => Math.min(...[...document.querySelectorAll(sel)].map((a) => a.getBoundingClientRect()).filter((r) => r.height > 0 && r.bottom > 0).map((r) => r.top)), TASK);
const rowTop = (page: Page) => page.locator(`section[aria-label="My tasks"] ${TASK}`).first().evaluate((a) => a.getBoundingClientRect().top);

const SIZES = [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 844, phone: true }] as const;
for (const size of SIZES) {
  test(`Work's task list starts high and scrolls with the page at ${size.width}×${size.height}`, async ({ browser }) => {
    const phone = "phone" in size;
    const { context, page } = await busy(browser, size, { phone });
    await page.goto("/tasks", { waitUntil: "load" });
    const list = page.locator('section[aria-label="My tasks"]');
    await expect(list.getByRole("link", { name: "Synthetic busy task 01", exact: true })).toBeVisible({ timeout: 30_000 });
    // The first time, the summary is open: the check-in is a compact strip, and the list still starts in the top 40 %.
    const strip = page.locator("[data-checkin-card]");
    await expect(strip).toBeVisible();
    expect((await strip.boundingBox())!.height).toBeLessThanOrEqual(64);
    const box = (await list.boundingBox())!;
    expect(box.y, `My tasks starts at ${Math.round(box.y)} px of ${size.height}`).toBeLessThanOrEqual(size.height * 0.4);

    // No nested scroll trap: nothing inside the list scrolls on its own, and at most one box (the page) scrolls the rows.
    const boxes = await scrollers(page);
    expect(boxes.filter((b) => b.inList), JSON.stringify(boxes)).toEqual([]);
    expect(boxes.length, JSON.stringify(boxes)).toBeLessThanOrEqual(1);
    for (const b of boxes) expect(b.height, JSON.stringify(boxes)).toBeGreaterThanOrEqual(size.height * 0.75);

    const last = list.getByRole("link", { name: "Synthetic busy task 48", exact: true });
    if (!phone) {
      // The mouse wheel over the list moves it (the page scrolls under the pointer) ...
      const before = await rowTop(page);
      await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 120, size.height - 20));
      await page.mouse.wheel(0, 500);
      await expect.poll(() => rowTop(page)).toBeLessThan(before - 300);
      // ... and what was above it scrolled away: only the slim toolbar stays, at the top.
      const bar = page.getByRole("toolbar", { name: "View" });
      const barBox = (await bar.boundingBox())!;
      expect(barBox.height).toBeLessThanOrEqual(64);
      expect(barBox.y).toBeLessThanOrEqual(72);
      expect((await page.locator("[data-page-header]").boundingBox())!.y + 30).toBeLessThan(barBox.y);
      // ... all the way to the last task.
      const bottom = async () => { const b = await last.boundingBox(); return b ? b.y + b.height : Infinity; };
      for (let i = 0; i < 20 && (await bottom()) > size.height; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(150); }
      await expect.poll(bottom).toBeLessThanOrEqual(size.height);
      // The keyboard: from a task, Page Up scrolls the page back towards the top.
      await last.focus();
      const atEnd = await rowTop(page);
      await page.keyboard.press("PageUp");
      await expect.poll(() => rowTop(page)).toBeGreaterThan(atEnd + 200);
    } else {
      // A finger dragging up over the list moves it.
      const before = await rowTop(page);
      const cdp = await context.newCDPSession(page);
      const x = Math.round(box.x + box.width / 2);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: 640 }] });
      for (let y = 620; y >= 200; y -= 20) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => rowTop(page)).toBeLessThan(before - 250);
      // The keyboard (a phone with a keyboard, or a screen reader) reaches the last task.
      await last.focus();
      const end = (await last.boundingBox())!;
      expect(end.y).toBeGreaterThanOrEqual(0);
      expect(end.y + end.height).toBeLessThanOrEqual(size.height);
    }
    await context.close();
  });
}

const LAYOUTS = ["list", "table", "board", "calendar", "timeline"] as const;
for (const layout of LAYOUTS) {
  test(`once the summary has been seen, the first task shows in the top 35 % at 1366×768: ${layout}`, async ({ browser }) => {
    const { context, page } = await busy(browser, { width: 1366, height: 768 }, { seen: true });
    await page.goto(layout === "list" ? "/tasks" : `/tasks?layout=${layout}`, { waitUntil: "load" });
    await expect(page.locator(TASK).first()).toBeAttached({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Show summary" })).toBeVisible();
    await expect(page.locator("[data-checkin-card]")).toBeHidden();
    // A calendar shows the month from its first week: its first week row (where its tasks are drawn) starts that high.
    const first = layout === "calendar" ? () => page.locator("[data-work-controls] [class*='__month'] > *").nth(1).evaluate((e) => e.getBoundingClientRect().top) : () => firstTaskTop(page);
    await expect.poll(first, { message: `first ${layout} row` }).toBeLessThanOrEqual(768 * 0.35);
    if (layout === "table") {
      // The header row sticks under the toolbar while the page scrolls.
      await page.mouse.move(700, 500);
      await page.mouse.wheel(0, 700);
      const bar = (await page.getByRole("toolbar", { name: "View" }).boundingBox())!;
      await expect.poll(async () => Math.abs((await page.locator("table thead th").first().boundingBox())!.y - (bar.y + bar.height))).toBeLessThanOrEqual(4);
    }
    if (layout === "board") {
      // The columns fill the window under the toolbar: scrolled to the board, they reach the window's bottom.
      const board = page.locator("[data-work-controls] [class*='board-module'][class*='__board'], [data-work-controls] [role='group'][aria-label='Board']").first();
      await page.mouse.move(700, 400);
      await page.mouse.wheel(0, 400);
      const b = (await board.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(768 - 48 - 64 - 60);
    }
    await context.close();
  });
}

test("Show summary opens what was folded, and the choice is kept", async ({ browser }) => {
  const { context, page } = await busy(browser, { width: 1366, height: 768 }, { seen: true });
  await page.goto("/tasks", { waitUntil: "load" });
  const toggle = page.getByRole("button", { name: "Show summary" });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-checkin-card]")).toBeHidden();
  await toggle.click();
  await expect(page.locator("[data-checkin-card]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide summary" })).toHaveAttribute("aria-expanded", "true");
  await page.reload({ waitUntil: "load" });
  await expect(page.locator("[data-checkin-card]")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Hide summary" }).click();
  await expect(page.locator("[data-checkin-card]")).toBeHidden();
  await context.close();
});
