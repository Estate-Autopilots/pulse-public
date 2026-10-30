// UX-5A layout-shift gate (owner, 13 Oct 2026: "the layout jumps after clicks"). On the production build with the
// synthetic API: pages do not move while they load (layout shift ≤ LOAD_LIMIT), and the clicks people make every day
// do not move anything outside the drawer or popover they open (≤ CLICK_LIMIT): opening and saving a side drawer,
// asking to work on a day off, Ctrl+K, a tab. Shifts inside dialogs, popovers and Pip's island are allowed (they are what
// appears). The rules are tests/e2e/layout-shift.mjs; ux5a-shots.mjs applies the same gate to every screenshot.
import { expect, test, type Page } from "@playwright/test";
import { CLICK_LIMIT, LOAD_LIMIT, SHIFTS, SHIFT_RECORDER, settleShifts } from "./layout-shift.mjs";

test.skip(Boolean(process.env.PULSE_BASE_URL), "Runs on the synthetic build.");
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const SIZES = [[1440, 900], [390, 844]] as const;

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "load" });
  await page.waitForFunction(() => { const m = document.querySelector("main"); return !!m && m.innerText.trim().length > 10 && !m.querySelector("[aria-busy='true']"); }, undefined, { timeout: 30_000 });
  await settleShifts(page, 900, 8000);
}
const describe = (r: { score: number; shifts: { value: number; where: string[] }[] }) => `${r.score}: ${r.shifts.slice(0, 4).map((s) => `${s.value} ${s.where.join(", ")}`).join(" | ")}`;
/** The shifts after `act`, until the page is quiet. */
async function after(page: Page, act: () => Promise<unknown>) {
  const t = await page.evaluate(() => performance.now());
  await act();
  await settleShifts(page);
  return page.evaluate(SHIFTS, { since: t, all: true });
}

test.beforeEach(async ({ context }) => { await context.addInitScript(SHIFT_RECORDER); });

for (const route of ["/dashboard", "/me", "/me?tab=attendance", "/me?tab=leave", "/tasks", "/people", "/hr", "/hr?tab=approvals", "/settings"]) {
  test(`nothing moves while it loads: ${route}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setExtraHTTPHeaders(admin);
    const problems: string[] = [];
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await open(page, route);
      const load = await page.evaluate(SHIFTS, { since: 0 });
      if (load.score > LOAD_LIMIT) problems.push(`${width}: ${describe(load)}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}

test("a side drawer opens, closes and saves without moving the page", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await open(page, "/me?tab=requests");
    const opened = await after(page, () => page.getByRole("button", { name: "Raise a request" }).first().click());
    expect(opened.score, `open at ${width}: ${describe(opened)}`).toBeLessThanOrEqual(CLICK_LIMIT);
    const drawer = page.getByRole("dialog", { name: "Raise a request with HR" });
    await expect(drawer).toBeVisible();
    // An error appears in the footer's reserved line, not above the fields.
    const empty = await after(page, () => drawer.getByRole("button", { name: "Send to HR" }).click());
    expect(empty.score, `invalid send at ${width}: ${describe(empty)}`).toBeLessThanOrEqual(CLICK_LIMIT);
    const closed = await after(page, () => page.keyboard.press("Escape"));
    expect(closed.score, `close at ${width}: ${describe(closed)}`).toBeLessThanOrEqual(CLICK_LIMIT);
    await expect(drawer).toHaveCount(0);
  }
});

test("asking to work on a day off is an action, not a block, and nothing moves", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await open(page, "/me?tab=attendance");
  await expect(page.getByRole("heading", { name: "Working on a day off?" })).toHaveCount(0);
  const action = page.getByRole("button", { name: "Work on a day off…" });
  if (!(await action.count())) test.skip(true, "No day-off calendar in this fixture");
  const opened = await after(page, () => action.click());
  expect(opened.score, describe(opened)).toBeLessThanOrEqual(CLICK_LIMIT);
  const drawer = page.getByRole("dialog", { name: "Working on a day off?" });
  await expect(drawer).toBeVisible();
  // The fixture may have no weekly off ahead: the button then says "Choose a day" and stays off.
  const asked = await after(page, async () => { const go = drawer.getByRole("button", { name: /^I'll work on|^Choose a day/ }); if (await go.isEnabled()) await go.click(); });
  expect(asked.score, describe(asked)).toBeLessThanOrEqual(CLICK_LIMIT);
});

test("Ctrl+K opens over the page and its results never move the page", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await open(page, "/dashboard");
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"));
  const opened = await after(page, async () => {
    await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.getByRole("dialog", { name: "Search Pulse" })).toBeVisible({ timeout: 1000 }); }).toPass();
  });
  expect(opened.score, describe(opened)).toBeLessThanOrEqual(CLICK_LIMIT);
  const typed = await after(page, () => page.getByRole("dialog", { name: "Search Pulse" }).getByRole("combobox").pressSequentially("office", { delay: 30 }));
  expect(typed.score, describe(typed)).toBeLessThanOrEqual(CLICK_LIMIT);
});

test("switching tabs on My desk does not shift the header or tabs", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  // Owner workbench (21 Oct 2026): My desk's tabs are five groups. Today's header has no context line (the hero below
  // greets the person), the other groups name the person in it; switching between those must not move anything.
  await open(page, "/me?tab=attendance");
  const moved = await after(page, () => page.getByRole("navigation", { name: "My desk", exact: true }).getByRole("link", { name: /^Growth/ }).click());
  // A new tab's content arrives; the shell, header and tab bar above it stay where they are.
  const above = moved.shifts.filter((s) => s.where.some((w) => /^(header|nav|h1)/.test(w)));
  expect(above, describe(moved)).toEqual([]);
});
