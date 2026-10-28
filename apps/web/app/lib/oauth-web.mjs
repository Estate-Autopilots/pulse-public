// EST-2811: the public face of "Sign in with Pulse" for apps (Claude, ChatGPT, the Pulse CLI) and the remote MCP
// server at /mcp. Discovery documents (RFC 8414, RFC 9728) are built here from the address the app called; the OAuth
// endpoints forward to the API (services/api/src/oauth.ts), which holds every rule and every secret.
import { hostHeader, requestHost } from "./host-mode.mjs";

/** Must match OAUTH_SCOPES in services/api/src/oauth.ts (test: oauth-web.test.mjs). */
export const OAUTH_SCOPES = ["people.read", "people.write", "search.read", "tasks.read", "tasks.write", "projects.read", "projects.write", "chats.write", "events.read", "events.write"];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };

/** This install's address as the caller sees it: https, except plain http on this computer. */
export function publicOrigin(headers) {
  const host = requestHost(headers);
  if (!host) {
    try { return new URL(process.env.PULSE_PUBLIC_URL ?? "").origin; } catch { return "http://localhost"; }
  }
  return `${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https"}://${host}`;
}

export function protectedResource(origin) {
  return { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: OAUTH_SCOPES,
    resource_name: "Pulse", resource_documentation: `${origin}/developers` };
}
export function authorizationServer(origin) {
  const auth = ["none", "client_secret_basic", "client_secret_post"];
  return { issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`,
    revocation_endpoint: `${origin}/oauth/mcp/revoke`, registration_endpoint: `${origin}/oauth/mcp/register`,
    response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: auth, revocation_endpoint_auth_methods_supported: auth,
    scopes_supported: OAUTH_SCOPES, authorization_response_iss_parameter_supported: true, service_documentation: `${origin}/developers` };
}
export const discovery = (body) => Response.json(body, { headers: { ...CORS, "cache-control": "public, max-age=300" } });
export const preflight = () => new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "600" } });

/** The 401 challenge MCP clients follow to find the authorization server (MCP authorization, RFC 9728 §5.1). */
export function challenge(origin, invalid = false) {
  return `Bearer realm="pulse", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${OAUTH_SCOPES.join(" ")}"${invalid ? ', error="invalid_token"' : ""}`;
}

/** register, token and revoke: the body (JSON or a form) goes to the API as JSON with the client's Basic credentials. */
export async function forwardOAuth(request, action, fetchImpl = fetch) {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", ...CORS } });
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  let body;
  try {
    const text = await request.text();
    if (text.length > 8192) throw new Error("too large");
    body = type === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
  } catch {
    return Response.json({ error: action === "register" ? "invalid_client_metadata" : "invalid_request" }, { status: 400, headers: { ...CORS, "cache-control": "no-store" } });
  }
  const headers = { "content-type": "application/json", "x-pulse-client-ip": request.headers.get("cf-connecting-ip") ?? "oauth-client", ...hostHeader(request.headers) };
  const basic = request.headers.get("authorization");
  if (basic && /^Basic [A-Za-z0-9+/=]+$/.test(basic)) headers.authorization = basic;
  try {
    const upstream = await fetchImpl(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/oauth/${action}`,
      { method: "POST", headers, body: JSON.stringify(body), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000) });
    const out = new Headers({ ...CORS, "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" });
    for (const key of ["www-authenticate", "retry-after"]) if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
    return new Response(await upstream.text(), { status: upstream.status, headers: out });
  } catch {
    return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { ...CORS, "cache-control": "no-store" } });
  }
}

const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const PAGE = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--ink:#16161a;--muted:#5d5d66;--line:#e2e2e0;--accent:#2f5bea;--warn:#8a5a00;--warnbg:#fff6df}
@media (prefers-color-scheme:dark){:root{--bg:#111114;--card:#1b1b20;--ink:#f1f1f3;--muted:#a3a3ad;--line:#2c2c33;--accent:#7b9bff;--warn:#f3c66b;--warnbg:#2b2414}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:460px;width:100%;padding:24px}
h1{font-size:20px;margin:0 0 4px}p{margin:8px 0;color:var(--muted)}ul{padding-left:18px;margin:12px 0}li{margin:6px 0}
.warn{background:var(--warnbg);color:var(--warn);border-radius:10px;padding:10px 12px;font-size:14px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font:inherit;padding:11px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer;min-height:44px}
button.go{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}a{color:var(--accent)}
</style></head><body><main>${inner}</main></body></html>`;
export const html = (title, inner, status = 200) => new Response(PAGE(title, inner), { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });

/** The consent screen: who is asking, where it returns, what it may do as you. No script; one form back to /oauth/mcp/authorize. */
export function consentPage(info, query) {
  const fields = ["client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "response_type"]
    .filter((k) => query.get(k) !== null).map((k) => `<input type="hidden" name="${k}" value="${escape(query.get(k))}">`).join("");
  return html(`Connect ${info.app.name} to Pulse`, `<h1>${escape(info.app.name)} wants to use Pulse as you</h1>
<p>Signed in as <strong>${escape(info.person)}</strong> · ${escape(info.company)}</p>
<p class="warn">Pulse has not checked this app; it named itself “${escape(info.app.name)}”. Continue only if you started this from that app. It will return to <strong>${escape(info.returnsTo)}</strong>.</p>
<p>It will be able to:</p><ul>${info.scopes.map((s) => `<li>${escape(s.label)}</li>`).join("")}</ul>
<p>It sees only what you can see in Pulse. Changes it makes show its name and most can be undone for 7 days. Disconnect any time from the app, or ask an admin.</p>
<form method="post" action="/oauth/mcp/authorize">${fields}<div class="row"><button type="submit" name="decision" value="deny">Cancel</button><button class="go" type="submit" name="decision" value="approve">Allow</button></div></form>`);
}
export function returnPage(target) {
  const host = (() => { try { return new URL(target).host; } catch { return "the app"; } })();
  return new Response(PAGE("Returning to the app", `<h1>Returning to ${escape(host)}…</h1><p><a href="${escape(target)}">Continue</a> if nothing happens.</p>`)
    .replace("<title>", `<meta http-equiv="refresh" content="0;url=${escape(target)}"><title>`),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
}
