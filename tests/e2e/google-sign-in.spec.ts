import { expect, test, type Page, type Route } from "@playwright/test";

// EST-1398: Account → Google and Settings → Sign-in → Google over contract EST-1392 §3, against synthetic data. The
// Google start redirect is stubbed; the API's own checks are covered by tests/core/test_google_sign_in.py.
test.skip(Boolean(process.env.PULSE_BASE_URL), "Uses synthetic identities and routed Google sign-in calls.");

const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const hr = { "Cf-Access-Authenticated-User-Email": "hr@estateautopilots.com" };
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const settings = { configured: true, enabled: false, allowedDomains: [], trustGoogle2Step: false, passwordSignIn: "on" };

async function account(page: Page, link: () => unknown) {
  await page.route("**/api/v0/auth/account", (route) => route.fulfill(json({ delivery: null, twoStep: false, recoveryRemaining: 0, sessions: [], activity: [], googleLink: link() })));
}

test("Account → Google: loading has a skeleton and an unavailable account can retry", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  let release!: () => void, reads = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v0/auth/account", async (route) => {
    if (++reads === 1) { await pending; return route.fulfill(json({ error: "Account unavailable. Try again." }, 503)); }
    return route.fulfill(json({ delivery: null, twoStep: false, recoveryRemaining: 0, sessions: [], activity: [], googleLink: null }));
  });
  await page.goto("/account?google=state_invalid");
  await expect(page.getByRole("status", { name: "Loading account security" })).toBeVisible();
  release();
  await expect(page.locator("#main-content").getByRole("alert")).toHaveText("Account unavailable. Try again.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Not linked.")).toBeVisible();
});

test("Account → Google: explains linking, shows the result and unlinks", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  let link: unknown = null;
  await account(page, () => link);
  await page.route(/\/api\/v0\/auth\/google\/start\?/, (route) => { link = { email: "sam@studio.example", linkedAt: "2026-10-19T08:00:00Z", lastUsedAt: null }; return route.fulfill({ status: 302, headers: { location: "/account?google=linked" } }); });
  let unlinked = "";
  await page.route("**/api/v0/auth/google/unlink", (route) => { unlinked = route.request().postData() ?? ""; link = null; return route.fulfill(json({ ok: true })); });

  await page.goto("/account");
  const main = page.locator("#main-content");
  await page.getByRole("tab", { name: "Google" }).click();
  await expect(page.getByText("Not linked.")).toBeVisible();
  await expect(page.getByText(/already exists and is linked here; it never creates one/)).toBeVisible();
  await page.getByRole("link", { name: "Link Google" }).click();
  await expect(main.getByRole("status")).toHaveText(/Google account linked/);
  await expect(page.getByText("sam@studio.example")).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);

  await page.getByRole("button", { name: "Unlink Google" }).click();
  await page.getByRole("button", { name: "Confirm unlink" }).click();
  await expect(main.getByRole("status")).toHaveText(/Google unlinked/);
  await expect(page.getByText("Not linked.")).toBeVisible();
  expect(JSON.parse(unlinked)).toEqual({});
});

test("Account → Google: a refused link says why and offers Link Google again", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await account(page, () => null);
  await page.goto("/account?google=domain_not_allowed");
  const main = page.locator("#main-content");
  await expect(page.getByRole("tab", { name: "Google" })).toHaveAttribute("aria-selected", "true");
  await expect(main.getByRole("alert")).toHaveText(/isn’t in one of your organisation’s Workspace domains/);
  await expect(main.getByRole("alert")).toHaveAttribute("data-tone", "blocked");
  await expect(page.getByRole("link", { name: "Link Google" })).toHaveAttribute("href", "/api/v0/auth/google/start?mode=link&next=/account");
});

test("Settings → Google: trust is off by default, a failed save keeps changes, the 2-step code travels in its header", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  const puts: { body: Record<string, unknown>; code?: string }[] = [];
  await page.route("**/api/v0/admin/sign-in/google", async (route) => {
    if (route.request().method() === "GET") return route.fulfill(json(settings));
    const body = route.request().postDataJSON(), code = route.request().headers()["x-pulse-two-step"];
    puts.push({ body, code });
    return route.fulfill(code ? json({ ...body, configured: true }) : json({ error: "Fresh Pulse two-step required" }, 403));
  });
  await page.goto("/settings?tab=sign-in&section=Google");
  const pane = page.locator('[data-section="Google"]');
  const trust = pane.getByRole("switch", { name: "Trust Google 2-step" });
  await expect(trust).not.toBeChecked();
  await expect(pane.getByText(/Only switch this on if 2-step verification is enforced for every user of these domains/)).toBeVisible();

  await pane.getByRole("switch", { name: "Allow Continue with Google" }).check();
  const save = pane.getByRole("button", { name: "Save Google sign-in" });
  await expect(pane.getByText("Add at least one Workspace domain before switching Google on.")).toBeVisible();
  await expect(save).toBeDisabled();
  await pane.getByLabel("Allowed Workspace domains").fill("Studio.example");
  await trust.check();
  await save.click();
  await expect(pane.getByRole("alert")).toHaveText("Enter a current code from your authenticator app to change Trust Google 2-step. Your changes are still here.");
  await expect(pane.getByLabel("Allowed Workspace domains")).toHaveValue("Studio.example");
  await expect(trust).toBeChecked();

  await pane.getByLabel("Your Pulse 2-step code").fill("123456");
  await save.click();
  await expect(pane.getByRole("status")).toHaveText("Google sign-in saved.");
  expect(puts.at(-1)).toEqual({ code: "123456", body: { enabled: true, allowedDomains: ["studio.example"], trustGoogle2Step: true, passwordSignIn: "on" } });
});

test("Settings → Google: a server without a Google client keeps the switch off", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await page.route("**/api/v0/admin/sign-in/google", (route) => route.fulfill(json({ ...settings, configured: false })));
  await page.goto("/settings?tab=sign-in&section=Google");
  const pane = page.locator('[data-section="Google"]');
  await expect(pane.getByText(/isn’t set up on this server yet/)).toBeVisible();
  await expect(pane.getByRole("switch", { name: "Allow Continue with Google" })).toBeDisabled();
});

test("Settings → Google: HR sees no controls and the settings are never read", async ({ page }) => {
  await page.setExtraHTTPHeaders(hr);
  let reads = 0;
  await page.route("**/api/v0/admin/sign-in/google", (route) => { reads += 1; return route.fulfill(json({ error: "Admin required" }, 403)); });
  await page.goto("/settings?tab=sign-in&section=Google");
  const pane = page.locator('[data-section="Google"]');
  await expect(pane.getByText("Admins only")).toBeVisible();
  await expect(pane.getByRole("switch")).toHaveCount(0);
  expect(reads).toBe(0);
});

test("People → Account access: an admin unlinks someone's Google with the action alone", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await page.route("**/api/v0/admin/auth-history/synthetic-sam", (route) => route.fulfill(json({ authStatus: "active", delivery: null, workEmail: null, draftDelivery: null, verifiedDelivery: null, lastLoginAt: null, emailPending: null, activity: [], sessions: [] })));
  let body: unknown;
  await page.route("**/api/v0/people/synthetic-sam/login", (route) => { body = route.request().postDataJSON(); return route.fulfill(json({ ok: true })); });
  await page.goto("/settings?tab=sign-in");
  await page.locator('[data-section="Who can sign in"]').getByRole("button", { name: "Account access" }).click();
  await page.getByRole("button", { name: "Unlink Google" }).click();
  await page.getByRole("button", { name: "Confirm unlink Google" }).click();
  await expect(page.getByText("Google unlinked. Their password still works.")).toBeVisible();
  expect(body).toEqual({ action: "google-unlink" });
});

test("normal sign-in and password recovery stay intact", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to Pulse" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
});

// Transport failures, non-JSON gateways and empty API errors must all leave a useful recovery path.
for (const failure of ["offline", "html", "empty"] as const) test(`Google recovery guidance: ${failure}`, async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  const reconnect = "Pulse could not be reached. Check your connection and try again.";
  const refuse = (r: Route) => failure === "offline" ? r.abort() : r.fulfill(failure === "html" ? { status: 502, contentType: "text/html", body: "<html>Gateway failure</html>" } : json({}, 503));
  await page.route("**/api/v0/auth/account", refuse);
  await page.goto("/account");
  const main = page.locator("#main-content");
  await expect(main.getByRole("alert")).toHaveText(failure === "empty" ? "Account security is unavailable." : reconnect);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.unroute("**/api/v0/auth/account");
  await account(page, () => ({ email: "sam@studio.example", linkedAt: "2026-10-19T08:00:00Z", lastUsedAt: null }));
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("tab", { name: "Google" }).click();
  await page.route("**/api/v0/auth/google/unlink", refuse);
  await page.getByRole("button", { name: "Unlink Google", exact: true }).click();
  await page.getByRole("button", { name: "Confirm unlink", exact: true }).click();
  await expect(main.getByRole("alert")).toHaveText(failure === "empty" ? "Could not unlink Google. Try again." : reconnect);
  await page.route("**/api/v0/admin/sign-in/google", r => r.request().method() === "GET" ? r.fulfill(json(settings)) : refuse(r));
  await page.goto("/settings?tab=sign-in&section=Google");
  const pane = page.locator('[data-section="Google"]');
  await pane.getByLabel("Allowed Workspace domains").fill("studio.example");
  await pane.getByRole("button", { name: "Save Google sign-in" }).click();
  await expect(pane.getByRole("alert")).toHaveText(`${failure === "empty" ? "Could not save Google sign-in." : reconnect} Your changes are still here.`);
  await expect(pane.getByLabel("Allowed Workspace domains")).toHaveValue("studio.example");
});

test("Google self-unlink keeps the session restriction and explains password recovery", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await account(page, () => ({ email: "sam@studio.example", linkedAt: "2026-10-19T08:00:00Z", lastUsedAt: null }));
  let body: unknown;
  await page.route("**/api/v0/auth/google/unlink", route => {
    body = route.request().postDataJSON();
    return route.fulfill(json({ error: "Use your browser account session" }, 403));
  });
  await page.goto("/account?google=linked");
  await page.getByRole("button", { name: "Unlink Google", exact: true }).click();
  await page.getByRole("button", { name: "Confirm unlink", exact: true }).click();
  await expect(page.locator("#main-content").getByRole("alert")).toHaveText("Sign in with your Pulse password, then unlink Google.");
  await expect(page.getByText("sam@studio.example")).toBeVisible();
  expect(body).toEqual({});
});

test("unknown Google results are calm alerts with a retry link", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await account(page, () => null);
  await page.goto("/account?google=unknown_synthetic_result");
  const alert = page.locator("#main-content").getByRole("alert");
  await expect(alert).toHaveText("Google didn’t link your account. Link Google again from this page.");
  await expect(alert).toHaveAttribute("data-tone", "blocked");
  await expect(page.getByRole("link", { name: "Link Google" })).toBeVisible();
});

for (const refusal of ["Google sign-in is not configured", "Invalid Google settings", "Try again.", "Try again!"]) {
  test(`Settings save punctuation: ${refusal}`, async ({ page }) => {
    await page.setExtraHTTPHeaders(admin);
    await page.route("**/api/v0/admin/sign-in/google", route => route.fulfill(
      route.request().method() === "GET" ? json(settings) : json({ error: refusal }, 409)));
    await page.goto("/settings?tab=sign-in&section=Google");
    const pane = page.locator('[data-section="Google"]');
    await pane.getByLabel("Allowed Workspace domains").fill("studio.example");
    await pane.getByRole("button", { name: "Save Google sign-in" }).click();
    await expect(pane.getByRole("alert")).toHaveText(`${refusal}${/[.!?]$/.test(refusal) ? "" : "."} Your changes are still here.`);
    await expect(pane.getByLabel("Allowed Workspace domains")).toHaveValue("studio.example");
    await expect(pane.getByRole("switch", { name: "Trust Google 2-step" })).not.toBeChecked();
  });
}

test("Password sign-in owns its help; the domain field stays valid", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await page.route("**/api/v0/admin/sign-in/google", route => route.fulfill(json(settings)));
  await page.goto("/settings?tab=sign-in&section=Google");
  const pane = page.locator('[data-section="Google"]');
  await pane.getByRole("radio", { name: "People with a linked Google account use Google" }).check();
  await expect(pane.getByRole("group", { name: "Password sign-in" })).toHaveAccessibleDescription("Switch on Continue with Google before linked people must use it.");
  await expect(pane.getByLabel("Allowed Workspace domains")).toHaveAttribute("aria-invalid", "false");
  await expect(pane.locator("#google-domains-hint")).not.toContainText("Switch on");
  await expect(pane.getByRole("button", { name: "Save Google sign-in" })).toBeDisabled();
  await pane.getByRole("switch", { name: "Trust Google 2-step" }).check();
  await expect(pane.getByLabel("Your Pulse 2-step code")).toHaveAttribute("placeholder", "Needed if you use 2-step");
});

for (const theme of ["light", "dark"] as const) for (const width of [1440, 390]) {
  test(`Account layout and disabled primary contrast: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript(value => localStorage.setItem("pulse.theme", value), theme);
    await page.setExtraHTTPHeaders(admin);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v0/auth/account", async route => {
      await pending;
      return route.fulfill(json({ delivery: null, twoStep: false, recoveryRemaining: 0, sessions: [], activity: [], googleLink: null }));
    });
    await page.goto("/account?google=linked");
    const loading = page.getByRole("status", { name: "Loading account security" });
    await expect(loading).toBeVisible();
    const loadingWidth = (await loading.boundingBox())!.width;
    release();
    const google = page.locator("section").filter({ has: page.getByRole("heading", { name: "Google", exact: true }) });
    await expect(google).toBeVisible();
    expect(Math.abs((await google.boundingBox())!.width - loadingWidth)).toBeLessThan(2);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await expect(page.locator("#main-content").getByText("Your password, sessions, delivery email and Google")).toHaveText("Your password, sessions, delivery email and Google");
    if (width === 390) await expect(page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Home (Dashboard)" })).not.toHaveAttribute("aria-current", "page");
    const success = page.locator("#main-content").getByRole("status");
    await expect(success).toHaveText(/Google account linked/);
    await expect(success).not.toHaveAttribute("data-tone", "blocked");
    await page.route("**/api/v0/admin/sign-in/google", route => route.fulfill(json(settings)));
    await page.goto("/settings?tab=sign-in&section=Google");
    const save = page.getByRole("button", { name: "Save Google sign-in" });
    await expect(save).toBeDisabled();
    const contrast = await save.evaluate(button => {
      const style = getComputedStyle(button);
      const luminance = (rgb: string) => rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => {
        const n = v / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(3);
    const distinct = await save.evaluate(button => {
      const style = getComputedStyle(button);
      return style.getPropertyValue("--theme-disabled-text").trim() !== style.getPropertyValue("--theme-text-muted").trim();
    });
    expect(distinct).toBe(true);
  });
}
