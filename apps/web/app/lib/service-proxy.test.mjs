// EST-1715: signed out, the public service boundary answers 401 before any shape or method refusal, as the API does
// (EST-1521); a psvc_ key outside the contract stays a 403 scope refusal, and neither refusal reaches the API.
import assert from "node:assert/strict";
import test from "node:test";
import { serviceProxy } from "./service-proxy.mjs";

const KEY = "Bearer psvc_00000000-0000-4000-8000-000000000000_" + "a".repeat(43);
const CHAT = "11111111-2222-4333-8444-555555555555";
const context = (path) => ({ params: Promise.resolve({ path }) });
// `body: null` sends no body; `query` is the search string, outside the route's path parameter.
const call = (path, { method = "POST", headers = {}, body = method === "POST" ? "{}" : undefined, query = "" } = {}) =>
  serviceProxy(new Request("http://web.test/api/v1/service/" + path.join("/") + query, { method, headers, body }), context(path));
const capture = (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { seen.push({ url, init });
    return new Response('{"error":"Invalid service credential"}', { status: 401, headers: { "content-type": "application/json" } }); });
  return seen;
};

test("signed out, a path or method outside the contract answers 401 and never reaches the API", async (t) => {
  const seen = capture(t);
  for (const headers of [{}, { cookie: "pulse_session=staff-session" }, { authorization: "Bearer " + "x".repeat(43) }]) {
    for (const [path, method] of [[["chats", ":chatId", "messages"], "POST"], [["chats", "abc", "messages"], "POST"],
                                  [["nonexistent"], "POST"], [["quotes"], "GET"], [["updates"], "GET"], [["clients"], "POST"], [["chats", CHAT, "messages"], "PUT"]]) {
      const response = await call(path, { method, headers });
      assert.equal(response.status, 401, `${method} ${path.join("/")} ${JSON.stringify(headers)}`);
      assert.deepEqual(await response.json(), { error: "Invalid service credential" });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
  assert.equal(seen.length, 0);
});

test("a service key outside the contract keeps the 403 scope refusal and never reaches the API", async (t) => {
  const seen = capture(t);
  for (const [path, method] of [[["chats", ":chatId", "messages"], "POST"], [["nonexistent"], "POST"], [["quotes"], "GET"], [["updates"], "GET"], [["clients"], "POST"]]) {
    const response = await call(path, { method, headers: { authorization: KEY } });
    assert.equal(response.status, 403, `${method} ${path.join("/")}`);
    assert.deepEqual(await response.json(), { error: "Service key scope excludes this endpoint" });
  }
  assert.equal(seen.length, 0);
});

// EST-1912: the release smoke POSTs `{}` to every route signed out; ready-notice answered its no-body 400 here.
test("signed out, a contract operation answers 401 before any query or body refusal and never reaches the API", async (t) => {
  const seen = capture(t);
  for (const headers of [{}, { cookie: "pulse_session=staff-session" }, { authorization: "Bearer " + "x".repeat(43) }]) {
    for (const [path, options] of [[["quotes", CHAT, "ready-notice"], {}], [["quotes", CHAT, "ready-notice"], { body: null }],
                                   [["quotes"], { body: "a".repeat(64 * 1024 + 1) }], [["chats", CHAT, "messages"], {}],
                                   [["clients"], { method: "GET", query: "?org=other" }], [["leads"], { method: "GET", query: "?phone=1&phone=2" }]]) {
      const response = await call(path, { ...options, headers });
      assert.equal(response.status, 401, `${path.join("/")} ${JSON.stringify(options).slice(0, 60)} ${JSON.stringify(headers)}`);
      assert.deepEqual(await response.json(), { error: "Invalid service credential" });
    }
  }
  assert.equal(seen.length, 0);
});

test("a service key keeps the ready-notice body refusal and the query refusals", async (t) => {
  const seen = capture(t);
  const headers = { authorization: KEY, "content-type": "application/json" };
  const notice = await call(["quotes", CHAT, "ready-notice"], { headers });
  assert.equal(notice.status, 400);
  assert.deepEqual(await notice.json(), { error: "No request body allowed" });
  for (const [path, query] of [[["clients"], "?org=other"], [["leads"], "?phone=1&phone=2"]])
    assert.equal((await call(path, { method: "GET", headers, query })).status, 400, path[0] + query);
  assert.equal(seen.length, 0);
});

test("contract operations still go to the API, without a person's session", async (t) => {
  const seen = capture(t);
  for (const [path, method, body] of [[["chats", CHAT, "messages"], "POST"], [["quotes"], "POST"], [["clients"], "GET"], [["leads"], "GET"],
                                      [["quotes", CHAT, "ready-notice"], "POST", null], [["updates"], "POST"]]) {
    const response = await call(path, { method, body, headers: { authorization: KEY, cookie: "pulse_session=staff-session", "content-type": "application/json" } });
    assert.equal(response.status, 401);
  }
  assert.equal(seen.length, 6);
  for (const { init } of seen) {
    assert.equal(init.headers.get("cookie"), null);
    assert.equal(init.headers.get("authorization"), KEY);
  }
  assert.match(seen[0].url, new RegExp(`/api/v1/service/chats/${CHAT}/messages$`));
  assert.match(seen[4].url, new RegExp(`/api/v1/service/quotes/${CHAT}/ready-notice$`));
});
