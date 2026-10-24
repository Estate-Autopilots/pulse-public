// CHAT-V4 screenshots of the chat at 1440, 900 and 390, light and dark, as Kedab (synthetic).
//   node tests/e2e/chat-v4-shots.mjs <out dir> [prefix] [widths] [themes] [only]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
const [out = "/tmp/chat-v4", prefix = "shot", widthsArg = "1440,900,390", themesArg = "light,dark", onlyArg = ""] = process.argv.slice(2);
const base = process.env.BASE ?? "http://127.0.0.1:3200", api = process.env.API ?? "http://127.0.0.1:3203";
const KEDAB = "kedab.mifos@synthetic.invalid";
mkdirSync(out, { recursive: true });
const list = await (await fetch(`${api}/api/v0/chats`, { headers: { "cf-access-authenticated-user-email": KEDAB } })).json();
const group = list.channels.find((c) => c.name === "Brochure launch (test)") ?? list.channels.find((c) => c.kind !== "direct"); // tests/e2e/chat-v4-seed.mjs
const ai = list.channels.find((c) => c.peerAgent && c.name === "Mira") ?? list.channels.find((c) => c.peerAgent);
const only = onlyArg.split(",").filter(Boolean);
const scenes = [
  ["list", "/chats", []],
  ["group", `/chats?channel=${group.id}`, []],
  ["info", `/chats?channel=${group.id}`, [["click", /details and members/]]],
  ["thread", `/chats?channel=${group.id}`, [["click", /replies|Open the thread/]]],
  ["panel", `/chats?channel=${group.id}`, [["key", "Control+."]]],
  ["gallery", `/chats?channel=${group.id}`, [["click", /^Conversation options$/], ["click", /Media, files and links/]]],
  ["ai", `/chats?channel=${ai.id}`, []],
].filter(([n]) => !only.length || only.includes(n));
const browser = await chromium.launch();
for (const width of widthsArg.split(",").map(Number)) for (const theme of themesArg.split(",")) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { "cf-access-authenticated-user-email": KEDAB } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.removeItem("pulse.panel.tabs"); } catch {} }, theme);
  const page = await ctx.newPage();
  for (const [name, path, steps] of scenes) {
    try {
      await page.goto(base + path, { waitUntil: "load", timeout: 120000 });
      await page.waitForTimeout(2500);
      for (const [k, a, last] of steps) {
        if (k === "click") { const loc = page.getByRole("button", { name: a }).or(page.getByRole("menuitem", { name: a })); await (last ? loc.last() : loc.first()).click({ timeout: 8000 }); }
        else if (k === "hover") await page.locator(a).hover({ timeout: 8000 });
        else if (k === "key") await page.keyboard.press(a);
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
