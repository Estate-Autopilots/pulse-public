// CHAT-WORK journeys in a real browser (owner, 22 Oct 2026: TOP-JOURNEYS J2, J3, J4, J6, J7), against a running Pulse
// (pulse-dev by default) as synthetic people only (Access headers, as on pulse-dev). Each journey runs at 1440 px and
// 390 px in light and dark; the 1440 px light run is recorded (one video per journey). The AI employee works through
// the real runtime code with the stub model (no plan quota is used); CHAT_WORK_REAL=1 lets its own runtime answer.
//
//   BASE=http://127.0.0.1:3200 API=http://127.0.0.1:3203 ADMIN=… LEADER=… MEMBER=… OTHER=… \
//   CONNECT="services/coworker/connect.sh <env> <role> EA" VIDEOS=~/ea-research/ux/journeys node services/api/test/chat-work-e2e.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Employee } from "../../coworker/runner.mjs";

const { chromium, expect } = await import("../../../tests/e2e/node_modules/@playwright/test/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:3200", API = process.env.API ?? "http://127.0.0.1:3203";
const [ADMIN, LEADER, MEMBER, OTHER] = [process.env.ADMIN, process.env.LEADER, process.env.MEMBER, process.env.OTHER];
const VIDEOS = process.env.VIDEOS ?? join(tmpdir(), "chat-work-journeys"), SHOTS = join(VIDEOS, "shots");
mkdirSync(SHOTS, { recursive: true });
const ONLY = (process.env.ONLY ?? "J2,J3,J4,J6,J7").split(",");
const SIZES = (process.env.SIZES ?? "1440:light,1440:dark,390:light,390:dark").split(",").map((x) => { const [w, t] = x.split(":"); return { width: Number(w), theme: t }; });
const results = []; let live = [];
const call = async (who, path, body) => {
  const r = await fetch(API + path, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": who, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d };
};
const meOf = async (who) => { const d = (await call(who, "/api/v0/me")).d; return { id: d.person ?? d.personId, username: d.username }; };
const leader = await meOf(LEADER), member = await meOf(MEMBER), other = await meOf(OTHER);
const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
const browser = await chromium.launch();

async function open(who, size, video, name) {
  const mobile = size.width < 600;
  const ctx = await browser.newContext({ viewport: { width: size.width, height: mobile ? 844 : 900 }, colorScheme: size.theme, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1,
    ...(video ? { recordVideo: { dir: join(VIDEOS, `tmp-${name}`), size: { width: mobile ? 390 : 1440, height: mobile ? 844 : 900 } } } : {}) });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); } catch { /* private */ } }, size.theme);
  await ctx.route(`${BASE}/**`, (r) => r.continue({ headers: { ...r.request().headers(), "cf-access-authenticated-user-email": who } }));
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(`${new URL(page.url()).pathname}: ${e.message.slice(0, 300)}`));
  live.push({ page, name }); return { ctx, page, errors };
}
async function close(s, name, video) {
  await s.ctx.close();
  if (video) { const dir = join(VIDEOS, `tmp-${name}`); const f = readdirSync(dir).find((x) => x.endsWith(".webm")); if (f) renameSync(join(dir, f), join(VIDEOS, `${name}.webm`)); }
  assert.deepEqual(s.errors, [], `${name}: no page errors`);
}
const shot = (p, n) => p.screenshot({ path: join(SHOTS, `${n}.png`) });
const chat = (p, id) => p.goto(`${BASE}/chats?channel=${id}`, { waitUntil: "load", timeout: 120000 });
const composer = (p) => p.getByRole("textbox", { name: /^Message / });
const noSideScroll = async (p, n) => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${n}: no sideways scroll`);
async function journey(id, run) {
  if (!ONLY.includes(id)) return;
  for (const size of SIZES) {
    const name = `${id}-${size.width}-${size.theme}`, video = size.width === 1440 && size.theme === "light";
    const t0 = Date.now(); live = [];
    try { await run(size, name, video); results.push(`${name} PASS ${Math.round((Date.now() - t0) / 1000)}s`); console.log(name, "PASS"); }
    catch (e) { for (const x of live) await x.page.screenshot({ path: join(SHOTS, `${x.name}-FAILED.png`) }).catch(() => {});
      results.push(`${name} FAIL ${String(e.message).split("\n")[0].slice(0, 200)}`); console.log(name, "FAIL", e.message.slice(0, 400)); }
  }
}
// One group per run: the leader and two synthetic people.
const group = (await call(LEADER, "/api/v0/chats/groups", { name: `Journeys ${stamp}`, memberIds: [member.id, other.id] })).d.id;
assert.ok(group, "a group for the journeys");

// J2: "@asha draft … by Fri" in a group → offered as a task → sent → she takes it on its card → it is in her tasks.
await journey("J2", async (size, name, video) => {
  const L = await open(LEADER, size, video, name);
  await chat(L.page, group);
  const box = composer(L.page); await expect(box).toBeVisible({ timeout: 60000 });
  const title = `Draft positioning for the launch ${name}`;
  await box.click(); await box.pressSequentially(`@${member.username} ${title.toLowerCase()} by Fri`, { delay: 5 });
  await L.page.keyboard.press("Escape");
  const offer = L.page.locator("[data-task-offer]"); await expect(offer).toBeVisible(); await expect(offer).toContainText("Task for");
  await shot(L.page, `${name}-1-offer`);
  await offer.getByRole("button", { name: "Send as task" }).click();
  const card = L.page.locator("[data-task-card]:not([data-compact])").filter({ hasText: title }).last();
  await expect(card).toBeVisible({ timeout: 20000 }); await expect(card).toContainText("Waiting for");
  await noSideScroll(L.page, name); await shot(L.page, `${name}-2-sent`);
  const M = await open(MEMBER, size, video, `${name}-member`);
  await chat(M.page, group);
  const mine = M.page.locator("[data-task-card]:not([data-compact])").filter({ hasText: title }).last();
  await expect(mine.getByRole("button", { name: "Take it" })).toBeVisible({ timeout: 60000 });
  await shot(M.page, `${name}-3-given`);
  await mine.getByRole("button", { name: "Take it" }).click();
  await expect(mine).toContainText("You took it", { timeout: 15000 });
  await shot(M.page, `${name}-4-taken`);
  await M.page.goto(`${BASE}/tasks`, { waitUntil: "load" });
  await expect(M.page.getByText(title).first()).toBeVisible({ timeout: 60000 });
  await shot(M.page, `${name}-5-her-tasks`);
  await close(M, `${name}-member`, video); await close(L, name, video);
});

// J3: a brochure PDF dropped into the chat → "Make it a task" → given → the file is on the task.
await journey("J3", async (size, name, video) => {
  const L = await open(LEADER, size, video, name);
  await chat(L.page, group); await expect(composer(L.page)).toBeVisible({ timeout: 60000 });
  const pdf = join(tmpdir(), `brochure-${name}.pdf`); writeFileSync(pdf, "%PDF-1.4\n% synthetic brochure for the journeys\n");
  await L.page.locator('input[type="file"]').first().setInputFiles(pdf);
  await expect(L.page.getByText(`brochure-${name}.pdf`).first()).toBeVisible({ timeout: 20000 });
  await L.page.getByRole("button", { name: "Send", exact: true }).click();
  const chip = L.page.locator("article").filter({ hasText: `brochure-${name}.pdf` }).last().locator("[data-file-task]"); await expect(chip).toBeVisible({ timeout: 30000 });
  await shot(L.page, `${name}-1-file`);
  await chip.click();
  const dialog = L.page.getByRole("dialog", { name: "New task" }); await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox").first(); await field.fill(`Print the brochure ${name} @${member.username}`);
  await shot(L.page, `${name}-2-dialog`);
  await dialog.getByRole("button", { name: /^(Assign to|Ask|Create task)/ }).click();
  const card = L.page.locator("[data-task-card]:not([data-compact])").filter({ hasText: `Print the brochure ${name}` }).last();
  await expect(card).toBeVisible({ timeout: 20000 });
  const tid = await card.getAttribute("data-task-card");
  await L.page.goto(`${BASE}/tasks/${tid}`, { waitUntil: "load" });
  await expect(async () => { await L.page.reload({ waitUntil: "load" }); await expect(L.page.getByText(`From the chat: brochure-${name}.pdf`).first()).toBeVisible({ timeout: 20000 }); }).toPass({ timeout: 90000 });
  await noSideScroll(L.page, name); await shot(L.page, `${name}-3-on-the-task`);
  await close(L, name, video);
});

// J4: /tasks in the group → the team's open tasks by person, late first → open one; /projects.
await journey("J4", async (size, name, video) => {
  const L = await open(LEADER, size, video, name);
  await chat(L.page, group); const box = composer(L.page); await expect(box).toBeVisible({ timeout: 60000 });
  await box.click(); await box.fill("/tas"); await expect(L.page.locator('[data-command="tasks"]')).toBeVisible();
  await box.fill("/tasks"); await L.page.keyboard.press("Enter");
  const list = L.page.locator('[data-work-list="tasks"]'); await expect(list).toBeVisible({ timeout: 20000 });
  await expect(list).toContainText("Only you can see this"); await expect(list.locator("li").first()).toBeVisible({ timeout: 30000 });
  await shot(L.page, `${name}-1-tasks`); await noSideScroll(L.page, name);
  await box.fill("/projects"); await L.page.keyboard.press("Enter");
  const pl = L.page.locator('[data-work-list="projects"]'); await expect(pl).toBeVisible({ timeout: 20000 });
  await shot(L.page, `${name}-2-projects`);
  await list.locator("li a").first().click();
  await expect(L.page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/, { timeout: 30000 });
  await shot(L.page, `${name}-3-opened`);
  await close(L, name, video);
});

// J7: Team → Add member → "This is an AI employee" → runtime, manager → its profile → into the group → given a task in
// one chat line → it acknowledges, works, reports and asks for review → approved → the task and what it learned are on
// its profile.
let aiCount = 0;
await journey("J7", async (size, name, video) => {
  const A = await open(ADMIN, size, video, name);
  await A.page.goto(`${BASE}/people`, { waitUntil: "load", timeout: 120000 });
  const addBtn = A.page.getByRole("button", { name: "Add member", exact: true });
  const form = A.page.getByRole("dialog", { name: "Add a team member" });
  await expect(async () => {
    if (await form.isVisible()) return;
    if (!await addBtn.isVisible()) await A.page.getByRole("button", { name: /^More actions/ }).click({ timeout: 1000 });
    await addBtn.click({ timeout: 1000 }); await expect(form).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30000 });
  await form.getByText("This is an AI employee").click(); await expect(form.getByRole("switch", { name: /This is an AI employee/ })).toBeChecked();
  const aiName = `Mira ${stamp} ${++aiCount}`;
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(aiName);
  await form.getByRole("textbox", { name: "Role", exact: true }).fill("Content writer");
  await form.getByRole("button", { name: /^Reports to/ }).click(); await A.page.getByRole("option", { name: "Kedab Mifos", exact: true }).click();
  await form.getByRole("radio", { name: /Claude/ }).check();
  await shot(A.page, `${name}-1-add`);
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await A.page.getByRole("dialog", { name: "Add AI employee" }).getByRole("button", { name: "Add AI employee" }).click();
  await expect(A.page).toHaveURL(/\/people\/ai\//, { timeout: 60000 });
  const ai = decodeURIComponent(A.page.url().split("/people/ai/")[1].split(/[?#]/)[0]);
  await expect(A.page.getByLabel("What it can do here")).toContainText("Not connected yet", { timeout: 30000 });
  await shot(A.page, `${name}-2-profile`); await noSideScroll(A.page, name);
  await close(A, name, video);
  // The operator connects its runtime on the server (one command); the stub model stands in for its plan.
  const username = (await call(ADMIN, "/api/v0/agents")).d.agents.find((x) => x.id === ai)?.username;
  assert.ok(username, "its username");
  const dir = mkdtempSync(join(tmpdir(), "cw-e2e-")), cfg = join(dir, "runtime.json");
  execFileSync("bash", ["-c", `${process.env.CONNECT} ${username} ${cfg}`], { stdio: "inherit", env: { ...process.env, PULSE_URL: API } });
  const employee = new Employee(API, JSON.parse(readFileSync(cfg, "utf8")).agents[0], { stub: process.env.CHAT_WORK_REAL !== "1" });
  // The leader adds it to the group from Group info, then gives it a task in one line.
  const L = await open(LEADER, size, video, `${name}-leader`);
  await chat(L.page, group); await expect(composer(L.page)).toBeVisible({ timeout: 60000 });
  const info = L.page.getByRole("complementary", { name: "Group info" });
  await expect(async () => { if (!await info.isVisible()) await L.page.getByRole("button", { name: "Details", exact: true }).first().click({ timeout: 2000 }); await expect(info).toBeVisible({ timeout: 4000 }); }).toPass({ timeout: 40000 });
  await info.getByRole("button", { name: "Add people" }).click();
  await info.getByRole("textbox", { name: "Search people to add" }).fill(aiName);
  await info.getByText(aiName).first().click();
  await info.getByRole("button", { name: /^Add 1/ }).click();
  await expect(info.getByText(aiName).first()).toBeVisible({ timeout: 20000 });
  await shot(L.page, `${name}-3-in-group`);
  await L.page.getByRole("button", { name: "Close details" }).click().catch(() => {});
  const box = composer(L.page);
  await box.click(); await box.pressSequentially(`@${username} draft three captions for the launch by Fri`, { delay: 5 }); await L.page.keyboard.press("Escape");
  await L.page.locator("[data-task-offer]").getByRole("button", { name: "Send as task" }).click();
  const card = L.page.locator("[data-task-card]:not([data-compact])").filter({ hasText: "Draft three captions for the launch" }).last();
  await expect(card).toContainText(/Queued for|working on it/, { timeout: 30000 });
  await shot(L.page, `${name}-4-given`);
  await employee.tick(); await employee.tick();
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 40000 });
  await expect(L.page.locator("article").filter({ hasText: "ready for your review" }).last()).toBeVisible();
  await shot(L.page, `${name}-5-reported`);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toContainText(/Accepted|Done/, { timeout: 20000 });
  await L.page.goto(`${BASE}/people/ai/${ai}`, { waitUntil: "load" });
  await expect(L.page.getByText("Draft three captions for the launch").first()).toBeVisible({ timeout: 60000 });
  await expect(L.page.getByText("Learned on a task").first()).toBeVisible();
  await expect(L.page.getByLabel("What it can do here")).toContainText("Working", { timeout: 20000 });
  await shot(L.page, `${name}-6-profile-after`); await noSideScroll(L.page, `${name}-profile`);
  await close(L, `${name}-leader`, video);
});

// J6: a step of a live process opens for me → a line in my group says so → I open it from there → done → the next person
// is told in the group. A live run of the company's client-project process, its roles held by the journeys' people; the
// group follows the run from /steps. (Doing the step itself is Flow's step screen; here it is finished through its API.)
const procs = (await call(LEADER, "/v1/flow/processes")).d.processes ?? [];
const proc = procs.find((x) => /Client project/.test(x.name) && x.status === "live") ?? procs.find((x) => x.status === "live");
await journey("J6", async (size, name, video) => {
  assert.ok(proc, "a live process");
  const people = Object.fromEntries(["gs_head", "gs", "cs", "ve", "gd", "ac", "pc", "vg", "sme"].map((k) => [k, k === "gs" ? member.id : k === "cs" ? other.id : leader.id]));
  const run = await call(LEADER, `/v1/flow/processes/${proc.id}/runs`, { name: `Journeys run ${name}`, people, fields: { package: "starter", segment: "mid" } });
  assert.equal(run.s, 200, `run started: ${JSON.stringify(run.d).slice(0, 120)}`);
  try {
    const L = await open(LEADER, size, video, name);
    await chat(L.page, group); const box = composer(L.page); await expect(box).toBeVisible({ timeout: 60000 });
    await box.click(); await box.fill("/steps"); await L.page.keyboard.press("Enter");
    const list = L.page.locator('[data-work-list="steps"]'); await expect(list).toBeVisible({ timeout: 20000 });
    await expect(list).toContainText(`Journeys run ${name}`);
    await list.locator("[data-follow-runs]").click(); await expect(list.locator("[data-follow-runs]")).toContainText("Their updates post here", { timeout: 15000 });
    await shot(L.page, `${name}-1-steps-follow`);
    const mine = (await call(LEADER, "/v1/flow/my-steps")).d.steps.find((x) => x.runId === run.d.id);
    assert.equal((await call(LEADER, `/v1/flow/steps/${mine.id}/finish`, {})).s, 200, "the leader does the first step");
    const M = await open(MEMBER, size, video, `${name}-member`);
    await chat(M.page, group);
    const line = M.page.locator("[id^=m-]").filter({ hasText: `is ready for @${member.username}` }).filter({ hasText: `Journeys run ${name}` }).last();
    await expect(line).toBeVisible({ timeout: 60000 });
    await shot(M.page, `${name}-2-told`);
    await line.locator("[data-step-link]").click();
    await expect(M.page).toHaveURL(/\/runs\/[0-9a-f-]{36}\?step=/, { timeout: 30000 });
    await shot(M.page, `${name}-3-her-step`); await noSideScroll(M.page, name);
    const hers = (await call(MEMBER, "/v1/flow/my-steps")).d.steps.find((x) => x.runId === run.d.id);
    assert.equal((await call(MEMBER, `/v1/flow/steps/${hers.id}/finish`, {})).s, 200, "she does her step");
    await expect(L.page.locator("[id^=m-]").filter({ hasText: `finished “${hers.title.slice(0, 40)}` }).last()).toBeVisible({ timeout: 60000 });
    await shot(L.page, `${name}-4-done-next`);
    await close(M, `${name}-member`, video); await close(L, name, video);
  } finally { await call(LEADER, `/v1/flow/runs/${run.d.id}/cancel`, { note: "Journey test run" }); }
});

await browser.close();
writeFileSync(join(VIDEOS, "results.txt"), results.join("\n") + "\n");
console.log(results.join("\n"));
if (results.some((r) => r.includes(" FAIL ") && !r.includes("not run"))) process.exitCode = 1;
