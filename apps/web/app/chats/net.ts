// Chat requests. Unlike records' post(), a sent message is not "data changed" for the rest of the app: the
// intelligence rail and freshness checks are left alone, and the live-updates stream tells the chat what moved.
/** E2E-4P (owner check): a read that hangs (a loaded server) gives up after 15 s, so the caller can retry quietly
 *  instead of spinning for good. */
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const limit = AbortSignal.timeout(15000);
  const r = await fetch(`/api/v0/${path}`, { cache: "no-store", signal: signal ? AbortSignal.any([signal, limit]) : limit })
    .catch((e: unknown) => { throw new Error((e as Error)?.name === "TimeoutError" ? "Pulse is slow to answer" : "Could not connect. Check your connection and try again."); });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Could not connect. Check your connection and try again.");
  return d as T;
}
export async function send<T = { ok: boolean }>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "That did not go through. Try again.");
  return d as T;
}
/** A file as base64 for the upload endpoints (5 MB for chat files, 1 MB for a group photo). */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] ?? ""); r.onerror = () => reject(new Error("Could not read that file")); r.readAsDataURL(file); });
}
