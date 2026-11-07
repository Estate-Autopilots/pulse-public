import type { NextRequest } from "next/server";
import { createApiProxy, v0ProxyOptions } from "../../api/proxy.mjs";
import { devicePage, html } from "../../lib/oauth-web.mjs";

// AGENT-API (owner, 4 Nov 2026), 1511: the page where a person approves `pulse login --device` (RFC 8628). It runs on
// their own Pulse sign-in through the normal API proxy, like the consent screen; signed out, it goes to Sign in and back.
const api = createApiProxy(v0ProxyOptions);
const path = { params: Promise.resolve({ path: ["oauth", "device"] }) };
const problem = (detail: string, status = 400) => html("Cannot connect", `<h1>Cannot connect</h1><p>${detail.replace(/[&<>"']/g, "")}</p><p><a href="/oauth/device">Enter another code</a></p>`, status);
const shown = (raw: string | null) => { const c = String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8); return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : ""; };

export async function GET(request: NextRequest) {
  const code = shown(request.nextUrl.searchParams.get("user_code"));
  if (!code) return devicePage(null, "");
  const response = await api(request, path);
  if (response.status === 401) {
    const next = request.nextUrl.pathname + request.nextUrl.search;
    return new Response(null, { status: 303, headers: { location: `/login?next=${encodeURIComponent(next)}`, "cache-control": "no-store" } });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return problem(String(data.error ?? "That code is not waiting here."), response.status === 403 ? 403 : 400);
  return devicePage(data, code);
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const code = shown(typeof form?.get("user_code") === "string" ? String(form!.get("user_code")) : null);
  if (!form || !code) return problem("Enter the code from your terminal again.");
  const approve = form.get("decision") === "approve";
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const response = await api(new Request(request.url, { method: "POST", headers, body: JSON.stringify({ user_code: code, approve }) }) as NextRequest, path);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) return problem("Your Pulse sign-in ended. Sign in and enter the code again.", 401);
  if (!response.ok) return problem(String(data.error ?? "That code is not waiting here any more."));
  return html(approve ? "Connected" : "Cancelled", approve ? `<h1>Connected</h1><p>Go back to your terminal: the pulse command is signed in as you. You can close this tab.</p>`
    : `<h1>Cancelled</h1><p>Nothing was connected. You can close this tab.</p>`);
}
