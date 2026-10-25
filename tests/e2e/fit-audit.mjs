// Dev helper: node fit-audit.mjs [--shots] [--collapsed] [--theme=dark] [--sizes=1280x720,1440x900] <path>...
// Opens each path at each window size and reports anything that scrolls, anything cut off, and page errors.
import { chromium } from "@playwright/test";
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}`))?.split("=")[1];
const shots = args.includes("--shots"); const collapsed = args.includes("--collapsed"); const theme = flag("theme") ?? "light"; const email = flag("email") ?? "admin@estateautopilots.com";
const sizes = (flag("sizes") ?? "1280x720,1440x900,1920x1080").split(",").map((s) => s.split("x").map(Number));
const paths = args.filter((a) => !a.startsWith("--"));
const browser = await chromium.launch(); let bad = 0;
for (const [width, height] of sizes) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await ctx.route("**/*", route => new URL(route.request().url()).origin === "http://127.0.0.1:3200"
    ? route.continue({ headers: { ...route.request().headers(), "cf-access-authenticated-user-email": email } }) : route.continue());
  await ctx.addInitScript(([t, c]) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); if (c) localStorage.setItem("pulse.sidebar.collapsed", "true"); } catch {} }, [theme, collapsed]);
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  for (const path of paths) {
    errors.length = 0;
    await page.goto(`http://127.0.0.1:3200${path}`, { waitUntil: "networkidle" }); await page.waitForTimeout(700);
    const found = await page.evaluate((desktop) => {
      const out = []; const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0].replace(/^.*__/, "")}`;
      const doc = document.scrollingElement;
      if (doc.scrollHeight > innerHeight + 1 && desktop) out.push(`document scrolls ${doc.scrollHeight}>${innerHeight}`);
      if (doc.scrollWidth > innerWidth + 1) out.push(`document wider ${doc.scrollWidth}>${innerWidth}`);
      for (const el of document.querySelectorAll("main *, main")) {
        const cs = getComputedStyle(el); if (cs.display === "none" || !el.clientHeight) continue;
        const dy = el.scrollHeight - el.clientHeight, dx = el.scrollWidth - el.clientWidth;
        if (desktop && /auto|scroll/.test(cs.overflowY) && dy > 1) out.push(`scrolls-y ${name(el)} +${dy}`);
        if (/auto|scroll/.test(cs.overflowX) && dx > 1 && desktop) out.push(`scrolls-x ${name(el)} +${dx}`);
        if (desktop && /hidden|clip/.test(cs.overflowY) && dy > 3 && el.clientHeight > 36 && cs.whiteSpace !== "nowrap" && !cs.webkitLineClamp?.match(/\d/)) out.push(`cut-y ${name(el)} +${dy}`);
        if (desktop && /hidden|clip/.test(cs.overflowX) && dx > 3 && el.clientHeight > 36 && cs.textOverflow !== "ellipsis") out.push(`cut-x ${name(el)} +${dx}`);
      }
      const r = document.querySelector("main")?.getBoundingClientRect();
      for (const el of document.querySelectorAll("main section, main [data-pager]")) { const b = el.getBoundingClientRect(); if (desktop && b.height && (b.bottom > innerHeight + 1 || b.right > innerWidth + 1)) out.push(`outside ${name(el)} bottom ${Math.round(b.bottom)} right ${Math.round(b.right)}`); }
      return [...new Set(out)].slice(0, 12);
    }, width >= 1180);
    const all = [...found, ...errors.slice(0, 3).map((e) => `ERROR ${e.slice(0, 160)}`)];
    if (all.length) bad++;
    console.log(`${all.length ? "✗" : "✓"} ${width}x${height} ${theme} ${path}${all.length ? "\n    " + all.join("\n    ") : ""}`);
    if (shots) await page.screenshot({ path: `/tmp/shots/a-${path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}-${width}-${theme}.png` });
  }
  await ctx.close();
}
await browser.close(); console.log(bad ? `${bad} with findings` : "all clean");
