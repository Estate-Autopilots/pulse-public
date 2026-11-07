// UX-TENANT rehearsal (dev only, synthetic people only, nothing sent): the platform operator walks the setup wizard for
// "Atlas Crest (rehearsal)" in a browser, then its synthetic admin "Datup (rehearsal)" redeems his private link at
// the company's own address, creates a project and assigns tasks. Screenshots of every step go to OUT.
//
//   WEB_PORT=<local Pulse web> OUT=<dir> OPERATOR=<an admin's Access e-mail on that install> node tests/e2e/tenant-rehearsal.mjs
//
// The web must run against an API that has migration 0260, with *.localhost resolving to this machine (Chromium does).
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const port = process.env.WEB_PORT, out = process.env.OUT, operator = process.env.OPERATOR;
if (!port || !out || !operator) throw new Error("WEB_PORT, OUT and OPERATOR are required");
const EA = `http://127.0.0.1:${port}`, HOST = "ac-rehearsal.localhost", AC = `http://${HOST}:${port}`;
const COMPANY = "Atlas Crest (rehearsal)";
const PASSWORD = `Rehearsal-${Date.now().toString(36)}-only`;   // synthetic admin on dev; not written anywhere
const PEOPLE = [
  ["Name", "Email", "Title", "Pod", "Team", "Manager", "Access"],
  ["Aarav Mifos (rehearsal)", "aarav@ac-rehearsal.invalid", "Appointment setter", "Setters", "Sales", "kavya@ac-rehearsal.invalid", ""],
  ["Kavya Nair (rehearsal)", "kavya@ac-rehearsal.invalid", "Setter lead", "Setters", "Sales", "datup.rehearsal@ac-rehearsal.invalid", "manager"],
  ["Rifob Gobap (rehearsal)", "rifob@ac-rehearsal.invalid", "Closer", "Closers", "Sales", "vikram@ac-rehearsal.invalid", ""],
  ["Vikram Rao (rehearsal)", "vikram@ac-rehearsal.invalid", "Closer lead", "Closers", "Sales", "datup.rehearsal@ac-rehearsal.invalid", "manager"],
  ["Sidif Iyer (rehearsal)", "sidif@ac-rehearsal.invalid", "People partner", "", "People", "datup.rehearsal@ac-rehearsal.invalid", "hr"],
  ["Ananya Das (rehearsal)", "ananya@ac-rehearsal.invalid", "Operations associate", "", "Operations", "datup.rehearsal@ac-rehearsal.invalid", ""],
].map((r) => r.join(",")).join("\n") + "\n";
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 64" role="img" aria-label="${COMPANY}"><rect x="0" y="8" width="48" height="48" rx="12" fill="#0e7490"/>`
  + `<text x="24" y="40" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="700" fill="#ffffff">AC</text>`
  + `<text x="62" y="32" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="700" fill="#0f172a">Atlas Crest</text>`
  + `<text x="62" y="52" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600" fill="#0e7490" letter-spacing="2">REHEARSAL · SYNTHETIC</text></svg>`;

await mkdir(out, { recursive: true });
await writeFile(`${out}/rehearsal-logo.svg`, LOGO);
const browser = await chromium.launch();
const log = []; const note = (s) => { log.push(`${new Date().toISOString()} ${s}`); console.log(s); };
async function context(headers, width = 1440, theme = "light") {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: headers });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch {} }, theme);
  return ctx;
}
const settle = async (page) => { await page.waitForLoadState("load"); await page.waitForTimeout(700); };
// The operator's own avatar and check-in chip are masked: only synthetic people appear unmasked.
const shot = async (page, name, opts = {}) => { await settle(page); const own = page.url().startsWith(EA) ? [page.locator('header [class*="avatar" i], header img[alt]:not([alt=""])'), page.getByRole("button", { name: /Check in|Check out/ })] : [];
  await page.screenshot({ path: `${out}/${name}.png`, ...opts, mask: [...own, ...(opts.mask ?? [])], maskColor: "#c9cbd8" }); note(`shot ${name}`); };
const step = async (page, url, heading) => { await page.goto(url); await page.getByRole("heading", { name: heading }).first().waitFor(); await settle(page); };
const errors = (page) => { page.on("pageerror", (e) => note(`PAGE ERROR ${e.message}`)); };

const resumeDatup = process.env.DATUP_ISSUED;   // set only to resume after the company is open (see the README)
const shotsOnly = process.env.SHOTS_ONLY === "1"; // with DATUP_ISSUED: take the company's screenshots again, create nothing
let link = null;
// ---------------------------------------------------------------------------------------- the operator's wizard
const op = await context({ "Cf-Access-Authenticated-User-Email": operator });
if (!resumeDatup) {
const p = await op.newPage(); errors(p);
await p.goto(`${EA}/companies`); await settle(p);
// Every step can be run again: an earlier, interrupted walk is resumed rather than started twice.
const existing = p.getByRole("link", { name: COMPANY });
const resumed = (await existing.count()) > 0;
if (resumed) { await existing.first().click(); await p.waitForURL(/\/companies\/[0-9a-f-]{36}/); await p.goto(`${p.url().split("?")[0]}?step=company`); }
else {
  await shot(p, "01-companies-before");
  await p.getByLabel("Company name").fill(COMPANY);
  await p.getByRole("button", { name: "Set up a company" }).click();
  await p.waitForURL(/\/companies\/[0-9a-f-]{36}\?step=company/);
}
const setupUrl = p.url().split("?")[0]; note(`setup ${setupUrl}`);
await p.getByRole("heading", { name: "Company and address" }).waitFor(); await settle(p);
await p.getByLabel("Time zone").fill("Asia/Kolkata");
await p.getByLabel("Web address").fill(HOST);
await p.getByRole("button", { name: "Check first" }).click();
await p.getByText(/^(Creating it will|Saving will):$/).waitFor();
if (!resumed) await shot(p, "02-company-check");
await p.getByRole("button", { name: /^(Create company|Save)$/ }).click();
await step(p, `${setupUrl}?step=brand`, "Accent colour");
await p.getByRole("button", { name: /^Teal / }).click();
await p.waitForTimeout(800);
await p.locator('input[aria-label$="the logo, light background"]').setInputFiles(`${out}/rehearsal-logo.svg`);
await p.getByText("Logo, light background").locator("..").getByText("The sign-in page, e-mails and printed copies.").waitFor();
await p.getByRole("button", { name: "From initials" }).click();
await p.waitForTimeout(1200);
await shot(p, "03-brand");

await step(p, `${setupUrl}?step=admin`, "First admin");
await p.getByLabel("Full name").fill("Datup (rehearsal)");
await p.getByLabel("Work e-mail").fill("datup.rehearsal@ac-rehearsal.invalid");
await p.getByLabel("Title").fill("Founder (rehearsal)");
await p.getByRole("button", { name: /^(Add admin|Save admin)$/ }).click();
await p.getByRole("heading", { name: "Invitation" }).waitFor();
await shot(p, "04-admin-invitation-nothing-sent");
await p.getByLabel(/I will hand the link to Datup \(rehearsal\) privately/).check();
await p.getByRole("button", { name: "Get a private link" }).click();
const linkBox = p.locator("code").filter({ hasText: "/login/set-password#" });
await linkBox.waitFor();
link = (await linkBox.textContent()).trim();
await shot(p, "05-admin-private-link", { mask: [linkBox] });
if (!link.startsWith(`${AC}/login/set-password#`)) throw new Error(`unexpected link host: ${new URL(link).host}`);

await step(p, `${setupUrl}?step=people`, "People");
await p.getByLabel("Or paste the CSV").fill(PEOPLE);
await p.getByRole("button", { name: "Preview" }).click();
await p.getByRole("heading", { name: "Preview" }).waitFor();
await shot(p, "06-people-preview");
await p.getByRole("button", { name: /^Import \d+ people$/ }).click();
await p.getByRole("heading", { name: "Imported" }).waitFor();
await shot(p, "07-people-imported");

await step(p, `${setupUrl}?step=structure`, "Pods");
if (!(await p.locator("li", { hasText: /^Leadership$/ }).count())) { await p.getByLabel("New pod").fill("Leadership"); await p.getByRole("button", { name: "Add pod" }).click(); }
await p.getByLabel("Pod of Datup (rehearsal)").selectOption("Leadership");
await p.locator("tr", { has: p.locator("td:first-child b", { hasText: /^Datup \(rehearsal\)$/ }) }).getByLabel("Leadership").check();
const save = p.getByRole("button", { name: /^Save \d+ changes$/ });
if (await save.isEnabled()) { await save.click(); await p.getByText("Pods and roles saved").waitFor().catch(() => {}); }
await p.waitForTimeout(1000);
await shot(p, "08-pods-teams-roles");

await step(p, `${setupUrl}?step=settings`, "Modules");
await p.getByRole("switch", { name: /^Finance/ }).uncheck();
await p.getByRole("button", { name: "Save modules and rules" }).click();
await p.waitForTimeout(1200);
await shot(p, "09-modules-and-rules");

await step(p, `${setupUrl}?step=open`, "Checklist");
await shot(p, "10-checklist-before-open");
await p.getByRole("button", { name: "Run the isolation check" }).click();
await p.getByText(/tables read: nothing from another company/).waitFor({ timeout: 120000 });
await shot(p, "11-isolation-check");
await p.getByRole("button", { name: `Open ${COMPANY} for sign-in` }).click();
await p.getByText(/sign in at/).first().waitFor();
await shot(p, "12-open-for-sign-in");
await p.goto(`${EA}/companies`); await shot(p, "13-companies-after");
await p.goto(`${setupUrl}?step=company`); await p.setViewportSize({ width: 390, height: 844 }); await shot(p, "13b-wizard-phone");
} else if (shotsOnly) {
  // After opening: the operator's view of the company is its health, with counts only.
  const p = await op.newPage(); errors(p);
  await p.goto(`${EA}/companies`); await settle(p); await shot(p, "13-companies-after");
  await p.getByRole("link", { name: COMPANY }).first().click(); await p.getByRole("heading", { name: "Checklist" }).waitFor(); await shot(p, "12b-setup-after-open");
}

// ------------------------------------------------------------------------------- the company's own address
// EA's Access identity means nothing here: the company's sign-in page, with its logo and colour.
const cross = await context({ "Cf-Access-Authenticated-User-Email": operator });
const x = await cross.newPage(); errors(x);
await x.goto(`${AC}/dashboard`); await x.waitForURL(/\/login/);
await shot(x, "14-ac-address-ignores-ea-access");
const ac = await context({});
const d = await ac.newPage(); errors(d);
await d.goto(`${AC}/login`); await settle(d);
if (!resumeDatup) {
  await shot(d, "15-ac-sign-in");
  await d.goto(link);
  await d.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await d.getByLabel("New password again").fill(PASSWORD);
  await d.getByRole("button", { name: "Set password and start" }).click();
} else {
  // Resume: Datup signs in with the temporary password he issued himself, and changes it at once.
  await d.getByLabel("Username").fill("datup.rehearsal"); await d.getByLabel("Password", { exact: true }).fill(resumeDatup);
  await d.getByRole("button", { name: "Sign in", exact: true }).click();
  // An admin is sent to Account to set up two-step (required after the grace days); the password change comes first.
  await d.waitForURL(/change=1|\/account/); await d.goto(`${AC}/login?change=1`); await d.getByLabel("Current password").fill(resumeDatup);
  await d.getByLabel("New password", { exact: true }).fill(PASSWORD); await d.getByLabel("New password again").fill(PASSWORD);
  await d.getByRole("button", { name: "Set password and continue" }).click();
}
await d.waitForURL(/\/dashboard/, { timeout: 60000 });
if (!resumeDatup || shotsOnly) { await shot(d, "16-datup-dashboard"); await d.goto(`${AC}/people`); await shot(d, "17-datup-team-only-ac-people"); }

// Datup creates a project with his closers and setters, then gives two of them tasks.
await d.goto(`${AC}/tasks?view=projects`); await settle(d);
const haveProject = (await d.getByText("Lead follow-up sprint (rehearsal)").count()) > 0;
if (!haveProject && !shotsOnly) {
await d.getByRole("button", { name: /Create a task or a project/ }).first().click();
await d.getByRole("button", { name: /^Project/ }).click();
await d.getByLabel("Project name").fill("Lead follow-up sprint (rehearsal)");
for (const who of ["Kavya Nair", "Vikram Rao", "Aarav Mifos", "Rifob Gobap"]) {
  const add = d.getByRole("combobox", { name: "Add people" });
  if (!(await add.count())) await d.getByRole("button", { name: /^Add people:/ }).click();
  await add.fill(who.split(" ")[0]); await d.getByRole("option", { name: new RegExp(who) }).first().click();
}
await shot(d, "18-datup-new-project");
await d.getByRole("button", { name: "Create project" }).click();
await d.getByRole("dialog").waitFor({ state: "detached" }).catch(() => {});
await d.waitForTimeout(1200);
}
const tasks = [["Call back last week's warm leads", "Aarav Mifos"], ["Close the three Friday demos", "Rifob Gobap"], ["Review setter scripts with the team", "Kavya Nair"]];
for (const [title, who] of shotsOnly ? [] : tasks) {
  await d.getByRole("button", { name: /Create a task or a project/ }).first().click();
  await d.getByRole("button", { name: /^Task/ }).click();
  await d.getByLabel("What needs doing").fill(`${title} (rehearsal)`);
  await d.getByRole("button", { name: /^Who does it:/ }).click();
  await d.getByRole("combobox", { name: "Who does it" }).fill(who.split(" ")[0]);
  await d.getByRole("option", { name: new RegExp(who) }).first().click();
  // A short list opens without a search box (the kit's Combobox searches only longer lists).
  await d.getByRole("button", { name: /^Project:/ }).click();
  const search = d.getByRole("combobox", { name: "Project" });
  if (await search.count()) await search.fill("Lead follow-up");
  await d.getByRole("option", { name: /Lead follow-up sprint/ }).first().click();
  if (title.startsWith("Close")) await shot(d, "19-datup-assigns-task");
  await d.getByRole("button", { name: /^Assign to / }).click();
  await d.getByRole("dialog").waitFor({ state: "detached" }).catch(() => {});
  await d.waitForTimeout(900);
}
await d.goto(`${AC}/tasks?view=projects`); await shot(d, "20-datup-projects");
await d.getByText("Lead follow-up sprint (rehearsal)").first().click();
await d.waitForTimeout(1500); await shot(d, "21-datup-project-with-tasks");
await d.goto(`${AC}/tasks?view=team`); await shot(d, "22-datup-team-dashboard");
await d.goto(`${AC}/settings?tab=organisation`); await settle(d); await d.getByRole("button", { name: "Modules", exact: true }).click();
await d.getByRole("heading", { name: "Modules" }).first().waitFor(); await shot(d, "23-datup-settings-modules");
await d.goto(`${AC}/finance`); await shot(d, "24-datup-finance-off");
const phone = await context({}, 390);
await phone.addCookies(await ac.cookies());
const ph = await phone.newPage(); errors(ph);
await ph.goto(`${AC}/dashboard`); await shot(ph, "25-datup-phone-dashboard");
await ph.goto(`${AC}/tasks`); await shot(ph, "26-datup-phone-work");
const dark = await context({}, 1440, "dark");
await dark.addCookies(await ac.cookies());
const dk = await dark.newPage(); errors(dk);
await dk.goto(`${AC}/tasks?view=projects`); await shot(dk, "27-datup-projects-dark");

await writeFile(`${out}/rehearsal-log.txt`, log.join("\n") + "\n");
await browser.close();
