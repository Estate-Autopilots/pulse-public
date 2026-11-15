// Admission rules for the native gateway (/api/native/v0), kept apart from the route so they are unit-tested.
// Token-only: sign-in, pairing, token rotation and the company name before pairing (native/about) are the only calls
// without a per-device bearer credential.
// Access headers are never forwarded. Rate limits use fixed one-minute windows per hashed key in this process.
import { createHash } from "node:crypto";

/** Requests allowed per minute for each kind of call. */
export const LIMITS = Object.freeze({
  signIn: 10,      // auth/sign-in, two-step, forgot, change-password, sign-out: per address
  pairStart: 6,    // new pairing codes: per address
  pairPoll: 40,    // pairing status checks (every 3 s): per address
  refresh: 20,     // token rotation: per address
  bootstrap: 30,   // me / devices with a browser session during password enrolment: per address
  device: 240,     // everything a signed-in device does: per credential
  address: 600,    // every call from one address, whatever it is
});

export const BOOTSTRAP = /^(auth\/(sign-in|two-step|forgot|change-password|sign-out)|me|devices|native\/(exchange|refresh|about|pair\/(start|poll)))$/;
// CALLS-NATIVE: a ring on the phone asks whether its call still rings (calls/:id/ring) and declines it.
export const ALLOWED = /^(auth\/(sign-in|two-step|forgot|change-password|sign-out)|native\/(exchange|refresh|about|batches|web-session|pair\/(start|poll)|notifications\/[0-9a-f-]{36}\/open)|me|feedback|companion(?:\/(?:presence|inbox|updates|read|ack|snooze|notification-settings|wallet|late-dispute))?|my-week|intelligence|delivery|hr\/(self|tickets)|attendance\/(check-in|check-out|break)|leave|tasks|people(?:\/[0-9a-f-]{36})?|projects(?:\/[0-9a-f-]{36})?|chats(?:\/events|\/direct|\/[0-9a-f-]{36}\/(messages|read))?|devices(?:\/policy|\/[0-9a-f-]{36}\/(consent|resume|pause|revoke|push|health))?|calls\/[0-9a-f-]{36}\/(ring|decline)|events\/today|sensing\/desk|sensing\/events\/[0-9a-f-]{36}\/correct|fair-work)$/;
const TOKEN = /^Bearer [A-Za-z0-9_-]{43}$/;
const SESSION = /^[A-Za-z0-9_-]{40,64}$/;

export function keyOf(...parts) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

export function createLimiter({ now = () => Date.now(), max = 20000 } = {}) {
  const windows = new Map();
  return {
    /** Count one call; returns { ok, retryAfter } (seconds until the window resets when refused). */
    hit(key, limit) {
      const t = now(), w = windows.get(key);
      if (!w || t - w.start >= 60000) {
        if (windows.size >= max) for (const [k, v] of windows) { if (t - v.start >= 60000 || windows.size >= max) windows.delete(k); if (windows.size < max * 0.9) break; }
        windows.set(key, { start: t, count: 1 });
        return { ok: true, retryAfter: 0 };
      }
      w.count += 1;
      return w.count <= limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + 60000 - t) / 1000)) };
    },
    size: () => windows.size,
  };
}

function bucketOf(path, bearer) {
  if (/^auth\//.test(path)) return "signIn";
  if (path === "native/pair/start") return "pairStart";
  if (path === "native/pair/poll") return "pairPoll";
  if (path === "native/refresh") return "refresh";
  return bearer ? "device" : "bootstrap";
}

/**
 * Decide one gateway request. Returns { ok: false, status, error, headers? } or { ok: true, forward } where
 * forward holds the only credential headers passed to the API.
 */
export function admit({ path, authorization, session, address, enabled = true, limiter }) {
  if (!enabled) return { ok: false, status: 503, error: "The Pulse app connection is switched off on this server" };
  if (!ALLOWED.test(path)) return { ok: false, status: 403, error: "Route outside device scope" };
  if (authorization != null && !TOKEN.test(authorization)) return { ok: false, status: 401, error: "Invalid device credential" };
  const bootstrap = BOOTSTRAP.test(path);
  if (!bootstrap && !authorization) return { ok: false, status: 401, error: "Scoped device sign-in required" };
  const bucket = bucketOf(path, authorization);
  const checks = [[keyOf("address", address), LIMITS.address], [bucket === "device" ? keyOf("device", authorization) : keyOf(bucket, address), LIMITS[bucket]]];
  for (const [key, limit] of checks) {
    const r = limiter.hit(key, limit);
    if (!r.ok) return { ok: false, status: 429, error: "Too many requests from this app. Try again shortly.", headers: { "retry-after": String(r.retryAfter) } };
  }
  const forward = {};
  if (authorization) forward.authorization = authorization;
  else if (bootstrap && session && SESSION.test(session)) forward["x-pulse-session"] = session;
  return { ok: true, forward };
}
