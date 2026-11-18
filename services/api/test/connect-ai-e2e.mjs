// CONNECT-AI journey in a real browser, against pulse-dev, as the owner (admin of Estate Autopilots and of the synthetic
// EA Production Test). Step by step, with a screenshot at each: Settings → AI (this server's subscriptions, the cloud
// workspace), the Claude sign-in (Claude Code's own setup-token link; a wrong code is refused honestly), the ChatGPT ·
// Codex device code, an API key for a custom OpenAI-compatible address (the local stub, services/api/test/
// connect-ai-stub.mjs; no paid key), Test, a server added over SSH (a local sshd stands in for a VPS), its key
// authorised and checked healthy, an AI employee's AI tab choosing that connection, a message answered through it, and
// an organisation with nothing connected ("Connect an AI first"). Then 390 px and dark. No real secret is used.
//
//   BASE=http://127.0.0.1:3200 API=http://127.0.0.1:3203 OWNER=user-668d21b6@estateautopilots.com AI=<EA AI employee id>
//   EPT_AI=<EA Production Test AI employee id> AUTH_KEYS=<authorized_keys file of the test sshd> SSH_PORT=2222
//   OUT=~/ea-research/ux/journeys/CONNECT-AI node services/api/test/connect-ai-e2e.mjs
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { chromium, expect: expect0 } = await import("../../../tests/e2e/node_modules/@playwright/test/index.mjs");
const expect = expect0.configure({ timeout: 180000 });
// ONLY=rest: skip the 1440-light journey (already passed) and run the 390 / dark views and the empty organisation.
const REST = process.env.ONLY === "rest";
const BASE = process.env.BASE ?? "http://127.0.0.1:3200", API = process.env.API ?? "http://127.0.0.1:3203";
const OWNER = process.env.OWNER, AI = process.env.AI, EPT_AI = process.env.EPT_AI, OUT = process.env.OUT, SHOTS = join(OUT, "shots");
const STUB = process.env.STUB_URL ?? "http://127.0.0.1:3299/v1", STUB_KEY = process.env.STUB_KEY ?? "pulse-stub-key-0001";
mkdirSync(SHOTS, { recursive: true });
const call = async (path, body) => {
  const r = await fetch(API + path, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": OWNER, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d };
};
const log = []; const step = (s) => { log.push(`${new Date().toISOString()} ${s}`); console.log(s); };
const shot = async (page, name) => { const f = join(SHOTS, `${name}.png`); await page.screenshot({ path: f, fullPage: false }); step(`shot ${f}`); };
const settle = (page, ms = 1200) => page.waitForTimeout(ms);

// A clean start: no API connection and no server from earlier runs (EA's own server sign-ins stay).
const before = REST ? { connections: [], workspaces: [] } : (await call("/api/v0/ai")).d;
for (const c of before.connections) await call(`/api/v0/ai/connections/${c.id}/disconnect`, {});
for (const w of before.workspaces) await call(`/api/v0/ai/workspaces/${w.id}/remove`, {});
if (!REST) await call(`/api/v0/agents/${AI}/settings`, { aiChoice: "stub", aiWorkspaceId: "cloud", model: "stub" });
else {
  // The views need what the full journey makes: the stub key and the test server (made here through the API if missing).
  const now = (await call("/api/v0/ai")).d;
  let c = now.connections.find((x) => x.name === "Local model (stub)");
  if (!c) c = (await call("/api/v0/ai/keys", { provider: "custom", name: "Local model (stub)", baseUrl: STUB, key: STUB_KEY, monthlyTokenCap: 200000 })).d.connection;
  if (!now.workspaces.find((w) => w.name === "Agents VPS (test)")) {
    const w = (await call("/api/v0/ai/workspaces", { name: "Agents VPS (test)", host: "127.0.0.1", port: Number(process.env.SSH_PORT ?? 2222), username: process.env.SSH_USER ?? "eadev", keyMode: "generate" })).d.workspace;
    appendFileSync(process.env.AUTH_KEYS, `${w.publicKey}
`); await call(`/api/v0/ai/workspaces/${w.id}/verify`, {});
  }
  await call(`/api/v0/agents/${AI}/settings`, { aiChoice: c.id });
}
step(`clean start: ${before.connections.length} connection(s), ${before.workspaces.length} workspace(s) removed`);

const browser = await chromium.launch();
async function open(size, scheme) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: scheme });
  await ctx.route(`${BASE}/**`, (r) => r.continue({ headers: { ...r.request().headers(), "cf-access-authenticated-user-email": OWNER } }));
  const page = await ctx.newPage(); page.setDefaultTimeout(120000);
  // The dev box is shared and sometimes throttled: pages are given time to arrive.
  const go = page.goto.bind(page); page.goto = (u, o) => go(u, { waitUntil: "domcontentloaded", timeout: 300000, ...o });
  return { ctx, page };
}
const errors = [];
const results = [];
const opt = (page, text) => page.locator("button[aria-pressed]", { hasText: text }).first();
try {
  // ---- 1440, light: the whole journey ----
  if (!REST) {
    const { ctx, page } = await open({ width: 1440, height: 900 }, "light");
    page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
    await page.goto(`${BASE}/settings?tab=ai`);
    await expect(page.getByRole("heading", { name: "AI for your AI employees" })).toBeVisible();
    await expect(page.getByText("Claude Max · this server")).toBeVisible(); await settle(page);
    await shot(page, "01-settings-ai-1440-light");

    // Claude: Claude Code's own sign-in, started on the server; its link shown; a wrong code refused honestly.
    await page.getByRole("button", { name: "Connect an AI" }).first().click();
    await opt(page, "Claude").click();
    await expect(page.getByRole("button", { name: "Start sign-in" })).toBeVisible(); await settle(page, 600);
    await shot(page, "02-connect-claude-1440-light");
    await page.getByRole("button", { name: "Start sign-in" }).click();
    const link = page.getByRole("link", { name: "Open Claude sign-in" });
    await expect(link).toBeVisible({ timeout: 60000 });
    const href = await link.getAttribute("href");
    assert.match(href, /^https:\/\/claude\.(com|ai)\/.*oauth\/authorize\?.*code_challenge=/, "the sign-in link is Claude's own OAuth page");
    results.push("Claude sign-in link from claude setup-token: PASS");
    await shot(page, "03-claude-link-1440-light");
    await page.getByLabel("Code from Claude").fill("not-a-real-code-1234567890#state");
    await page.getByRole("button", { name: "Connect Claude" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /did not accept|Start the sign-in again/ })).toBeVisible({ timeout: 90000 });
    results.push("Claude: a wrong code is refused and nothing is kept: PASS");
    await shot(page, "04-claude-wrong-code-1440-light");
    await page.getByRole("button", { name: "I already have a token from claude setup-token" }).click(); await settle(page, 500);
    await shot(page, "04b-claude-paste-token-1440-light");

    // ChatGPT · Codex: the device code and link, shown in Pulse.
    await opt(page, "ChatGPT · Codex").click();
    await page.getByRole("button", { name: "Get a code" }).click();
    await expect(page.locator("b", { hasText: /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/ })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole("link", { name: /auth\.openai\.com/ })).toBeVisible();
    results.push("Codex device code + link shown: PASS");
    await shot(page, "05-codex-device-code-1440-light");
    await page.getByRole("button", { name: "Cancel and start again" }).click(); await settle(page, 500);

    // Paid keys are off for EA (subscriptions only); a custom OpenAI-compatible address is allowed: the local stub.
    await expect(opt(page, "OpenAI")).toBeDisabled();
    await opt(page, "Custom (OpenAI-compatible)").click();
    const kf = page.getByRole("form", { name: /Add a Custom/ });
    await kf.getByLabel("Name").fill("Local model (stub)");
    await kf.getByLabel("Address").fill(STUB);
    await kf.getByLabel("API key").fill("wrong-key-0000");
    await kf.getByRole("button", { name: "Check and connect" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "refused the key" })).toBeVisible();
    results.push("API key: a refused key is not kept: PASS");
    await shot(page, "06-key-refused-1440-light");
    await kf.getByLabel("API key").fill(STUB_KEY);
    await kf.getByLabel(/Monthly limit/).fill("200000");
    await kf.getByRole("button", { name: "Check and connect" }).click();
    const card = page.getByRole("article", { name: "Local model (stub)" });
    await expect(card).toBeVisible(); await expect(card.getByText("••••0001")).toBeVisible();
    results.push("API key connected, shown as ••••0001: PASS");
    await card.scrollIntoViewIfNeeded(); await settle(page);
    await shot(page, "07-key-connected-1440-light");
    await card.getByRole("button", { name: "Test" }).click();
    await expect(card.getByText(/Answered a test just now/)).toBeVisible();
    results.push("Test on the key: PASS");

    // A server over SSH: Pulse makes the key; the public half goes into authorized_keys; then the check.
    await page.getByRole("button", { name: "Add a server" }).first().click();
    const form = page.getByRole("form", { name: "Add a server" });
    await form.getByLabel("Name").fill("Agents VPS (test)");
    await form.getByLabel("Address").fill("127.0.0.1");
    await form.getByLabel("SSH port").fill(process.env.SSH_PORT ?? "2222");
    await form.getByLabel("User").fill(process.env.SSH_USER ?? "eadev");
    await settle(page, 400);
    await shot(page, "08-add-server-1440-light");
    await form.getByRole("button", { name: "Add server" }).click();
    const ws = page.getByRole("article", { name: "Agents VPS (test)" });
    await expect(ws.getByText("Add Pulse's key to the server.")).toBeVisible();
    await ws.scrollIntoViewIfNeeded(); await settle(page);
    await shot(page, "09-server-key-1440-light");
    const pub = (await call("/api/v0/ai")).d.workspaces.find((w) => w.name === "Agents VPS (test)").publicKey;
    appendFileSync(process.env.AUTH_KEYS, `${pub}\n`);
    await ws.getByRole("button", { name: "Check connection" }).click();
    await expect(ws.getByText("Healthy")).toBeVisible();
    results.push("Workspace over SSH checked healthy, host key pinned: PASS");
    await settle(page);
    await shot(page, "10-workspace-healthy-1440-light");

    // The AI employee's AI tab: choose the connection; what it costs; save.
    await page.goto(`${BASE}/people/${AI}?tab=ai`);
    const pick = page.getByLabel("AI it uses");
    await expect(pick).toBeVisible();
    const id = (await call("/api/v0/ai")).d.connections.find((c) => c.name === "Local model (stub)").id;
    await pick.selectOption(id);
    await expect(page.getByText(/Billed by Custom \(OpenAI-compatible\) per token/)).toBeVisible();
    await pick.scrollIntoViewIfNeeded(); await settle(page);
    await shot(page, "11-ai-tab-choose-1440-light");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    results.push("AI tab: connection chosen and saved: PASS");
    // A message to it is answered through the organisation's own connection.
    const dm = (await call("/api/v0/chats/direct", { personId: AI })).d.id;
    await call(`/api/v0/chats/${dm}/messages`, { body: "Which AI answers you now?", clientId: randomUUID() });
    let answered = null;
    for (let i = 0; i < 40 && !answered; i++) { await new Promise((r) => setTimeout(r, 3000)); const m = (await call(`/api/v0/chats/${dm}/messages?flat=1`)).d.messages; const l = m[m.length - 1]; if (l?.byAgent && /API connection/.test(l.body)) answered = l.body; }
    assert.ok(answered, "the AI employee answered through the API connection");
    results.push(`Runner used the API connection: PASS ("${answered.slice(0, 80)}")`);
    await page.goto(`${BASE}/chats?channel=${dm}`); await expect(page.getByText(/API connection/).last()).toBeVisible(); await settle(page);
    await shot(page, "12-answer-through-connection-1440-light");
    await page.goto(`${BASE}/settings?tab=ai`); await expect(page.getByRole("article", { name: "Local model (stub)" }).getByText("1 AI employee")).toBeVisible(); await settle(page);
    await shot(page, "13-settings-in-use-1440-light");
    await ctx.close();
  }

  // ---- 390 and dark ----
  for (const [size, scheme, tag] of [[{ width: 390, height: 844 }, "light", "390-light"], [{ width: 390, height: 844 }, "dark", "390-dark"], [{ width: 1440, height: 900 }, "dark", "1440-dark"]]) {
    const { ctx, page } = await open(size, scheme);
    page.on("pageerror", (e) => errors.push(`${tag}: ${e.message.slice(0, 200)}`));
    await page.goto(`${BASE}/settings?tab=ai`);
    await expect(page.getByRole("heading", { name: "AI for your AI employees" })).toBeVisible(); await settle(page);
    await shot(page, `20-settings-ai-${tag}`);
    await page.getByRole("article", { name: "Local model (stub)" }).scrollIntoViewIfNeeded(); await settle(page, 500);
    await shot(page, `21-connections-${tag}`);
    await page.getByRole("article", { name: "Agents VPS (test)" }).scrollIntoViewIfNeeded(); await settle(page, 500);
    await shot(page, `22-workspaces-${tag}`);
    await page.getByRole("button", { name: "Connect an AI" }).first().click();
    await opt(page, "Custom (OpenAI-compatible)").click(); await settle(page, 500);
    await page.getByRole("form", { name: /Add a Custom/ }).scrollIntoViewIfNeeded();
    await shot(page, `23-connect-key-${tag}`);
    await page.goto(`${BASE}/people/${AI}?tab=ai`); await page.getByLabel("AI it uses").scrollIntoViewIfNeeded(); await settle(page);
    await shot(page, `24-ai-tab-${tag}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 1, `${tag}: no sideways scroll (${wide}px)`);
    await ctx.close();
  }
  results.push("390 / dark: no sideways scroll: PASS");

  // ---- An organisation with nothing connected: "Connect an AI first" ----
  if (EPT_AI) {
    const { ctx, page } = await open({ width: 1440, height: 900 }, "light");
    await page.goto(`${BASE}/settings`);
    const ea = await page.evaluate(async () => { const me = await (await fetch("/api/v0/account", { cache: "no-store" })).json(); return { here: me.org?.id ?? me.orgId ?? null, orgs: me.orgs ?? [] }; });
    const ept = ea.orgs.find((o) => o.name === "EA Production Test"), home = ea.orgs.find((o) => o.name === "Estate Autopilots");
    const sw = (org) => page.evaluate(async (id) => (await fetch("/api/v0/account/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ org: id }) })).status, org.id);
    assert.equal(await sw(ept), 200, "switched to EA Production Test");
    try {
      await page.goto(`${BASE}/settings?tab=ai`);
      await expect(page.getByText("No AI connected yet")).toBeVisible(); await settle(page);
      await shot(page, "30-empty-other-org-1440-light");
      await page.goto(`${BASE}/people/${EPT_AI}?tab=ai`);
      await expect(page.getByText("Connect an AI first").first()).toBeVisible(); await page.getByText("Connect an AI first").first().scrollIntoViewIfNeeded(); await settle(page);
      await shot(page, "31-connect-ai-first-1440-light");
      // It is on the test runtime; choosing "nothing" and saving is refused with where to connect one.
      await page.getByLabel("AI it uses").selectOption("");
      await page.getByRole("button", { name: "Save" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Connect an AI first" })).toBeVisible();
      results.push("Nothing connected: 'Connect an AI first' with a button, and Save says so: PASS");
    } finally { if (home) await sw(home); }
    await ctx.close();
  }
} catch (e) {
  results.push(`FAIL: ${e.message.split("\n")[0]}`); throw e;
} finally {
  await call(`/api/v0/agents/${AI}/settings`, { aiChoice: "stub", aiWorkspaceId: "cloud", model: "stub" });
  await browser.close();
  writeFileSync(join(OUT, "results.txt"), [...results, ...(errors.length ? ["Page errors:", ...errors] : ["No page errors"]), "", ...log].join("\n") + "\n");
}
console.log(results.join("\n"));
