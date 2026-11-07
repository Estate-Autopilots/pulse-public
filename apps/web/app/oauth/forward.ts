import { hostHeader } from "../lib/host-mode.mjs";

// PULSE-ID: the OpenID Connect endpoints and the data API apps call (docs/architecture/PULSE_IDENTITY_AND_DATA_API.md).
// Apps call them server to server with their own credentials: a client secret or a bearer token. No cookie, session or
// Access identity is read or passed on; the API checks the credential itself. Answers keep their status, the headers
// OAuth needs, and never a cookie.
const API = () => process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";
const KEEP_IN = ["authorization", "content-type", "idempotency-key"];
const KEEP_OUT = ["content-type", "cache-control", "pragma", "www-authenticate", "retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset",
  "x-content-type-options", "content-security-policy", "referrer-policy"];

/** Forward one request to the API at `path` (with the caller's query), carrying only the app's own credential. */
export async function forward(request: Request, path: string, options: { credential?: boolean; maxBody?: number } = {}) {
  const headers: Record<string, string> = { ...hostHeader(request.headers), "x-pulse-client-ip": request.headers.get("cf-connecting-ip") ?? "oauth-client",
    "user-agent": (request.headers.get("user-agent") ?? "").slice(0, 300) };
  if (options.credential !== false) for (const key of KEEP_IN) { const v = request.headers.get(key); if (v !== null) headers[key] = v; }
  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > (options.maxBody ?? 262144)) return Response.json({ error: "invalid_request", error_description: "The request is too large" }, { status: 413, headers: { "cache-control": "no-store" } });
  try {
    const upstream = await fetch(`${API()}${path}${new URL(request.url).search}`, { method: request.method, headers, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(30000), ...(body && body.byteLength ? { body } : {}) });
    const out = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    for (const key of KEEP_OUT) { const v = upstream.headers.get(key); if (v !== null) out.set(key, v); }
    return new Response(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers: out });
  } catch {
    return Response.json({ error: "temporarily_unavailable", error_description: "Pulse is not answering just now" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
