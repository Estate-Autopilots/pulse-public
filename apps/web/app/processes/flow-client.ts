// FLOW-B: the browser's calls to the flow API (/api/v1/flow/…, as the signed-in person). The answer's own sentence is
// the error people see; a refusal without one says what did not happen.
export async function flow<T = Record<string, unknown>>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1/flow/${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({})) as { error?: string; detail?: string; title?: string };
  if (!r.ok) throw new Error(d.error ?? d.detail ?? (r.status === 404 ? "Pulse could not find that. It may have been removed." : "That did not save. Try again."));
  return d as T;
}
export const why = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
