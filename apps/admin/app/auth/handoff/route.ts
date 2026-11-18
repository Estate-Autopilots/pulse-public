import { NextResponse, type NextRequest } from "next/server";

import { API, SESSION_COOKIE } from "@/app/lib/api";
import { sameOrigin, secureCookie } from "@/app/lib/guard";

/**
 * SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.4: "if I have to log in again, that's a very hectic job"): the hand-off from
 * Pulse. A platform admin signed in to Pulse clicks Admin console; Pulse sends them to /handoff#<token>; that page posts
 * the token here; Pulse's API trades it (once, within two minutes) for this site's own session, kept in the same
 * HttpOnly cookie a password sign-in sets. No password, no second sign-in.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Open the admin console from Pulse." }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.slice(0, 64) : "";
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "admin-handoff";
  let r: Response;
  try {
    r = await fetch(`${API()}/api/v0/auth/admin-handoff/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pulse-client-ip": ip, "x-pulse-device-agent": request.headers.get("user-agent") ?? "" },
      body: JSON.stringify({ token }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ error: "Pulse did not answer. Try again in a moment." }, { status: 503 });
  }
  const data = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok || !data.token) return NextResponse.json({ error: r.status >= 500 ? "Pulse did not answer. Try again in a moment." : data.error ?? "Open the admin console from Pulse again." }, { status: r.status >= 500 ? 503 : 400 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, data.token, { httpOnly: true, secure: secureCookie(request), sameSite: "strict", path: "/", maxAge: 12 * 3600 });
  return response;
}
