// TELEMETRY (owner, 24 Oct 2026): the pure half of app telemetry. What a browser batch may contain, how names are reduced
// to templates and private-looking text is removed, and the per-person ingest budget. The routes and the server timing
// are telemetry.ts; storage is migration 0983. Nothing here touches the database.

/** client kinds: nav.*, ui.*, api, vital.*, perf.*, error.*, app.*; the server writes api.server itself. */
export const CLIENT_KIND = /^(nav|ui|vital|perf|error|app)(\.[a-z0-9_]{1,24}){1,2}$|^api$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[^\s@/?#:;,"'<>()]+@[^\s@/?#:;,"'<>()]+\.[a-z]{2,}/gi;
// Opaque strings: 20+ characters of letters, digits, _ or - that contain a digit (session tokens, keys, hashes, ids).
const TOKEN = /(?<![A-Za-z0-9_-])(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;
const DIGITS = /\d{4,}/g;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BLOCKED_KEY = /pass|secret|token|cookie|auth|body|content|message|text|email|phone|value|query|search/i;
export const PLATFORMS = ["web", "android", "ios", "desktop"] as const;
export const DEVICES = ["phone", "tablet", "desktop"] as const;
/** Older than this (an offline queue that waited too long) is dropped; a batch never holds more than MAX_EVENTS. */
export const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
export const MAX_EVENTS = 300;

/** Text with ids, e-mail addresses, phone numbers, tokens and long numbers replaced; trimmed to `max`. */
export function scrub(text: unknown, max = 200): string | null {
  if (typeof text !== "string") return null;
  const s = text.replace(UUID, ":id").replace(EMAIL, ":email").replace(TOKEN, ":token").replace(PHONE, ":n").replace(DIGITS, ":n")
    .replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/** "/api/v0/people/3f2a…/files?q=x" → "/api/v0/people/:id/files?q": ids become :id, the query keeps its keys only. */
export function pathTemplate(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const [path, query = ""] = raw.split("#")[0].split("?");
  const parts = path.split("/").map((seg) => {
    if (!seg) return seg;
    let d = seg;
    try { d = decodeURIComponent(seg); } catch { /* keep the raw segment */ }
    if (/^:[a-z]+$/i.test(d)) return d;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d)) return ":id";
    if (/^\d+$/.test(d)) return ":n";
    if (d.includes("@")) return ":email";
    if ((/\d/.test(d) && d.length >= 6) || d.length > 40 || /[^A-Za-z0-9._~-]/.test(d)) return ":id";
    return d;
  });
  const keys = [...new Set(query.split("&").map((p) => p.split("=")[0]).filter((k) => /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(k)))].sort();
  return (parts.join("/") + (keys.length ? `?${keys.join("&")}` : "")).slice(0, 200);
}

const num = (x: unknown, min: number, max: number): number | null =>
  typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : null;

/** A detail object reduced to safe, small values: at most 16 keys; numbers, booleans, scrubbed short strings and lists of
 *  short names (form field names). Keys that could carry content (text, body, value, password, token…) are dropped. */
export function cleanDetail(x: unknown): Record<string, unknown> | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (n >= 16) break;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(k) || BLOCKED_KEY.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") { const s = scrub(v, 160); if (!s) continue; out[k] = s; }
    else if (Array.isArray(v)) out[k] = v.filter((s): s is string => typeof s === "string").slice(0, 30).map((s) => scrub(s, 40)).filter(Boolean);
    else continue;
    n++;
  }
  return n ? out : null;
}

export type TelemetryRow = {
  at: string; kind: string; name: string | null; page: string | null; duration_ms: number | null; value: number | null;
  status: number | null; session_id: string | null; request_id: string | null; app_version: string | null;
  shell_version: string | null; platform: string | null; device: string | null; detail: Record<string, unknown> | null;
};
export type CleanBatch = { rows: TelemetryRow[]; dropped: number };

/** A browser's batch as rows to store, or null when the body is not a batch at all. Times are moved onto the server's
 *  clock (the batch says when it was sent by the browser's clock). Events with an unknown kind, from the future or older
 *  than three days are dropped and counted. */
export function cleanBatch(body: unknown, receivedAt = Date.now()): CleanBatch | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.ev)) return null;
  const sentAt = num(b.sentAt, 0, Number.MAX_SAFE_INTEGER);
  const skew = sentAt === null ? 0 : receivedAt - sentAt;
  const app = (b.app && typeof b.app === "object" ? b.app : {}) as Record<string, unknown>;
  const session = typeof b.sid === "string" && REQUEST_ID.test(b.sid) ? b.sid : null;
  const version = typeof app.rel === "string" && /^[A-Za-z0-9._+-]{1,60}$/.test(app.rel) ? app.rel : null;
  const shell = typeof app.shell === "string" && /^\d{1,4}(\.\d{1,4}){0,3}$/.test(app.shell) ? app.shell : null;
  const platform = (PLATFORMS as readonly string[]).includes(String(app.plat)) ? String(app.plat) : "web";
  const device = (DEVICES as readonly string[]).includes(String(app.dev)) ? String(app.dev) : null;
  const rows: TelemetryRow[] = [];
  let dropped = Math.max(0, b.ev.length - MAX_EVENTS);
  for (const raw of b.ev.slice(0, MAX_EVENTS)) {
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kind = typeof e.k === "string" && CLIENT_KIND.test(e.k) ? e.k : null;
    const t = num(e.t, 0, Number.MAX_SAFE_INTEGER);
    const at = t === null ? receivedAt : Math.min(receivedAt, t + skew);
    if (!kind || receivedAt - at > MAX_AGE_MS) { dropped++; continue; }
    const duration = num(e.d, 0, 86_400_000);
    const status = num(e.s, 0, 999);
    rows.push({
      at: new Date(at).toISOString(), kind,
      name: kind === "api" ? pathTemplateWithMethod(e.n) : scrub(e.n, 200),
      page: pathTemplate(e.p),
      duration_ms: duration === null ? null : Math.round(duration),
      value: num(e.v, -1e12, 1e12),
      status: status === null ? null : Math.round(status),
      session_id: session,
      request_id: typeof e.r === "string" && REQUEST_ID.test(e.r) ? e.r : null,
      app_version: version, shell_version: shell, platform, device,
      detail: cleanDetail(e.x),
    });
  }
  return { rows, dropped };
}

/** "GET /api/v0/tasks/…" with its path as a template. */
function pathTemplateWithMethod(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const m = /^([A-Z]{3,7}) (\S+)$/.exec(x.trim());
  return m ? `${m[1]} ${pathTemplate(m[2])}` : pathTemplate(x);
}

/** Per person (or session, or address): at most `batches` batches and `events` events a minute. */
export class TelemetryBudget {
  private seen = new Map<string, { start: number; batches: number; events: number }>();
  constructor(private readonly events = 3000, private readonly batches = 60) {}
  take(key: string, count: number, now = Date.now()): boolean {
    let s = this.seen.get(key);
    if (!s || now - s.start >= 60_000) {
      s = { start: now, batches: 0, events: 0 };
      this.seen.delete(key);
      this.seen.set(key, s);
      if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value!);
    }
    if (s.batches + 1 > this.batches || s.events + count > this.events) return false;
    s.batches++; s.events += count;
    return true;
  }
}
