import { expect, test, type Browser, type Page } from "@playwright/test";

// FLOAT-2 (real-device audit, 22 Oct 2026: ~/ea-research/flow/reports/DEVICE-QA.md). What the phones found, held here:
// Android back closes an open layer (Pip's menu, the bell, the account menu, the More sheet) instead of leaving the
// page; the "Turn on notifications?" ask covers nothing; Pip rests clear of controls and numbers; long links wrap;
// phone tap targets are at least 44 px; landscape keeps room for the page; hidden chat-mode sidebar controls take no
// Tab. Runs against the isolated test server or, with PULSE_BASE_URL, a dev preview (writes are answered in the
// browser, so no data changes).
const base = process.env.PULSE_BASE_URL;
const who = { "cf-access-authenticated-user-email": "admin@estateautopilots.com" };

async function setup(browser: Browser, viewport: { width: number; height: number }, opts: { theme?: "light" | "dark" } = {}) {
  const phone = viewport.width < 600 || viewport.height < 500;
  const context = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone, colorScheme: opts.theme ?? "light" });
  await context.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (base && url.origin !== new URL(base).origin) return route.continue();
    if (req.method() !== "GET" && req.method() !== "HEAD" && url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, json: { ok: true } });
    return route.continue({ headers: { ...req.headers(), ...who } });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { context, page, errors, phone };
}
async function ready(page: Page, path: string) {
  await page.goto(path, { waitUntil: "load", timeout: 90_000 });
  await page.waitForFunction(() => { const b = document.querySelector("button[aria-label='Open account menu']"); return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 60_000 });
  await page.waitForTimeout(600);
}
// A back that leaves the page (to the one opened before it) replaces the document under the evaluate: that is a back too.
const back = async (page: Page) => {
  try { await page.evaluate(() => new Promise<void>((done) => { addEventListener("popstate", () => setTimeout(done, 250), { once: true }); history.back(); setTimeout(done, 1500); })); }
  catch (e) { if (!/Execution context was destroyed|navigation/i.test(String(e))) throw e; await page.waitForLoadState("load"); }
};
const path = (page: Page) => new URL(page.url()).pathname;

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`back closes the open layer, not the page (${viewport.width})`, async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page, errors, phone } = await setup(browser, viewport);
    await ready(page, "/tasks");
    await ready(page, "/dashboard");
    const layers: [string, () => Promise<void>, () => Promise<boolean>][] = [
      ["account menu", () => page.getByRole("button", { name: "Open account menu" }).click(), () => page.getByRole("menu", { name: "Account" }).isVisible()],
      ["bell", () => page.locator("button[aria-controls='pulse-notices'], button[aria-label^='Notifications']").first().click(), () => page.locator("#pulse-notices").isVisible()],
      ["Pip's menu", () => page.locator("[data-island] [data-pip]").click(), () => page.locator("[data-island] [role=menu]").isVisible()],
    ];
    if (phone) layers.push(["More sheet", () => page.locator("nav[aria-label='Mobile navigation'] button", { hasText: "More" }).click(), () => page.getByRole("dialog", { name: "All pages" }).isVisible()]);
    for (const [name, openIt, isOpen] of layers) {
      if (!(await page.locator("[data-island] [data-pip]").count()) && name === "Pip's menu") continue;
      await openIt();
      await expect.poll(isOpen, { message: `${name} opens` }).toBe(true);
      await back(page);
      await expect.poll(isOpen, { message: `back closes the ${name}` }).toBe(false);
      expect(path(page), `back with the ${name} open stays on the page`).toBe("/dashboard");
    }
    // A layer closed another way (Esc) leaves no dead back press: the next back goes to the previous page.
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "Account" })).toBeHidden();
    await back(page);
    await expect.poll(() => path(page), { timeout: 15_000 }).toBe("/tasks");
    expect(errors.filter((e) => !/ResizeObserver/.test(e))).toEqual([]);
    await context.close();
  });
}

const rect = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
const inside = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`the notifications question is a chip in the top bar that covers nothing (${viewport.width})`, async ({ browser }) => {
    test.setTimeout(180_000);
    const { context, page, phone } = await setup(browser, viewport);
    await context.addInitScript(() => { try { Object.defineProperty(Notification, "permission", { get: () => "default" }); } catch { /* none */ } });
    await ready(page, "/chats");
    const chip = page.locator("[data-shell-actions] [data-notify-ask] button");
    test.skip(!(await chip.count().then((n) => n > 0 || page.waitForTimeout(3000).then(() => chip.count())).then(Number)), "this server has no browser push key");
    // Inside the top bar, nothing of the page under it.
    const bar = await rect(page, "[data-shell-topbar]");
    const c = await rect(page, "[data-shell-actions] [data-notify-ask] button");
    expect(inside(c, bar)).toBe(true);
    if (phone) { expect(c.width).toBeGreaterThanOrEqual(44); expect(c.height).toBeGreaterThanOrEqual(44); }
    // The old floating card is gone: nothing with the question floats over the page.
    expect(await page.locator("[role=region][aria-label='Notifications']").count()).toBe(0);
    if (!phone) {
      // The chat composer takes a click at its left edge (the old card's button sat there).
      const composer = page.locator("main textarea, main [contenteditable=true]").first();
      if (await composer.count()) {
        const r = await composer.boundingBox();
        if (r) expect(await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return !!el?.closest("main"); }, [r.x + 8, r.y + r.height / 2])).toBe(true);
      }
    }
    await chip.click();
    const card = page.getByRole("dialog", { name: "Notifications" });
    await expect(card).toBeVisible();
    const box = await rect(page, "[role=dialog][aria-label='Notifications']");
    for (const name of ["Allow notifications", "Not now"]) {
      const b = await card.getByRole("button", { name }).boundingBox();
      expect(b && inside({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height }, box), `${name} sits inside the card`).toBe(true);
    }
    expect(box.right).toBeLessThanOrEqual(viewport.width); expect(box.left).toBeGreaterThanOrEqual(0);
    await back(page);
    await expect(card).toBeHidden();
    await chip.click();
    await card.getByRole("button", { name: "Not now" }).click();
    await expect(chip).toHaveCount(0);
    await ready(page, "/chats");
    await page.waitForTimeout(2500);
    await expect(chip, "Not now is remembered").toHaveCount(0);
    await context.close();
  });
}

// Cloudflare's Email Obfuscation, as it rewrote Pulse's HTML (DEVICE-QA #4): every address outside scripts became
// "[email protected]", mailto: links pointed at /cdn-cgi/l/email-protection, and its decoder script was added.
function cfRewrite(html: string) {
  const enc = (e: string) => { const k = 0x5a; return k.toString(16) + [...Buffer.from(e)].map((b) => (b ^ k).toString(16).padStart(2, "0")).join(""); };
  let n = 0;
  const out = html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/).map((part, i) => i % 2 ? part : part.replace(/(<[^>]*>)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (m, tag: string | undefined, email: string | undefined) => {
    if (tag) return tag.replace(/href="mailto:([^"]+)"/g, (_x, e: string) => { n++; return `href="/cdn-cgi/l/email-protection#${enc(e)}"`; });
    n++; return `<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${enc(email!)}">[email&#160;protected]</a>`;
  })).join("").replace("</body>", '<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script></body>');
  return { html: out, n };
}

test("an e-mail address rewritten by Cloudflare never breaks a page (/settings)", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, errors } = await setup(browser, { width: 1440, height: 900 });
  let rewritten = 0;
  await page.route((url) => /\/settings(\?|$)/.test(url.pathname + url.search) || url.pathname === "/settings", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const res = await route.fetch({ headers: { ...route.request().headers(), ...who } });
    const { html, n } = cfRewrite(await res.text()); rewritten = n;
    await route.fulfill({ response: res, body: html, headers: { ...res.headers(), "content-length": String(Buffer.byteLength(html)) } });
  });
  await page.route("**/cdn-cgi/**", (route) => route.fulfill({ status: 404, body: "" }));
  await ready(page, "/settings");
  test.skip(rewritten === 0, "no e-mail address in this server's /settings HTML");
  await page.waitForTimeout(3000);
  expect(errors.filter((e) => /418|hydrat/i.test(e)), "no hydration error").toEqual([]);
  await expect(page.getByText("Something glitched")).toHaveCount(0);
  expect(await page.locator(".__cf_email__").count()).toBe(0);
  expect(await page.evaluate(() => document.body.innerText.includes("[email\u00a0protected]") || document.body.innerText.includes("[email protected]"))).toBe(false);
  await context.close();
});

/** What a press at points around the control's centre (a 44 px square, or the control itself if larger) lands on. */
// Only controls shown whole: a chip scrolled partly out of its sideways-scrolling row is reached by scrolling the row.
const pressable = (page: Page, sel: string) => page.locator(sel).evaluateAll((els) => els.filter((el) => {
  const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth)) return false;
  for (let p = el.parentElement; p; p = p.parentElement) { if (!/auto|scroll/.test(getComputedStyle(p).overflowX)) continue; const c = p.getBoundingClientRect(); return r.left >= c.left - 0.5 && r.right <= c.right + 0.5; }
  return true;
}).map((el) => {
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, h = Math.max(21, r.width / 2 - 1), v = Math.max(21, r.height / 2 - 1);
  const ok = [[cx - h, cy], [cx + h, cy], [cx, cy - v], [cx, cy + v]].every(([x, y]) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t)); });
  return `${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}: ${ok ? "ok" : `${Math.round(r.width)}x${Math.round(r.height)}`}`;
}));

test("phone: the top bar's controls and the page's filters take a 44 px press", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await setup(browser, { width: 390, height: 844 });
  const bad: string[] = [];
  for (const [path, sels] of [["/dashboard", ["[data-shell-actions] [data-checkin-chip] button", "button[aria-label^='Notifications']", "button[aria-label='Open account menu']"]],
    ["/tasks", ["main [role=tablist][aria-label='Which tasks'] button", "main button[aria-label='Select tasks']", "main [role=tab]"]],
    ["/people", ["main [role=radiogroup] button, main [role=radio]"]]] as const) {
    await ready(page, path);
    for (const sel of sels) bad.push(...(await pressable(page, sel)).filter((x) => !x.endsWith("ok")).map((x) => `${path} ${x}`));
  }
  expect(bad).toEqual([]);
  await context.close();
});

test("phone: Pip rests clear of the page's controls (/tasks)", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await setup(browser, { width: 390, height: 844 });
  for (const path of ["/tasks"]) {
    await ready(page, path);
    await page.waitForTimeout(2500);
    const hit = await page.evaluate(() => {
      const pip = document.querySelector("[data-island][data-home='free'] [data-pip]"); if (!pip) return [];
      const r = pip.getBoundingClientRect(), out: string[] = [];
      for (const [fx, fy] of [[.5, .5], [.15, .15], [.85, .15], [.15, .85], [.85, .85]]) {
        const under = document.elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy).find((el) => !el.closest("[data-island]"));
        const c = under?.closest("main :is(button, input, select, textarea, [role=tab], [role=button])");
        if (c) out.push((c.getAttribute("aria-label") || c.textContent || c.tagName).trim().slice(0, 30));
      }
      return out;
    });
    expect(hit, `${path}: no control under Pip`).toEqual([]);
  }
  await context.close();
});

test("a phone on its side keeps room for the page: a short bar and the tabs as a rail", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await setup(browser, { width: 844, height: 390 });
  await ready(page, "/people");
  const bar = await rect(page, "[data-shell-topbar]"), tabs = await rect(page, "nav[aria-label='Mobile navigation']");
  expect(bar.height).toBeLessThanOrEqual(48);
  expect(tabs.width, "the tabs stand at the left edge").toBeLessThanOrEqual(80);
  expect(tabs.height).toBeGreaterThan(200);
  // Nothing of the page's own controls is under the tabs.
  const under = await page.locator("main button, main a[href], main [role=radio]").evaluateAll((els, t) => els.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left < t.right - 1 && r.right > t.left && r.top < t.bottom && r.bottom > t.top; }).length, tabs);
  expect(under).toBe(0);
  await context.close();
});

test("a long link in a notification wraps inside the bell panel", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await setup(browser, { width: 390, height: 844 });
  const long = "Read https://docs.google.com/document/d/1NfAbB9PyzQwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOp/edit?usp=sharing before Friday";
  await context.route("**/api/v0/notices*", (route) => route.fulfill({ json: { rows: [{ id: "n-long", ids: ["n-long"], kind: "task", eventType: "task.assigned", title: long, body: long, href: "/tasks", at: new Date().toISOString(), readAt: null, active: true, state: "open", group: "action", from: null, subject: null, open: { label: "Open", href: "/tasks" }, actions: [], priority: "needs_you" }], counts: { unread: 1, action: 1, mention: 0, update: 0, important: 1 }, dnd: false, today: { due: 0, overdue: 0 } } }));
  await ready(page, "/dashboard");
  await page.locator("button[aria-controls='pulse-notices'], button[aria-label^='Notifications']").first().click();
  const panel = page.locator("#pulse-notices");
  await expect(panel.getByText(/docs\.google\.com/).first()).toBeVisible();
  const wide = await panel.evaluate((p) => { const pr = p.getBoundingClientRect(); return [...p.querySelectorAll("*")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > Math.min(pr.right, innerWidth) + 1); }).length; });
  expect(wide, "nothing runs past the panel or the screen").toBe(0);
  await context.close();
});

test("desktop Chats: Tab never lands on a control hidden under the chat list", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await setup(browser, { width: 1440, height: 900 });
  await ready(page, "/chats");
  const hidden: string[] = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const h = await page.evaluate(() => { const el = document.activeElement as HTMLElement | null; if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect(); if (r.width < 1) return null; const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (t?.closest("nextjs-portal") || t?.tagName.toLowerCase() === "nextjs-portal") return null; // next dev's own badge
      return t && (t === el || el.contains(t) || t.contains(el)) ? null : (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40); });
    if (h) hidden.push(h);
  }
  expect(hidden).toEqual([]);
  await context.close();
});

test("phone: in an open chat Pip keeps off the composer and a real tap on Send sends", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await setup(browser, { width: 390, height: 844 });
  // The isolated test server has no chats: one synthetic group, answered in the browser (as in polish1).
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const channel = { id: "55555555-5555-4555-8555-555555555555", name: "Synthetic Studio", kind: "team", description: "Your team", address: null, unread: 0, members: 3, lastAt: at, preview: "Morning", previewAuthor: "Synthetic Rila" };
  const people = [{ id: "synthetic-admin", name: "Synthetic Admin", username: "admin" }, { id: "synthetic-rila", name: "Synthetic Rila", username: "rila" }];
  await context.route("**/api/v0/chats/events", (route) => route.abort());
  await context.route("**/api/v0/chats", (route) => route.request().method() === "GET" ? route.fulfill({ json: { channels: [channel], viewer: "synthetic-admin", canModerate: false, retentionDays: 365, people } }) : route.fallback());
  await context.route(/\/api\/v0\/chats\/[0-9a-f-]+\/messages/, (route) => {
    const message = (id: string, authorId: string, name: string, body: string, createdAt: string) => ({ id, channelId: channel.id, authorId, name, username: null, body, parentId: null, createdAt, editedAt: null, removed: false, replies: 0, attachments: [], mentions: [], reactions: [], kind: "text" });
    // A send is answered as the API answers it: the saved message.
    if (route.request().method() === "POST") { const posted = route.request().postDataJSON() ?? {}; return route.fulfill({ json: { id: "m-2", message: { ...message("m-2", "synthetic-admin", "Synthetic Admin", String(posted.body ?? ""), new Date().toISOString()), clientId: posted.clientId } } }); }
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { messages: [message("m-1", "synthetic-rila", "Synthetic Rila", "Morning", at)], hasMore: false, members: people, formerMembers: [], receipts: { readThrough: null, deliveredThrough: null }, root: null } });
  });
  const sent: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/v0\/chats\//.test(r.url())) sent.push(r.url()); });
  await ready(page, "/chats");
  await page.locator("[data-chat-row]").first().click({ timeout: 30_000 });
  const box = page.locator("[data-chat-composer] textarea");
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.fill("FLOAT-2 test message (answered in the browser, never saved)");
  await page.waitForTimeout(1800); // Pip's placement settles (re-checked every 0.8 s)
  const send = page.locator("[data-chat-composer] button[aria-label^='Send']").first();
  // A real tap: Playwright refuses when another element (Pip) would take it.
  await send.tap({ timeout: 10_000 });
  await expect.poll(() => sent.length, { message: "Send reached the API" }).toBeGreaterThan(0);
  const pip = page.locator("[data-island] [data-pip]");
  if (await pip.count()) {
    const a = await pip.boundingBox(), c = await page.locator("[data-chat-composer]").boundingBox();
    if (a && c) expect(a.y + a.height <= c.y + 1 || a.y >= c.y + c.height - 1, "Pip is not over the composer").toBe(true);
  }
  await context.close();
});
