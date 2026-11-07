import assert from "node:assert/strict";
import test from "node:test";
import { apiPoolConfig } from "../dist/database.js";

test("API prefers its dedicated database login", () => {
  assert.deepEqual(apiPoolConfig({ PULSE_DATABASE_URL_API: "postgresql://api@db/pulse" }), {
    connectionString: "postgresql://api@db/pulse",
    options: "-c jit=off",
    idleTimeoutMillis: 120000,
  });
});

test("API applies the pulse_api role to the shared database login", () => {
  assert.deepEqual(apiPoolConfig({ DATABASE_URL: "postgresql://app@db/pulse" }), {
    connectionString: "postgresql://app@db/pulse",
    options: "-c role=pulse_api -c jit=off",
    idleTimeoutMillis: 120000,
  });
});

// PERF: connections stay two minutes (warm catalog and plans); PULSE_DB_IDLE_MS overrides, nonsense keeps the default.
test("API keeps idle connections warm, overridable", () => {
  assert.equal(apiPoolConfig({ DATABASE_URL: "postgresql://app@db/pulse", PULSE_DB_IDLE_MS: "30000" }).idleTimeoutMillis, 30000);
  assert.equal(apiPoolConfig({ DATABASE_URL: "postgresql://app@db/pulse", PULSE_DB_IDLE_MS: "soon" }).idleTimeoutMillis, 120000);
});

test("API reports the expected setting when no database URL is configured", () => {
  assert.throws(() => apiPoolConfig({}), /PULSE_DATABASE_URL_API is not set \(nor DATABASE_URL\)/);
});
