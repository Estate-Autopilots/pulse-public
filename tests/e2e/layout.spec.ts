// LAYOUT-SWEEP gate (owner, 11 Oct 2026: "nothing hidden, nothing clipped"): at 1366×768, 1440×900, 1920×1080, 768 and
// 390 px no page has text or a control covered by something else, boxes drawn over each other, content spilling out
// of its card, content cut off or out of reach, a page wider than the window, a scroll area too small to use, or the
// end of a scroll area stuck under a bar. The rules are tests/e2e/layout-audit.mjs; real data is swept by
// tests/e2e/layout-sweep.mjs.
import { expect, test } from "@playwright/test";
import { BLOCKING, SIZES, auditLayout, settle } from "./layout-audit.mjs";

test.skip(Boolean(process.env.PULSE_BASE_URL), "Runs on the synthetic build; real data is swept by layout-sweep.mjs.");

const ROUTES = ["/dashboard", "/people", "/me", "/me?tab=attendance", "/me?tab=leave", "/me?tab=policies", "/hr", "/hr?tab=approvals",
  "/hr?tab=attendance", "/hr?tab=leave", "/hr?tab=policies", "/finance", "/designers", "/brand", "/settings"];

for (const route of ROUTES) {
  test(`nothing covered, cut off or out of reach: ${route}`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
    const problems: string[] = [];
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await page.goto(route, { waitUntil: "load" });
      await page.waitForFunction(() => { const m = document.querySelector("main"); return !!m && m.innerText.trim().length > 10 && !m.querySelector("[aria-busy='true']"); }, undefined, { timeout: 30_000 });
      await settle(page, 400);
      const { findings } = await page.evaluate(auditLayout, {});
      for (const f of findings) if (BLOCKING.includes(f.rule)) problems.push(`${width}×${height} ${f.rule}: ${f.where} — ${f.detail}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
