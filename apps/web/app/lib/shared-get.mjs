// PERF: one GET when several parts of a page ask for the same JSON at once. The shell asked for the notification
// settings two or three times on every page load (the browser pings, the notification status and the bell); each was a
// round trip of ~350 ms from India. A failed or non-JSON answer is not kept, so the next caller asks again.
const shared = new Map();

/** The JSON at `url` (or null when the answer is not ok), shared with any other caller within `ttl` ms. */
export function sharedJson(url, ttl = 10_000, fetchImpl = (u) => fetch(u, { cache: "no-store" }), now = () => Date.now()) {
  const hit = shared.get(url);
  if (hit && now() - hit.at < ttl) return hit.promise;
  const promise = Promise.resolve().then(() => fetchImpl(url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  shared.set(url, { at: now(), promise });
  void promise.then((value) => { if (value === null && shared.get(url)?.promise === promise) shared.delete(url); });
  if (shared.size > 50) shared.delete(shared.keys().next().value);
  return promise;
}

/** Forget a shared answer (after a save that changes it). */
export function forgetShared(url) { shared.delete(url); }
