import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

// CHAT-V3 (24 Oct 2026): the chat the team lives in. List sections, mute and archive; a conversation with someone typing,
// "Seen by", a pinned message, an approval, a thread, forwarding, copy link, the picture viewer with a comment on a point,
// search filters, the offline outbox, and swipe to reply on a phone. Synthetic persona and data only (browser adapters).
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "Isolated synthetic browser adapters only");
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ME = "synthetic-admin", RILA = "synthetic-rila", NEHA = "synthetic-neha", MIRA = "synthetic-mira";
const G = "51111111-1111-4111-8111-111111111111", DM = "52222222-2222-4222-8222-222222222222", OLD = "53333333-3333-4333-8333-333333333333";
const AI = "54444444-4444-4444-8444-444444444444", POD = "55555555-5555-4555-8555-555555555555";
const FILE = "56666666-6666-4666-8666-666666666666";
const people = [{ id: ME, name: "Synthetic Admin", username: "admin" }, { id: RILA, name: "Rila Synthetic", username: "rila" }, { id: NEHA, name: "Neha Synthetic", username: "neha" }, { id: MIRA, name: "Mira Synthetic", username: "mira", agent: true }];
const list = () => ({
  channels: [
    { id: G, name: "Skyline creative (test)", kind: "custom", description: "", address: null, unread: 0, members: 3, lastAt: at(2), preview: "Payment done", previewAuthor: "Neha Synthetic", clientFacing: true },
    { id: DM, name: "Rila Synthetic", kind: "direct", description: "", address: null, unread: 2, members: 2, lastAt: at(9), peerId: RILA, preview: "See you at 10", mutedUntil: "infinity" },
    { id: OLD, name: "Old launch (test)", kind: "custom", description: "", address: null, unread: 0, members: 3, lastAt: at(4000), preview: "Done", archivedAt: at(3000) },
    { id: AI, name: "Mira Synthetic", kind: "direct", description: "", address: null, unread: 0, members: 2, lastAt: at(60), peerId: MIRA, peerAgent: true, preview: "Draft ready" },
    { id: POD, name: "Synthetic pod", kind: "pod", description: "", address: null, unread: 0, members: 6, lastAt: at(30), preview: "Standup at 10" },
  ],
  viewer: ME, canModerate: false, retentionDays: 365, people,
});
const msg = (id: string, author: string, body: string, minutes: number, extra: Record<string, unknown> = {}) => ({
  id, channelId: G, authorId: author, name: people.find((p) => p.id === author)!.name, username: null, body, parentId: null, quoteId: null, quote: null, kind: "text",
  createdAt: at(minutes), editedAt: null, removed: false, replies: 0, attachments: [], mentions: [], reactions: [], ...extra });
const M1 = "57777777-7777-4777-8777-777777777771", M2 = "57777777-7777-4777-8777-777777777772", M3 = "57777777-7777-4777-8777-777777777773";
const thread = () => {
  const m1 = msg(M1, RILA, "Here is the brochure, version 1", 30, { attachments: [{ id: FILE, name: "brochure.png", mime: "image/png" }], replies: 2, lastReplyAt: at(10),
    approval: { state: "waiting", askedBy: RILA, askedByName: "Rila Synthetic", decidedByName: null, decidedAt: null, note: null, rounds: 0 } });
  const m2 = msg(M2, ME, "Looks good, one change on the cover", 20);
  const m3 = msg(M3, NEHA, "Payment done, screenshot in Drive", 2, { pinnedAt: at(1) });
  return { messages: [m1, m2, m3], hasMore: false, members: people.slice(0, 3), readers: [{ id: RILA, at: at(1) }, { id: NEHA, at: at(25) }], pinned: [m3], receipts: { readThrough: at(25), deliveredThrough: at(1) } };
};
const replies = () => ({ messages: [
  { ...msg("58888888-8888-4888-8888-888888888881", NEHA, "Make the logo bigger", 12), parentId: M1, annotation: { fileId: FILE, x: 0.3, y: 0.4, resolved: false } },
  { ...msg("58888888-8888-4888-8888-888888888882", RILA, "Will do", 10), parentId: M1 }], hasMore: false, root: thread().messages[0], members: people.slice(0, 3), receipts: null });
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#4f46e5"/><text x="60" y="260" font-size="64" fill="#fff">Brochure v1</text></svg>`;

type Calls = { path: string; body: Record<string, unknown> }[];
async function mock(context: BrowserContext, { typing = true } = {}) {
  const calls: Calls = [], posted: Record<string, unknown>[] = [];
  await context.route("**/api/v0/chats/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" },
    body: `retry: 800\n\n${typing ? `event: typing\ndata: ${JSON.stringify({ channel: G, person: RILA, name: "Rila Synthetic", on: true })}\n\n` : ""}` }));
  await context.route("**/api/v0/calls/events", (route) => route.abort());
  await context.route(/\/api\/v0\/chats(\?.*)?$/, (route) => route.fulfill({ json: list() }));
  await context.route(/\/api\/v0\/chats\/files\//, (route) => route.fulfill({ status: 200, headers: { "content-type": "image/svg+xml" }, body: SVG }));
  await context.route(/\/api\/v0\/chats\/search/, (route) => { calls.push({ path: route.request().url(), body: {} }); return route.fulfill({ json: { messages: [thread().messages[0]] } }); });
  await context.route(/\/api\/v0\/chats\/[^/]+\/media/, (route) => route.fulfill({ json: { kind: "image", items: [{ messageId: M1, authorId: RILA, name: "Rila Synthetic", createdAt: at(30), attachment: { id: FILE, name: "brochure.png", mime: "image/png" } }], counts: { image: 1, file: 0, link: 0, voice: 0 } } }));
  await context.route(/\/api\/v0\/chats\/[^/]+\/messages/, async (route: Route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>; calls.push({ path: url.pathname, body });
      const id = `59999999-9999-4999-8999-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
      const message = { ...msg(id, ME, String(body.body ?? ""), 0), parentId: body.parentId ?? null, clientId: body.clientId, attachments: body.attachments ?? [] };
      if (body.parentId) posted.push(message);
      return route.fulfill({ json: { id, message } });
    }
    // A thread's replies, with what this test posted in it (as the API would answer after a reply).
    if (url.searchParams.get("thread")) { const r = replies(); return route.fulfill({ json: { ...r, messages: [...r.messages, ...posted] } }); }
    return route.fulfill({ json: url.pathname.includes(G) ? thread() : { messages: [], hasMore: false, members: people.slice(0, 2), receipts: null, readers: [], pinned: [] } });
  });
  await context.route(/\/api\/v0\/chats\/(messages|annotations)\/[^/]+\/\w+$|\/api\/v0\/chats\/[^/]+\/(typing|read|mute|archive|pin)$/, (route) => {
    calls.push({ path: new URL(route.request().url()).pathname, body: (route.request().postDataJSON() ?? {}) as Record<string, unknown> });
    return route.fulfill({ json: { ok: true, ids: ["x"] } });
  });
  return calls;
}
async function openGroup(page: Page) {
  await page.goto("/chats");
  await page.locator('[data-chat-row]:has-text("Skyline creative")').click();
  await expect(page.locator('[role="log"] article').filter({ hasText: "Payment done" })).toBeVisible();
}

test.describe("chat v3 on a computer", () => {
  test.use({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: admin, permissions: ["clipboard-read", "clipboard-write"] });

  test("the list has sections, muted chats and an archive", async ({ page, context }) => {
    await mock(context, { typing: false });
    await page.goto("/chats");
    await expect(page.locator('[data-chat-row]:has-text("Rila Synthetic")').getByLabel("Muted")).toBeVisible();
    await expect(page.locator('[data-chat-row]:has-text("Old launch")')).toHaveCount(0);
    await page.getByRole("tab", { name: "Clients" }).click();
    await expect(page.locator("[data-chat-row]")).toHaveCount(1);
    await expect(page.locator("[data-chat-row]").first()).toContainText("Skyline creative");
    await page.getByRole("tab", { name: "AI" }).click();
    await expect(page.locator("[data-chat-row]").first()).toContainText("Mira Synthetic");
    await page.getByRole("tab", { name: "All" }).click();
    await page.locator("[data-archived-row]").click();
    await expect(page.locator("[data-chat-row]").first()).toContainText("Old launch");
  });

  test("a conversation shows who is typing, who has seen it, the pinned message and an approval", async ({ page, context }) => {
    const calls = await mock(context);
    await openGroup(page);
    await expect(page.locator("[data-pinned-bar]")).toContainText("Payment done");
    await expect(page.locator("[data-typing]")).toContainText("Rila is typing");
    await expect(page.locator("[data-seen-by]")).toContainText("Seen by Rila");
    const approval = page.locator('[role="log"] [data-approval="waiting"]');
    await expect(approval).toContainText("Waiting for approval");
    await approval.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => calls.find((c) => c.path.endsWith(`/messages/${M1}/approval`))?.body.action).toBe("approved");
  });

  test("a thread opens beside the conversation and a reply goes into it", async ({ page, context }) => {
    const calls = await mock(context, { typing: false });
    await openGroup(page);
    await page.locator("[data-thread-chip]").click();
    const pane = page.locator("[data-thread-pane]");
    await expect(pane).toContainText("Make the logo bigger");
    await pane.getByRole("textbox", { name: "Reply in the thread" }).fill("Bigger logo coming up");
    await pane.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => calls.find((c) => c.body.parentId === M1)?.body.body).toBe("Bigger logo coming up");
    await expect(pane).toContainText("Bigger logo coming up");
  });

  test("forward, copy link and pin from a message's menu", async ({ page, context }) => {
    const calls = await mock(context, { typing: false });
    await openGroup(page);
    const m3 = page.locator(`#m-${M3}`);
    await m3.hover(); await m3.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Copy link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`message=${M3}`);
    await m3.hover(); await m3.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Forward" }).click();
    const dialog = page.getByRole("dialog", { name: "Forward message" });
    await dialog.getByRole("checkbox").first().check();
    await dialog.getByRole("button", { name: "Forward" }).click();
    await expect.poll(() => (calls.find((c) => c.path.endsWith(`/messages/${M3}/forward`))?.body.channels as string[] | undefined)?.length).toBe(1);
    await m3.hover(); await m3.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Unpin" }).click();
    await expect.poll(() => calls.find((c) => c.path.endsWith(`/messages/${M3}/pin`))?.body.on).toBe(false);
  });

  test("a picture opens large; a click on it comments on that point", async ({ page, context }) => {
    const calls = await mock(context, { typing: false });
    await openGroup(page);
    await page.locator(`#m-${M1} img`).click();
    const box = page.locator("[data-lightbox]");
    await expect(box).toBeVisible();
    await expect(box.getByRole("button", { name: /^Comment 1:/ })).toBeVisible();
    const img = box.getByRole("img", { name: "brochure.png" });
    const r = (await img.boundingBox())!;
    await page.mouse.click(r.x + r.width * 0.7, r.y + r.height * 0.2);
    const note = box.getByRole("textbox", { name: "Comment on point 2" });
    await note.fill("Move the price here"); await note.press("Enter");
    await expect.poll(() => calls.find((c) => c.path.endsWith(`/messages/${M1}/annotate`))?.body.body).toBe("Move the price here");
    const sent = calls.find((c) => c.path.endsWith("/annotate"))!.body;
    expect(Number(sent.x)).toBeGreaterThan(0.6); expect(Number(sent.y)).toBeLessThan(0.3);
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
  });

  test("search runs as you type and keeps its filters: photos only", async ({ page, context }) => {
    const calls = await mock(context, { typing: false });
    await page.goto("/chats");
    const q = page.getByRole("textbox", { name: /Search chats and people/ });
    await q.fill("brochure");
    await expect(page.locator('section[aria-label="Messages"]')).toBeVisible();
    await expect(page.locator("[data-search-filters]")).toBeVisible();
    await page.locator("[data-search-filters]").getByRole("button", { name: "Photos" }).click();
    await expect.poll(() => calls.some((c) => c.path.includes("has=image") && c.path.includes("q=brochure"))).toBe(true);
    await expect(page.locator('section[aria-label="Messages"] mark').first()).toHaveText(/brochure/i);
  });

  test("offline, a message waits and goes by itself when the connection is back", async ({ page, context }) => {
    const calls = await mock(context, { typing: false });
    await openGroup(page);
    await context.setOffline(true);
    const box = page.locator("[data-chat-composer] textarea");
    await box.fill("Sent from the lift"); await box.press("Enter");
    await expect(page.locator("[data-outbox]")).toContainText("Waiting for the connection");
    expect(calls.some((c) => c.body.body === "Sent from the lift")).toBe(false);
    await context.setOffline(false);
    await expect.poll(() => calls.some((c) => c.body.body === "Sent from the lift"), { timeout: 10_000 }).toBe(true);
    await expect(page.locator("[data-outbox]")).toHaveCount(0);
  });
});

test.describe("chat v3 on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: admin, hasTouch: true, isMobile: true });

  test("swiping a message to the right replies to it", async ({ page, context }) => {
    await mock(context, { typing: false });
    await openGroup(page);
    const r = (await page.locator(`#m-${M3} [class*="bubble"]`).first().boundingBox())!;
    await page.locator(`#m-${M3}`).evaluate((el, b) => {
      const touch = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: b.y + b.height / 2 });
      el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(b.x + 20)], changedTouches: [touch(b.x + 20)] }));
      for (const dx of [20, 45, 70, 95]) el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [touch(b.x + 20 + dx)], changedTouches: [touch(b.x + 20 + dx)] }));
      el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch(b.x + 115)] }));
    }, r);
    await expect(page.locator("[data-chat-composer]")).toContainText("Replying to Neha Synthetic");
  });
});
