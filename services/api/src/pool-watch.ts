import { Client, type Pool, type PoolConfig } from "pg";

// LAND-CAPTAIN-10 (12 Nov 2026): production hung ~43 h with every API query waiting for a database client, and nothing
// recorded which statements held the clients: the incident left no cause behind. This watch makes the next one name
// its cause, and keeps one server-side ending of a borrowed client from taking the whole API down.

export interface PoolCounts { total: number; idle: number; waiting: number }
export const poolCounts = (pool: unknown): PoolCounts | null => {
  const p = pool as Partial<Record<"totalCount" | "idleCount" | "waitingCount", unknown>> | null;
  return p && typeof p.totalCount === "number" && typeof p.idleCount === "number" && typeof p.waitingCount === "number"
    ? { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount } : null;
};

/** What this API login's other sessions are doing: state, wait, ages, who blocks them, and the start of the statement.
 *  The API's statements carry their values as parameters ($1 ...), so the text names the work, not the data. */
export const SESSIONS_SQL = `select pid, state, wait_event_type || ':' || wait_event as wait,
  extract(epoch from now() - xact_start)::int as xact_s, extract(epoch from now() - state_change)::int as state_s,
  pg_blocking_pids(pid) as blocked_by, left(regexp_replace(query, '\\s+', ' ', 'g'), 200) as query
  from pg_stat_activity where usename = current_user and pid <> pg_backend_pid() and state is distinct from 'idle'
  order by xact_start nulls last limit 20`;

type Log = { warn: (o: object, msg: string) => void };
type Snapshot = () => Promise<unknown[]>;

/** One short-lived connection outside the pool (the pool is the thing that is stuck), 5 s to connect and to answer. */
export const sessionSnapshot = (config: PoolConfig): Snapshot => async () => {
  const client = new Client({ ...config, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try { await client.connect(); return (await client.query(SESSIONS_SQL)).rows; }
  finally { await client.end().catch(() => {}); }
};

/** Every `everyMs`: when requests have been waiting for a client on two checks in a row, log the pool's counts and the
 *  sessions (at most once a minute). Returns the stop function. */
export function watchPool(pool: Pool, log: Log, snapshot: Snapshot, everyMs = 15_000, now = () => Date.now()) {
  // A borrowed client has no error listener of its own (pg-pool takes its idle one off): the server ending it (e.g.
  // idle_in_transaction_session_timeout) would throw an unhandled 'error' and stop the API. The request using it fails
  // on its next query instead, and the pool drops the client when it comes back.
  pool.on("connect", (client) => { client.on("error", (error: Error & { code?: string }) => log.warn({ code: error.code ?? "unknown" }, "PostgreSQL ended an API connection")); });
  let starved = 0, logged = Number.NEGATIVE_INFINITY, busy = false;
  const tick = async () => {
    const c = poolCounts(pool);
    if (!c || c.waiting === 0) { starved = 0; return; }
    if (++starved < 2 || busy || now() - logged < 60_000) return;
    busy = true; logged = now();
    try { log.warn({ pool: c, sessions: await snapshot() }, "API requests are waiting for a database client"); }
    catch (error) { log.warn({ pool: c, sessions: null, reason: (error as Error).message?.slice(0, 120) }, "API requests are waiting for a database client"); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), everyMs); timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
