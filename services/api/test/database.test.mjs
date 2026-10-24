import assert from "node:assert/strict";
import test from "node:test";
import { apiPoolConfig } from "../dist/database.js";

test("API prefers its dedicated database login", () => {
  assert.deepEqual(apiPoolConfig({ PULSE_DATABASE_URL_API: "postgresql://api@db/pulse" }), {
    connectionString: "postgresql://api@db/pulse",
    options: "-c jit=off",
  });
});

test("API applies the pulse_api role to the shared database login", () => {
  assert.deepEqual(apiPoolConfig({ DATABASE_URL: "postgresql://app@db/pulse" }), {
    connectionString: "postgresql://app@db/pulse",
    options: "-c role=pulse_api -c jit=off",
  });
});

test("API reports the expected setting when no database URL is configured", () => {
  assert.throws(() => apiPoolConfig({}), /PULSE_DATABASE_URL_API is not set \(nor DATABASE_URL\)/);
});
