// CHAT-V6 screenshots at 1440 and 390, light and dark, as Kedab (synthetic): reminders and scheduled, the emoji picker
// (and its search), a reaction from the whole set, a long chat, a match found far back, the dock's Threads tab, plus the
// everyday chat screens for the quality sweep (list, a group, a thread, info).
//   node tests/e2e/chat-v6-shots.mjs <out dir> [prefix] [widths] [themes] [only]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
const [out = "/tmp/chat-v6", prefix = "v6", widthsArg = "1440,390", themesArg = "light,dark", onlyArg = ""] = process.argv.slice(2);
const base = process.env.BASE ?? "http://127.0.0.1:3200", api = process.env.API ?? "http://127.0.0.1:3203";
const KEDAB = "kedab.mifos@synthetic.invalid";
mkdirSync(out, { recursive: true });
const list = await (await fetch(`${api}/api/v0/chats`, { headers: { "cf-access-authenticated-user-email": KEDAB } })).json();
const group = list.channels.find((c) => c.name === "Brochure launch (test)");   // tests/e2e/chat-v4-seed.mjs
const long = list.channels.find((c) => c.name === "Long history (test)");       // tests/e2e/chat-v6-seed.mjs
const only = onlyArg.split(",").filter(Boolean);
const g = `/chats?channel=${group.id}`, l = `/chats?channel=${long.id}`;
const scenes = [
  ["list", "/chats", []],
  ["later", "/chats", [["role", "More"], ["css", "[data-later-open]"], ["wait", 1500]]],
  ["group", g, []],
  ["emoji", g, [["css", "[data-emoji-toggle]"]]],
  ["emoji-search", g, [["css", "[data-emoji-toggle]"], ["type-in", ["[data-emoji-picker] input", "heart"]]]],
  ["react-more", g, [["more-react"]]],
  ["long", l, [["wait", 1500]]],
  ["find-far", l, [["find", "zebracrossing"], ["wait", 3500]]],
  ["thread", g, [["css", "[data-thread-chip]"], ["wait", 1500]]],
  ["info", g, [["css", "header button[aria-label$='details and members']"], ["wait", 1200]]],
  ["dock-threads", "/dashboard", [["css", "[data-chat-dock]"], ["css", "[data-dock-threads]"], ["wait", 1500]]],
  ["dock-thread", "/dashboard", [["css", "[data-chat-dock]"], ["css", "[data-dock-threads]"], ["css", "[data-dock-thread-row]"], ["wait", 1500]]],
].filter(([n]) => !only.length || only.includes(n));
const browser = await chromium.launch();
for (const width of widthsArg.split(",").map(Number)) for (const theme of themesArg.split(",")) {
  const phone = width < 500;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 2 : 1, extraHTTPHeaders: { "cf-access-authenticated-user-email": KEDAB } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.removeItem("pulse.panel.tabs"); } catch {} }, theme);
  const page = await ctx.newPage();
  for (const [name, path, steps] of scenes) {
    if (phone && name.startsWith("dock")) continue;   // the dock is for computers (a phone has the Chats tab)
    try {
      await page.goto(base + path, { waitUntil: "load", timeout: 120000 });
      if (path.includes("channel=")) await page.locator('[role="log"] article[id^="m-"]').first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(2500);
      for (const [k, a] of steps) {
        if (k === "css") await page.locator(a).first().click({ timeout: 8000 });
        else if (k === "role") await page.getByRole("button", { name: a, exact: true }).first().click({ timeout: 8000 });
        else if (k === "type-in") await page.locator(a[0]).fill(a[1]);
        else if (k === "wait") await page.waitForTimeout(a);
        else if (k === "find") {
          if (phone) { await page.getByRole("button", { name: "Conversation options" }).click(); await page.locator("[data-chat-search-item]").click(); }
          else await page.keyboard.press("Control+Shift+F");
          await page.locator("[data-find-bar] input").fill(a);
        } else if (k === "more-react") {
          const m = page.locator('[role="log"] article[id^="m-"]:not([data-mine])').last();
          if (phone) { const b = await m.locator('[class*="bubble"]').first().boundingBox(); const cdp = await ctx.newCDPSession(page);
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x + 30, y: b.y + b.height / 2 }] }); await page.waitForTimeout(700); await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await page.waitForTimeout(600); await page.locator('[role="dialog"] [data-react-more]').click(); }
          else { await m.hover(); await m.getByRole("button", { name: "React", exact: true }).click(); await m.locator("[data-react-more]").click(); }
        }
        await page.waitForTimeout(700);
      }
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/${prefix}-${name}-${width}-${theme}.png` });
      console.log("ok", name, width, theme);
    } catch (e) { console.log("FAIL", name, width, theme, (e.message ?? "").split("\n")[0]); await page.screenshot({ path: `${out}/${prefix}-${name}-${width}-${theme}-fail.png` }).catch(() => {}); }
  }
  await ctx.close();
}
await browser.close();
