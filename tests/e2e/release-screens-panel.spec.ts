import { expect, test, type BrowserContext } from "@playwright/test";
import { screensPanel } from "../../tools/release-screens-panel.mjs";

// EST-1983: the staging smoke's read-only Screens and menu pass (tools/release-screens-panel.mjs) against the mock API,
// so its selectors follow the web app; on staging it signs in with the smoke's synthetic sessions instead.
test.skip(!!process.env.PULSE_BASE_URL, "Requires the isolated mock API");

test("release screens pass: panel, protected switches and /hidden recovery, read only", async ({ browser, baseURL }, info) => {
  test.setTimeout(150_000);
  const origin = new URL(baseURL!).origin;
  const identity = (role: string) => ({ "Cf-Access-Authenticated-User-Email": `${role === "admin" ? "admin" : "staff"}@screen-release.example` });
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    const newContext = async (role: string) => {
      const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 980 }, colorScheme: theme, extraHTTPHeaders: identity(role) });
      await ctx.addInitScript((t) => {
        localStorage.setItem("pulse.theme", t); localStorage.setItem("pulse.notify.browser.asked", "1");
        const w = window as Window & { __pulseCspViolations?: string[] }; w.__pulseCspViolations = [];
        document.addEventListener("securitypolicyviolation", (e) => w.__pulseCspViolations!.push(e.violatedDirective));
      }, theme);
      return ctx;
    };
    const receipt = await screensPanel({ newContext, closeContext: (ctx: BrowserContext) => ctx.close(), origin, width, theme, out: info.outputDir, environment: "mock" });
    expect(receipt).toMatchObject({ passed: true, writes: 0, canEdit: true, protectedScreens: ["/chats", "/dashboard", "/hr", "/me"] });
    expect(receipt.roles.admin.protected).toEqual(["Chats", "Dashboard", "HR desk", "My desk"]);
  }
  // Read only: the tenant's choice is still the untouched default.
  const admin = await browser.newContext({ extraHTTPHeaders: identity("admin") });
  expect(await (await admin.request.get(`${origin}/api/v0/settings/screens`)).json()).toMatchObject({ newScreensHidden: false, hidden: { admin: [], person: [], hr: [] } });
  await admin.close();
});
