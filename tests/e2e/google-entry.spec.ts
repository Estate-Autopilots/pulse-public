import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// EST-1399: Continue with Google and the one quiet attempt on the sign-in page (EST-1392 contract §3). The organisation's
// flag (public branding) and the server's start redirect are stubbed; people and records are synthetic.
const outputDir = () => process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? "test-results";
const deepLink = "/clients/synthetic-client-1?tab=visits";

/** Branding says Google is on (or not); every start the page makes is recorded and answered with `answer`. */
async function stub(page: Page, { google = true, answer }: { google?: boolean; answer?: (start: URL) => string | null } = {}) {
  const starts: URL[] = [];
  await page.route("**/api/v0/auth/branding", (route) => route.fulfill({ json: google ? { name: "Northwind Studio", google: true } : { name: "Northwind Studio" } }));
  await page.route("**/api/v0/auth/google/start**", async (route) => {
    const start = new URL(route.request().url());
    starts.push(start);
    const location = answer?.(start);
    if (location === null) return route.fulfill({ status: 204 }); // Keep the waiting page without a pending navigation blocking screenshots.
    await route.fulfill({ status: 302, headers: { location: new URL(location ?? "/login?google=silent_failed", start).href } });
  });
  return starts;
}

test("a deep link signs in quietly once: the cookie is set and the person lands where the link pointed", async ({ page, context }) => {
  const starts = await stub(page, { answer: (start) => start.searchParams.get("next") });
  await page.goto(`/login?next=${encodeURIComponent(deepLink)}`);
  await expect(page).toHaveURL(deepLink);
  expect(starts.map((start) => [start.searchParams.get("mode"), start.searchParams.get("next")])).toEqual([["silent", deepLink]]);
  const quiet = (await context.cookies()).find((cookie) => cookie.name === "pulse_oidc_quiet");
  expect(quiet?.value).toBe("1");
  expect(quiet?.path).toBe("/");
  expect(quiet?.sameSite).toBe("Lax");
  expect((quiet?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(540);
  // Signed out again within 10 minutes: the normal page, no second attempt.
  await page.goto(`/login?next=${encodeURIComponent(deepLink)}`);
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  expect(starts).toHaveLength(1);
});

test("a failed quiet attempt shows the normal page with Continue with Google and never tries again", async ({ page }) => {
  const starts = await stub(page, { answer: (start) => `/login?next=${encodeURIComponent(start.searchParams.get("next") ?? "")}&google=silent_failed` });
  await page.goto(`/login?next=${encodeURIComponent(deepLink)}`);
  await expect(page.getByText("Pulse could not sign you in with Google automatically.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveAttribute("href", `/api/v0/auth/google/start?mode=signin&next=${encodeURIComponent(deepLink)}`);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with company Google account" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  expect(starts).toHaveLength(1);
});

test("no quiet attempt over a session that ended, after signing out, or when the organisation has Google off", async ({ page, context, baseURL }) => {
  let starts = await stub(page);
  await context.addCookies([{ name: "pulse_session", value: "synthetic-revoked", url: baseURL! }]);
  await page.goto(`/login?next=${encodeURIComponent(deepLink)}`);
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await context.clearCookies();
  await page.goto("/login?out=1");
  await expect(page.getByText("You are signed out of Pulse on this device. Google and your other work apps stay signed in.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await page.goto("/login?google=");
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  expect(starts).toHaveLength(0);
  await page.unrouteAll();
  starts = await stub(page, { google: false });
  await page.goto(`/login?next=${encodeURIComponent(deepLink)}`);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
  expect(starts).toHaveLength(0);
});

test("an unsafe return path is dropped for Google and for the password", async ({ page }) => {
  const starts = await stub(page, { answer: () => "/login?google=silent_failed" });
  for (const unsafe of ["/\t/evil.example", "//x", "/\\x", "/login?change=1", "/api/v0/x", "/%6cogin", "/%61pi/v0/x"]) {
    await page.goto(`/login?next=${encodeURIComponent(unsafe)}&google=provider_error`);
    await expect(page.getByText("Google sign-in is not available right now.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveAttribute("href", "/api/v0/auth/google/start?mode=signin");
  }
  await page.goto(`/login?next=${encodeURIComponent("/\t/evil.example")}`);
  await expect(page.getByText("Pulse could not sign you in with Google automatically.", { exact: false })).toBeVisible();
  expect(starts.map((start) => start.searchParams.has("next"))).toEqual([false]);
  // EST-1443: the tab path that used to reach another site after a password sign-in now lands on the dashboard.
  await page.goto(`/login?next=${encodeURIComponent("/\t/evil.example")}&google=provider_error`);
  await page.route("**/api/v0/auth/sign-in", (route) => route.fulfill({ json: {} }));
  await page.getByLabel("Username").fill("synthetic.person");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-passphrase");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("after Google, Pulse 2-step still asks for the code, sends it alone and returns to the deep link", async ({ page }) => {
  await stub(page);
  let sent: unknown;
  await page.route("**/api/v0/auth/two-step", async (route) => { sent = route.request().postDataJSON(); await route.fulfill({ json: {} }); });
  await page.goto(`/login?next=${encodeURIComponent(deepLink)}&google=two_step`);
  await expect(page.getByRole("heading", { name: "Verify it’s you" })).toBeVisible();
  await page.getByLabel("Authenticator or recovery code").fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page).toHaveURL(deepLink);
  expect(sent).toEqual({ code: "123456" });
});

test("sign-in with Google in both themes and at phone width: waiting, button, not linked", async ({ browser }) => {
  test.setTimeout(90_000);
  const shots = outputDir();
  await mkdir(shots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce" });
      await context.addInitScript((value) => localStorage.setItem("pulse.theme", value), theme);
      const page = await context.newPage();
      await stub(page, { answer: () => null });
      await page.goto(`/login?next=${encodeURIComponent(deepLink)}`);
      await expect(page.getByRole("heading", { name: "Signing you in…" })).toBeVisible();
      await page.screenshot({ path: join(shots, `google-waiting-${theme}-${width}.png`), fullPage: true });
      for (const reason of ["silent_failed", "not_linked", "provider_error", "domain_not_allowed", "account_disabled", "state_invalid", "two_step"]) {
        await page.goto(`/login?next=${encodeURIComponent(deepLink)}&google=${reason}`);
        await expect(page.getByRole(reason === "two_step" ? "heading" : "link", { name: reason === "two_step" ? "Verify it’s you" : "Continue with Google" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        await page.screenshot({ path: join(shots, `google-${reason}-${theme}-${width}.png`), fullPage: true });
      }
      await context.close();
    }
  }
});
