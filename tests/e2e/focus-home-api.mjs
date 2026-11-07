// Busy, synthetic Focus/HR/Chats fixtures; all unrelated requests use the existing shell fixture.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { desk } from "./fixtures/hr-polish.mjs";

const mockPort = await new Promise((resolve) => {
  const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const mock = spawn(process.execPath, ["tests/e2e/mock-editors-api.mjs"], { stdio: "inherit", env: { ...process.env, PORT: String(mockPort) } });
process.on("exit", () => mock.kill());
process.on("SIGTERM", () => process.exit());
process.on("SIGINT", () => process.exit());
const channel = "11111111-1111-4111-8111-111111111111";
const members = [{ id: "synthetic-admin", name: "Synthetic Admin", username: "synthetic-admin" }, { id: "synthetic-colleague", name: "Synthetic Colleague", username: "synthetic-colleague" }];
const message = (body, i) => ({ id: `synthetic-message-${i}`, channelId: channel, authorId: members[1].id, name: members[1].name, username: members[1].username,
  body, parentId: null, createdAt: new Date(Date.now() - (30 - i) * 60_000).toISOString(), editedAt: null, removed: false, replies: 0, attachments: [], mentions: [], reactions: [] });
const messages = Array.from({ length: 24 }, (_, i) => message(`Synthetic message ${i + 1}`, i));
const list = { channels: [{ id: channel, name: "Synthetic review", kind: "group", description: "A populated synthetic conversation", address: null, unread: 0, members: 2, lastAt: messages.at(-1).createdAt }],
  people: members, viewer: members[0].id, canModerate: false, retentionDays: 365 };
const json = (res, data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
// Wait for the shell fixture before declaring this managed service ready.
for (let i = 0; i < 100; i++) {
  try { await fetch(`http://127.0.0.1:${mockPort}/api/v0/me`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/api/v0/hr/desk") return json(res, desk("synthetic-admin"));
    if (url.pathname === "/api/v0/chats") return json(res, list);
    if (url.pathname === `/api/v0/chats/${channel}/messages`) {
      if (req.method === "POST") {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); const sent = { ...message(body.body, messages.length), authorId: members[0].id, name: members[0].name, clientId: body.clientId };
        messages.push(sent); return json(res, { id: sent.id, message: sent });
      }
      return json(res, { messages, hasMore: false, members, receipts: null });
    }
    if (url.pathname.startsWith("/api/v0/chats/")) return json(res, { ok: true });
    const up = await fetch(`http://127.0.0.1:${mockPort}${req.url}`, { headers: req.headers });
    const data = await up.json();
    // Fill all nine Max slots with invented filing actions so every number key is exercised.
    if (url.pathname === "/api/v0/finance/live") data.model.compliance.quarters = [1, 2, 3].map((quarter) => ({
      quarter, period: "2026-09", gstr1: { filed: false, due: "2026-09-20" }, gstr3b: { filed: false, due: "2026-09-25" },
    }));
    if (url.pathname === "/api/v0/home") {
      data.attendanceEnabled = true;
      data.attendance = { headcount: 2, present: 1, checkedInToday: 1, ownOpen: false, canCheckIn: true,
        entries: [{ id: "synthetic-entry", personId: members[1].id, name: members[1].name, checkedInAt: new Date().toISOString(), checkedOutAt: null }] };
    }
    json(res, data, up.status);
  } catch (e) { json(res, { error: String(e) }, 500); }
}).listen(Number(process.env.PORT), "127.0.0.1");
