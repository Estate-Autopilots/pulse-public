// AI-SERVER-TOOLS: the AI employee's Pulse tools (pulse-tools.mjs): what the prompt says, what the model asks for, and what
// goes back to it (never a secret).
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogue, directRun, jobOf, mcpCall, QUOTE_PLAYBOOK, quoteOf, redact, resultText, toolCalls, toolsPart, TOOLS_PER_ROUND, QUOTE_WORDS_PLAYBOOK, QUOTE_CORE, wordsReply, heardByVoice, pickTools, quoteAsk, docChat, wantsOpen, areaOf } from "./pulse-tools.mjs";

const TOOLS = [
  { name: "list_servers", description: "Lists the company's connected servers. More words.", inputSchema: { type: "object", properties: {} } },
  { name: "run_on_server", description: "Runs work on a company server by name.", inputSchema: { type: "object", properties: { server: {}, mode: {}, command: {}, requestId: {} }, required: ["server", "mode"] } },
  { name: "list_invoices", description: "Lists invoices.", inputSchema: { type: "object", properties: { status: {} } } },
];

test("the catalogue is one short line per tool, required arguments starred, requestId left out", () => {
  const c = catalogue(TOOLS).split("\n");
  assert.equal(c.length, 3);
  assert.equal(c[0], "- list_servers(): Lists the company's connected servers.");
  assert.equal(c[1], "- run_on_server(server*, mode*, command): Runs work on a company server by name.");
});

test("the prompt says what it can do (servers included) and never that it has no access", () => {
  const servers = [{ name: "host-49a12d.internal.example", online: true, accessLevel: "read-write", sandbox: true, claude: true, codex: false, mayUse: true },
    { name: "backup", online: false, accessLevel: "read-only", sandbox: true, claude: false, codex: false, mayUse: false }];
  const t = toolsPart(TOOLS, { name: "Project Coordinator (AI)", servers });
  assert.match(t, /host-49a12d.internal.example \(online, your tier: read-write, Claude Code signed in\)/);
  assert.match(t, /backup \(offline, AI employees may not use it yet\)/);
  assert.match(toolsPart(TOOLS, { servers: [{ ...servers[0], tier: "sandboxed" }] }), /your tier: read-write in a sandbox/);
  assert.match(t, /Never say you have no access/);
  assert.match(t, /- list_invoices\(status\): Lists invoices\./);
  assert.match(toolsPart(TOOLS, {}), /has not connected a server/);
});

test("tool calls: from the JSON answer, known tools only, at most five", () => {
  const many = { tools: Array.from({ length: 8 }, () => ({ name: "list_servers", args: {} })) };
  assert.equal(toolCalls(JSON.stringify(many)).length, TOOLS_PER_ROUND);
  assert.deepEqual(toolCalls('{"tools":[{"name":"run_on_server","args":{"server":"ea","mode":"shell","command":"uname -a"}},{"name":"drop_db"}]}', new Set(["run_on_server"])),
    [{ name: "run_on_server", args: { server: "ea", mode: "shell", command: "uname -a" } }]);
  assert.deepEqual(toolCalls('{"reply":"hello"}'), []);
  assert.deepEqual(toolCalls("plain words"), []);
});

test("results go back as text, refusals said, secrets hidden, long answers cut", () => {
  const key = `pak_0123abcd_${"a".repeat(64)}`;
  assert.equal(redact(`key ${key} end`), "key [hidden] end");
  const t = resultText({ name: "list_servers", args: {} }, { content: [{ type: "text", text: `{"items":[]} ${key}` }] });
  assert.ok(!t.includes(key) && t.startsWith("list_servers({}) returned:"));
  assert.match(resultText({ name: "x", args: {} }, { isError: true, content: [{ type: "text", text: "No" }] }), /was refused: No/);
  assert.match(resultText({ name: "x", args: {} }, { content: [{ type: "text", text: "y".repeat(50) }] }, 10), /\(cut\)$/);
});

test("an empty page reads as an empty page, not {} (BUG-SWEEP-3, Agent Lab #2)", () => {
  const page = { items: [], nextCursor: null };
  const t = resultText({ name: "list_triage_tasks", args: { limit: "100" } }, { content: [{ type: "text", text: JSON.stringify(page) }], structuredContent: page });
  assert.equal(t, 'list_triage_tasks({"limit":"100"}) returned: {"items":[],"nextCursor":null}');
  const more = { items: [{ id: "t1", title: "Synthetic", assignee: null, dueAt: null }], nextCursor: "abc" };
  assert.equal(resultText({ name: "list_triage_tasks", args: {} }, { content: [{ type: "text", text: JSON.stringify(more) }] }),
    'list_triage_tasks({}) returned: {"items":[{"id":"t1","title":"Synthetic"}],"nextCursor":"abc"}');
});

test("a run_on_server answer names its job, from structured content or text", () => {
  assert.deepEqual(jobOf({ structuredContent: { job: { id: "job_1", final: false, kind: "shell-safe" } } }), { id: "job_1", final: false, kind: "shell-safe" });
  assert.deepEqual(jobOf({ content: [{ type: "text", text: '{"job":{"id":"job_2","final":true,"kind":"claude"}}' }] }), { id: "job_2", final: true, kind: "claude" });
  assert.equal(jobOf({ content: [] }), null);
});

test("MCP calls carry the key as a bearer only, and read JSON or an event stream", async () => {
  const seen = [];
  const fake = (body) => async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => body }; };
  const r1 = await mcpCall("http://pulse.test", "pak_k", "tools/list", {}, { fetchImpl: fake('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}') });
  assert.deepEqual(r1, { tools: [] });
  const r2 = await mcpCall("http://pulse.test", "pak_k", "tools/list", {}, { fetchImpl: fake('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n') });
  assert.deepEqual(r2, { ok: 1 });
  assert.equal(seen[0].url, "http://pulse.test/api/v1/mcp");
  assert.equal(seen[0].init.headers.authorization, "Bearer pak_k");
  assert.equal(seen[0].init.headers["x-pulse-agent-key"], undefined);
  await assert.rejects(mcpCall("http://pulse.test", "k", "tools/call", {}, { fetchImpl: fake('{"jsonrpc":"2.0","id":1,"error":{"message":"refused"}}') }), /refused/);
});

test("AI-EMPLOYEE-POWER: 'run X on Y' runs first, only on a server it may use, never as root", () => {
  const servers = [{ name: "host-49a12d.internal.example", mayUse: true }, { name: "srv2058835", mayUse: false }];
  assert.deepEqual(directRun("(test) run uname -a on host-49a12d.internal.example", servers), { name: "run_on_server", args: { server: "host-49a12d.internal.example", mode: "shell", command: "uname -a", level: "read-only" } });
  assert.equal(directRun("run df -h on srv2058835", servers), null);
  assert.equal(directRun("can you check the disk?", servers), null);
  assert.match(toolsPart(TOOLS, { name: "Ops", servers: [{ name: "host-49a12d.internal.example", mayUse: true, tier: "root", timeLimitSec: 900, online: true }] }), /your tier: root, unsandboxed, up to 15 min/);
});

test("BHARATA-CORE: an employee with the quotation tools gets the quotation playbook; others do not", () => {
  const quote = [...TOOLS, { name: "find_or_create_client", description: "Finds or adds a client." }, { name: "create_quotation", description: "Drafts a quotation." }];
  const t = toolsPart(quote, { name: "Quotation agent" });
  assert.ok(t.includes(QUOTE_PLAYBOOK));
  assert.ok(t.indexOf(QUOTE_PLAYBOOK) < t.indexOf("- create_quotation"), "the playbook comes before the tool list");
  assert.ok(!toolsPart(TOOLS, {}).includes("Quotations (someone asks"));
  // What the playbook holds the model to: the client found first, a choice when unclear, catalogue prices, no second draft.
  for (const rule of [/ambiguous": do not draft/, /Which client is this for\?/, /Never a second draft/, /leave rate out so the catalogue price applies/, /never ask a colleague for a price the catalogue holds/, /you never approve/])
    assert.match(QUOTE_PLAYBOOK, rule);
  assert.doesNotMatch(QUOTE_PLAYBOOK, /Willow Lane|PuREPower|Akabod/, "tenant-neutral");
});

test("BHARATA-CORE: the quotation a create or revise answer names, from text or structured content; nothing else", () => {
  const id = "d2dc215f-738f-47b5-9782-9fdf0da66f73", url = `https://pulse.example.test/erp/documents/${id}`;
  assert.deepEqual(quoteOf({ content: [{ type: "text", text: JSON.stringify({ id, status: "draft", url }) }] }), { id, url });
  assert.deepEqual(quoteOf({ structuredContent: { document: { id, url } } }), { id, url });
  assert.equal(quoteOf({ content: [{ type: "text", text: JSON.stringify({ id, url: "javascript:alert(1)" }) }] }), null);
  assert.equal(quoteOf({ content: [{ type: "text", text: "not json" }] }), null);
});

test("BHARATA-CORE: the person asking is named with their id (AI employees cannot search people), never a malformed id", () => {
  const id = "3e703d8a-13ea-49f1-9fa0-6303d1c062aa";
  assert.match(toolsPart(TOOLS, { asker: { id, name: "Asha" } }), new RegExp(`Asha \\(person id ${id}\\)`));
  assert.doesNotMatch(toolsPart(TOOLS, { asker: { id: "x; drop", name: "Asha" } }), /person id/);
  assert.doesNotMatch(toolsPart(TOOLS, {}), /person id/);
});

// AGENT-UI-CONTROL: the screen tools act for the person who wrote; the model never picks whose screen it is.
test("screen tools: whose screen is the person who wrote, the prompt teaches cards, the catalogue hides forPersonId", async () => {
  const { isScreenTool, screenTarget } = await import("./pulse-tools.mjs");
  const person = "0a0a0a0a-0000-4000-8000-000000000001";
  assert.equal(isScreenTool("screen_open_side_panel"), true);
  assert.equal(isScreenTool("run_on_server"), false);
  assert.equal(screenTarget({ message: { authorId: person } }), person);
  assert.equal(screenTarget({ message: { author_id: person } }), person);
  assert.equal(screenTarget({ message: { authorId: person, mine: true } }), null, "never its own message");
  assert.equal(screenTarget({ task: { id: "t" }, message: { authorId: person } }), null, "a task has nobody at a screen");
  assert.equal(screenTarget({ message: { authorId: "Kazuk" } }), null);
  const screen = [{ name: "screen_open_side_panel", description: "Opens target beside the chat. More.", inputSchema: { type: "object", properties: { target: {}, title: {}, forPersonId: {}, why: {}, requestId: {} }, required: ["target"] } }];
  assert.equal(catalogue(screen), "- screen_open_side_panel(target*, title, why): Opens target beside the chat.");
  const p = toolsPart([...TOOLS, ...screen], { name: "Pip" });
  assert.match(p, /screen_show_card/);
  assert.match(p, /client\.add/);
  assert.match(p, /quote:<id>/);
  assert.doesNotMatch(toolsPart(TOOLS, { name: "Pip" }), /screen_/, "no screen words without the tools");
});

test("BHARATA-2: with draft_quotation a quotation request gets the one-call playbook and only the core quote tools", () => {
  const quote = [...TOOLS, ...["find_or_create_client", "create_quotation", "search_catalogue", "list_quotations", "draft_quotation", "create_client", "get_client", "submit_quotation"].map((name) => ({ name, description: `${name}.` }))];
  for (const ask of ["Make a quotation for Mifos Traders: one 5 kW system", "नए क्लाइंट शर्मा ट्रेडर्स के लिए कोटेशन बनाओ", "Kireteso Agro साठी मागच्या वेळेसारखेच कोटेशन करा", "Change it to two 3 kW systems and add the 10-year warranty for both."]) {
    const t = toolsPart(quote, { name: "Bharata", text: ask });
    assert.ok(t.includes(QUOTE_WORDS_PLAYBOOK), ask);
    assert.ok(!t.includes("Quotations (someone asks"), "not the step-by-step playbook too");
    assert.match(t, /- draft_quotation\(/);
    assert.doesNotMatch(t, /- create_quotation\(|- find_or_create_client\(|- create_client\(/, "the step-by-step tools are one more_tools away");
  }
  const shown = pickTools(quote, "quote for Desai Dairy").shown.map((x) => x.name);
  assert.ok(shown.every((n) => QUOTE_CORE.has(n) || ["search", "whoami"].includes(n) || !/quot|client|catalog/.test(n)), shown.join());
  assert.ok(toolsPart(quote.filter((x) => x.name !== "draft_quotation"), { text: "quote for Desai Dairy" }).includes("Quotations (someone asks"), "an older Pulse: the old playbook");
  assert.doesNotMatch(QUOTE_WORDS_PLAYBOOK, /Willow Lane|PuREPower|Akabod/, "tenant-neutral");
  assert.ok(!QUOTE_CORE.has("revise_quotation") && !QUOTE_CORE.has("submit_quotation"), "changes and submits go through draft_quotation (one round)");
});

test("BHARATA-2: draft_quotation's own reply is the answer (drafted or a question); a refusal or another shape is not", () => {
  const ok = { structuredContent: { status: "drafted", reply: "Draft quotation for X:\nhttps://p.test/erp/documents/1", quotation: { id: "1" } } };
  assert.deepEqual(wordsReply(ok), { reply: "Draft quotation for X:\nhttps://p.test/erp/documents/1", status: "drafted", quote: true });
  assert.deepEqual(wordsReply({ content: [{ type: "text", text: JSON.stringify({ status: "ask", reply: "Which client is this for?", quotation: null }) }] }), { reply: "Which client is this for?", status: "ask", quote: false });
  assert.equal(wordsReply({ isError: true, content: [{ type: "text", text: "refused" }] }), null);
  assert.equal(wordsReply({ structuredContent: { status: "weird", reply: "x" } }), null);
  assert.equal(heardByVoice("🎙 Voice note, transcribed on our server: quote for Desai Dairy"), true);
  assert.equal(heardByVoice("🎙 Live transcript · Site meeting"), true);
  assert.equal(heardByVoice("quote for Desai Dairy"), false);
});

test("BHARATA-2: a quotation request is recognised in English, Hindi and Marathi (the admin snapshot stays out of it)", () => {
  for (const t of ["Make a quotation for Mifos Traders", "Same as last time for Kireteso Agro please.", "नए क्लाइंट के लिए कोटेशन बनाओ", "Kireteso Agro साठी मागच्या वेळेसारखेच कोटेशन करा", "🎙 Voice note, transcribed on our server: देसाई डेयरी के लिए कोटेशन"])
    assert.equal(quoteAsk(t), true, t);
  for (const t of ["How many people are on leave today?", "open Finance", "thanks!"]) assert.equal(quoteAsk(t), false, t);
});

test('WL-FOLLOWUP: the quotation playbook says a task asked for someone is a task, never a quotation or a client', () => {
  assert.match(QUOTE_WORDS_PLAYBOOK, /assign <name> a task/);
  assert.match(QUOTE_WORDS_PLAYBOOK, /create_task\), never a quotation, and a colleague is never a client/);
});

// ARTHA-FIX (17 Nov 2026): a Finance AI employee's doc stayed private to it and nobody in the group could open it; the
// ask to open it came in the message before a bare "@name".
test("ARTHA-FIX: a doc written in a chat is shared with that chat, and opens beside it when the person asked to see it", () => {
  const ch = "00000000-0000-4000-8000-0000000000c1", who = "00000000-0000-4000-8000-0000000000c2";
  const group = { message: { channelId: ch, authorId: who, body: "@kosha", channelKind: "custom" },
    recent: [{ authorId: who, body: "Check what is remaining, make a document and open it in the side browser for us to see." }] };
  assert.equal(docChat(group), ch, "the chat it is answering in");
  assert.equal(docChat({ ...group, task: { id: "t" } }), null, "not a task run");
  assert.equal(docChat({ ...group, clientFacing: true }), null, "never a client's conversation");
  assert.equal(docChat({ ...group, message: { ...group.message, mine: true } }), null);
  assert.equal(docChat({ ...group, kind: "consult.answer" }), null);
  assert.equal(wantsOpen(group), true, "the ask in the line before the bare mention counts");
  assert.equal(wantsOpen({ message: { channelId: ch, authorId: who, body: "Make a doc of the pending GST work" }, recent: [] }), false, "only when they asked to see it");
  assert.equal(wantsOpen({ message: { channelId: ch, authorId: who, body: "@kosha" }, recent: [{ authorId: "someone-else", body: "open it beside the chat" }] }), false, "someone else's words do not count");
  assert.equal(wantsOpen({ message: { body: "show me", channelId: ch, authorId: who }, task: { id: "t" } }), false);
});

test("ARTHA-FIX: Money records, finance numbers and bank statements are the money area, and bank or GST words show it", () => {
  for (const n of ["list_money_records", "get_finance_numbers", "import_bank_statement", "list_finance_entries"]) assert.equal(areaOf(n), "money", n);
  const tools = ["list_money_records", "import_bank_statement", "create_doc"].map((name) => ({ name, description: "x" }));
  assert.deepEqual(pickTools(tools, "Import the HDFC bank statement for October").shown.map((t) => t.name), ["list_money_records", "import_bank_statement"]);
  assert.ok(pickTools(tools, "GST and non-GST payments").shown.some((t) => t.name === "list_money_records"));
});

test("FIN-AGENT-2: the learned-skill tools come with the money tools", () => {
  for (const n of ["list_skills", "run_skill", "get_job"]) assert.equal(areaOf(n), "money");
  const tools = ["list_skills", "run_skill", "get_job", "list_invoices", "create_task"].map((name) => ({ name }));
  assert.deepEqual(pickTools(tools, "which invoices are paid?").shown.map((t) => t.name), ["list_skills", "run_skill", "get_job", "list_invoices"]);
  assert.ok(pickTools(tools, "reconcile the October bank statement").shown.some((t) => t.name === "run_skill"), "bank words show them too");
});

// QUOTE-FAST (18 Nov 2026): the quotations an answer links (their PDF then comes to the chat), and the arguments the
// runtime fills itself (the chat and who asked) stay out of the tool list the model reads.
test("the quotations an answer links, and the runtime's own arguments kept out of the tool list", async () => {
  const { quoteIdsIn } = await import("./pulse-tools.mjs");
  const a = "afa792e9-f647-46ec-9304-ff81b0978ca6", b = "0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
  assert.deepEqual(quoteIdsIn(`QT/26-27/0002: https://app.example/erp/documents/${a} (and again https://app.example/erp/documents/${a.toUpperCase()}), the draft https://app.example/erp/documents/${b}`), [a, b]);
  assert.deepEqual(quoteIdsIn("no link here, only /erp/documents/not-an-id"), []);
  assert.equal(quoteIdsIn(Array.from({ length: 5 }, (_, i) => `/erp/documents/${a.slice(0, -1)}${i}`).join(" ")).length, 3);
  const line = catalogue([{ name: "draft_quotation", description: "One call for a quotation.", inputSchema: { properties: { client: {}, items: {}, chatId: {}, askedById: {} }, required: [] } }]);
  assert.match(line, /draft_quotation\(client, items\)/); assert.doesNotMatch(line, /chatId|askedById/);
});
