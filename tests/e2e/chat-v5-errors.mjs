// CHAT-V5: page errors and console errors while opening the synthetic group (debug helper).
import { chromium } from "@playwright/test";
const base = process.env.BASE ?? "http://127.0.0.1:3200", api = process.env.API ?? "http://127.0.0.1:3203";
const KEDAB = "kedab.mifos@synthetic.invalid";
const list = await (await fetch(`${api}/api/v0/chats`, { headers: { "cf-access-authenticated-user-email": KEDAB } })).json();
const group = list.channels.find((c) => c.name === "Brochure launch (test)");
const browser = await chromium.launch();
for (const width of [1440, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, extraHTTPHeaders: { "cf-access-authenticated-user-email": KEDAB } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(width, "PAGEERROR", String(e.stack ?? e).split("\n").slice(0, 6).join(" | ")));
  page.on("response", (r) => { if (r.status() >= 400) console.log(width, "HTTP", r.status(), r.url().slice(0, 160)); });
  page.on("console", (m) => { if (m.type() === "error") console.log(width, "CONSOLE", m.text().slice(0, 400)); });
  await page.goto(`${base}/chats?channel=${group.id}`, { waitUntil: "load", timeout: 120000 });
  await page.waitForTimeout(6000);
  await page.getByRole("textbox", { name: /^Message / }).fill("@e"); await page.waitForTimeout(1500);
  await page.getByRole("textbox", { name: /^Message / }).fill(""); await page.waitForTimeout(1500);
  if (width > 900) { await page.keyboard.press("Control+Shift+F"); await page.keyboard.type("brochure"); await page.waitForTimeout(3000); await page.keyboard.press("ArrowUp"); await page.waitForTimeout(2000); await page.keyboard.press("Escape"); }
  await page.getByRole("textbox", { name: /^Message / }).fill("Debug words (test)"); await page.locator("[data-send-later]").click(); await page.waitForTimeout(1000); await page.keyboard.press("Escape");
  await page.locator("[data-scheduled-bar] > button").click().catch(() => {}); await page.waitForTimeout(2000);
  const glitch = await page.getByText("Something glitched").count(); console.log(width, "glitch", glitch);
  await ctx.close();
}
await browser.close();
