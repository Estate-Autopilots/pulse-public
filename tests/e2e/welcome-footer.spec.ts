import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// BUG-ONBOARD (EA user, 6 Nov 2026, on /welcome: "i zoomed in the screen till 50%", "there is no option of skip, next or
// back"): every step of the first run shows Back, its own way forward and "Skip for now" (or, on a step Pulse needs
// before it opens, why it can't be skipped plus Sign out and Get help) inside the window and not covered by anything.
// Browser zoom is emulated as the CSS viewport it leaves: 200% on a 1440 x 700 window is 720 x 350.
test.skip(process.env.PULSE_WELCOME_FOOTER_CONTRACT !== "1", "run with welcome-footer.config.ts for the synthetic first run");

const shots = process.env.WELCOME_FOOTER_SHOTS; if (shots) mkdirSync(shots, { recursive: true });
type Who = "held" | "owner" | "open";
const STEPS: Record<Who, string[]> = {
  held: ["welcome", "details", "work", "bank", "documents", "done"],
  owner: ["welcome", "details", "work", "bank", "documents", "done"],
  open: ["welcome", "details", "work", "bank", "documents", "app", "notifications", "consent", "done"],
};
const SCREENS = [
  { name: "390x600", width: 390, height: 600, scale: 2, who: ["held", "owner", "open"] as Who[] },
  { name: "1440x700", width: 1440, height: 700, scale: 1, who: ["held", "owner", "open"] as Who[] },
  { name: "1440x700-zoom50", width: 2880, height: 1400, scale: 1, who: ["held"] as Who[] },
  { name: "1440x700-zoom200", width: 720, height: 350, scale: 2, who: ["held", "open"] as Who[] },
  { name: "390x600-zoom200", width: 195, height: 300, scale: 2, who: ["held"] as Who[] },
];

/** In the window and the topmost thing at its centre (nothing drawn over it). */
async function onScreen(page: Page, target: Locator, label: string) {
  await expect(target, `${label} is shown`).toBeVisible();
  const box = await target.boundingBox();
  const view = page.viewportSize()!;
  expect(box, `${label} has a box`).not.toBeNull();
  expect(box!.y, `${label} starts inside the window`).toBeGreaterThanOrEqual(0);
  expect(box!.x, `${label} starts inside the window`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${label} ends inside the window (${view.height})`).toBeLessThanOrEqual(view.height + 0.5);
  expect(box!.x + box!.width, `${label} ends inside the window (${view.width})`).toBeLessThanOrEqual(view.width + 0.5);
  const top = await target.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && (hit === el || el.contains(hit)); });
  expect(top, `${label} is not covered`).toBe(true);
}

for (const screen of SCREENS) for (const who of screen.who) {
  test(`${who}: every step's footer is on screen at ${screen.name}`, async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": `${who}@welcome-footer.example` },
      viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.scale, reducedMotion: "reduce" });
    const page = await context.newPage();
    for (const step of STEPS[who]) {
      await page.goto(`/welcome?step=${step}`);
      const card = page.locator("section[aria-label]").filter({ has: page.locator("[data-step-foot]") });
      await expect(card).toHaveCount(1, { timeout: 60_000 });
      const foot = card.locator("[data-step-foot]");
      await page.waitForTimeout(150);
      const label = `${who} ${screen.name} ${step}`;
      await onScreen(page, foot.locator('[class*="wide"]').first(), `${label}: the way forward`);
      if (step !== "welcome") await onScreen(page, foot.getByRole("button", { name: "Back", exact: true }), `${label}: Back`);
      const held = who === "held" && step !== "documents" && step !== "done";
      if (held) {
        await expect(foot).toContainText("can’t be skipped");
        await onScreen(page, foot.getByRole("button", { name: "Sign out", exact: true }), `${label}: Sign out`);
        await onScreen(page, foot.getByRole("button", { name: "Get help", exact: true }), `${label}: Get help`);
      } else if (step !== "done") {
        await onScreen(page, foot.getByText("Skip for now", { exact: true }), `${label}: Skip for now`);
      }
      // The page itself never needs scrolling to reach the footer (a very short window keeps it stuck to the bottom).
      if (shots && (screen.name === "390x600" || screen.name === "1440x700" || step === "welcome" || step === "details")) {
        await page.screenshot({ path: join(shots, `${screen.name}-${who}-${step}.png`) });
      }
    }
    await context.close();
  });
}

test("held at 390x600: Next and Back move between steps from the footer", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": "held@welcome-footer.example" },
    viewport: { width: 390, height: 600 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/welcome?step=welcome");
  await page.getByRole("button", { name: /Set up my profile/ }).click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible({ timeout: 30_000 });
  await page.locator("[data-step-foot]").getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Welcome to Pulse/ })).toBeVisible();
  await context.close();
});
