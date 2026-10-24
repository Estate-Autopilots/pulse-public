import { NextRequest } from "next/server";
import { hostHeader, passwordHost, requestHost } from "../../lib/host-mode.mjs";

/** A person's photo from the Pulse database. The URL carries ?v=<changed at>, so the browser may keep it. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const email = await passwordHost(requestHost(request.headers)) ? null : request.headers.get("cf-access-authenticated-user-email");
  const token = request.cookies.get("pulse_session")?.value;
  const { id } = await context.params;
  if ((!email && !token) || !/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 404 });
  try {
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/people/${id}/photo`, { headers: { ...hostHeader(request.headers), ...(!token && email ? { "cf-access-authenticated-user-email": email } : { "x-pulse-session": token! }) }, cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!r.ok) return new Response(null, { status: 404 });
    const photo = await r.json() as { mime: string; data: string };
    return new Response(Buffer.from(photo.data, "base64"), { headers: { "content-type": photo.mime, "cache-control": request.nextUrl.searchParams.has("v") ? "private, max-age=31536000, immutable" : "private, no-cache" } });
  } catch { return new Response(null, { status: 404 }); }
}
