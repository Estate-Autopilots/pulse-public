// EST-1399 (folds in EST-1443): the one check for `next` and every return path after signing in (EST-1392 contract §3).
const BASE = "https://pulse.invalid";
const UNSAFE = /[\u0000-\u001f\u007f\\]/;

/** The path to return to, or undefined. A path passes only when it starts with exactly one "/", has no control character
 *  or "\" (raw or percent-encoded), stays on this origin and is not a sign-in or API address. */
export function safeNext(next) {
  if (typeof next !== "string" || next.length > 2048) return undefined;
  let decoded;
  try { decoded = decodeURIComponent(next); } catch { return undefined; }
  if (![next, decoded].every((value) => /^\/(?![/\\])/.test(value) && !UNSAFE.test(value))) return undefined;
  let url;
  try { url = new URL(next, BASE); } catch { return undefined; }
  if (url.origin !== BASE || /^\/(login|api)(\/|$)/.test(new URL(decoded, BASE).pathname)) return undefined;
  return url.pathname + url.search + url.hash;
}
