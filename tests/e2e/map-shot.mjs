// Map showcase shots against the live dev server (127.0.0.1:3200), with software WebGL.
// node map-shot.mjs <state> [WxH] [light|dark] [outDir]
// States: home, light, dark, relief, areas, areas-repeat, areas-deliveries, rings, hex3d, heat, markets, focus, wide-growth,
//         project, project-nearby, filters, layers, time, measure, patterns, pins, sheet, sheet-open, sheet-project
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

const [state = "home", size = "1536x730", theme = "light", out = `${homedir()}/ea-research/round-6/map-showcase`] = process.argv.slice(2);
const [width, height] = size.split("x").map(Number);
const BASE = "http://127.0.0.1:3200";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" } });
// Tiles come from third parties: never send them the sign-in header.
await ctx.route("**/*", async (route) => { const headers = { ...route.request().headers() }; if (!route.request().url().startsWith(BASE)) delete headers["cf-access-authenticated-user-email"]; await route.continue({ headers }); });
await ctx.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 300)); });
await page.goto(`${BASE}/map`, { waitUntil: "networkidle", timeout: 60000 });
await page.getByText("Opening the map…").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const phone = width < 700;
const layers = async () => { await page.getByRole("button", { name: "Layers", exact: true }).click(); await page.waitForTimeout(300); };
const pick = async (name) => { await layers(); await page.getByRole("radio", { name, exact: true }).click(); await page.keyboard.press("Escape"); };
const project = async (q = "Moshi") => {
  await page.getByRole("searchbox", { name: "Search projects, clients or places" }).fill(q);
  await page.locator('[aria-label="Search results"] button').nth(1).click();
  await page.waitForTimeout(2600);
};
const wait = (ms = 1800) => page.waitForTimeout(ms);
switch (state) {
  case "relief": await pick("Relief"); await wait(4000); break;
  case "dark": await pick("Streets dark"); await wait(3000); break;
  case "light": await pick("Streets light"); await wait(3000); break;
  case "areas": await pick("Market areas"); await wait(); break;
  case "areas-repeat": await pick("Market areas"); await page.getByRole("tab", { name: "Repeat clients", exact: true }).first().click(); await wait(); break;
  case "areas-deliveries": await pick("Market areas"); await page.getByRole("tab", { name: "Deliveries", exact: true }).first().click(); await wait(); break;
  case "heat": await pick("Heatmap"); await wait(); break;
  case "markets": await pick("Market centres"); await wait(); break;
  case "hex3d": await layers(); await page.getByRole("radio", { name: "Hexagons", exact: true }).click(); await page.getByRole("switch", { name: "3D towers" }).check(); await page.keyboard.press("Escape"); await wait(3200); break;
  case "layers": await layers(); await page.getByRole("radio", { name: "Market areas", exact: true }).click(); await wait(800); break;
  case "rings": await project(); await page.getByRole("tab", { name: "Nearby", exact: true }).click(); await page.getByRole("button", { name: "Fit all projects" }).click().catch(() => {}); await page.mouse.move(10, 10); await wait(600); await page.keyboard.press("Escape").catch(() => {}); break;
  case "project": await project(); break;
  case "project-nearby": await project(); await page.getByRole("tab", { name: "Nearby", exact: true }).click(); await wait(800); break;
  case "focus": await page.getByRole("searchbox", { name: "Search projects, clients or places" }).fill("Moshi"); await page.locator('[aria-label="Search results"] button').first().click(); await wait(2200); break;
  case "wide-growth": await page.getByRole("tab", { name: "Growth", exact: true }).click(); await page.getByRole("button", { name: "Focus mode" }).click(); await wait(1500); break;
  case "wide-places": await page.getByRole("button", { name: "Focus mode" }).click(); await wait(1500); break;
  case "places-list": await page.getByRole("tab", { name: /^Markets/ }).first().click(); await wait(800); break;
  case "patterns": await page.getByRole("tab", { name: "Patterns", exact: true }).click(); await wait(800); break;
  case "growth": await page.getByRole("tab", { name: "Growth", exact: true }).click(); await wait(800); break;
  case "pins": await page.getByRole("tab", { name: "Pins", exact: true }).click(); await wait(800); break;
  case "pins-list": await page.getByRole("tab", { name: "Pins", exact: true }).click(); await page.getByRole("tab", { name: /^To pin/ }).click(); await wait(800); break;
  case "filters": await page.getByRole("button", { name: "Filters", exact: true }).click(); await wait(800); break;
  case "time": await page.getByRole("button", { name: "Open the timeline" }).click(); await page.getByRole("slider", { name: "From start month" }).fill("12"); await wait(1200); break;
  case "measure": { await page.getByRole("button", { name: "Measure distance", exact: true }).click(); const box = await page.locator(".maplibregl-canvas").boundingBox(); for (const [x, y] of [[0.25, 0.35], [0.4, 0.6], [0.5, 0.45]]) { await page.mouse.click(box.x + box.width * x, box.y + box.height * y); await wait(250); } await wait(800); break; }
  case "closed": await page.getByRole("button", { name: "Hide analysis" }).click(); await wait(1200); break;
  case "sheet-open": await page.getByRole("button", { name: "Show analysis" }).click(); await wait(1200); break;
  case "sheet-project": await project(); break;
  default: break;
}
if (phone && state === "sheet-project") await page.getByRole("button", { name: "Show analysis" }).click().catch(() => {});
await page.screenshot({ path: `${out}/${state}-${theme}-${width}x${height}.png` });
console.log(`${out}/${state}-${theme}-${width}x${height}.png`);
await browser.close();
