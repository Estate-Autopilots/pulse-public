import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { assertConfiguredOrg } from "../dist/installation.js";

test("health is ready when PostgreSQL responds", async () => {
  const app = createApp({ query: async (sql) => {
    if (sql === "SELECT 1") return { rows: [] };
    assert.equal(sql, "select pulse.install_org() as org_id");
    return { rows: [{ org_id: "00000000-0000-0000-0000-000000000001" }] };
  } });

  try {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok", setup: "ready" });
  } finally {
    await app.close();
  }
});

test("health is unavailable when PostgreSQL fails", async () => {
  const app = createApp({ query: async () => Promise.reject(new Error("unavailable")) });

  try {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: "unavailable", part: "database" });
  } finally {
    await app.close();
  }
});

test("an uninitialised install keeps health live and rejects API and portal routes", async () => {
  const database = { query: async sql => {
    if (sql === "SELECT 1") return { rows: [] };
    assert.equal(sql, "select pulse.install_org() as org_id");
    return { rows: [{ org_id: null }] };
  } };
  const app = createApp(database, database);

  try {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok", setup: "pending" });
    for (const url of ["/api/v0/me", "/api/v0/portal/me"]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 503, url);
      assert.deepEqual(response.json(), { error: "not_initialised" }, url);
    }
    // The operator API is how an install is initialised; without PULSE_OPERATOR_TOKEN it does not exist.
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/operator/init" })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("a configured tenant mismatch refuses API startup", () => {
  assert.throws(
    () => assertConfiguredOrg("00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000001"),
    /PULSE_ORG_ID does not match pulse\.install\.org_id/,
  );
  assert.throws(
    () => assertConfiguredOrg("00000000-0000-0000-0000-000000000002", null),
    /PULSE_ORG_ID is set but pulse\.install is empty/,
  );
});
