import { NextResponse, type NextRequest } from "next/server";

import { API, SESSION_COOKIE } from "@/app/lib/api";
import { sameOrigin, secureCookie } from "@/app/lib/guard";

/**
 * Sign in with Pulse itself (PULSE-ADMIN): the person's Pulse username and password, then their two-step code when
 * Pulse asks for one. The session Pulse returns is kept in this site's own HttpOnly cookie; the console then asks
 * Pulse whether this person is a platform admin (everyone else is refused there).
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Sign in from the admin site itself." }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Type your username and password." }, { status: 400 });
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "admin-sign-in";
  const twoStep = typeof body.code === "string";
  const payload = twoStep
    ? { code: String(body.code).slice(0, 40), ...(typeof body.challenge === "string" && body.challenge ? { challenge: body.challenge.slice(0, 200) } : {}) }
    : { username: String(body.username ?? "").slice(0, 120), password: String(body.password ?? "").slice(0, 200), remember: false };
  let r: Response;
  try {
    r = await fetch(`${API()}/api/v0/auth/${twoStep ? "two-step" : "sign-in"}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pulse-client-ip": ip },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ error: "Pulse did not answer. Try again in a moment." }, { status: 503 });
  }
  const data = (await r.json().catch(() => ({}))) as { token?: string; twoStep?: boolean; challenge?: string; mustChange?: boolean; error?: string };
  if (!r.ok) return NextResponse.json({ error: r.status >= 500 ? "Pulse did not answer. Try again in a moment." : data.error ?? "Those details did not work." }, { status: r.status >= 500 ? 503 : r.status });
  if (data.twoStep) return NextResponse.json({ twoStep: true, challenge: data.challenge ?? "" });
  if (!data.token) return NextResponse.json({ error: "Pulse did not start a session. Try again." }, { status: 502 });
  const response = NextResponse.json({ ok: true, mustChange: !!data.mustChange });
  response.cookies.set(SESSION_COOKIE, data.token, { httpOnly: true, secure: secureCookie(request), sameSite: "strict", path: "/", maxAge: 12 * 3600 });
  return response;
}
