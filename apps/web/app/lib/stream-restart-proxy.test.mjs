// ERROR-SWEEP (17 Nov 2026): the live streams (Calls, Chats, screen control) survive the API restarting.
// Production telemetry: "error.stream SSE /api/v0/calls/events" 741 times in 7 days (26 people, 6 companies), half within
// 4 minutes of a release. The API restarting answered 502/503 (or nothing), the proxy gave that as JSON, and a browser's
// EventSource closes for good on any answer that is not a stream. Now it is told to reconnect in 3 s, by itself.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiProxy, liveStream, v0ProxyOptions } from "../api/proxy.mjs";

const context = (path) => ({ params: Promise.resolve({ path }) });
const get = (path, fetchImpl) => createApiProxy({ ...v0ProxyOptions, fetchImpl, hostLookup: async () => ({ signIn: "access" }) })(
  new Request(`http://web.test/api/v0/${path.join("/")}`, { headers: { host: "web.test", accept: "text/event-stream", "cf-access-authenticated-user-email": "synthetic@example.test" } }), context(path));
const answer = (status, body = '{"error":"restarting"}', type = "application/json") => async () => new Response(body, { status, headers: { "content-type": type } });

for (const stream of [["calls", "events"], ["chats", "events"], ["screen", "events"]]) {
  for (const status of [502, 503, 504]) {
    test(`${stream.join("/")}: the API answering ${status} (restarting) is a stream that reconnects in 3 s`, async () => {
      const r = await get(stream, answer(status));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "text/event-stream");
      assert.equal(r.headers.get("cache-control"), "private, no-store");
      assert.match(await r.text(), /^retry: 3000\n/);
    });
  }
  test(`${stream.join("/")}: the API not answering at all is a stream that reconnects too`, async () => {
    const r = await get(stream, async () => { throw new TypeError("fetch failed"); });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    assert.match(await r.text(), /^retry: 3000\n/);
  });
}

test("signed out, refused or unknown stays what it is (the page must stop, not retry)", async () => {
  for (const status of [401, 403, 404]) {
    const r = await get(["calls", "events"], answer(status, '{"error":"no"}'));
    assert.equal(r.status, status);
    assert.notEqual(r.headers.get("content-type"), "text/event-stream");
  }
});

test("a live stream still streams, and other reads keep their 503", async () => {
  const live = await get(["calls", "events"], answer(200, "event: ping\ndata: {}\n\n", "text/event-stream"));
  assert.equal(live.status, 200);
  assert.equal(await live.text(), "event: ping\ndata: {}\n\n");
  const read = await get(["calls"], answer(503));
  assert.equal(read.status, 503);
  const down = await get(["tasks", "reviews", "count"], async () => { throw new TypeError("fetch failed"); });
  assert.equal(down.status, 503);
});

test("only the three live streams are treated as streams", () => {
  for (const p of [["calls", "events"], ["chats", "events"], ["screen", "events"]]) assert.equal(liveStream(p), true, p.join("/"));
  for (const p of [["calls"], ["calls", "events", "next"], ["events"], ["chats"]]) assert.equal(liveStream(p), false, p.join("/"));
});

// ERROR-SWEEP: a read asks the API once more when it did not answer at all (a restart); a write never does.
const retrying = (fetchImpl, method = "GET", path = ["tasks", "reviews", "count"]) => createApiProxy({ ...v0ProxyOptions, fetchImpl, retryMs: 1, hostLookup: async () => ({ signIn: "access" }) })(
  new Request(`http://web.test/api/v0/${path.join("/")}`, { method, headers: { host: "web.test", origin: "http://web.test", "sec-fetch-site": "same-origin", "content-type": "application/json", "cf-access-authenticated-user-email": "synthetic@example.test" }, ...(method === "GET" ? {} : { body: "{}" }) }), context(path));
const flaky = (fails) => { let n = 0; const f = async () => { n++; if (n <= fails) throw new TypeError("fetch failed"); return new Response('{"count":3}', { status: 200, headers: { "content-type": "application/json" } }); }; f.calls = () => n; return f; };

test("a read the restarting API missed once is asked again and answers", async () => {
  const f = flaky(1);
  const r = await retrying(f);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { count: 3 });
  assert.equal(f.calls(), 2);
});

test("a read missed twice is a 503, asked only twice", async () => {
  const f = flaky(5);
  assert.equal((await retrying(f)).status, 503);
  assert.equal(f.calls(), 2);
});

test("a write is never sent twice", async () => {
  const f = flaky(1);
  assert.equal((await retrying(f, "POST", ["tasks", "x", "move"])).status, 503);
  assert.equal(f.calls(), 1);
});

test("a read that timed out is not asked again", async () => {
  let n = 0;
  const f = async () => { n++; const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  assert.equal((await retrying(f)).status, 503);
  assert.equal(n, 1);
});

// FIX-BILLING (BC-036): a connection the restarting API refused never reached it, so even a save is sent again.
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8081"), { code: "ECONNREFUSED" }) });
const refusing = (fails) => { let n = 0; const f = async () => { n++; if (n <= fails) throw refused(); return new Response('{"id":"synthetic"}', { status: 200, headers: { "content-type": "application/json" } }); }; f.calls = () => n; return f; };

test("a save the restarting API refused is sent again and saves", async () => {
  const f = refusing(2);
  const r = await retrying(f, "POST", ["erp", "documents", "00000000-0000-4000-8000-000000000001"]);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: "synthetic" });
  assert.equal(f.calls(), 3);
});

test("a save refused four times is a 503, sent four times at most", async () => {
  const f = refusing(9);
  assert.equal((await retrying(f, "POST", ["erp", "items", "00000000-0000-4000-8000-000000000002"])).status, 503);
  assert.equal(f.calls(), 4);
});

test("a refused read is asked up to three more times too", async () => {
  const f = refusing(3);
  assert.equal((await retrying(f)).status, 200);
  assert.equal(f.calls(), 4);
});

test("a write whose connection broke after it went out is still never sent twice", async () => {
  let n = 0;
  const f = async () => { n++; throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }); };
  assert.equal((await retrying(f, "POST", ["erp", "documents", "00000000-0000-4000-8000-000000000003"])).status, 503);
  assert.equal(n, 1);
});
