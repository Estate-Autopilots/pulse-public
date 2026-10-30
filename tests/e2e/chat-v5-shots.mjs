// CHAT-V5 screenshots at 1440 and 390, light and dark, as Kedab (synthetic): the Threads inbox, a poll, send later,
// remind me, the jump dialog, find in a chat, the shortcuts, the emoji picker.
//   node tests/e2e/chat-v5-shots.mjs <out dir> [prefix] [widths] [themes] [only]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
const [out = "/tmp/chat-v5", prefix = "shot", widthsArg = "1440,390", themesArg = "light,dark", onlyArg = ""] = process.argv.slice(2);
const base = process.env.BASE ?? "http://127.0.0.1:3200", api = process.env.API ?? "http://127.0.0.1:3203";
const KEDAB = "kedab.mifos@synthetic.invalid";
mkdirSync(out, { recursive: true });
const list = await (await fetch(`${api}/api/v0/chats`, { headers: { "cf-access-authenticated-user-email": KEDAB } })).json();
const group = list.channels.find((c) => c.name === "Brochure launch (test)"); // tests/e2e/chat-v4-seed.mjs
const only = onlyArg.split(",").filter(Boolean);
const g = `/chats?channel=${group.id}`;
const scenes = [
  ["list", "/chats", []],
  ["threads", "/chats", [["css", '[role="tab"][data-filter="threads"]']]],
  ["group", g, []],
  ["poll", g, [["scroll-to", "[data-poll]"]]],
  ["remind", g, [["hold-or-menu"], ["text", /^Remind me$/]]],
  ["later", g, [["fill", "Shoot moves to 11 tomorrow (test)"], ["css", "[data-send-later]"]]],
  ["scheduled", g, [["fill", "Ping Neha about the print proof (test)"], ["css", "[data-send-later]"], ["text", /^Tomorrow/], ["css", "[data-scheduled-bar] > button"]]],
  ["everyone", g, [["fill", "@e"]]],
  ["emoji", g, [["role", "Emoji"]]],
  ["find", g, [["key", "Control+Shift+F"], ["type", "brochure"], ["wait", 2500]]],
  ["jump", "/chats", [["key", "Control+k"], ["type", "bro"]]],
  ["keys", "/chats", [["key", "Control+/"]]],
].filter(([n]) => !only.length || only.includes(n));
const browser = await chromium.launch();
for (const width of widthsArg.split(",").map(Number)) for (const theme of themesArg.split(",")) {
  const phone = width < 500;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { "cf-access-authenticated-user-email": KEDAB } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.removeItem("pulse.panel.tabs"); } catch {} }, theme);
  const page = await ctx.newPage();
  for (const [name, path, steps] of scenes) {
    if (phone && ["jump", "keys", "find"].includes(name)) continue;   // keyboard scenes: computer only
    try {
      await page.goto(base + path, { waitUntil: "load", timeout: 120000 });
      await page.waitForTimeout(2500);
      for (const [k, a] of steps) {
        if (k === "css") await page.locator(a).first().click({ timeout: 8000 });
        else if (k === "text") await page.getByRole("button", { name: a }).or(page.getByRole("menuitem", { name: a })).first().click({ timeout: 8000 });
        else if (k === "role") await page.getByRole("button", { name: a, exact: true }).click({ timeout: 8000 });
        else if (k === "fill") await page.getByRole("textbox", { name: /^Message / }).fill(a);
        else if (k === "type") await page.keyboard.type(a);
        else if (k === "key") await page.keyboard.press(a);
        else if (k === "wait") await page.waitForTimeout(a);
        else if (k === "scroll-to") await page.locator(a).last().scrollIntoViewIfNeeded({ timeout: 8000 });
        else if (k === "hold-or-menu") {
          const m = page.locator('[role="log"] article[id^="m-"]:not([data-mine])').last();
          if (phone) { const b = await m.locator('[class*="bubble"]').first().boundingBox(); const cdp = await ctx.newCDPSession(page);
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x + 30, y: b.y + b.height / 2 }] }); await page.waitForTimeout(700); await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); }
          else { await m.hover(); await m.locator('[aria-label="More actions"]').click(); }
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
