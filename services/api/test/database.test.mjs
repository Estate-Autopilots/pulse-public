import assert from "node:assert/strict";
import test from "node:test";
import { apiPoolConfig, sessionLimits } from "../dist/database.js";

const LIMITS = "-c statement_timeout=300000 -c lock_timeout=30000 -c idle_in_transaction_session_timeout=300000";

test("API prefers its dedicated database login", () => {
  assert.deepEqual(apiPoolConfig({ PULSE_DATABASE_URL_API: "postgresql://api@db/pulse" }), {
    connectionString: "postgresql://api@db/pulse",
    options: `-c jit=off ${LIMITS}`,
    idleTimeoutMillis: 120000,
    connectionTimeoutMillis: 10000,
  });
});

test("API applies the pulse_api role to the shared database login", () => {
  assert.deepEqual(apiPoolConfig({ DATABASE_URL: "postgresql://app@db/pulse" }), {
    connectionString: "postgresql://app@db/pulse",
    options: `-c role=pulse_api -c jit=off ${LIMITS}`,
    idleTimeoutMillis: 120000,
    connectionTimeoutMillis: 10000,
  });
});

// PERF: connections stay two minutes (warm catalog and plans); PULSE_DB_IDLE_MS overrides, nonsense keeps the default.
test("API keeps idle connections warm, overridable", () => {
  assert.equal(apiPoolConfig({ DATABASE_URL: "postgresql://app@db/pulse", PULSE_DB_IDLE_MS: "30000" }).idleTimeoutMillis, 30000);
  assert.equal(apiPoolConfig({ DATABASE_URL: "postgresql://app@db/pulse", PULSE_DB_IDLE_MS: "soon" }).idleTimeoutMillis, 120000);
});

// LAND-CAPTAIN-10: production hung ~43 h because no wait on PostgreSQL had an end (no acquire, statement, lock or
// idle-in-transaction limit). Every one is bounded by default; each can be set, and a value that is no whole number of
// at least a second can never turn a limit off.
test("API bounds every wait on PostgreSQL, overridable but never unlimited", () => {
  const url = { DATABASE_URL: "postgresql://app@db/pulse" };
  assert.equal(apiPoolConfig(url).connectionTimeoutMillis, 10000);
  assert.equal(apiPoolConfig({ ...url, PULSE_DB_ACQUIRE_MS: "4000" }).connectionTimeoutMillis, 4000);
  for (const off of ["0", "-1", "", "never", "1.5", "999"]) {
    assert.equal(apiPoolConfig({ ...url, PULSE_DB_ACQUIRE_MS: off }).connectionTimeoutMillis, 10000, off);
    assert.equal(sessionLimits({ PULSE_DB_STATEMENT_MS: off, PULSE_DB_LOCK_MS: off, PULSE_DB_IDLE_TX_MS: off }), LIMITS, off);
  }
  assert.equal(sessionLimits({ PULSE_DB_STATEMENT_MS: "60000", PULSE_DB_LOCK_MS: "5000", PULSE_DB_IDLE_TX_MS: "120000" }),
    "-c statement_timeout=60000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=120000");
});

test("API reports the expected setting when no database URL is configured", () => {
  assert.throws(() => apiPoolConfig({}), /PULSE_DATABASE_URL_API is not set \(nor DATABASE_URL\)/);
});
