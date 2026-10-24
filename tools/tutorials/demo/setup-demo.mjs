#!/usr/bin/env node
// Reels demo company (dev only, fictional people only, nothing sent): the platform operator walks the setup wizard
// for "Brightside Studio" at its own address reels-demo.localhost, imports the synthetic team, opens it for sign-in,
// and the synthetic admin Meera sets her password. Adapted from tests/e2e/tenant-rehearsal.mjs.
//
//   BASE=http://127.0.0.1:<pulse-dev web port> OPERATOR=<an EA admin's Access e-mail> LOGINS=<file to write>
//   CHROME=<chromium> node tools/tutorials/demo/setup-demo.mjs
//
// The passwords go only to LOGINS (keep it outside the repo; it is deleted with the run's temp folder). Run
// seed-demo.mjs on the server afterwards for the AI employee, the client group, tasks and a synthetic finance model.
import { chromium } from "playwright-core";
import fs from "node:fs";
import crypto from "node:crypto";

const base = process.env.BASE, operator = process.env.OPERATOR, loginsPath = process.env.LOGINS;
if (!base || !operator || !loginsPath) throw new Error("BASE, OPERATOR and LOGINS are required");
const port = new URL(base).port;
export const HOST = "reels-demo.localhost";
export const COMPANY = "Brightside Studio";
const DEMO = `http://${HOST}:${port}`;
const DOMAIN = "brightside-demo.invalid";
const PEOPLE = [
  ["Name", "Email", "Title", "Pod", "Team", "Manager", "Access"],
  ["Rifob Desai", `rifob.desai@${DOMAIN}`, "Client coordinator", "Clients", "Operations", `meera.shah@${DOMAIN}`, "manager"],
  ["Isha Kapoor", `isha.kapoor@${DOMAIN}`, "Video editor", "Studio", "Production", `rifob.desai@${DOMAIN}`, ""],
  ["Ahoro Nair", `ahoro.nair@${DOMAIN}`, "Designer", "Studio", "Production", `rifob.desai@${DOMAIN}`, ""],
  ["Zoya Khan", `zoya.khan@${DOMAIN}`, "Content writer", "Studio", "Production", `rifob.desai@${DOMAIN}`, ""],
  ["Dev Malhotra", `dev.malhotra@${DOMAIN}`, "Account manager", "Clients", "Operations", `meera.shah@${DOMAIN}`, ""],
].map((r) => r.join(",")).join("\n") + "\n";

const logins = fs.existsSync(loginsPath) ? JSON.parse(fs.readFileSync(loginsPath, "utf8")) : {};
const save = () => fs.writeFileSync(loginsPath, JSON.stringify(logins, null, 1), { mode: 0o600 });
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const note = (s) => console.log(`${new Date().toISOString()} ${s}`);
const settle = async (p) => { await p.waitForLoadState("load"); await p.waitForTimeout(600); };
const step = async (p, url, heading) => { await p.goto(url); await p.getByRole("heading", { name: heading }).first().waitFor(); await settle(p); };

let current = null;
try {
  const op = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": operator } });
  const p = await op.newPage(); current = p;
  await p.goto(`${base}/companies`); await settle(p);
  const existing = p.getByRole("link", { name: COMPANY, exact: true });
  let link = null;
  if ((await existing.count()) && logins["meera.shah"]) {
    note("company exists and Meera has a password: nothing to set up");
  } else {
    if (await existing.count()) { await existing.first().click(); await p.waitForURL(/\/companies\/[0-9a-f-]{36}/); }
    else {
      await p.getByLabel("Company name").fill(COMPANY);
      await p.getByRole("button", { name: "Set up a company" }).click();
      await p.waitForURL(/\/companies\/[0-9a-f-]{36}\?step=company/);
    }
    const setupUrl = p.url().split("?")[0]; note(`setup ${setupUrl}`);
    await step(p, `${setupUrl}?step=company`, "Company and address");
    await p.getByLabel("Time zone").fill("Asia/Kolkata");
    await p.getByLabel("Web address").fill(HOST);
    const rehearsal = p.getByRole("checkbox", { name: /Rehearsal/ });
    if (await rehearsal.count()) await rehearsal.check();
    await p.getByRole("button", { name: "Check first" }).click();
    await p.getByText(/^(Creating it will|Saving will)/).first().waitFor();
    await p.getByRole("button", { name: /^(Create company|Save)$/ }).click();
    await p.waitForTimeout(1500);

    await step(p, `${setupUrl}?step=admin`, "First admin");
    if (await p.getByLabel("Full name").count()) {
      await p.getByLabel("Full name").fill("Meera Shah");
      await p.getByLabel("Work e-mail").fill(`meera.shah@${DOMAIN}`);
      await p.getByLabel("Title").fill("Founder");
      await p.getByRole("button", { name: /^(Add admin|Save admin)$/ }).click();
    }
    await p.getByRole("heading", { name: "Invitation" }).waitFor();
    await p.getByLabel(/I will hand the link to Meera Shah privately/).check();
    await p.getByRole("button", { name: "Get a private link" }).click();
    const linkBox = p.locator("code").filter({ hasText: "/login/set-password#" });
    await linkBox.waitFor();
    link = (await linkBox.textContent()).trim().replace(/^https?:\/\/[^/]+/, DEMO);

    await step(p, `${setupUrl}?step=people`, "People");
    await p.getByLabel("Or paste the CSV").fill(PEOPLE);
    await p.getByRole("button", { name: "Preview" }).click();
    await p.getByRole("heading", { name: "Preview" }).waitFor();
    const imp = p.getByRole("button", { name: /^Import \d+ people$/ });
    if (await imp.count()) { await imp.click(); await p.getByRole("heading", { name: "Imported" }).waitFor(); }

    await step(p, `${setupUrl}?step=structure`, "Pods");
    if (!(await p.locator("li", { hasText: /^Leadership$/ }).count())) { await p.getByLabel("New pod").fill("Leadership"); await p.getByRole("button", { name: "Add pod" }).click(); }
    await p.getByLabel("Pod of Meera Shah").selectOption("Leadership");
    await p.locator("tr", { has: p.locator("td:first-child b", { hasText: /^Meera Shah$/ }) }).getByLabel("Leadership").check();
    const saveBtn = p.getByRole("button", { name: /^Save \d+ changes$/ });
    if (await saveBtn.isEnabled()) { await saveBtn.click(); await p.getByText("Pods and roles saved").waitFor().catch(() => {}); }

    await step(p, `${setupUrl}?step=open`, "Checklist");
    const openBtn = p.getByRole("button", { name: `Open ${COMPANY} for sign-in` });
    if (await openBtn.count()) {
      await p.getByRole("button", { name: "Run the isolation check" }).click();
      await p.getByText(/tables read: nothing from another company/).waitFor({ timeout: 120000 });
      await openBtn.click();
      await p.getByText(/sign in at/).first().waitFor();
    }
    note("company open");
  }
  await op.close();

  if (link && !logins["meera.shah"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const d = await ctx.newPage();
    const pw = `Demo-${crypto.randomBytes(9).toString("base64url")}`;
    await d.goto(link);
    await d.getByLabel("New password", { exact: true }).fill(pw);
    await d.getByLabel("New password again").fill(pw);
    await d.getByRole("button", { name: "Set password and start" }).click();
    await d.waitForURL(/\/(dashboard|account)/, { timeout: 60000 });
    logins["meera.shah"] = pw; save();
    note("Meera signed in once");
    await ctx.close();
  }
} catch (e) {
  // Debug aid: what the page showed when a step failed (the operator page lists companies only, no EA data).
  if (current && process.env.DEBUG_DIR) {
    await current.screenshot({ path: `${process.env.DEBUG_DIR}/setup-fail.png` }).catch(() => {});
    console.error((await current.locator("main").innerText().catch(() => "")).slice(0, 1500));
  }
  throw e;
} finally {
  await browser.close();
}
