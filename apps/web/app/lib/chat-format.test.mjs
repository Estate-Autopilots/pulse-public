import { test } from "node:test";
import assert from "node:assert/strict";
import { byDepartment, clock, dayChip, fileSize, filterChats, kindLabel, lastSeen, listTime, presenceLabel, preview, segments, sortChats, splitQuoted, ticks } from "./chat-format.mjs";

const now = new Date("2026-10-10T09:00:00Z"); // 2:30 pm in India, a Saturday

test("days and times read like WhatsApp, in India time", () => {
  assert.equal(clock("2026-10-10T05:12:00Z"), "10:42 am");
  assert.equal(dayChip("2026-10-10T03:00:00Z", now), "Today");
  assert.equal(dayChip("2026-10-09T03:00:00Z", now), "Yesterday");
  assert.equal(dayChip("2026-10-09T19:00:00Z", now), "Today", "half past midnight in India is today");
  assert.equal(dayChip("2026-10-06T08:00:00Z", now), "Tuesday");
  assert.equal(dayChip("2026-09-28T08:00:00Z", now), "28 September");
  assert.equal(dayChip("2025-12-31T08:00:00Z", now), "31 December 2025");
  assert.equal(listTime("2026-10-10T05:12:00Z", now), "10:42 am");
  assert.equal(listTime("2026-10-09T05:12:00Z", now), "Yesterday");
  assert.equal(listTime("2026-10-07T05:12:00Z", now), "Wed");
  assert.equal(listTime("2026-09-07T05:12:00Z", now), "7 Sept");
});

test("ticks: clock, one, two, read; only on your own messages", () => {
  const m = { authorId: "me", createdAt: "2026-10-10T05:00:00.123456Z" };
  assert.equal(ticks({ ...m, pending: true }, null, "me"), "pending");
  assert.equal(ticks({ ...m, failed: true }, null, "me"), "failed");
  assert.equal(ticks(m, { readThrough: null, deliveredThrough: null }, "me"), "sent");
  assert.equal(ticks(m, { readThrough: "2026-10-10T04:00:00Z", deliveredThrough: "2026-10-10T05:01:00Z" }, "me"), "delivered");
  assert.equal(ticks(m, { readThrough: "2026-10-10T05:00:01Z", deliveredThrough: "2026-10-10T05:00:01Z" }, "me"), "read");
  assert.equal(ticks(m, null, "someone else"), null);
  assert.equal(ticks({ ...m, kind: "event" }, null, "me"), null);
});

test("the preview line says who and what, briefly", () => {
  const base = { kind: "pod", lastAt: "2026-10-10T05:00:00Z", preview: "Shoot moved to 4", previewAuthor: "Ms. Meera Shah", previewAuthorId: "p1" };
  assert.equal(preview(base, "me"), "Meera: Shoot moved to 4");
  assert.equal(preview({ ...base, kind: "direct" }, "me"), "Shoot moved to 4");
  assert.equal(preview({ ...base, previewAuthorId: "me" }, "me"), "You: Shoot moved to 4");
  assert.equal(preview({ ...base, preview: "", previewAttachment: { task: "t", name: "Cut the reel" } }, "me"), "Meera: Task: Cut the reel");
  assert.equal(preview({ ...base, preview: "", previewAttachment: { id: "f", name: "brief.pdf" } }, "me"), "Meera: 📎 brief.pdf");
  assert.equal(preview({ ...base, previewRemoved: true }, "me"), "Meera: This message was deleted");
  assert.equal(preview({ ...base, previewKind: "event", preview: "created the group “Launch”" }, "me"), "Meera created the group “Launch”");
  assert.equal(preview({ kind: "direct", lastAt: null }, "me"), "Say hello");
  assert.equal(preview({ kind: "team", lastAt: null, members: 8 }, "me"), "8 members");
});

test("VISIBLE: a WhatsApp group's moved history previews in its own words, never 'undefined'", () => {
  const base = { kind: "custom", lastAt: "2026-10-10T05:00:00Z", preview: "", previewAuthor: "Pranit Fakeson", previewAuthorId: "p1" };
  // A notice moved from WhatsApp names who in its words; its author is the "WhatsApp" placeholder, left out.
  assert.equal(preview({ ...base, previewKind: "event", preview: "Asha Testwala added Ravi Sample", previewAuthor: "WhatsApp", previewImported: true }, "me"), "Asha Testwala added Ravi Sample");
  // Media the export left out: its kind, said plainly.
  assert.equal(preview({ ...base, previewAttachment: { omitted: "audio" } }, "me"), "Pranit: 📎 Audio (not in the WhatsApp export)");
  assert.equal(preview({ ...base, previewAttachment: { omitted: "unknown" } }, "me"), "Pranit: 📎 Media (not in the WhatsApp export)");
  assert.equal(preview({ ...base, previewAttachment: { omitted: "document", name: "cost-sheet.pdf" } }, "me"), "Pranit: 📎 cost-sheet.pdf (not in the WhatsApp export)");
  // A link or file without a name.
  assert.equal(preview({ ...base, previewAttachment: {} }, "me"), "Pranit: 🔗 Link");
  assert.equal(preview({ ...base, previewAttachment: { id: "f" } }, "me"), "Pranit: 📎 File");
  for (const a of [{}, { id: "f" }, { omitted: "image" }, { url: "/runs/x" }]) assert.ok(!preview({ ...base, previewAttachment: a }, "me").includes("undefined"));
});

test("VISIBLE: the Clients view holds clients' groups moved from WhatsApp", () => {
  const list = [
    { id: "a", name: "Pod 1", kind: "pod", unread: 0 },
    { id: "b", name: "Skyline Fake Homes · Launch", kind: "custom", unread: 0, clientGroup: true },
    { id: "c", name: "Shared with Lotus Test Interiors", kind: "custom", unread: 0, withOrg: "Lotus Test Interiors" },
    { id: "d", name: "Client chat", kind: "custom", unread: 0, clientFacing: true },
  ];
  assert.deepEqual(filterChats(list, "clients").map((c) => c.id), ["b", "c", "d"]);
  assert.deepEqual(filterChats(list, "groups").map((c) => c.id), ["a", "b", "c", "d"]);
});

test("pinned first, then latest; filters for unread, groups and people; duplicates and moderation stay out", () => {
  const list = [
    { id: "a", name: "Pod 1", kind: "pod", unread: 0, lastAt: "2026-10-10T05:00:00Z" },
    { id: "b", name: "Kerin", kind: "direct", unread: 2, lastAt: "2026-10-09T05:00:00Z" },
    { id: "c", name: "Leadership", kind: "team", unread: 0, lastAt: null, pinnedAt: "2026-10-01T00:00:00Z" },
    { id: "d", name: "Creative", kind: "team", unread: 0, lastAt: null, duplicateOf: "x" },
    { id: "e", name: "Ops", kind: "group", unread: 5, lastAt: null, moderationOnly: true },
  ];
  assert.deepEqual(sortChats(list).slice(0, 3).map((c) => c.id), ["c", "a", "b"]);
  assert.deepEqual(filterChats(list, "all").map((c) => c.id), ["a", "b", "c"]);
  assert.deepEqual(filterChats(list, "unread").map((c) => c.id), ["b"]);
  assert.deepEqual(filterChats(list, "groups").map((c) => c.id), ["a", "c"]);
  assert.deepEqual(filterChats(list, "people").map((c) => c.id), ["b"]);
  assert.deepEqual(filterChats(list, "all", "ker").map((c) => c.id), ["b"]);
  assert.equal(kindLabel("team"), "Department");
  assert.equal(kindLabel("direct"), null);
});

test("presence: the place in words, do-not-disturb wins the dot, last seen from the app", () => {
  assert.deepEqual(presenceLabel({ state: "office" }), { label: "In the office", tone: "green", status: "" });
  assert.deepEqual(presenceLabel({ state: "shoot", dnd: true, text: "Back at 6", emoji: "🎬" }), { label: "Do not disturb · On a shoot", tone: "dnd", status: "🎬 Back at 6" });
  assert.equal(presenceLabel({ state: "nonsense" }).label, "Offline");
  assert.equal(lastSeen("2026-10-10T08:48:00Z", now), "Active 12 min ago");
  assert.equal(lastSeen("2026-10-10T03:00:00Z", now), "Last seen today at 8:30 am");
  assert.equal(lastSeen("2026-10-09T03:00:00Z", now), "Last seen yesterday at 8:30 am");
});

test("long links show their domain; mentions only for real people", () => {
  const s = segments("See https://click.mailer.example.com/ls/click?upn=u001.abcdefghijklmnopqrstuvwxyz0123456789, @meera and @nobody", ["meera"]);
  assert.deepEqual(s.map((x) => x.type), ["text", "link", "text", "mention", "text"]);
  assert.equal(s[4].value, " and @nobody");
  assert.equal(s[1].label, "click.mailer.example.com");
  assert.equal(s[1].rest, ",");
  assert.equal(segments("https://pulse.example/tasks/1")[0].label, "https://pulse.example/tasks/1");
});

test("a plain-text e-mail separates the new part from the quoted message", () => {
  const mail = "Thanks, see you Monday.\n\nOn Fri, 9 Oct 2026 at 10:00, Priya <p@example.com> wrote:\n> Can we meet?\n> P";
  assert.deepEqual(splitQuoted(mail), { main: "Thanks, see you Monday.", quoted: "On Fri, 9 Oct 2026 at 10:00, Priya <p@example.com> wrote:\n> Can we meet?\n> P" });
  assert.deepEqual(splitQuoted("No quote here\n> but this is mid-text\nmore"), { main: "No quote here\n> but this is mid-text\nmore", quoted: "" });
  assert.equal(splitQuoted("Hi\n\n---------- Forwarded message ---------\nFrom: X").main, "Hi");
});

test("group members by department, biggest first; sizes in words", () => {
  const out = byDepartment([{ name: "Zoya", team: "Creative" }, { name: "Amit", team: "Sales" }, { name: "Bina", team: "Creative" }, { name: "Om", team: null }]);
  assert.deepEqual(out.map((g) => [g.department, g.people.map((p) => p.name)]), [["Creative", ["Bina", "Zoya"]], ["Sales", ["Amit"]], ["No department", ["Om"]]]);
  // SIM-CLIENTS R137: a client under their company, first; never "No department".
  const withClient = byDepartment([{ name: "Zoya", team: "Creative" }, { name: "Ashby Rook", team: null, company: "Rookwood Homes (test)" }, { name: "Om", team: null }]);
  assert.deepEqual(withClient.map((g) => [g.department, g.people.map((p) => p.name)]), [["Rookwood Homes (test)", ["Ashby Rook"]], ["Creative", ["Zoya"]], ["No department", ["Om"]]]);
  assert.equal(fileSize(2_500_000), "2.4 MB");
  assert.equal(fileSize(0), "");
});

test("WA-NATIVE: a mention by name, and a username followed by a full stop", () => {
  const parts = segments("Thanks @kedab.mifos. Over to @Asha Kireteso and @nobody.", ["kedab.mifos"], [{ name: "Asha Kireteso", username: null }]);
  assert.deepEqual(parts.filter((p) => p.type === "mention").map((p) => p.value), ["@kedab.mifos", "@Asha Kireteso"]);
  assert.equal(parts.map((p) => p.value).join(""), "Thanks @kedab.mifos. Over to @Asha Kireteso and @nobody.");
});

test("STAFF-UX: a chat without a name never breaks the search (TypeError reading toLowerCase on /chats)", () => {
  const list = [{ id: "a", kind: "direct", name: null, unread: 0 }, { id: "b", kind: "group", name: "Shoot crew", unread: 0, preview: "call sheet" }];
  assert.deepEqual(filterChats(list, "all", "shoot").map((c) => c.id), ["b"]);
  assert.deepEqual(filterChats(list, "all", "call").map((c) => c.id), ["b"]);
});
