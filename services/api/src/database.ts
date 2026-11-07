import type { PoolConfig } from "pg";

// The API runs many small aggregates over a few thousand rows. PostgreSQL's JIT compiler is tuned for long analytical
// scans and, on a misestimated plan, spends seconds compiling a query that executes in milliseconds (the 12-week
// trend behind the dashboard: 2.0 s of JIT for a 0.2 s query). Every API session turns it off.
const SESSION = "-c jit=off";
// PERF: a connection kept two minutes instead of node-pg's 10 s. A new connection costs its sign-in and then pays for
// every catalog entry and function plan it has not cached yet: the same reads took 9-30 ms on a new connection against
// 2 ms on a warm one, a matching task fit 167 ms against 20 ms. A page's burst of calls opened connections that closed
// again before the next page. PULSE_DB_IDLE_MS overrides (the pool's maximum stays node-pg's 10).
const IDLE_MS = 120_000;
const idle = (env: NodeJS.ProcessEnv) => { const n = Number(env.PULSE_DB_IDLE_MS); return Number.isInteger(n) && n >= 1000 ? n : IDLE_MS; };

export function apiPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const serviceUrl = env.PULSE_DATABASE_URL_API;
  if (serviceUrl) return { connectionString: serviceUrl, options: SESSION, idleTimeoutMillis: idle(env) };

  const sharedUrl = env.DATABASE_URL;
  if (sharedUrl) {
    return { connectionString: sharedUrl, options: `-c role=pulse_api ${SESSION}`, idleTimeoutMillis: idle(env) };
  }

  throw new Error("PULSE_DATABASE_URL_API is not set (nor DATABASE_URL)");
}
