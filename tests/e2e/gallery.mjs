// Round 6 gallery: screenshots pages at the owner's real window sizes in light and dark.
// node gallery.mjs <stage> [--sizes=1920x860,...] [--themes=light,dark] [--email=...] [--base=url] [path ...]
// Writes ~/ea-research/round-6/<stage>/<theme>-<w>x<h>-<path>.png
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = (n) => args.find((x) => x.startsWith(`--${n}=`))?.split("=")[1];
const [stage = "before", ...rest] = args.filter((x) => !x.startsWith("--"));
export const realSizes = "1920x860,1536x730,1366x650,1280x650,2560x1300,390x760";
const sizes = (flag("sizes") ?? realSizes).split(",").map((x) => x.split("x").map(Number));
const themes = (flag("themes") ?? "light,dark").split(",");
const email = flag("email") ?? "admin@estateautopilots.com";
// --base=http://127.0.0.1:3299 shoots another server (e.g. the pre-round baseline worktree).
const base = flag("base") ?? "http://127.0.0.1:3200";
// --paths=file.json takes a JSON list of paths.
const paths = flag("paths") ? JSON.parse(await readFile(flag("paths"), "utf8")) : rest.length ? rest : [
  "/dashboard", "/dashboard?tab=delivery", "/dashboard?tab=people", "/dashboard?tab=money",
  "/projects", "/projects?view=cards", "/projects?view=list", "/clients", "/contacts",
  "/people", "/people?view=list", "/people?tab=tracking", "/me", "/hr", "/leadership", "/settings", "/map",
];
const out = `${homedir()}/ea-research/round-6/${stage}`;
await mkdir(out, { recursive: true });
// Software WebGL for MapLibre in headless Chromium.
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const theme of themes) for (const [width, height] of sizes) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": email } });
  await ctx.addInitScript((t) => { localStorage.setItem("pulse.theme", t); }, theme);
  // Map tiles come from a third party: never send them the sign-in header (it would also fail CORS).
  await ctx.route("**/*", (route) => { const headers = { ...route.request().headers() }; if (!route.request().url().startsWith(base)) delete headers["cf-access-authenticated-user-email"]; return route.continue({ headers }); });
  const page = await ctx.newPage();
  for (const path of paths) {
    try {
      await page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3,main [class*="__message"]') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 45000 });
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.waitForTimeout(path.startsWith("/map") ? 2500 : 700);
      await page.screenshot({ path: `${out}/${theme}-${width}x${height}-${path.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "_") || "root"}.png` });
    } catch (e) { console.log("ERROR", theme, width, path, e.message.slice(0, 120)); }
  }
  await ctx.close();
}
await browser.close();
console.log(`${stage}: ${themes.length * sizes.length * paths.length} shots in ${out}`);
