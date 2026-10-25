import { expect, test, type Page } from "@playwright/test";

const options = { me: "synthetic-avery", today: "2026-10-24", role: "leadership", roleLabel: "Leadership",
  people: [{ id: "synthetic-avery", name: "Avery Example", canAssign: false, photoAt: null },
    { id: "tp-kedab", name: "Kedab Demo", canAssign: false, photoAt: null }],
  projects: [{ id: "synthetic-launch", name: "Launch Example", kind: "internal", clientName: null }],
  clientProjects: [], templates: [], scopes: {}, canCreateProject: false, pods: [], myPods: [], headPods: [] };
const added = (n: number) => ({ id: `synthetic-new-${n}`, asked: null, assigned: false, assigneeName: null, parsed: { title: "Synthetic task" } });
const capture = (page: Page) => page.getByRole("form", { name: "Add a task", exact: true });
const input = (page: Page) => capture(page).getByRole("textbox", { name: "Add a task", exact: true });
async function open(page: Page, layout = "table", extra = "") {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  await page.route("**/api/v0/work/options", (r) => r.fulfill({ json: options }));
  const params = new URLSearchParams({ scope: "me", layout });
  for (const [key, value] of new URLSearchParams(extra)) params.set(key, value);
  await page.goto(`/tasks?${params}`);
  await expect(input(page)).toBeVisible();
}

for (const layout of ["list", "board", "table"]) {
  test(`${layout}: repeated Enter creates each title once, after committed focus reset`, async ({ page }) => {
    const sent: { text: string }[] = [];
    await page.route("**/api/v0/tasks/quick", async (r) => { sent.push(r.request().postDataJSON()); await r.fulfill({ json: added(sent.length) }); });
    await open(page, layout, "&group=status");
    for (const title of ["Synthetic first", "Synthetic second", "Synthetic third"]) {
      await input(page).fill(title); await input(page).press("Enter");
      await expect(input(page)).toHaveValue(""); await expect(input(page)).toBeFocused();
    }
    expect(sent.map((x) => x.text)).toEqual(["Synthetic first", "Synthetic second", "Synthetic third"]);
    await expect(capture(page)).toHaveCount(1);
    await expect(page.getByRole("search", { name: "Add a task", exact: true })).toHaveCount(0);
    if (layout === "list") { await input(page).blur(); await page.keyboard.press("n"); await expect(page.getByRole("dialog")).toHaveCount(1); }
  });
}

test("delayed response keeps a newer draft and cannot submit it as the older request", async ({ page }) => {
  const sent: { text: string }[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v0/tasks/quick", async (r) => { sent.push(r.request().postDataJSON()); if (sent.length === 1) await pending; await r.fulfill({ json: added(sent.length) }); });
  await open(page);
  await input(page).fill("Synthetic old draft"); await input(page).press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  await input(page).fill("Synthetic later draft"); await input(page).press("Enter"); await input(page).press("Enter");
  expect(sent.map((x) => x.text)).toEqual(["Synthetic old draft"]);
  release();
  await expect(capture(page).getByRole("button", { name: "Add", exact: true })).toBeEnabled();
  await expect(input(page)).toHaveValue("Synthetic later draft"); await expect(input(page)).toBeFocused();
  await input(page).press("Enter"); await expect(input(page)).toHaveValue("");
  expect(sent.map((x) => x.text)).toEqual(["Synthetic old draft", "Synthetic later draft"]);
});

test("failure retains selected chips and title; Retry preserves ask semantics and repeat context", async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/v0/tasks/quick", async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill(sent.length === 1 ? { status: 503, json: { error: "Synthetic save unavailable" } } : { json: { ...added(sent.length), asked: { to: "Avery Example" } } });
  });
  await open(page);
  await input(page).fill("Synthetic brief @Ave");
  await capture(page).getByRole("option", { name: /Avery Example/ }).click();
  await input(page).fill("Synthetic brief #Launch");
  await capture(page).getByRole("option", { name: /Launch Example/ }).click();
  await input(page).press("Enter");
  await expect(capture(page).getByRole("alert")).toContainText("Synthetic save unavailable");
  await expect(input(page)).toHaveValue("Synthetic brief ");
  await expect(capture(page).getByText("ask", { exact: true })).toBeVisible();
  await capture(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(input(page)).toHaveValue(""); await expect(input(page)).toBeFocused();
  expect(sent[0]).toEqual(sent[1]);
  expect(sent[1]).toMatchObject({ text: "Synthetic brief ", assigneeId: "synthetic-avery", projectId: "synthetic-launch" });
  await expect(capture(page).getByText("Launch Example", { exact: true })).toBeVisible();
});

test("removing the person-scope chip clears its fallback and subsequent save payloads", async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/v0/tasks/quick", async (r) => { sent.push(r.request().postDataJSON()); await r.fulfill({ json: added(sent.length) }); });
  await open(page, "table", "&scope=person&person=tp-kedab");
  await input(page).fill("Synthetic scoped task");
  const remove = capture(page).getByRole("button", { name: "Not Kedab Demo", exact: true });
  await expect(remove).toBeVisible();
  await input(page).press("Enter"); await expect(input(page)).toHaveValue("");
  expect(sent[0]).toMatchObject({ assigneeId: "tp-kedab" });
  await input(page).fill("Synthetic task after removal"); await remove.click();
  await expect(remove).toHaveCount(0);
  for (const title of ["Synthetic task after removal", "Synthetic repeated task"]) {
    await input(page).fill(title); await input(page).press("Enter");
    await expect(input(page)).toHaveValue(""); await expect(remove).toHaveCount(0);
    expect(sent.at(-1)).not.toHaveProperty("assigneeId");
  }
  expect(sent).toHaveLength(3);
  await expect(page).toHaveURL(/scope=person&.*person=tp-kedab/);
});

for (const project of ["synthetic-empty", "synthetic-error"]) {
  test(`${project}: capture keeps project context through empty or failed list data`, async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.route("**/api/v0/tasks/quick", async (r) => { sent.push(r.request().postDataJSON()); await r.fulfill({ json: added(sent.length) }); });
    await open(page, "table", `&scope=project&project=${project}`);
    await expect(page.getByText(project === "synthetic-empty" ? "No open tasks here" : "Pulse data is temporarily unavailable", { exact: true })).toBeVisible();
    await input(page).fill("Synthetic scoped task"); await input(page).press("Enter");
    await expect(input(page)).toHaveValue("");
    expect(sent[0]).toMatchObject({ text: "Synthetic scoped task", projectId: project });
  });
}

test("switching views and filter-empty states retain the same draft and filters", async ({ page }) => {
  await open(page, "table", "&q=no-synthetic-match&group=status");
  await expect(page.getByText("Nothing matches these filters")).toBeVisible();
  await input(page).fill("Synthetic retained draft");
  for (const label of ["List", "Board", "Table"]) {
    await page.getByRole("toolbar", { name: "View", exact: true }).getByRole("radio", { name: label, exact: true }).click();
    await expect(input(page)).toHaveValue("Synthetic retained draft");
    await expect(page).toHaveURL(/q=no-synthetic-match/);
  }
});

for (const theme of ["light", "dark"]) for (const phone of [false, true]) {
  test(`${theme} ${phone ? "phone" : "desktop"}: capture stays outside horizontal layout scrolling`, async ({ page }, info) => {
    await page.setViewportSize({ width: phone ? 360 : 1440, height: phone ? 780 : 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
    await open(page, "table");
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await input(page).fill("Synthetic phone task");
    await expect(input(page)).toBeInViewport();
    const box = await capture(page).boundingBox(); expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(phone ? 360 : 1440);
    if (phone) expect((await capture(page).getByRole("button", { name: "Add", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(capture(page).locator("xpath=ancestor::*[contains(@class, 'body_')]")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`capture-${theme}-${phone ? "phone" : "desktop"}.png`) });
  });
}
