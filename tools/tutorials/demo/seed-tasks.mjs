#!/usr/bin/env node
// Reels demo tasks for Brightside Studio, through the real API as the demo's own people (dev only, fictional): Meera
// gets two late tasks and three teammates' tasks that wait on hers, so the Focus home's "Next up" has real moves.
//
//   REELS_BASE=http://reels-demo.localhost:<port> REELS_LOGINS=<file> REELS_CHROME=<chromium> \
//   node tools/tutorials/demo/seed-tasks.mjs <people.json>     people.json: {"meera.shah": "<person id>", ...}
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.REELS_BASE;
const logins = JSON.parse(fs.readFileSync(process.env.REELS_LOGINS, "utf8"));
const ids = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ist = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plus = (n) => new Date(Date.parse(`${ist}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const MINE = [
  { key: "brief", title: "Approve the Skyline Heights shoot brief", due: plus(-2), priority: "high" },
  { key: "quote", title: "Sign off the Greenleaf Cafe quote", due: plus(-1), priority: "high" },
  { key: "hire", title: "Pick the new editor from the shortlist", due: plus(3), priority: "normal" },
];
const WAITING = [
  { who: "isha.kapoor", title: "Plan the show flat shoot", due: plus(2), waits: "brief" },
  { who: "ahoro.nair", title: "Design the launch posters", due: plus(4), waits: "brief" },
  { who: "dev.malhotra", title: "Send Greenleaf the signed quote", due: plus(1), waits: "quote" },
];

const browser = await chromium.launch({ executablePath: process.env.REELS_CHROME });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.locator('input[name="username"]').fill("meera.shah");
  await page.locator('input[name="password"]').fill(logins["meera.shah"]);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname));
  const call = async (path, body) => {
    const r = await ctx.request.fetch(`${base}/api/v0/${path}`, { method: body === undefined ? "GET" : "POST", data: body, headers: { "content-type": "application/json", origin: new URL(base).origin } });
    const text = await r.text();
    if (!r.ok()) throw new Error(`${path}: ${r.status()} ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  const home = await call("tasks/home");
  const have = new Set([...(home.rows ?? []), ...(home.waitingOnMe ?? [])].map((t) => t.title));
  const made = {};
  for (const t of MINE) {
    if (have.has(t.title)) continue;
    made[t.key] = (await call("work/tasks", { title: t.title, assigneeId: ids["meera.shah"], dueOn: t.due, priority: t.priority, reviewerId: ids["rifob.desai"] })).id;
  }
  for (const t of WAITING) {
    if (have.has(t.title) || !made[t.waits]) continue;
    const id = (await call("work/tasks", { title: t.title, assigneeId: ids[t.who], dueOn: t.due, priority: "normal", reviewerId: ids["meera.shah"] })).id;
    await call(`tasks/${id}/block`, { blockerId: made[t.waits] });
  }
  const after = await call("tasks/home");
  console.log(JSON.stringify({ made: Object.keys(made), rows: after.rows?.length, waitingOnMe: after.waitingOnMe?.length }));
} finally {
  await browser.close();
}
