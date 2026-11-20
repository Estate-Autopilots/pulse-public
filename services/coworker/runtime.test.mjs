import { test } from "node:test";
import assert from "node:assert/strict";
import { answerJson, quotaUntil, QUOTA } from "./runtime.mjs";

const now = new Date("2026-10-22T04:00:00Z");
test("out of quota is told apart, with the plan's own reset time", () => {
  const claude = "You've hit your weekly limit · resets Oct 24, 11am (UTC)";
  const codex = "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 27th, 2026 6:34 AM.";
  assert.ok(QUOTA.test(claude)); assert.ok(QUOTA.test(codex)); assert.ok(!QUOTA.test("model not found"));
  assert.equal(quotaUntil(claude, now).toISOString(), "2026-10-24T11:00:00.000Z");
  assert.equal(quotaUntil(codex, now).toISOString(), "2026-10-27T06:34:00.000Z");
  assert.equal(quotaUntil("resets Jan 2, 3pm (UTC)", now).toISOString(), "2027-01-02T15:00:00.000Z", "a reset in January is next year's");
  assert.equal(quotaUntil("limit reached, try later", now), null);
});
test("the model's JSON answer, also inside a code fence or a sentence", () => {
  assert.deepEqual(answerJson('{"reply":"hi"}'), { reply: "hi" });
  assert.deepEqual(answerJson('```json\n{"status":"done","report":"ok"}\n```'), { status: "done", report: "ok" });
  assert.deepEqual(answerJson('Here you go: {"reply":"x"} thanks'), { reply: "x" });
  assert.equal(answerJson("plain words"), null);
});

// AI-TOOLS-FIX (17 Nov 2026, EA bug #25): no engine reaches Pulse (or anything) through the operator's MCP servers. Claude
// Code runs with --strict-mcp-config; a Codex run here switches off every MCP server Codex lists, or does not run.
test("AI-TOOLS-FIX: Codex's own MCP servers are switched off for an AI employee's run, or the run stops", async () => {
  const { callModel, claudeArgs, codexMcpOff } = await import("./runtime.mjs");
  assert.ok(claudeArgs("sonnet", null).includes("--strict-mcp-config"));
  assert.deepEqual(codexMcpOff([]), []);
  assert.deepEqual(codexMcpOff([{ name: "pulse", enabled: true }, { name: "off-already", enabled: false }, { name: "docs_2", enabled: true }]),
    ["-c", "mcp_servers.pulse.enabled=false", "-c", "mcp_servers.docs_2.enabled=false"]);
  assert.throws(() => codexMcpOff(null), /could not list its MCP servers/);
  assert.throws(() => codexMcpOff([{ name: "my tool", enabled: true }]), /cannot be switched off/);

  const { mkdtemp, writeFile, readFile, rm, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "fake-codex-")), bin = join(dir, "codex");
  await writeFile(bin, `#!/bin/sh
if [ "$1" = "mcp" ]; then cat "$FAKE_MCP"; exit "\${FAKE_MCP_RC:-0}"; fi
printf '%s\\n' "$@" > "$FAKE_ARGS"; cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"comment\\":\\"ok\\"}"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
`);
  await chmod(bin, 0o755);
  const saved = { PATH: process.env.PATH, FAKE_MCP: process.env.FAKE_MCP, FAKE_ARGS: process.env.FAKE_ARGS, FAKE_MCP_RC: process.env.FAKE_MCP_RC };
  Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, FAKE_MCP: join(dir, "mcp.json"), FAKE_ARGS: join(dir, "args.txt") });
  try {
    await writeFile(join(dir, "mcp.json"), JSON.stringify([{ name: "pulse", enabled: true, transport: { type: "streamable_http", url: "https://pulse.invalid/api/v1/mcp" } }]));
    const r = await callModel({ provider: "codex" }, "Synthetic prompt");
    assert.equal(r.text, '{"comment":"ok"}');
    const args = (await readFile(join(dir, "args.txt"), "utf8")).trim().split("\n");
    assert.equal(args[0], "exec"); assert.ok(args.includes("read-only"));
    assert.equal(args[args.indexOf("mcp_servers.pulse.enabled=false") - 1], "-c", "the operator's Pulse MCP server is off for this run");
    await writeFile(join(dir, "mcp.json"), JSON.stringify([{ name: "a b", enabled: true }]));
    await assert.rejects(callModel({ provider: "codex" }, "Synthetic prompt"), /cannot be switched off/);
    process.env.FAKE_MCP_RC = "1";
    await assert.rejects(callModel({ provider: "codex" }, "Synthetic prompt"), /could not list its MCP servers/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { recursive: true, force: true });
  }
});
