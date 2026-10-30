import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hasV1CredentialConflict, hostHeader, hostMode, requestHost } from "../lib/host-mode.mjs";

const sessionCookie = "pulse_session";
const clientCookie = "pulse_client_session";

function readCookie(request, cookie) {
  const nextCookie = request.cookies?.get?.(cookie)?.value;
  if (nextCookie !== undefined) return nextCookie;

  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== cookie) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return value.join("=");
    }
  }
  return undefined;
}

/** v0 GET paths that answer with a stored file rather than JSON. */
export function fileRoute(path) {
  return (path.length === 3 && path[0] === "tasks" && path[1] === "proof")
    || (path.length === 3 && path[0] === "people" && path[1] === "files")
    || (path.length === 4 && path[0] === "onboarding" && path[1] === "documents" && path[3] === "file")
    || (path.length === 4 && path[0] === "finance" && path[1] === "desk" && ["files", "exports"].includes(path[2]))
    // ERP-INVOICE: a document's PDF or DOCX, a template's logo or signature, and the Zoho/Tally/register exports.
    || (path.length === 4 && path[0] === "erp" && path[1] === "documents" && ["pdf", "docx"].includes(path[3]))
    || (path.length === 3 && path[0] === "erp" && ["assets", "exports"].includes(path[1]))
    // R41: a policy version's exact Word file.
    || (path.length === 4 && path[0] === "hr" && path[1] === "policies" && path[3] === "docx")
    // SOP-WORKFLOW: a photo or signature sent with a field form.
    || (path.length === 3 && path[0] === "forms" && path[1] === "files")
    // COMP-A: a pay letter (PDF or Word), a claim's bill, and the letterhead's logo or signature.
    || (path.length === 4 && path[0] === "comp" && path[1] === "letters" && ["pdf", "docx"].includes(path[3]))
    || (path.length === 4 && path[0] === "comp" && path[1] === "claims" && path[3] === "receipt")
    || (path.length === 3 && path[0] === "comp" && path[1] === "letterhead")
    // COMP-B: a payslip's PDF and a payroll run's bank file (CSV, always a download).
    || (path.length === 4 && path[0] === "comp" && path[1] === "payslips" && path[3] === "pdf")
    || (path.length === 4 && path[0] === "comp" && path[1] === "payroll" && path[3] === "bank-file")
    // FIN-ENTRY: a finance entry's receipt, and a WhatsApp payment screenshot's thumbnail.
    || (path.length === 4 && path[0] === "finance" && path[1] === "entries" && path[2] === "files")
    || (path.length === 5 && path[0] === "finance" && path[1] === "entries" && path[2] === "whatsapp" && path[4] === "image")
    // WA-REPORT: a report page's Markdown or PDF, and the whole analysis book.
    || (path.length === 2 && path[0] === "reports" && path[1] === "export")
    // CLIENT-PORTAL / PORTAL-2: a document's PDF in the client's space.
    || (path.length === 4 && path[0] === "client-portal" && path[1] === "documents" && path[3] === "pdf");
}

/** PORTAL-2: a file shared with a client or sent by one (deliverables, payment proofs) streams with range requests. */
export const clientFile = (path) => (path.length === 3 && path[0] === "client-portal" && path[1] === "files") || (path.length === 2 && path[0] === "client-files");

/** UX-TENANT: the setup wizard's preview of a new company's logo (operator only, never cached). */
const tenantBrand = (path) => path.length === 4 && path[0] === "tenants" && path[2] === "brand";

/** v0 paths whose bytes carry their own content-security-policy from this proxy. The page policy must not replace it:
 *  Next keeps a header the middleware already set. */
export function ownCsp(path) {
  return fileRoute(path) || clientFile(path) || (path[0] === "chats" && (path[1] === "files" || path[2] === "photo")) || tenantBrand(path)
    || path.join("/") === "inbox/attachment" || (path[0] === "feedback" && path[2] === "screenshot");
}

function jsonError(error, status, noStore = true) {
  return Response.json({ error }, { status, ...(noStore ? { headers: { "cache-control": "private, no-store" } } : {}) });
}

const upstreamPath = (upstreamPrefix, path) =>
  new URL(`${upstreamPrefix}${path.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}`, "http://upstream.invalid").pathname;

/** True when the upstream request would reach /api/v1/operator/* (also after dot segments are resolved). */
export function isOperatorPath(upstreamPrefix, path) {
  let resolved;
  try { resolved = upstreamPath(upstreamPrefix, path); } catch { return true; }
  return /^\/(?:api\/)?v1\/operator(?:\/|$)/i.test(resolved);
}

/** Builds a same-origin API proxy using only the app's verified identity headers. */
export function createApiProxy({ upstreamPrefix, methods, allowPublicAuthPaths = false, legacyV0 = false, allowPostPath, fetchImpl, hostLookup }) {
  return async function proxy(request, context) {
    const { path } = await context.params;
    // Integrations keys require private, no-store on every response, including refusals before the API is called.
    const integrationKeys = legacyV0 && path[0] === "integrations" && path[1] === "keys";
    if (/^Bearer\s+psvc_/i.test(request.headers.get('authorization') ?? '')) return Response.json({ error: 'Service key scope excludes this endpoint' }, { status: 403, headers: { 'cache-control': integrationKeys ? 'private, no-store' : 'no-store', 'referrer-policy': 'no-referrer' } });
    if (/^Bearer\s+pcat_/i.test(request.headers.get('authorization') ?? '')) return jsonError('catalog.read scope excludes this endpoint', 403);
    if (legacyV0 && path[0] === 'integrations' && request.headers.has('authorization')) return jsonError('Company admins manage integration keys', 403);
    // The operator API (ADR-0031 §2) is for the server's own shell only: never forwarded, whatever the path spells.
    if (isOperatorPath(upstreamPrefix, path)) return jsonError("Not found", 404);
    const googleSettings = legacyV0 && path.length === 3 && path.join("/") === "admin/sign-in/google";
    const allowedMethods = methods.filter((method) => method !== "PUT" || googleSettings);
    if (!allowedMethods.includes(request.method)) {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { allow: allowedMethods.join(", "), "content-type": "application/json", "cache-control": "private, no-store" },
      });
    }

    const googleSettingsWrite = googleSettings && request.method === "PUT";
    const errorResponse = (error, status) => jsonError(error, status, !legacyV0 || integrationKeys);
    if (request.method === "POST" && allowPostPath && !allowPostPath(path)) {
      const allowed = methods.filter((method) => method !== "POST").join(", ") || "GET";
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { allow: allowed, "content-type": "application/json", "cache-control": "private, no-store" },
      });
    }
    // EST-1035: an AI co-worker's runner, on its company's own server, calls /api/v0/agent/* with the company key and
    // nothing else. No cookie, Access identity or session is read or forwarded with it, so the key never becomes a
    // person's sign-in; no browser credential is involved, so there is no same-origin check. Other paths never forward it.
    if (legacyV0 && path[0] === "agent") {
      // Plain path segments only: no ".", ".." or encoded slashes that could step outside /api/v0/agent/.
      let plain = false;
      try { plain = path.every((part) => { const d = decodeURIComponent(part); return d !== "." && d !== ".." && !d.includes("/") && !d.includes("\\"); }); } catch {}
      if (!plain) return errorResponse("Not found", 404);
      const key = request.headers.get("x-pulse-agent-key") ?? "";
      if (!/^pak_[0-9a-f]{8}_[0-9a-f]{64}$/.test(key)) return errorResponse("An AI co-worker key is required", 401);
      // The key travels alone: a person's cookie, Access identity or bearer token with it is refused, not stripped.
      if (["cookie", "authorization", "x-pulse-session", "x-pulse-client-session", "cf-access-authenticated-user-email", "cf-access-jwt-assertion"].some((h) => request.headers.has(h))) {
        return errorResponse("Send the co-worker key alone, with no person's sign-in", 401);
      }
      try {
        const upstream = await (fetchImpl ?? fetch)(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}${upstreamPrefix}${path.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}${new URL(request.url).search}`, {
          method: request.method,
          cache: "no-store",
          headers: { "content-type": "application/json", "x-pulse-agent-key": key, "x-pulse-client-ip": request.headers.get("cf-connecting-ip") ?? "agent-runner", ...hostHeader(request.headers) },
          ...(request.method === "POST" ? { body: await request.text() } : {}),
          signal: AbortSignal.timeout(50000),
        });
        return new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
      } catch { return errorResponse("The data service is unavailable", 503); }
    }
    // PRODUCT-MAP: the build team's tools and AI agents read a product's map and plan with a Product map token, and a
    // token that may push sends a manifest (/api/v0/product-map/feed/*). Only the token travels: no cookie, Access
    // identity or session is read or forwarded with it, so it never becomes a person's sign-in.
    if (legacyV0 && path[0] === "product-map" && path[1] === "feed" && /^Bearer pmap_/.test(request.headers.get("authorization") ?? "")) {
      let plain = false;
      try { plain = path.length <= 3 && path.every((part) => /^[a-z-]+$/.test(decodeURIComponent(part))); } catch {}
      if (!plain) return errorResponse("Not found", 404);
      if (["cookie", "x-pulse-session", "x-pulse-client-session", "x-pulse-agent-key"].some((h) => request.headers.has(h))) {
        return errorResponse("Send the Product map token alone, with no person's sign-in", 401);
      }
      try {
        const upstream = await (fetchImpl ?? fetch)(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}${upstreamPrefix}${path.join("/")}${new URL(request.url).search}`, {
          method: request.method,
          cache: "no-store",
          headers: { "content-type": "application/json", authorization: request.headers.get("authorization") ?? "", "x-pulse-client-ip": request.headers.get("cf-connecting-ip") ?? "product-map-token", ...hostHeader(request.headers) },
          ...(request.method === "POST" ? { body: await request.text() } : {}),
          signal: AbortSignal.timeout(50000),
        });
        return new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "private, no-store" } });
      } catch { return errorResponse("The data service is unavailable", 503); }
    }
    // A person's path never carries a co-worker key: refused here, before any header is stripped or forwarded.
    if (request.headers.has("x-pulse-agent-key")) return errorResponse("An AI co-worker key works on its own routes only", 401);
    // UX-TENANT: a company's own address signs in with Pulse passwords; Access headers are not read there.
    const mode = await (hostLookup ?? hostMode)(requestHost(request.headers));
    const publicLogin = mode.signIn === "password";
    const email = publicLogin ? null : request.headers.get("cf-access-authenticated-user-email");
    const session = readCookie(request, sessionCookie);
    const deviceKey=readCookie(request,'pulse_device_key')??randomBytes(24).toString('base64url');
    // Client portal accounts (v0 only) carry their own cookie and may open released portal work only.
    const clientSession = legacyV0 ? readCookie(request, clientCookie) : undefined;
    const portal = legacyV0 && path[0] === "portal";
    // EST-1399: Continue with Google is two browser navigations (EST-1392 contract §3), both made before a session exists.
    const google = legacyV0 && request.method === "GET" && path.length === 3 && path[0] === "auth" && path[1] === "google" && ["start", "callback"].includes(path[2]);
    const open = allowPublicAuthPaths && (google || (path[0] === "auth" && ["branding", "sign-in", "forgot", "forgot-username", "two-step", "set-password", "invite-peek", "team-setup", "team-setup-check", "bug-report", "confirm-email", "link-sign-in", "device-sign-in", "join", "join-peek", "account-sign-in", "connect-peek", "connect-join", "account-forgot", "account-link", "account-reset", "account-link-sign-in", "account-confirm", "signup"].includes(path[1]))
      || (portal && path[1] === "auth" && ["sign-in", "forgot", "forgot-username", "two-step", "set-password", "confirm-email"].includes(path[2])));
    // LAYOUT-SWEEP: the organisation's logo is public (the sign-in page shows it before anyone signs in; e-mails link it).
    const brand = legacyV0 && request.method === "GET" && path[0] === "brand" && path.length <= 2;
    if (brand && !email && !session && !clientSession) {
      try {
        const upstream = await (fetchImpl ?? fetch)(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}${upstreamPrefix}${path.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}`, { cache: "no-store", ...(requestHost(request.headers) ? { headers: hostHeader(request.headers) } : {}), signal: AbortSignal.timeout(10000) });
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        if (path.length === 1) return new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
        return new Response(upstream.ok ? upstream.body : null, { status: upstream.status, headers: { "content-type": upstream.ok && ["image/svg+xml", "image/png", "image/jpeg", "image/webp"].includes(type) ? type : "application/octet-stream", "cache-control": "public, max-age=300, stale-while-revalidate=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" } });
      } catch { return errorResponse("The data service is unavailable", 503); }
    }
    if(clientSession&&!portal&&!open)return errorResponse("Client accounts can open only released portal work",403);
    if (!email && !clientSession && (!publicLogin || (!session && !open))) {
      return errorResponse(mode.own ? "Sign in through your organisation's Access" : "Sign in to Pulse", 401);
    }

    if (request.method === "POST" || googleSettingsWrite) {
      const origin = request.headers.get("origin");
      let sameOrigin = false;
      try {
        const requestUrl = new URL(request.url);
        // A company's own address (UX-TENANT) is its own origin; the install's addresses keep PULSE_PUBLIC_URL.
        const own = `${requestUrl.protocol}//${request.headers.get("host")}`;
        sameOrigin = !!origin && new URL(origin).origin === new URL(mode.own ? process.env.PULSE_PUBLIC_URL ?? own : own).origin;
      } catch {}
      if (!sameOrigin) return errorResponse("Invalid origin", 403);
      if (process.env.PULSE_PUBLIC_LOGIN_ENABLED === "1" && process.env.NODE_ENV === "production" && !process.env.PULSE_PUBLIC_URL) {
        return errorResponse("Public sign-in origin is not configured", 503);
      }
    }

    const target = `${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}${upstreamPrefix}${path.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}${new URL(request.url).search}`;
    const headers = {
      "content-type": "application/json",
      "x-pulse-device-id": createHash("sha256").update(deviceKey).digest("hex"),
      "x-pulse-device-agent": (request.headers.get("user-agent") ?? "").slice(0,500),
      "x-pulse-client-ip": request.headers.get("cf-connecting-ip") ?? "unattributed-web",
      ...hostHeader(request.headers),
    };
    // TELEMETRY: the browser's request id (lib/telemetry.mjs) joins its timing to the API's own.
    const requestId = request.headers.get("x-pulse-request-id");
    if (requestId && /^[A-Za-z0-9_-]{8,64}$/.test(requestId)) headers["x-pulse-request-id"] = requestId;
    if (googleSettingsWrite && request.headers.has("x-pulse-two-step")) headers["x-pulse-two-step"] = request.headers.get("x-pulse-two-step");
    if (portal && clientSession) {
      headers["x-pulse-client-session"] = clientSession;
    } else if (!session && email) {
      headers["cf-access-authenticated-user-email"] = email;
      const assertion = request.headers.get("cf-access-jwt-assertion");
      if (assertion) headers["x-pulse-access-id"] = createHash("sha256").update(assertion).digest("hex");
    } else if (session) {
      headers["x-pulse-session"] = session;
    }
    // The API answers both with a redirect and never reads a cookie: the proxy hands it the attempt cookie and turns the
    // attempt and session it returns into cookies. Only Google's address or a path here is followed; an outage or any
    // other answer goes back to the normal sign-in page, so the password stays usable.
    if (google) {
      const attempt = readCookie(request, "pulse_oidc");
      if (attempt) headers["x-pulse-oidc"] = attempt;
      const query = new URL(request.url).searchParams;
      // A failed link (signed in) goes back to Account, a failed sign-in to the normal sign-in page.
      const fallback = query.get("mode") === "link" || (path[2] === "callback" && session) ? "/account?google=provider_error" : `/login?${query.get("next") ? `next=${encodeURIComponent(query.get("next"))}&` : ""}google=provider_error`;
      const go = (location, cookies = []) => {
        const out = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        for (const cookie of cookies) out.append("set-cookie", cookie);
        return new Response(null, { status: 302, headers: out });
      };
      try {
        const upstream = await (fetchImpl ?? fetch)(target, { method: "GET", cache: "no-store", headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
        const location = upstream.headers.get("location") ?? "";
        const allowed = location.startsWith("https://accounts.google.com/") || (/^\/(?![/\\])/.test(location) && !/[\u0000-\u001f\u007f\\]/.test(location));
        if (upstream.status < 300 || upstream.status > 399 || !allowed) return go(fallback);
        const cookies = [], set = upstream.headers.get("x-pulse-oidc-set"), token = upstream.headers.get("x-pulse-session-token");
        // Pulse 2-step still applies after Google: its challenge waits in a cookie only the two-step request receives.
        const twoStep = upstream.headers.get("x-pulse-two-step-challenge");
        if (twoStep && /^[A-Za-z0-9_-]{43}$/.test(twoStep)) cookies.push(`pulse_two_step=${twoStep}; Path=/api/v0/auth/two-step; HttpOnly; Secure; SameSite=Lax; Max-Age=300`);
        if (set && /^[\w-]{16,256}$/.test(set)) cookies.push(`pulse_oidc=${set}; Path=/api/v0/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
        else if (path[2] === "callback") cookies.push("pulse_oidc=; Path=/api/v0/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
        if (token && /^[\w-]{16,256}$/.test(token)) cookies.push(`${sessionCookie}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`, `${clientCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, `pulse_device_key=${deviceKey}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
        return go(location, cookies);
      } catch { return go(fallback); }
    }
    // EST-1399: the code step after Google posts {code} alone; the challenge comes from its cookie, never the page.
    const googleTwoStep = legacyV0 && request.method === "POST" && path.join("/") === "auth/two-step" ? /^[A-Za-z0-9_-]{43}$/.exec(readCookie(request, "pulse_two_step") ?? "")?.[0] : undefined;
    let body = request.method === "POST" || googleSettingsWrite ? await request.text() : undefined;
    if (googleTwoStep) {
      try { const parsed = JSON.parse(body || "{}"); if (parsed && typeof parsed === "object" && !parsed.challenge) body = JSON.stringify({ ...parsed, challenge: googleTwoStep }); } catch {}
    }
    const media = legacyV0 && ((portal && path[1] === "media") || path.join("/") === "delivery/demo-media");
    // WA-IMPORT: a file of an imported WhatsApp chat (photos, voice notes, video, documents) streams with range requests.
    const waFile = legacyV0 && path.length === 4 && path[0] === "chats" && path[1] === "whatsapp" && path[2] === "files";
    // CALLS-V2: a call recording's audio plays (and seeks) with range requests too.
    const callAudio = legacyV0 && request.method === "GET" && path.length === 4 && path[0] === "calls" && path[1] === "recordings" && path[3] === "audio";
    const cpFile = legacyV0 && request.method === "GET" && clientFile(path);
    if (media || waFile || callAudio || cpFile) {
      for (const key of ["range", "if-range"]) if (request.headers.has(key)) headers[key] = request.headers.get(key);
    }

    try {
      const upstream = await (fetchImpl ?? fetch)(target, {
        method: request.method,
        cache: "no-store",
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(50000),
      });

      if (!legacyV0) {
        return new Response(await upstream.text(), {
          status: upstream.status,
          headers: { "content-type": "application/json", "cache-control": "private, no-store" },
        });
      }

      if (callAudio && (upstream.ok || upstream.status === 416)) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        const out = new Headers({ "content-type": /^audio\/(webm|ogg|mp4)$/.test(type) ? type : "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
        for (const key of ["content-length", "content-range", "accept-ranges", "content-disposition"]) if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
        return new Response(upstream.body, { status: upstream.status, headers: out });
      }
      if ((waFile || cpFile) && (upstream.ok || upstream.status === 416)) {
        // The API decided inline or download; only the types it shows inline pass as themselves, the rest download.
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        const inline = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(ogg|mp4|mpeg|aac|webm|wav)|application\/pdf)$/.test(type);
        const out = new Headers({ "content-type": inline ? type : "application/octet-stream", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
        for (const key of ["content-length", "content-range", "accept-ranges", "etag", "content-disposition"]) {
          if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
        }
        if (type !== "application/pdf") out.set("content-security-policy", "sandbox");
        return new Response(upstream.body, { status: upstream.status, headers: out });
      }
      if (media && (upstream.ok || upstream.status === 416)) {
        const out = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
        for (const key of ["content-type", "content-length", "content-range", "accept-ranges", "etag"]) {
          if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
        }
        return new Response(upstream.body, { status: upstream.status, headers: out });
      }
      // Owner workbench UI (stability): Calls' live stream is streamed like Chats' (it was read to the end, 45 s later,
      // and answered as JSON: every page logged an EventSource MIME error and reconnected).
      if ((path.join("/") === "chats/events" || path.join("/") === "calls/events") && upstream.ok) {
        return new Response(upstream.body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "private, no-store", "x-accel-buffering": "no" } });
      }
      // BUG-REPORT: a report's picture or recording (the API checked who may see it), sandboxed and never cached.
      if (path[0] === "bug-reports" && path.length === 3 && ["screenshot", "recording"].includes(path[2]) && upstream.ok) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        return new Response(upstream.body, { status: 200, headers: { "content-type": ["image/png", "image/jpeg", "image/webp", "video/webm", "video/mp4"].includes(type) ? type : "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
      }
      if (path[0] === "feedback" && path[2] === "screenshot" && upstream.ok) {
        const type = upstream.headers.get("content-type");
        return new Response(upstream.body, { status: 200, headers: { "content-type": ["image/png", "image/jpeg", "image/webp"].includes(type) ? type : "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
      }
      // LAYOUT-SWEEP: the organisation's logo (public; SVG is allowed: the API refuses uploads that script or link out,
      // and the response is sandboxed). Cached briefly; the address carries its version.
      if (path[0] === "brand" && path.length === 2 && upstream.ok) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        return new Response(upstream.body, { status: 200, headers: { "content-type": ["image/svg+xml", "image/png", "image/jpeg", "image/webp"].includes(type) ? type : "application/octet-stream", "cache-control": "public, max-age=300, stale-while-revalidate=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" } });
      }
      if (tenantBrand(path) && upstream.ok) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        return new Response(upstream.body, { status: 200, headers: { "content-type": ["image/svg+xml", "image/png", "image/jpeg", "image/webp"].includes(type) ? type : "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" } });
      }
      // Chat files, group photos and the viewer's own e-mail attachments: a raster image the API marked inline previews
      // in place (and may be kept privately for a day); anything else is a sandboxed download.
      if ((path[0] === "chats" && (path[1] === "files" || path[2] === "photo") || path.join("/") === "inbox/attachment") && upstream.ok) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        const disposition = upstream.headers.get("content-disposition") ?? (path[2] === "photo" ? "inline" : "attachment");
        // FEATURES-1024: a chat's PDF or plain text the API marked inline opens beside the chat too; a PDF goes without
        // the sandbox (Chrome's PDF viewer draws nothing in a sandboxed document), like task files below.
        const doc = path[0] === "chats" && path[1] === "files" && ["application/pdf", "text/plain"].includes(type);
        const inline = (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type) || doc) && disposition.startsWith("inline");
        const headers = { "content-type": inline ? type : "application/octet-stream", "content-disposition": inline ? disposition : disposition.replace(/^inline/, "attachment"), "cache-control": inline ? "private, max-age=86400" : "private, no-store", "x-content-type-options": "nosniff" };
        if (!(inline && type === "application/pdf")) headers["content-security-policy"] = "sandbox";
        return new Response(upstream.body, { status: 200, headers });
      }
      // Task proof, HR files, onboarding documents and finance evidence stream through unchanged: a PDF or raster image
      // the API marked inline opens in place, anything else is a download. Chrome's PDF viewer draws nothing in a
      // sandboxed document, so only a PDF goes without the sandbox.
      if (fileRoute(path) && upstream.ok) {
        const type = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
        const disposition = upstream.headers.get("content-disposition") ?? "attachment";
        const inline = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(type) && disposition.startsWith("inline");
        const out = new Headers({ "content-type": inline ? type : "application/octet-stream", "content-disposition": inline ? disposition : disposition.replace(/^inline/, "attachment"), "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
        if (type !== "application/pdf" || !inline) out.set("content-security-policy", "sandbox");
        return new Response(upstream.body, { status: 200, headers: out });
      }
      const outHeaders = new Headers({ "content-type": "application/json", "cache-control": "private, no-store" });
      // ORG: a Pulse account's switch, join, start and sign-in answer with a session of the organisation it moves to.
      const accountSession = ["auth/join", "auth/signup", "auth/account-sign-in", "account/switch", "account/start", "account/accept", "auth/connect-join", "account/connect-accept", "auth/account-reset", "auth/account-link-sign-in"].includes(path.join("/"));
      if ((accountSession || ["auth/sign-in", "auth/two-step", "auth/set-password", "auth/link-sign-in", "auth/device-sign-in", "portal/auth/sign-in", "portal/auth/two-step", "portal/auth/set-password"].includes(path.join("/"))) && upstream.ok) {
        const data = await upstream.json();
        // Back to the organisation this address belongs to while its Access identity is present: that identity is the
        // sign-in there, so the switch session is dropped instead of kept.
        if (accountSession && data.token && data.hostOwn && email) { outHeaders.append("set-cookie", `${sessionCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`); data.token = undefined; }
        if(data.token)outHeaders.append("set-cookie", `${portal ? clientCookie : sessionCookie}=${data.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${data.maxAge===2592000||accountSession?2592000:43200}`);
        if(data.token)outHeaders.append("set-cookie",`${portal?sessionCookie:clientCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
        if(data.token)outHeaders.append("set-cookie",`pulse_device_key=${deviceKey}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
        if (data.token && googleTwoStep) outHeaders.append("set-cookie", "pulse_two_step=; Path=/api/v0/auth/two-step; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
        delete data.token;
        return Response.json(data, { status: upstream.status, headers: outHeaders });
      }
      if (path.join("/") === "portal/auth/sign-out") outHeaders.append("set-cookie", `${clientCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      if (path.join("/") === "auth/sign-out") {
        outHeaders.append("set-cookie", `${sessionCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
        // The Pulse desktop window may hold its session as a domain cookie; sign-out there clears that one too.
        let host = null;
        try { host = new URL(process.env.PULSE_PUBLIC_URL ?? request.url).hostname; } catch {}
        if (host && /^[a-z0-9.-]+$/i.test(host)) outHeaders.append("set-cookie", `${sessionCookie}=; Domain=${host}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      }
      return new Response(await upstream.text(), { status: upstream.status, headers: outHeaders });
    } catch {
      return errorResponse("The data service is unavailable", 503);
    }
  };
}

// EST-1611: API v1 operations (/api/v1/<area>/…, the same areas as V1_SCOPES in services/api/src/service-key.ts) and
// their public reference. One bearer key travels, with the content type, idempotency key and the address the caller
// opened; no cookie, session or Access identity is read or forwarded, and one beside the key is refused (401), so a
// browser's sign-in never becomes an API call. The API checks the key itself.
const V1_AREAS = ["tasks", "projects", "people", "chats", "docs", "billing", "workflows", "companies", "search", "events"];
export const v1Area = (path) => V1_AREAS.includes(path[0]) || path[0] === "mcp" || path.join("/") === "openapi.json";

export async function v1BearerProxy(request, context, fetchImpl = fetch) {
  const { path } = await context.params;
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  const problem = (status, title, detail) => {
    const requestId = randomUUID();
    return new Response(JSON.stringify({ type: "about:blank", title, status, detail, requestId }),
      { status, headers: { ...headers, "content-type": "application/problem+json", "x-request-id": requestId } });
  };
  let plain = false;
  try { plain = path.every((part) => { const d = decodeURIComponent(part); return d !== "" && d !== "." && d !== ".." && !/[/\\]/.test(d); }); } catch {}
  if (!plain) return problem(404, "Not Found", "No such API v1 operation");
  const reference = path.join("/") === "openapi.json";
  if (!reference && (!/^Bearer \S+$/.test(request.headers.get("authorization") ?? "")
      || hasV1CredentialConflict(request.headers))) {
    return problem(401, "Unauthorized", "Send one API key as Authorization: Bearer, with no sign-in beside it");
  }
  const forwarded = new Headers(hostHeader(request.headers));
  const mcp = path.join("/") === "mcp";
  for (const key of reference ? [] : ["authorization", "content-type", "idempotency-key", ...(mcp ? ["accept", "origin", "mcp-protocol-version", "mcp-session-id", "last-event-id"] : [])]) if (request.headers.has(key)) forwarded.set(key, request.headers.get(key));
  try {
    const upstream = await fetchImpl(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v1/${path.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}${new URL(request.url).search}`, {
      method: request.method, headers: forwarded, cache: "no-store", redirect: "error", signal: mcp ? AbortSignal.any([request.signal, AbortSignal.timeout(50000)]) : AbortSignal.timeout(50000),
      ...(["POST", "PATCH", "DELETE"].includes(request.method) && request.body ? { body: await request.arrayBuffer() } : {}),
    });
    const out = new Headers(headers);
    for (const key of ["content-type", "x-request-id", "retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", ...(mcp ? ["mcp-session-id", "allow", "x-accel-buffering"] : [])]) if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
    return new Response([202, 204, 205, 304].includes(upstream.status) ? null : upstream.body, { status: upstream.status, headers: out });
  } catch { return problem(503, "Service Unavailable", "The data service is unavailable"); }
}

export const v0ProxyOptions = {
  upstreamPrefix: "/api/v0/",
  methods: ["GET", "POST", "PUT"],
  allowPublicAuthPaths: true,
  legacyV0: true,
};

// FLOW-B: processes, runs, steps and records (/api/v1/flow/…) are read and written from the browser as the signed-in
// person: every POST there goes through, with the same verified identity and same-origin check as the claim POSTs.
export const v1FlowProxyOptions = { upstreamPrefix: "/v1/", methods: ["GET", "POST"] };

export const v1ProxyOptions = {
  upstreamPrefix: "/v1/",
  methods: ["GET", "POST"],
  allowPostPath: (path) => (path.length === 3 && ["deliveries", "designs"].includes(path[0]) && path[2] === "claim")
    || (path.length === 3 && path[0] === "updates" && ["open", "reply"].includes(path[2]))
    || (path.length === 4 && path[0] === "deliveries" && path[2] === "claim" && path[3] === "decide")
    || (path.length === 3 && path[0] === "accounts" && path[2] === "claim")
    || (path.length === 4 && path[0] === "accounts" && path[2] === "claim" && ["decide", "revert"].includes(path[3])),
};
