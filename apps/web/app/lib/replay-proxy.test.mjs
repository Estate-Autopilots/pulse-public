// DITASU-FIX (17 Nov 2026): the leadership replay player fetches each chunk through the web proxy as gzip bytes. The
// proxy read every unknown answer as text, which corrupted them, so no replay could ever play. Bytes pass unchanged now.
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { createApiProxy, replayChunk, v0ProxyOptions } from "../api/proxy.mjs";

const events = [{ type: 4, timestamp: 1, data: { width: 1280, height: 720 } }, { type: 2, timestamp: 2, data: { node: { type: 0, id: 1, childNodes: [] } } }];
const gz = gzipSync(Buffer.from(JSON.stringify(events)));
const context = (path) => ({ params: Promise.resolve({ path }) });
const get = (path) => createApiProxy({ ...v0ProxyOptions, fetchImpl: async () => new Response(gz, { status: 200, headers: { "content-type": "application/gzip" } }), hostLookup: async () => ({ signIn: "access" }) })(
  new Request(`http://web.test/api/v0/${path.join("/")}`, { headers: { host: "web.test", "cf-access-authenticated-user-email": "synthetic@example.test" } }), context(path));

test("a replay chunk reaches the player byte for byte, as gzip, sandboxed and never cached", async () => {
  const r = await get(["telemetry", "replay", "sessSYNTH0001", "0"]);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/gzip");
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("content-security-policy"), "sandbox");
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(bytes, gz, "unchanged");
  assert.deepEqual(JSON.parse(gunzipSync(bytes).toString("utf8")), events);
});

test("only the chunk address takes the binary path", () => {
  assert.equal(replayChunk(["telemetry", "replay", "sessSYNTH0001", "12"]), true);
  for (const p of [["telemetry", "replay", "sessSYNTH0001"], ["telemetry", "replays"], ["telemetry", "replay", "bad id!", "0"], ["telemetry", "replay", "sessSYNTH0001", "x"]])
    assert.equal(replayChunk(p), false, p.join("/"));
});
