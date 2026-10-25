import { expect, test, type Page } from "@playwright/test";

const cell = (page: Page, field: string, title = "Synthetic Alpha") => page.getByRole("button", { name: `${field} for “${title}”: change`, exact: true });
const titleInput = (page: Page) => page.getByRole("textbox", { name: "Task title", exact: true });
const newRow = (page: Page) => page.getByRole("form", { name: "New task", exact: true });
const newInput = (page: Page) => newRow(page).getByRole("textbox", { name: "New task", exact: true });
let project: string;
test.beforeEach(async ({ page }, info) => {
  project = `synthetic-table-entry-${info.testId.replace(/\W/g, "").slice(-16)}-${info.retry}`;
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  await page.route("**/api/v0/work/options", (r) => r.fulfill({ json: { me: "synthetic-admin", today: "2026-10-24",
    people: [{ id: "synthetic-outside", name: "Rowan Example", canAssign: false }], projects: [{ id: "synthetic-destination", name: "Synthetic destination" }], templates: [], clientProjects: [] } }));
});
const open = (page: Page, extra = "") => page.goto(`/tasks?scope=project&project=${project}&layout=table&sort=title${extra}`);
const deferred = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };

test("title Enter-down, F2, type-to-edit, empty validation and Escape", async ({ page }) => {
  const titles: string[] = [];
  await page.route("**/api/v0/tasks/synthetic-table-entry-*", async (r) => { titles.push(r.request().postDataJSON().title); await r.fulfill({ response: await r.fetch() }); });
  await open(page);
  await cell(page, "Title").focus(); await page.keyboard.press("Enter");
  await titleInput(page).fill("Synthetic Alpha edited"); await titleInput(page).press("Enter");
  await expect(cell(page, "Title", "Synthetic Beta")).toBeFocused();
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("F2");
  await titleInput(page).fill("   "); await titleInput(page).press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Add a title" })).toBeVisible(); await expect(titleInput(page)).toHaveValue("   ");
  await titleInput(page).press("Escape"); await expect(cell(page, "Title", "Synthetic Alpha edited")).toBeFocused();
  for (const key of ["x", "n", "q", "c"]) {
    await page.keyboard.press(key); await expect(titleInput(page)).toHaveValue(key); await expect(titleInput(page)).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await titleInput(page).press("Escape"); await expect(cell(page, "Title", "Synthetic Alpha edited")).toBeFocused();
  }
  expect(titles).toEqual(["Synthetic Alpha edited"]);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur()); await page.keyboard.press("n");
  await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "Open task: Synthetic Alpha edited", exact: true })).toHaveAttribute("href", /synthetic-table-entry-/);
  await page.reload(); await expect(cell(page, "Title", "Synthetic Alpha edited")).toBeVisible();
});

test("Tab across cells, Enter choices, cancel focus, persistence and shared layouts", async ({ page }) => {
  await open(page);
  await cell(page, "Title").focus();
  await page.keyboard.press("Tab"); await expect(page.getByRole("link", { name: "Open task: Synthetic Alpha", exact: true })).toBeFocused();
  for (const field of ["Status", "Who", "Due", "Priority", "Project"]) { await page.keyboard.press("Tab"); await expect(cell(page, field)).toBeFocused(); }
  await page.keyboard.press("Shift+Tab"); await expect(cell(page, "Priority")).toBeFocused();
  await page.keyboard.press("Enter"); await page.getByRole("listbox", { name: "Change priority" }).press("Escape");
  await expect(cell(page, "Priority")).toBeFocused();
  await cell(page, "Status").press("Enter"); await page.getByRole("listbox", { name: "Change status" }).press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(cell(page, "Status")).toBeFocused(); await expect(cell(page, "Status")).toContainText("Doing");
  await cell(page, "Priority").press("Enter"); await page.getByRole("listbox", { name: "Change priority" }).press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(cell(page, "Priority")).toBeFocused();
  await cell(page, "Project").press("Enter"); await page.getByRole("combobox", { name: "Search projects" }).fill("destination");
  await expect(page.getByRole("option", { name: "Synthetic destination", exact: true })).toBeVisible(); await page.keyboard.press("Enter");
  await expect(cell(page, "Project")).toContainText("Synthetic destination"); await expect(cell(page, "Project")).toBeFocused();
  await cell(page, "Due").press("Enter"); await expect(page.getByRole("button", { name: /^Today/ })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: /^Tomorrow/ })).toBeFocused(); await page.keyboard.press("Enter");
  await expect(cell(page, "Due")).toBeFocused(); await expect(cell(page, "Due")).not.toContainText("No date");
  await cell(page, "Due").press("Enter");
  for (const name of [/^Tomorrow/, /^This Friday/, /^Next Monday/, /^In a week/, /^In 2 weeks/, /^End of month/, /^No date$/, /^Previous month$/, /^Next month$/]) {
    await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name })).toBeFocused();
  }
  await page.keyboard.press("Tab"); await expect(page.getByRole("grid").getByRole("button", { pressed: true })).toBeFocused();
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter"); await expect(cell(page, "Due")).toBeFocused();
  const due = await cell(page, "Due").textContent(), priority = await cell(page, "Priority").textContent();
  for (const view of ["List", "Board", "Table"]) {
    await page.getByRole("toolbar", { name: "View", exact: true }).getByRole("radio", { name: view, exact: true }).click();
    await expect(page.getByText("Synthetic Alpha", { exact: true }).first()).toBeVisible();
  }
  await page.reload(); await expect(cell(page, "Status")).toContainText("Doing"); await expect(cell(page, "Project")).toContainText("Synthetic destination");
  await expect(cell(page, "Due")).toHaveText(due!); await expect(cell(page, "Priority")).toHaveText(priority!);
  await page.route("**/api/v0/work/tasks/*/assign", (r) => r.fulfill({ json: { asked: { to: "Rowan Example" } } }));
  const before = await cell(page, "Who").textContent(); await cell(page, "Who").press("Enter");
  await page.getByRole("combobox", { name: "Search people" }).fill("Rowan");
  await expect(page.getByRole("option", { name: /Rowan Example/ })).toBeVisible(); await page.keyboard.press("Enter");
  await expect(cell(page, "Who")).toBeFocused(); await expect(cell(page, "Who")).toHaveText(before!);
  await expect(page.getByText("It stays as it is until they accept.", { exact: true })).toBeVisible();
});

test("row two opens and finishes through keyboard stops; finished title keeps its styling", async ({ page }) => {
  await open(page, "&status=all"); await cell(page, "Title").focus(); await page.keyboard.press("ArrowDown");
  await expect(cell(page, "Title", "Synthetic Beta")).toBeFocused(); await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Open task: Synthetic Beta", exact: true })).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/tasks/${project}-1$`)); await open(page, "&status=all");
  await cell(page, "Title").focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Mark “Synthetic Beta” done", exact: true })).toBeFocused();
  const started = Date.now(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Confirm: mark “Synthetic Beta” done", exact: true })).toBeFocused();
  await expect.poll(() => Date.now() - started).toBeGreaterThan(300); await page.keyboard.press("Enter");
  await expect(cell(page, "Status", "Synthetic Beta")).toHaveText("Done");
  await expect(cell(page, "Title", "Synthetic Beta")).toHaveCSS("text-decoration-line", "line-through");
  await page.reload(); await expect(cell(page, "Title", "Synthetic Beta")).toHaveCSS("text-decoration-line", "line-through");
});

test("Space keeps the title, click-away saves, and failed blur keeps the draft for Retry", async ({ page }) => {
  const titles: string[] = [];
  await page.route("**/api/v0/tasks/synthetic-table-entry-*", async (r) => {
    titles.push(r.request().postDataJSON().title);
    if (titles.length === 2) return r.fulfill({ status: 503, json: { error: "Synthetic blur unavailable" } });
    await r.fulfill({ response: await r.fetch() });
  });
  await open(page); await cell(page, "Title").focus(); await page.keyboard.press("Space");
  await expect(titleInput(page)).toHaveValue("Synthetic Alpha"); await cell(page, "Status").click(); expect(titles).toHaveLength(0);
  await page.keyboard.press("Escape"); await cell(page, "Title").click(); await titleInput(page).fill("Synthetic Alpha blurred");
  await cell(page, "Status").click(); await expect(cell(page, "Title", "Synthetic Alpha blurred")).toBeVisible();
  await cell(page, "Title", "Synthetic Alpha blurred").click(); await titleInput(page).fill("Synthetic Alpha retry blur");
  await page.getByRole("heading", { name: "Synthetic entry project", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Synthetic blur unavailable" })).toBeVisible();
  await expect(titleInput(page)).toHaveValue("Synthetic Alpha retry blur");
  await cell(page, "Priority", "Synthetic Alpha blurred").click();
  await expect(titleInput(page)).toHaveValue("Synthetic Alpha retry blur");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(cell(page, "Title", "Synthetic Alpha retry blur")).toBeVisible();
  expect(titles).toEqual(["Synthetic Alpha blurred", "Synthetic Alpha retry blur", "Synthetic Alpha retry blur"]);
});

test("failed title and selection keep drafts for Retry; slow save cannot erase later typing", async ({ page }) => {
  const pending = deferred(); let attempts = 0;
  await page.route("**/api/v0/tasks/synthetic-table-entry-*", async (r) => {
    attempts++; if (attempts === 1 || attempts === 4) return r.fulfill({ status: 503, json: { error: "Synthetic offline" } });
    if (attempts === 3) await pending.promise;
    await r.fulfill({ response: await r.fetch() });
  });
  await open(page); await cell(page, "Title").click(); await titleInput(page).fill("Synthetic Alpha retry"); await titleInput(page).press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Synthetic offline" })).toBeVisible(); await expect(titleInput(page)).toHaveValue("Synthetic Alpha retry");
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await expect(cell(page, "Title", "Synthetic Beta")).toBeFocused();
  await cell(page, "Title", "Synthetic Alpha retry").click(); await titleInput(page).fill("Synthetic older"); await titleInput(page).press("Enter");
  await expect.poll(() => attempts).toBe(3); await titleInput(page).fill("Synthetic later"); await titleInput(page).press("Enter");
  expect(attempts).toBe(3); pending.release(); await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0);
  await expect(titleInput(page)).toHaveValue("Synthetic later"); await titleInput(page).press("Escape");
  await cell(page, "Priority", "Synthetic older").click(); await page.getByRole("option", { name: "Low", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Synthetic offline" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Low", exact: true })).toHaveAttribute("data-chosen", "");
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await expect(cell(page, "Priority", "Synthetic older")).toContainText("Low");
});

test("bottom row repeats Enter, creates once during slow response and retains failed text", async ({ page }) => {
  const pending = deferred(), sent: { text: string; projectId: string }[] = [];
  await page.route("**/api/v0/tasks/quick", async (r) => {
    sent.push(r.request().postDataJSON()); if (sent.length === 1) await pending.promise;
    if (sent.length === 3) return r.fulfill({ status: 503, json: { error: "Synthetic save unavailable" } });
    await r.fulfill({ response: await r.fetch() });
  });
  await open(page); await newInput(page).fill("Synthetic first"); await newInput(page).press("Enter");
  await expect.poll(() => sent.length).toBe(1); await newInput(page).press("Enter"); await newInput(page).fill("Synthetic second"); await newInput(page).press("Enter");
  expect(sent).toHaveLength(1); pending.release();
  await expect(newRow(page).getByRole("button", { name: "Add", exact: true })).toBeEnabled(); await expect(newInput(page)).toHaveValue("Synthetic second");
  await newInput(page).press("Enter"); await expect(newInput(page)).toHaveValue(""); await expect(newInput(page)).toBeFocused();
  await newInput(page).fill("Synthetic third"); await newInput(page).press("Enter");
  await expect(newRow(page).getByRole("alert")).toContainText("Synthetic save unavailable"); await expect(newInput(page)).toHaveValue("Synthetic third");
  await newRow(page).getByRole("button", { name: "Retry", exact: true }).click(); await expect(newInput(page)).toHaveValue(""); await expect(newInput(page)).toBeFocused();
  expect(sent.map((s) => s.text)).toEqual(["Synthetic first", "Synthetic second", "Synthetic third", "Synthetic third"]);
  expect(sent.every((s) => s.projectId === project)).toBe(true); await expect(cell(page, "Title", "Synthetic third")).toBeVisible();
});

for (const theme of ["light", "dark"]) for (const phone of [false, true]) {
  test(`${theme} ${phone ? "phone" : "desktop"}: bottom row, empty filters and capture remain reachable`, async ({ page }, info) => {
    await page.setViewportSize({ width: phone ? 360 : 1440, height: phone ? 780 : 1000 }); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme); await open(page);
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await newInput(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`table-entry-${theme}-${phone ? "phone" : "desktop"}.png`) });
    await open(page, "&q=hidden-synthetic");
    const table = page.locator('[data-layout="table"]').filter({ visible: true });
    await expect(table).toHaveCount(1);
    await expect(table.getByText("Nothing matches these filters", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(table.getByRole("button", { name: "Clear the filters", exact: true })).toBeVisible();
    await newInput(page).fill("Synthetic hidden entry"); await newInput(page).press("Enter"); await expect(newInput(page)).toHaveValue("");
    await expect(page.getByRole("status").filter({ hasText: "scope or filters hide it" })).toBeVisible();
    await newInput(page).scrollIntoViewIfNeeded(); const box = (await newInput(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(phone ? 360 : 1440);
    if (phone) expect(box.height).toBeGreaterThanOrEqual(44);
    const capture = page.getByRole("form", { name: "Add a task", exact: true });
    await expect(capture.locator("xpath=ancestor::*[contains(@class, 'tableWrap_')]")).toHaveCount(0);
  });
}
