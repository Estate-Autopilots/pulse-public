import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { operatorAuthorized } from "../dist/operator.js";

const TOKEN = "synthetic-operator-token-0123456789abcdef";
const ORG = "00000000-0000-0000-0000-0000000000a1";

/** A pool double: install_org() answers `installed`, transactions record their SQL and parameters. */
function fakePool(installed = null) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('pulse.operator_agent_chat(')) return { rows: [{ result: { agentId: ORG, chatId: ORG } }] };
      if (sql.includes("pulse.install_init(")) return { rows: [{ orgId: ORG, personId: "p-1", username: "admin.admin", temporaryPassword: "synthetic-temp-pass" }] };
      if (sql.includes("from pulse.org where id=")) return { rows: [{ name: "Northwind Studio", slug: "northwind", code: "NWS", time_zone: "Europe/London" }] };
      if (sql.includes("pulse.operator_role_set(")) {
        if (params[1] === "admin" && params[2] === false) throw Object.assign(new Error("This is the last admin; grant admin to someone else first"), { code: "23505", where: "PL/pgSQL function pulse.operator_role_set(text,text,boolean,text) line 52 at RAISE" });
        return { rows: [{ personId: "p-2", name: "Second Account" }] };
      }
      if (sql.includes("pulse.operator_roles(")) return { rows: [{ role: "admin", email: "admin@northwind.example", name: "Admin", active: true, since: "2026-10-10" }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    async query(sql) {
      if (sql === "SELECT 1") return { rows: [] };
      if (sql === "select pulse.install_org() as org_id") return { rows: [{ org_id: installed }] };
      return { rows: [] };
    },
    async connect() { return client; },
  };
}

async function withApp(token, installed, run) {
  const previous = process.env.PULSE_OPERATOR_TOKEN;
  if (token === undefined) delete process.env.PULSE_OPERATOR_TOKEN; else process.env.PULSE_OPERATOR_TOKEN = token;
  const pool = fakePool(installed);
  const app = createApp(pool, pool);
  try {
    await run(app, pool);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.PULSE_OPERATOR_TOKEN; else process.env.PULSE_OPERATOR_TOKEN = previous;
  }
}

const init = { name: "Northwind Studio", slug: "northwind", code: "NWS", timeZone: "Europe/London",
  adminEmail: "admin@northwind.example", adminName: "Admin" };
const bearer = (value = TOKEN) => ({ authorization: `Bearer ${value}` });

test("without PULSE_OPERATOR_TOKEN the operator routes do not exist, installed or not", async () => {
  for (const installed of [null, ORG]) {
    await withApp(undefined, installed, async app => {
      for (const [method, url] of [["POST", "/api/v1/operator/init"], ["GET", "/api/v1/operator/status"], ["POST", "/api/v1/operator/org"],
        ["GET", "/api/v1/operator/roles"], ["POST", "/api/v1/operator/roles"]]) {
        const response = await app.inject({ method, url, headers: bearer(), payload: method === "POST" ? init : undefined });
        assert.equal(response.statusCode, 404, `${method} ${url}`);
      }
    });
  }
});

test("a short operator token leaves the routes off", async () => {
  await withApp("short", null, async app => {
    const response = await app.inject({ method: "GET", url: "/api/v1/operator/status", headers: bearer("short") });
    assert.equal(response.statusCode, 404);
  });
});

test("a missing, malformed or wrong bearer gets 401 and never reaches the database", async () => {
  await withApp(TOKEN, null, async (app, pool) => {
    for (const headers of [{}, { authorization: TOKEN }, bearer("wrong"), bearer(TOKEN + "x"), { authorization: `Basic ${TOKEN}` }]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/operator/init", headers, payload: init });
      assert.equal(response.statusCode, 401, JSON.stringify(headers));
      assert.deepEqual(response.json(), { error: "Operator token required" });
    }
    assert.equal(pool.calls.length, 0);
  });
});

test("a call relayed by the web tier is refused even with the right token", async () => {
  await withApp(TOKEN, null, async (app, pool) => {
    for (const extra of [{ "x-pulse-device-agent": "" }, { "x-pulse-client-ip": "native" }]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/operator/init", headers: { ...bearer(), ...extra }, payload: init });
      assert.equal(response.statusCode, 404);
    }
    assert.equal(pool.calls.length, 0);
  });
});

test("init answers before the install exists and runs install_init as actor operator", async () => {
  await withApp(TOKEN, null, async (app, pool) => {
    const status = await app.inject({ method: "GET", url: "/api/v1/operator/status", headers: bearer() });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), { initialised: false, org: null, version: process.env.PULSE_RELEASE ?? "dev" });
    pool.calls.length = 0;

    const response = await app.inject({ method: "POST", url: "/api/v1/operator/init", headers: bearer(), payload: init });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json(), { orgId: ORG, personId: "p-1", username: "admin.admin", temporaryPassword: "synthetic-temp-pass" });
    const call = pool.calls.find(c => c.sql.includes("pulse.install_init("));
    assert.deepEqual(call.params, ["Northwind Studio", "northwind", "NWS", "Europe/London", "admin@northwind.example", "Admin", "operator"]);
    assert.deepEqual(pool.calls.map(c => c.sql).filter(sql => /^(begin|commit|rollback)$/.test(sql)), ["begin", "commit"]);
  });
});

test("body schemas refuse unknown, missing and mistyped fields", async () => {
  await withApp(TOKEN, ORG, async (app, pool) => {
    for (const payload of [{ ...init, isAdmin: true }, { ...init, timeZone: undefined }, { ...init, code: "nws" }, { ...init, name: 42 }]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/operator/init", headers: bearer(), payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    const rename = await app.inject({ method: "POST", url: "/api/v1/operator/org", headers: bearer(), payload: { name: "Northwind", slug: "x" } });
    assert.equal(rename.statusCode, 400);
    assert.equal(pool.calls.length, 0);
  });
});

test("status reports the install's company and rename goes through operator_org_set; both are audited", async () => {
  await withApp(TOKEN, ORG, async (app, pool) => {
    const status = await app.inject({ method: "GET", url: "/api/v1/operator/status", headers: bearer() });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json().org, { name: "Northwind Studio", slug: "northwind", code: "NWS", time_zone: "Europe/London" });
    const audit = pool.calls.find(c => c.sql.includes("pulse.audit_write("));
    assert.deepEqual(audit.params, ["operator_status", ORG]);
    assert.deepEqual(pool.calls[pool.calls.indexOf(audit) - 1].params, [ORG, "operator"]);

    const rename = await app.inject({ method: "POST", url: "/api/v1/operator/org", headers: bearer(), payload: { name: "Northwind Studio Ltd" } });
    assert.equal(rename.statusCode, 200);
    assert.deepEqual(pool.calls.find(c => c.sql.includes("pulse.operator_org_set(")).params, ["Northwind Studio Ltd", "operator"]);
  });
});

test("roles: grant and revoke go through operator_role_set as actor operator; the last admin answers 409", async () => {
  await withApp(TOKEN, ORG, async (app, pool) => {
    const grant = await app.inject({ method: "POST", url: "/api/v1/operator/roles", headers: bearer(),
      payload: { email: "second@northwind.example", role: "hr", action: "grant" } });
    assert.equal(grant.statusCode, 200);
    assert.deepEqual(grant.json(), { ok: true, personId: "p-2", name: "Second Account" });
    assert.deepEqual(pool.calls.find(c => c.sql.includes("pulse.operator_role_set(")).params, ["second@northwind.example", "hr", true, "operator"]);
    assert.deepEqual(pool.calls.map(c => c.sql).filter(sql => /^(begin|commit|rollback)$/.test(sql)), ["begin", "commit"]);
    pool.calls.length = 0;

    const last = await app.inject({ method: "POST", url: "/api/v1/operator/roles", headers: bearer(),
      payload: { email: "admin@northwind.example", role: "admin", action: "revoke" } });
    assert.equal(last.statusCode, 409);
    assert.deepEqual(last.json(), { error: "This is the last admin; grant admin to someone else first" });
    assert.deepEqual(pool.calls.map(c => c.sql).filter(sql => /^(begin|commit|rollback)$/.test(sql)), ["begin", "rollback"]);

    const list = await app.inject({ method: "GET", url: "/api/v1/operator/roles", headers: bearer() });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), { roles: [{ role: "admin", email: "admin@northwind.example", name: "Admin", active: true, since: "2026-10-10" }] });
    assert.deepEqual(pool.calls.find(c => c.sql.includes("pulse.operator_roles(")).params, ["operator"]);
  });
});

test("roles: unknown roles, actions and fields are refused before the database", async () => {
  await withApp(TOKEN, ORG, async (app, pool) => {
    const ok = { email: "second@northwind.example", role: "hr", action: "grant" };
    for (const payload of [{ ...ok, role: "manager" }, { ...ok, role: "Admin" }, { ...ok, action: "toggle" }, { ...ok, email: undefined },
      { ...ok, personId: "p-2" }, { ...ok, action: true }]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/operator/roles", headers: bearer(), payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    const unauthorised = await app.inject({ method: "POST", url: "/api/v1/operator/roles", headers: bearer("wrong"), payload: ok });
    assert.equal(unauthorised.statusCode, 401);
    assert.equal(pool.calls.length, 0);
  });
});

test("operatorAuthorized accepts only the exact bearer value", () => {
  assert.equal(operatorAuthorized(`Bearer ${TOKEN}`, TOKEN), true);
  for (const header of [undefined, "", TOKEN, `Bearer ${TOKEN} `, `Bearer  ${TOKEN}`, `bearer ${TOKEN}`, ["Bearer", TOKEN]]) {
    assert.equal(operatorAuthorized(header, TOKEN), false, String(header));
  }
});

test('agent chat setup stays inside the operator boundary, validates strictly and prints IDs only', async () => {
  const url = '/api/v1/operator/agent-chat';
  const payload = { name: 'Pulse Updates', username: 'pulse-updates', chat: 'Studio updates', members: ['member@northwind.example'] };
  await withApp(undefined, ORG, async app => assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 404));
  await withApp(TOKEN, ORG, async (app, pool) => {
    for (const [headers, status] of [[{},401], [bearer('wrong'),401], [{ ...bearer(), 'x-pulse-client-ip': 'native' },404]]) {
      assert.equal((await app.inject({ method: 'POST', url, payload, headers })).statusCode, status);
    }
    for (const bad of [{ ...payload, agentId: ORG }, { ...payload, members: [] }, { ...payload, username: 'bad user' }, { ...payload, members: ['no-email'] }]) {
      assert.equal((await app.inject({ method: 'POST', url, payload: bad, headers: bearer() })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'POST', url: url+'?org=other', payload, headers: bearer() })).statusCode, 400);
    assert.equal(pool.calls.length, 0);
    const response = await app.inject({ method: 'POST', url, payload, headers: bearer() });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { agentId: ORG, chatId: ORG });
    assert.match(response.headers['cache-control'], /(?:^|,\s*)no-store(?:,|$)/);
    assert.deepEqual(pool.calls.find(c => c.sql.includes('pulse.operator_agent_chat(')).params, Object.values(payload));
    assert.deepEqual(pool.calls.map(c => c.sql).filter(sql => /^(begin|commit|rollback)$/.test(sql)), ['begin','commit']);
  });
});
