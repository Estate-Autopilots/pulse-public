import { hasV1CredentialConflict } from "../../../../lib/host-mode.mjs";
import { forward } from "../../../../oauth/forward";

// PULSE-ID: the data API apps call with a Pulse access token (pulse_org_api_base = {issuer}/api/v1/connect). One bearer
// token and nothing else; a photo address carries its own signature instead (no token, no cookie read).
async function handle(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  let plain = false;
  try { plain = path.every((part) => { const d = decodeURIComponent(part); return d !== "" && d !== "." && d !== ".." && !/[/\\]/.test(d); }); } catch {}
  if (!plain) return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  const photo = path.length === 2 && path[0] === "photos" && request.method === "GET";
  if (!photo && (!/^Bearer \S+$/.test(request.headers.get("authorization") ?? "") || hasV1CredentialConflict(request.headers))) {
    return Response.json({ error: "invalid_token", error_description: "Send one Pulse access token as Authorization: Bearer, and nothing else" },
      { status: 401, headers: { "cache-control": "no-store", "www-authenticate": 'Bearer error="invalid_token"' } });
  }
  return forward(request, `/api/v1/connect/${path.map((p) => encodeURIComponent(decodeURIComponent(p))).join("/")}`, { credential: !photo });
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
