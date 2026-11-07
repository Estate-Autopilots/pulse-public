import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

test.skip(process.env.PULSE_AI_COUNTS_CONTRACT !== "1", "Uses the isolated synthetic counts overlay");
for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`People and AI stay separate: ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const [route, label] of [["/hr", "HR desk"], ["/leadership", "Team"], ["/dashboard?mode=max", "Team"]]) {
        await page.goto(route);
        const surface = route === "/hr" ? page.locator("[data-page-header]").filter({ has: page.getByRole("heading", { name: label, exact: true }) })
          : page.locator("a").filter({ has: page.getByText(label, { exact: true }) }).filter({ has: page.getByRole("img", { name: "AI employee", exact: true }) });
        await expect(surface).toBeVisible();
        await expect(surface.getByRole("img", { name: "AI employee", exact: true })).toBeVisible();
        await expect(surface).toContainText(/People \d+\s*AI\s*3/, { useInnerText: true });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await surface.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        const split = surface.locator("[data-people-count]");
        // Each line's leading separator is fully outside the clipping box. At phone
        // width, constrain the count to exercise the wrapped case on every surface.
        if (width === 390) await split.evaluate(el => {
          const first = el.firstElementChild!.firstElementChild!;
          el.style.maxWidth = `${first.getBoundingClientRect().width - parseFloat(getComputedStyle(first, "::before").width) + 1}px`;
        });
        const lines = await split.evaluate(el => {
          const clip = el.getBoundingClientRect(), groups = [...el.firstElementChild!.children];
          return groups.map(group => {
            const box = group.getBoundingClientRect();
            const separator = getComputedStyle(group, "::before");
            return { left: box.left - clip.left, top: box.top, separatorEnd: box.left + parseFloat(separator.width) - clip.left, separator: separator.content };
          });
        });
        expect(lines.every(line => line.separator === '"·"')).toBe(true);
        const firstOnLine = lines.filter((line, i) => i === 0 || line.left < lines[i - 1].left + 1);
        if (width === 390) expect(firstOnLine).toHaveLength(2);
        expect(firstOnLine.every(line => line.separatorEnd <= 1)).toBe(true);
        await split.evaluate(el => { el.style.removeProperty("max-width"); });
        if (route.startsWith("/dashboard")) {
          const tiles = page.getByRole("region", { name: "Key numbers", exact: true }).locator(":scope > a");
          await expect(tiles).toHaveCount(6);
          await expect(surface).toHaveAttribute("href", "/hr");
          await expect(surface).toContainText("0 in today · 0 on leave");
          if (width === 1440) {
            const tops = await tiles.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)));
            expect(new Set(tops).size).toBe(1);
          }
        }
        if (process.env.PULSE_SCREENSHOT_DIR) {
          await mkdir(process.env.PULSE_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.PULSE_SCREENSHOT_DIR, `ai-counts-${route.slice(1).split("?")[0]}-${theme}-${width}.png`) });
        }
      }
    });
  }
}
test("zero is a count; unavailable AI totals are not invented", async ({ page }) => {
  for (const [email, showAi] of [["zero@counts.example.test", true], ["legacy@counts.example.test", false]] as const) {
    await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email });
    await page.goto("/hr");
    const header = page.locator("[data-page-header]").filter({ has: page.getByRole("heading", { name: "HR desk", exact: true }) });
    await expect(header).toContainText("People 2");
    await expect(header.getByRole("img", { name: "AI employee", exact: true })).toHaveCount(showAi ? 1 : 0);
    if (showAi) await expect(header).toContainText(/AI\s*0/, { useInnerText: true });
  }
});
test("dashboard keeps six tiles and the Team link when attendance is off", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@northwind.example" });
  // OWNER-HOME: the six tiles are the dashboard's Max view; Focus is the default.
  await page.goto("/dashboard?mode=max");
  const numbers = page.getByRole("region", { name: "Key numbers", exact: true });
  await expect(numbers.locator(":scope > a")).toHaveCount(6);
  const team = numbers.getByRole("link").filter({ has: page.getByText("Team", { exact: true }) });
  await expect(team).toHaveAttribute("href", "/people");
  await expect(team).toContainText("Human and AI employees");
  await expect(team).toContainText(/People 2\s*AI\s*3/, { useInnerText: true });
});
