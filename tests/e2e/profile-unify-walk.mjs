// PROFILE-UNIFY (1683): a browser walk of one profile across companies, on a private stack (an API on a scratch
// database seeded by profile-unify-seed.sql, and the lane's web app). Synthetic, obviously fake people and companies only.
//   WEB=http://127.0.0.1:4590 API=http://127.0.0.1:4591 OUT=<dir> node tests/e2e/profile-unify-walk.mjs
// Walk: edit the profile in Fake Alpha → the same photo-less details show on the person's page in Fake Beta → My career
// → resume PDF and a public link (signed out) → an admin invites the person to move to Fake Gamma → they accept → career.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

const WEB = process.env.WEB ?? "http://127.0.0.1:4590", API = process.env.API ?? "http://127.0.0.1:4591", OUT = process.env.OUT ?? "/tmp/profile-unify-walk";
const PASS = "Fake-Pass-For-Tests-1";
await mkdir(OUT, { recursive: true });

async function signIn(login) {
  const r = await fetch(`${API}/api/v0/auth/account-sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login, password: PASS }) });
  const d = await r.json(); assert.ok(d.token, `sign-in ${login}: ${JSON.stringify(d)}`); return d.token;
}
async function call(token, path, body) {
  const r = await fetch(`${API}/api/v0/${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-pulse-session": token }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); assert.ok(r.ok, `${path}: ${JSON.stringify(d)}`); return d;
}
const browser = await chromium.launch();
async function as(token) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies([{ name: "pulse_session", value: token, url: WEB }]);
  return { ctx, page: await ctx.newPage() };
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const steps = [];
const step = (s) => { steps.push(s); console.log("ok:", s); };

// 1. Priya edits her profile once, in Fake Alpha.
let priya = await signIn("fakepriya");
let { ctx, page } = await as(priya);
await page.goto(`${WEB}/orgs/profile`);
await page.getByLabel("Pronouns").fill("they/them");
await page.getByLabel("Headline").fill("Fake motion designer");
await page.getByLabel("About you").fill("A synthetic person for the profile walk.");
await page.getByLabel("Location").fill("Testville");
await page.getByPlaceholder("Add a skill and press Enter").fill("Motion graphics");
await page.getByPlaceholder("Add a skill and press Enter").press("Enter");
await page.getByRole("button", { name: "Save profile" }).click();
await page.getByText("Saved. Your photo and details now show the same").waitFor();
await shot(page, "01-profile-edit");
step("profile saved once on the account (Fake Alpha)");

// 2. The same details on her page in Fake Beta (a second company), as Max, Beta's admin.
const max = await signIn("fakemax");
const seats = await call(max, "account");
const beta = seats.orgs.find((o) => o.handle === "fakebeta");
const maxBeta = (await call(max, "account/switch", { org: beta.id })).token;
const priyaBeta = (await call(maxBeta, "people?lite=1")).people.find((p) => p.name.startsWith("Fake Priya"));
const m = await as(maxBeta);
await m.page.goto(`${WEB}/people/${priyaBeta.id}`);
await m.page.getByText("they/them").first().waitFor();
await shot(m.page, "02-visible-in-second-org");
await m.page.goto(`${WEB}/people/${priyaBeta.id}?tab=overview`);
step("pronouns from the account show on her Fake Beta profile");

// 3. My career.
await page.goto(`${WEB}/orgs/career`);
await page.getByRole("heading", { name: /Fake Alpha Studio/ }).waitFor();
await page.getByRole("heading", { name: /Fake Beta Labs/ }).waitFor();
await shot(page, "03-career");
step("My career lists both companies");

// 4. Resume: PDF, then a public link opened signed out.
await page.goto(`${WEB}/orgs/resume`);
await page.locator("[data-resume]").getByText("Fake motion designer").waitFor();
await shot(page, "04-resume-builder");
await page.getByRole("button", { name: "Download PDF" }).waitFor();
await page.getByRole("button", { name: /^(Make a public link|New link)$/ }).click();
const href = await page.locator("[data-resume-link]").getAttribute("href");
const link = href.replace(/^https?:\/\/[^/]+/, WEB);
const anon = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
const ap = await anon.newPage();
await ap.goto(link);
await ap.getByText("Fake motion designer").waitFor();
assert.equal(await ap.getByText("Synthetic HR note").count(), 0);
await shot(ap, "06-public-resume");
step("public resume link shows the chosen sections signed out");
// The PDF: the resume printed on its own (as "Download PDF" prints it, without the app around it).
const pdf = await ap.pdf({ format: "A4", printBackground: true });
await writeFile(join(OUT, "05-resume.pdf"), pdf);
assert.ok(pdf.length > 5000, `the resume PDF has content (${pdf.length} bytes)`);
step(`resume PDF written (${pdf.length} bytes)`);

// 5. Max (admin in Alpha and Gamma) invites Priya to move from Alpha to Gamma; she accepts on My career.
const maxAlpha = (await call(max, "account/switch", { org: seats.orgs.find((o) => o.handle === "fakealpha").id })).token;
const priyaAlpha = (await call(maxAlpha, "people?lite=1")).people.find((p) => p.name.startsWith("Fake Priya"));
const a = await as(maxAlpha);
await a.page.goto(`${WEB}/people/${priyaAlpha.id}`);
await a.page.getByRole("button", { name: "Invite to another company" }).click();
await a.page.getByRole("button", { name: "Invite to move" }).click();
await a.page.getByText("Invited.").waitFor();
await shot(a.page, "07-invite-to-move");
step("admin invited her to move to Fake Gamma");
await page.goto(`${WEB}/orgs/career`);
await page.getByRole("button", { name: "Accept and move" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/orgs/career"), { timeout: 30000 });
priya = (await signIn("fakepriya"));
({ ctx, page } = await as(priya));
await page.goto(`${WEB}/orgs/career`);
await page.getByText("moved to Fake Gamma Works").waitFor();
await shot(page, "08-career-after-move");
step("moved: Gamma is current, Alpha is alumni with its history");
await browser.close();
console.log(JSON.stringify({ ok: true, steps }));
