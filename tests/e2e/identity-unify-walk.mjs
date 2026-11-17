// IDENTITY-UNIFY (1746): a browser walk of one @handle across companies, on a private stack (an API on a scratch
// database seeded by identity-unify-seed.sql, and the lane's web app). Synthetic, obviously fake people and companies.
//   WEB=http://127.0.0.1:4594 API=http://127.0.0.1:4595 OUT=<dir> node tests/e2e/identity-unify-walk.mjs
// Walk: sign in at the shared address with an OLD username → the profile page says the one @handle, lists the old
// names and the company where someone else has it → a colleague in Fake Beta sees @fakesam, not @fakesam123 → the
// person sees their whole career on their own page in Fake Beta → light and dark, desktop and phone.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

const WEB = process.env.WEB ?? "http://127.0.0.1:4594", API = process.env.API ?? "http://127.0.0.1:4595", OUT = process.env.OUT ?? "/tmp/identity-unify-walk";
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
async function as(token, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...opts });
  await ctx.addCookies([{ name: "pulse_session", value: token, url: WEB }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000); page.setDefaultNavigationTimeout(900000); // a dev server compiles each page on first visit
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const steps = [];
const step = (s) => { steps.push(s); console.log("ok:", s); };

// 1. The old Fake Beta username signs in at the shared address (and a wrong password still does not).
const bad = await fetch(`${API}/api/v0/auth/account-sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "fakesam123", password: "Wrong-Pass-For-Tests-9" }) });
assert.equal(bad.status, 401);
const sam = await signIn("fakesam123");
assert.equal((await call(sam, "account")).account.handle, "fakesam");
step("the old username fakesam123 signs in to @fakesam; a wrong password is refused");

// 2. The profile page: one @handle, the old names, the company where someone else already has it.
const profile = await call(sam, "account/profile");
assert.deepEqual(profile.names.old, ["fakesam123"]);
assert.deepEqual(profile.names.kept, [{ company: "Fake Gamma Works", username: "fake.sam.seats" }]);
let { page } = await as(sam);
await page.goto(`${WEB}/orgs/profile`, { waitUntil: "domcontentloaded" });
const card = page.locator("[data-identity]");
await card.getByText("Your username is").waitFor();
assert.match(await card.innerText(), /Your username is @fakesam, the same in every company\./);
assert.match(await card.locator("[data-identity-old]").innerText(), /@fakesam123/);
assert.match(await card.locator("[data-identity-kept]").innerText(), /In Fake Gamma Works, someone else already uses @fakesam, so you are still @fake\.sam\.seats there\./);
await shot(page, "01-profile-one-handle");
step("profile: one @handle, old names listed, the clash in Fake Gamma Works explained");

// 3. A colleague (Fake Beta's admin) sees @fakesam on Sam's Fake Beta page.
const max = await signIn("fakemaxu");
const samBeta = (await call(max, "people?lite=1")).people.find((p) => p.name === "Fake Sam Seats");
const m = await as(max);
await m.page.goto(`${WEB}/people/${samBeta.id}`, { waitUntil: "domcontentloaded" });
await m.page.getByText("fakesam", { exact: true }).first().waitFor();
assert.equal(await m.page.getByText("fakesam123", { exact: true }).count(), 0, "the old username is not shown any more");
await shot(m.page, "02-colleague-sees-one-handle");
step("in Fake Beta a colleague sees @fakesam (not fakesam123)");

// 4. Sam's own page in Fake Beta: the whole career (three companies), shared or not.
const orgs = (await call(sam, "account")).orgs;
const samInBeta = (await call(sam, "account/switch", { org: orgs.find((o) => o.handle === "fakeubeta").id })).token;
const own = await as(samInBeta);
await own.page.goto(`${WEB}/people/${samBeta.id}`, { waitUntil: "domcontentloaded" });
// An admin's view has an Overview sub-section "Profile everywhere"; the person's own view shows the card under the record.
const career = own.page.locator("[data-career]");
try { await career.waitFor({ timeout: 120000 }); } catch {
  await own.page.getByText("Profile everywhere", { exact: true }).first().click();
  await career.waitFor();
}
for (const c of ["Fake Alpha Studio", "Fake Beta Labs", "Fake Gamma Works"]) await career.getByText(c).first().waitFor();
await shot(own.page, "03-own-career-in-second-company");
step("the person sees their career from all three companies on their Fake Beta page");

// 5. Light/dark and phone.
for (const [name, opts] of [["04-dark-desktop", { colorScheme: "dark" }], ["05-phone", { viewport: { width: 390, height: 844 }, isMobile: true }]]) {
  const v = await as(sam, opts); // the theme follows the system by default (ui-shell theme-provider)
  await v.page.goto(`${WEB}/orgs/profile`, { waitUntil: "domcontentloaded" });
  await v.page.locator("[data-identity]").getByText("Your username is").waitFor();
  const box = await v.page.locator("[data-identity]").boundingBox();
  assert.ok(box && box.width <= (opts.viewport?.width ?? 1440), "the card fits the screen");
  if (opts.colorScheme === "dark") assert.equal(await v.page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await shot(v.page, name);
}
step("the username card fits a phone and reads in dark mode");

await browser.close();
console.log(`WALK ${steps.length}/5 steps passed; screenshots in ${OUT}`);
