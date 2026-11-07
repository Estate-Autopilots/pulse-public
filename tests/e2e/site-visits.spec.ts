import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Synthetic local API only");
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
});
const base = "/clients/synthetic-customer/visits";
async function capture(page: Page, name: string) {
  const dir = process.env.PULSE_EVIDENCE_DIR; if (!dir) return;
  await mkdir(dir, { recursive: true }); await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}
const field = { key: "roof", label: "Roof", hint: "Access and condition" as string | null, state: "active", required: true, maxPhotos: 3, position: 0 };
const initial = { id: "synthetic-visit", customer_id: "synthetic-customer", type_key: "survey", status: "open", notes: "Initial visit", assigned_person_id: "synthetic-person", created_at: "2026-10-20T08:00:00Z", field_set_version: 2, starting_fields: [field] };
const customer = { name: "Synthetic customer", phone: null, siteAddress: null, systemSizeKw: null, latestQuote: null, salesperson: null };
async function fixture(page: Page) {
  const state = { visits: [] as typeof initial[], visit: structuredClone(initial), fieldNotes: [] as { field_key: string; notes: string }[], history: [] as Record<string, unknown>[],
    settings: { fields: [structuredClone(field)], visitTypes: [{ key: "survey", label: "Site survey", state: "active", position: 0 }, { key: "service", label: "Service", state: "active", position: 1 }] },
    refused: false, failed: false, other: false, role: "admin", person: "synthetic-person" as string | null, writes: 0 };
  const detail = () => ({ visit: state.visit, fieldNotes: state.fieldNotes, history: state.history });
  await page.route(/\/api\/v0\/(customers\/[^/]+\/site-visits|site-visits\/.*|settings\/site-visit|me)$/, async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (state.failed) return route.fulfill({ status: 503, json: { error: "Synthetic service failure" } });
    if (path.endsWith("/me")) return route.fulfill({ json: { person: state.person, role: state.role } });
    if (path.endsWith("settings/site-visit")) return route.fulfill({ json: state.settings });
    if (method !== "GET") {
      state.writes++;
      if (state.refused) return route.fulfill({ status: 403, json: { error: "Visit edit permission required" } });
      const body = route.request().postDataJSON();
      if (method === "POST") { state.visit = { ...initial, id: state.visits.length ? `synthetic-visit-${state.writes}` : initial.id, created_at: `2026-10-${20 + state.visits.length}T08:00:00Z`, type_key: body.typeKey, notes: body.notes }; state.visits.push(state.visit); }
      else if (path.includes("/fields/")) state.fieldNotes = [{ field_key: "roof", notes: body.notes }];
      else state.visit.notes = body.notes;
      state.history.unshift({ id: `event-${state.writes}`, action: path.includes("/fields/") ? "field_notes_changed" : method === "POST" ? "visit_created" : "visit_notes_changed", at: "2026-10-20T09:00:00Z", field_key: null, from_value: "", to_value: body.notes });
      return route.fulfill({ json: detail() });
    }
    return route.fulfill({ json: path.includes("/customers/") ? { customer, visits: state.visits } : { ...detail(), visit: { ...state.visit, customer_id: state.other ? "other-customer" : state.visit.customer_id } } });
  });
  return state;
}
test("create two types, reopen by stable link, save field and visit notes with history", async ({ page }) => {
  const s = await fixture(page);
  await page.goto(base); await expect(page.getByText("No site visits yet")).toBeVisible();
  await page.getByLabel("Visit type").selectOption("service"); await page.getByLabel("Starting notes").fill("Service plan");
  await page.getByRole("button", { name: "Start visit" }).click(); await expect(page).toHaveURL(`${base}/synthetic-visit`);
  await expect(page.getByRole("heading", { name: "Service", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Visit notes", exact: true }).fill("Service confirmed"); await page.getByRole("button", { name: "Save visit notes" }).click();
  await expect(page.getByText("Notes saved.")).toBeVisible();
  await page.getByLabel("Roof notes").fill("Ladder access"); await page.getByRole("button", { name: "Save roof notes" }).click();
  await page.reload(); await expect(page.getByLabel("Roof notes")).toHaveValue("Ladder access"); await expect(page.getByRole("textbox", { name: "Visit notes", exact: true })).toHaveValue("Service confirmed");
  await expect(page.getByText("field notes changed", { exact: true })).toBeVisible();
  await page.goto(base); await page.getByLabel("Visit type").selectOption("survey"); await page.getByRole("button", { name: "Start visit" }).click();
  await expect(page.getByRole("heading", { name: "Site survey", exact: true })).toBeVisible(); expect(s.visits.map(v => v.type_key)).toEqual(["service", "survey"]);
  await page.goto(base); await expect(page.locator('main a[href*="/visits/synthetic-visit"]').first()).toHaveAttribute("href", `${base}/synthetic-visit-4`); await capture(page, "multiple-visits");
});
test("refused create and saves keep the draft and never report success", async ({ page }) => {
  const s = await fixture(page); s.refused = true;
  await page.goto(base); await page.getByLabel("Visit type").selectOption("survey"); await page.getByRole("button", { name: "Start visit" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Nothing was saved"); await expect(page).toHaveURL(base); expect(s.visits).toHaveLength(0);
  await page.goto(`${base}/synthetic-visit`); await page.getByRole("textbox", { name: "Visit notes", exact: true }).fill("Keep this draft");
  await page.getByRole("button", { name: "Save visit notes" }).click(); await expect(page.locator("main").getByRole("alert")).toContainText("Nothing was saved");
  await expect(page.getByRole("textbox", { name: "Visit notes", exact: true })).toHaveValue("Keep this draft"); await expect(page.getByText("Notes saved.")).toHaveCount(0); expect(s.visit.notes).toBe("Initial visit"); await capture(page, "forbidden-draft");
});
test("current labels and archive retain starting fields and saved notes", async ({ page }) => {
  const s = await fixture(page); s.fieldNotes = [{ field_key: "roof", notes: "Preserved capture context" }];
  s.settings.fields[0] = { ...field, label: "Roof access", state: "archived" };
  s.settings.fields.push({ ...field, key: "later", label: "Later field" });
  await page.goto(`${base}/synthetic-visit`);
  const archived = page.locator("section").filter({ has: page.getByRole("heading", { name: "Archived fields", exact: true }) }).first();
  await expect(archived.getByLabel("Roof access notes")).toHaveValue("Preserved capture context"); await expect(archived.getByText("Optional", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Later field notes")).toHaveCount(0); await capture(page, "archived-notes");
});
for (const state of ["archived", "hidden"]) test(`${state} fields without saved notes are omitted`, async ({ page }) => {
  const s = await fixture(page); s.settings.fields[0].state = state;
  const kept = { ...field, key: "kept", label: "Retained field", state };
  s.settings.fields.push(kept); s.visit.starting_fields.push(kept); s.fieldNotes = [{ field_key: "kept", notes: "Retained notes" }];
  await page.goto(`${base}/synthetic-visit`);
  await expect(page.getByRole("textbox", { name: "Retained field notes" })).toHaveValue("Retained notes");
  await expect(page.getByRole("textbox", { name: "Roof notes" })).toHaveCount(0);
  await capture(page, `${state}-with-notes-only`);
});
test("no active visit types teaches the setup step instead of showing a disabled form", async ({ page }) => {
  const s = await fixture(page); s.settings.visitTypes.forEach(t => { t.state = "archived"; });
  await page.goto(base); await expect(page.getByText("No visit types are set up yet")).toBeVisible();
  await expect(page.getByText("Ask an admin to add one.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Visit type" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start visit" })).toHaveCount(0); await capture(page, "no-visit-types");
});
test("an unlinked sign-in explains the disabled start action", async ({ page }) => {
  const s = await fixture(page); s.person = null;
  await page.goto(base); await expect(page.getByRole("button", { name: "Start visit" })).toBeDisabled();
  await expect(page.getByText("Your sign-in is not linked to a staff profile. Ask an admin to link it before starting a visit.")).toBeVisible();
  expect(s.writes).toBe(0); await capture(page, "no-linked-person");
});
test("submitted staff read-only, other-customer denial, transport recovery and offline draft", async ({ page }) => {
  const s = await fixture(page); s.visit.status = "submitted"; s.role = "pgs";
  await page.goto(`${base}/synthetic-visit`); await expect(page.getByRole("textbox", { name: "Visit notes", exact: true })).toBeDisabled(); await capture(page, "submitted-readonly");
  s.other = true; await page.reload(); await expect(page.locator("main").getByRole("alert")).toHaveText("This visit is not available for this customer."); await expect(page.getByRole("textbox", { name: "Visit notes", exact: true })).toHaveCount(0);
  s.other = false; s.failed = true; await page.reload(); await expect(page.locator("main").getByRole("alert")).toContainText("temporarily unavailable"); await capture(page, "service-error");
  const retryBox = await page.getByRole("button", { name: "Try again" }).boundingBox(), errorBox = await page.locator("section").filter({ has: page.getByRole("heading", { name: "Site visits unavailable", exact: true }) }).boundingBox();
  expect(retryBox!.x - errorBox!.x).toBeGreaterThanOrEqual(12);
  s.failed = false; await page.getByRole("button", { name: "Try again" }).click(); await expect(page.getByRole("heading", { name: /^Customer summary/ })).toBeVisible();
  s.role = "admin"; s.visit.status = "open"; await page.reload(); await page.getByRole("textbox", { name: "Visit notes", exact: true }).fill("Offline draft");
  await page.context().setOffline(true); await expect(page.getByText(/You are offline/)).toBeVisible(); await expect(page.getByRole("button", { name: "Save visit notes" })).toBeDisabled();
  await page.context().setOffline(false); await expect(page.getByRole("textbox", { name: "Visit notes", exact: true })).toHaveValue("Offline draft");
});
test("loading skeleton waits for the API", async ({ page }) => {
  await fixture(page); let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v0/customers/synthetic-customer/site-visits", async route => { await pending; await route.fulfill({ json: { customer, visits: [] } }); });
  await page.goto(base); await expect(page.getByRole("status", { name: "Loading site visits" })).toBeVisible(); await capture(page, "loading"); release();
  await expect(page.getByText("No site visits yet")).toBeVisible();
});
for (const theme of ["light", "dark"] as const) for (const width of [1280, 390]) test(`visit states ${theme} ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  const s = await fixture(page); await page.goto(base);
  await expect(page.getByRole("heading", { name: "New visit", exact: true })).toBeVisible();
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
  const dir = process.env.PULSE_EVIDENCE_DIR ?? info.outputPath("evidence"); await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `list-${theme}-${width}.png`), fullPage: true });
  s.visits = [s.visit]; s.visit.starting_fields[0].hint = null;
  await page.goto(`${base}/synthetic-visit`); await expect(page.getByRole("textbox", { name: "Roof notes" })).toBeVisible();
  await expect(page.locator("[data-page-header]")).toContainText("20 Oct, 13:30");
  await expect(page.getByText("Up to 3 photos", { exact: true })).toBeVisible();
  const inputBox = await page.getByRole("textbox", { name: "Roof notes" }).boundingBox(), fieldBox = await page.getByRole("heading", { name: "Roof Required", exact: true }).boundingBox();
  expect(Math.abs(inputBox!.x - fieldBox!.x)).toBeLessThanOrEqual(2);
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
  await expect(page.getByRole("button", { name: "Submit" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(dir, `detail-${theme}-${width}.png`), fullPage: true });
});
