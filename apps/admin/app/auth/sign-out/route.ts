import { NextResponse, type NextRequest } from "next/server";

import { API, SESSION_COOKIE } from "@/app/lib/api";
import { sameOrigin, secureCookie } from "@/app/lib/guard";

/** Sign out of the admin site: Pulse ends the session, and the cookie goes (PULSE-ADMIN). */
async function end(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && /^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    await fetch(`${API()}/api/v0/auth/sign-out`, { method: "POST", headers: { "x-pulse-session": token, "content-type": "application/json" }, body: "{}", cache: "no-store", signal: AbortSignal.timeout(10_000) }).catch(() => null);
  }
}

const cleared = (response: NextResponse, request: NextRequest) => {
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: secureCookie(request), sameSite: "strict", path: "/", maxAge: 0 });
  return response;
};

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Sign out from the admin site itself." }, { status: 403 });
  await end(request);
  return cleared(NextResponse.json({ ok: true }), request);
}

/** A link ("Sign in as someone else"): only removes this site's session cookie, then the sign-in page. */
export async function GET(request: NextRequest) {
  return cleared(NextResponse.redirect(new URL("/login", request.url), 303), request);
}
