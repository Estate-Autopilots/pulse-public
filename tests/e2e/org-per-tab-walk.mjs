// ORG-PER-TAB: two tabs of one browser profile in two fake companies at once, on a private stack (an API on a scratch
// database seeded by org-per-tab-seed.sql, and the lane's web app). Synthetic, obviously fake data.
//   WEB=http://127.0.0.1:4611 API=http://127.0.0.1:4612 OUT=<dir> node tests/e2e/org-per-tab-walk.mjs
// API: a tab's company opens beside the sign-in; a forged company (one the account is not in, or no company) answers
// "Not found" with no data; sign-out ends every company. Browser (1440 and 363 wide): tab A in Fake Estate Co, tab B
// opens Fake Vitals Tech, A stays; a Fake Vitals Tech doc link in A opens there ("Opened in …"), B stays; the switcher
// says which company the tab is in; a Fake Stranger Co doc still says not found; sign-out of one company, then of all.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

const WEB = process.env.WEB ?? "http://127.0.0.1:4611", API = process.env.API ?? "http://127.0.0.1:4612", OUT = process.env.OUT ?? "/tmp/org-per-tab-walk";
const PASS = "Fake-Pass-For-Tests-1";
// SLOW=3 on a busy host or `next dev` (first compiles of a page can take a minute or more).
const SLOW = Math.max(1, Number(process.env.SLOW ?? 1) || 1);
const FVT = "f1000000-0000-4000-8000-000000000001", FEC = "f2000000-0000-4000-8000-000000000002", FSC = "f3000000-0000-4000-8000-000000000003";
const DOC_FVT = "d1000000-0000-4000-8000-000000000001", DOC_FSC = "d3000000-0000-4000-8000-000000000003";
await mkdir(OUT, { recursive: true });
const steps = [];
const step = (s) => { steps.push(s); console.log("ok:", s); };

async function call(token, path, { body, org, expect = 200 } = {}) {
  const r = await fetch(`${API}/api/v0/${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { "x-pulse-session": token } : {}), ...(org ? { "x-pulse-org": org } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => null); assert.equal(r.status, expect, `${path} (${org ?? "no tab"}): ${r.status} ${JSON.stringify(d)}`); return d;
}
const signIn = async () => { const s = await call(null, "auth/account-sign-in", { body: { login: "faketab", password: PASS } }); assert.ok(s.token); return s; };

// ---- API ------------------------------------------------------------------------------------------------------------
{
  const s = await signIn(); const t = s.token;
  assert.equal(s.org, FEC, "the sign-in lands in the company used last");
  assert.equal((await call(t, "me", { org: FVT })).orgName, "Fake Vitals Tech");
  assert.equal((await call(t, "me")).orgName, "Fake Estate Co", "the sign-in itself stays where it was");
  assert.equal((await call(t, "me", { org: FEC })).orgName, "Fake Estate Co");
  assert.equal((await call(t, `docs/${DOC_FVT}`, { org: FVT })).doc.id, DOC_FVT);
  await call(t, `docs/${DOC_FVT}`, { org: FEC, expect: 404 });
  step("api: one sign-in, Fake Vitals Tech in one tab and Fake Estate Co in another, each its own company's data");
  for (const forged of [FSC, "99999999-9999-4999-8999-999999999999"]) {
    const d = await call(t, "me", { org: forged, expect: 404 });
    assert.deepEqual(d, { error: "Not found", code: "tab_org_unavailable" });
    await call(t, `docs/${DOC_FSC}`, { org: forged, expect: 404 });
    await call(t, "account/tab-open", { body: { org: forged }, expect: 404 });
  }
  await call(t, `account/record-home?kind=doc&id=${DOC_FSC}`, { expect: 404 });
  assert.equal((await call(t, `account/record-home?kind=doc&id=${DOC_FVT}`)).org, FVT);
  step("api: a forged company (not the account's, or none) answers Not found with no data; a record link finds only the account's own company");
  await call(t, "auth/sign-out", { body: {}, org: FVT });
  await call(t, "me", { expect: 401 });
  await call(t, "me", { org: FVT, expect: 404 });
  step("api: sign-out (from a tab in Fake Vitals Tech) ends the sign-in in every company");
}

// ---- Browser --------------------------------------------------------------------------------------------------------
const browser = await chromium.launch();
const meIn = (p) => p.evaluate(async () => (await (await fetch("/api/v0/me")).json()).orgName);
/** The doc opens in this tab's company (its API answer as the tab asks for it) and the page shows its title somewhere. */
const docOpens = async (p, id, title) => {
  assert.equal(await p.evaluate(async (d) => (await fetch(`/api/v0/docs/${d}`)).status, id), 200, `doc ${id} opens in this tab`);
  // The doc's title is the editor's title field (a textarea: its value, not page text).
  await p.waitForFunction((t) => document.querySelector("[data-doc-title]")?.value === t || document.body.innerText.includes(t), title);
};
for (const [w, h, tag] of [[1440, 1000, "1440"], [363, 780, "363"]]) {
  try { await walkAt(w, h, tag); } catch (e) {
    for (const [i, p] of (globalThis.__pages ?? []).entries()) await p.screenshot({ path: join(OUT, `${tag}-failure-tab${i ? "B" : "A"}.png`), timeout: 20000 }).catch(() => {});
    throw e;
  }
}
await browser.close();
console.log(JSON.stringify({ ok: true, steps }, null, 1));
async function walkAt(w, h, tag) {
  const s = await signIn();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: "pulse_session", value: s.token, url: WEB }]);
  const shotDark = async (p, file) => {
    // The app follows the system's dark setting as it changes (ThemeProvider), so the whole page redraws dark.
    await p.emulateMedia({ colorScheme: "dark" });
    await p.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(OUT, file) });
    await p.emulateMedia({ colorScheme: "light" });
    await p.waitForFunction(() => document.documentElement.dataset.theme === "light");
  };
  /** The switcher (Ctrl+Shift+O) once the page has started (its title carries the company prefix); a press before the
   *  app listens is lost, so press again until it opens. */
  const openSwitcher = async (p, prefix) => {
    await p.waitForFunction((x) => document.title.startsWith(x), prefix, { timeout: 90000 * SLOW });
    for (let i = 0; ; i++) {
      await p.keyboard.press("Control+Shift+O");
      try { await p.locator("[data-tab-now]").waitFor({ timeout: 10000 * SLOW }); return; } catch (e) { if (i >= 4) throw e; }
    }
  };
  /** The page lands at `re`. On an overloaded host the dev server can break a page's stream (its server calls time
   *  out), so the page never starts: reload it once, as a person would, and say so in the log. */
  const landAt = async (p, re, what) => {
    try { await p.waitForURL(re, { timeout: 90000 * SLOW, waitUntil: "domcontentloaded" }); }
    catch {
      console.log(`  retry ${tag}: ${what}: the page did not start; reloaded once`);
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.waitForURL(re, { timeout: 90000 * SLOW, waitUntil: "domcontentloaded" });
    }
  };
  const noScrollX = async (p, what) => { const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(o <= 2, `${what} at ${tag}: ${o}px sideways`); };
  ctx.setDefaultTimeout(90000 * SLOW); ctx.setDefaultNavigationTimeout(120000 * SLOW);
  const a = await ctx.newPage(), b = await ctx.newPage();
  globalThis.__pages = [a, b];
  for (const [n, p] of [["A", a], ["B", b]]) p.on("framenavigated", (f) => { if (f === p.mainFrame()) console.log(`  nav ${tag} tab ${n}: ${f.url().replace(WEB, "")}`); });
  await a.goto(`${WEB}/docs`, { waitUntil: "domcontentloaded" });
  assert.equal(await meIn(a), "Fake Estate Co");
  await a.waitForFunction(() => document.title.startsWith("FEC · "), null, { timeout: 60000 * SLOW });
  // Tab B opens Fake Vitals Tech (the switcher's "Open in new tab" address).
  await b.goto(`${WEB}/at/${FVT}?next=${encodeURIComponent("/docs")}`, { waitUntil: "domcontentloaded" });
  await landAt(b, /\/docs$/, "tab B opening Fake Vitals Tech");
  await b.waitForLoadState("domcontentloaded");
  assert.equal(await meIn(b), "Fake Vitals Tech");
  await b.waitForFunction(() => document.title.startsWith("FVT · "), null, { timeout: 60000 * SLOW });
  await a.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await meIn(a), "Fake Estate Co", "tab A stayed in its company");
  await a.waitForFunction(() => document.title.startsWith("FEC · "), null, { timeout: 60000 * SLOW });
  step(`${tag}: tab B opened Fake Vitals Tech; tab A (reloaded) is still in Fake Estate Co`);
  // The switcher in tab B says which company this tab is in.
  await openSwitcher(b, "FVT · ");
  assert.match(await b.locator("[data-tab-now]").innerText(), /This tab:\s*Fake Vitals Tech/);
  assert.equal(await b.locator('a[aria-label="Open Fake Estate Co in a new tab"]').count(), 1);
  await noScrollX(b, "switcher");
  await b.screenshot({ path: join(OUT, `${tag}-light-switcher.png`) });
  await shotDark(b, `${tag}-dark-switcher.png`);
  // Switch tab B to Fake Estate Co with the switcher: tab A must not move (it is in Fake Estate Co already, so move A first).
  await b.keyboard.press("Escape");
  // A Fake Vitals Tech doc link opened in tab A opens that company in tab A, with a note.
  await a.goto(`${WEB}/docs/${DOC_FVT}`, { waitUntil: "domcontentloaded" });
  await landAt(a, new RegExp(`/docs/${DOC_FVT}$`), "tab A opening the Fake Vitals Tech doc link");
  await a.getByText("Opened in Fake Vitals Tech").first().waitFor({ timeout: 20000 * SLOW });
  await a.screenshot({ path: join(OUT, `${tag}-light-opened-doc.png`) });
  await shotDark(a, `${tag}-dark-opened-doc.png`);
  await docOpens(a, DOC_FVT, "Fake plan of Fake Vitals Tech");
  assert.equal(await meIn(a), "Fake Vitals Tech");
  await noScrollX(a, "opened doc");
  step(`${tag}: a Fake Vitals Tech doc link in tab A opened there with "Opened in Fake Vitals Tech"`);
  // Now tab B switches to Fake Estate Co with the switcher; tab A stays in Fake Vitals Tech.
  await openSwitcher(b, "FVT · ");
  await b.locator('[role="menuitemradio"]', { hasText: "Fake Estate Co" }).first().click();
  await b.waitForURL((u) => true, { waitUntil: "domcontentloaded" });
  await b.waitForFunction(() => document.title.startsWith("FEC · "), null, { timeout: 90000 * SLOW });
  await b.waitForLoadState("domcontentloaded");
  assert.equal(await meIn(b), "Fake Estate Co");
  await a.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await meIn(a), "Fake Vitals Tech", "a switch in tab B never moves tab A");
  await docOpens(a, DOC_FVT, "Fake plan of Fake Vitals Tech");
  step(`${tag}: switching tab B to Fake Estate Co left tab A in Fake Vitals Tech`);
  // A company the account is not in: still not found, nothing switches.
  await a.goto(`${WEB}/docs/${DOC_FSC}`, { waitUntil: "domcontentloaded" });
  assert.ok(!(await a.locator("main").innerText()).includes("Fake Stranger Co"), "never names a company the account is not in");
  assert.equal(await meIn(a), "Fake Vitals Tech");
  await a.screenshot({ path: join(OUT, `${tag}-light-stranger-doc.png`) });
  await shotDark(a, `${tag}-dark-stranger-doc.png`);
  step(`${tag}: a Fake Stranger Co doc says not found, and tab A stays in Fake Vitals Tech`);
  // Sign out of this company only (tab A, Fake Vitals Tech): tab B (Fake Estate Co) stays signed in.
  await a.goto(`${WEB}/docs`, { waitUntil: "domcontentloaded" });
  await openSwitcher(a, "FVT · ");
  await a.locator("[data-sign-out-company]").click();
  // The tab leaves for its home in the company still signed in.
  await a.waitForURL((u) => u.pathname !== "/docs", { waitUntil: "domcontentloaded" });
  await b.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await meIn(b), "Fake Estate Co", "tab B stays signed in");
  assert.equal(await meIn(a), "Fake Estate Co", "tab A opens the company still signed in");
  step(`${tag}: "Sign out of Fake Vitals Tech only" kept Fake Estate Co signed in in both tabs`);
  // Sign out of all: both tabs are signed out.
  await a.evaluate(async () => { await fetch("/api/v0/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); });
  const after = await b.evaluate(async () => (await fetch("/api/v0/me")).status);
  assert.equal(after, 401);
  await call(s.token, "me", { expect: 401 });
  step(`${tag}: sign-out ended every company in both tabs`);
  await ctx.close();
}
