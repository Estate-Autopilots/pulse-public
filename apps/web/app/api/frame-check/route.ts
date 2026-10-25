// CHAT-SHELL (22 Oct 2026): whether a web address may be shown inside the chat's side panel, and what to call it.
// The panel asks before framing a site, so a site that refuses (X-Frame-Options, CSP frame-ancestors) shows as a clean
// card instead of a blank box. Signed-in people only; public https addresses only (never this server's own network);
// at most three redirects, four seconds and the first 64 KB of the page, read once and never stored.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "../../lib/api";
import { frameAllowed } from "../../lib/panel-target.mjs";

export const dynamic = "force-dynamic";

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^198\.1[89]\./, /^2(2[4-9]|[3-5]\d)\./];
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((re) => re.test(ip));
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:") && privateAddress(v6.slice(7));
}
async function publicHttps(raw: string) {
  let url: URL; try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return null;
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length || ips.some(privateAddress)) return null;
  return url;
}
const text = (html: string, re: RegExp) => html.match(re)?.[1]?.replace(/\s+/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, "\"").trim().slice(0, 200) || undefined;

export async function GET(request: NextRequest) {
  if (!(await getMe()).data) return NextResponse.json({ error: "Sign in to Pulse first." }, { status: 401 });
  const own = request.nextUrl.origin;
  let url = await publicHttps(request.nextUrl.searchParams.get("url") ?? "");
  if (!url) return NextResponse.json({ embeddable: false, reason: "not a public https address" });
  try {
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000), headers: { accept: "text/html,*/*;q=0.5", "user-agent": "Mozilla/5.0 (Pulse side panel check)" } });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        void r.body?.cancel();
        const next = await publicHttps(new URL(r.headers.get("location")!, url).href); if (!next) return NextResponse.json({ embeddable: false, reason: "redirects away" });
        url = next; continue;
      }
      const embeddable = r.ok && frameAllowed(r.headers, own);
      let title: string | undefined, description: string | undefined;
      if ((r.headers.get("content-type") ?? "").includes("text/html") && r.body) {
        const reader = r.body.getReader(); let html = ""; const dec = new TextDecoder();
        while (html.length < 65536) { const { done, value } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); }
        void reader.cancel();
        title = text(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ?? text(html, /<title[^>]*>([^<]+)<\/title>/i);
        description = text(html, /<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']+)/i);
      } else void r.body?.cancel();
      return NextResponse.json({ embeddable, title, description, site: url.hostname.replace(/^www\./, "") }, { headers: { "cache-control": "private, max-age=600" } });
    }
    return NextResponse.json({ embeddable: false, reason: "too many redirects" });
  } catch { return NextResponse.json({ embeddable: false, reason: "did not answer" }); }
}
