import type { NextRequest } from "next/server";
import { createApiProxy, v0ProxyOptions } from "../../../api/proxy.mjs";
import { consentPage, html, returnPage } from "../../../lib/oauth-web.mjs";

// EST-2811: the consent screen. It runs on the person's own Pulse sign-in through the normal API proxy (same identity
// and same-origin rules as every screen); signed out, it goes to Sign in and comes back here.
const api = createApiProxy(v0ProxyOptions);
const path = { params: Promise.resolve({ path: ["oauth", "authorize"] }) };
const problem = (detail: string, status = 400) => html("Cannot connect this app", `<h1>Cannot connect this app</h1><p>${detail.replace(/[&<>"']/g, "")}</p>`, status);

export async function GET(request: NextRequest) {
  const response = await api(request, path);
  if (response.status === 401) {
    const next = request.nextUrl.pathname + request.nextUrl.search;
    return new Response(null, { status: 303, headers: { location: `/login?next=${encodeURIComponent(next)}`, "cache-control": "no-store" } });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return problem(String(data.error ?? "Start the connection again from the app."), response.status === 403 ? 403 : 400);
  return consentPage(data, request.nextUrl.searchParams);
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  if (!form) return problem("Start the connection again from the app.");
  const body: Record<string, unknown> = {};
  for (const key of ["client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "response_type"]) {
    const value = form.get(key);
    if (typeof value === "string") body[key] = value;
  }
  body.approve = form.get("decision") === "approve";
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const response = await api(new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) }) as NextRequest, path);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) return problem("Your Pulse sign-in ended. Start the connection again from the app.", 401);
  if (!response.ok || typeof data.redirect !== "string") return problem(String(data.error ?? "Start the connection again from the app."));
  return returnPage(data.redirect);
}
