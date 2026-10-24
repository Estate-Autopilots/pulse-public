import { expect, test, type Page } from "@playwright/test";
import { TASKS_NOW } from "./fixtures/tasks-clock.mjs";

// TASKS-P0 (owner, 11 Oct 2026): a person understands their own tasks in five seconds. On the production build with
// the synthetic fixture (tests/e2e/fixtures/tasks-p0.mjs): proof opens inside Pulse and PDF.js draws page 1 of a real
// PDF; an @mention is a chip with an avatar (in the box and in the posted comment) and carries the person's id; a
// person's board groups by when; each role sees its one primary action, and nobody sees "Take it" on work someone does.
const as = (who: string) => ({ "Cf-Access-Authenticated-User-Email": who });
const admin = as("admin@estateautopilots.com"), reviewer = as("hr@estateautopilots.com"), other = as("someone@estateautopilots.com");

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "load" });
  await expect(page.locator("main")).toBeVisible();
}

test("all tasks shows parent and child relationships at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.setExtraHTTPHeaders(admin);
  await open(page, "/tasks?view=all");
  await expect(page.getByRole("link", { name: "Synthetic proofread", exact: true })).toBeVisible();
  await expect(page.getByText("Subtask of", { exact: true })).toBeVisible();
  await expect(page.locator('a[href="/tasks/tp-parent"]').nth(1)).toBeVisible();
  await expect(page.getByText("0/1 subtasks", { exact: true })).toBeVisible();
});

test("a task's circle asks before it marks the task done; Escape takes the question back (EST-997)", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await open(page, "/tasks?view=all");
  const moves: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/v0\/tasks\/[^/]+\/move$/.test(r.url())) moves.push(r.url()); });
  const circle = page.getByRole("button", { name: "Mark “Synthetic proofread” done", exact: true });
  const confirm = page.getByRole("button", { name: "Confirm: mark “Synthetic proofread” done", exact: true });
  await circle.click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute("data-armed", "");
  await page.keyboard.press("Escape");
  await expect(circle).toBeVisible();
  await circle.click();
  await expect(confirm).toBeVisible();
  await page.waitForTimeout(400);
  expect(moves).toHaveLength(0);
  await confirm.click();
  await expect.poll(() => moves.length).toBe(1);
});

test("proof opens in Pulse: PDF.js draws page 1, with the file name, Download and Open in a new tab", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await open(page, "/tasks/tp-task");
  // Owner workbench (21 Oct 2026): the task is the page's own title (the page header's heading; the bar's h1 names Work).
  await expect(page.locator("[data-page-header]").getByRole("heading", { name: "Send HR the office Wi-Fi name and the office public IP", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Pulse roadmap (synthetic).pdf" }).click();
  const viewer = page.getByRole("dialog", { name: "Proof: Pulse roadmap (synthetic).pdf" });
  await expect(viewer).toBeVisible();
  await expect(page).toHaveURL(/[?&]proof=tp-pdf/);
  await expect(viewer.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/v0/tasks/proof/tp-pdf");
  await expect(viewer.getByRole("link", { name: "Open in a new tab" })).toHaveAttribute("target", "_blank");
  await expect(viewer.locator('div[data-page="1"] canvas[data-drawn="1"]')).toBeAttached({ timeout: 20_000 });
  // Page 1 really has ink: some pixels are far from white.
  const ink = await viewer.locator('div[data-page="1"] canvas[data-drawn="1"]').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; let dark = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] < 384) dark++;
    return dark;
  });
  expect(ink).toBeGreaterThan(200);
  await expect(viewer.getByText(/^Page 1 of \d+$/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  // A protected document the viewer may not open says who can, without fetching it.
  await page.getByRole("link", { name: "Offer letter (synthetic draft)" }).click();
  const locked = page.getByRole("dialog", { name: "Proof: Offer letter (synthetic draft)" });
  await expect(locked.getByText("Protected: HR, the founders and the person it concerns can see it")).toBeVisible();
  await expect(locked.getByText("You can’t open this document.")).toBeVisible();
});

test("the raw proof link serves the PDF itself (not JSON), without a sandbox", async ({ request }) => {
  const r = await request.get("/api/v0/tasks/proof/tp-pdf", { headers: admin });
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toBe("application/pdf");
  expect(r.headers()["content-security-policy"]).toBeUndefined();
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
  expect((await r.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
});

test("mentions: the @ list shows avatar, name and role; the choice is a chip; the posted comment keeps it and names the person", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await open(page, "/tasks/tp-task");
  const box = page.getByRole("textbox", { name: "Write a comment" });
  await box.click(); await box.pressSequentially("Please check @Ash");
  const list = page.getByRole("listbox", { name: "Mention someone" });
  await expect(list).toBeVisible();
  const option = list.getByRole("option", { name: /Asha Demo/ });
  await expect(option).toContainText("HR executive (synthetic)");
  await expect(option.locator("span[aria-hidden='true']").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(box.locator('[data-mention-id="tp-asha"]')).toBeVisible();
  await expect(box.locator('[data-mention-id="tp-asha"] img, [data-mention-id="tp-asha"] span').first()).toBeVisible();
  await box.pressSequentially("today please");
  const posted = page.waitForRequest((r) => r.url().endsWith("/api/v0/work/comments") && r.method() === "POST");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const body = (await posted).postDataJSON();
  expect(body.body).toBe("Please check @Asha Demo today please");
  expect(body.mentions).toEqual(["tp-asha"]);
  await expect(page.locator('ol [aria-label="@Asha Demo"]').first()).toBeVisible();
});

test("a person's board groups by when, with counts, rails for empty columns and the person's own header", async ({ page }) => {
  await page.clock.install({ time: TASKS_NOW });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders(admin);
  // Since TASKS-4A the old link opens the person scope (work/list?scope=person) as a board grouped by when.
  await open(page, "/tasks?view=board&scope=person&person=tp-kedab");
  await expect(page.getByRole("heading", { name: "Kedab’s work" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^A person: Kedab Demo/ })).toBeVisible();
  for (const [lane, n] of [["Overdue", 1], ["Today", 2], ["This week", 2], ["No date", 1]] as const) {
    const region = page.getByRole("region", { name: lane, exact: true });
    await expect(region.getByRole("listitem")).toHaveCount(n);
    await expect(region.getByRole("heading")).toContainText(String(n));
  }
  // Later is empty: a thin rail that still takes a drop.
  const later = page.getByRole("region", { name: "Later", exact: true });
  expect((await later.boundingBox())!.width).toBeLessThan(60);
  // Cards: a countdown, a quiet tick instead of a status dropdown box, the waiting badge, a just-unlocked glow.
  const card = page.getByRole("listitem", { name: /^Send HR the office Wi-Fi name/ });
  await expect(card.getByRole("button", { name: /^Mark “Send HR/ })).toBeVisible();
  await expect(card.getByText("2 waiting on Kedab")).toBeVisible();
  await expect(page.getByRole("listitem", { name: /^Decide the check-in rules/ }).getByText("Just unlocked")).toBeVisible();
  // The status columns are one choice away (TASKS-4A: Group by, where the "By status" link was).
  await page.getByRole("button", { name: /^Group by:/ }).click();
  await page.getByRole("option", { name: "Status", exact: true }).click();
  await expect(page.getByRole("region", { name: "To do", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByRole("listitem")).toHaveCount(1);
  // Today's focus sits on My tasks since TASKS-4A; the owner's workbench (21 Oct 2026) calls it Up next.
  await open(page, "/tasks?scope=me");
  await expect(page.getByRole("region", { name: "Up next", exact: true })).toBeVisible();
});

test("one primary action per role; nobody sees Take it on work someone is doing", async ({ browser }) => {
  for (const [headers, want, not] of [
    [admin, ["Start"], ["Accept", "Take it", "Follow"]],
    [reviewer, ["Accept", "Send back"], ["Start", "Take it"]],
    [other, ["Follow", "Ask to join"], ["Take it", "Start", "Accept"]],
  ] as const) {
    const context = await browser.newContext({ extraHTTPHeaders: headers });
    const page = await context.newPage();
    await open(page, "/tasks/tp-task");
    // The task's actions, and since TASKS-4B the reviewer's bar under the banner ("Review Kedab's work").
    const actions = page.getByRole("group", { name: "Status" }).or(page.getByRole("group", { name: /^Review .+’s work$/ }));
    for (const name of want) await expect(actions.getByRole("button", { name, exact: true })).toBeVisible();
    for (const name of not) await expect(actions.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Take it" })).toHaveCount(0);
    await page.getByRole("group", { name: "Status" }).getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await context.close();
  }
});

test("the task page answers what, by when and how at the top", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await open(page, "/tasks/tp-task");
  // In the hero (the value card repeats it under "Why it matters" since TASKS-4B).
  await expect(page.getByText("Unlocks: check-in on arrival, so attendance is accurate and payroll can come from Pulse.").first()).toBeVisible();
  await expect(page.getByText(/^Due today 18:00 · \d+ h left$|^Due today 18:00 · \d+ min left$|^Overdue by \d+ hours?$/).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Steps" }).getByRole("checkbox")).toHaveCount(3);
  // UX-5B: a place in the notes opens that page with "Go there" (the spotlight on it, the task handed to the companion).
  await expect(page.getByRole("link", { name: "Open HR → Policies → Office presence" })).toHaveAttribute("href", /^\/hr\?tab=policies&view=presence&go=hr\.policies\.presence&task=tp-task$/);
  await expect(page.getByRole("link", { name: /Search “what is my ip”/ }).first()).toHaveAttribute("target", "_blank");
  // Owner workbench (21 Oct 2026): what finishing it unlocks is its own section, counted in its heading.
  await expect(page.getByRole("region", { name: "Unlocks", exact: true }).getByRole("heading", { name: /^Unlocks\s*2 tasks for 2 people$/ })).toBeVisible();
  await page.getByRole("button", { name: "Plan it with Pip" }).click();
  await expect(page.getByRole("region", { name: "Pip’s plan" }).getByText("Pip never sends anything.", { exact: false })).toBeVisible();
});
