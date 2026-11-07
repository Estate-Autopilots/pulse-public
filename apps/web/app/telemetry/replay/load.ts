// BUGKIT-TELEMETRY (owner, 6 Nov 2026): a session replay's chunks from the API, decompressed in the browser (they are
// stored gzip-compressed, masked on the recording device and checked by the API). Used by the player and the heatmap.
import { mergeEvents, type RrEvent } from "../../lib/friction-dashboard.mjs";

export type Chunk = { seq: number; route: string | null; startedAt: string; endedAt: string; events: number; bytes: number; reason: string };
export type ReplayMeta = { sid: string; zone: string; who: string | null; chunks: Chunk[] };

async function gunzipJson(buffer: ArrayBuffer): Promise<unknown[]> {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const parsed = JSON.parse(await new Response(stream).text()) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

export async function replayMeta(sid: string, signal?: AbortSignal): Promise<ReplayMeta> {
  const r = await fetch(`/api/v0/telemetry/replay/${encodeURIComponent(sid)}`, { cache: "no-store", signal });
  if (!r.ok) throw new Error(r.status === 404 ? "This replay is gone (past the company's retention) or never recorded." : "The replay could not load.");
  return r.json() as Promise<ReplayMeta>;
}

/** The events of the given chunks, merged in time order. */
export async function replayEvents(sid: string, seqs: number[], signal?: AbortSignal): Promise<RrEvent[]> {
  const lists = await Promise.all(seqs.map(async (seq) => {
    const r = await fetch(`/api/v0/telemetry/replay/${encodeURIComponent(sid)}/${seq}`, { cache: "no-store", signal });
    if (!r.ok) return [];
    try { return await gunzipJson(await r.arrayBuffer()); } catch { return []; }
  }));
  return mergeEvents(lists);
}
