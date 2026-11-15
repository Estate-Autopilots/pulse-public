import type { NextRequest } from "next/server";
import { createApiProxy, v0ProxyOptions } from "../../../api/proxy.mjs";
import { brandFor, consentBody, consentPage, html, returnPage } from "../../../lib/oauth-web.mjs";

// EST-2811: the consent screen. It runs on the person's own Pulse sign-in through the normal API proxy (same identity
// and same-origin rules as every screen); signed out, it goes to Sign in and comes back here.
// AI-CONNECT: the person ticks what the app may do (six plain groups); only those scopes are granted.
const api = createApiProxy(v0ProxyOptions);
const path = { params: Promise.resolve({ path: ["oauth", "authorize"] }) };
const problem = (detail: string, status = 400) => html("Cannot connect this app", `<h1>Cannot connect this app</h1><p>${detail.replace(/[&<>"']/g, "")}</p>`, status);

/** The consent screen for these OAuth fields, as the signed-in person sees it (with a note when it is shown again). */
async function consent(request: NextRequest, query: URLSearchParams, note = "") {
  const url = new URL(request.url); url.search = query.toString();
  const headers = new Headers(request.headers); headers.delete("content-type"); headers.delete("content-length");
  const response = await api(new Request(url, { method: "GET", headers }) as unknown as NextRequest, path);
  if (response.status === 401) {
    const next = url.pathname + url.search;
    return new Response(null, { status: 303, headers: { location: `/login?next=${encodeURIComponent(next)}`, "cache-control": "no-store" } });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return problem(String(data.error ?? "Start the connection again from the app."), response.status === 403 ? 403 : 400);
  return consentPage(data, query, { brand: brandFor(request.headers), note });
}

export async function GET(request: NextRequest) {
  return consent(request, request.nextUrl.searchParams);
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  if (!form) return problem("Start the connection again from the app.");
  const { none, body } = consentBody(form);
  if (none) {
    const again = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) if (typeof value === "string") again.set(key, value);
    return consent(request, again, "Tick at least one thing it may do, or press Cancel.");
  }
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const response = await api(new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) }) as NextRequest, path);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) return problem("Your sign-in ended. Start the connection again from the app.", 401);
  if (!response.ok || typeof data.redirect !== "string") return problem(String(data.error ?? "Start the connection again from the app."));
  return returnPage(data.redirect);
}
