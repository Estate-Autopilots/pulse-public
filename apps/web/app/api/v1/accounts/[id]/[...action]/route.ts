import { createApiProxy, v1ProxyOptions } from "../../../../proxy.mjs";
import type { NextRequest } from "next/server";

const postProxy = createApiProxy({ ...v1ProxyOptions, methods: ["POST"] });
const allowedActions = new Set(["claim", "claim/decide", "claim/revert"]);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string; action: string[] }> }) {
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try {
    const requestUrl = new URL(request.url);
    const host = request.headers.get("host");
    const configured = process.env.PULSE_PUBLIC_URL ?? (host ? requestUrl.protocol + "//" + host : requestUrl.origin);
    const expected = new URL(configured).origin;
    sameOrigin = !!origin && new URL(origin).origin === expected;
  } catch {}
  if (!sameOrigin) {
    return Response.json({ error: "Invalid origin" }, { status: 403, headers: { "cache-control": "private, no-store" } });
  }

  const { id, action } = await context.params;
  if (!allowedActions.has(action.join("/"))) {
    return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  return postProxy(request, { params: Promise.resolve({ path: ["accounts", id, ...action] }) });
}
