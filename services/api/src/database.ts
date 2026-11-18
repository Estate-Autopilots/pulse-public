import type { PoolConfig } from "pg";

// The API runs many small aggregates over a few thousand rows. PostgreSQL's JIT compiler is tuned for long analytical
// scans and, on a misestimated plan, spends seconds compiling a query that executes in milliseconds (the 12-week
// trend behind the dashboard: 2.0 s of JIT for a 0.2 s query). Every API session turns it off.
const JIT = "-c jit=off";
// PERF: a connection kept two minutes instead of node-pg's 10 s. A new connection costs its sign-in and then pays for
// every catalog entry and function plan it has not cached yet: the same reads took 9-30 ms on a new connection against
// 2 ms on a warm one, a matching task fit 167 ms against 20 ms. A page's burst of calls opened connections that closed
// again before the next page. PULSE_DB_IDLE_MS overrides (the pool's maximum stays node-pg's 10).
const IDLE_MS = 120_000;
// LAND-CAPTAIN-10 (12 Nov 2026): every wait the API makes on PostgreSQL has an end. Production hung for about 43 hours
// (11-12 Nov) with the process up: the API's login had no statement, lock or idle-in-transaction limit and node-pg's
// pool no limit on waiting for a client, so once the pool's clients were all held (three are the LISTEN hubs' by design)
// every query, /healthz's SELECT 1 too, queued for ever and nothing recovered until a restart. Now:
//  - a request waits at most PULSE_DB_ACQUIRE_MS (10 s) for a client, then fails (500 "temporarily unavailable");
//  - a statement runs at most PULSE_DB_STATEMENT_MS (5 min) and waits at most PULSE_DB_LOCK_MS (30 s) for a lock;
//  - a transaction left idle PULSE_DB_IDLE_TX_MS (5 min) is ended by the server, which frees its locks. The longest
//    idle gap the API means to keep inside a transaction is Sales X-Ray's 150 s tool run; 5 min leaves room for it.
// A value under 1000 ms (or not a whole number) keeps the default.
const ACQUIRE_MS = 10_000, STATEMENT_MS = 300_000, LOCK_MS = 30_000, IDLE_TX_MS = 300_000;
const ms = (value: string | undefined, fallback: number) => { const n = Number(value); return Number.isInteger(n) && n >= 1000 ? n : fallback; };

/** The per-session limits, as libpq startup options (the server enforces them; nothing in the API has to remember). */
export function sessionLimits(env: NodeJS.ProcessEnv = process.env): string {
  return `-c statement_timeout=${ms(env.PULSE_DB_STATEMENT_MS, STATEMENT_MS)} -c lock_timeout=${ms(env.PULSE_DB_LOCK_MS, LOCK_MS)}`
    + ` -c idle_in_transaction_session_timeout=${ms(env.PULSE_DB_IDLE_TX_MS, IDLE_TX_MS)}`;
}

export function apiPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const limits = { idleTimeoutMillis: ms(env.PULSE_DB_IDLE_MS, IDLE_MS), connectionTimeoutMillis: ms(env.PULSE_DB_ACQUIRE_MS, ACQUIRE_MS) };
  const session = `${JIT} ${sessionLimits(env)}`;
  const serviceUrl = env.PULSE_DATABASE_URL_API;
  if (serviceUrl) return { connectionString: serviceUrl, options: session, ...limits };

  const sharedUrl = env.DATABASE_URL;
  if (sharedUrl) {
    return { connectionString: sharedUrl, options: `-c role=pulse_api ${session}`, ...limits };
  }

  throw new Error("PULSE_DATABASE_URL_API is not set (nor DATABASE_URL)");
}
