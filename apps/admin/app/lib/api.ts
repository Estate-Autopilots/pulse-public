import { cookies, headers } from "next/headers";

/**
 * The admin site reads and changes Pulse only through Pulse's API, as the signed-in person (PULSE-ADMIN). Identity:
 * the admin site's own Pulse session (HttpOnly cookie, set by /auth/sign-in), else the Cloudflare Access e-mail where
 * the API accepts it (the API ignores it in public sign-in mode). Every route under /api/v0/platform is checked again by
 * the API and the database; this file grants nothing.
 */
export const SESSION_COOKIE = "pulse_admin_session";
export const API = () => process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";

export type ApiResult<T> = { data: T; error?: never; status: number } | { data?: never; error: string; status: number };

/** Headers that carry the signed-in person to the API. */
export async function identity(): Promise<Record<string, string>> {
  const h = await headers();
  const jar = await cookies();
  const out: Record<string, string> = {};
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token && /^[A-Za-z0-9_-]{40,64}$/.test(token)) out["x-pulse-session"] = token;
  else {
    const email = h.get("cf-access-authenticated-user-email");
    if (email) out["cf-access-authenticated-user-email"] = email;
  }
  const ip = h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) out["x-pulse-client-ip"] = ip;
  return out;
}

const refusal = (status: number, body: unknown) => {
  const text = typeof body === "object" && body && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : "";
  if (status === 401) return "Sign in to the admin console.";
  if (status === 403) return text || "Only Pulse’s platform admins use the admin console.";
  if (status >= 500) return "Pulse’s data service did not answer. Try again in a moment.";
  return text || "This could not be read.";
};

async function request<T>(path: string, init?: { method: "POST"; body: string }): Promise<ApiResult<T>> {
  try {
    const r = await fetch(`${API()}/api/v0/${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: { ...(await identity()), ...(init ? { "content-type": "application/json" } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) return { error: refusal(r.status, body), status: r.status };
    return { data: body as T, status: r.status };
  } catch {
    return { error: "Pulse’s data service did not answer. Try again in a moment.", status: 503 };
  }
}

export const read = <T>(path: string) => request<T>(path);
export const write = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
