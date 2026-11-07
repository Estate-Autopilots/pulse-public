export async function GET() {
  try {
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    return Response.json({ status: r.ok ? "ok" : "unavailable", release: process.env.PULSE_RELEASE ?? "dev" }, { status: r.ok ? 200 : 503 });
  } catch { return Response.json({ status: "unavailable" }, { status: 503 }); }
}
