import { hostHeader } from "./host-mode.mjs";

// SELF-SERVE (owner, 4 Nov 2026: a new person creates their Pulse account while connecting the Pulse connector from
// ChatGPT or Claude): the name of the app a return address continues to, for the sign-in and sign-up pages. Sign in
// with Pulse asks the OpenID check; the MCP connector (/oauth/mcp/authorize) asks for the name the app registered.
const API = () => process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";
const ip = (h: Headers, fallback: string) => h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? fallback;

export async function appNameFor(next: string | undefined, h: Headers): Promise<string | undefined> {
  if (!next) return undefined;
  const mcp = next.startsWith("/oauth/mcp/authorize?"), oidc = next.startsWith("/oauth/authorize?");
  if (!mcp && !oidc) return undefined;
  const params = new URL(next, "https://pulse.invalid").searchParams;
  try {
    const url = mcp ? `${API()}/api/v0/oauth/authorize/app?${new URLSearchParams({ client_id: params.get("client_id") ?? "" })}` : `${API()}/api/v0/oidc/authorize/check?${params}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000), headers: { ...hostHeader(h), "x-pulse-client-ip": ip(h, "signup-page") } });
    const d = r.ok ? await r.json() : null;
    const name = mcp ? d?.name : !d?.fatal ? d?.app?.name : undefined;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : mcp ? "the app you are connecting" : undefined;
  } catch { return mcp ? "the app you are connecting" : undefined; }
}
