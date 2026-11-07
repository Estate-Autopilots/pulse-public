// UX-TENANT (ADR-0032): the address a request came in on decides the company and how people sign in there. The
// API answers (/api/v0/host); this keeps each answer for 30 seconds per host in the web server's memory.
//
// signIn "access": the install's own addresses behind Cloudflare Access (EA today); the Access e-mail header is the
// identity. signIn "password": a company that signs in with Pulse passwords; Access headers are never forwarded there.

const cache = new Map();
const TTL = 30_000;

/** The host the person opened (lower case, port kept: a *.localhost rehearsal links back to the same port). */
export function requestHost(headers) {
  const raw = typeof headers?.get === "function" ? headers.get("host") : headers?.host;
  return typeof raw === "string" && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

/** { signIn, name, own, status, rehearsal } for a host; the install's default when the API cannot say. */
export async function hostMode(host, fetchImpl = fetch) {
  const publicLogin = process.env.PULSE_PUBLIC_LOGIN_ENABLED === "1";
  const fallback = { signIn: publicLogin ? "password" : "access", name: null, own: true, status: "active", rehearsal: false };
  if (!host) return fallback;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  // SIM-CLIENTS R146 / AI-EMP-2: while the API restarts or is slow, the last answer for this host stands (a client on a
  // password address was told to sign in through Access, and their message was refused, when the lookup timed out).
  const known = hit?.value ?? fallback;
  try {
    const r = await fetchImpl(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/host`, { headers: { "x-pulse-host": host }, cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!r.ok) return known;
    const data = await r.json();
    const value = { ...fallback, ...data, signIn: data.signIn === "password" || publicLogin ? "password" : "access" };
    cache.set(host, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  } catch { return known; }
}

/** Whether people sign in with Pulse passwords on this host (public sign-in mode, or a company's own address). */
export async function passwordHost(host, fetchImpl) {
  return (await hostMode(host, fetchImpl)).signIn === "password";
}

/** The header that tells the API which address the person opened (never taken from the client: computed from Host). */
export function hostHeader(headers) {
  const host = requestHost(headers);
  return host ? { "x-pulse-host": host } : {};
}

/** Another credential or identity alongside API v1's bearer, including present-but-empty headers. */
export function hasV1CredentialConflict(headers) {
  return [...headers.keys()].some((key) => ["cookie", "x-pulse-session", "x-pulse-client-session", "x-pulse-agent-key", "x-pulse-access-id"].includes(key)
    || key.startsWith("cf-access-") || key.startsWith("x-dev-"));
}

/** The request headers the app sees (proxy.ts). x-pulse-host never comes from the client. On a password host no
 * client-sent identity header survives (cf-access-*, x-pulse-*, x-dev-*), except a native app's own session on
 * /api/native/ and an AI co-worker's key: the key is a credential the database checks, not a claim, and the API proxy
 * forwards it on /api/v0/agent/* only and refuses it anywhere else (EST-1088: dropping it here shut every runner out
 * of a password-mode install). */
export function inboundHeaders(source, path, password, method) {
  const headers = new Headers(source);
  headers.delete("x-pulse-host");
  if (!password) return headers;
  // Check before removing identity headers; preserve the refusal by invalidating the bearer for the route guard.
  let decodedPath = path;
  try { decodedPath = decodeURIComponent(path); } catch { /* A malformed suffix must not skip a plain v1 prefix. */ }
  if (/^\/api\/v1(?:\/|$)/.test(decodedPath) && headers.has("authorization") && hasV1CredentialConflict(headers)) {
    headers.set("authorization", "");
  }
  // Sanitizing a person's session/Access header must never turn mixed credentials into an accepted key-only request.
  // Keep the key header present but invalid, so the API proxy refuses it on agent AND person routes before fetching.
  if (headers.has("x-pulse-agent-key") && ["cookie", "authorization", "x-pulse-session", "x-pulse-client-session", "cf-access-authenticated-user-email", "cf-access-jwt-assertion"].some((key) => headers.has(key))) {
    headers.set("x-pulse-agent-key", "");
  }
  for (const key of [...headers.keys()]) {
    // A fresh code is a credential the API verifies, scoped to the Google settings write.
    if (key === "x-pulse-two-step" && method === "PUT" && path === "/api/v0/admin/sign-in/google") continue;
    if (key === "x-pulse-agent-key" || (key === "x-pulse-session" && path.startsWith("/api/native/"))) continue;
    // PERF: the browser telemetry's request id is no credential (the API proxy forwards it only in its own shape). Removed
    // with the other x-pulse-* headers, production never joined a browser's call to the API's own timing.
    if (key === "x-pulse-request-id") continue;
    if (key.startsWith("cf-access-") || key.startsWith("x-pulse-") || key.startsWith("x-dev-")) headers.delete(key);
  }
  return headers;
}
