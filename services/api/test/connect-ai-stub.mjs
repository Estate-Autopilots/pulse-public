#!/usr/bin/env node
// CONNECT-AI: a local OpenAI-compatible model for tests (no real provider, no cost). GET /v1/models and
// POST /v1/chat/completions with "Authorization: Bearer <STUB_KEY>"; anything else is refused like a provider would
// (401 for a wrong key). Its answers fit the AI employee runtime's JSON (reply, propose, task report).
//   STUB_KEY=pulse-stub-key-0001 PORT=3299 node services/api/test/connect-ai-stub.mjs
import { createServer } from "node:http";

const KEY = process.env.STUB_KEY ?? "pulse-stub-key-0001", PORT = Number(process.env.PORT ?? 3299);
let calls = 0;
const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
function answer(prompt) {
  const said = prompt.match(/The message to act on, from ([^:]+): (.+)$/m), task = prompt.match(/^Task: (.+)$/m)?.[1];
  if (/connection test from Pulse/.test(prompt)) return "OK";
  if (said && /"action"/.test(prompt)) return JSON.stringify({ action: /\bAsk first\b/.test(prompt) ? "propose" : "reply", message: `Hi ${said[1].split(" ")[0]}, thanks, noted. I'll come back to you today. (local OpenAI-compatible stub)`, why: "A short acknowledgement keeps them informed." });
  if (task) return JSON.stringify({ status: "done", report: `Done: ${task}. (local OpenAI-compatible stub)`, remember: [] });
  const who = prompt.match(/Reply now to the latest message from ([^.]+)\./)?.[1] ?? "there";
  return JSON.stringify({ reply: `Hi ${who.split(" ")[0]}, this answer came through the organisation's own API connection (local OpenAI-compatible stub).` });
}
createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } });
  if (req.method === "GET" && req.url === "/v1/models") return send(res, 200, { object: "list", data: [{ id: "stub-small", object: "model" }, { id: "stub-large", object: "model" }] });
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = ""; req.on("data", (d) => { raw += d; if (raw.length > 2e6) req.destroy(); });
    req.on("end", () => {
      let b; try { b = JSON.parse(raw); } catch { return send(res, 400, { error: { message: "bad JSON" } }); }
      if (!["stub-small", "stub-large"].includes(b.model)) return send(res, 404, { error: { message: `model ${b.model} not found` } });
      const prompt = (b.messages ?? []).map((m) => m.content).join("\n"), text = answer(prompt); calls++;
      const p = Math.ceil(prompt.length / 4), c = Math.ceil(text.length / 4);
      console.log(new Date().toISOString(), "call", calls, b.model, `${p}+${c} tokens`);
      send(res, 200, { id: `stub-${calls}`, object: "chat.completion", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });
    });
    return;
  }
  send(res, 404, { error: { message: "not found" } });
}).listen(PORT, "127.0.0.1", () => console.log(`OpenAI-compatible stub on http://127.0.0.1:${PORT}/v1`));
