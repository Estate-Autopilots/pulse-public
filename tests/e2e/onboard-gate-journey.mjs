// ONBOARD-GATE journey on the demo company (synthetic person only): a temporary password, the forced password change,
// "Set up your profile" step by step with a screenshot of each, and Pulse opening at the end. Before the wizard is
// done the API answers profile_incomplete; after, it answers.
// Run (pulse-dev, demo company on a password address):
//   ea-heavy node tests/e2e/onboard-gate-journey.mjs --base http://onboard-demo.localhost:3200 --user synthetic.joiner \
//     --temp <issued> --next <new> --out /tmp/onboard-gate-shots
// The person, the address and the issued password come from tests/e2e/fixtures/onboard-gate-demo.sql (synthetic values).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt("base", "http://onboard-demo.localhost:3200"), user = opt("user", "synthetic.joiner");
const temp = opt("temp", process.env.ONBOARD_TEMP ?? ""), next = opt("next", process.env.ONBOARD_NEXT ?? "");
const out = opt("out", "/tmp/onboard-gate-shots"); mkdirSync(out, { recursive: true });
const width = Number(opt("width", "390"));
if (!temp || !next) throw new Error("--temp and --next are required");

const results = []; const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) process.exitCode = 1; };
const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"] });
const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2, colorScheme: "light" });
let n = 0; const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: join(out, `${String(++n).padStart(2, "0")}-${name}.png`), fullPage: true }); };
const apiStatus = (path) => page.evaluate(async (p) => { const r = await fetch(p, { credentials: "include" }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, code: body?.code ?? null }; }, path);
const click = (name) => page.getByRole("button", { name }).first().click();
const nextStep = async (title) => { await page.getByRole("heading", { name: title }).first().waitFor({ timeout: 20000 }); };

try {
  // 1. Sign in with the issued (temporary) password.
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await shot("sign-in");
  await page.locator('input[name="username"]').fill(user);
  await page.locator('input[name="password"]').fill(temp);
  await page.locator('input[name="password"]').press("Enter");
  // 2. The forced password change.
  await page.locator('input[name="next"]').waitFor({ timeout: 20000 });
  await shot("set-password");
  if (await page.locator('input[name="current"]').count()) await page.locator('input[name="current"]').fill(temp);
  await page.locator('input[name="next"]').fill(next);
  if (await page.locator('input[name="again"]').count()) await page.locator('input[name="again"]').fill(next);
  await page.locator('input[name="next"]').press("Enter");
  // 3. Every page leads to "Set up your profile"; the API is closed.
  await page.waitForURL(/\/welcome/, { timeout: 30000 });
  check(true, "after the password change the app opens Set up your profile");
  await page.goto(`${base}/tasks`, { waitUntil: "networkidle" });
  check(/\/welcome/.test(page.url()), "another page redirects to the wizard");
  const closed = await apiStatus("/api/v0/tasks");
  check(closed.status === 403 && closed.code === "profile_incomplete", `the API answers profile_incomplete (${closed.status} ${closed.code})`);
  await shot("welcome");
  await click(/Set up my profile/);
  // 4. Your details (date of birth and photo are prefilled from HR in the fixture).
  await nextStep("Your details"); await shot("details");
  const fill = async (name, value) => { const f = page.locator(`input[name="${name}"]`); if (await f.count()) { await f.fill(value); } };
  await fill("legalName", "Synthetic Joiner Kalah"); await fill("preferredName", "Joiner");
  await fill("personalPhone", "90000 01234"); await fill("personalEmail", "joiner@northstar-demo.invalid");
  await fill("address", "12 Synthetic Lane, Kothrud"); await fill("city", "Pune"); await fill("pincode", "411038");
  await fill("emergencyName", "Synthetic Parent"); await fill("emergencyRelation", "Parent"); await fill("emergencyPhone", "90000 05678");
  await click(/Save and continue/);
  // 5. Your work: confirm and add skills.
  await nextStep("Your work"); await shot("work");
  const skills = page.getByPlaceholder("Canva, Excel, Cold calling");
  for (const s of ["Canva", "Premiere Pro"]) { await skills.fill(s); await skills.press("Enter"); }
  await shot("work-skills");
  await click(/Confirm and continue/);
  // 6. Bank for salary.
  await nextStep("Bank for salary"); await shot("bank");
  if (await page.locator('input[name="account"]').count()) {
    await fill("holder", "Synthetic Joiner Kalah"); await fill("ifsc", "HDFC0001234");
    await page.locator('input[name="ifsc"]').blur(); await page.waitForTimeout(1500);
    await fill("bank", "HDFC Bank"); await fill("branch", "Synthetic Branch");
    await fill("account", "000012340001"); await fill("confirm", "000012340001");
    await shot("bank-filled");
    await click(/Save and continue/);
  } else await click(/Keep and continue/);
  // 7. Documents: Aadhaar (masked), PAN (masked), photo.
  await nextStep("Documents"); await shot("documents");
  // Each ID card has its own number field and Save; after a save the card shows the masked number instead.
  for (const number of ["2345 6789 0124", "ABCPE1234F"]) {
    const form = page.locator("form").filter({ has: page.locator('input[name="number"]') }).first();
    await form.locator('input[name="number"]').fill(number);
    await form.getByRole("button", { name: "Save" }).click();
    await page.getByText(number.endsWith("F") ? "XXXXXX234F" : "XXXX XXXX 0124").first().waitFor({ timeout: 20000 });
  }
  await shot("documents-saved");
  await click(/^(Done|Continue)$/);
  // 8. You're all set; Pulse opens.
  await page.getByRole("heading", { name: /You’re all set|Nearly there/ }).waitFor({ timeout: 20000 });
  await shot("all-set");
  check(await page.getByRole("heading", { name: "You’re all set" }).count() > 0, "the last screen says You’re all set");
  await click(/Open Pulse/);
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
  check(!/\/welcome/.test(page.url()), `Pulse opens (${new URL(page.url()).pathname})`);
  const open = await apiStatus("/api/v0/tasks");
  check(open.status === 200, `the API answers again (${open.status})`);
  await shot("app-unlocked");
} catch (e) {
  check(false, `journey stopped: ${e.message.split("\n")[0]}`);
  await page.screenshot({ path: join(out, "zz-stopped.png"), fullPage: true }).catch(() => {});
} finally {
  writeFileSync(join(out, "journey.json"), JSON.stringify(results, null, 1));
  await browser.close();
}
