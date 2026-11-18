// AI-CONNECT: Settings → Connect your AI. Every app card: one thing to copy, three steps, a picture per step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aiApps, installLinks } from "./connect-ai-apps.mjs";

const url = "https://app.vitalsos.ai/mcp";
test("the six apps the owner asked for, each way with one copy and three steps with pictures", () => {
  const apps = aiApps({ url, brand: "Vitals" });
  assert.deepEqual(apps.map((a) => a.key), ["claude", "chatgpt", "gemini", "editor", "any", "key"]);
  for (const a of apps) for (const w of a.ways) {
    assert.equal(w.steps.length, 3, `${a.key}/${w.key} steps`);
    assert.equal(w.shots.length, 3, `${a.key}/${w.key} pictures`);
    assert.ok(w.copy.label, `${a.key}/${w.key} copy label`);
    for (const s of w.steps) { assert.ok(s.length <= 200, `${a.key}/${w.key}: ${s}`); assert.doesNotMatch(s, /Pulse/); }
  }
  // Signing in, not pasted secrets: every app but the API key card copies the address or a command without a key.
  for (const a of apps.filter((x) => x.signIn)) for (const w of a.ways) { assert.match(w.copy.text, /app\.vitalsos\.ai\/mcp/); assert.doesNotMatch(w.copy.text, /Bearer/); }
  const claude = apps[0];
  assert.equal(claude.ways[0].copy.text, url);
  assert.equal(claude.ways[1].copy.text, "claude mcp add --transport http vitals https://app.vitalsos.ai/mcp");
  assert.match(apps[1].ways[0].steps.join(" "), /Developer mode/);
  assert.match(apps[1].ways[0].steps.join(" "), /OAuth/);
  assert.equal(apps[2].ways[0].copy.text, "gemini mcp add --transport http vitals https://app.vitalsos.ai/mcp");
});
test("the API key card copies nothing until a key is made, then the key", () => {
  assert.equal(aiApps({ url, brand: "Vitals" }).at(-1).ways[0].copy.text, "");
  const made = aiApps({ url, brand: "Vitals", key: "ppt_synthetic" }).at(-1).ways[0];
  assert.equal(made.copy.text, "ppt_synthetic");
  assert.match(made.note, /--header "Authorization: Bearer ppt_synthetic"/);
});
test("Pulse addresses say Pulse", () => {
  const apps = aiApps({ url: "https://pulse.example.test/mcp", brand: "Pulse" });
  assert.equal(apps[0].ways[1].copy.text, "claude mcp add --transport http pulse https://pulse.example.test/mcp");
  assert.match(apps[0].ways[0].steps[1], /Name it Pulse/);
});
test("one-click installs for Cursor and VS Code carry only the address", () => {
  const l = installLinks(url, "vitals");
  const cfg = JSON.parse(Buffer.from(decodeURIComponent(new URL(l.cursor).searchParams.get("config")), "base64").toString());
  assert.deepEqual(cfg, { url });
  assert.ok(l.cursor.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=vitals&config="));
  assert.deepEqual(JSON.parse(decodeURIComponent(l.vscode.slice("vscode:mcp/install?".length))), { name: "vitals", type: "http", url });
});
