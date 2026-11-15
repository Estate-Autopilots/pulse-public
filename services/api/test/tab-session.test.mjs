// ORG-PER-TAB: the API's front door for a tab's company (tab-session.ts, app.ts). Synthetic ids and tokens only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { tabToken } from "../dist/tab-session.js";

const INSTALL = "00000000-0000-4000-8000-0000000000a1";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const T = "p".repeat(43);
const hash = (t) => createHash("sha256").update(t).digest("hex");

/** A fake database: the parent session T lives in A; B is another company of the same account; C is not the account's. */
function setup({ sessionRow = { org_id: A, status: "active", rehearsal: false }, tab = { [B]: "open" }, sessionTab = false } = {}) {
  const front = [], data = [];
  const database = { query: async (sql, params) => {
    front.push({ sql, params });
    if (sql.includes("pulse.session_org")) return { rows: sessionRow ? [sessionRow] : [] };
    if (sql.includes("pulse.account_tab_session")) { const st = tab[params[2]]; return { rows: st ? [{ org_id: params[2], status: "active", rehearsal: false, state: st }] : [] }; }
    return { rows: [{ org_id: INSTALL }] };
  } };
  const client = { async query(sql, params) {
    data.push({ sql, params });
    if (sql.includes("from pulse.login_session s")) return { rows: [{ person: "e0000000-0000-4000-8000-000000000001", name: "Fake Person", status: "active", side: "staff", roles: [], via: "account", tab: sessionTab }] };
    if (sql.includes("from pulse.login_credential")) return { rows: [] };
    if (sql.includes("auth_enforcement")) return { rows: [{ blocked: false, gate: null }] };
    return { rows: [] };
  }, release() {} };
  return { app: createApp(database, { connect: async () => client }), front, data };
}
const orgOf = (data) => data.find((c) => c.sql === "select set_config('pulse.org_id',$1,true)")?.params?.[0];
const sessionLookup = (data) => data.find((c) => c.sql.includes("from pulse.login_session s"))?.params?.[0];

test("a tab in another company of the account runs as that company's child session, derived from the sign-in", async () => {
  const { app, front, data } = setup();
  try {
    await app.inject({ method: "GET", url: "/api/v0/me", headers: { "x-pulse-session": T, "x-pulse-org": B } });
    const asked = front.find((c) => c.sql.includes("account_tab_session"));
    assert.deepEqual(asked.params, [hash(T), hash(tabToken(T, B)), B]);
    assert.equal(orgOf(data), B);
    assert.equal(sessionLookup(data), hash(tabToken(T, B)));
    assert.notEqual(tabToken(T, B), tabToken(T, A));
    assert.match(tabToken(T, B), /^[A-Za-z0-9_-]{43}$/);
  } finally { await app.close(); }
});

test("a company the account is not in (or signed out of here) is Not found, before any data is read", async () => {
  for (const tab of [{}, { [C]: "closed" }]) {
    const { app, data } = setup({ tab });
    try {
      const r = await app.inject({ method: "GET", url: `/api/v0/docs/${A}`, headers: { "x-pulse-session": T, "x-pulse-org": C } });
      assert.equal(r.statusCode, 404);
      assert.deepEqual(r.json(), { error: "Not found", code: "tab_org_unavailable" });
      assert.equal(r.headers["x-pulse-tab"], "closed");
      assert.equal(data.length, 0, "no transaction was opened");
    } finally { await app.close(); }
  }
});

test("the sign-in's own company needs no second lookup; a value that is no company id is ignored", async () => {
  const { app, front, data } = setup();
  try {
    await app.inject({ method: "GET", url: "/api/v0/me", headers: { "x-pulse-session": T, "x-pulse-org": A } });
    assert.equal(front.some((c) => c.sql.includes("account_tab_session")), false);
    assert.equal(sessionLookup(data), hash(T));
    data.length = 0; front.length = 0;
    await app.inject({ method: "GET", url: "/api/v0/me", headers: { "x-pulse-session": T, "x-pulse-org": "' or 1=1 --" } });
    assert.equal(front.some((c) => c.sql.includes("account_tab_session")), false);
    assert.equal(sessionLookup(data), hash(T));
  } finally { await app.close(); }
});

test("a tab's company session presented on its own (not through the live sign-in) is refused", async () => {
  const { app } = setup({ sessionRow: null, sessionTab: true });
  try {
    const r = await app.inject({ method: "GET", url: "/api/v0/me", headers: { "x-pulse-session": tabToken(T, B) } });
    assert.equal(r.statusCode, 401);
  } finally { await app.close(); }
});
