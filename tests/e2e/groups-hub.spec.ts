import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// GROUPS-2 (25 Oct 2026): the groups hub (/chats/groups) in a real browser against a live Pulse with the made-up demo
// company "Northstar Realty Media (demo)" (GROUPS-HUB's seed: every person, client, group and message invented). Search
// (names and message text), quick filters and facets in the address, a saved view, a bulk tag, editing a group in its
// panel, the review lanes and the guided review, phone sheets, and a client's Groups tab. Everything a test changes is
// put back. Runs only when pointed at it:
//   PULSE_BASE_URL=http://groups-demo.localhost:3200 PULSE_GROUPS_DEMO=shruti.ranade@northstar-demo.invalid \
//     ea-heavy npx playwright test -c groups-hub.config.ts
const VIEWER = process.env.PULSE_GROUPS_DEMO ?? "";
test.skip(!VIEWER || !process.env.PULSE_BASE_URL, "Needs a live Pulse with the demo company (PULSE_BASE_URL, PULSE_GROUPS_DEMO)");
test.use({ extraHTTPHeaders: { "cf-access-authenticated-user-email": VIEWER } });
test.describe.configure({ mode: "serial" });

type G = { id: string; name: string; kind: string | null; client: string | null; clientId: string | null; projectId: string | null; area: string | null; waitingSince: string | null;
  status: string; imported: number; tags: string[]; manual: string[]; unmapped: number; suggestions: number };
type Hub = { groups: G[]; views: { id: string; name: string }[]; canLead: boolean };
const hubOf = async (r: APIRequestContext) => (await (await r.get("/api/v0/chats/hub")).json()) as Hub;
const stamp = Date.now().toString(36);
// next dev compiles a route the first time it is opened: allow for it.
async function openHub(page: Page, query = "") {
  await page.goto(`/chats/groups${query}`, { timeout: 180_000 });
  await expect(page.locator("[data-hub-list]")).toBeVisible({ timeout: 120_000 });
}
const rows = (page: Page) => page.locator("[data-hub-list] [data-group-row]");

test("search finds groups by client and by words said in them", async ({ page, request }) => {
  test.setTimeout(240_000);
  const hub = await hubOf(request);
  const g = hub.groups.find((x) => x.client && x.status !== "archived")!;
  await openHub(page);
  const all = await rows(page).count();
  const word = g.client!.split(" ").at(-1)!;
  await page.locator("[data-hub-search]").fill(word);
  await expect.poll(async () => rows(page).count(), { timeout: 15_000 }).toBeLessThan(all);
  await expect(rows(page).first()).toBeVisible();
  // Message text: the server counts matches per group ("N matches" on the row).
  await page.locator("[data-hub-search]").fill("walkthrough");
  await expect(page.getByText(/\d+ match(es)?/).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator("[data-hub-search]")).toHaveValue("");
});

test("quick filters and facets live in the address and survive a reload", async ({ page, request }) => {
  test.setTimeout(240_000);
  const hub = await hubOf(request);
  const waiting = hub.groups.filter((x) => x.waitingSince && x.status !== "archived").length;
  await openHub(page);
  await page.locator('[data-quick="waiting"]').click();
  await expect(page).toHaveURL(/quick=waiting/);
  await expect.poll(async () => rows(page).count()).toBe(Math.min(waiting, 80));
  await page.locator('[data-facet="kinds"] label', { hasText: "Client project" }).click();
  await expect(page).toHaveURL(/kinds=client/);
  await expect(page.getByRole("button", { name: /Remove Type: Client project/ })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-quick="waiting"]')).toHaveAttribute("aria-pressed", "true", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: /Remove Type: Client project/ })).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page).not.toHaveURL(/kinds=/);
});

test("a saved view brings its filters back and can be deleted", async ({ page, request }) => {
  test.setTimeout(240_000);
  const name = `E2E view ${stamp}`;
  await openHub(page, "?quick=imported&sort=review");
  await page.getByRole("button", { name: "Save this view" }).click();
  await page.getByPlaceholder("Pod 2 · luxury · active").fill(name);
  await page.getByRole("button", { name: "Save view" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible({ timeout: 15_000 });
  await openHub(page);
  await expect(page.locator('[data-quick="imported"]')).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator('[data-quick="imported"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/sort=review/);
  await page.getByRole("button", { name: `Delete view ${name}` }).click();
  await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0, { timeout: 15_000 });
  expect((await hubOf(request)).views.some((v) => v.name === name)).toBe(false);
});

test("a bulk tag reaches the selected groups and is taken off again", async ({ page, request }) => {
  test.setTimeout(240_000);
  const tag = `e2e-${stamp}`;
  await openHub(page);
  const boxes = page.locator("[data-hub-list] [data-group-row] input[type=checkbox]");
  const ids = [await rows(page).nth(0).getAttribute("data-group-row"), await rows(page).nth(1).getAttribute("data-group-row")] as string[];
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await expect(page.locator("[data-bulk]")).toContainText("2 selected");
  await page.getByRole("button", { name: "Add a tag" }).click();
  await page.getByPlaceholder("renewal, vip, escalated…").fill(tag);
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(page.getByRole("status")).toContainText(`Tagged 2 groups “${tag}”`, { timeout: 15_000 });
  const after = await hubOf(request);
  expect(ids.every((id) => after.groups.find((g) => g.id === id)?.tags.includes(tag))).toBe(true);
  await expect(page.locator('[data-facet="tags"]')).toContainText(tag);
  const r = await request.post("/api/v0/chats/hub/set", { data: { ids, fields: { removeTags: [tag] } } });
  expect(r.ok()).toBe(true);
});

test("a group's panel edits what it is about, and the name reader takes it back", async ({ page, request }) => {
  test.setTimeout(240_000);
  const hub = await hubOf(request);
  const g = hub.groups.find((x) => x.kind === "client" && x.status !== "archived" && !x.manual.includes("area"))!;
  await openHub(page, `?group=${g.id}`);
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText("What it is about")).toBeVisible({ timeout: 60_000 });
  const area = panel.getByPlaceholder("e.g. Baner");
  await area.fill(`E2E area ${stamp}`); await area.press("Enter");
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
  await expect.poll(async () => (await hubOf(request)).groups.find((x) => x.id === g.id)?.area).toBe(`E2E area ${stamp}`);
  // Back to what the name says (the link shows when the name was readable; else the same through the API).
  const again = panel.getByRole("button", { name: "Use the name again" });
  if (await again.isVisible()) await again.click();
  else expect((await request.post("/api/v0/chats/hub/set", { data: { ids: [g.id], fields: { area: null } } })).ok()).toBe(true);
  await expect.poll(async () => (await hubOf(request)).groups.find((x) => x.id === g.id)?.manual.includes("area")).toBe(false);
  expect((await hubOf(request)).groups.find((x) => x.id === g.id)?.area ?? null).toBe(g.area);
});

test("review lanes: one by one in order of value, links, senders, tasks", async ({ page, request }) => {
  test.setTimeout(300_000);
  await openHub(page, "?tab=review");
  const guide = page.locator("[data-guide]");
  await expect(guide).toBeVisible({ timeout: 60_000 });
  const before = (await (await request.get("/api/v0/chats/hub/guide")).json()) as { queue: { id: string; tier: "active" | "client" | "other"; reviewedAt: string | null; later: boolean }[]; progress: { done: number } };
  const first = before.queue.find((q) => !q.reviewedAt)!;
  // Active clients first, then other client groups, then the rest (among those not reviewed nor put off).
  const rank = { active: 0, client: 1, other: 2 };
  const open = before.queue.filter((q) => !q.reviewedAt && !q.later).map((q) => rank[q.tier]);
  expect(open.every((t, i) => i === 0 || open[i - 1] <= t)).toBe(true);
  await expect(guide.locator("h3")).toHaveText(/.+/);
  await expect(guide.locator('[data-step="link"]')).toBeVisible();
  await expect(guide.locator('[data-step="senders"]')).toBeVisible();
  await expect(guide.locator('[data-step="work"]')).toBeVisible();
  await guide.locator("[data-done-next]").click();
  await expect(page.getByRole("status")).toContainText("Done. Next group", { timeout: 20_000 });
  const mid = (await (await request.get("/api/v0/chats/hub/guide")).json()) as { progress: { done: number } };
  expect(mid.progress.done).toBe(before.progress.done + 1);
  expect((await request.post(`/api/v0/chats/hub/groups/${first.id}/review`, { data: { state: "open" } })).ok()).toBe(true);
  // The other lanes.
  const tab = page.getByRole("region", { name: "To review" });
  for (const lane of [/Link to projects/, /Who is this\?/, /Tasks and approvals/]) {
    await page.getByRole("radio", { name: lane }).click();
    await expect(page.getByRole("radio", { name: lane })).toHaveAttribute("aria-checked", "true");
    await expect(tab.locator("li, h2").first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Look through all imported history" })).toBeVisible();
});

test("on a phone: the filter sheet and the group sheet", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { "cf-access-authenticated-user-email": VIEWER } });
  const page = await ctx.newPage();
  await openHub(page);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /Show \d+ groups/ }).click();
  await expect(sheet).toHaveCount(0);
  await rows(page).first().locator("button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 60_000 });
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(1);
  await ctx.close();
});

test("a client's Group chats tab lists its groups with the hub's facts", async ({ page, request }) => {
  test.setTimeout(240_000);
  const hub = await hubOf(request);
  const g = hub.groups.find((x) => x.clientId && x.status !== "archived")!;
  await page.goto(`/clients/${g.clientId}?tab=chats`, { timeout: 180_000 });
  const list = page.locator("[data-linked-groups]");
  await expect(list).toBeVisible({ timeout: 120_000 });
  await expect(list.locator(`[data-group-row="${g.id}"]`)).toBeVisible();
  await expect(list).toContainText(/waiting on us|nobody waiting on us/);
  await list.locator(`[data-group-row="${g.id}"] a`).first().click();
  await expect(page).toHaveURL(new RegExp(`/chats/groups\\?group=${g.id}`), { timeout: 60_000 });
});
