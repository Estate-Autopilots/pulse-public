import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { Viewer } from "./routes.js";

/**
 * A small in-process cache for expensive read-only views (dashboard figures, research summaries).
 *
 * An entry is reused only for the same signed-in viewer and request URL, while its data version is unchanged and it is
 * younger than its time-to-live. The version is a cheap database stamp (the last index run, the last research import),
 * so a cached answer is exactly as current as the data it was computed from; a successful write through this API
 * empties the whole cache so a decision or check-in shows up on the next read. Every payload keeps its own
 * `generatedAt`, which the pages show, so nothing is presented as newer than it is.
 */
type Entry = { key: string; version: string; at: number; value: unknown };

export class ResponseCache {
  private entries = new Map<string, Entry>();
  constructor(private readonly max = 200) {}

  /** The cached value for this viewer and URL, or undefined when it is missing, stale or of another version. */
  get<T>(viewer: Viewer, url: string, version: string, ttlMs: number): T | undefined {
    const key = ResponseCache.key(viewer, url);
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.version !== version || Date.now() - e.at > ttlMs) { this.entries.delete(key); return undefined; }
    // Refresh insertion order so the oldest entries are the first evicted.
    this.entries.delete(key); this.entries.set(key, e);
    return e.value as T;
  }

  set(viewer: Viewer, url: string, version: string, value: unknown) {
    const key = ResponseCache.key(viewer, url);
    this.entries.delete(key);
    this.entries.set(key, { key, version, at: Date.now(), value });
    while (this.entries.size > this.max) { const oldest = this.entries.keys().next().value; if (oldest === undefined) break; this.entries.delete(oldest); }
  }

  /** Compute once per viewer, URL and version; later calls within the TTL reuse the answer. */
  async through<T>(viewer: Viewer, url: string, version: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(viewer, url, version, ttlMs);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(viewer, url, version, value);
    return value;
  }

  /** How many times writes have emptied the cache: part of the version the pages poll, so a write made through this
   *  API by anyone is noticed by every open tab within a poll interval. */
  generation = 0;
  clear() { this.entries.clear(); this.generation++; }
  get size() { return this.entries.size; }

  /** Identity is the resolved viewer (account, person, role), never a raw header: two viewers never share an entry. */
  static key(viewer: Viewer, url: string) { return `${viewer.org}|${viewer.email}|${viewer.person ?? ""}|${viewer.role}|${viewer.via}|${url}`; }
}

/** Successful writes through this process invalidate every cached read. */
export function invalidateOnWrite(app: FastifyInstance, cache: ResponseCache) {
  app.addHook("onResponse", async (request, reply) => {
    // TELEMETRY: a route marked keepsCache (the telemetry batch) writes no data the cached views read.
    if ((request.routeOptions.config as { keepsCache?: boolean } | undefined)?.keepsCache) return;
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS" && reply.statusCode < 400) cache.clear();
  });
}

/** The data version behind the work and people figures: the last finished index run plus the newest change this
 *  process has not seen through a write (worker-written projections are visible through the index stamp). */
export async function syncVersion(c: PoolClient) {
  const row = (await c.query(`select coalesce(max(finished_at)::text,'') stamp,count(*)::int runs from pulse.sync_run`)).rows[0] as { stamp: string; runs: number };
  return `sync:${row.stamp}:${row.runs}`;
}

/** The data version behind research summaries: the imports they are computed from. */
export async function researchVersion(c: PoolClient) {
  const row = (await c.query(`select coalesce(string_agg(dataset||'='||row_count||'@'||coalesce(imported_at::text,''),',' order by dataset),'') stamp from pulse.research_import`)).rows[0] as { stamp: string };
  return `research:${row.stamp}`;
}
