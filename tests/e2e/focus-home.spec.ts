import { expect, test, type Locator, type Page } from "@playwright/test";
import { think } from "../../apps/web/app/home/brain";
import { LOAD_LIMIT, SHIFT_RECORDER, SHIFTS, settleShifts } from "./layout-shift.mjs";

test.skip(process.env.PULSE_FOCUS_HOME_CONTRACT !== "1", "run with focus-home.config.ts for the isolated synthetic fixtures");
const headers = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const channel = "11111111-1111-4111-8111-111111111111";
for (const docked of [false, true]) test(`My desk reserves Pip room before hydration: ${docked ? "docked" : "free"}`, async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: headers, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  if (docked) await context.addCookies([{ name: "pulse.pip.dock", value: "1", domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript(SHIFT_RECORDER);
  const page = await context.newPage();
  await page.goto("/me", { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector('[data-island][data-placed]'));
  await settleShifts(page, 900, 8000);
  expect((await page.evaluate(SHIFTS, { since: 0 })).score).toBeLessThanOrEqual(LOAD_LIMIT);
  await context.close();
});
async function ready(page: Page) {
  await page.waitForFunction(() => document.querySelector('[data-island][data-home="free"][data-placed]'));
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  test(`Focus sheet focus lifecycle and Later at ${width} ${theme}`, async ({ browser }, info) => {
    const context = await browser.newContext({ extraHTTPHeaders: headers, viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
    const page = await context.newPage();
    await page.goto("/dashboard"); await ready(page);
    const region = page.getByRole("region", { name: "Next up" });
    const title = region.locator('[class*="nextTitle"]').first();
    const before = await title.innerText();
    const later = region.getByRole("button", { name: "Later", exact: true });
    await later.scrollIntoViewIfNeeded(); await uncovered(later);
    await page.screenshot({ path: info.outputPath(`focus-${width}-${theme}.png`) });
    await later.click(); await expect(title).not.toHaveText(before);
    const afterClick = await title.innerText(); await later.focus(); await page.keyboard.press("Enter");
    await expect(title).not.toHaveText(afterClick); await expect(page).toHaveURL(/\/dashboard$/);
    const opener = page.getByRole("region", { name: "At a glance" }).getByRole("button").first();
    await opener.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(":focus")).toHaveCount(1);
    const controls = dialog.locator('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
    await controls.first().focus(); await page.keyboard.press("Shift+Tab");
    await expect(controls.last()).toBeFocused();
    await page.keyboard.press("Tab"); await expect(controls.first()).toBeFocused();
    // The modal background cannot steal focus, even via a programmatic focus request.
    await opener.evaluate((el) => (el as HTMLElement).focus());
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`focus-sheet-${width}-${theme}.png`) });
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    await page.keyboard.press("c");
    await expect(page.getByRole("textbox", { name: "What do you want to create?" })).toBeFocused();
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0); await expect(opener).toBeFocused();
    await context.close();
  });
}
async function uncovered(control: Locator) {
  await expect(control).toBeVisible();
  expect(await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const p = document.querySelector('[data-island][data-home="free"] [data-pip]')?.getBoundingClientRect();
    return { inWindow: r.top >= 0 && r.bottom <= innerHeight + 1,
      overlapsPip: !!p && r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top,
      onTop: [[.1, .5], [.5, .5], [.9, .5]].every(([x, y]) => el.contains(document.elementFromPoint(r.left + r.width * x, r.top + r.height * y))) };
  })).toEqual({ inWindow: true, overlapsPip: false, onTop: true });
}

for (const input of ["mouse", "touch"] as const) test(`Next up buttons respond to ${input}, while the card still swipes`, async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: headers, viewport: input === "touch" ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: input === "touch", reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/dashboard"); await ready(page);
  const region = page.getByRole("region", { name: "Next up" });
  const title = region.locator('[class*="nextTitle"]').first();
  const before = await title.innerText();
  const later = region.getByRole("button", { name: "Later", exact: true });
  if (input === "touch") await later.tap(); else await later.click();
  await expect(title).not.toHaveText(before);
  const action = region.getByRole("button").first();
  if (input === "touch") await action.tap(); else await action.click();
  await expect(page).not.toHaveURL(/\/dashboard(?:\?|$)/);
  if (input === "mouse") {
    await page.goto("/dashboard"); await ready(page);
    await sheetReady(page);
    const previous = await title.innerText();
    const box = await title.boundingBox();
    await page.mouse.move(box!.x + box!.width - 10, box!.y + 10); await page.mouse.down();
    await page.mouse.move(box!.x + box!.width - 150, box!.y + 10, { steps: 8 }); await page.mouse.up();
    await expect(title).not.toHaveText(previous);
  }
  await context.close();
});

test("named attendance entries use the neutral semantic tone", async ({ request }) => {
  const home = await (await request.get("/api/v0/home", { headers })).json();
  const brief = think({ me: null, live: null, insights: null, tasks: null, home });
  const people = brief.glance.find((g) => g.id === "people")!;
  expect(people.sheet.rows.length).toBeGreaterThan(0);
  expect(people.sheet.rows.every((r) => r.tone === "info")).toBe(true);
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  for (const screen of ["max", "hr", "chats"] as const) test(`${screen} content stays clear of Pip at ${width} ${theme}`, async ({ browser }, info) => {
    const context = await browser.newContext({ extraHTTPHeaders: headers, viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
    const page = await context.newPage();
    await page.goto(screen === "max" ? "/dashboard?mode=max" : screen === "hr" ? "/hr" : `/chats?channel=${channel}`);
    await ready(page);
    if (screen === "chats") {
      const log = page.getByRole("log", { name: "Messages" });
      await expect(log.getByText("Synthetic message 24", { exact: true })).toBeVisible();
      const field = page.getByRole("textbox", { name: "Message Synthetic review", exact: true });
      await field.fill(`Synthetic ${width} ${theme} send`);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("pulse:arrival", { detail: { id: "synthetic-compose-arrival", title: "A synthetic message arrived", href: "/chats" } })));
      await expect(page.locator('[data-island][data-home="free"]')).toHaveAttribute("data-open", "");
      await expect(page.locator("[data-island-content]")).toBeHidden();
      await uncovered(field); await uncovered(page.getByRole("button", { name: "Send", exact: true }));
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await uncovered(log.getByText(`Synthetic ${width} ${theme} send`, { exact: true }));
    } else {
      if (screen === "hr") for (const name of ["Synthetic Leela Menon", "Synthetic Dev Malhotra"]) {
        const row = page.getByText(name, { exact: true }).filter({ visible: true }).last();
        await row.scrollIntoViewIfNeeded({ timeout: 10_000 }); await uncovered(row);
      }
      const last = page.locator("main a:visible, main button:visible").last();
      await last.scrollIntoViewIfNeeded({ timeout: 10_000 }); await uncovered(last);
    }
    if (width === 1440 && screen === "max") {
      // Calm Max scrolls inside the shell; its ending gutter, rather than the old panel's side reserve, clears Pip.
      expect(await page.locator('[data-max][class*="column"]').evaluate((el) => {
        const root = el.parentElement!.parentElement!;
        return getComputedStyle(root).overflowY === "auto" && root.scrollTop > 0 && parseFloat(getComputedStyle(root, "::after").height) > 0;
      })).toBe(true);
    } else if (width === 1440) {
      // Reserve width beside panels, preserving the full window height for their scrollers.
      expect(await page.locator("main [data-fit]").evaluate((el) => {
        const pip = document.querySelector('[data-island] [data-pip]')!.getBoundingClientRect();
        return [...el.children].filter((c) => !c.matches("header")).every((c) => c.getBoundingClientRect().right <= pip.left - 4);
      })).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`${screen}-${width}-${theme}.png`), fullPage: false });
    await context.close();
  });
}

// A modal round trip proves CalmHome's streamed client boundary has hydrated (Pip is a separate boundary).
async function sheetReady(page: Page) {
  await page.locator('section[aria-label="Key numbers"], section[aria-label="At a glance"]').getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

for (const width of [390, 1440]) for (const theme of ["light", "dark"] as const) test(`Max presentation and keyboard sheet at ${width} ${theme}`, async ({ browser }, info) => {
  const context = await browser.newContext({ extraHTTPHeaders: headers, viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: "reduce" });
  await context.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
  const page = await context.newPage(); await page.goto("/dashboard?mode=max"); await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-pulse-focus", "");
  await expect(page.getByRole("group", { name: "Dashboard mode" })).toHaveAttribute("data-mode", "max");
  await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`max-home-${width}-${theme}.png`) });
  const opener = page.getByRole("region", { name: "Key numbers" }).getByRole("button").first();
  await opener.click(); const sheet = page.getByRole("dialog"); await expect(sheet).toBeVisible();
  await page.keyboard.press("9"); await expect(page).toHaveURL(/mode=max/);
  const controls = sheet.locator('button:not(:disabled), a[href]');
  await controls.first().focus(); await page.keyboard.press("Shift+Tab"); await expect(controls.last()).toBeFocused();
  await page.screenshot({ path: info.outputPath(`max-sheet-${width}-${theme}.png`) });
  await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); await expect(opener).toBeFocused();
  const end = page.getByRole("navigation", { name: "Deeper views" }).getByRole("link").last();
  await end.scrollIntoViewIfNeeded(); await uncovered(end);
  await page.screenshot({ path: info.outputPath(`max-end-${width}-${theme}.png`) });
  await context.close();
});

test("Max keys follow the visible queue and yield to controls, input and other modals; F and remembered modes agree", async ({ page, request }) => {
  await page.setExtraHTTPHeaders(headers); await page.emulateMedia({ reducedMotion: "reduce" });
  const get = async (path: string) => { const r = await request.get(`/api/v0/${path}`, { headers }); return r.ok() ? r.json() : null; };
  const [me, live, home, insights, tasks] = await Promise.all(["me", "finance/live", "home", "insights", "tasks/home"].map(get));
  const brief = think({ me, live: live?.model ?? null, home, insights, tasks });
  expect(brief.queue).toHaveLength(9);
  for (const [i, move] of brief.queue.entries()) {
    await page.goto("/dashboard?mode=max"); await ready(page); await sheetReady(page);
    await expect(page.getByRole("region", { name: "Up next", exact: true }).getByRole("button").nth(i)).toContainText(move.title);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press(String(i + 1)); await expect(page).toHaveURL(new URL(move.href, page.url()).href);
  }
  await page.goto("/dashboard?mode=max"); await ready(page);
  await page.getByRole("region", { name: "Up next", exact: true }).getByRole("button").first().focus();
  await page.keyboard.press("1"); await expect(page).toHaveURL(/mode=max/);
  // Native/select, editable and ARIA controls keep numeric keys, as does another modal.
  for (const html of ['<input>', '<textarea>', '<select><option>One</option></select>', '<div contenteditable="true" tabindex="0"></div>', '<div role="slider" tabindex="0"></div>', '<dialog open><button>Other modal</button></dialog>']) {
    await page.evaluate((markup) => { const box = document.createElement("div"); box.id = "synthetic-key-owner"; box.innerHTML = markup; document.body.append(box); (box.querySelector("button, input, textarea, select, [tabindex]") as HTMLElement).focus(); }, html);
    await page.keyboard.press("1"); await expect(page).toHaveURL(/mode=max/);
    await page.evaluate(() => document.getElementById("synthetic-key-owner")?.remove());
  }
  await page.keyboard.press("f"); await expect(page.getByRole("region", { name: "At a glance" })).toBeVisible();
  await page.goto("/dashboard"); await expect(page.getByRole("group", { name: "Dashboard mode" })).toHaveAttribute("data-mode", "focus");
  await page.keyboard.press("f"); await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
  await page.goto("/dashboard"); await expect(page.getByRole("group", { name: "Dashboard mode" })).toHaveAttribute("data-mode", "max");
  await page.goto("/dashboard?mode=focus"); await expect(page.getByRole("region", { name: "At a glance" })).toBeVisible();
  await page.goto("/dashboard?classic=1"); await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
  await page.getByRole("navigation", { name: "Deeper views" }).getByRole("link", { name: "Delivery" }).click();
  await expect(page).toHaveURL(/tab=delivery/); await expect(page.getByRole("region", { name: "Key numbers" })).toHaveCount(0);
});
