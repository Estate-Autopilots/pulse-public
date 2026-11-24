// FIX-CHAT-AI: the token cuts (owner, 10 Nov 2026: "one simple request used about 113k tokens; cut this 20-100x").
import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutScreen, promptStats, screenDirect, simpleAsk } from "./thrift.mjs";
import { compactJson, fixNote, moreTools, pickTools, roundLimit, TASK_AREAS, taskWords, TOOL_ROUNDS, toolsPart } from "./pulse-tools.mjs";
import { claudeArgs, codexArgs, SYSTEM } from "./runtime.mjs";
import { tierRuntime } from "./engines.mjs";

const T = (name, description = `${name} does a thing.`) => ({ name, description, inputSchema: { properties: { query: {} }, required: [] } });
const TOOLS = ["search", "whoami", "create_quotation", "find_or_create_client", "search_catalogue", "list_quotations", "list_tasks", "create_task", "request_leave", "list_attendance",
  "run_on_server", "list_servers", "create_doc", "list_docs", "send_message", "screen_open_page", "screen_read", "screen_click", "screen_fill", "list_contracts"].map((n) => T(n));

test("a request shows only the tools of the areas it is about, and the others by name", () => {
  const q = pickTools(TOOLS, "make me a quotation for a new client");
  assert.ok(q.shown.some((t) => t.name === "create_quotation") && q.shown.some((t) => t.name === "find_or_create_client"));
  assert.ok(!q.shown.some((t) => t.name === "request_leave" || t.name === "run_on_server" || t.name.startsWith("screen_")));
  assert.ok(q.shown.some((t) => t.name === "search") && q.shown.some((t) => t.name === "whoami"), "search and whoami always");
  assert.ok(q.others.some((o) => o.area === "hr") && q.others.some((o) => o.area === "screen"));
  const s = pickTools(TOOLS, "remove the model-led video line");
  assert.ok(s.shown.some((t) => t.name === "screen_click") && s.shown.some((t) => t.name === "list_quotations"), "a screen ask about a quote line sees both");
  assert.equal(pickTools(TOOLS, "x".repeat(500)).shown.length, TOOLS.length, "a long ask naming no area keeps every tool");
  const part = toolsPart(TOOLS, { name: "Accounts", text: "make me a quotation" }), all = toolsPart(TOOLS, { name: "Accounts" });
  assert.ok(part.length < all.length && /more_tools/.test(part) && !/request_leave/.test(part));
  assert.ok(!/run_on_server \(server by name/.test(part), "the server paragraph only with server tools");
  assert.match(moreTools(TOOLS, "hr"), /request_leave/);
});

test("WL-QUOTE-LIVE: a quotation asked in Hindi or Marathi, typed or as a voice note's transcript, shows the quotation tools", () => {
  for (const ask of ["नए क्लाइंट शर्मा ट्रेडर्स के लिए कोटेशन बनाओ: एक 5 kW सोलर सिस्टम", "पाटील ट्रेडर्स यांच्यासाठी दरपत्रक करा", "kotation bana do Desai Dairy ke liye",
    "🎙 Voice note, transcribed on our server: देसाई डेअरी साठी एक बारा किलोवॅट सिस्टमचे कोटेशन करा"]) {
    const names = pickTools(TOOLS, ask).shown.map((t) => t.name);
    assert.ok(names.includes("create_quotation") && names.includes("find_or_create_client") && names.includes("search_catalogue"), ask);
  }
});

test("tool answers lose their padding (nulls, empty strings and lists inside), never their facts", () => {
  assert.equal(compactJson('{"a": 1, "e": {"f": null, "g": "x", "h": []}, "l": [{"x": null, "y": 2}]}'), '{"a":1,"e":{"g":"x"},"l":[{"y":2}]}');
  // BUG-SWEEP-3 (Agent Lab #2): an empty page stays an empty page, not {} (its own fields are the answer).
  assert.equal(compactJson('{"items": [], "nextCursor": null}'), '{"items":[],"nextCursor":null}');
  assert.equal(compactJson('{"a": 1, "b": null, "c": "", "d": []}'), '{"a":1,"b":null,"c":"","d":[]}');
  assert.equal(compactJson("plain words"), "plain words");
  assert.equal(compactJson("{broken"), "{broken");
});

test("Claude Code runs with a short system prompt (its own costs ~3,600 tokens a call); a web task keeps its own", () => {
  const a = claudeArgs("sonnet", "low");
  assert.equal(a[a.indexOf("--system-prompt") + 1], SYSTEM);
  assert.ok(SYSTEM.length < 400);
  assert.ok(!claudeArgs("sonnet", "low", true).includes("--system-prompt"));
});

test("BHARATA-3: Codex here runs with the short instructions from a file and its own tools off (14,219 → 4,072 tokens a call)", () => {
  const a = codexArgs("gpt-5", "low", "/tmp/x/instructions.md");
  assert.deepEqual(a.slice(0, 6), ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only"]);
  assert.ok(a.includes('model_instructions_file="/tmp/x/instructions.md"') && a.includes('web_search="disabled"') && a.includes("include_environment_context=false"));
  for (const f of ["shell_tool", "unified_exec", "browser_use", "computer_use", "image_generation", "multi_agent", "plugins", "hooks"]) assert.equal(a[a.indexOf(f) - 1], "--disable", f);
  assert.ok(a.includes('model_reasoning_effort="low"') && a.includes("gpt-5"));
  const plain = codexArgs("gpt-5", "low");
  assert.ok(!plain.includes("--disable") && !plain.some((x) => /model_instructions_file/.test(x)), "no file (a company workspace's own Codex): as it was");
  process.env.PULSE_CODEX_LEAN = "0";
  try { assert.ok(!codexArgs(null, null, "/tmp/x/instructions.md").includes("--disable")); } finally { delete process.env.PULSE_CODEX_LEAN; }
});

test("BHARATA-3: a task run shows the tools its own words are about, with the tasks tools; the others stay one more_tools away", () => {
  const TT = [...TOOLS, T("comment_on_task"), T("update_task")];
  const ctx = { task: { title: "Send Desai Dairy the 12 kW quotation PDF", notes: "They asked on the phone." }, thread: [{ body: "Use the approved one" }] };
  assert.match(taskWords(ctx), /Desai Dairy[\s\S]*phone[\s\S]*approved one/);
  const part = toolsPart(TT, { name: "Bharata", text: taskWords(ctx), also: TASK_AREAS }), all = toolsPart(TT, { name: "Bharata" });
  for (const n of ["list_quotations", "comment_on_task", "update_task", "list_tasks"]) assert.match(part, new RegExp(`\\b${n}\\b`), n);
  assert.ok(!/request_leave|run_on_server \(/.test(part) && /more_tools/.test(part) && part.length < all.length * 0.75, "hr and servers by name only");
  const vague = toolsPart(TT, { name: "Bharata", text: taskWords({ task: { title: "x ".repeat(300) } }), also: TASK_AREAS });
  assert.ok(vague.includes("request_leave"), "a long task naming no area keeps every tool");
  assert.equal(taskWords({}), "");
});

test("simple asks run on the smallest model; questions about money or work do not", () => {
  for (const t of ["hi", "Thanks!", "ok 👍", "open finance", "close the sidebar"]) assert.equal(simpleAsk(t), true, t);
  for (const t of ["make me a quotation", "open the quotation and change the price", "what is pending for approval?", "remove the model-led video line"]) assert.equal(simpleAsk(t), false, t);
  assert.equal(simpleAsk("hi", { kind: "client.silent" }), false);
  const claude = { id: "server:claude", kind: "server", provider: "claude" };
  assert.equal(tierRuntime(claude, {}, "small").model, "haiku");
  assert.equal(tierRuntime(claude, {}, "fast").model, "sonnet");
});

test("plain screen requests are done without a model; anything with a record in it is not", () => {
  assert.deepEqual(screenDirect("open finance")?.args, { path: "/finance" });
  assert.deepEqual(screenDirect("Show me billing.")?.args, { path: "/erp" });
  assert.deepEqual(screenDirect("close the sidebar")?.args, { open: false });
  assert.equal(screenDirect("open the quotation for Lotus Interiors"), null);
  assert.equal(screenDirect("remove the model-led video line"), null);
  assert.equal(screenDirect("open quotation 1042"), null);
  assert.equal(aboutScreen("remove the model-led video line"), true);
  assert.equal(aboutScreen("fill the client's phone number"), true);
  assert.equal(aboutScreen("what did we quote Lotus last month?"), false);
});

test("each model call logs its size and biggest parts, never their words", () => {
  const s = promptStats([{ key: "tools", text: "x".repeat(4000) }, { key: "recent", text: "secret words" }], { tokens: 1003, trimmed: [] }, { provider: "claude", model: "haiku" });
  assert.match(s, /~1003 tokens \(claude\/haiku; biggest: tools 1000, recent 3\)/);
  assert.ok(!s.includes("secret"));
});

test("the stable parts (who it is, its rules and tools) are the cached system prompt; the conversation and results are not", async () => {
  const { cached } = await import("./runner.mjs");
  const { fitPrompt } = await import("./budget.mjs");
  const fit = fitPrompt([{ key: "h0", text: "You are X." }, { key: "h2", text: "Rules." }, { key: "recent", text: "Asha: hi", drop: 1 }, { key: "tools", text: "Tools: a, b" }, { key: "tools0", text: "Tool results" }], 10000);
  const [prompt, opts] = cached(fit);
  assert.equal(opts.system, "You are X.\n\nRules.\n\nTools: a, b");
  assert.equal(prompt, "Asha: hi\n\nTool results");
  assert.deepEqual(cached(fitPrompt([{ key: "recent", text: "only this" }], 1000)), ["only this", {}], "nothing stable: the prompt as it was");
  const a = claudeArgs("sonnet", "low", false, "/tmp/x/system.txt");
  assert.equal(a[a.indexOf("--system-prompt-file") + 1], "/tmp/x/system.txt");
});

test("WL-QUOTE-LIVE: a run gets one more tool round only after Pulse refused a call", () => {
  assert.equal(roundLimit(false), TOOL_ROUNDS);
  assert.equal(roundLimit(true), TOOL_ROUNDS + 1);
  assert.match(fixNote(1), /^Pulse refused one of those calls/);
  assert.match(fixNote(2), /refused 2 of those calls.*Send those calls again now/);
});

test("DOCS-EDITOR-8: \"how do I …\" that a walkthrough answers is shown on their screen (no model call); one it does not answer goes to the model", () => {
  const task = screenDirect("How do I add a task?");
  assert.equal(task?.tool, "screen_show_me_how");
  assert.deepEqual(task.args, { question: "How do I add a task", tutorial: "tasks-basics" });
  assert.match(task.say, /show you on the page/);
  assert.equal(screenDirect("how do i add a bank statement")?.args.tutorial, "add-a-bank-statement");
  assert.equal(screenDirect("show me how to record an expense")?.args.tutorial, "add-an-expense");
  assert.equal(screenDirect("Where do I apply for leave?")?.args.tutorial, "apply-for-leave");
  assert.equal(screenDirect("how do I bake a cake"), null, "no walkthrough: the model explains");
  assert.equal(screenDirect("show me how to fly"), null, "never opens a page for a how-question");
  assert.equal(screenDirect("open finance")?.tool, "screen_open_page", "plain opens still open");
});
