import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

// HR desk → Policies (HR-UI round, 9 Oct 2026): one row of views, the "Needs your attention" checklist, old addresses,
// the document reader, editing with autosave, the publish confirmation and employees never seeing a draft.
// Synthetic fixtures from mock-editors-api.mjs.
const hr = { "Cf-Access-Authenticated-User-Email": "hr@estateautopilots.com" };
const staff = { "Cf-Access-Authenticated-User-Email": "staff@example.test" };
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
/** Evidence for review: the same view at desktop and phone width, light and dark. */
async function shots(page: Page, name: string) {
  await mkdir("test-results/hr-policies", { recursive: true });
  for (const [size, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate((t) => { localStorage.setItem("pulse.theme", t); document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/hr-policies/${name}-${size}-${theme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("Policies has one row of views and one checklist instead of pill buttons", async ({ page }) => {
  await page.setExtraHTTPHeaders(hr);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/hr?tab=policies");
  // Owner workbench (21 Oct 2026): HR desk's five groups; Policies is a view of Pay & policy.
  const sections = page.getByRole("navigation", { name: "HR desk", exact: true }), group = page.getByRole("navigation", { name: "Pay & policy", exact: true });
  await expect(sections.getByRole("link", { name: "Pay & policy" })).toHaveAttribute("aria-current", "page");
  await expect(group.getByRole("link", { name: "Policies" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("link", { name: "Work calendar" })).toHaveCount(0);
  const views = page.getByRole("navigation", { name: "Views" });
  await expect(views.getByRole("link")).toHaveText(["Documents", "Working rules", "Leave & holidays", "Patterns & shifts", "Office presence", "Approvals & comp-off"]);
  await expect(views.getByRole("link", { name: "Documents" })).toHaveAttribute("aria-current", "true");
  // Setup tasks are lines of one card, each with its count and the exact place to settle it.
  const card = page.locator("details").filter({ hasText: "Needs your attention" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: /Publish the leave policy.*2 items marked \(confirm\)/ })).toHaveAttribute("href", "/hr?tab=policies&view=documents&doc=leave");
  await expect(card.getByRole("link", { name: /Confirm the working rules/ })).toHaveAttribute("href", "/hr?tab=policies&view=rules");
  await expect(card.getByRole("link", { name: /Confirm proposed holidays.*2/ })).toHaveAttribute("href", "/review-data?kind=holiday");
  await expect(card.getByRole("link", { name: /Match imported monthly history.*3/ })).toHaveAttribute("href", "/hr-history");
  await expect(card.getByRole("link", { name: /Name pod heads/ })).toHaveAttribute("href", "/hr?tab=pods");
  await expect(card.getByRole("link", { name: /Add the office location/ })).toHaveAttribute("href", "/hr?tab=policies&view=presence");
  await expect(card.getByRole("link", { name: /opening leave balances/ })).toHaveCount(0);
  for (const pill of ["Person & organisation shifts", "Imported monthly history", "Working rules & leave types", "Policy documents"]) await expect(page.getByRole("link", { name: pill, exact: true })).toHaveCount(0);
  await shots(page, "documents");

  await views.getByRole("link", { name: "Working rules" }).click();
  await expect(page.getByRole("heading", { name: /^Working rules/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm and save" })).toBeVisible();
  await expect(page.getByText(/Half-day leave/)).toBeVisible();
  await shots(page, "rules");
  await views.getByRole("link", { name: "Leave & holidays" }).click();
  await expect(page.getByRole("heading", { name: /^Leave types/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Holidays/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /2 proposed to confirm/ })).toHaveAttribute("href", "/review-data?kind=holiday");
  await shots(page, "leave");
  await views.getByRole("link", { name: "Patterns & shifts" }).click();
  await expect(page.getByRole("heading", { name: "Shifts", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic day shift")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Standing working patterns" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sunday and holiday work" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save working pattern" })).toBeVisible();
  await shots(page, "patterns");
  await views.getByRole("link", { name: "Approvals & comp-off" }).click();
  await expect(page.getByRole("button", { name: "Save approval policy" })).toBeVisible();
  await views.getByRole("link", { name: "Office presence" }).click();
  await expect(page.getByRole("heading", { name: /^Office presence/ })).toBeVisible();
});

test("old Policies and Work calendar addresses land on the new views", async ({ page }) => {
  await page.setExtraHTTPHeaders(hr);
  for (const old of ["/hr?tab=policies&view=types", "/hr?tab=policies&view=holidays"]) {
    await page.goto(old);
    await expect(page).toHaveURL(/\/hr\?tab=policies&view=leave$/);
    await expect(page.getByRole("heading", { name: /^Leave types/ })).toBeVisible();
  }
  await page.goto("/hr?tab=work-calendar");
  await expect(page).toHaveURL(/\/hr\?tab=policies&view=patterns$/);
  await expect(page.getByRole("heading", { name: "Standing working patterns" })).toBeVisible();
  for (const [old, heading] of [["/hr?tab=policies&view=approvals", "Approval and comp-off policy"], ["/hr?tab=policies&view=rules", /^Working rules/], ["/hr?tab=policies&view=documents", "Synthetic Leave Policy"]] as const) {
    await page.goto(old);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
});

test("the reader shows the whole policy with real headings, lists and tables", async ({ page }) => {
  await page.setExtraHTTPHeaders(hr);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/hr?tab=policies&view=documents&doc=leave");
  const reader = page.getByRole("region", { name: "Leave", exact: true });
  await expect(reader.getByText("Draft — not published")).toBeVisible();
  await expect(reader.getByText("Version 1", { exact: true })).toBeVisible();
  await expect(reader.getByText("Acknowledged 0 of 2")).toBeVisible();
  const doc = reader.getByRole("document");
  await expect(doc.getByRole("heading", { name: "Synthetic Leave Policy", level: 3 })).toBeVisible();
  for (const name of ["1. Leave entitlement", "2. Types of leave", "3. Applying for leave"]) await expect(doc.getByRole("heading", { name, level: 4 })).toBeAttached();
  await expect(doc.getByRole("listitem").filter({ hasText: "Half days count as 0.5." })).toBeVisible();
  await expect(doc.getByRole("listitem").filter({ hasText: "Leave above the limit lapses on 31 March." })).toBeVisible();
  const steps = doc.locator("article ol").first();
  await expect(steps.locator(":scope > li")).toHaveCount(2);
  await expect(steps.locator(":scope > li").first().locator("ul > li")).toHaveText(["1–2 days: 3 working days ahead.", "3 or more days: 2 weeks ahead."]);
  const table = doc.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Type", "How it works"]);
  await expect(table.getByRole("row", { name: /Paternity leave 5 working days \(confirm\)/ })).toBeAttached();
  await expect(doc.locator("mark")).toHaveCount(3);
  await expect(page.getByText("| --- |")).toHaveCount(0);
  await expect(page.getByText(/of \d+ paragraphs/)).toHaveCount(0);
  // One scrolling page: the contents follow the reading position and jump to a section.
  const contents = reader.getByRole("navigation", { name: "Contents" });
  await expect(contents.getByRole("link")).toHaveText(["1. Leave entitlement", "2. Types of leave", "3. Applying for leave"]);
  await contents.getByRole("link", { name: "3. Applying for leave" }).click();
  await expect(doc.getByRole("heading", { name: "3. Applying for leave" })).toBeInViewport();
  await expect(contents.getByRole("link", { name: "3. Applying for leave" })).toHaveAttribute("aria-current", "location");
  await expect(reader.getByRole("button", { name: "Print / PDF" })).toBeVisible();
  // The print copy holds the same document without the app around it.
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".pulse-print-root")).toBeVisible();
  await expect(page.locator("main")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  // Phones: the same document in one column, tables as stacked rows, nothing wider than the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(doc.getByRole("heading", { name: "2. Types of leave" })).toBeAttached();
  await expect(reader.getByText(/Contents · 3 sections/)).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});

test("publishing opens a confirmation sheet listing every (confirm) item", async ({ page }) => {
  await page.setExtraHTTPHeaders(hr);
  await page.goto("/hr?tab=policies&view=documents&doc=leave");
  const reader = page.getByRole("region", { name: "Leave", exact: true });
  await reader.getByRole("button", { name: "Publish…" }).click();
  const sheet = page.getByRole("dialog", { name: "Publish version 1?" });
  await expect(sheet.getByText(/all 2 employees on My desk → Policies/)).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "2 items are still marked (confirm)" })).toBeVisible();
  await expect(sheet.getByRole("listitem")).toHaveCount(2);
  await expect(sheet.getByRole("listitem").nth(0)).toContainText("carried up to 12 days (confirm)");
  await expect(sheet.getByRole("listitem").nth(1)).toContainText("Paternity leave — 5 working days (confirm)");
  await shots(page, "publish-sheet");
  const publish = sheet.getByRole("button", { name: "Publish version 1" });
  await expect(publish).toBeDisabled();
  await sheet.getByLabel(/HR and the founders have agreed these 2 items/).check();
  await expect(publish).toBeEnabled();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(reader.getByText("Draft — not published")).toBeVisible();

  // Write a new policy: Markdown with a live preview, saved as a draft while typing, then published after confirming.
  await page.getByRole("navigation", { name: "Policies" }).getByRole("button", { name: /Travel/ }).click();
  await page.getByRole("button", { name: "Write the travel policy" }).click();
  const editor = page.getByRole("dialog", { name: "Edit travel policy" });
  const text = editor.getByRole("textbox", { name: "Policy text (Markdown)" });
  await text.fill("# Synthetic Travel Policy\n\n## 1. Booking\n\n- Book through HR **(confirm)**\n\n| Trip | Approval |\n| --- | --- |\n| Shoot | Pod Head |\n");
  const preview = editor.getByRole("region", { name: "Preview" });
  await expect(preview.getByRole("heading", { name: "1. Booking" })).toBeVisible();
  await expect(preview.getByRole("columnheader", { name: "Approval" })).toBeVisible();
  await expect(editor.getByRole("status")).toHaveText(/Draft saved at/, { timeout: 10_000 });
  await shots(page, "editor");
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(editor).toHaveCount(0);
  const travel = page.getByRole("region", { name: "Travel", exact: true });
  await expect(travel.getByText("Draft — not published")).toBeVisible();
  await expect(travel.getByRole("heading", { name: "Synthetic Travel Policy" })).toBeVisible();
  await travel.getByRole("button", { name: "Publish…" }).click();
  const confirm = page.getByRole("dialog", { name: "Publish version 1?" });
  await expect(confirm.getByRole("listitem")).toHaveCount(1);
  await confirm.getByLabel(/HR and the founders have agreed this item/).check();
  await confirm.getByRole("button", { name: "Publish version 1" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(travel.getByText("Published", { exact: true })).toBeVisible();
  await expect(travel.getByRole("button", { name: "Publish…" })).toHaveCount(0);
});

test("employees only ever see published versions", async ({ page, request }) => {
  await page.setExtraHTTPHeaders(staff);
  await page.goto("/me?tab=policies&doc=leave");
  const list = page.getByRole("navigation", { name: "Policies" });
  await expect(list.getByRole("button", { name: /Leave/ })).toContainText("Not published yet");
  await expect(page.getByText("HR has not published the leave policy yet")).toBeVisible();
  await expect(page.getByText("Synthetic Leave Policy")).toHaveCount(0);
  await expect(page.getByText("Draft — not published")).toHaveCount(0);
  const policies = await (await request.get("/api/v0/hr/policies", { headers: staff })).json();
  expect(policies.rows.every((row: { status: string }) => row.status === "published")).toBe(true);
  expect(policies.rows.some((row: { kind: string }) => row.kind === "leave")).toBe(false);
  expect((await request.post("/api/v0/hr/policies/draft", { headers: staff, data: { kind: "leave", title: "x", body: "Synthetic body", version: 1, revision: 1 } })).status()).toBe(403);
  expect((await request.post("/api/v0/hr/policies/publish", { headers: staff, data: { documentId: "synthetic-policy-leave", revision: 1 } })).status()).toBe(403);
  // The published policy reads in the same reader, with Acknowledge and no Edit or Publish.
  await list.getByRole("button", { name: /Code of conduct/ }).click();
  const reader = page.getByRole("region", { name: "Code of conduct", exact: true });
  await expect(reader.getByRole("heading", { name: "1. Respect" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Publish…" })).toHaveCount(0);
  await reader.getByRole("button", { name: "I have read and acknowledge this policy" }).click();
  await expect(reader.getByText("You acknowledged version 1.")).toBeVisible();
  await shots(page, "employee");
});
