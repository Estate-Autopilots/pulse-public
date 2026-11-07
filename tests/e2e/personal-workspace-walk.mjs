// PERSONAL-WORKSPACE (1640): a browser walk of a person's own workspace on a private stack (an API on a scratch database
// seeded by personal-workspace-seed.sql, and the lane's web app), at 1440 and 390 wide. Synthetic, obviously fake data.
//   WEB=http://127.0.0.1:4600 API=http://127.0.0.1:4601 OUT=<dir> node tests/e2e/personal-workspace-walk.mjs
// Walk: the switcher shows "My workspace" first → My projects (no client, gate, team-load or owner framing) → a project
// page (its idea first, then its tasks) → Goals → /tasks with 60 tasks → a task whose title says "company" is not sent
// to Settings → Organisation.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

const WEB = process.env.WEB ?? "http://127.0.0.1:4600", API = process.env.API ?? "http://127.0.0.1:4601", OUT = process.env.OUT ?? "/tmp/personal-workspace-walk";
const PASS = "Fake-Pass-For-Tests-1";
await mkdir(OUT, { recursive: true });

async function call(token, path, body) {
  const r = await fetch(`${API}/api/v0/${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { "x-pulse-session": token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); assert.ok(r.ok, `${path}: ${JSON.stringify(d)}`); return d;
}
const signin = await call(null, "auth/account-sign-in", { login: "fakeowner", password: PASS });
let token = signin.token; assert.ok(token, "signed in");
const acct = await call(token, "account");
const mine = acct.orgs.find((o) => o.mine);
assert.ok(mine && acct.orgs[0].mine, "the account's own workspace is listed first");
assert.equal(mine.orgKind, "personal");
const moved = await call(token, "account/switch", { org: mine.id });
token = moved.token ?? token;
const me = await call(token, "me");
assert.equal(me.orgKind, "personal", "the session is in the personal workspace");

const browser = await chromium.launch();
const steps = [];
const step = (s) => { steps.push(s); console.log("ok:", s); };
for (const [w, h, tag] of [[1440, 1000, "1440"], [390, 844, "390"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: "pulse_session", value: token, url: WEB }]);
  const page = await ctx.newPage();
  const shot = (name) => page.screenshot({ path: join(OUT, `${tag}-${name}.png`), fullPage: true });
  const noScrollX = async (what) => { const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(o <= 2, `${what} at ${tag}: ${o}px sideways`); };

  // 1. My projects: personal words, no company framing.
  await page.goto(`${WEB}/tasks?view=projects`, { waitUntil: "networkidle" });
  await page.getByText("Fake PR and Story").first().waitFor();
  const body = await page.locator("main").innerText();
  for (const word of ["Waiting on the client", "Foundation", "Stuck at a gate", "Team load", "Owner Fake", "My team"]) assert.ok(!body.includes(word), `projects list says "${word}" at ${tag}`);
  assert.ok(body.includes("My projects") && body.includes("Goals") && body.includes("This week"), `personal words at ${tag}`);
  await noScrollX("projects"); await shot("01-my-projects"); step(`${tag}: My projects without client, gate, team-load or owner framing`);

  // 2. A project: its idea first, then its tasks; no client-delivery panels.
  await page.getByText("Fake PR and Story").first().click();
  await page.waitForURL(/\/tasks\/projects\//); await page.waitForLoadState("networkidle");
  await page.getByText("Fake idea: tell the story").waitFor();
  const proj = await page.locator("main").innerText();
  for (const word of ["Client package", "Fulfilment is not set up", "fulfilment is not set up", "Deliverables per week", "Client delivery"]) assert.ok(!proj.includes(word), `project page says "${word}" at ${tag}`);
  assert.ok(proj.includes("Personal project"), "the project's type");
  const ideaY = await page.getByText("Fake idea: tell the story").boundingBox(), tasksY = await page.locator('[aria-label="Tasks"]').first().boundingBox();
  assert.ok(ideaY && tasksY && ideaY.y < tasksY.y, "the idea comes before the tasks");
  await noScrollX("project"); await shot("02-project-page"); step(`${tag}: project page opens on its idea, then its tasks; no client-delivery panels`);

  // 3. Goals, apart from projects and tasks.
  await page.goto(`${WEB}/goals`, { waitUntil: "networkidle" });
  await page.getByText("Fake goal: consulting at 2,500 an hour").first().waitFor();
  await page.getByText("Achieved").first().waitFor();
  await noScrollX("goals"); await shot("03-goals"); step(`${tag}: Goals: where I am heading, and achieved`);

  // 4. Tasks: 60 of them, using the width.
  await page.goto(`${WEB}/tasks`, { waitUntil: "networkidle" });
  await page.getByText(/Fake task \d+ for the walk/).first().waitFor();
  await noScrollX("tasks"); await shot("04-tasks"); step(`${tag}: /tasks with 60 tasks`);

  // 5. The task whose title says "company" is not sent to Settings → Organisation.
  await page.getByText("Fake achievement A10").first().click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}/); await page.waitForLoadState("networkidle");
  const task = await page.locator("main").innerText();
  assert.ok(!/Go to Organisation|Go to Organization|Go to Companies/.test(task), `a title with "company" routed to the organisation at ${tag}`);
  await shot("05-task-company-title"); step(`${tag}: a task titled "…every company" has no Go to Organisation`);

  // 6. The switcher: My workspace first, apart from the companies.
  await page.goto(`${WEB}/tasks`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.dispatchEvent(new Event("pulse:orgs-open")));
  await page.getByRole("dialog", { name: "Switch organisation" }).waitFor();
  const first = await page.locator('[role="dialog"] [role="menuitemradio"]').first().innerText();
  assert.ok(first.includes("My workspace"), `the switcher's first row: ${first}`);
  await shot("06-switcher"); step(`${tag}: the switcher lists My workspace first`);
  await ctx.close();
}
await browser.close();
console.log(`WALK OK: ${steps.length} steps`);
