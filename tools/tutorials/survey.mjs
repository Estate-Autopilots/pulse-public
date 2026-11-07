#!/usr/bin/env node
// Survey: signs in as one demo person on the phone viewport, screenshots routes and lists the tappable elements
// (role, name, box), for writing storyboards.  node survey.mjs <user> <outdir> <route>[,<route>...]
// env: REELS_BASE, REELS_CHROME, REELS_LOGINS (as capture.mjs)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { PHONE } from "./capture.mjs";

const [user, outDir, routes] = process.argv.slice(2);
const base = process.env.REELS_BASE;
const logins = JSON.parse(fs.readFileSync(process.env.REELS_LOGINS, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.REELS_CHROME });
try {
  const ctx = await browser.newContext({ ...PHONE, deviceScaleFactor: 1, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.locator('input[name="username"]').fill(user);
  await page.locator('input[name="password"]').fill(logins[user]);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 });
  for (const [i, route] of routes.split(",").entries()) {
    await page.goto(new URL(route, base).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const name = `${String(i).padStart(2, "0")}-${route.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}`;
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
    const els = await page.evaluate(() => [...document.querySelectorAll('a,button,[role="button"],input,textarea,select,[role="tab"],[role="link"],[aria-label]')]
      .map((e) => { const r = e.getBoundingClientRect(); return { tag: e.tagName.toLowerCase(), label: (e.getAttribute("aria-label") || e.innerText || e.getAttribute("placeholder") || e.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 70), box: [r.x, r.y, r.width, r.height].map(Math.round) }; })
      .filter((e) => e.box[2] > 0 && e.box[3] > 0 && e.label));
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ url: page.url(), els }, null, 0));
    console.log(name, page.url(), els.length);
  }
} finally {
  await browser.close();
}
