import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createApiProxy, v0ProxyOptions, v1BearerProxy, v1FlowProxyOptions, v1ProxyOptions } from "../api/proxy.mjs";
import * as v0Route from "../api/v0/[...path]/route.ts";
import { inboundHeaders } from "./host-mode.mjs";
import * as v1Route from "../api/v1/[...path]/route.ts";

const context = (path) => ({ params: Promise.resolve({ path }) });
const withEnv = async (entries, fn) => {
  const previous = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]));
  Object.assign(process.env, entries);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("v1 bearer proxy-generated failures carry matching Problem and header request ids", async () => {
  for (const [path, headers, status] of [[['tasks'], {}, 401], [['%2f'], {}, 404],
    [['tasks'], { authorization: 'Bearer synthetic-api-key' }, 503]]) {
    const r = await v1BearerProxy(new Request('https://web.test/api/v1/tasks', { headers }), context(path),
      async () => { throw new Error('Synthetic data service unavailable'); });
    const body = await r.json();
    assert.equal(r.status, status); assert.equal(body.status, status);
    assert.deepEqual(Object.keys(body).sort(), ['detail', 'requestId', 'status', 'title', 'type']);
    assert.equal(body.requestId, r.headers.get('x-request-id')); assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(body.type, 'about:blank'); assert.equal(r.headers.get('content-type'), 'application/problem+json');
    assert.match(r.headers.get('cache-control'), /no-store/);
  }
});

test("v1 GET without a verified identity returns 401 JSON without calling upstream", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    let called = false;
    const proxy = createApiProxy({ ...v1ProxyOptions, fetchImpl: async () => { called = true; throw new Error("unexpected fetch"); } });
    const response = await proxy(new Request("http://web.test/api/v1/editors/person-1/week"), context(["editors", "person-1", "week"]));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Sign in through your organisation's Access" });
    assert.equal(called, false);
  });
});

test("the Next v1 route exports GET and POST and delegates anonymous requests to the shared guard", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    assert.equal(typeof v1Route.GET, "function");
    assert.equal(typeof v1Route.POST, "function");
    const response = await v1Route.GET(new Request("http://web.test/api/v1/editors/person-1/week"), context(["editors", "person-1", "week"]));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Sign in through your organisation's Access" });
    const post = await v1Route.POST(new Request("http://web.test/api/v1/deliveries/file-1/claim", {
      method: "POST", headers: { origin: "http://web.test", host: "web.test" }, body: "{}",
    }), context(["deliveries", "file-1", "claim"]));
    assert.equal(post.status, 401);
  });
});

test("v1 session identity forwards only verified identity to /v1 with the query string", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    let captured;
    const proxy = createApiProxy({ ...v1ProxyOptions, fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ week: "synthetic" }), { status: 206 });
    } });
    const request = new Request("http://web.test/api/v1/editors/person-1/week?from=2026-W40&to=2026-W41", {
      headers: {
        cookie: "pulse_session=synthetic-session",
        authorization: "Bearer client-supplied",
        "x-pulse-session": "spoofed-session",
        "x-forwarded-for": "192.0.2.1, 192.0.2.2",
      },
    });
    const response = await proxy(request, context(["editors", "person-1", "week"]));

    assert.equal(captured.url, "http://127.0.0.1:8081/v1/editors/person-1/week?from=2026-W40&to=2026-W41");
    assert.equal(captured.options.method, "GET");
    assert.equal(captured.options.headers["x-pulse-session"], "synthetic-session");
    assert.equal(captured.options.headers.authorization, undefined);
    assert.equal(captured.options.headers["x-forwarded-for"], undefined);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { week: "synthetic" });
  });
});

test("v1 allows only same-origin claim POSTs and forwards verified identity and JSON", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "0", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    const calls = [];
    const proxy = createApiProxy({ ...v1ProxyOptions, fetchImpl: async (_url, options) => {
      calls.push(options);
      return Response.json({ ok: true });
    } });
    const response = await proxy(new Request("http://web.test/api/v1/deliveries/file-2/claim", {
      method: "POST",
      headers: {
        "cf-access-authenticated-user-email": "synthetic@example.test",
        "cf-access-jwt-assertion": "synthetic-jwt-assertion",
        "x-pulse-access-id": "spoofed-hash",
        origin: "http://web.test",
        host: "web.test",
      },
      body: "{}",
    }), context(["deliveries", "file-2", "claim"]));
    assert.equal(response.status, 200);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, "{}");
    assert.equal(calls[0].headers["cf-access-authenticated-user-email"], "synthetic@example.test");
    assert.equal(calls[0].headers["x-pulse-access-id"], createHash("sha256").update("synthetic-jwt-assertion").digest("hex"));

    const designClaim = await proxy(new Request("http://web.test/api/v1/designs/design-2/claim", {
      method: "POST",
      headers: { "cf-access-authenticated-user-email": "synthetic@example.test", origin: "http://web.test", host: "web.test" },
      body: "{}",
    }), context(["designs", "design-2", "claim"]));
    assert.equal(designClaim.status, 200);
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].body, "{}");
    assert.equal(calls[1].headers["cf-access-authenticated-user-email"], "synthetic@example.test");

    const crossOrigin = await proxy(new Request("http://web.test/api/v1/deliveries/file-2/claim", {
      method: "POST",
      headers: { "cf-access-authenticated-user-email": "synthetic@example.test", origin: "http://evil.test", host: "web.test" },
      body: "{}",
    }), context(["deliveries", "file-2", "claim"]));
    assert.equal(crossOrigin.status, 403);

    const unsupported = await proxy(new Request("http://web.test/api/v1/editors/person-2/week", {
      method: "POST",
      headers: { "cf-access-authenticated-user-email": "synthetic@example.test", origin: "http://web.test", host: "web.test" },
      body: "{}",
    }), context(["editors", "person-2", "week"]));
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "GET");
    assert.equal(calls.length, 2);
  });
});

test("v0 retains its /api/v0 target, session header, and POST handler configuration", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    let captured;
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    } });
    const response = await proxy(new Request("http://web.test/api/v0/me?scope=self", { headers: { cookie: "pulse_session=synthetic-v0" } }), context(["me"]));

    assert.equal(captured.url, "http://127.0.0.1:8081/api/v0/me?scope=self");
    assert.equal(captured.options.headers["x-pulse-session"], "synthetic-v0");
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true });

    const post = await proxy(new Request("http://web.test/api/v0/records?scope=self", {
      method: "POST",
      headers: { cookie: "pulse_session=synthetic-v0", origin: "http://web.test", host: "web.test" },
      body: JSON.stringify({ note: "synthetic" }),
    }), context(["records"]));
    assert.equal(captured.url, "http://127.0.0.1:8081/api/v0/records?scope=self");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.body, JSON.stringify({ note: "synthetic" }));
    assert.equal(post.status, 202);
    assert.deepEqual(v0ProxyOptions.methods, ["GET", "POST", "PUT"]);
  });
});

test("v0 Google settings PUT forwards JSON and a fresh code through the password-host header boundary", async () => {
  await withEnv({ PULSE_PUBLIC_URL: "https://pulse.install.test", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    assert.equal(v0Route.PUT, v0Route.GET);
    assert.equal(v1Route.PUT, undefined);
    const path = ["admin", "sign-in", "google"], calls = [];
    const body = JSON.stringify({ enabled: true, allowed_domains: ["example.test"], password_enabled: true, trust_google_two_step: false });
    for (const own of [false, true]) {
      const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own }),
        fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ saved: true }); } });
      const headers = inboundHeaders(new Headers({ host: "web.test", origin: own ? "https://pulse.install.test" : "http://web.test", cookie: "pulse_session=synthetic-admin", "X-Pulse-Two-Step": "654321", "x-pulse-session": "spoofed", "x-pulse-host": "other.test" }), "/api/v0/admin/sign-in/google", true, "PUT");
      const response = await proxy(new Request("http://web.test/api/v0/admin/sign-in/google", { method: "PUT", headers, body }), context(path));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { saved: true });
      const call = calls.at(-1);
      assert.equal(call.url, "http://127.0.0.1:8081/api/v0/admin/sign-in/google");
      assert.equal(call.options.method, "PUT");
      assert.equal(call.options.body, body);
      assert.equal(call.options.headers["content-type"], "application/json");
      assert.equal(call.options.headers["x-pulse-two-step"], "654321");
      assert.equal(call.options.headers["x-pulse-session"], "synthetic-admin");
      assert.equal(call.options.headers["x-pulse-host"], "web.test");
      assert.equal(call.options.headers.cookie, undefined);
      assert.equal(response.headers.get("x-pulse-two-step"), null);
    }
    assert.equal(calls.length, 2);
  });
});

test("v0 Google settings PUT refuses invalid origins, missing staff identity and missing production origin config", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_PUBLIC_URL: "http://web.test", NODE_ENV: "production" }, async () => {
    let calls = 0;
    const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: true }), fetchImpl: async () => { calls++; return Response.json({}); } });
    const put = (origin, cookie = "pulse_session=synthetic-admin") => proxy(new Request("http://web.test/api/v0/admin/sign-in/google", { method: "PUT", headers: { host: "web.test", ...(origin === undefined ? {} : { origin }), cookie }, body: "{}" }), context(["admin", "sign-in", "google"]));
    for (const origin of [undefined, "https://foreign.test", "null", "invalid"]) assert.equal((await put(origin)).status, 403);
    assert.equal((await put("http://web.test", "")).status, 401);
    assert.equal((await put("http://web.test", "pulse_client_session=synthetic-client")).status, 403);
    delete process.env.PULSE_PUBLIC_URL;
    assert.equal((await put("http://web.test")).status, 503);
    assert.equal(calls, 0);
  });
});

test("PUT stays scoped to exact v0 Google settings and fresh codes never reach other requests", async () => {
  const calls = [], source = new Headers({ host: "web.test", origin: "http://web.test", cookie: "pulse_session=synthetic-admin", "x-pulse-two-step": "654321" });
  for (const options of [v0ProxyOptions, v1ProxyOptions]) {
    const proxy = createApiProxy({ ...options, hostLookup: async () => ({ signIn: "password", own: false }), fetchImpl: async (_url, options) => { calls.push(options); return Response.json({}); } });
    const request = (method, path) => proxy(new Request(`http://web.test${options.upstreamPrefix}${path.join("/")}`, { method, headers: source, ...(method === "GET" ? {} : { body: "{}" }) }), context(path));
    const paths = [["me"], ["agent", "me"], ["admin", "sign-in", "google", "extra"], ["admin", "sign-in", "%67oogle"], ["admin", "sign-in", "google"]];
    for (const path of paths.slice(0, options.legacyV0 ? -1 : undefined)) {
      const response = await request("PUT", path);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, POST");
    }
    assert.equal((await request("DELETE", ["admin", "sign-in", "google"])).status, 405);
    for (const [method, path] of [["GET", ["admin", "sign-in", "google"]], ["POST", ["deliveries", "synthetic", "claim"]]]) {
      const urlPath = `${options.legacyV0 ? "/api/v0/" : "/api/v1/"}${path.join("/")}`;
      assert.equal(inboundHeaders(source, urlPath, true, method).has("x-pulse-two-step"), false);
      assert.equal((await request(method, path)).status, 200);
    }
  }
  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(call.headers["x-pulse-two-step"], undefined);
});

// PEOPLE-CONTACTS: a one-time sign-in link HR sent is redeemed without a session, and its answer sets the staff cookie
// (the token itself never reaches the page).
test("v0 one-time sign-in link: open while signed out, sets the staff session cookie", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081", PULSE_PUBLIC_URL: "http://web.test" }, async () => {
    let captured;
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async (url, options) => { captured = { url, options }; return Response.json({ token: "synthetic-staff-token", maxAge: 43200, mustChange: false }); } });
    const post = { method: "POST", headers: { origin: "http://web.test", host: "web.test" }, body: JSON.stringify({ token: "x".repeat(43) }) };
    const redeemed = await proxy(new Request("http://web.test/api/v0/auth/link-sign-in", post), context(["auth", "link-sign-in"]));
    assert.equal(captured.url, "http://127.0.0.1:8081/api/v0/auth/link-sign-in");
    assert.equal(redeemed.status, 200);
    assert.match(redeemed.headers.get("set-cookie"), /^pulse_session=synthetic-staff-token; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200/);
    assert.equal((await redeemed.json()).token, undefined);
  });
});

// EST-1399: the attempt cookie goes up as a header; the API's redirect comes back with its attempt and session as cookies;
// an outage or a redirect anywhere but Google or a Pulse path lands on the normal sign-in page instead.
test("v0 Continue with Google: start and callback follow only Google or a Pulse path and set cookies from the API", async () => {
  for (const host of ["web.test", "hosted.example.test"]) await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: host === "web.test" ? "1" : "0", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    let answer, captured;
    const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: host === "web.test" }), fetchImpl: async (url, options) => { captured = { url, options }; if (answer instanceof Error) throw answer; return answer; } });
    const go = (step, query, cookie) => proxy(new Request(`https://${host}/api/v0/auth/google/${step}${query}`, { headers: { host, ...(cookie ? { cookie } : {}), "x-pulse-host": "forged.example.test" } }), context(["auth", "google", step]));
    const attempt = "a".repeat(43), token = "t".repeat(43);
    answer = new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?state=s", "x-pulse-oidc-set": attempt } });
    let response = await go("start", "?mode=silent&next=%2Fclients%2Fc-1");
    assert.equal(captured.url, "http://127.0.0.1:8081/api/v0/auth/google/start?mode=silent&next=%2Fclients%2Fc-1");
    assert.equal(captured.options.redirect, "manual");
    assert.equal(captured.options.headers["x-pulse-host"], host);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://accounts.google.com/o/oauth2/v2/auth?state=s");
    assert.equal(response.headers.get("set-cookie"), `pulse_oidc=${attempt}; Path=/api/v0/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);

    answer = new Response(null, { status: 302, headers: { location: "/clients/c-1", "x-pulse-session-token": token } });
    response = await go("callback", "?code=c&state=s", `pulse_oidc=${attempt}`);
    assert.equal(captured.options.headers["x-pulse-oidc"], attempt);
    assert.equal(response.headers.get("location"), "/clients/c-1");
    const cookies = response.headers.getSetCookie();
    assert.ok(cookies.includes(`pulse_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`));
    assert.ok(cookies.includes("pulse_oidc=; Path=/api/v0/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0"));
    assert.equal(response.headers.get("x-pulse-session-token"), null);

    for (const bad of [new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), new Response(null, { status: 302, headers: { location: "//evil.example" } }),
      new Response(null, { status: 302, headers: { location: "/\\evil.example" } }), Response.json({ error: "Not found" }, { status: 404 }), new Error("down")]) {
      answer = bad;
      response = await go("start", "?mode=signin&next=%2Ftasks%2Ft-1");
      assert.equal(response.headers.get("location"), "/login?next=%2Ftasks%2Ft-1&google=provider_error");
      assert.equal(response.headers.get("set-cookie"), null);
    }
    answer = new Error("down");
    assert.equal((await go("start", "?mode=link&next=%2Faccount")).headers.get("location"), "/account?google=provider_error");
  });
});

// EST-1399: Pulse 2-step after Google. The challenge travels only in its cookie; the page posts {code} alone.
test("v0 Google 2-step: callback challenge becomes a cookie, added only to a staff two-step without one, cleared on success", async () => {
  for (const host of ["web.test", "hosted.example.test"]) await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: host === "web.test" ? "1" : "0", PULSE_API_URL: "http://127.0.0.1:8081", PULSE_PUBLIC_URL: "https://web.test" }, async () => {
    let answer, captured;
    const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ signIn: "password", own: host === "web.test" }), fetchImpl: async (url, options) => { captured = { url, options }; if (answer instanceof Error) throw answer; return answer; } });
    const challenge = "c".repeat(43);
    answer = new Response(null, { status: 302, headers: { location: "/login?next=%2Ftasks%2Ft-1&google=two_step", "x-pulse-two-step-challenge": challenge } });
    let response = await proxy(new Request(`https://${host}/api/v0/auth/google/callback?code=c&state=s`, { headers: { host } }), context(["auth", "google", "callback"]));
    assert.equal(response.headers.get("location"), "/login?next=%2Ftasks%2Ft-1&google=two_step");
    assert.ok(response.headers.getSetCookie().includes(`pulse_two_step=${challenge}; Path=/api/v0/auth/two-step; HttpOnly; Secure; SameSite=Lax; Max-Age=300`));

    const post = (path, body, cookie) => proxy(new Request(`https://${host}/api/v0/${path.join("/")}`, { method: "POST", headers: { origin: `https://${host}`, host, cookie }, body: JSON.stringify(body) }), context(path));
    answer = Response.json({ error: "Wrong code" }, { status: 401 });
    await post(["auth", "two-step"], { code: "000000" }, `pulse_two_step=${challenge}`);
    assert.deepEqual(JSON.parse(captured.options.body), { code: "000000", challenge });
    answer = Response.json({ error: "Wrong code" }, { status: 401 });
    response = await post(["auth", "two-step"], { code: "000000" }, `pulse_two_step=${challenge}`);
    assert.equal(response.headers.getSetCookie().some((c) => c.startsWith("pulse_two_step=;")), false, "a wrong code keeps the challenge");
    await post(["auth", "two-step"], { code: "1", challenge: "from-password" }, `pulse_two_step=${challenge}`);
    assert.equal(JSON.parse(captured.options.body).challenge, "from-password");
    await post(["portal", "auth", "two-step"], { code: "1" }, `pulse_two_step=${challenge}`);
    assert.equal(JSON.parse(captured.options.body).challenge, undefined);
    answer = Response.json({ token: "t".repeat(43), maxAge: 43200 });
    response = await post(["auth", "two-step"], { code: "123456" }, `pulse_two_step=${challenge}`);
    assert.ok(response.headers.getSetCookie().includes("pulse_two_step=; Path=/api/v0/auth/two-step; HttpOnly; Secure; SameSite=Lax; Max-Age=0"));

    answer = new Error("down");
    response = await proxy(new Request(`https://${host}/api/v0/auth/google/callback?code=c&state=s`, { headers: { host, cookie: "pulse_session=s" } }), context(["auth", "google", "callback"]));
    assert.equal(response.headers.get("location"), "/account?google=provider_error");
  });
});

test("v0 exposes install branding to signed-out sign-in pages", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    let captured;
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async (url, options) => {
      captured = { url, options };
      return Response.json({ name: "Northwind Studio" });
    } });
    const response = await proxy(new Request("http://web.test/api/v0/auth/branding"), context(["auth", "branding"]));

    assert.equal(response.status, 200);
    assert.equal(captured.url, "http://127.0.0.1:8081/api/v0/auth/branding");
    assert.equal(captured.options.headers["x-pulse-session"], undefined);
    assert.deepEqual(await response.json(), { name: "Northwind Studio" });
  });
});

test("v0 client portal: client cookie forwards only on portal routes and sets or clears its own cookie", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081", PULSE_PUBLIC_URL: "http://web.test" }, async () => {
    let captured;
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async (url, options) => {
      captured = { url, options };
      return Response.json({ ok: true, token: "synthetic-client-token" });
    } });
    const client = { cookie: "pulse_client_session=synthetic-client; pulse_session=synthetic-staff" };

    const outside = await proxy(new Request("http://web.test/api/v0/me", { headers: client }), context(["me"]));
    assert.equal(outside.status, 403);
    assert.equal(captured, undefined);

    await proxy(new Request("http://web.test/api/v0/portal/projects", { headers: client }), context(["portal", "projects"]));
    assert.equal(captured.options.headers["x-pulse-client-session"], "synthetic-client");
    assert.equal(captured.options.headers["x-pulse-session"], undefined);

    const post = { method: "POST", headers: { origin: "http://web.test", host: "web.test" }, body: "{}" };
    const signIn = await proxy(new Request("http://web.test/api/v0/portal/auth/sign-in", post), context(["portal", "auth", "sign-in"]));
    assert.match(signIn.headers.get("set-cookie"), /^pulse_client_session=synthetic-client-token; Path=\/; HttpOnly; Secure/);
    assert.equal((await signIn.json()).token, undefined);

    const signOut = await proxy(new Request("http://web.test/api/v0/portal/auth/sign-out", { ...post, headers: { ...post.headers, ...client } }), context(["portal", "auth", "sign-out"]));
    assert.match(signOut.headers.get("set-cookie"), /^pulse_client_session=; .*Max-Age=0/);

    const anonymous = await proxy(new Request("http://web.test/api/v0/portal/projects"), context(["portal", "projects"]));
    assert.equal(anonymous.status, 401);
  });
});

test("v0 media routes pass range requests through and return only safe media headers", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    let captured;
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async (_url, options) => {
      captured = options;
      return new Response("bytes", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-4/10", "set-cookie": "leak=1" } });
    } });
    const response = await proxy(new Request("http://web.test/api/v0/portal/media/item-1", {
      headers: { cookie: "pulse_client_session=synthetic-client", range: "bytes=0-4" },
    }), context(["portal", "media", "item-1"]));
    assert.equal(captured.headers.range, "bytes=0-4");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-4/10");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.text(), "bytes");
  });
});

test("v0 chat files, group photos and e-mail attachments: raster images inline, everything else a sandboxed download", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "0", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    const reply = { type: "image/png", disposition: "inline; filename*=UTF-8''frame.png" };
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async () => new Response("bytes", { status: 200, headers: { "content-type": reply.type, ...(reply.disposition ? { "content-disposition": reply.disposition } : {}) } }) });
    const get = (path) => proxy(new Request(`http://web.test/api/v0/${path.join("/")}`, { headers: { "cf-access-authenticated-user-email": "person@example.com" } }), context(path));
    for (const path of [["chats", "files", "f1"], ["chats", "c1", "photo"], ["inbox", "attachment"]]) {
      const r = await get(path);
      assert.equal(r.headers.get("content-type"), "image/png", path.join("/"));
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("content-security-policy"), "sandbox");
      assert.equal(await r.text(), "bytes");
    }
    Object.assign(reply, { type: "text/html", disposition: "inline; filename*=UTF-8''page.html" });
    const html = await get(["chats", "files", "f2"]);
    assert.equal(html.headers.get("content-type"), "application/octet-stream");
    assert.match(html.headers.get("content-disposition"), /^attachment/);
    Object.assign(reply, { type: "image/svg+xml", disposition: "inline" });
    assert.equal((await get(["inbox", "attachment"])).headers.get("content-type"), "application/octet-stream");
  });
});

test("v0 file routes stream bytes unchanged: PDFs and raster images inline, anything else a sandboxed download", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "0", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    // Bytes no text decoding survives: a PDF header, a PNG signature and invalid UTF-8.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x00, 0xff]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xc3, 0x28, 0xfe]);
    const odd = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x80, 0x81, 0xfe, 0xff]);
    let reply;
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async () => new Response(reply.bytes, { status: reply.status ?? 200, headers: {
      "content-type": reply.type, ...(reply.disposition ? { "content-disposition": reply.disposition } : {}), "content-security-policy": "sandbox", "x-content-type-options": "nosniff", "cache-control": "private, no-store" } }) });
    const get = (path) => proxy(new Request(`http://web.test/api/v0/${path.join("/")}`, { headers: { "cf-access-authenticated-user-email": "person@example.com" } }), context(path));
    const bytes = async (r) => new Uint8Array(await r.arrayBuffer());

    reply = { bytes: pdf, type: "application/pdf", disposition: "inline; filename*=UTF-8''offer%20letter.pdf" };
    for (const path of [["tasks", "proof", "p1"], ["people", "files", "f1"], ["onboarding", "documents", "d1", "file"]]) {
      const r = await get(path);
      assert.equal(r.status, 200, path.join("/"));
      assert.equal(r.headers.get("content-type"), "application/pdf", path.join("/"));
      assert.equal(r.headers.get("content-disposition"), "inline; filename*=UTF-8''offer%20letter.pdf");
      assert.equal(r.headers.get("content-security-policy"), null, "Chrome's PDF viewer draws nothing under a sandbox");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await bytes(r), pdf);
    }

    reply = { bytes: png, type: "image/png", disposition: "inline; filename*=UTF-8''receipt.png" };
    const image = await get(["tasks", "proof", "p2"]);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.match(image.headers.get("content-disposition"), /^inline/);
    assert.equal(image.headers.get("content-security-policy"), "sandbox");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.equal(image.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await bytes(image), png);

    reply = { bytes: odd, type: "application/zip", disposition: "attachment; filename*=UTF-8''bundle.zip" };
    const unknown = await get(["finance", "desk", "files", "k1"]);
    assert.equal(unknown.headers.get("content-type"), "application/octet-stream");
    assert.equal(unknown.headers.get("content-disposition"), "attachment; filename*=UTF-8''bundle.zip");
    assert.equal(unknown.headers.get("content-security-policy"), "sandbox");
    assert.equal(unknown.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await bytes(unknown), odd);

    // Marked inline but not a PDF or raster image (HTML, SVG): a sandboxed download, never rendered.
    for (const type of ["text/html", "image/svg+xml"]) {
      reply = { bytes: odd, type, disposition: "inline; filename*=UTF-8''page" };
      const r = await get(["tasks", "proof", "p3"]);
      assert.equal(r.headers.get("content-type"), "application/octet-stream", type);
      assert.match(r.headers.get("content-disposition"), /^attachment/);
      assert.equal(r.headers.get("content-security-policy"), "sandbox");
    }
    // A PDF the API sent as an attachment stays a sandboxed download.
    reply = { bytes: pdf, type: "application/pdf", disposition: "attachment; filename*=UTF-8''x.pdf" };
    const attached = await get(["finance", "desk", "files", "k2"]);
    assert.equal(attached.headers.get("content-type"), "application/octet-stream");
    assert.equal(attached.headers.get("content-security-policy"), "sandbox");

    // Errors and the JSON neighbours (the person's file list, removing a proof) stay JSON.
    reply = { bytes: JSON.stringify({ error: "File unavailable" }), type: "application/json", status: 404 };
    const missing = await get(["tasks", "proof", "gone"]);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-type"), "application/json");
    assert.deepEqual(await missing.json(), { error: "File unavailable" });
    reply = { bytes: JSON.stringify({ rows: [] }), type: "application/json" };
    assert.equal((await get(["people", "p1", "files"])).headers.get("content-type"), "application/json");
  });
});

test("v1 allows the three account-claim POST actions", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "0", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    const calls = [];
    const proxy = createApiProxy({ ...v1ProxyOptions, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    } });
    const actions = [
      { path: ["accounts", "account-1", "claim"], body: "{}" },
      { path: ["accounts", "account-1", "claim", "decide"], body: '{"decision":"confirmed"}' },
      { path: ["accounts", "account-1", "claim", "revert"], body: "{}" },
    ];
    for (const action of actions) {
      const url = `http://web.test/api/v1/${action.path.join("/")}`;
      const response = await proxy(new Request(url, {
        method: "POST",
        headers: {
          "cf-access-authenticated-user-email": "synthetic@example.test",
          "cf-access-jwt-assertion": "synthetic-jwt-assertion",
          origin: "http://web.test",
          host: "web.test",
        },
        body: action.body,
      }), context(action.path));
      assert.equal(response.status, 200);
    }
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      "/v1/accounts/account-1/claim",
      "/v1/accounts/account-1/claim/decide",
      "/v1/accounts/account-1/claim/revert",
    ]);
    assert.ok(calls.every((call) => call.options.method === "POST"));
    assert.equal(calls[1].options.body, '{"decision":"confirmed"}');
  });
});

test("v1 rejects account POST paths outside the claim contract", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "0", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    let called = false;
    const proxy = createApiProxy({ ...v1ProxyOptions, fetchImpl: async () => {
      called = true;
      return Response.json({ ok: true });
    } });
    for (const path of [
      ["accounts", "account-1", "profile"],
      ["accounts", "account-1", "claim", "approve"],
      ["accounts", "account-1", "claim", "revert", "extra"],
    ]) {
      const response = await proxy(new Request(`http://web.test/api/v1/${path.join("/")}`, {
        method: "POST",
        headers: { "cf-access-authenticated-user-email": "synthetic@example.test", origin: "http://web.test", host: "web.test" },
        body: "{}",
      }), context(path));
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET");
    }
    assert.equal(called, false);
  });
});

test("v1 ignores the client portal cookie", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    const proxy = createApiProxy({ ...v1ProxyOptions, fetchImpl: async () => { throw new Error("unexpected fetch"); } });
    const response = await proxy(new Request("http://web.test/api/v1/editors/person-1/week", { headers: { cookie: "pulse_client_session=synthetic-client" } }), context(["editors", "person-1", "week"]));
    assert.equal(response.status, 401);
  });
});

test("v0 the organisation's logo is public and sandboxed; nothing else opens without a sign-in", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    const calls = [];
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async (url, options) => { calls.push({ url, options }); return url.endsWith("/brand") ? Response.json({ name: "Synthetic Org", version: 2, mark: true }) : new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml", "set-cookie": "leak=1" } }); } });
    const logo = await proxy(new Request("http://web.test/api/v0/brand/mark"), context(["brand", "mark"]));
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/svg+xml");
    assert.match(logo.headers.get("content-security-policy"), /sandbox/);
    assert.equal(logo.headers.get("set-cookie"), null);
    assert.equal(calls[0].url, "http://127.0.0.1:8081/api/v0/brand/mark");
    assert.equal(calls[0].options.headers, undefined, "no identity travels with a public read");
    assert.deepEqual(await (await proxy(new Request("http://web.test/api/v0/brand"), context(["brand"]))).json(), { name: "Synthetic Org", version: 2, mark: true });
    const other = await proxy(new Request("http://web.test/api/v0/brand/mark/extra"), context(["brand", "mark", "extra"]));
    assert.equal(other.status, 401);
    const post = await proxy(new Request("http://web.test/api/v0/brand/mark", { method: "POST", headers: { origin: "http://web.test" }, body: "{}" }), context(["brand", "mark"]));
    assert.notEqual(post.status, 200);
  });
});

test("UX-TENANT: a company's own address forwards its host and never an Access identity", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: undefined, PULSE_API_URL: "http://127.0.0.1:8081", PULSE_PUBLIC_URL: "https://pulse.install.test" }, async () => {
    const calls = [];
    const proxy = createApiProxy({ ...v0ProxyOptions, fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true }); },
      hostLookup: async (host) => host === "acmark.example.test" ? { name: "Synthetic AC", own: false, signIn: "password", status: "active", rehearsal: true } : { name: "Synthetic EA", own: true, signIn: "access", status: "active", rehearsal: false } });
    const access = { "cf-access-authenticated-user-email": "someone@install.test" };
    // At the company's address the Access header is not an identity: without a session nothing goes upstream.
    let r = await proxy(new Request("http://acmark.example.test/api/v0/me", { headers: { host: "acmark.example.test", ...access } }), context(["me"]));
    assert.equal(r.status, 401);
    r = await proxy(new Request("http://acmark.example.test/api/v0/me", { headers: { host: "acmark.example.test", ...access, cookie: "pulse_session=synthetic-session" } }), context(["me"]));
    assert.equal(r.status, 200);
    const upstream = calls.at(-1).options.headers;
    assert.equal(upstream["x-pulse-host"], "acmark.example.test");
    assert.equal(upstream["x-pulse-session"], "synthetic-session");
    assert.equal(upstream["cf-access-authenticated-user-email"], undefined);
    // A POST from the company's own origin is same-origin there, though PULSE_PUBLIC_URL names the install's address.
    r = await proxy(new Request("http://acmark.example.test/api/v0/tasks", { method: "POST", headers: { host: "acmark.example.test", origin: "http://acmark.example.test", cookie: "pulse_session=synthetic-session" }, body: "{}" }), context(["tasks"]));
    assert.equal(r.status, 200);
    r = await proxy(new Request("http://acmark.example.test/api/v0/tasks", { method: "POST", headers: { host: "acmark.example.test", origin: "https://pulse.install.test", cookie: "pulse_session=synthetic-session" }, body: "{}" }), context(["tasks"]));
    assert.equal(r.status, 403, "another origin is refused");
    // The install's own address keeps Access.
    r = await proxy(new Request("http://pulse.install.test/api/v0/me", { headers: { host: "pulse.install.test", ...access } }), context(["me"]));
    assert.equal(r.status, 200);
    assert.equal(calls.at(-1).options.headers["cf-access-authenticated-user-email"], "someone@install.test");
  });
});

test("operator API paths answer 404 at the proxy and are never forwarded, even with a session and a bearer", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "1", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    let called = false;
    const fetchImpl = async () => { called = true; throw new Error("unexpected fetch"); };
    const cases = [
      [v1ProxyOptions, ["operator", "init"]],
      [v1ProxyOptions, ["operator", "status"]],
      [v1ProxyOptions, ["Operator", "org"]],
      [v1ProxyOptions, ["editors", "..", "operator", "init"]],
      [v0ProxyOptions, ["..", "v1", "operator", "init"]],
      [v0ProxyOptions, ["%2e%2e", "v1", "operator", "status"]],
    ];
    for (const [options, path] of cases) {
      const proxy = createApiProxy({ ...options, fetchImpl });
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await proxy(new Request(`http://web.test/api/${options.legacyV0 ? "v0" : "v1"}/${path.join("/")}`, {
          method,
          headers: { cookie: "pulse_session=synthetic-session", authorization: "Bearer synthetic-operator-token", origin: "http://web.test", host: "web.test" },
          ...(method === "GET" ? {} : { body: "{}" }),
        }), context(path));
        assert.equal(response.status, 404, `${method} ${path.join("/")}`);
        assert.deepEqual(await response.json(), { error: "Not found" });
      }
    }
    assert.equal(called, false);
  });
});

test("FLOW-B: the flow area forwards same-origin POSTs as the signed-in person, with their body; nothing else writes", async () => {
  await withEnv({ PULSE_PUBLIC_LOGIN_ENABLED: "0", PULSE_API_URL: "http://127.0.0.1:8081" }, async () => {
    const calls = [];
    const proxy = createApiProxy({ ...v1FlowProxyOptions, fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } });
    const write = (method, origin) => new Request("http://web.test/api/v1/flow/processes/p1", { method, body: JSON.stringify({ name: "Synthetic" }),
      headers: { host: "web.test", "cf-access-authenticated-user-email": "lead@example.test", ...(origin ? { origin } : {}) } });
    const ok = await proxy(write("POST", "http://web.test"), context(["flow", "processes", "p1"]));
    assert.equal(ok.status, 200);
    assert.equal(calls[0].url, "http://127.0.0.1:8081/v1/flow/processes/p1");
    assert.equal(calls[0].options.body, JSON.stringify({ name: "Synthetic" }));
    assert.equal(calls[0].options.headers["cf-access-authenticated-user-email"], "lead@example.test");
    assert.equal((await proxy(write("POST", "http://evil.test"), context(["flow", "processes", "p1"]))).status, 403);
    for (const method of ["PATCH", "DELETE", "PUT"]) assert.equal((await proxy(write(method, "http://web.test"), context(["flow", "processes", "p1"]))).status, 405, method);
    assert.equal(calls.length, 1, "only the same-origin POST reached the API");
  });
});
