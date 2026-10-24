import type { PoolConfig } from "pg";

// The API runs many small aggregates over a few thousand rows. PostgreSQL's JIT compiler is tuned for long analytical
// scans and, on a misestimated plan, spends seconds compiling a query that executes in milliseconds (the 12-week
// trend behind the dashboard: 2.0 s of JIT for a 0.2 s query). Every API session turns it off.
const SESSION = "-c jit=off";

export function apiPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const serviceUrl = env.PULSE_DATABASE_URL_API;
  if (serviceUrl) return { connectionString: serviceUrl, options: SESSION };

  const sharedUrl = env.DATABASE_URL;
  if (sharedUrl) {
    return { connectionString: sharedUrl, options: `-c role=pulse_api ${SESSION}` };
  }

  throw new Error("PULSE_DATABASE_URL_API is not set (nor DATABASE_URL)");
}
