// FLOW-E: another app (a web form, a CRM, anything) posts here to start a process ("Another app sends it in"), signed
// out. Only the JSON body (up to 64 KB) and the address it came in on go to the API: no cookie, session or identity.
// The API answers 404 unless the token is a live address of a process of this company.
import { hostHeader } from "../../../lib/host-mode.mjs";

const api = () => process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return Response.json({ error: "Not found" }, { status: 404 });
  const text = await request.text();
  if (text.length > 65536) return Response.json({ error: "Too large" }, { status: 413 });
  let json: unknown = {};
  if (text.trim()) { try { json = JSON.parse(text); } catch { return Response.json({ error: "Send JSON" }, { status: 400 }); } }
  try {
    const r = await fetch(`${api()}/v1/flow/hooks/${token}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", ...hostHeader(request.headers) }, body: JSON.stringify(json) });
    return Response.json(await r.json().catch(() => ({})), { status: r.status === 200 ? 200 : 404, headers: { "cache-control": "no-store" } });
  } catch { return Response.json({ error: "Try again" }, { status: 503 }); }
}
