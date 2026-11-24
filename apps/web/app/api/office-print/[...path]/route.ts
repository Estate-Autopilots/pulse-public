import { hostHeader } from "../../../lib/host-mode.mjs";
// OFFICE-PRINT (2503; the Mac's ~/orch/office-setup/print-agent/QUEUE-API.md): the office print agent's four calls, signed
// out, with its own token only (Bearer vpa_…). Nothing of a browser (cookies, Access headers) crosses. The API checks the
// token per call; this only keeps the routes, methods and sizes to the four the agent makes.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const error = (message: string, status: number) => Response.json({ error: message }, { status, headers });

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const auth = request.headers.get("authorization") ?? "";
  if (!/^Bearer vpa_[A-Za-z0-9_-]{43}$/.test(auth)) return error("Invalid print agent token", 401);
  const call = path.length === 2 && path[0] === "agent" && ["next", "status"].includes(path[1]) ? "post"
    : path.length === 3 && path[0] === "jobs" && UUID.test(path[1]) && path[2] === "file" ? "get"
    : path.length === 3 && path[0] === "jobs" && UUID.test(path[1]) && path[2] === "update" ? "post" : null;
  if (!call || request.method.toLowerCase() !== call) return error("Not a print agent call", 404);
  const body = call === "post" ? await request.text() : undefined;
  if (body && body.length > 16 * 1024) return error("Request body too large", 413);
  const forwarded = new Headers(hostHeader(request.headers));
  forwarded.set("authorization", auth);
  if (body) forwarded.set("content-type", "application/json");
  try {
    const upstream = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/office-print/${path.join("/")}`, {
      method: request.method, headers: forwarded, body: body || undefined, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000),
    });
    const out = new Headers(headers);
    const type = upstream.headers.get("content-type");
    if (type) out.set("content-type", type);
    return new Response(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers: out });
  } catch { return error("Service unavailable", 503); }
}
export const GET = forward;
export const POST = forward;
