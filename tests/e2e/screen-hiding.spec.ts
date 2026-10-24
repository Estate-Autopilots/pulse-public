import { expect, test, type Page } from "@playwright/test";

// EST-1803: synthetic, tenant-isolated fixtures; never run this stateful suite against a live install.
test.skip(!!process.env.PULSE_BASE_URL, "Requires the isolated mock API");
const settings = "/settings?tab=organisation&section=Modules";
const notice = "Hidden by your admin";
const endpoint = "/api/v0/settings/screens";
type Choice = { newScreensHidden: boolean; hidden: Record<string, string[]> };
type Probe = Window & { hiddenMounts: string[]; documentToken: string;
  next: { router: { push: (href: string) => void; prefetch: (href: string) => void } } };
const rail = (page: Page) => page.getByRole("navigation", { name: "Main sections" });
// Owner workbench (21 Oct 2026): the rail holds sections; a section's pages are listed in the panel beside it, shown
// for the section the pointer is on.
async function sectionPages(page: Page, section: string) {
  await rail(page).getByRole("link", { name: section, exact: true }).hover();
  return page.getByRole("navigation", { name: `${section} pages`, exact: true });
}
const main = (page: Page) => page.locator("#main-content");
const origins = new WeakMap<Page, string>();
const post = (page: Page, path: string, data: unknown) => page.request.post(path, {
  headers: { Origin: origins.get(page)! }, data,
});
async function choose(page: Page, keys: string[], newScreensHidden = false) {
  const r = await post(page, endpoint, { newScreensHidden, hidden: { admin: keys, person: keys } });
  expect(r.status()).toBe(200);
}
async function palette(page: Page) {
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Search Pulse" })).toBeVisible({ timeout: 1000 });
  }).toPass();
  return page.getByRole("dialog", { name: "Search Pulse" });
}
async function push(page: Page, href: string) {
  await page.evaluate((href) => (window as Probe).next.router.push(href), href);
}
async function held(page: Page) {
  await expect(main(page).getByText(notice, { exact: true })).toBeVisible();
  await expect(main(page).getByRole("heading", { name: "Clients", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as Probe).hiddenMounts)).toEqual([]);
}

test.beforeEach(async ({ page, context, baseURL }, info) => {
  origins.set(page, new URL(baseURL!).origin);
  const tenant = info.title.match(/^([a-z-]+):/)![1];
  await context.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": `admin@screen-${tenant}.example` });
  await context.addInitScript(() => {
    const w = window as Probe;
    w.documentToken = Math.random().toString(36); w.hiddenMounts = [];
    // Record every DOM insertion, including content removed again before an ordinary assertion could see it.
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) {
        const inside = (record.target instanceof Element && !!record.target.closest("#main-content")) || !!node.closest("#main-content");
        const headings = [...node.querySelectorAll(inside ? "h2" : "#main-content h2")];
        if (inside && node.matches("h2")) headings.push(node);
        for (const h of headings) if (h.textContent === "Clients") w.hiddenMounts.push("Clients");
      }
    }).observe(document, { childList: true, subtree: true });
  });
});

async function clientKpi(page: Page) {
  await main(page).getByRole("button", { name: /Active clients/ }).click();
  await page.getByRole("dialog", { name: "Clients", exact: true }).getByRole("link", { name: "Open clients", exact: true }).click();
}

test("entry: cold, Link, router.push, history and prefetch never mount hidden content", async ({ page }) => {
  test.setTimeout(90_000);
  // Positive control: the real page and its heading render with this API before the screen is hidden.
  await page.goto("/clients");
  await expect(main(page).getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Probe).hiddenMounts)).toContain("Clients");
  await choose(page, ["clients"]);
  await page.goto("/clients");
  await expect(page).toHaveURL(/\/hidden$/);
  await held(page);
  await expect(page.getByRole("link", { name: "Open Settings → Modules" })).toBeVisible();

  const prefetched = page.waitForResponse((r) => new URL(r.url()).pathname === "/clients"
    && r.request().headers()["next-router-prefetch"] === "1");
  // The KPI link below is Max's, so this person has chosen Max (Focus is leadership's default dashboard since 20 Oct 2026).
  await page.evaluate(() => { document.cookie = "pulse.home.mode=max; path=/; samesite=lax"; });
  await page.goto("/dashboard");
  await page.waitForFunction(() => !!(window as Probe).next?.router && document.documentElement.hasAttribute("data-theme"));
  const token = await page.evaluate(() => (window as Probe).documentToken);
  // The real Next Link in Max's client detail still observes the hidden-screen boundary.
  await clientKpi(page);
  await held(page);
  await push(page, "/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await push(page, "/clients?via=push");
  await held(page);
  await push(page, "/dashboard?via=history");
  await expect(page).toHaveURL(/\/dashboard\?via=history$/);
  await page.goBack(); await held(page);
  await page.goForward(); await expect(page).toHaveURL(/\/dashboard\?via=history$/);
  await page.goBack(); await held(page);
  await push(page, "/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.evaluate(() => (window as Probe).next.router.prefetch("/clients"));
  await prefetched;
  await clientKpi(page); await held(page);
  expect(await page.evaluate(() => (window as Probe).documentToken)).toBe(token);
});

test("search: records, server hits, picks and both Recents surfaces exclude hidden bases", async ({ page }) => {
  await page.addInitScript(() => {
    const records = [["person:synthetic-colleague", "/people/synthetic-colleague", "Synthetic Colleague", "people"],
      ["client:synthetic-client", "/clients/synthetic-client", "Synthetic Client", "clients"],
      ["cproject:synthetic-project", "/projects/synthetic-project", "Synthetic Project", "client-projects"]];
    localStorage.setItem("pulse.search.picks", JSON.stringify(records.map(([key, href, label, group]) => ({ key, href, label, group, at: Date.now(), n: 1 }))));
    localStorage.setItem("pulse.recents", JSON.stringify([...records.map(([, href, title]) => ({ href, title, kind: "page", at: Date.now() })),
      { href: "/settings", title: "Synthetic Visible Recent", kind: "page", at: Date.now() },
      { href: "/people/synthetic-admin", title: "Synthetic Own Profile", kind: "person", at: Date.now() }]));
  });
  await page.goto("/dashboard");
  let dialog = await palette(page);
  for (const name of ["Synthetic Colleague", "Synthetic Client", "Synthetic Project"]) await expect(dialog.getByRole("option", { name, exact: true })).toBeVisible();
  await dialog.getByRole("combobox").fill("Synthetic");
  for (const name of ["Synthetic Task", "Synthetic SOP", "Synthetic Place", "Synthetic Visible"]) await expect(dialog.getByRole("option", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await choose(page, ["team", "clients", "work", "sops", "map"]);
  await page.reload();
  // The panel beside the rail is open on a 1280 px window; its Recents start folded (owner workbench, 21 Oct 2026).
  await expect(page.getByRole("button", { name: "Collapse sidebar navigation" })).toBeVisible();
  const recents = page.getByRole("region", { name: "Recent pages" });
  await recents.getByRole("button", { name: "Recents" }).click();
  await expect(recents.getByRole("button", { name: "Recents" })).toHaveAttribute("aria-expanded", "true");
  await expect(recents.getByRole("link", { name: /Synthetic Visible Recent/ })).toBeVisible();
  await expect(recents.getByRole("link", { name: /Synthetic Own Profile/ })).toBeVisible();
  await expect(recents.locator('a[href="/people/synthetic-colleague"], a[href^="/clients/"], a[href^="/projects/"]')).toHaveCount(0);
  dialog = await palette(page);
  for (const name of ["Synthetic Colleague", "Synthetic Client", "Synthetic Project"]) await expect(dialog.getByRole("option", { name, exact: true })).toHaveCount(0);
  const response = page.waitForResponse((r) => r.url().includes("/api/v0/search?q=Synthetic"));
  await dialog.getByRole("combobox").fill("Synthetic"); await response;
  await expect(dialog.getByRole("option", { name: "Synthetic Visible", exact: true })).toBeVisible();
  for (const name of ["Synthetic Colleague", "Synthetic Client", "Synthetic Project", "Synthetic Task", "Synthetic SOP", "Synthetic Place"]) await expect(dialog.getByRole("option", { name, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: "All pages" });
  await expect(sheet.getByRole("link", { name: /Synthetic Visible Recent/ })).toBeVisible();
  await expect(sheet.getByRole("link", { name: /Synthetic Own Profile/ })).toBeVisible();
  await expect(sheet.locator('a[href="/people/synthetic-colleague"], a[href^="/clients/"], a[href^="/projects/"]')).toHaveCount(0);
});

test("save: own-role hide/unhide updates rail and palette without reloading", async ({ page }) => {
  await page.goto(settings);
  await page.getByRole("radio", { name: /^Owner \/ admin/ }).click();
  const token = await page.evaluate(() => (window as Probe).documentToken);
  const hidden = page.waitForResponse((r) => r.url().endsWith(endpoint) && r.request().method() === "POST");
  await page.getByRole("switch", { name: "Clients for Owner / admin: shown" }).click();
  expect((await hidden).status()).toBe(200);
  await expect((await sectionPages(page, "Clients")).getByRole("link", { name: "Clients", exact: true })).toHaveCount(0);
  let dialog = await palette(page);
  await dialog.getByRole("combobox").fill("Clients");
  await expect(dialog.getByRole("option", { name: "Clients", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("switch", { name: "Clients for Owner / admin: hidden" })).toBeEnabled();
  const shown = page.waitForResponse((r) => r.url().endsWith(endpoint) && r.request().method() === "POST");
  await page.getByRole("switch", { name: "Clients for Owner / admin: hidden" }).click();
  expect((await shown).status()).toBe(200);
  await expect((await sectionPages(page, "Clients")).getByRole("link", { name: "Clients", exact: true })).toBeVisible();
  dialog = await palette(page);
  await expect(dialog.getByRole("option", { name: "Clients", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Probe).documentToken)).toBe(token);
});

test("recovery: protected screens reject forged saves and own profile/settings stay reachable", async ({ page }) => {
  await page.goto(settings);
  await page.getByRole("radio", { name: /^Owner \/ admin/ }).click();
  for (const [label, key] of [["Dashboard", "dashboard"], ["Chats", "chats"], ["My desk", "me"], ["HR desk", "hr"]]) {
    const control = page.getByRole("switch", { name: `${label} for Owner / admin: shown` });
    await expect(control).toBeChecked(); await expect(control).toBeDisabled();
    await expect(control.locator("xpath=ancestor::li").getByText("Always shown", { exact: true })).toBeVisible();
    expect((await post(page, endpoint, { newScreensHidden: false, hidden: { admin: [key] } })).status()).toBe(400);
  }
  await choose(page, ["team"]);
  await page.goto("/people/synthetic-admin");
  await expect(main(page).getByRole("heading", { name: /^Synthetic Admin/ })).toBeVisible();
  await expect(main(page).getByText(notice, { exact: true })).toHaveCount(0);
  await page.goto(settings);
  await expect(page.getByRole("heading", { name: /^Screens and menu/ })).toBeVisible();
  expect((await page.request.get(endpoint)).status()).toBe(200);
});

test("off: switched-off modules retain their neutral page over a hidden notice", async ({ page }) => {
  await choose(page, ["map"]);
  await page.goto("/map");
  await expect(main(page).getByText("This module is not switched on for your organisation.", { exact: true })).toBeVisible();
  await expect(main(page).getByText(notice, { exact: true })).toHaveCount(0);
});

test("future: saved choices survive reload and new registry keys start hidden", async ({ page }) => {
  await choose(page, ["clients"], true);
  await page.goto(settings); await page.reload();
  const saved = await (await page.request.get(endpoint)).json() as Choice;
  expect(saved.newScreensHidden).toBe(true); expect(saved.hidden.admin).toContain("clients");
  const clients = await sectionPages(page, "Clients");
  await expect(clients.getByRole("link", { name: "Clients", exact: true })).toHaveCount(0);
  await expect(clients.getByRole("link", { name: "Contacts", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "New screens start hidden: on" })).toBeChecked();
  expect((await post(page, "/api/v0/__test/screens/add", {})).status()).toBe(200);
  await page.reload();
  await expect((await sectionPages(page, "Clients")).getByRole("link", { name: "Contacts", exact: true })).toHaveCount(0);
  const me = await (await page.request.get("/api/v0/me")).json();
  expect(me.hiddenScreens.keys).toEqual(expect.arrayContaining(["clients", "contacts"]));
  await page.goto("/contacts"); await expect(page).toHaveURL(/\/hidden$/);
  await expect(main(page).getByText(notice, { exact: true })).toBeVisible();
});

test("denied: non-admin has no enabled screen switches and GET/POST return 403", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "hr@screen-denied.example" });
  await page.goto(settings);
  await expect(main(page).getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  // Non-admin Settings omits the admin-only panel entirely; there is no switch to enable.
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Screens and menu/ })).toHaveCount(0);
  for (const role of ["hr", "staff"]) {
    await context.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": `${role}@screen-denied.example` });
    expect((await page.request.get(endpoint)).status()).toBe(403);
    expect((await post(page, endpoint, { newScreensHidden: false, hidden: { person: ["map"] } })).status()).toBe(403);
  }
});
