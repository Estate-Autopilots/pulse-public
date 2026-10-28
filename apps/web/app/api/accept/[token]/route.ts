import { hostHeader, hostMode, requestHost } from "../../../lib/host-mode.mjs";
// ERP-INVOICE: a client's answer through an acceptance link (signed out). Same-origin only; forwards the answer with the
// client's IP (hashed by the API) and browser. No session or Access header is passed on.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return Response.json({ error: "This link is not valid" }, { status: 404 });
  const origin = request.headers.get("origin");
  try {
    // A company's own address (UX-TENANT) is its own origin; the install's addresses keep PULSE_PUBLIC_URL.
    const self = new URL((await hostMode(requestHost(request.headers))).own ? process.env.PULSE_PUBLIC_URL ?? request.url : request.url).origin;
    if (!origin || new URL(origin).origin !== self) return Response.json({ error: "Invalid origin" }, { status: 403 });
  } catch { return Response.json({ error: "Invalid origin" }, { status: 403 }); }
  const body = await request.text();
  if (body.length > 4000) return Response.json({ error: "Too long" }, { status: 413 });
  try {
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/accept/${token}`, {
      method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(10000),
      headers: { ...hostHeader(request.headers), "content-type": "application/json", "x-pulse-client-ip": request.headers.get("cf-connecting-ip") ?? "unattributed-web", "user-agent": (request.headers.get("user-agent") ?? "").slice(0, 300) },
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch { return Response.json({ error: "The service is unavailable; try again shortly" }, { status: 503 }); }
}
