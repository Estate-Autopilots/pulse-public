import { expect, test, type Page } from "@playwright/test";

test.skip(!process.env.PULSE_REAL_SMOKE, "Uses the live dev map and the real EA seed");
test.use({ actionTimeout: 10_000, launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

/** Nothing under 12 px, no page scroll, no list that shows fewer than six rows when it has more. */
async function assertFit(page: Page, phone: boolean) {
  const r = await page.evaluate((phone) => {
    const root = document.querySelector('[aria-label="Pulse Map workspace"]')!;
    const small: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (el.closest(".maplibregl-ctrl, .maplibregl-canvas-container, .maplibregl-marker, svg")) continue;
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own || !el.offsetParent || el.closest('[aria-hidden="true"]')) continue;
      const box = el.getBoundingClientRect(); if (box.width < 2 || box.height < 2) continue;
      const size = parseFloat(getComputedStyle(el).fontSize); if (size < 12) small.push(`${el.textContent!.trim().slice(0, 30)} ${size}px`);
    }
    const cramped: string[] = [];
    if (!phone) for (const pager of Array.from(root.querySelectorAll<HTMLElement>("[data-pager]"))) {
      if (!pager.offsetParent) continue;
      const items = Array.from(pager.querySelectorAll("[data-items] > li"));
      const shown = items.filter((li) => (li as HTMLElement).offsetParent).length;
      if (shown < Math.min(6, items.length)) cramped.push(`${shown} of ${items.length}`);
    }
    return { w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, small, cramped };
  }, phone);
  expect(r.sw).toBeLessThanOrEqual(r.w); expect(r.sh).toBeLessThanOrEqual(r.h);
  expect(r.small, "text under 12 px").toEqual([]);
  expect(r.cramped, "lists showing fewer than six rows").toEqual([]);
  const mapBox = await page.locator(".maplibregl-canvas").boundingBox(); expect(mapBox!.height).toBeGreaterThan(200);
}

for (const [width, height] of [[1920, 860], [1366, 650], [390, 760]]) for (const theme of ["light", "dark"] as const) {
  test(`Map app ${width}×${height} ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    const phone = width < 700;
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => localStorage.setItem("pulse.theme", value), theme);
    // The sign-in header goes to Pulse only, never to the tile hosts.
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin === new URL(process.env.PULSE_BASE_URL!).origin) await route.continue({ headers: { ...route.request().headers(), "cf-access-authenticated-user-email": "admin@estateautopilots.com" } });
      else await route.continue();
    });
    // Hydration warnings come from the shared shell, which this spec does not own.
    const errors: string[] = []; page.on("pageerror", (e) => { if (!/Hydration/.test(e.message)) errors.push(e.message); });
    await page.goto("/map", { waitUntil: "networkidle" });
    const ws = page.locator('[aria-label="Pulse Map workspace"]');
    await expect(ws).toBeVisible();
    await expect(page.getByText("Opening the map…")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("The base map could not load.", { exact: false })).toHaveCount(0);
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByText("527 projects · 42 without a point").filter({ visible: true }).first()).toBeVisible();
    if (!phone) await expect(page.locator("#main-content").getByRole("heading", { name: "Map", exact: true })).toBeVisible();
    await page.waitForTimeout(1800);
    await assertFit(page, phone);

    const openPanel = async () => { if (phone && await page.getByRole("button", { name: "Show analysis", exact: true }).count()) await page.getByRole("button", { name: "Show analysis", exact: true }).click(); };
    const foldPanel = async () => { if (phone && await page.getByRole("button", { name: "Hide analysis", exact: true }).count()) await page.getByRole("button", { name: "Hide analysis", exact: true }).click(); };

    // Analysis tabs and their sub-tabs.
    await openPanel();
    await expect(page.getByRole("tab", { name: "Places", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Half of the work sits in", { exact: false })).toBeVisible();
    await page.getByRole("tab", { name: "Markets", exact: true }).click();
    await assertFit(page, phone);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeEnabled();
    await page.getByRole("tab", { name: "Patterns", exact: true }).click();
    await expect(page.getByRole("button", { name: /Moshi: 30 projects/ })).toBeVisible();
    await assertFit(page, phone);
    await page.getByRole("tab", { name: "Growth", exact: true }).click();
    await expect(page.getByRole("img", { name: /Engagements started per month/ })).toBeVisible();
    await page.getByRole("tab", { name: "Money", exact: true }).click();
    // R55: money is on the map for leadership with finance access, which this login holds on dev.
    await expect(page.getByText("On the map", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Money is not connected yet")).toHaveCount(0);
    await assertFit(page, phone);
    await page.getByRole("tab", { name: "Pins", exact: true }).click();
    await expect(page.getByText("498", { exact: true }).first()).toBeVisible();
    if (!phone) {
      await page.getByRole("button", { name: "Focus mode", exact: true }).click();
      const [panel, box] = [await page.getByRole("complementary", { name: "Map analysis" }).boundingBox(), await ws.boundingBox()];
      await page.waitForTimeout(500);
      expect((await page.getByRole("complementary", { name: "Map analysis" }).boundingBox())!.width).toBeGreaterThan(Math.min(box!.width * 0.5, 760) - 2);
      expect(panel).not.toBeNull();
      await assertFit(page, phone);
      await page.getByRole("button", { name: "Exit focus mode", exact: true }).click();
    }
    await page.getByRole("tab", { name: /^No point/ }).click();
    await assertFit(page, phone);

    // Fix pin: drag, validate, cancel. Nothing is saved.
    await page.getByRole("button", { name: "Fix pin", exact: true }).first().click();
    await expect(page.getByRole("textbox", { name: "Pin coordinates or Maps link" })).toBeVisible();
    await page.waitForTimeout(1500);
    const beforeDrag = await page.getByRole("textbox", { name: "Pin coordinates or Maps link" }).inputValue();
    const marker = await page.locator('[aria-label="Drag to the site"]').boundingBox();
    await page.mouse.move(marker!.x + marker!.width / 2, marker!.y + marker!.height / 2);
    await page.mouse.down(); await page.mouse.move(marker!.x + marker!.width / 2 + 35, marker!.y + marker!.height / 2 - 30, { steps: 8 }); await page.mouse.up();
    await expect(page.getByRole("textbox", { name: "Pin coordinates or Maps link" })).not.toHaveValue(beforeDrag);
    await page.getByRole("textbox", { name: "Pin coordinates or Maps link" }).fill("91,73");
    await page.getByRole("button", { name: "Save pin", exact: true }).click();
    await expect(ws.getByRole("alert")).toHaveText(/Enter valid latitude/);
    await page.getByRole("button", { name: "Cancel pin correction" }).click();
    await foldPanel();

    // Search, a market, a project card and its tabs, catchment rings.
    await page.getByRole("searchbox", { name: "Search projects, clients or places" }).fill("Moshi");
    await page.getByRole("button", { name: /Moshi.*30 projects/ }).click();
    await openPanel();
    await expect(page.getByRole("heading", { name: "Moshi", exact: true })).toBeVisible();
    await page.getByRole("complementary", { name: "Map analysis" }).locator("button").filter({ has: page.locator("[data-precision]") }).filter({visible:true}).first().click();
    await openPanel();
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByText(/within 2 km/).first()).toBeVisible();
    for (const name of ["Nearby", "Contacts", "Work", "Pin"] as const) { await page.getByRole("tab", { name, exact: true }).click(); await expect(page.getByRole("tabpanel")).toBeVisible(); await assertFit(page, phone); }
    await page.getByRole("tab", { name: "Nearby", exact: true }).click();
    await expect(page.getByRole("tab", { name: /^10 km/ })).toBeVisible();
    await expect(page.getByText(/2, 5 and 10 km around/).first()).toBeVisible({ visible: !phone });
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Analysis", exact: true }).click();
    await foldPanel();

    // Filters.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await openPanel();
    await page.getByRole("tab", { name: "Segment", exact: true }).click();
    await page.getByRole("checkbox", { name: "Residential", exact: true }).check();
    await page.getByRole("button", { name: "Show results" }).click();
    await page.getByRole("button", { name: "Clear filters & months" }).click();
    await foldPanel();

    // Layers: every data layer (R55: clients, money, shoots and prices too), the 3D tilt, base maps; satellite waits for
    // a provider; travel time is an estimate drawn from the office.
    for (const name of ["Heatmap", "Hexagons", "Market areas", "Market centres", "Clients", "Money", "Shoots", "Prices", "Projects"]) {
      await page.getByRole("button", { name: "Layers", exact: true }).click();
      await page.getByRole("radio", { name, exact: true }).click();
      await expect(page.getByRole("radio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
      if (name === "Hexagons") await page.getByRole("switch", { name: "3D towers" }).check();
      if (name === "Market areas") await expect(page.getByText(/Nearest-centre areas within 3 km/)).toBeVisible({ visible: !phone });
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    }
    await page.getByRole("button", { name: "Layers", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Satellite", exact: true })).toBeDisabled();
    await page.getByRole("switch", { name: "Travel time" }).check();
    await page.getByRole("switch", { name: "White space" }).check();
    if (!phone) await expect(page.getByText(/90 min from .*, estimated/).first()).toBeVisible();
    await page.getByRole("switch", { name: "Travel time" }).uncheck();
    await page.getByRole("switch", { name: "White space" }).uncheck();
    await page.getByRole("radio", { name: "Relief", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Relief", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: theme === "dark" ? "Streets dark" : "Streets light", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);

    // Measure.
    await page.getByRole("button", { name: "Measure distance", exact: true }).click();
    const canvas = await page.locator(".maplibregl-canvas").boundingBox();
    await page.mouse.click(canvas!.x + canvas!.width * 0.3, canvas!.y + canvas!.height * 0.4);
    await page.mouse.click(canvas!.x + canvas!.width * 0.45, canvas!.y + canvas!.height * 0.5);
    await expect(page.getByRole("status", { name: "Measure distance" })).toContainText(/\d+(\.\d+)? (km|m)/);
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // Timeline: folded until opened.
    await expect(page.getByRole("slider", { name: "To start month", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open the timeline" }).click();
    await page.getByRole("slider", { name: "To start month", exact: true }).fill("3");
    await expect(page.getByText("527 projects · 42 without a point")).toHaveCount(0);
    await page.getByRole("button", { name: "All months", exact: true }).click();
    await page.getByRole("button", { name: "Close the timeline" }).click();
    await expect(page.getByText("527 projects · 42 without a point").filter({ visible: true }).first()).toBeVisible();

    if (!phone) {
      await page.getByRole("button", { name: "Hide analysis", exact: true }).click();
      await expect(ws).toHaveAttribute("data-panel", "closed");
      await expect.poll(async () => (await page.getByRole("complementary", { name: "Map analysis" }).boundingBox())?.x ?? 0).toBeGreaterThanOrEqual(width - 2);
      await page.getByRole("button", { name: "Show analysis", exact: true }).click();
    }
    await assertFit(page, phone); expect(errors).toEqual([]);
  });
}
