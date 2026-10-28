import type { NextRequest } from "next/server";
import { v1BearerProxy } from "../api/proxy.mjs";
import { challenge, preflight, publicOrigin } from "../lib/oauth-web.mjs";

// EST-2811: Pulse's remote MCP server (Streamable HTTP, stateless, POST only) for Claude, ChatGPT and other MCP apps.
// The same bearer-only door as /api/v1/mcp; a 401 carries the challenge that leads the app to "Sign in with Pulse".
const mcp = async (request: NextRequest) => {
  if (request.method === "OPTIONS") return preflight();
  const response = await v1BearerProxy(request, { params: Promise.resolve({ path: ["mcp"] }) });
  if (response.status !== 401) return response;
  const headers = new Headers(response.headers);
  headers.set("www-authenticate", challenge(publicOrigin(request.headers), request.headers.has("authorization")));
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "www-authenticate");
  return new Response(response.body, { status: 401, headers });
};
export const GET = mcp;
export const POST = mcp;
export const DELETE = mcp;
export const OPTIONS = mcp;
