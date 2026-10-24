// PULSE-NETWORK (EST-1038): "Open Pulse Network". The API asks the network for a one-time link (60 seconds) for the
// signed-in leader, and the browser goes straight there, signed in. The link is never logged or shown; on any refusal
// the leader lands back on the Network page with a plain notice.
import { NextResponse, type NextRequest } from "next/server";
import { api } from "../../lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const next = request.nextUrl.searchParams.get("next") ?? "/";
  const r = await api<{ url: string }>(`network/sign-in?next=${encodeURIComponent(next)}`);
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  if (r.error || !r.data?.url) return new NextResponse(null, { status: 303, headers: { ...headers, location: "/network?error=1" } });
  return new NextResponse(null, { status: 302, headers: { ...headers, location: r.data.url } });
}
