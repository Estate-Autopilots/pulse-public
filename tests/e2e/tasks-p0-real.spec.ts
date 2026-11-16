import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";

// TASKS-P0, end to end on a real Pulse (API + database) with the synthetic seed (tools/tasks-p0-seed.mjs):
//   PULSE_BASE_URL=http://127.0.0.1:<port> PULSE_TASKS_P0_SEED=~/ea-research/ux/tasks-p0/seed.json npx playwright test tasks-p0-real --workers=1
// Only synthetic people act (sign-ins @synthetic.invalid); what it adds is removed by the seed's --reset.
test.skip(!process.env.PULSE_TASKS_P0_SEED, "Run against a Pulse with the TASKS-P0 seed");
const seed = process.env.PULSE_TASKS_P0_SEED ? JSON.parse(readFileSync(process.env.PULSE_TASKS_P0_SEED, "utf8")) : null;
const who = (key: string) => ({ "Cf-Access-Authenticated-User-Email": seed.people[key].email });
const origin = () => new URL(process.env.PULSE_BASE_URL ?? "http://127.0.0.1:3200").origin;
async function call(request: APIRequestContext, key: string, path: string, body?: unknown) {
  const r = body === undefined ? await request.get(`/api/v0/${path}`, { headers: who(key) })
    : await request.post(`/api/v0/${path}`, { headers: { ...who(key), origin: origin(), "content-type": "application/json" }, data: body });
  expect(r.status(), `${path}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
}

test("a mention made in the comment box reaches the mentioned person's notifications", async ({ page, request }) => {
  const stamp = `end-to-end check ${Date.now()}`;
  await page.setExtraHTTPHeaders(who("asha"));
  await page.goto(`/tasks/${seed.tasks.wifi}`, { waitUntil: "load" });
  const box = page.getByRole("textbox", { name: "Write a comment" });
  await box.click(); await box.pressSequentially("Reminder @Kir");
  await expect(page.getByRole("listbox", { name: "Mention someone" }).getByRole("option", { name: /Kedab Mifos/ })).toContainText("Co-founder");
  await page.keyboard.press("Enter");
  await expect(box.locator(`[data-mention-id="${seed.people.kedab.id}"]`)).toBeVisible();
  await box.pressSequentially(stamp);
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/v0/work/comments") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  expect((await posted).status()).toBe(200);
  await expect(page.locator(`[aria-label="@Kedab Mifos"]`).last()).toBeVisible();
  const notices = await call(request, "kedab", "work/notices?limit=50");
  const mention = notices.rows.find((n: { eventType: string; subject?: { id: string } }) => n.eventType === "task.mention" && n.subject?.id === seed.tasks.wifi);
  expect(mention, "Kedab is told about the mention").toBeTruthy();
  const comments = await call(request, "kedab", `work/comments?task=${seed.tasks.wifi}`);
  expect(comments.rows.some((c: { body: string }) => c.body === `Reminder @Kedab Mifos ${stamp}`)).toBe(true);
});

test("finishing a blocker unlocks the waiting task: its doer hears who finished what and what it is worth", async ({ page, request }) => {
  const stamp = Date.now();
  const blocker = (await call(request, "kedab", "work/tasks", { title: `Unlock check: send the room list ${stamp}`, assigneeId: seed.people.kedab.id })).id;
  const waiting = (await call(request, "kedab", "work/tasks", { title: `Unlock check: book the rooms ${stamp}`, assigneeId: seed.people.asha.id, valuePoints: 5 })).id;
  await call(request, "kedab", `tasks/${waiting}/block`, { blockerId: blocker });
  // Kedab ticks the blocker done on the board (the quiet tick).
  await page.setExtraHTTPHeaders(who("kedab"));
  await page.goto("/tasks?view=board&scope=mine&group=status", { waitUntil: "load" });
  const moved = page.waitForResponse((r) => r.url().endsWith(`/api/v0/tasks/${blocker}/move`));
  // EST-997: the circle asks first; the second click (after a beat, so it is not a double click) finishes it.
  await page.getByRole("button", { name: `Mark “Unlock check: send the room list ${stamp}” done` }).click();
  const confirm = page.getByRole("button", { name: `Confirm: mark “Unlock check: send the room list ${stamp}” done` });
  await expect(confirm).toBeVisible();
  await page.waitForTimeout(350);
  await confirm.click();
  expect((await moved).status()).toBe(200);
  const detail = await call(request, "asha", `tasks/${waiting}`);
  expect(detail.task.unlockedAt).toBeTruthy();
  const notices = await call(request, "asha", "work/notices?limit=50");
  const unlocked = notices.rows.find((n: { title: string; subject?: { id: string } }) => n.subject?.id === waiting);
  expect(unlocked?.title).toBe(`Unlocked: Unlock check: book the rooms ${stamp} · Kedab finished Unlock check: send the room list ${stamp}`.slice(0, 160));
});
