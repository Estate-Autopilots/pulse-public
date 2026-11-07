import { expect, test, type Page } from "@playwright/test";

// Synthetic identities only; never run this screenshot fixture against a live tenant. Runs under the standard e2e config
// (tools/ci.sh, next start) and under ai-employees.config.ts (next dev, affected-route check).
const members = [
  { id: "synthetic-admin", name: "Synthetic Admin", username: "synthetic.admin", agent: false },
  { id: "synthetic-human", name: "Studio Member", username: "studio.member", agent: false },
  { id: "synthetic-ai", name: "Studio Assistant", username: "studio.assistant", agent: true, employeeId: "DEMO-AI-001" },
];
const group = { id: "synthetic-chat", name: "Studio chat", kind: "custom", description: "Synthetic AI identity check", address: null,
  unread: 0, members: 3, lastAt: "2026-10-19T10:00:00Z", myRole: "member" };
const direct = { id: "synthetic-dm", name: "Studio Assistant", kind: "direct", description: "", address: null,
  unread: 0, members: 2, lastAt: "2026-10-19T10:02:00Z", peerId: "synthetic-ai", peerAgent: true };
const message = (id: string, channelId: string, who: (typeof members)[number], body: string, minute: number) => ({
  id, channelId, authorId: who.id, name: who.name, username: who.username, byAgent: who.agent, employeeId: who.agent ? who.employeeId : null,
  body, parentId: null, createdAt: `2026-10-19T10:0${minute}:00Z`, editedAt: null, removed: false, replies: 0, attachments: [], mentions: [], reactions: [],
});
const threads: Record<string, ReturnType<typeof message>[]> = {
  [group.id]: [message("human-message", group.id, members[1], "Please review the brief.", 0), message("ai-message", group.id, members[2], "The synthetic brief is ready for review.", 1)],
  [direct.id]: [message("dm-ai-1", direct.id, members[2], "I drafted the synthetic brief.", 0), message("dm-mine", direct.id, members[0], "Thanks, send it over.", 1),
    message("dm-ai-2", direct.id, members[2], "Done: it is in the shared folder.", 2)],
};
const badge = { name: "AI employee · DEMO-AI-001", exact: true };

async function open(page: Page, baseURL: string | undefined, theme: string, width: number, channel: { id: string; name: string }) {
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Synthetic local API only");
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme as "light" | "dark" });
  // Use the mock server's synthetic admin account so the layout and chat cache have the same viewer.
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@northwind-on.example" });
  await page.addInitScript((theme) => { localStorage.setItem("pulse.theme", theme); }, theme);
  const list = { channels: [group, direct], people: members, viewer: "synthetic-admin", canLead: true, canModerate: false, retentionDays: 90 };
  // A glob's ** spans folders only between slashes ("chats**" never matched a thread), so the chat API is a pattern.
  await page.route(/\/api\/v0\/chats(\/|\?|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname, id = path.split("/")[4] ?? "";
    if (path === "/api/v0/chats/events") return route.abort();
    await route.fulfill({ json: path === "/api/v0/chats" ? list : path.endsWith("/messages")
      ? { messages: threads[id] ?? [], members: id === direct.id ? [members[0], members[2]] : members, receipts: null, hasMore: false } : { ok: true } });
  });
  // The server's list read has no synthetic chat API, so the list loads in the browser first and the chat opens with a
  // click: a deep link would sync the thread before the viewer is known, and the cache drops it once the list arrives.
  await page.goto("/chats");
  await expect(page.locator("body")).toHaveAttribute("data-viewer", members[0].id);
  await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
  await page.locator("[data-chat-row]").filter({ has: page.locator("b", { hasText: channel.name }) }).click();
  await expect(page).toHaveURL(new RegExp(`channel=${channel.id}`));
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`AI chat identity: author, members and mentions (${theme}, ${width}px)`, async ({ page, baseURL }, testInfo) => {
    await open(page, baseURL, theme, width, group);
    const author = page.locator("#m-ai-message");
    await expect(author.getByRole("img", badge)).toBeVisible();
    await expect(author.getByRole("link", { name: "Studio Assistant", exact: true })).toHaveAttribute("href", "/people/ai/synthetic-ai");
    await expect(author.locator('[data-shape="square"]')).toHaveCount(1);
    await expect(page.locator("#m-human-message").getByRole("img", { name: /AI employee/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Studio chat: details and members", exact: true }).click();
    const info = page.getByRole("complementary", { name: "Group info" });
    await expect(info.getByRole("img", badge)).toBeVisible();
    await expect(info.getByRole("img", { name: /AI employee/ })).toHaveCount(1);
    await expect(info.getByRole("link", { name: "Studio Assistant" })).toHaveAttribute("href", "/people/ai/synthetic-ai");
    await info.getByRole("button", { name: "Close details" }).click();
    await page.getByRole("textbox", { name: "Message Studio chat", exact: true }).fill("@");
    const picker = page.getByRole("listbox", { name: "People", exact: true });
    // The two people, then CHAT-V5's group-wide @everyone and @here (1007).
    await expect(picker.getByRole("option")).toHaveCount(4);
    await expect(picker.locator("[data-broadcast]")).toHaveCount(2);
    await expect(picker.getByRole("option").filter({ hasText: "Studio Assistant" }).getByRole("img", badge)).toBeVisible();
    await expect(picker.getByRole("option").filter({ hasText: "Studio Member" }).getByRole("img", { name: /AI employee/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`ai-chat-${theme}-${width}.png`), fullPage: true });
    await page.goto("/kit");
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    const gallery = page.getByRole("region", { name: "AI employees", exact: true });
    await expect(gallery.getByRole("img", { name: /AI employee/ })).toHaveCount(2);
    await expect(gallery.locator('[data-shape="square"]')).toHaveCount(1);
  });
}

// A direct chat with an AI employee on a phone: each run of its messages carries its face and name, mine never do.
for (const theme of ["light", "dark"]) {
  test(`AI direct chat on a phone (${theme})`, async ({ page, baseURL }, testInfo) => {
    await open(page, baseURL, theme, 390, direct);
    await expect(page.getByRole("button", { name: "Studio Assistant: details and members", exact: true }).getByRole("img", badge)).toBeVisible();
    for (const id of ["#m-dm-ai-1", "#m-dm-ai-2"]) {
      await expect(page.locator(id).getByRole("img", badge)).toBeVisible();
      await expect(page.locator(id).locator('[data-shape="square"]')).toHaveCount(1);
    }
    await expect(page.locator("#m-dm-mine").getByRole("img", { name: /AI employee/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`ai-dm-${theme}-390.png`), fullPage: true });
  });
}
