// R41: the Word editor service (ONLYOFFICE Docs, once the owner approves and connects one) fetches a policy's Word file
// and reports saves here, signed out. The API checks the session token in the address and the service's signature;
// this route passes on only that signature header and a bounded body: no cookie, session or Access identity.
const api = () => process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const signature = (request: Request): Record<string, string> => {
  const value = request.headers.get("authorization");
  return value && value.length < 65536 ? { authorization: value } : {};
};
const notFound = () => Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ token: string; action: string }> }) {
  const { token, action } = await params;
  if (!TOKEN.test(token) || action !== "file") return notFound();
  try {
    const r = await fetch(`${api()}/api/v0/policy-editor/${token}/file`, { cache: "no-store", signal: AbortSignal.timeout(30000), headers: signature(request) });
    if (!r.ok) return new Response(null, { status: r.status === 403 ? 403 : 404, headers: { "cache-control": "no-store" } });
    return new Response(r.body, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
  } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string; action: string }> }) {
  const { token, action } = await params;
  if (!TOKEN.test(token) || action !== "callback") return notFound();
  const body = await request.text();
  if (body.length > 1_000_000) return Response.json({ error: 1 }, { status: 413 });
  try {
    const r = await fetch(`${api()}/api/v0/policy-editor/${token}/callback`, { method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json", ...signature(request) } });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch { return Response.json({ error: 1 }, { status: 503 }); }
}
