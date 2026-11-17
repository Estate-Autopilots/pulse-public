import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const confirmation = "This member is AI. It is marked AI everywhere, has no sign-in, and acts only through its own key.";
// FIX-PEOPLE-MONEY C1 (10 Nov 2026): Add member is merged into Add people; "AI employee" is one of its choices (admins).
// CHAT-WORK (21 Oct 2026): the AI employee is the same person
// record (name, role, pod, team, reports to) plus its runtime, model, effort, answers, daily limit and tools, with
// working defaults. Reports to (its manager, who reviews its work) is the one choice left to make.
const payload = { name: "Synthetic Assistant", title: "Creative assistant", ownerId: "synthetic-active-owner", provider: "claude", model: "claude-opus-5-5",
  effort: "medium", lane: "thinking", dailyTokenBudget: "160000", tools: ["chats", "tasks", "memory"] };
const as = (role = "admin") => ({ "Cf-Access-Authenticated-User-Email": `${role}@ai-add.example` });

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Synthetic local API only");
  await page.setExtraHTTPHeaders(as());
});
async function open(page: Page) {
  await page.goto("/people");
  return openAdd(page);
}
async function openAdd(page: Page) {
  const form = page.getByRole("dialog", { name: "Add people", exact: true });
  await expect(async () => {
    if (await form.isVisible()) return;
    const add = page.getByRole("button", { name: "Add people", exact: true });
    if (!await add.isVisible()) await page.getByRole("button", { name: /^More actions \(/ }).click({ timeout: 1000 });
    await add.click({ timeout: 1000 });
    await expect(form).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  return form;
}
const aiSwitch = (form: Locator) => form.getByRole("radio", { name: /^AI employee/ });
// The choice's input sits under its drawn card: a press lands on the card's words, as a person's does.
async function turnOnAi(form: Locator) {
  // A phone opens step 1 as one line ("Employee · Change"); Change shows the choices.
  const change = form.getByRole("button", { name: "Change", exact: true });
  if (await change.isVisible()) await change.click();
  await form.getByText("AI employee", { exact: true }).click();
  // Once picked, step 1 folds to one line: the choice and a Change button.
  await expect(form.getByRole("button", { name: "Change", exact: true })).toBeVisible();
  await expect(form.getByText("AI employee", { exact: true })).toBeVisible();
}
async function fillAi(page: Page) {
  const form = await open(page);
  await turnOnAi(form);
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(payload.name);
  await form.getByRole("textbox", { name: "Role", exact: true }).fill(payload.title);
  await form.getByRole("button", { name: /^Reports to:/ }).click();
  await expect(page.getByRole("option", { name: "Synthetic Alumnus" })).toHaveCount(0);
  await page.getByRole("option", { name: "Synthetic Owner", exact: true }).click();
  // What it can do, its team and how it runs start on defaults, folded under More options.
  await form.locator("summary", { hasText: "More options" }).click();
  await expect(form.getByRole("radio", { name: "Claude", exact: true })).toBeChecked();
  await expect(form.getByRole("radio", { name: "Thinking", exact: true })).toBeChecked();
  await form.getByRole("button", { name: "Next: review", exact: true }).click();
  await expect(form.getByText(confirmation, { exact: true })).toBeVisible();
  return form;
}

for (const theme of ["light", "dark"] as const) for (const width of [1440, 374]) {
  test(`confirm creates one AI employee, with a profile link (${theme}, ${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript((theme) => localStorage.setItem("pulse.theme", theme), theme);
    const writes: unknown[] = [];
    await page.route("**/api/v0/agents", async (route) => {
      writes.push(route.request().postDataJSON());
      await route.fulfill({ json: { id: "synthetic-ai-created", employeeId: "NW-AI-001" } });
    });
    const confirm = await fillAi(page);
    await expect(confirm.getByRole("button", { name: "Back", exact: true })).toBeFocused();
    expect(writes).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(confirm.getByRole("button", { name: "Add AI employee", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const screenshot = testInfo.outputPath(`ai-add-confirm-${theme}-${width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach("Synthetic AI confirmation", { path: screenshot, contentType: "image/png" });
    if (process.env.PULSE_SCREENSHOT_DIR) {
      await mkdir(process.env.PULSE_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PULSE_SCREENSHOT_DIR, `ai-add-confirm-${theme}-${width}.png`) });
    }
    await confirm.getByRole("button", { name: "Add AI employee", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(writes).toEqual([payload]);
    // The island waits until the pointer leaves the header before showing a toast.
    await page.mouse.move(width - 1, 899);
    const toast = page.getByRole("button", { name: `Added NW-AI-001. ${payload.name}`, exact: true });
    await expect(toast).toBeVisible();
    const id = toast.locator("b");
    await expect(id).toBeInViewport();
    expect(await id.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const view = page.getByRole("link", { name: "View", exact: true });
    await expect(view).toHaveAttribute("href", "/people/ai/synthetic-ai-created");
    await expect(view).toHaveCSS("align-items", "center");
    await expect(view).toHaveCSS("text-decoration-line", "none");
    if (process.env.PULSE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PULSE_SCREENSHOT_DIR, `ai-add-toast-${theme}-${width}.png`) });
  });
}

test("AI employee is not picked at first, the manager is required, and going back never writes", async ({ page }) => {
  const writes: string[] = [];
  await page.route(/\/api\/v0\/(agents|people)$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes.push(route.request().url()); await route.fulfill({ json: { id: "unexpected-write" } });
  });
  let form = await open(page);
  // Step 1 opens on one line, Employee; nothing is AI until it is picked.
  await expect(form.getByText("Employee", { exact: true })).toBeVisible();
  await expect(aiSwitch(form)).toHaveCount(0);
  await turnOnAi(form);
  await form.getByRole("button", { name: "Next: review", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Name: fill this in");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(payload.name);
  await form.getByRole("textbox", { name: "Role", exact: true }).fill(payload.title);
  await form.getByRole("button", { name: "Next: review", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Reports to: choose one");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  const confirm = await fillAi(page);
  await confirm.getByRole("button", { name: "Back", exact: true }).click();
  form = page.getByRole("dialog", { name: "Add people", exact: true });
  await expect(form.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(payload.name);
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  expect(writes).toEqual([]);
  await openAdd(page);
  await expect(form.getByText("Employee", { exact: true })).toBeVisible();
});

for (const role of ["admin", "hr"]) test(`${role}: "No link" still posts the person to people`, async ({ page }) => {
  await page.setExtraHTTPHeaders(as(role));
  let sent: unknown;
  await page.route("**/api/v0/people", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent = route.request().postDataJSON(); await route.fulfill({ json: {} });
  });
  const form = await open(page);
  await form.getByRole("button", { name: "Change", exact: true }).click();
  if (role === "admin") await expect(aiSwitch(form)).not.toBeChecked();
  else await expect(aiSwitch(form)).toHaveCount(0);
  await form.getByText("Employee", { exact: true }).click();
  await form.getByText("No link", { exact: true }).click();
  await form.getByRole("textbox", { name: "Full name", exact: true }).fill("Synthetic Human");
  await form.getByRole("textbox", { name: "Role", exact: true }).fill("Designer");
  await form.getByRole("button", { name: "Add to the team", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(sent).toEqual({ name: "Synthetic Human", role: "Designer" });
});

test("failed confirmation can retry; repeated clicks send one pending request", async ({ page }) => {
  let attempts = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v0/agents", async (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Please try again" } });
    await pending;
    await route.fulfill({ json: { id: "synthetic-ai-created", employeeId: "NW-AI-002" } });
  });
  const confirm = await fillAi(page);
  await confirm.getByRole("button", { name: "Add AI employee", exact: true }).click();
  await expect(confirm.getByRole("alert")).toHaveText("Please try again");
  await confirm.getByRole("button", { name: "Add AI employee", exact: true }).evaluate((el: HTMLButtonElement) => { el.click(); el.click(); });
  await expect(confirm.getByRole("button", { name: "Adding…", exact: true })).toBeDisabled();
  await expect(confirm.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeVisible();
  await expect.poll(() => attempts).toBe(2);
  release();
  await expect(confirm).toHaveCount(0);
  expect(attempts).toBe(2);
});
