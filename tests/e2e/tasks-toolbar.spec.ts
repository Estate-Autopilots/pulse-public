import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Exercise the production page and view CSS without API data or a Next build.
// Preserve CSS Modules' class isolation when loading the sources in the browser.
const scoped = (path: string, prefix: string) => readFileSync(resolve(__dirname, path), "utf8").replace(/\.([a-zA-Z_][\w-]*)/g, `.${prefix}-$1`);
const pageCss = scoped("../../apps/web/app/ui.module.css", "ui");
const viewsCss = scoped("../../apps/web/app/tasks/views/views.module.css", "work");

for (const width of [1180, 1366, 1440]) {
  test(`Work's sticky toolbar leaves no strip for scrolling rows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.setContent(`
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; --theme-canvas: #f6f6fa; --theme-surface: white; --theme-border: #ccc; }
        main { height: calc(100vh - 48px); }
        .topbar { height: 48px; }
        ${pageCss}
        ${viewsCss}
      </style>
      <div class="topbar">Top bar</div>
      <main><div class="ui-page">
        <header style="height: 100px">Work</header>
        <div data-work-controls style="display: contents">
          <div class="work-views">
            <div class="work-toolbar" role="toolbar" aria-label="View"><button>Me / Company / A person</button></div>
            <div class="work-body"><div class="work-tableWrap"><table class="work-table">
              <thead><tr><th scope="col">Task</th></tr></thead>
              <tbody>${Array.from({ length: 48 }, (_, i) => `<tr><td>Synthetic task ${i + 1}</td></tr>`).join("")}</tbody>
            </table></div></div>
          </div>
        </div>
      </div></main>`);
    const bar = page.getByRole("toolbar", { name: "View" });
    const views = page.locator(".work-views");
    // TaskViews measures this same height with ResizeObserver in the application.
    await views.evaluate((el) => el.style.setProperty("--work-bar", `${el.querySelector('[role="toolbar"]')!.getBoundingClientRect().height}px`));
    const scrollport = page.locator(".ui-page");
    const top = (await scrollport.boundingBox())!.y;
    for (const scrollTop of [250, 500, 750]) {
      await scrollport.evaluate((el, y) => { el.scrollTop = y; }, scrollTop);
      await expect.poll(() => bar.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(top, 0);
      const barBottom = await bar.evaluate((el) => el.getBoundingClientRect().bottom);
      await expect.poll(() => page.getByRole("columnheader").evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(barBottom, 0);
    }
  });
}
