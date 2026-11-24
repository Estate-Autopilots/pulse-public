import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hasV1CredentialConflict, hostHeader, hostMode, requestHost } from "../lib/host-mode.mjs";
import { sameOriginFor } from "../lib/host-families.mjs";
import { FRAME_CSP, isFramePath } from "../lib/doc-rich.mjs";
import { bootAnswer, bootKeys } from "../lib/boot.mjs";

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

/** ORG-PER-TAB: the company this browser tab is in (proxy.ts puts it in x-pulse-org from the tab's header, its `_o`
 *  address hint, its navigation cookie or the page last drawn; a company id only). The API opens that company's session
 *  of the same sign-in, or answers "Not found". */
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const tabOrgOf = (request) => { const v = request.headers.get("x-pulse-org"); return v && ORG_ID.test(v) ? v : null; };
/** The address's query as the API gets it: without the tab's `_o` hint (the proxy already read it). */
export function forwardSearch(url) {
  const u = new URL(url);
  if (!u.searchParams.has("_o")) return u.search;
  u.searchParams.delete("_o");
  return u.search;
}

/** v0 GET paths that answer with a stored file rather than JSON. */
/** LOGIN-VITALS: where each sign-in provider's start may send the browser (anything else falls back to the sign-in page). */
const IDP_ORIGINS = { google: "https://accounts.google.com/", microsoft: "https://login.microsoftonline.com/", apple: "https://appleid.apple.com/" };

/** DOREVE-FIX: one session replay chunk, /api/v0/telemetry/replay/:sid/:seq (binary gzip). */
export function replayChunk(path) {
  return path.length === 4 && path[0] === "telemetry" && path[1] === "replay" && /^[A-Za-z0-9_-]{8,64}$/.test(path[2]) && /^\d{1,6}$/.test(path[3]);
}
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
    // FIX-PEOPLE-MONEY C7 (owner, 10 Nov 2026: "Download signed copy downloads a .json file"): an agreement's signed PDF
    // with its audit page. It fell through to the JSON answer below, which also read the bytes as text.
    || (path.length === 3 && path[0] === "contracts" && path[2] === "pdf")
    // CONTRACTS-PRO: the editor's live preview (a POST answered with the PDF of words not saved yet); read as text it drew blank.
    || (path.length === 3 && path[0] === "contracts" && path[2] === "preview")
    // CLIENT-PORTAL / PORTAL-2: a document's PDF in the client's space.
    || (path.length === 4 && path[0] === "client-portal" && path[1] === "documents" && path[3] === "pdf")
    // DOCS-RICH: a doc's picture or file (pictures and PDFs inline, the rest a sandboxed download, as below).
    || (path.length === 3 && path[0] === "docs" && path[1] === "files" && /^[0-9a-f-]{36}$/.test(path[2]))
    // FIX-PR-CALENDAR (owner, 10 Nov: "the board shows images in review, but nothing renders"): PR Studio's creatives,
    // the PR pipeline's made images and a client's PR image were read as text and sent on as JSON, so no picture drew.
    || (path.length === 4 && path[0] === "pr" && path[1] === "flow" && path[2] === "files" && /^[0-9a-f-]{36}(\.(png|jpe?g|webp|pdf))?$/i.test(path[3]))
    || (path.length === 4 && path[0] === "pr" && path[1] === "pipeline" && path[2] === "creatives" && /^[0-9a-f-]{36}(\.png)?$/.test(path[3]))
    || (path.length === 4 && path[0] === "client-portal" && path[1] === "pr" && path[2] === "images" && /^[0-9a-f-]{36}(\.png)?$/.test(path[3]));
}

/** PORTAL-2: a file shared with a client or sent by one (deliverables, payment proofs) streams with range requests. */
export const clientFile = (path) => (path.length === 3 && path[0] === "client-portal" && path[1] === "files") || (path.length === 2 && path[0] === "client-files");

/** KAZUK-REST slice 7: a training course's uploaded video plays (and seeks) with range requests. */
export const trainingFile = (path) => path.length === 4 && path[0] === "training" && path[1] === "videos" && path[3] === "file";

/** UX-TENANT: the setup wizard's preview of a new company's logo (operator only, never cached). */
const tenantBrand = (path) => path.length === 4 && path[0] === "tenants" && path[2] === "brand";

/** COMPANY-MARKS: one of the signed-in account's companies' square logo, for My day (the API checks the seat). */
export const seatMark = (path) => path.length === 4 && path[0] === "tasks" && path[1] === "my-day" && path[2] === "mark";

/** RELEASE-COMMS: a release's share card picture (the API checks the person's audiences). */
export const whatsNewCard = (path) => path.length === 4 && path[0] === "whats-new" && /^\d+$/.test(path[1]) && path[2] === "card";

/** COMPANY-SEARCH: a listed company's logo or a findable person's photo in the directory (the API checks what is shown). */
export const directoryPicture = (path) => path.length === 4 && path[0] === "directory"
  && ((path[1] === "companies" && path[3] === "logo") || (path[1] === "people" && path[3] === "photo"));

/** v0 paths whose bytes carry their own content-security-policy from this proxy. The page policy must not replace it:
 *  Next keeps a header the middleware already set. */
export function ownCsp(path) {
  return fileRoute(path) || isFramePath(path) || clientFile(path) || trainingFile(path) || (path[0] === "chats" && (path[1] === "files" || path[2] === "photo")) || tenantBrand(path) || seatMark(path) || whatsNewCard(path) || directoryPicture(path)
    || path.join("/") === "inbox/attachment" || (path[0] === "feedback" && path[2] === "screenshot")
    || (path[0] === "chats" && path[1] === "history" && path[2] === "files");
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
export function createApiProxy({ upstreamPrefix, methods, allowPublicAuthPaths = false, legacyV0 = false, allowPostPath, fetchImpl, hostLookup, retryMs = 1500 }) {
  return async function proxy(request, context) {
    const { path } = await context.params;
    // DOCS-RICH: an uploaded web page opens only inside a doc's frame. Opened on its own (a link someone was sent), it is
    // refused, so a page cannot be used to send a person elsewhere from a Pulse address. Its code (?source=1) is text.
    if (legacyV0 && request.method === "GET" && isFramePath(path) && new URL(request.url).searchParams.get("source") !== "1") {
      const dest = request.headers.get("sec-fetch-dest");
      if (dest && dest !== "iframe") return new Response("Open the doc in Vitals to see this page.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8",
        "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    // Integrations keys require private, no-store on every response, including refusals before the API is called.
    const integrationKeys = legacyV0 && path[0] === "integrations" && path[1] === "keys";
    if (/^Bearer\s+psvc_/i.test(request.headers.get('authorization') ?? '')) return Response.json({ error: 'Service key scope excludes this endpoint' }, { status: 403, headers: { 'cache-control': integrationKeys ? 'private, no-store' : 'no-store', 'referrer-policy': 'no-referrer' } });
    if (/^Bearer\s+pcat_/i.test(request.headers.get('authorization') ?? '')) return jsonError('catalog.read scope excludes this endpoint', 403);
    if (legacyV0 && path[0] === 'integrations' && request.headers.has('authorization')) return jsonError('Company admins manage integration keys', 403);
    // The operator API (ADR-0031 §2) is for the server's own shell only: never forwarded, whatever the path spells.
    if (isOperatorPath(upstreamPrefix, path)) return jsonError("Not found", 404);
    const googleSettings = legacyV0 && path.length === 3 && path.join("/") === "admin/sign-in/google";
    // TG-VOICE (7 Nov 2026): Company channels (AGENT-CHANNELS) saves with PUT /api/v0/agent-channels; the proxy answered
    // "Method not allowed", so no admin could choose the company's own Telegram bot or switch WhatsApp or listening on.
    // Same rules as the Google settings PUT: a signed-in admin (the API checks) and the same-origin check below.
    const agentChannels = legacyV0 && path.length === 1 && path[0] === "agent-channels";
    const allowedMethods = methods.filter((method) => method !== "PUT" || googleSettings || agentChannels);
    if (!allowedMethods.includes(request.method)) {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { allow: allowedMethods.join(", "), "content-type": "application/json", "cache-control": "private, no-store" },
      });
    }

    const googleSettingsWrite = (googleSettings || agentChannels) && request.method === "PUT";
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
    // TG-VOICE (7 Nov 2026): Meta's webhook for the WhatsApp Cloud API (AGENT-CHANNELS, services/api/src/agent-channels.ts)
    // must reach the API signed out: Meta's verification handshake (GET) and its signed deliveries (POST). Only the body
    // as sent and Meta's signature travel; no cookie, session or Access identity is read or forwarded. The API checks the
    // signature with the company's app secret and answers 404 while no business number is connected. Without this the
    // proxy answered "Sign in" and Meta could never verify the callback.
    if (legacyV0 && path.length === 3 && path[0] === "channels" && path[1] === "whatsapp" && path[2] === "hook") {
      if (!["GET", "POST"].includes(request.method)) return errorResponse("Method not allowed", 405);
      try {
        const post = request.method === "POST";
        const upstream = await (fetchImpl ?? fetch)(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}${upstreamPrefix}channels/whatsapp/hook${new URL(request.url).search}`, {
          method: request.method,
          cache: "no-store",
          headers: { ...(post ? { "content-type": "application/json", "x-hub-signature-256": request.headers.get("x-hub-signature-256") ?? "" } : {}),
            "x-pulse-client-ip": request.headers.get("cf-connecting-ip") ?? "whatsapp-webhook", ...hostHeader(request.headers) },
          ...(post ? { body: await request.arrayBuffer() } : {}),
          signal: AbortSignal.timeout(20000),
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
    const deviceKept=readCookie(request,'pulse_device_key');
    const deviceKey=deviceKept??randomBytes(24).toString('base64url');
    // Client portal accounts (v0 only) carry their own cookie and may open released portal work only.
    const clientSession = legacyV0 ? readCookie(request, clientCookie) : undefined;
    const portal = legacyV0 && path[0] === "portal";
    // EST-1399: Continue with Google is two browser navigations (EST-1392 contract §3), both made before a session exists.
    // LOGIN-VITALS: Continue with Microsoft and with Apple the same way (each its own cookie path and provider address).
    const idp = legacyV0 && request.method === "GET" && path.length === 3 && path[0] === "auth" && Object.hasOwn(IDP_ORIGINS, path[1]) && ["start", "callback"].includes(path[2]) ? path[1] : null;
    const google = idp !== null;
    // Apple answers with a POST from appleid.apple.com (response_mode=form_post), which carries no SameSite=Lax cookie:
    // the same callback opens again as a GET (a top-level navigation, so the binding cookie comes along), with the code,
    // the state and an error only. The API checks all of it as for the others.
    if (legacyV0 && request.method === "POST" && path.join("/") === "auth/apple/callback") {
      let form = new URLSearchParams();
      try { form = new URLSearchParams((await request.text()).slice(0, 16384)); } catch {}
      const keep = new URLSearchParams();
      for (const key of ["code", "state", "error"]) { const value = form.get(key); if (value && value.length <= 4096) keep.set(key, value); }
      return new Response(null, { status: 303, headers: { location: `/api/v0/auth/apple/callback?${keep}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    const open = allowPublicAuthPaths && (google || (path[0] === "auth" && ["branding", "sign-in", "sign-in-code", "code-sign-in", "forgot", "forgot-username", "two-step", "set-password", "invite-peek", "team-setup", "team-setup-check", "bug-report", "confirm-email", "link-sign-in", "device-sign-in", "join", "join-peek", "account-sign-in", "connect-peek", "connect-join", "account-forgot", "account-link", "account-reset", "account-link-sign-in", "account-confirm", "signup", "signup-code", "signup-confirm", "handle-check"].includes(path[1]))
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
        // A company's own address (UX-TENANT) is its own origin; the install's addresses keep PULSE_PUBLIC_URL, except a
        // platform family's host (VITALS-HOSTS), which is its own origin too.
        const own = `${requestUrl.protocol}//${request.headers.get("host")}`;
        sameOrigin = !!origin && new URL(origin).origin === new URL(sameOriginFor(request.headers.get("host"), mode.own ? process.env.PULSE_PUBLIC_URL ?? own : own)).origin;
      } catch {}
      if (!sameOrigin) return errorResponse("Invalid origin", 403);
      if (process.env.PULSE_PUBLIC_LOGIN_ENABLED === "1" && process.env.NODE_ENV === "production" && !process.env.PULSE_PUBLIC_URL) {
        return errorResponse("Public sign-in origin is not configured", 503);
      }
    }

    const target = `${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}${upstreamPrefix}${path.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}${forwardSearch(request.url)}`;
    const headers = {
      "content-type": "application/json",
      "x-pulse-device-id": createHash("sha256").update(deviceKey).digest("hex"),
      // SWITCH-SMOOTH: the API trusts a browser (a person proved themselves on it) only by a device key this browser really
      // kept; a key made up for this one request is never "known".
      ...(deviceKept ? { "x-pulse-device-known": "1" } : {}),
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
    const tab = tabOrgOf(request);
    if (tab && !(portal && clientSession) && (session || email)) headers["x-pulse-org"] = tab;
    // SPEED-NET: the shell's start-up reads in one round trip (lib/boot.mjs). Each part is asked of the API here, as this
    // person in this tab's company (the same headers as any call), so every part keeps its own checks and answer.
    if (legacyV0 && request.method === "GET" && path.length === 1 && path[0] === "boot" && !portal && !clientSession) {
      const keys = bootKeys(new URL(request.url).searchParams);
      const api = process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";
      const t0 = Date.now();
      const answer = await bootAnswer(keys, (key) => (fetchImpl ?? fetch)(`${api}${upstreamPrefix}${key}`, { method: "GET", cache: "no-store", headers, signal: AbortSignal.timeout(15000) }));
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store", "server-timing": `app;dur=${Date.now() - t0}` } });
    }
    // The API answers both with a redirect and never reads a cookie: the proxy hands it the attempt cookie and turns the
    // attempt and session it returns into cookies. Only Google's address or a path here is followed; an outage or any
    // other answer goes back to the normal sign-in page, so the password stays usable.
    if (google) {
      const attempt = readCookie(request, "pulse_oidc");
      if (attempt) headers["x-pulse-oidc"] = attempt;
      const query = new URL(request.url).searchParams;
      // A failed link (signed in) goes back to Account, a failed sign-in to the normal sign-in page.
      const fallback = idp !== "google" ? `/login?${query.get("next") ? `next=${encodeURIComponent(query.get("next"))}&` : ""}idp=${idp}&reason=provider_error`
        : query.get("mode") === "link" || (path[2] === "callback" && session) ? "/account?google=provider_error" : `/login?${query.get("next") ? `next=${encodeURIComponent(query.get("next"))}&` : ""}google=provider_error`;
      const go = (location, cookies = []) => {
        const out = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        for (const cookie of cookies) out.append("set-cookie", cookie);
        return new Response(null, { status: 302, headers: out });
      };
      try {
        const upstream = await (fetchImpl ?? fetch)(target, { method: "GET", cache: "no-store", headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
        const location = upstream.headers.get("location") ?? "";
        const allowed = location.startsWith(IDP_ORIGINS[idp]) || (/^\/(?![/\\])/.test(location) && !/[\u0000-\u001f\u007f\\]/.test(location));
        if (upstream.status < 300 || upstream.status > 399 || !allowed) return go(fallback);
        const cookies = [], set = upstream.headers.get("x-pulse-oidc-set"), token = upstream.headers.get("x-pulse-session-token");
        // Pulse 2-step still applies after Google: its challenge waits in a cookie only the two-step request receives.
        const twoStep = upstream.headers.get("x-pulse-two-step-challenge");
        if (twoStep && /^[A-Za-z0-9_-]{43}$/.test(twoStep)) cookies.push(`pulse_two_step=${twoStep}; Path=/api/v0/auth/two-step; HttpOnly; Secure; SameSite=Lax; Max-Age=300`);
        if (set && /^[\w-]{16,256}$/.test(set)) cookies.push(`pulse_oidc=${set}; Path=/api/v0/auth/${idp}; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
        else if (path[2] === "callback") cookies.push(`pulse_oidc=; Path=/api/v0/auth/${idp}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
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
    const cpFile = legacyV0 && request.method === "GET" && (clientFile(path) || trainingFile(path));
    // CHAT-VOICE-FIX (owner, 14 Nov 2026: voice notes must always play): a voice note streams to the player as itself, with
    // range requests (Safari and iPhones play media only from a server that answers ranges), and keeps the API's caching
    // (a copy still to come is revalidated); a photo, voice note or file of imported WhatsApp history streams the same way.
    const voicePlay = legacyV0 && request.method === "GET" && path.length === 4 && path[0] === "chats" && path[1] === "files" && path[3] === "play";
    const historyFile = legacyV0 && request.method === "GET" && path.length === 4 && path[0] === "chats" && path[1] === "history" && path[2] === "files";
    if (media || waFile || callAudio || cpFile || voicePlay || historyFile) {
      for (const key of ["range", "if-range"]) if (request.headers.has(key)) headers[key] = request.headers.get(key);
    }

    try {
      const t0 = Date.now();
      const ask = () => (fetchImpl ?? fetch)(target, {
        method: request.method,
        cache: "no-store",
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(50000),
      });
      let upstream;
      for (let tries = 0; ; tries++) {
        try { upstream = await ask(); break; } catch (e) {
          // ERROR-SWEEP (17 Nov 2026): the API not answering at all is almost always a release restarting it (about 13 a
          // day; 114 failed reads for 19 people in a week, 43-byte "data service is unavailable"). A read asks once more
          // 1.5 s later. Never after the 50 s timeout.
          // Only the browser's own /api/v0 calls (integrations and API keys keep one try and their own retry rules).
          // A connection failure is fetch's TypeError ("fetch failed"); a timeout or abort is not, and is not retried.
          // FIX-BILLING (BC-036, 19 Nov 2026): saving a Billing document or item during a release failed with 503. A
          // connection the API refused (ECONNREFUSED: not listening yet) never reached it, so a write is safe to send
          // again: any call is asked up to three more times, 1.5 s apart. A connection that broke after the request went
          // out is still never retried for a write (it may have been saved).
          if (!legacyV0 || !(e instanceof TypeError)) throw e;
          if (!(refusedConnection(e) ? tries < 3 : request.method === "GET" && tries < 1)) throw e;
          await new Promise((done) => setTimeout(done, retryMs));
        }
      }

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
      if (voicePlay && (upstream.ok || upstream.status === 416)) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        const out = new Headers({ "content-type": /^audio\/(webm|ogg|mp4|mpeg|aac)$/.test(type) ? type : "application/octet-stream", "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox", "cache-control": /^private, (no-cache|max-age=\d+)$/.test(upstream.headers.get("cache-control") ?? "") ? upstream.headers.get("cache-control") : "private, no-cache" });
        for (const key of ["content-length", "content-range", "accept-ranges", "etag", "content-disposition", "x-content-duration"]) if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
        return new Response(upstream.body, { status: upstream.status, headers: out });
      }
      if ((waFile || cpFile || historyFile) && (upstream.ok || upstream.status === 416)) {
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
      // AGENT-UI-CONTROL: the screen stream (what AI employees send to this person's screen) streams the same way.
      if (liveStream(path) && upstream.ok) {
        return new Response(upstream.body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "private, no-store", "x-accel-buffering": "no" } });
      }
      // ERROR-SWEEP (17 Nov 2026): the API restarting (a release, about 13 a day) answers 502/503/504. Given as JSON, the
      // browser closes the stream for good (741 times in 7 days for Calls alone, half within 4 minutes of a release)
      // and each page reopens it on its own back-off. A stream that only says "come back in 3 s" lets the browser
      // reconnect by itself. Sign-in and permission answers (401, 403, 404 ...) are still given as they are.
      if (liveStream(path) && [502, 503, 504].includes(upstream.status)) return streamRetry();
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
      // COMPANY-MARKS: a seat's logo (SVG allowed: the API refuses uploads that script or link out; sandboxed), kept
      // privately for a while (the address carries its version).
      // RELEASE-COMMS: a release's share card (JPEG, PNG or WebP; the API checked the bytes and the person's audiences).
      // Its address carries the picture's tag (?v=), so the browser keeps it for a month.
      if (whatsNewCard(path) && upstream.ok) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        return new Response(upstream.body, { status: 200, headers: { "content-type": ["image/png", "image/jpeg", "image/webp"].includes(type) ? type : "application/octet-stream", "cache-control": "private, max-age=2592000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
      }
      // COMPANY-SEARCH: a directory logo or photo (SVG allowed as for seat marks; sandboxed), kept privately for a while
      // (the address carries its version).
      if (directoryPicture(path) && upstream.ok) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        return new Response(upstream.body, { status: 200, headers: { "content-type": ["image/svg+xml", "image/png", "image/jpeg", "image/webp"].includes(type) ? type : "application/octet-stream", "cache-control": "private, max-age=300, stale-while-revalidate=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" } });
      }
      if (seatMark(path) && upstream.ok) {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        return new Response(upstream.body, { status: 200, headers: { "content-type": ["image/svg+xml", "image/png", "image/jpeg", "image/webp"].includes(type) ? type : "application/octet-stream", "cache-control": "private, max-age=300, stale-while-revalidate=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" } });
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
      // DOCS-RICH: a web page uploaded into a doc runs only sealed: this policy (doc-rich.mjs FRAME_CSP: an opaque origin
      // with scripts and nothing else, no network but a few public CDNs, framed only by Pulse), whatever the API sent.
      // ?source=1 is the page's words as plain text for "Edit code", sandboxed with no scripts at all.
      if (legacyV0 && request.method === "GET" && isFramePath(path) && upstream.ok) {
        const source = new URL(request.url).searchParams.get("source") === "1";
        return new Response(upstream.body, { status: 200, headers: { "content-type": source ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
          "content-security-policy": source ? "default-src 'none'; sandbox" : FRAME_CSP, "cache-control": "private, no-store", "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin" } });
      }
      // Task proof, HR files, onboarding documents and finance evidence stream through unchanged: a PDF or raster image
      // the API marked inline opens in place, anything else is a download. Chrome's PDF viewer draws nothing in a
      // sandboxed document, so only a PDF goes without the sandbox.
      // DOREVE-FIX (17 Nov 2026): a session replay's chunk is gzip bytes (friction.ts GET /telemetry/replay/:sid/:seq).
      // It fell through to the JSON path below, which reads the answer as text: the bytes were corrupted and the replay
      // player could never play a replay ("This replay has no full picture of the screen yet"). Streamed unchanged now.
      if (replayChunk(path) && upstream.ok) {
        return new Response(upstream.body, { status: 200, headers: { "content-type": "application/gzip", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
      }
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
      const accountSession = ["auth/join", "auth/signup", "auth/signup-confirm", "auth/account-sign-in", "account/switch", "account/start", "account/accept", "account/leave", "auth/connect-join", "account/connect-accept", "auth/account-reset", "auth/account-link-sign-in", "account/tab-open"].includes(path.join("/"));
      if ((accountSession || ["auth/sign-in", "auth/two-step", "auth/set-password", "auth/link-sign-in", "auth/code-sign-in", "auth/device-sign-in", "portal/auth/sign-in", "portal/auth/two-step", "portal/auth/set-password"].includes(path.join("/"))) && upstream.ok) {
        const data = await upstream.json();
        // Back to the organisation this address belongs to while its Access identity is present: that identity is the
        // sign-in there, so the switch session is dropped instead of kept.
        if (accountSession && data.token && data.hostOwn && email) { outHeaders.append("set-cookie", `${sessionCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`); data.token = undefined; }
        // IDENTITY-SIGNIN: "Keep me signed in" (on by default) keeps it 30 days on this device; unticked (the API answers
        // remember: false), a browser-session cookie that ends when the browser closes. The server's own expiry stands.
        const keep = data.remember === false ? "" : `; Max-Age=${data.maxAge===2592000||accountSession?2592000:43200}`;
        delete data.remember;
        if(data.token)outHeaders.append("set-cookie", `${portal ? clientCookie : sessionCookie}=${data.token}; Path=/; HttpOnly; Secure; SameSite=Lax${keep}`);
        if(data.token)outHeaders.append("set-cookie",`${portal?sessionCookie:clientCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
        if(data.token)outHeaders.append("set-cookie",`pulse_device_key=${deviceKey}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
        if (data.token && googleTwoStep) outHeaders.append("set-cookie", "pulse_two_step=; Path=/api/v0/auth/two-step; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
        delete data.token;
        return Response.json(data, { status: upstream.status, headers: outHeaders });
      }
      if (path.join("/") === "portal/auth/sign-out") outHeaders.append("set-cookie", `${clientCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      // ORG-PER-TAB: "Sign out of this company" keeps the browser's sign-in for the other companies (signedOut: false).
      if (path.join("/") === "auth/sign-out" && upstream.ok) {
        const text = await upstream.text();
        let kept = false;
        try { kept = JSON.parse(text)?.signedOut === false; } catch {}
        if (!kept) {
          outHeaders.append("set-cookie", `${sessionCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
          outHeaders.append("set-cookie", "pulse_view=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
          let host = null;
          try { host = new URL(process.env.PULSE_PUBLIC_URL ?? request.url).hostname; } catch {}
          if (host && /^[a-z0-9.-]+$/i.test(host)) outHeaders.append("set-cookie", `${sessionCookie}=; Domain=${host}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
        }
        return new Response(text, { status: upstream.status, headers: outHeaders });
      }
      if (path.join("/") === "auth/sign-out") {
        outHeaders.append("set-cookie", `${sessionCookie}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
        // The Pulse desktop window may hold its session as a domain cookie; sign-out there clears that one too.
        let host = null;
        try { host = new URL(process.env.PULSE_PUBLIC_URL ?? request.url).hostname; } catch {}
        if (host && /^[a-z0-9.-]+$/i.test(host)) outHeaders.append("set-cookie", `${sessionCookie}=; Domain=${host}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      }
      // ORG-PER-TAB: the tab's company did not open (signed out of it here, or not one of the account's): the tab
      // forgets it and opens again in the company of the sign-in.
      if (upstream.status === 404 && upstream.headers.get("x-pulse-tab") === "closed") outHeaders.set("x-pulse-tab", "closed");
      const text = await upstream.text();
      // SPEED-NET: how long this server took (the API and this hop), so telemetry splits a call's wait into the
      // person's network and the server (lib/telemetry.mjs reads it as x.srv).
      outHeaders.set("server-timing", `app;dur=${Date.now() - t0}`);
      // SWITCH-SMOOTH: a signed-in browser without a device key keeps the one made now, so a proof on it can be remembered.
      if (!deviceKept && session && upstream.ok) outHeaders.append("set-cookie", `pulse_device_key=${deviceKey}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
      return new Response(text, { status: upstream.status, headers: outHeaders });
    } catch {
      // ERROR-SWEEP: the API not answering at all (restarting): a live stream is told to reconnect, as above.
      if (legacyV0 && liveStream(path)) return streamRetry();
      return errorResponse("The data service is unavailable", 503);
    }
  };
}

/** The live streams the pages hold open (Chats, Calls, the AI employees' screen control). */
export const liveStream = (path) => ["chats/events", "calls/events", "screen/events"].includes(path.join("/"));
/** FIX-BILLING (BC-036): fetch failed because nothing was listening (the API restarting), so the request never reached it. */
export const refusedConnection = (e) => e instanceof TypeError && [e.cause?.code, e.cause?.cause?.code].includes("ECONNREFUSED");
/** A stream that ends at once and asks the browser to connect again in 3 s (EventSource's own retry). */
export const streamRetry = () => new Response("retry: 3000\n: the service is restarting\n\n", { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "private, no-store", "x-accel-buffering": "no" } });

// EST-1611: API v1 operations (/api/v1/<area>/…, the same areas as V1_SCOPES in services/api/src/service-key.ts) and
// their public reference. One bearer key travels, with the content type, idempotency key and the address the caller
// opened; no cookie, session or Access identity is read or forwarded, and one beside the key is refused (401), so a
// browser's sign-in never becomes an API call. The API checks the key itself.
const V1_AREAS = ["tasks", "projects", "people", "chats", "docs", "billing", "finance", "hr", "workflows", "companies", "search", "events", "contracts", "connectors"];
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

// SERVERS-AI: Pulse Runner (docs/runner/PROTOCOL.md). A paired server calls /runner/v1/… with its own credential
// (Authorization: Bearer prc_…), JSON bodies and raw output files. Only that credential, the content type and the file
// hash travel, with the caller's address for the API's rate limits; never a cookie, session or Access identity. The
// answer is passed through as it is: never a redirect (the runner does not follow them), and a long poll may be held
// up to 25 s by the API (the timeout leaves room for that).
const RUNNER_PATH = /^[a-z]+(?:\/[A-Za-z0-9_-]{1,64}(?:\/[a-z]+)?)?$/;
export async function runnerProxy(request, context, fetchImpl = fetch) {
  const { path } = await context.params;
  const plain = Array.isArray(path) && RUNNER_PATH.test(path.join("/"));
  const headers = { "cache-control": "no-store", "content-type": "application/json" };
  const refuse = (status, code, message) => new Response(JSON.stringify({ error: { code, message } }), { status, headers });
  if (!plain) return refuse(404, "not_found", "No such runner endpoint");
  if (!["POST", "PUT"].includes(request.method)) return refuse(405, "invalid_request", "Use POST (PUT for output files)");
  const forwarded = new Headers(hostHeader(request.headers));
  for (const key of ["authorization", "content-type", "x-content-sha256"]) if (request.headers.has(key)) forwarded.set(key, request.headers.get(key));
  forwarded.set("x-pulse-client-ip", request.headers.get("cf-connecting-ip") ?? "runner-unattributed");
  try {
    const upstream = await fetchImpl(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/runner/v1/${path.join("/")}${new URL(request.url).search}`, {
      method: request.method, headers: forwarded, cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(55000)]),
      ...(request.body ? { body: await request.arrayBuffer() } : {}),
    });
    const out = new Headers({ "cache-control": "no-store" });
    for (const key of ["content-type", "retry-after"]) if (upstream.headers.has(key)) out.set(key, upstream.headers.get(key));
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch { return refuse(503, "unavailable", "Pulse is unavailable right now"); }
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
