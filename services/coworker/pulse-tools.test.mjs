// AI-SERVER-TOOLS: the AI employee's Pulse tools (pulse-tools.mjs): what the prompt says, what the model asks for, and what
// goes back to it (never a secret).
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogue, directRun, jobOf, mcpCall, redact, resultText, toolCalls, toolsPart, TOOLS_PER_ROUND } from "./pulse-tools.mjs";

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
