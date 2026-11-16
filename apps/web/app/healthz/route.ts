// LAND-CAPTAIN-10: an unhealthy answer says which part failed (the API's own "part" and pool counts, or "api" when the
// API did not answer in 4 s), so the production guard's log names the cause. The status and release fields are as before.
const PASSED = ["part", "total", "idle", "waiting"] as const;

export async function GET() {
  try {
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (r.ok) return Response.json({ status: "ok", release: process.env.PULSE_RELEASE ?? "dev" });
    const body = await r.json().catch(() => ({})) as Record<string, unknown>;
    const why = Object.fromEntries(PASSED.filter((k) => typeof body[k] === "string" || typeof body[k] === "number").map((k) => [k, body[k]]));
    return Response.json({ status: "unavailable", release: process.env.PULSE_RELEASE ?? "dev", ...why }, { status: 503 });
  } catch { return Response.json({ status: "unavailable", part: "api" }, { status: 503 }); }
}
